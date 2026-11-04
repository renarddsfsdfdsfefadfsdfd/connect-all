'use strict';
/*
 * Link — the encrypted pipe between the two devices.
 *
 * It picks LAN when available and falls back to the private relay, envelopes
 * every payload with AES-256-GCM using a per-topic subkey, de-duplicates,
 * queues when offline, and acknowledges chat delivery.
 */

const { EventEmitter } = require('events');
const ca = require('./crypto');
const { RelayTransport } = require('./relay-transport');
const { LanTransport } = require('./lan-transport');

const MAX_QUEUE = 400;
const MAX_SEEN = 4000;
const AAD_PREFIX = 'ca1|';

class Link extends EventEmitter {
  constructor({ identity, config, state, logger = () => {} }) {
    super();
    this.identity = identity;
    this.config = config;
    this.stateStore = state;
    this.logger = logger;
    this.keys = null;
    this.relay = null;
    this.lan = null;
    this.queue = [];
    this.seen = new Set();
    this.stopped = true;
    this._flushTimer = null;
  }

  start() {
    this.stop();
    this.stopped = false;
    if (!this.identity.isPaired) {
      this._emitState();
      return;
    }
    this.keys = this.identity.keys();
    if (!this.keys) {
      this._emitState();
      return;
    }
    const cfg = this.config.get();
    const mode = cfg.transport.mode || 'auto';
    const creds = this.identity.relayCredentials();
    const lanTag = this.identity.lanTag();
    const serverUrl = (cfg.server.url || '').trim();

    if (mode !== 'lan' && mode !== 'offline' && serverUrl && creds) {
      const since = Number(this.stateStore.get().relaySeq || 0);
      this.relay = new RelayTransport({
        serverUrl,
        room: creds.room,
        token: creds.token,
        deviceId: this.identity.id,
        insecure: Boolean(cfg.server.insecure),
        since,
        epoch: this.stateStore.get().relayEpoch || '',
        logger: this.logger,
      });
      this.relay.on('message', (record) => this._receive(record));
      this.relay.on('state', () => this._emitState());
      this.relay.on('online', () => {
        this.emit('transport-online', { via: 'relay' });
        this.emit('online', { via: 'relay' });
        this._flush();
      });
      this.relay.on('offline', () => this._emitState());
      this.relay.on('peer', (info) => this.emit('peer-presence', info));
      this.relay.on('seq', (seq) => {
        const st = this.stateStore.get();
        st.relaySeq = seq;
        this.stateStore.saveSoon(800);
      });
      this.relay.on('epoch', (epoch) => {
        const st = this.stateStore.get();
        st.relayEpoch = epoch;
        this.stateStore.saveSoon(800);
      });
      this.relay.start();
    }

    if (mode !== 'relay' && mode !== 'offline' && lanTag && this.identity.peer) {
      const lanEnabled = cfg.transport.lan !== false;
      if (lanEnabled) {
        this.lan = new LanTransport({
          tag: lanTag,
          deviceId: this.identity.id,
          peerDeviceId: this.identity.peer.id,
          deviceName: this.identity.name,
          peerName: this.identity.peer.name,
          port: Number(cfg.transport.lanPort || 47710),
          discovery: cfg.transport.discovery !== false,
          logger: this.logger,
        });
        this.lan.on('message', (record) => this._receive(record));
        this.lan.on('state', () => this._emitState());
        this.lan.on('online', () => {
          this.emit('transport-online', { via: 'lan' });
          this.emit('online', { via: 'lan' });
          this._flush();
        });
        this.lan.on('offline', () => this._emitState());
        this.lan.on('discovered', (info) => this.emit('lan-discovered', info));
        this.lan.start();
      }
    }

    this._flushTimer = setInterval(() => this._flush(), 10000);
    if (this._flushTimer.unref) this._flushTimer.unref();
    setTimeout(() => this._emitState(), 50);
  }

  stop() {
    this.stopped = true;
    if (this._flushTimer) clearInterval(this._flushTimer);
    this._flushTimer = null;
    if (this.relay) this.relay.stop();
    if (this.lan) this.lan.stop();
    this.relay = null;
    this.lan = null;
    this._emitState();
  }

