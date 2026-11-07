'use strict';
/*
 * Connect All — private relay + encrypted backup server.
 *
 *   node ca-server.js --port 8787 --data ./ca-data
 *
 * What this server can see:
 *   - room ids (HMAC-derived, not the 6-character pairing code)
 *   - device ids / names the clients choose to publish
 *   - opaque ciphertext sizes and timestamps
 * What it cannot see:
 *   - messages, summaries, calendars, locations, media metadata, API keys
 *     (all payloads are AES-256-GCM sealed with a key derived on the two
 *      couple's devices; the key never leaves them)
 *
 * No dependencies. Node 18+.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { attach } = require('./ws');

const VERSION = '1.0.3';
const MAX_BODY = 20 * 1024 * 1024;
const ROOM_RE = /^[a-f0-9]{16,64}$/;
const TOKEN_RE = /^[a-f0-9]{16,128}$/;
const NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;
const DEVICE_RE = /^[a-zA-Z0-9-]{4,64}$/;

function now() {
  return Date.now();
}
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text);
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function createRelay(options = {}) {
  const port = options.port == null ? 8787 : Number(options.port);
  const host = options.host || '0.0.0.0';
  const dataDir = path.resolve(options.dataDir || path.join(process.cwd(), 'ca-data'));
  const quotaMB = Number(options.quotaMB || 512);
  const historyLimit = Math.max(0, Number(options.historyLimit == null ? 300 : options.historyLimit));
  const historyDays = Math.max(1, Number(options.historyDays || 7));
  const quiet = Boolean(options.quiet);
  const pairingTTL = Math.max(60000, Number(options.pairingTTL || 15 * 60 * 1000));

  const dirs = {
    root: dataDir,
    rooms: path.join(dataDir, 'rooms'),
    backups: path.join(dataDir, 'backups'),
    meta: path.join(dataDir, 'rooms-meta.json'),
  };
  for (const dir of [dirs.root, dirs.rooms, dirs.backups]) fs.mkdirSync(dir, { recursive: true });

  let meta = { rooms: {} };
  try {
    meta = JSON.parse(fs.readFileSync(dirs.meta, 'utf8'));
    if (!meta.rooms) meta.rooms = {};
  } catch (_) {}
  if (meta.version == null) meta.version = 1;
  if (!meta.epoch) {
    meta.epoch = crypto.randomBytes(4).toString('hex');
    saveMetaSoon();
  }
  const serverEpoch = meta.epoch;

  const pairingRooms = new Map(); // roomId -> {token, expiresAt, peers: Map}
  const liveRooms = new Map(); // roomId -> RoomState
  const connections = new Set();
  const ipHits = new Map();
  let closed = false;

  function saveMetaNow() {
    clearTimeout(saveMetaSoon._t);
    saveMetaSoon._t = null;
    try {
      const tmp = dirs.meta + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(meta));
      fs.renameSync(tmp, dirs.meta);
    } catch (err) {
      if (!quiet) log('warn: failed to persist room meta:', err.message);
    }
  }

  function saveMetaSoon() {
    clearTimeout(saveMetaSoon._t);
    saveMetaSoon._t = setTimeout(saveMetaNow, 400);
  }

  function rateLimit(ip, bucket, perMinute) {
    const key = ip + '|' + bucket;
    const t = now();
    let entry = ipHits.get(key);
    if (!entry || t - entry.start > 60000) {
      entry = { start: t, count: 0 };
      ipHits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > perMinute) return false;
    if (ipHits.size > 5000) {
      for (const [k, v] of ipHits) if (t - v.start > 120000) ipHits.delete(k);
    }
    return true;
  }

  function historyFile(room) {
    return path.join(dirs.rooms, room + '.jsonl');
  }

  function loadHistory(room) {
    const file = historyFile(room);
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (_) {
      return [];
    }
    const cutoff = now() - historyDays * 86400000;
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (!msg || typeof msg.seq !== 'number') continue;
        if (msg.ts && msg.ts < cutoff) continue;
        out.push(msg);
      } catch (_) {}
    }
    return out.slice(-historyLimit);
  }

  function appendHistory(room, msg) {
    if (historyLimit <= 0) return;
    try {
      fs.appendFileSync(historyFile(room), JSON.stringify(msg) + '\n');
      const state = getLiveRoom(room);
      state.historyCount += 1;
      if (state.historyCount > historyLimit * 3) {
        const trimmed = loadHistory(room).slice(-historyLimit);
        fs.writeFileSync(historyFile(room), trimmed.map((m) => JSON.stringify(m)).join('\n') + '\n');
        state.historyCount = trimmed.length;
      }
    } catch (err) {
      if (!quiet) log('warn: history write failed:', err.message);
    }
  }

  function getLiveRoom(room) {
    let state = liveRooms.get(room);
    if (!state) {
      const history = loadHistory(room);
      state = {
        room,
        token: null,
        seq: history.reduce((max, m) => Math.max(max, m.seq || 0), 0),
        history,
        historyCount: history.length,
        clients: new Map(), // deviceId -> Set(conn)
        peers: new Map(), // deviceId -> {device, lastSeen}
        createdAt: now(),
      };
      liveRooms.set(room, state);
    }
    return state;
  }

  function persistRoomToken(room, token) {
    if (!meta.rooms[room]) {
      meta.rooms[room] = { tokenHash: crypto.createHash('sha256').update(token).digest('hex'), createdAt: now() };
      saveMetaSoon();
    }
  }

  function roomTokenMatches(room, token) {
    if (meta.rooms[room]) {
      return safeEqual(meta.rooms[room].tokenHash, crypto.createHash('sha256').update(token).digest('hex'));
    }
    return true; // first connection claims the token (stored immediately)
  }

  // ---------- pairing rendezvous (HTTP) ----------
  function getPairRoom(room) {
    let pr = pairingRooms.get(room);
    if (pr && pr.expiresAt < now()) {
      pairingRooms.delete(room);
      pr = null;
    }
    return pr;
  }

  async function handlePairJoin(req, res) {
    const ip = req.socket.remoteAddress || '';
    if (!rateLimit(ip, 'pair', 40)) return sendJson(res, 429, { error: 'rate limited' });
    const body = JSON.parse((await readBody(req, 32 * 1024)).toString('utf8') || '{}');
    const { room, token, pub, device } = body;
    if (!ROOM_RE.test(String(room || ''))) return sendJson(res, 400, { error: 'bad room' });
    if (!TOKEN_RE.test(String(token || ''))) return sendJson(res, 400, { error: 'bad token' });
    if (typeof pub !== 'string' || pub.length < 40 || pub.length > 64) return sendJson(res, 400, { error: 'bad key' });
    if (!device || !DEVICE_RE.test(String(device.id || ''))) return sendJson(res, 400, { error: 'bad device' });
    let pr = getPairRoom(room);
    if (!pr) {
      pr = { token, expiresAt: now() + pairingTTL, peers: new Map(), createdAt: now() };
      pairingRooms.set(room, pr);
    } else if (!safeEqual(pr.token, token)) {
      return sendJson(res, 403, { error: 'room token mismatch' });
    }
    const id = String(device.id).slice(0, 64);
    const peer = {
      id,
      name: String(device.name || '').slice(0, 64),
      platform: String(device.platform || '').slice(0, 32),
      pub,
      joinedAt: now(),
    };
    if (!pr.peers.has(id) && pr.peers.size >= 2) {
      return sendJson(res, 409, { error: 'room is full' });
    }
    pr.peers.set(id, peer);
    return sendJson(res, 200, {
      room,
      you: id,
      peers: [...pr.peers.values()],
      expiresAt: pr.expiresAt,
    });
  }

  async function handlePairLeave(req, res) {
    const body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}');
    const pr = pairingRooms.get(String(body.room || ''));
    if (pr && safeEqual(pr.token, String(body.token || ''))) pr.peers.delete(String(body.deviceId || ''));
    return sendJson(res, 200, { ok: true });
  }

  // ---------- encrypted backups ----------
  function roomDir(room) {
    return path.join(dirs.backups, room);
  }

  function roomUsage(room) {
    let total = 0;
    let entries = [];
    try {
      for (const name of fs.readdirSync(roomDir(room))) {
        const stat = fs.statSync(path.join(roomDir(room), name));
        if (stat.isFile()) {
          total += stat.size;
          entries.push({ name, size: stat.size, mtime: stat.mtimeMs });
        }
      }
    } catch (_) {}
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return { total, entries };
  }

  function backupAuthorized(req, res) {
    const token = String(req.headers['x-ca-token'] || '');
    if (!TOKEN_RE.test(token)) {
      sendJson(res, 401, { error: 'missing token' });
      return false;
    }
    return token;
  }

  async function handleBackup(req, res, parts) {
    const ip = req.socket.remoteAddress || '';
    if (!rateLimit(ip, 'backup', 120)) return sendJson(res, 429, { error: 'rate limited' });
    const room = parts[2];
    if (!ROOM_RE.test(String(room || ''))) return sendJson(res, 400, { error: 'bad room' });
    const token = backupAuthorized(req, res);
    if (!token) return;
    if (!roomTokenMatches(room, token)) return sendJson(res, 403, { error: 'token mismatch' });
    persistRoomToken(room, token);

    if (req.method === 'GET' && parts.length === 3) {
      const usage = roomUsage(room);
      return sendJson(res, 200, { room, used: usage.total, quota: quotaMB * 1024 * 1024, files: usage.entries });
    }
    if (req.method === 'GET' && parts.length === 4) {
      const name = parts[3];
      if (!NAME_RE.test(name)) return sendJson(res, 400, { error: 'bad name' });
      const file = path.join(roomDir(room), name);
      let buf;
      try {
        buf = fs.readFileSync(file);
      } catch (_) {
        return sendJson(res, 404, { error: 'not found' });
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': buf.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(buf);
    }
    if (req.method === 'PUT' && parts.length === 4) {
      const name = parts[3];
      if (!NAME_RE.test(name)) return sendJson(res, 400, { error: 'bad name' });
      const body = await readBody(req, Math.min(MAX_BODY, quotaMB * 1024 * 1024));
      const existing = roomUsage(room);
      const prev = existing.entries.find((e) => e.name === name);
      const usedAfter = existing.total - (prev ? prev.size : 0) + body.length;
      if (usedAfter > quotaMB * 1024 * 1024) {
        return sendJson(res, 413, { error: 'room quota exceeded', used: existing.total, quota: quotaMB * 1024 * 1024 });
      }
      fs.mkdirSync(roomDir(room), { recursive: true });
      const file = path.join(roomDir(room), name);
      const tmp = file + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, file);
      if (!quiet) log('backup', room.slice(0, 8), name, body.length + 'B');
      return sendJson(res, 200, { ok: true, name, bytes: body.length, used: usedAfter });
    }
    if (req.method === 'DELETE' && parts.length === 4) {
      const name = parts[3];
      if (!NAME_RE.test(name)) return sendJson(res, 400, { error: 'bad name' });
      try {
        fs.unlinkSync(path.join(roomDir(room), name));
      } catch (_) {}
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 405, { error: 'method not allowed' });
  }


  // ---------- http server ----------
  let server;
  const onRequest = async (req, res) => {
    const started = now();
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (_) {
      return sendJson(res, 400, { error: 'bad url' });
    }
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        return sendText(res, 200, landingPage(), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        return sendJson(res, 200, {
          ok: true,
          service: 'connect-all-relay',
          version: VERSION,
          protocol: 1,
          time: now(),
          uptimeSec: Math.round(process.uptime()),
          rooms: liveRooms.size,
          epoch: serverEpoch,
          pairingRooms: pairingRooms.size,
          historyLimit,
          quotaMB,
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/pair/join') return await handlePairJoin(req, res);
      if (req.method === 'POST' && url.pathname === '/api/pair/leave') return await handlePairLeave(req, res);
      if (parts[0] === 'api' && parts[1] === 'backup') return await handleBackup(req, res, parts);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': 'GET,PUT,DELETE,POST',
        });
        return res.end();
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500 && !quiet) log('error', url.pathname, err.message);
      return sendJson(res, status, { error: status === 500 ? 'internal error' : err.message });
    } finally {
      if (!quiet && url.pathname !== '/api/health') {
        const ms = now() - started;
        if (ms > 500) log('slow request', url.pathname, ms + 'ms', req.socket.remoteAddress);
      }
    }
  };

  const tlsCert = options.tlsCert;
  const tlsKey = options.tlsKey;
  if (tlsCert && tlsKey) {
    server = https.createServer(
      { cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey) },
      onRequest
    );
  } else {
    server = http.createServer(onRequest);
  }

  // ---------- websocket relay ----------
  function socketVerify(req) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (_) {
      return false;
    }
    const room = url.searchParams.get('room') || '';
    const token = url.searchParams.get('token') || '';
    const deviceId = url.searchParams.get('device') || '';
    if (!ROOM_RE.test(room) || !TOKEN_RE.test(token)) return false;
    if (!DEVICE_RE.test(deviceId)) return false;
    const since = Math.max(0, Number(url.searchParams.get('since') || 0) || 0);
    const ip = req.socket.remoteAddress || '';
    if (!rateLimit(ip, 'ws', 120)) return false;
    if (!roomTokenMatches(room, token)) return false;
    persistRoomToken(room, token);
    return { room, token, deviceId, since };
  }

  function broadcast(room, payload, exceptConn) {
    const state = getLiveRoom(room);
    const text = JSON.stringify(payload);
    for (const conns of state.clients.values()) {
      for (const c of conns) {
        if (c !== exceptConn && !c.closed) c.send(text);
      }
    }
  }

  function presence(room, deviceId, online) {
    const state = getLiveRoom(room);
    broadcast(room, { type: 'peer', deviceId, online, at: now() });
    const peer = state.peers.get(deviceId);
    if (peer) peer.lastSeen = now();
  }

  function handleWs(conn) {
    const { room, deviceId, since } = conn.context;
    const state = getLiveRoom(room);
    if (!state.clients.has(deviceId)) state.clients.set(deviceId, new Set());
    state.clients.get(deviceId).add(conn);
    connections.add(conn);
    if (!quiet) log('ws open', room.slice(0, 8), deviceId.slice(0, 8), 'clients=' + state.clients.size);

    conn.send(
      JSON.stringify({
        type: 'ready',
        room,
        deviceId,
        seq: state.seq,
        epoch: serverEpoch,
        history: historyLimit,
      })
    );
    if (state.history.length) {
      const pending = state.history.filter((m) => m.seq > since).slice(-500);
      if (pending.length) conn.send(JSON.stringify({ type: 'history', messages: pending }));
    }
    presence(room, deviceId, true);

    conn.on('message', (msg) => {
      if (msg.type !== 'text') return;
      if (msg.data.length > 256 * 1024) {
        conn.close(1009, 'too large');
        return;
      }
      if (!rateLimit(conn.socket.remoteAddress || '', 'msg', 600)) {
        conn.close(1008, 'rate limited');
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(msg.data);
      } catch (_) {
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;
      if (parsed.type === 'ping') {
        conn.send(JSON.stringify({ type: 'pong', at: now() }));
        return;
      }
      if (parsed.type !== 'msg') return;
      if (typeof parsed.id !== 'string' || typeof parsed.cipher !== 'string') return;
      if (parsed.id.length > 80 || parsed.cipher.length > 200000) return;
      state.seq += 1;
      const record = {
        seq: state.seq,
        id: parsed.id,
        from: deviceId,
        kind: typeof parsed.kind === 'string' ? parsed.kind.slice(0, 16) : 'data',
        cipher: parsed.cipher,
        ts: now(),
      };
      state.history.push(record);
      if (state.history.length > historyLimit) state.history = state.history.slice(-historyLimit);
      appendHistory(room, record);
      broadcast(room, { type: 'msg', ...record }, conn);
      conn.send(JSON.stringify({ type: 'ack', id: record.id, seq: record.seq }));
    });

    const cleanup = () => {
      const set = state.clients.get(deviceId);
      if (set) set.delete(conn);
      if (set && set.size === 0) {
        state.clients.delete(deviceId);
        presence(room, deviceId, false);
      }
      connections.delete(conn);
    };
    conn.on('close', cleanup);
    conn.on('error', cleanup);
  }

  attach(server, { path: '/ws', verify: socketVerify, onConnection: handleWs });

  // ---------- housekeeping ----------
  const housekeeper = setInterval(() => {
    const t = now();
    for (const [room, pr] of pairingRooms) {
      if (pr.expiresAt < t) pairingRooms.delete(room);
    }
    // Drop idle room history from memory (kept on disk).
    for (const [room, state] of liveRooms) {
      if (state.clients.size === 0 && t - state.createdAt > 6 * 60 * 60 * 1000) {
        liveRooms.delete(room);
      }
    }
  }, 60000);
  if (housekeeper.unref) housekeeper.unref();

  const heartbeat = setInterval(() => {
    for (const conn of connections) {
      if (conn.closed) continue;
      if (now() - conn.lastActivity > 90000) conn.close(1001, 'idle');
      else conn.ping();
    }
  }, 30000);
  if (heartbeat.unref) heartbeat.unref();

  return {
    server,
    port,
    host,
    dataDir,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          const addr = server.address();
          if (!quiet) {
            log('Connect All relay ' + VERSION + ' listening on ' + (addr.address || host) + ':' + addr.port);
            log('data dir:', dataDir, '| quota:', quotaMB + 'MB', '| history:', historyLimit);
          }
          resolve(addr);
        });
      });
    },
    close() {
      if (closed) return Promise.resolve();
      closed = true;
      clearInterval(housekeeper);
      clearInterval(heartbeat);
      saveMetaNow();
      for (const conn of connections) {
        try {
          conn.close(1001, 'server shutting down');
        } catch (_) {}
      }
      return new Promise((resolve) => {
        server.close(() => resolve());
        setTimeout(resolve, 500);
      });
    },
    stats() {
      return {
        rooms: liveRooms.size,
        pairingRooms: pairingRooms.size,
        connections: connections.size,
      };
    },
  };
}

function landingPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Connect All Relay</title>
<style>
body{font:14px/1.6 Monaco,Menlo,monospace;background:#fff;color:#000;max-width:640px;margin:48px auto;padding:0 20px}
h1{font-size:18px;border-bottom:2px solid #000;padding-bottom:8px}
code{background:#f0f0f0;padding:2px 4px}
.ok{display:inline-block;border:1px solid #000;padding:1px 6px;background:#000;color:#fff}
</style></head>
<body>
<h1>Connect All — Private Relay</h1>
<p class="ok">RUNNING</p>
<p>This machine relays encrypted messages between two paired devices and stores encrypted backups. It cannot read their contents.</p>
<p>Paste this address into <b>Connect All → Private Server</b>:</p>
<p><code id="u"></code></p>
<p>Health check: <a href="/api/health">/api/health</a></p>
<script>document.getElementById('u').textContent = location.origin;</script>
</body></html>`;
}

// ---------- CLI ----------
function parseArgs(argv) {
  const out = { port: 8787, host: '0.0.0.0', dataDir: path.join(process.cwd(), 'ca-data'), quotaMB: 512, historyLimit: 300, historyDays: 7 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--port':
      case '-p':
        out.port = Number(next());
        break;
      case '--host':
        out.host = next();
        break;
      case '--data':
      case '-d':
        out.dataDir = path.resolve(next());
        break;
      case '--quota-mb':
        out.quotaMB = Number(next());
        break;
      case '--history':
        out.historyLimit = Number(next());
        break;
      case '--history-days':
        out.historyDays = Number(next());
        break;
      case '--tls-cert':
        out.tlsCert = path.resolve(next());
        break;
      case '--tls-key':
        out.tlsKey = path.resolve(next());
        break;
      case '--quiet':
        out.quiet = true;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        break;
    }
  }
  return out;
}

function printHelp() {
  console.log(`Connect All relay ${VERSION}

Usage:
  node ca-server.js [options]

Options:
  -p, --port <n>          listen port (default 8787)
      --host <addr>       bind address (default 0.0.0.0)
  -d, --data <dir>        data directory (default ./ca-data)
      --quota-mb <n>      per-room encrypted backup quota (default 512)
      --history <n>       offline messages kept per room (default 300)
      --history-days <n>  offline message retention in days (default 7)
      --tls-cert <file>   TLS certificate (PEM)
      --tls-key <file>    TLS private key (PEM)
      --quiet             less logging
  -h, --help              this help

Reverse proxy (recommended): terminate TLS with Caddy/nginx and forward
both HTTP and WebSocket upgrades to this port.
`);
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  const relay = createRelay(args);
  relay.listen().catch((err) => {
    console.error('failed to start:', err.message);
    process.exit(1);
  });
  const shutdown = () => {
    relay.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createRelay, VERSION };
