'use strict';
/*
 * Relay transport: WebSocket to a private Connect All server (or the in-app
 * local relay). Handles reconnect, heartbeat, offline queue, and history replay
 * using the last seen sequence number.
 */

const { EventEmitter } = require('events');
const ws = require('../../server/ws');

function normalizeWsUrl(serverUrl, insecure) {
  let base = String(serverUrl || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (/^http:\/\//i.test(base)) base = 'ws://' + base.slice(7);
  else if (/^https:\/\//i.test(base)) base = 'wss://' + base.slice(8);
  else if (!/^wss?:\/\//i.test(base)) base = 'ws://' + base;
  if (!/\/ws$/.test(base)) base += '/ws';
  return base;
}

class RelayTransport extends EventEmitter {
  constructor({ serverUrl, room, token, deviceId, insecure = false, since = 0, epoch = '', logger = () => {} }) {
    super();
    this.serverUrl = serverUrl;
    this.room = room;
    this.token = token;
    this.deviceId = deviceId;
    this.insecure = insecure;
    this.logger = logger;
    this.since = Number(since) || 0;
    this.epoch = String(epoch || '');
    this.conn = null;
    this.state = 'offline';
    this.stopped = true;
    this.retry = 0;
    this.queue = [];
    this._retryTimer = null;
    this._heartbeat = null;
    this._lastActivity = 0;
  }

  url() {
    const base = normalizeWsUrl(this.serverUrl, this.insecure);
    if (!base) return '';
    const q = new URLSearchParams({
      room: this.room,
      token: this.token,
      device: this.deviceId,
      since: String(this.since || 0),
    });
    return base + '?' + q.toString();
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this._connect();
    this._heartbeat = setInterval(() => this._checkHeartbeat(), 20000);
    if (this._heartbeat.unref) this._heartbeat.unref();
  }

  stop() {
    this.stopped = true;
    if (this._retryTimer) clearTimeout(this._retryTimer);
    if (this._heartbeat) clearInterval(this._heartbeat);
    this._retryTimer = null;
    this._heartbeat = null;
    if (this.conn) {
      try {
        this.conn.close(1000, 'client stop');
      } catch (_) {}
      this.conn = null;
    }
    this._setState('offline');
  }

  _setState(state, detail) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', { state, detail: detail || '', via: 'relay' });
  }

  _connect() {
    if (this.stopped || this.conn) return;
    const url = this.url();
    if (!url) {
      this._setState('error', 'no server configured');
      return;
    }
    this._setState('connecting');
    ws.connect(url, { timeout: 15000, rejectUnauthorized: !this.insecure })
      .then((conn) => {
        if (this.stopped) {
          conn.close(1000, 'stopped');
          return;
        }
        this.conn = conn;
        this.retry = 0;
        this._lastActivity = Date.now();
        conn.on('message', (msg) => this._onMessage(msg));
        conn.on('close', (code, reason) => this._onClose(code, reason));
        conn.on('error', (err) => {
          this.logger('warn', 'relay socket error: ' + err.message);
        });
        this._setState('online');
        this.emit('online', { via: 'relay' });
        this._flush();
      })
      .catch((err) => {
        this.conn = null;
        this._setState('error', err.message);
        this._scheduleRetry();
      });
  }

  _onClose(code, reason) {
    this.conn = null;
    this._setState('offline', code + ' ' + reason);
    this.emit('offline', { via: 'relay', code, reason });
    this._scheduleRetry();
  }

  _scheduleRetry() {
    if (this.stopped || this._retryTimer) return;
    this.retry = Math.min(this.retry + 1, 6);
    const delay = Math.min(30000, 1000 * Math.pow(2, this.retry - 1)) + Math.floor(Math.random() * 500);
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._connect();
    }, delay);
    if (this._retryTimer.unref) this._retryTimer.unref();
  }

  _checkHeartbeat() {
    if (!this.conn) return;
    if (Date.now() - this._lastActivity > 75000) {
      this.logger('warn', 'relay heartbeat timeout, reconnecting');
      const conn = this.conn;
      this.conn = null;
      try {
        conn.close(1001, 'heartbeat timeout');
      } catch (_) {}
      this._setState('offline');
      this.emit('offline', { via: 'relay', code: 1001, reason: 'heartbeat' });
      this._scheduleRetry();
      return;
    }
    try {
      this.conn.ping();
    } catch (_) {}
  }

  _onMessage(msg) {
    if (msg.type !== 'text') return;
    this._lastActivity = Date.now();
    let data;
    try {
      data = JSON.parse(msg.data);
    } catch (_) {
      return;
    }
    if (!data || typeof data !== 'object') return;
    switch (data.type) {
      case 'ready': {
        this.emit('ready', data);
        const serverEpoch = String(data.epoch || '');
        const epochChanged = Boolean(this.epoch && serverEpoch && serverEpoch !== this.epoch);
        if (serverEpoch && serverEpoch !== this.epoch) {
          this.epoch = serverEpoch;
          this.emit('epoch', serverEpoch);
        }
        // A rebuilt / wiped server starts over: its sequence and epoch differ.
        // Replay from zero and let id-level dedupe drop anything we already have.
        if (epochChanged || (typeof data.seq === 'number' && data.seq < this.since)) {
          this.logger('warn', 'relay history reset detected, resyncing');
          this.since = 0;
          this.emit('seq', 0);
          try {
            this.conn.close(1001, 'resync');
          } catch (_) {}
        }
        break;
      }
      case 'history':
        if (Array.isArray(data.messages)) {
          for (const m of data.messages) this._deliver(m);
        }
        break;
      case 'msg':
        this._deliver(data);
        break;
      case 'ack':
        this.emit('ack', { id: data.id, seq: data.seq });
        break;
      case 'peer':
        this.emit('peer', { deviceId: data.deviceId, online: Boolean(data.online), at: data.at });
        break;
      case 'pong':
        break;
      default:
        break;
    }
  }

  _deliver(record) {
    if (!record || typeof record.cipher !== 'string') return;
    if (typeof record.seq === 'number' && record.seq > this.since) {
      this.since = record.seq;
      this.emit('seq', this.since);
    }
    this.emit('message', {
      id: record.id,
      kind: record.kind || 'data',
      cipher: record.cipher,
      from: record.from || '',
      seq: record.seq,
      at: record.ts,
      via: 'relay',
    });
  }

  send(envelope) {
    if (!this.conn || this.state !== 'online') {
      this.queue.push(envelope);
      if (this.queue.length > 500) this.queue.shift();
      return false;
    }
    try {
      this.conn.send(
        JSON.stringify({ type: 'msg', id: envelope.id, kind: envelope.kind, cipher: envelope.cipher })
      );
      return true;
    } catch (err) {
      this.queue.push(envelope);
      return false;
    }
  }

  _flush() {
    if (this.state !== 'online' || !this.conn) return;
    const pending = this.queue.splice(0, this.queue.length);
    for (const envelope of pending) {
      try {
        this.conn.send(JSON.stringify({ type: 'msg', id: envelope.id, kind: envelope.kind, cipher: envelope.cipher }));
      } catch (_) {
        this.queue.push(envelope);
      }
    }
  }

  get online() {
    return this.state === 'online';
  }
}

module.exports = { RelayTransport, normalizeWsUrl };
