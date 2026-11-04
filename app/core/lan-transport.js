'use strict';
/*
 * LAN transport: zero-configuration direct connection when both partners are
 * on the same network.
 *
 *   UDP 47710  discovery beacons (HMAC tag derived from the pair root)
 *   TCP        line-delimited JSON signalling + chat/status/calendar envelopes
 *
 * Only the lexicographically smaller device id dials, so two devices never
 * race each other into duplicate sockets. Payloads are already end-to-end
 * encrypted by Link; this layer only moves opaque envelopes.
 */

const dgram = require('dgram');
const net = require('net');
const os = require('os');
const { EventEmitter } = require('events');

const DEFAULT_PORT = 47710;
const MAX_LINE = 1024 * 1024;

function broadcastTargets(port) {
  const targets = new Set(['127.0.0.1', '255.255.255.255']);
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const iface of list || []) {
        if (iface.family !== 'IPv4' || iface.internal || !iface.netmask) continue;
        const ip = iface.address.split('.').map(Number);
        const mask = iface.netmask.split('.').map(Number);
        if (ip.length !== 4 || mask.length !== 4) continue;
        const bcast = ip.map((n, i) => (n | (~mask[i] & 255)) & 255).join('.');
        targets.add(bcast);
      }
    }
  } catch (_) {}
  return [...targets].map((address) => ({ address, port }));
}

class LanTransport extends EventEmitter {
  constructor({
    tag,
    deviceId,
    peerDeviceId,
    deviceName = '',
    peerName = '',
    port = DEFAULT_PORT,
    logger = () => {},
    discovery = true,
  }) {
    super();
    this.tag = tag;
    this.deviceId = deviceId;
    this.peerDeviceId = peerDeviceId;
    this.deviceName = deviceName;
    this.peerName = peerName;
    this.port = Number(port) || DEFAULT_PORT;
    this.discovery = discovery && this.port > 0;
    this.logger = logger;
    this.state = 'offline';
    this.stopped = true;

    this.udp = null;
    this.tcp = null;
    this.tcpPort = 0;
    this.socket = null;
    this.connectedRole = '';
    this.peer = null; // {address, port, lastSeen}
    this.queue = [];
    this.retry = 0;
    this._retryTimer = null;
    this._beaconTimer = null;
    this._staleTimer = null;
    this._heartbeat = null;
    this._lastPong = 0;
    this._buf = '';
    this._helloTimer = null;
  }

  get online() {
    return this.state === 'connected';
  }

