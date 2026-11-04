'use strict';
/*
 * Connect All — minimal, dependency-free WebSocket (RFC 6455) for the relay.
 *
 * Why not the `ws` package: the private server must be a single disposable folder
 * on a VPS with no `npm install`, and the desktop app should ship without native
 * or network-installed runtime dependencies. This file is shared by both sides.
 *
 * Supported: server + client handshake, text/binary frames, fragmentation,
 * ping/pong, close with code/reason, 4 MiB payload cap, backpressure queue.
 */

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 4 * 1024 * 1024;

const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

function encodeFrame(opcode, payload, masked) {
  const len = payload.length;
  const headerLen = 2 + (len < 126 ? 0 : len < 65536 ? 2 : 8) + (masked ? 4 : 0);
  const buf = Buffer.allocUnsafe(headerLen + len);
  buf[0] = 0x80 | opcode; // FIN + opcode
  let off;
  if (len < 126) {
    buf[1] = len;
    off = 2;
  } else if (len < 65536) {
    buf[1] = 126;
    buf.writeUInt16BE(len, 2);
    off = 4;
  } else {
    buf[1] = 127;
    buf.writeBigUInt64BE(BigInt(len), 2);
    off = 10;
  }
  if (masked) {
    buf[1] |= 0x80;
    const key = crypto.randomBytes(4);
    key.copy(buf, off);
    off += 4;
    for (let i = 0; i < len; i++) buf[off + i] = payload[i] ^ key[i & 3];
  } else {
    payload.copy(buf, off);
  }
  return buf;
}

class FrameParser {
  constructor({ onFrame, onError, maxPayload = MAX_PAYLOAD }) {
    this.onFrame = onFrame;
    this.onError = onError || (() => {});
    this.maxPayload = maxPayload;
    this.buf = Buffer.alloc(0);
    this.frag = null; // {opcode, chunks, size}
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 2) {
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) return this._fail(1009, 'message too big');
        len = Number(big);
        off = 10;
      }
      if (len > this.maxPayload) return this._fail(1009, 'message too big');
      let maskKey = null;
      if (masked) {
        if (this.buf.length < off + 4) return;
        maskKey = this.buf.subarray(off, off + 4);
        off += 4;
      }
      if (this.buf.length < off + len) return;
      let payload = this.buf.subarray(off, off + len);
      if (maskKey) {
        payload = Buffer.from(payload); // copy, never mutate the read buffer
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
      } else {
        payload = Buffer.from(payload);
      }
      this.buf = this.buf.subarray(off + len);

      if (opcode >= 0x8) {
        if (!fin) return this._fail(1002, 'fragmented control frame');
        if (len > 125) return this._fail(1002, 'control frame too large');
        this.onFrame({ opcode, fin, payload });
        if (opcode === OP.CLOSE) return; // caller closes
        continue;
      }

      if (opcode === OP.CONT) {
        if (!this.frag) return this._fail(1002, 'unexpected continuation frame');
        this.frag.chunks.push(payload);
        this.frag.size += payload.length;
        if (this.frag.size > this.maxPayload) return this._fail(1009, 'message too big');
        if (fin) {
          const full = Buffer.concat(this.frag.chunks, this.frag.size);
          const op = this.frag.opcode;
          this.frag = null;
          this.onFrame({ opcode: op, fin: true, payload: full });
        }
        continue;
      }

      if (opcode === OP.TEXT || opcode === OP.BINARY) {
        if (this.frag) return this._fail(1002, 'new data frame during fragmentation');
        if (fin) {
          this.onFrame({ opcode, fin: true, payload });
        } else {
          this.frag = { opcode, chunks: [payload], size: payload.length };
        }
        continue;
      }
      return this._fail(1002, 'unknown opcode ' + opcode);
    }
  }

  _fail(code, reason) {
    this.onError(code, reason);
  }
}

class WSConnection extends EventEmitter {
  constructor(socket, { isServer = true, remoteAddress = '' } = {}) {
    super();
    this.socket = socket;
    this.isServer = isServer;
    this.remoteAddress = remoteAddress;
    this.closed = false;
    this.receivedClose = false;
    this._writeQueue = [];
    this._draining = false;
    this._lastActivity = Date.now();
    this._inbox = []; // frames that arrive before the caller attaches its listener
    this.on('newListener', (event) => {
      if (event === 'message') queueMicrotask(() => this._flushInbox());
    });
    socket.setNoDelay(true);
    this.parser = new FrameParser({
      onFrame: (f) => this._onFrame(f),
      onError: (code, reason) => {
        this.emit('protocolError', { code, reason });
        this.close(code, reason);
      },
    });
    socket.on('data', (chunk) => {
      this._lastActivity = Date.now();
      this.parser.push(chunk);
    });
    socket.on('error', (err) => {
      this.closed = true;
      this.emit('error', err);
      this.emit('close', 1006, 'socket error');
    });
    socket.on('end', () => this._finish(1006, 'peer ended'));
    socket.on('close', () => this._finish(1006, 'socket closed'));
    socket.on('drain', () => {
      this._draining = false;
      this._flush();
    });
  }

