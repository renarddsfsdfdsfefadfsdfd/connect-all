'use strict';
/*
 * Pairing ("牵手").
 *
 *  A) Private server: both devices enter the same 6-character code. The code
 *     hashes to a room; public keys meet there; both derive the same X25519
 *     root. A short 8-digit SAS is shown on both screens for a human check.
 *
 *  B) Offline: exchange two invitation strings by any channel you already
 *     trust (AirDrop, paper, another messenger). No server involved.
 *
 * The server never learns the code, only its HMAC-derived room id, and never
 * sees the pair root.
 */

const { EventEmitter } = require('events');
const ca = require('./crypto');
const { jsonRequest } = require('./http');

const INVITE_PREFIX = 'CA1.';
const POLL_MS = 1600;
const PAIR_TTL_MS = 15 * 60 * 1000;

function encodeInvite(obj) {
  return INVITE_PREFIX + Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

function decodeInvite(text) {
  const raw = String(text || '').trim();
  const body = raw.startsWith(INVITE_PREFIX) ? raw.slice(INVITE_PREFIX.length) : raw;
  let obj;
  try {
    obj = JSON.parse(Buffer.from(body.replace(/\s+/g, ''), 'base64url').toString('utf8'));
  } catch (_) {
    throw new Error('邀请码格式不正确 / Invalid invitation text');
  }
  if (!obj || obj.v !== 1 || !obj.pub || !obj.device || !obj.device.id) {
    throw new Error('邀请码内容不完整 / Incomplete invitation');
  }
  if (String(obj.pub).length < 40 || String(obj.pub).length > 64) {
    throw new Error('邀请码公钥无效 / Invalid public key');
  }
  return obj;
}

class PairingSession extends EventEmitter {
  constructor({ identity, serverUrl = '', insecure = false, logger = () => {} }) {
    super();
    this.identity = identity;
    this.serverUrl = String(serverUrl || '').replace(/\/+$/, '');
    this.insecure = Boolean(insecure);
    this.logger = logger;
    this.mode = ''; // server | offline
    this.code = '';
    this.room = '';
    this.token = '';
    this.peer = null;
    this.sas = '';
    this.reply = '';
    this.state = 'idle';
    this.timer = null;
    this.ttlTimer = null;
    this.cancelled = false;
    this._busy = false;
    this._errors = 0;
  }

  status() {
    return {
      state: this.state,
      mode: this.mode,
      code: this.code,
      sas: this.sas,
      peer: this.peer
        ? { id: this.peer.id, name: this.peer.name, platform: this.peer.platform }
        : null,
      reply: this.reply,
      serverUrl: this.serverUrl,
      expiresAt: this.expiresAt || 0,
    };
  }

  /* ---------------- server mode ---------------- */

  async startServer(code) {
    if (this.identity.isPaired) throw new Error('这台设备已经牵手了 / This device is already paired');
    if (!this.serverUrl) throw new Error('先在「私有服务器」里填写地址 / Set a server address first');
    this.cancel();
    this.cancelled = false;
    this.mode = 'server';
    this.state = 'waiting';
    this.code = code ? ca.normalizePairingCode(code) : ca.generatePairingCode();
    if (this.code.length !== ca.PAIR_CODE_LENGTH) {
      throw new Error('牵手码应为 6 位 / Pairing code must be 6 characters');
    }
    this.room = ca.pairRoom(this.code);
    this.token = ca.roomToken(this.code);
    this.expiresAt = Date.now() + PAIR_TTL_MS;
    await this._join();
    this._startPolling();
    this.ttlTimer = setTimeout(() => this._expire(), PAIR_TTL_MS);
    if (this.ttlTimer.unref) this.ttlTimer.unref();
    this.emit('state', this.status());
    return this.status();
  }

  async _join() {
    if (this.cancelled) return;
    try {
      const res = await jsonRequest(this.serverUrl + '/api/pair/join', {
        method: 'POST',
        insecure: this.insecure,
        timeout: 15000,
        body: {
          room: this.room,
          token: this.token,
          pub: this.identity.publicKey,
          device: {
            id: this.identity.id,
            name: this.identity.name,
            platform: this.identity.platform,
          },
        },
      });
      this._errors = 0;
      const peers = Array.isArray(res.peers) ? res.peers : [];
      const other = peers.find((p) => p && p.id !== this.identity.id);
      if (other) this._foundPeer(other);
    } catch (err) {
      this._errors += 1;
      this.emit('error', { message: err.message, errors: this._errors });
      if (this.state === 'waiting' && this._errors >= 20) {
        this.state = 'error';
        this.emit('state', this.status());
      }
    }
  }

  _foundPeer(peer) {
    if (this.peer && this.peer.id === peer.id) return;
    try {
      const derived = this.identity.deriveWith({
        id: peer.id,
        publicKey: peer.pub || peer.publicKey,
      });
      this.peer = {
        id: peer.id,
        name: peer.name || 'Partner',
        platform: peer.platform || '',
        publicKey: peer.pub || peer.publicKey,
        derived,
      };
      this.sas = ca.sasFromRoot(derived.root);
      this.state = 'verify';
      this._stopPolling();
      this.emit('peer', this.status());
      this.emit('state', this.status());
    } catch (err) {
      this.emit('error', { message: err.message });
    }
  }

  _startPolling() {
    this._stopPolling();
    this.timer = setInterval(() => {
      if (this.state === 'waiting') this._join();
    }, POLL_MS);
    if (this.timer.unref) this.timer.unref();
  }

  _stopPolling() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  _expire() {
    if (this.state === 'waiting' || this.state === 'verify') {
      this.state = 'expired';
      this._stopPolling();
      this.emit('state', this.status());
    }
  }

  /* ---------------- offline mode ---------------- */

  createInvite() {
    if (this.identity.isPaired) throw new Error('这台设备已经牵手了 / This device is already paired');
    this.cancel();
    this.cancelled = false;
    this.mode = 'offline';
    this.state = 'invite';
    const payload = {
      v: 1,
      type: 'ca-invite',
      pub: this.identity.publicKey,
      device: {
        id: this.identity.id,
        name: this.identity.name,
        platform: this.identity.platform,
      },
      serverUrl: this.serverUrl,
      createdAt: Date.now(),
    };
    this.code = '';
    this.invite = encodeInvite(payload);
    this.emit('state', this.status());
    return { invite: this.invite, status: this.status() };
  }

  acceptInvite(text) {
    if (this.identity.isPaired) throw new Error('这台设备已经牵手了 / This device is already paired');
    const payload = decodeInvite(text);
    if (payload.type !== 'ca-invite') throw new Error('这不是邀请码 / This is not an invitation');
    if (payload.device.id === this.identity.id) throw new Error('这是你自己的邀请码 / That is your own invitation');
    this.cancel();
    this.cancelled = false;
    this.mode = 'offline';
    this.peer = {
      id: String(payload.device.id),
      name: String(payload.device.name || 'Partner'),
      platform: String(payload.device.platform || ''),
      publicKey: String(payload.pub),
    };
    if (payload.serverUrl) this.serverUrl = String(payload.serverUrl).replace(/\/+$/, '');
    const derived = this.identity.deriveWith(this.peer);
    this.peer.derived = derived;
    this.sas = ca.sasFromRoot(derived.root);
    this.reply = encodeInvite({
      v: 1,
      type: 'ca-reply',
      pub: this.identity.publicKey,
      device: {
        id: this.identity.id,
        name: this.identity.name,
        platform: this.identity.platform,
      },
      serverUrl: this.serverUrl,
      createdAt: Date.now(),
    });
    this.state = 'reply';
    this.emit('peer', this.status());
    this.emit('state', this.status());
    return this.status();
  }

  acceptReply(text) {
    const payload = decodeInvite(text);
    if (payload.type !== 'ca-reply') throw new Error('这不是回执码 / This is not a reply code');
    if (payload.device.id === this.identity.id) throw new Error('这是你自己的邀请码 / That is your own invitation');
    this.mode = 'offline';
    if (!this.peer) {
      this.peer = {
        id: String(payload.device.id),
        name: String(payload.device.name || 'Partner'),
        platform: String(payload.device.platform || ''),
        publicKey: String(payload.pub),
      };
    } else if (this.peer.id !== payload.device.id) {
      throw new Error('回执来自另一台设备 / Reply is from a different device');
    }
    if (payload.serverUrl) this.serverUrl = String(payload.serverUrl).replace(/\/+$/, '');
    const derived = this.identity.deriveWith(this.peer);
    this.peer.derived = derived;
    this.sas = ca.sasFromRoot(derived.root);
    this.state = 'verify';
    this.emit('state', this.status());
    return this.status();
  }

  /* ---------------- shared ---------------- */

  confirm() {
    if (!this.peer || !this.peer.derived) throw new Error('还没有可确认的对方 / No peer to confirm yet');
    if (this.identity.isPaired) throw new Error('这台设备已经牵手了 / This device is already paired');
    this.identity.completePairing(this.peer, { serverUrl: this.serverUrl });
    this.state = 'paired';
    this._stopPolling();
    if (this.ttlTimer) clearTimeout(this.ttlTimer);
    this.emit('paired', {
      peer: this.peer,
      sas: this.sas,
      serverUrl: this.serverUrl,
      mode: this.mode,
    });
    this.emit('state', this.status());
    return this.status();
  }

  cancel() {
    const leaveRoom = this.mode === 'server' ? this.room : '';
    const leaveToken = this.token;
    const leaveServer = this.serverUrl;
    this.cancelled = true;
    this._stopPolling();
    if (this.ttlTimer) clearTimeout(this.ttlTimer);
    this.ttlTimer = null;
    this.state = 'idle';
    this.peer = null;
    this.sas = '';
    this.reply = '';
    this.code = '';
    this.room = '';
    this.token = '';
    if (leaveRoom && leaveServer) {
      jsonRequest(leaveServer + '/api/pair/leave', {
        method: 'POST',
        insecure: this.insecure,
        timeout: 4000,
        body: { room: leaveRoom, token: leaveToken, deviceId: this.identity.id },
      }).catch(() => {});
    }
  }
}

module.exports = { PairingSession, encodeInvite, decodeInvite, INVITE_PREFIX };