  _setState(state, detail) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', { state, via: 'lan', detail: detail || '', peerFound: Boolean(this.peer) });
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this._startTcp();
    if (this.discovery) this._startUdp();
    this._heartbeat = setInterval(() => this._checkHeartbeat(), 10000);
    if (this._heartbeat.unref) this._heartbeat.unref();
  }

  stop() {
    this.stopped = true;
    for (const timer of ['_retryTimer', '_beaconTimer', '_staleTimer', '_heartbeat', '_helloTimer']) {
      if (this[timer]) clearTimeout(this[timer]);
      this[timer] = null;
    }
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch (_) {}
      this.socket = null;
    }
    if (this.tcp) {
      try {
        this.tcp.close();
      } catch (_) {}
      this.tcp = null;
    }
    if (this.udp) {
      try {
        this.udp.close();
      } catch (_) {}
      this.udp = null;
    }
    this._setState('offline');
  }

  /* ---------------- TCP ---------------- */

  _startTcp() {
    this.tcp = net.createServer((socket) => this._accept(socket));
    this.tcp.on('error', (err) => this.logger('warn', 'lan tcp server error: ' + err.message));
    this.tcp.listen(0, '0.0.0.0', () => {
      this.tcpPort = this.tcp.address().port;
      this.emit('listening', { port: this.tcpPort });
      if (this.discovery) this._beacon();
      this._tryInitiate();
    });
  }

  _accept(socket) {
    socket.setNoDelay(true);
    socket.setTimeout(8000);
    let buf = '';
    let done = false;
    const fail = (why) => {
      if (done) return;
      done = true;
      this.logger('warn', 'lan incoming rejected: ' + why);
      try {
        socket.destroy();
      } catch (_) {}
    };
    socket.on('timeout', () => fail('hello timeout'));
    socket.on('error', () => fail('socket error'));
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.length > MAX_LINE) return fail('hello too large');
      const idx = buf.indexOf('\n');
      if (idx < 0) return;
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      let hello;
      try {
        hello = JSON.parse(line);
      } catch (_) {
        return fail('bad hello');
      }
      if (!hello || hello.type !== 'hello' || hello.tag !== this.tag) return fail('tag mismatch');
      if (hello.deviceId !== this.peerDeviceId) return fail('unexpected device');
      done = true;
      socket.setTimeout(0);
      socket.removeAllListeners('data');
      socket.write(JSON.stringify({ type: 'welcome', deviceId: this.deviceId, tag: this.tag }) + '\n');
      if (this.socket && this.socket !== socket) {
        // keep the connection initiated by the smaller id; drop duplicates
        fail('duplicate');
        return;
      }
      this._attach(socket, 'accept', hello.deviceName || '');
      if (buf) this._ingest(buf);
    });
  }

  _tryInitiate() {
    if (this.stopped || this.socket) return;
    if (!this.peer || !this.peer.port) return;
    if (!(this.deviceId < this.peerDeviceId)) return; // deterministic dialer
    this._dial();
  }

  _dial() {
    if (this.stopped || this.socket) return;
    if (!this.peer || !this.peer.address) return;
    this._setState('searching', 'dialing');
    const socket = net.connect({ host: this.peer.address, port: this.peer.port });
    socket.setNoDelay(true);
    socket.setTimeout(8000);
    this._helloTimer = setTimeout(() => {
      try {
        socket.destroy();
      } catch (_) {}
      this._scheduleRetry();
    }, 8000);
    socket.once('connect', () => {
      socket.write(
        JSON.stringify({ type: 'hello', tag: this.tag, deviceId: this.deviceId, deviceName: this.deviceName }) + '\n'
      );
      this._attach(socket, 'dial');
    });
    socket.on('error', (err) => {
      this.logger('warn', 'lan dial error: ' + err.message);
    });
    socket.once('close', () => {
      if (this.socket === socket) {
        this.socket = null;
        this._setState('searching', 'closed');
        this.emit('offline', { via: 'lan' });
      }
      this._scheduleRetry();
    });
    this._pendingDial = socket;
  }

  _attach(socket, role, peerName) {
    if (this._helloTimer) {
      clearTimeout(this._helloTimer);
      this._helloTimer = null;
    }
    if (this._pendingDial && this._pendingDial !== socket) {
      try {
        this._pendingDial.destroy();
      } catch (_) {}
      this._pendingDial = null;
    }
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch (_) {}
    }
    // Drop the dialing-phase listeners; _attach owns the socket from here.
    socket.removeAllListeners('close');
    socket.removeAllListeners('data');
    socket.removeAllListeners('error');
    this.socket = socket;
    this.connectedRole = role;
    this.retry = 0;
    this._buf = '';
    this._lastPong = Date.now();
    socket.setTimeout(0);
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._ingest(chunk.toString('utf8')));
    socket.on('close', () => this._onClose(socket));
    socket.on('error', () => {});
    if (role === 'dial') {
      this._welcomeTimer = setTimeout(() => {
        if (this.socket === socket) {
          this.logger('warn', 'lan welcome timeout');
          try {
            socket.destroy();
          } catch (_) {}
        }
      }, 8000);
      if (this._welcomeTimer.unref) this._welcomeTimer.unref();
    }
    this._setState('connected');
    if (peerName) this.peerName = peerName;
    this.emit('online', { via: 'lan', role, peerName: this.peerName });
    this._flush();
  }

  _onClose(socket) {
    if (this.socket !== socket) return;
    this.socket = null;
    this._setState('searching', 'closed');
    this.emit('offline', { via: 'lan' });
    this._scheduleRetry();
    this._tryInitiate();
  }

  _scheduleRetry() {
    if (this.stopped || this._retryTimer) return;
    this.retry = Math.min(this.retry + 1, 6);
    const delay = Math.min(15000, 1000 * Math.pow(2, this.retry - 1));
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      if (this.peer && this.deviceId < this.peerDeviceId) this._dial();
    }, delay);
    if (this._retryTimer.unref) this._retryTimer.unref();
  }

  _ingest(text) {
    this._buf += text;
    if (this._buf.length > MAX_LINE) {
      this.logger('warn', 'lan line too large, closing');
      if (this.socket) this.socket.destroy();
      return;
    }
    let idx;
    while ((idx = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, idx);
      this._buf = this._buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_) {
        continue;
      }
      this._onLine(msg);
    }
  }

  _onLine(msg) {
    if (!msg || typeof msg !== 'object') return;
    this._lastPong = Date.now();
    if (msg.type === 'welcome') {
      if (msg.tag !== this.tag) return;
      if (this._welcomeTimer) {
        clearTimeout(this._welcomeTimer);
        this._welcomeTimer = null;
      }
      this._setState('connected');
      return;
    }
    if (msg.type === 'ping') {
      this._write({ type: 'pong', at: Date.now() });
      return;
    }
    if (msg.type === 'pong') return;
    if (msg.type === 'data' && typeof msg.cipher === 'string' && typeof msg.id === 'string') {
      this.emit('message', {
        id: msg.id,
        kind: msg.kind || 'data',
        cipher: msg.cipher,
        from: this.peerDeviceId,
        via: 'lan',
        at: Date.now(),
      });
    }
  }

  _write(obj) {
    if (!this.socket) return false;
    try {
      this.socket.write(JSON.stringify(obj) + '\n');
      return true;
    } catch (_) {
      return false;
    }
  }

  send(envelope) {
    if (!this.socket || this.state !== 'connected') {
      this.queue.push(envelope);
      if (this.queue.length > 500) this.queue.shift();
      return false;
    }
    return this._write({ type: 'data', id: envelope.id, kind: envelope.kind, cipher: envelope.cipher });
  }

  _flush() {
    if (!this.socket) return;
    const pending = this.queue.splice(0, this.queue.length);
    for (const env of pending) {
      if (!this._write({ type: 'data', id: env.id, kind: env.kind, cipher: env.cipher })) {
        this.queue.push(env);
      }
    }
  }

  _checkHeartbeat() {
    if (!this.socket) {
      if (this.peer && this.deviceId < this.peerDeviceId) this._tryInitiate();
      return;
    }
    if (Date.now() - this._lastPong > 35000) {
      this.logger('warn', 'lan peer heartbeat timeout');
      try {
        this.socket.destroy();
      } catch (_) {}
      return;
    }
    this._write({ type: 'ping', at: Date.now() });
  }

  /* ---------------- UDP discovery ---------------- */

  _startUdp() {
    const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.udp = udp;
    udp.on('error', (err) => this.logger('warn', 'lan udp error: ' + err.message));
    udp.on('message', (buf, rinfo) => this._onBeacon(buf, rinfo));
    udp.bind(this.port, () => {
      try {
        udp.setBroadcast(true);
      } catch (_) {}
      this._beacon();
    });
    this._beaconTimer = setInterval(() => this._beacon(), 2000);
    if (this._beaconTimer.unref) this._beaconTimer.unref();
    this._staleTimer = setInterval(() => {
      if (this.peer && Date.now() - this.peer.lastSeen > 12000) {
        this.peer = null;
        this.emit('state', { state: this.state, via: 'lan', peerFound: false });
      }
    }, 4000);
    if (this._staleTimer.unref) this._staleTimer.unref();
  }

  _beacon() {
    if (!this.udp || !this.tcpPort) return;
    const payload = Buffer.from(
      JSON.stringify({
        ca: 1,
        tag: this.tag,
        deviceId: this.deviceId,
        name: this.deviceName.slice(0, 40),
        port: this.tcpPort,
        ts: Date.now(),
      })
    );
    for (const target of broadcastTargets(this.port)) {
      try {
        this.udp.send(payload, target.port, target.address, () => {});
      } catch (_) {}
    }
  }

  _onBeacon(buf, rinfo) {
    if (!buf || buf.length > 2048) return;
    let data;
    try {
      data = JSON.parse(buf.toString('utf8'));
    } catch (_) {
      return;
    }
    if (!data || data.ca !== 1) return;
    if (data.tag !== this.tag) return;
    if (data.deviceId === this.deviceId) return;
    if (this.peerDeviceId && data.deviceId !== this.peerDeviceId) return;
    if (!Number.isInteger(data.port) || data.port < 1 || data.port > 65535) return;
    const hadPeer = Boolean(this.peer);
    this.peer = { address: rinfo.address, port: data.port, lastSeen: Date.now(), name: data.name || '' };
    if (!hadPeer) {
      this.emit('state', { state: this.state, via: 'lan', peerFound: true });
      this.emit('discovered', { address: rinfo.address, port: data.port, name: data.name });
    }
    this._tryInitiate();
  }

  /** Test / manual hook: dial a known peer without waiting for a beacon. */
  forcePeer(address, port) {
    this.peer = { address, port, lastSeen: Date.now(), name: this.peerName || '' };
    this._tryInitiate();
  }
}

module.exports = { LanTransport, broadcastTargets, DEFAULT_PORT };