  _onFrame({ opcode, payload }) {
    this._lastActivity = Date.now();
    if (opcode === OP.TEXT) {
      this._deliver({ type: 'text', data: payload.toString('utf8') });
    } else if (opcode === OP.BINARY) {
      this._deliver({ type: 'binary', data: payload });
    } else if (opcode === OP.PING) {
      this._send(OP.PONG, payload);
    } else if (opcode === OP.PONG) {
      this.emit('pong', payload);
    } else if (opcode === OP.CLOSE) {
      this.receivedClose = true;
      let code = 1005;
      let reason = '';
      if (payload.length >= 2) {
        code = payload.readUInt16BE(0);
        reason = payload.subarray(2).toString('utf8');
      }
      if (!this.closed) this._send(OP.CLOSE, Buffer.alloc(0));
      this._finish(code, reason);
    }
  }

  _deliver(message) {
    this._inbox.push(message);
    this._flushInbox();
  }

  _flushInbox() {
    if (this.listenerCount('message') === 0) return;
    while (this._inbox.length) this.emit('message', this._inbox.shift());
  }

  _send(opcode, payload) {
    if (this.closed) return false;
    const frame = encodeFrame(opcode, payload, !this.isServer);
    if (this._draining || this._writeQueue.length) {
      this._writeQueue.push(frame);
      return true;
    }
    const ok = this.socket.write(frame);
    if (!ok) this._draining = true;
    return ok;
  }

  _flush() {
    while (!this._draining && this._writeQueue.length && !this.closed) {
      const frame = this._writeQueue.shift();
      const ok = this.socket.write(frame);
      if (!ok) this._draining = true;
    }
  }

  send(text) {
    if (typeof text !== 'string') throw new TypeError('send(text) requires a string');
    return this._send(OP.TEXT, Buffer.from(text, 'utf8'));
  }

  sendBinary(buf) {
    return this._send(OP.BINARY, Buffer.from(buf));
  }

  ping(payload = Buffer.alloc(0)) {
    return this._send(OP.PING, Buffer.from(payload));
  }

  pong(payload = Buffer.alloc(0)) {
    return this._send(OP.PONG, Buffer.from(payload));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const reasonBuf = Buffer.from(String(reason).slice(0, 120), 'utf8');
    const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    this._send(OP.CLOSE, payload);
    this._finish(code, reason);
    try {
      this.socket.end();
    } catch (_) {}
  }

  _finish(code, reason) {
    if (this._finished) return;
    this._finished = true;
    this.closed = true;
    this.emit('close', code, reason);
    try {
      this.socket.destroy();
    } catch (_) {}
  }

  get lastActivity() {
    return this._lastActivity;
  }
}

function _handshakeResponse(key) {
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  return (
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n' +
    '\r\n'
  );
}

/**
 * Attach websocket handling to an existing http/https server.
 * verify(req) -> truthy (or an object attached to conn.context) to accept; false to reject.
 */
function attach(server, { path = '/ws', verify, onConnection, maxPayload = MAX_PAYLOAD } = {}) {
  if (typeof onConnection !== 'function') throw new TypeError('onConnection required');
  server.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch (_) {
      socket.destroy();
      return;
    }
    if (pathname !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    const key = req.headers['sec-websocket-key'];
    const version = String(req.headers['sec-websocket-version'] || '');
    if (upgrade !== 'websocket' || !key || version !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    let context = null;
    if (verify) {
      try {
        context = verify(req);
      } catch (_) {
        context = null;
      }
      if (!context) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    socket.write(_handshakeResponse(key));
    const conn = new WSConnection(socket, {
      isServer: true,
      remoteAddress: socket.remoteAddress || '',
    });
    conn.context = context || true;
    conn.parser = new FrameParser({
      onFrame: (f) => conn._onFrame(f),
      onError: (code, reason) => {
        conn.emit('protocolError', { code, reason });
        conn.close(code, reason);
      },
      maxPayload,
    });
    if (head && head.length) conn.parser.push(head);
    onConnection(conn, req);
  });
  return server;
}

/**
 * Connect to a ws:// or wss:// endpoint.
 */
function connect(urlStr, { headers = {}, timeout = 12000, rejectUnauthorized = true } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (err) {
      reject(new Error('invalid websocket url'));
      return;
    }
    const secure = url.protocol === 'wss:' || url.protocol === 'https:';
    if (!secure && url.protocol !== 'ws:' && url.protocol !== 'http:') {
      reject(new Error('invalid websocket protocol'));
      return;
    }
    const key = crypto.randomBytes(16).toString('base64');
    const options = {
      hostname: url.hostname,
      port: url.port || (secure ? 443 : 80),
      path: (url.pathname || '/') + (url.search || ''),
      method: 'GET',
      headers: Object.assign(
        {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
          'User-Agent': 'ConnectAll/1.0',
        },
        headers
      ),
      rejectUnauthorized,
      agent: false,
    };
    const lib = secure ? https : http;
    let settled = false;
    const req = lib.request(options);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error('websocket handshake timeout'));
    }, timeout);
    req.on('upgrade', (res, socket, head) => {
      const expected = crypto.createHash('sha1').update(key + GUID).digest('base64');
      if (res.headers['sec-websocket-accept'] !== expected) {
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(new Error('invalid websocket handshake'));
        return;
      }
      settled = true;
      clearTimeout(timer);
      const conn = new WSConnection(socket, { isServer: false, remoteAddress: socket.remoteAddress || '' });
      if (head && head.length) conn.parser.push(head);
      resolve(conn);
    });
    req.on('response', (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res.resume();
      reject(new Error('websocket upgrade refused: HTTP ' + res.statusCode));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });
}

module.exports = { attach, connect, encodeFrame, WSConnection, GUID, OP, MAX_PAYLOAD };
