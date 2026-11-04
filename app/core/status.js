'use strict';
/*
 * Presence / status. Privacy-first: the partner only learns what this class
 * explicitly puts in the encrypted status envelope. Location is either the
 * LOCATION of a calendar event that is starting, or a place the user typed —
 * never continuous GPS tracking.
 */

const { EventEmitter } = require('events');

const STATES = ['online', 'away', 'focus', 'in_call', 'watching', 'listening', 'on_the_way', 'offline'];

function clip(value, max) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function validState(state) {
  return STATES.includes(state) ? state : 'online';
}

function deriveState({ idleSeconds = 0, videoMode = '', musicPlaying = false, manualState = '', imminentEvent = null }) {
  if (manualState === 'focus') return { state: 'focus', reason: 'manual' };
  if (videoMode === 'watch') return { state: 'watching', reason: 'video' };
  if (videoMode === 'call') return { state: 'in_call', reason: 'video' };
  if (musicPlaying) return { state: 'listening', reason: 'music' };
  if (imminentEvent && imminentEvent.location) return { state: 'on_the_way', reason: 'calendar', place: imminentEvent.location };
  if (idleSeconds > 300) return { state: 'away', reason: 'idle' };
  return { state: 'online', reason: 'active' };
}

class Presence extends EventEmitter {
  constructor({ config, lang = 'zh', deviceName = '', platform = '' }) {
    super();
    this.config = config;
    this.lang = lang;
    this.deviceName = deviceName;
    this.platform = platform;
    this.bootAt = Date.now();
    this.me = {
      state: 'online',
      place: '',
      since: Date.now(),
      bootAt: this.bootAt,
      updatedAt: Date.now(),
      detail: '',
      deviceName,
      platform,
    };
    this.peer = null;
    this.peerLastSeenAt = 0;
    this.peerOnline = false;
  }

  setLang(lang) {
    this.lang = lang;
  }

  update(patch = {}) {
    const next = { ...this.me };
    if (patch.state) next.state = validState(patch.state);
    if (patch.place !== undefined) next.place = clip(patch.place, 80);
    if (patch.detail !== undefined) next.detail = clip(patch.detail, 80);
    if (next.state !== this.me.state || next.place !== this.me.place) next.since = Date.now();
    next.updatedAt = Date.now();
    const changed =
      next.state !== this.me.state ||
      next.place !== this.me.place ||
      next.detail !== this.me.detail;
    this.me = next;
    if (changed) this.emit('change', this.me);
    return changed;
  }

  /** Payload sent inside the encrypted 'status' envelope. */
  snapshotForSend() {
    const s = this.config.status || {};
    const payload = {
      v: 1,
      state: this.me.state,
      since: this.me.since,
      updatedAt: this.me.updatedAt,
      bootAt: s.shareBoot ? this.me.bootAt : 0,
      detail: this.me.detail,
      deviceName: this.deviceName,
      platform: this.platform,
    };
    payload.place = s.sharePlace ? this.me.place : '';
    return payload;
  }

  applyPeer(payload) {
    if (!payload || typeof payload !== 'object') return false;
    const at = Number(payload.updatedAt) || 0;
    if (at && this.peer && this.peer.updatedAt > at) return false; // ignore stale
    if (at > Date.now() + 300000) return false; // clock skew guard
    this.peer = {
      state: validState(payload.state),
      place: clip(payload.place, 80),
      since: Number(payload.since) || at,
      bootAt: Number(payload.bootAt) || 0,
      updatedAt: at,
      detail: clip(payload.detail, 80),
      deviceName: clip(payload.deviceName, 40),
      platform: clip(payload.platform, 20),
    };
    this.peerOnline = true;
    this.peerLastSeenAt = Date.now();
    this.emit('peer', this.peer);
    return true;
  }

  markPeerOffline() {
    if (!this.peerOnline) return;
    this.peerOnline = false;
    this.emit('peerOffline', { lastSeenAt: this.peerLastSeenAt });
  }

  markPeerOnline() {
    if (this.peerOnline) return;
    this.peerOnline = true;
    this.emit('peerOnline', {});
  }

  describe(state) {
    const zh = this.lang !== 'en';
    const table = {
      online: ['在线', 'Online'],
      away: ['离开', 'Away'],
      focus: ['勿扰', 'Focus'],
      in_call: ['正在视频', 'In a call'],
      watching: ['一起看电影', 'Watching together'],
      listening: ['一起听歌', 'Listening together'],
      on_the_way: ['在路上', 'On the way'],
      offline: ['离线', 'Offline'],
    };
    return table[state] ? table[state][zh ? 0 : 1] : state;
  }

  snapshot() {
    return {
      me: {
        ...this.me,
        label: this.describe(this.me.state),
        auto: deriveState({
          idleSeconds: 0,
          videoMode: '',
          musicPlaying: false,
          manualState: this.config.status.manualState || '',
        }).state,
      },
      peer: this.peer
        ? { ...this.peer, label: this.describe(this.peer.state), online: this.peerOnline }
        : null,
      peerOnline: this.peerOnline,
      peerLastSeenAt: this.peerLastSeenAt,
      bootAt: this.bootAt,
    };
  }
}

module.exports = { Presence, deriveState, validState, STATES, clip };