  reconfigure() {
    const paired = this.identity.isPaired;
    this.start();
    if (paired) this.emit('online', { via: this.via() });
  }

  keysFor(kind) {
    if (!this.keys) return null;
    return this.keys[kind] || this.keys.chat;
  }

  _emitState() {
    this.emit('state', this.state());
  }

  state() {
    const cfg = this.config.get();
    return {
      paired: this.identity.isPaired,
      online: this.online(),
      via: this.via(),
      relay: this.relay ? this.relay.state : 'off',
      lan: this.lan ? this.lan.state : 'off',
      lanPeerFound: this.lan ? Boolean(this.lan.peer) : false,
      lanAvailable: Boolean(this.lan),
      queue: this.queue.length,
      mode: cfg.transport.mode || 'auto',
      serverUrl: cfg.server.url || '',
      roomShort: (this.identity.relayCredentials() || {}).room ? this.identity.relayCredentials().room.slice(0, 8) : '',
    };
  }

  online() {
    return Boolean((this.lan && this.lan.online) || (this.relay && this.relay.online));
  }

  via() {
    if (this.lan && this.lan.online) return 'lan';
    if (this.relay && this.relay.online) return 'relay';
    return '';
  }

  _markSeen(id) {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > MAX_SEEN) {
      const first = this.seen.values().next().value;
      this.seen.delete(first);
    }
    return true;
  }

  _receive(record) {
    if (!record || !record.id || !record.cipher) return;
    if (!this._markSeen(record.id)) return;
    const key = this.keysFor(record.kind);
    if (!key) return;
    const plaintext = ca.open(key, record.cipher, AAD_PREFIX + record.kind);
    if (plaintext == null) {
      this.emit('undecryptable', { id: record.id, kind: record.kind, via: record.via });
      return;
    }
    let payload;
    try {
      payload = JSON.parse(plaintext);
    } catch (_) {
      return;
    }
    const meta = { id: record.id, kind: record.kind, via: record.via, at: record.at, from: record.from };
    if (record.kind === 'chat') {
      // Acknowledge before handing to the app so the sender's ticks update even
      // if the UI does something slow.
      this._send('ack', { id: record.id, at: Date.now() }, { ack: false });
    }
    this.emit(record.kind, payload, meta);
    this.emit('message', { kind: record.kind, payload, meta });
  }

  _send(kind, payload, { ack = false } = {}) {
    if (!this.keys) return { id: '', queued: true, via: '' };
    const key = this.keysFor(kind);
    const id = ca.randomId(10);
    const cipher = ca.seal(key, JSON.stringify(payload), AAD_PREFIX + kind);
    const envelope = { v: 1, id, kind, cipher };
    this._markSeen(id);
    const target = this.lan && this.lan.online ? this.lan : this.relay && this.relay.online ? this.relay : null;
    if (!target) {
      this.queue.push(envelope);
      if (this.queue.length > MAX_QUEUE) this.queue.shift();
      return { id, queued: true, via: '' };
    }
    let ok;
    try {
      ok = target.send(envelope);
    } catch (_) {
      ok = false;
    }
    if (!ok) {
      this.queue.push(envelope);
      return { id, queued: true, via: this.via() };
    }
    if (ack) this.emit('sent', { id, via: target === this.lan ? 'lan' : 'relay' });
    return { id, queued: false, via: target === this.lan ? 'lan' : 'relay' };
  }

  send(kind, payload, opts = {}) {
    return this._send(kind, payload, opts);
  }

  _flush() {
    if (!this.queue.length) return;
    const target = this.lan && this.lan.online ? this.lan : this.relay && this.relay.online ? this.relay : null;
    if (!target) return;
    const pending = this.queue.splice(0, this.queue.length);
    for (const envelope of pending) {
      try {
        target.send(envelope);
      } catch (_) {
        this.queue.push(envelope);
      }
    }
    if (pending.length) this.emit('flushed', { count: pending.length, via: this.via() });
    this._emitState();
  }

  /** Force a local-only direct dial (diagnostics). */
  dialLan(address, port) {
    if (this.lan) this.lan.forcePeer(address, port);
  }
}

module.exports = { Link, AAD_PREFIX };
