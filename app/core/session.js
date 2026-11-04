'use strict';
/*
 * Session — the application brain, independent of Electron.
 *
 * Owns identity, encrypted link, chat log, presence, calendar, Connect
 * Intelligence, pairing and backups. The Electron main process only wires
 * windows/IPC/notifications to this object, which keeps the core testable.
 */

const { EventEmitter } = require('events');
const { JsonStore, JsonlLog, createPaths, appendLog } = require('./store');
const { createSecretStore } = require('./secrets');
const { Identity } = require('./identity');
const { Link } = require('./link');
const { ChatStore } = require('./chat');
const { Presence, deriveState } = require('./status');
const { CalendarService } = require('./calendar-service');
const { ConnectIntelligence } = require('./ci');
const { PairingSession } = require('./pairing');
const { BackupService } = require('./backup');
const { DEFAULT_CONFIG } = require('./defaults');
const { testConnection } = require('./llm');
const { request } = require('./http');
const ca = require('./crypto');
const ics = require('./ics');

const STATUS_TICK_MS = 20000;
const STATUS_HEARTBEAT_MS = 60000;
const CALENDAR_SHARE_MS = 6 * 3600000;

class Session extends EventEmitter {
  constructor({ userDataDir, deviceName, encryptor, platform, appVersion = '', getIdleSeconds, logger }) {
    super();
    this.paths = createPaths(userDataDir);
    this.appVersion = appVersion;
    this.platform = platform || '';
    this.logger =
      logger ||
      ((level, message, extra) => {
        appendLog(this.paths.log, level, message, extra);
        if (level === 'error' || level === 'warn') console.error('[ca]', level, message);
      });
    this.store = new JsonStore(this.paths.config, JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
    this._ensureLocale();
    this.stateStore = new JsonStore(this.paths.state, {
      lastReadAt: 0,
      relaySeq: 0,
      relayEpoch: '',
      widget: null,
      lastStatusAt: 0,
    });
    this.secrets = createSecretStore({ file: this.paths.secrets, encryptor, logger: this.logger });
    this.identity = new Identity({
      store: this.store,
      secrets: this.secrets,
      deviceName,
      logger: this.logger,
    });

    this.lang = this.store.get().lang || 'zh';
    this.chat = new ChatStore({
      log: new JsonlLog(this.paths.chat),
      state: this.stateStore,
    });
    this.presence = new Presence({
      config: this.store.get(),
      lang: this.lang,
      deviceName: this.identity.name,
      platform: this.identity.platform,
    });
    this.calendar = new CalendarService({
      store: this.store,
      paths: this.paths,
      logger: this.logger,
      identityName: this.identity.name,
      getPartnerName: () => (this.identity.peer ? this.identity.peer.name : 'Partner'),
    });
    this.ci = new ConnectIntelligence({
      store: this.store,
      secrets: this.secrets,
      paths: this.paths,
      logger: this.logger,
      lang: this.lang,
      getContext: (window) => this._ciContext(window),
    });
    this.pairing = new PairingSession({
      identity: this.identity,
      serverUrl: this.store.get().server.url || '',
      insecure: Boolean(this.store.get().server.insecure),
      logger: this.logger,
    });
    this.backup = new BackupService({
      identity: this.identity,
      store: this.store,
      paths: this.paths,
      logger: this.logger,
      chat: this.chat,
      ci: this.ci,
      calendar: this.calendar,
    });
    this.link = null;
    this.localRelay = null;
    this.activity = { idleSeconds: 0, videoMode: '', musicPlaying: false };
    this.getIdleSeconds = getIdleSeconds || (() => 0);
    this._timers = {};
    this._lastStatusSentAt = 0;
    this._lastTypingSentAt = 0;
    this._started = false;

    this._wireCore();
  }

  _ensureLocale() {
    if (this.store.get().firstRun) {
      // The product is bilingual; the owner is Chinese, so zh is the honest default.
      const forced = String(process.env.CA_LANG || '').toLowerCase();
      this.store.get().lang = forced === 'en' ? 'en' : 'zh';
      this.store.get().firstRun = false;
      this.store.saveSoon(0);
    }
  }

  /* ---------------- lifecycle ---------------- */

  init() {
    if (this._started) return this;
    this._started = true;
    this.chat.start();
    this.chat.prune(this.store.get().privacy.chatRetentionDays);
    this.calendar.setIdentityName(this.identity.name);
    this.calendar.start();
    this.ci.start();
    if (this.identity.isPaired) this._startLink();
    this._timers.statusTick = setInterval(() => this._statusTick(), STATUS_TICK_MS);
    this._timers.statusHeartbeat = setInterval(() => this._sendStatus(true), STATUS_HEARTBEAT_MS);
    this._timers.calendarShare = setInterval(() => this.shareCalendar('timer'), CALENDAR_SHARE_MS);
    this._timers.backup = setInterval(() => this._maybeBackup(), 60000);
    for (const t of Object.values(this._timers)) if (t.unref) t.unref();
    this.presence.update({ state: this._autoState().state });
    setTimeout(() => this._sendStatus(true), 2500);
    return this;
  }

  destroy() {
    for (const t of Object.values(this._timers)) if (t && t.unref) clearInterval(t);
    this._timers = {};
    if (this.link) this.link.stop();
    this.link = null;
    this.chat.stop();
    this.ci.stop();
    this.calendar.stop();
    if (this.localRelay) {
      try {
        this.localRelay.close();
      } catch (_) {}
      this.localRelay = null;
    }
    this.store.saveNow();
    this.stateStore.saveNow();
    this.identity.store.saveNow();
  }

  _wireCore() {
    this.chat.on('message', (message) => {
      this._emit('chat-message', { message, unread: this.chat.unreadCount() });
    });
    this.chat.on('update', (u) => {
      if (u.type === 'state') {
        this._emit('chat-update', { id: u.message.id, state: u.message.state, unread: this.chat.unreadCount() });
      } else if (u.type === 'read') {
        this._emit('chat-read', { unread: this.chat.unreadCount() });
      } else if (u.type === 'clear' || u.type === 'import' || u.type === 'prune') {
        this._emit('chat-reload', { stats: this.chat.stats() });
      }
    });
    this.presence.on('change', () => {
      this._emit('presence', this.presence.snapshot());
      this._sendStatus(false);
    });
    this.presence.on('peer', () => this._emit('presence', this.presence.snapshot()));
    this.presence.on('peerOffline', () => this._emit('presence', this.presence.snapshot()));
    this.presence.on('peerOnline', () => this._emit('presence', this.presence.snapshot()));

    this.ci.on('status', () => this._emit('ci-status', this.ci.status()));
    this.ci.on('summary', (record) => {
      this._emit('ci-summary', record);
      if (this.store.get().ci.notify !== false) {
        this._notify('ci', { headline: record.summary.headline, id: record.id, count: this.ci.summaries.length });
      }
    });
    this.ci.on('error', (err) => this._emit('ci-error', err));
    this.ci.on('skipped', (info) => this._emit('ci-skipped', info));

    this.pairing.on('state', (s) => this._emit('pairing', s));
    this.pairing.on('peer', (s) => this._emit('pairing', s));
    this.pairing.on('error', (e) => this._emit('pairing-error', e));
    this.pairing.on('paired', (info) => this._afterPair(info));

    this.calendar.on('change', () => this._emitCalendar());
    this.calendar.on('sources', (sources) => this._emit('calendar-sources', { sources, share: this.calendar.shareConfig() }));

    this.backup.on('backup', (info) => {
      this._emit('backup', this.backup.status());
      this._emit('backup-done', info);
    });
    this.backup.on('backup-error', (err) => this._emit('backup-error', err));
    this.backup.on('restore', (info) => this._emit('backup-restore', info));
  }

  _startLink() {
    if (this.link) this.link.stop();
    this.link = new Link({
      identity: this.identity,
      config: this.store,
      state: this.stateStore,
      logger: this.logger,
    });
    const link = this.link;
    link.on('state', (state) => this._emit('link', state));
    link.on('online', (info) => {
      this.chat.markPendingSent();
      this._emit('link', link.state());
      this._sendStatus(true);
      setTimeout(() => this.shareCalendar('online'), 1500);
      this._emit('link-online', info);
    });
    link.on('chat', (payload, meta) => this._onChat(payload, meta));
    link.on('ack', (payload) => {
      if (payload && payload.id) {
        this.chat.markDelivered(payload.id);
        this._emit('chat-update', { id: payload.id, state: 'delivered', unread: this.chat.unreadCount() });
      }
    });
    link.on('status', (payload) => this._onPeerStatus(payload));
    link.on('calendar', (payload) => {
      if (payload && payload.request) {
        this.shareCalendar('request');
        return;
      }
      const count = this.calendar.applyPartnerSnapshot(payload);
      if (count >= 0) this._emitCalendar();
    });
    link.on('signal', (payload) => this._emit('signal', payload));
    link.on('media', (payload) => this._emit('media-sync', payload));
    link.on('typing', (payload) => this._emit('peer-typing', { ...payload, at: Date.now() }));
    link.on('peer-presence', (info) => {
      if (!info || info.deviceId === this.identity.id) return;
      if (info.online) {
        this.presence.markPeerOnline();
        this._emit('presence', this.presence.snapshot());
      } else {
        this.presence.markPeerOffline();
        this._emit('presence', this.presence.snapshot());
      }
    });
    link.on('undecryptable', (info) => {
      this.logger('warn', 'undecryptable message ' + info.id + ' kind=' + info.kind);
      this._emit('link-warning', { code: 'undecryptable', ...info });
    });
    link.on('flushed', () => this.chat.markPendingSent());
    link.start();
    this._emit('link', link.state());
  }

  _afterPair(info) {
    this.logger('info', 'paired with ' + (info.peer && info.peer.name));
    this._startLink();
    this._sendStatus(true);
    this.shareCalendar('pair');
    this._emit('paired', {
      peer: info.peer ? { id: info.peer.id, name: info.peer.name, platform: info.peer.platform } : null,
      sas: info.sas,
    });
    this._emit('snapshot-changed', {});
    this._notify('paired', { name: info.peer ? info.peer.name : '' });
    this.initTimersAfterPair();
  }

  initTimersAfterPair() {
    // pairing starts the backup cadence too
    this._maybeBackup();
  }

  /* ---------------- helpers ---------------- */

  _emit(type, payload) {
    try {
      this.emit('event', { type, payload });
    } catch (err) {
      this.logger('error', 'event handler failed: ' + err.message);
    }
  }

  _notify(kind, payload) {
    this._emit('notify', { kind, ...payload });
  }

  _now() {
    return Date.now();
  }

  _autoState() {
    const now = this._now();
    const upcoming = this.calendar.merged(now - 3600000, now + 2 * 3600000).all;
    let imminent = null;
    for (const ev of upcoming) {
      if (ev.end < now) continue;
      if (ev.allDay) continue; // an all-day event is not a reason to say "on the way"
      if (ev.start <= now + 30 * 60000) {
        imminent = ev;
        break;
      }
    }
    const manual = this.store.get().status.manualState || '';
    const derived = deriveState({
      idleSeconds: this.activity.idleSeconds,
      videoMode: this.activity.videoMode,
      musicPlaying: this.activity.musicPlaying,
      manualState: manual,
      imminentEvent: imminent,
    });
    let place = '';
    if (this.store.get().status.manualPlace) place = this.store.get().status.manualPlace;
    else if (imminent && imminent.location) place = imminent.location;
    else if (derived.place) place = derived.place;
    return { state: derived.state, place, reason: derived.reason, event: imminent };
  }

  _statusTick() {
    const auto = this._autoState();
    const changed = this.presence.update({ state: auto.state, place: auto.place });
    if (changed) this._emit('presence', this.presence.snapshot());
    if (changed || this._now() - this._lastStatusSentAt > STATUS_HEARTBEAT_MS) this._sendStatus(true);
  }

  _sendStatus(force) {
    if (!this.link || !this.identity.isPaired || !this.link.online()) return false;
    if (!force && this._now() - this._lastStatusSentAt < 5000) return false;
    const payload = this.presence.snapshotForSend();
    payload.ciEnabled = Boolean(this.store.get().ci.enabled);
    payload.ciNextRunAt = this.ci.status().nextRunAt;
    this.link.send('status', payload);
    this._lastStatusSentAt = this._now();
    this._emit('presence', this.presence.snapshot());
    return true;
  }

  _onPeerStatus(payload) {
    if (!payload || typeof payload !== 'object') return;
    const before = this.presence.peerOnline;
    const applied = this.presence.applyPeer(payload);
    if (!applied) return;
    const peer = this.identity.peer;
    if (peer) {
      const patch = { lastSeenAt: Date.now() };
      let nameChanged = false;
      if (payload.deviceName && String(payload.deviceName).slice(0, 40) !== peer.name) {
        patch.name = String(payload.deviceName).slice(0, 40);
        nameChanged = true;
      }
      this.identity.updatePeer(patch);
      if (nameChanged) this._emit('snapshot-changed', { reason: 'peer-name' });
    }
    if (!before) {
      this._notify('presence', {
        state: payload.state,
        name: peer ? peer.name : '',
        bootAt: Number(payload.bootAt) || 0,
        place: payload.place || '',
      });
    }
    this._emit('presence', this.presence.snapshot());
    this._emit('peer-status', payload);
  }

  _onChat(payload, meta) {
    if (!payload || typeof payload.text !== 'string') return;
    const message = this.chat.addIncoming({
      id: meta.id,
      at: Number(payload.at) || Date.now(),
      text: payload.text,
    });
    if (!message) return;
    this._emit('chat-message', { message, unread: this.chat.unreadCount() });
    this._notify('chat', {
      id: message.id,
      text: message.text.slice(0, 140),
      name: this.identity.peer ? this.identity.peer.name : '',
    });
  }

  _ciContext(window) {
    const messages = this.chat
      .between(window.from, window.to)
      .map((m) => ({ from: m.from, text: m.text, at: m.at }));
    const now = Date.now();
    const all = this.calendar.merged(now - 3600000, now + 2 * 86400000).all;
    const events = all.map((e) => ({
      start: e.start,
      end: e.end,
      summary: e.summary,
      location: e.location,
      owner: e.owner,
      allDay: e.allDay,
    }));
    return {
      messages,
      events,
      partnerOnline: Boolean(this.link && this.link.online()),
      lang: this.lang,
    };
  }

  _emitCalendar() {
    const now = Date.now();
    this._emit('calendar', {
      upcoming: this.calendar.upcoming(14),
      sources: this.calendar.sources(),
      partner: this.calendar.partnerSummary(),
      share: this.calendar.shareConfig(),
    });
  }

  /* ---------------- public: snapshot ---------------- */

  snapshot() {
    const cfg = this.store.get();
    return {
      app: {
        name: 'Connect All',
        version: this.appVersion,
        platform: this.platform,
        lang: this.lang,
        device: {
          id: this.identity.id,
          name: this.identity.name,
          platform: this.identity.platform,
          publicKey: this.identity.publicKey,
        },
        paths: {
          data: this.paths.base,
          ci: this.paths.ci,
          chat: this.paths.chat,
          calendar: this.paths.calendarDir,
        },
        pairing: {
          paired: this.identity.isPaired,
          peer: this.identity.peer
            ? {
                id: this.identity.peer.id,
                name: this.identity.peer.name,
                platform: this.identity.peer.platform,
                sas: this.identity.sas(),
                shortId: this.identity.shortId(),
                pairedAt: this.identity.peer.pairedAt,
                lastSeenAt: this.identity.peer.lastSeenAt || 0,
              }
            : null,
          sas: this.identity.sas(),
          shortId: this.identity.shortId(),
        },
      },
      lang: this.lang,
      link: this.link ? this.link.state() : { paired: this.identity.isPaired, online: false, via: '', relay: 'off', lan: 'off', queue: 0 },
      presence: this.presence.snapshot(),
      chat: {
        messages: this.chat.list({ limit: 300 }),
        unread: this.chat.unreadCount(),
        stats: this.chat.stats(),
        typingUntil: 0,
      },
      calendar: {
        upcoming: this.calendar.upcoming(14),
        sources: this.calendar.sources(),
        partner: this.calendar.partnerSummary(),
        share: this.calendar.shareConfig(),
        widget: { ...cfg.calendar.widget },
      },
      ci: { config: this.ci.publicConfig(), status: this.ci.status(), summaries: this.ci.list({ limit: 30 }) },
      server: {
        url: cfg.server.url,
        insecure: Boolean(cfg.server.insecure),
        mode: cfg.transport.mode,
        autoBackup: cfg.server.autoBackup !== false,
        backupIntervalMin: cfg.server.backupIntervalMin || 60,
        localRelay: { running: Boolean(this.localRelay), port: this.localRelay ? this._localRelayPort : cfg.server.localRelay.port || 8787 },
        backup: this.backup.status(),
        roomShort: this.identity.relayCredentials() ? this.identity.relayCredentials().room.slice(0, 8) : '',
        backupRoomShort: this.identity.backupCredentials() ? this.identity.backupCredentials().room.slice(0, 8) : '',
      },
      settings: {
        video: { ...cfg.video },
        status: { ...cfg.status },
        notify: { ...cfg.notify },
        privacy: { ...cfg.privacy },
        transport: { ...cfg.transport },
      },
    };
  }

  /* ---------------- language ---------------- */

  setDeviceName(name) {
    const clean = String(name || '').trim().slice(0, 40);
    if (!clean) throw new Error('empty device name');
    this.identity.device.name = clean;
    this.store.get().device.name = clean;
    this.store.saveNow();
    this.presence.deviceName = clean;
    this.calendar.setIdentityName(clean);
    this._emit('device', { name: clean });
    this._emit('snapshot-changed', {});
    this._sendStatus(true);
    return { name: clean };
  }

  setLang(lang) {
    if (!['zh', 'en'].includes(lang)) return this.lang;
    this.lang = lang;
    this.store.set('lang', lang);
    this.presence.setLang(lang);
    this.ci.setLang(lang);
    this._emit('lang', { lang });
    return lang;
  }

  setActivity({ idleSeconds, videoMode, musicPlaying } = {}) {
    if (typeof idleSeconds === 'number' && idleSeconds >= 0) this.activity.idleSeconds = idleSeconds;
    if (typeof videoMode === 'string') this.activity.videoMode = videoMode;
    if (typeof musicPlaying === 'boolean') this.activity.musicPlaying = musicPlaying;
    const auto = this._autoState();
    const changed = this.presence.update({ state: auto.state, place: auto.place });
    if (changed) {
      this._emit('presence', this.presence.snapshot());
      this._sendStatus(true);
    }
    return this.presence.snapshot();
  }

  tickIdle() {
    try {
      const idle = Number(this.getIdleSeconds()) || 0;
      return this.setActivity({ idleSeconds: idle });
    } catch (_) {
      return this.presence.snapshot();
    }
  }

  /* ---------------- chat ---------------- */

  listChat({ limit = 200, before = 0 } = {}) {
    return { messages: this.chat.list({ limit, before }), unread: this.chat.unreadCount() };
  }

  sendChat(text) {
    if (!this.identity.isPaired) throw new Error('还没有牵手 / Not paired yet');
    const clean = String(text || '').trim();
    if (!clean) return null;
    if (!this.link) this._startLink();
    const res = this.link ? this.link.send('chat', { text: clean, at: Date.now() }, { ack: true }) : { id: '', queued: true };
    const message = this.chat.addOutgoing(clean, { clientId: res.id || undefined });
    if (!message) return null;
    this.chat.setState(message.id, res.queued ? 'queued' : 'sent');
    this._emit('chat-message', { message, unread: this.chat.unreadCount() });
    return message;
  }

  markRead() {
    const unread = this.chat.markRead(Date.now());
    return { unread, at: this.chat.lastReadAt() };
  }

  searchChat(query) {
    return this.chat.search(query);
  }

  clearChat() {
    this.chat.clear();
    return { ok: true };
  }

  setTyping(typing) {
    if (!this.link || !this.link.online()) return;
    const now = Date.now();
    if (typing && now - this._lastTypingSentAt < 2500) return;
    this._lastTypingSentAt = now;
    this.link.send('typing', { typing: Boolean(typing), at: now });
  }

  /* ---------------- presence ---------------- */

  setPresence(patch = {}) {
    const cfg = this.store.get().status;
    if (patch.manualState !== undefined) {
      cfg.manualState = ['', 'focus', 'away'].includes(patch.manualState) ? patch.manualState : '';
    }
    if (patch.manualPlace !== undefined) cfg.manualPlace = String(patch.manualPlace).slice(0, 80);
    if (patch.sharePlace !== undefined) cfg.sharePlace = Boolean(patch.sharePlace);
    if (patch.shareBoot !== undefined) cfg.shareBoot = Boolean(patch.shareBoot);
    this.store.saveSoon(0);
    const auto = this._autoState();
    this.presence.update({ state: auto.state, place: auto.place });
    this._sendStatus(true);
    return this.presence.snapshot();
  }

  /* ---------------- media / rtc signalling ---------------- */

  sendSignal(payload) {
    if (!payload || typeof payload !== 'object') return false;
    if (!this.link) return false;
    const res = this.link.send('signal', {
      callId: String(payload.callId || '').slice(0, 40),
      type: String(payload.type || '').slice(0, 20),
      data: payload.data,
      at: Date.now(),
    });
    return !res.queued;
  }

  sendMediaSync(payload) {
    if (!payload || typeof payload !== 'object') return false;
    if (!this.link) return false;
    const res = this.link.send('media', {
      type: String(payload.type || '').slice(0, 30),
      data: payload.data,
      at: Date.now(),
    });
    return !res.queued;
  }

  linkState() {
    return this.link ? this.link.state() : { paired: this.identity.isPaired, online: false };
  }

  reconnectLink() {
    if (!this.identity.isPaired) return this.linkState();
    this._startLink();
    return this.linkState();
  }

  /* ---------------- pairing ---------------- */

  pairingStatus() {
    if (this.identity.isPaired) {
      return {
        state: 'paired',
        peer: this.identity.peer
          ? { id: this.identity.peer.id, name: this.identity.peer.name, platform: this.identity.peer.platform }
          : null,
        sas: this.identity.sas(),
      };
    }
    return this.pairing.status();
  }

  async pairingStartServer(code) {
    const status = await this.pairing.startServer(code);
    this._emit('pairing', status);
    return status;
  }

  async pairingJoinServer(code) {
    return this.pairingStartServer(code);
  }

  pairingCreateInvite() {
    const res = this.pairing.createInvite();
    this._emit('pairing', this.pairing.status());
    return res;
  }

  pairingAcceptInvite(text) {
    const status = this.pairing.acceptInvite(text);
    this._emit('pairing', status);
    return status;
  }

  pairingAcceptReply(text) {
    const status = this.pairing.acceptReply(text);
    this._emit('pairing', status);
    return status;
  }

  pairingConfirm() {
    const status = this.pairing.confirm();
    return { status, snapshot: this.snapshot() };
  }

  pairingCancel() {
    this.pairing.cancel();
    this._emit('pairing', this.pairing.status());
    return this.pairing.status();
  }

  unpair() {
    if (this.link) this.link.stop();
    this.link = null;
    this.identity.unpair();
    this.presence.peer = null;
    this.presence.peerOnline = false;
    this.store.saveNow();
    this._emit('unpaired', {});
    this._emit('snapshot-changed', {});
    return { ok: true };
  }

  /* ---------------- server ---------------- */

  setServer({ url, insecure, mode, autoBackup, backupIntervalMin } = {}) {
    const cfg = this.store.get();
    if (url !== undefined) {
      const clean = String(url || '').trim().replace(/\/+$/, '');
      if (clean && !/^(https?|wss?):\/\//i.test(clean)) {
        throw new Error('服务器地址需以 http:// 或 https:// 开头');
      }
      cfg.server.url = clean;
    }
    if (insecure !== undefined) cfg.server.insecure = Boolean(insecure);
    if (mode !== undefined) {
      if (!['auto', 'relay', 'lan', 'offline'].includes(mode)) throw new Error('invalid transport mode');
      cfg.transport.mode = mode;
    }
    if (autoBackup !== undefined) cfg.server.autoBackup = Boolean(autoBackup);
    if (backupIntervalMin !== undefined) {
      cfg.server.backupIntervalMin = Math.max(15, Math.min(1440, Number(backupIntervalMin) || 60));
    }
    this.pairing.serverUrl = cfg.server.url;
    this.pairing.insecure = cfg.server.insecure;
    this.store.saveNow();
    if (this.identity.isPaired) this._startLink();
    this._emit('server', this.serverInfo());
    return this.serverInfo();
  }

  async testServer(url, insecure) {
    const base = String(url || '').trim().replace(/\/+$/, '');
    if (!base) return { ok: false, error: 'empty url' };
    const started = Date.now();
    try {
      const res = await request(base + '/api/health', { insecure: Boolean(insecure), timeout: 10000 });
      if (res.status !== 200 || !res.body || !res.body.ok) {
        return { ok: false, error: 'HTTP ' + res.status, latencyMs: Date.now() - started };
      }
      return {
        ok: true,
        latencyMs: Date.now() - started,
        version: res.body.version,
        epoch: res.body.epoch,
        rooms: res.body.rooms,
        quotaMB: res.body.quotaMB,
        historyLimit: res.body.historyLimit,
      };
    } catch (err) {
      return { ok: false, error: err.message, latencyMs: Date.now() - started };
    }
  }

  serverInfo() {
    const cfg = this.store.get();
    return {
      url: cfg.server.url,
      insecure: Boolean(cfg.server.insecure),
      mode: cfg.transport.mode,
      autoBackup: cfg.server.autoBackup !== false,
      backupIntervalMin: cfg.server.backupIntervalMin || 60,
      iceServers: cfg.transport.iceServers || [],
      turn: cfg.transport.turn,
      localRelay: {
        running: Boolean(this.localRelay),
        port: this.localRelay ? this._localRelayPort : cfg.server.localRelay.port || 0,
      },
      backup: this.backup.status(),
      relayRoom: this.identity.relayCredentials() ? this.identity.relayCredentials().room : '',
      backupRoom: this.identity.backupCredentials() ? this.identity.backupCredentials().room : '',
    };
  }

  async startLocalRelay({ port = 8787, host = '0.0.0.0' } = {}) {
    if (this.localRelay) {
      return { running: true, port: this._localRelayPort, url: `http://127.0.0.1:${this._localRelayPort}` };
    }
    const { createRelay } = require('../../server/ca-server');
    let chosen = Number(port) || 8787;
    let relay = null;
    let lastErr = null;
    for (let i = 0; i < 12; i++) {
      const candidate = createRelay({
        port: chosen + i,
        host,
        dataDir: this.paths.base + '/local-relay',
        quiet: true,
      });
      try {
        await candidate.listen();
        relay = candidate;
        chosen = chosen + i;
        break;
      } catch (err) {
        lastErr = err;
        candidate.close().catch(() => {});
        if (err.code !== 'EADDRINUSE') break;
      }
    }
    if (!relay) throw new Error('无法启动本机中继 / Cannot start local relay: ' + (lastErr ? lastErr.message : 'unknown'));
    this.localRelay = relay;
    this._localRelayPort = chosen;
    const cfg = this.store.get();
    cfg.server.localRelay = { enabled: true, port: chosen, running: true };
    this.store.saveNow();
    this.logger('info', 'local relay started on port ' + chosen);
    this._emit('server', this.serverInfo());
    return { running: true, port: chosen, url: `http://127.0.0.1:${chosen}` };
  }

  async stopLocalRelay() {
    if (this.localRelay) {
      await this.localRelay.close();
      this.localRelay = null;
      this._localRelayPort = 0;
      const cfg = this.store.get();
      cfg.server.localRelay.running = false;
      this.store.saveNow();
      this._emit('server', this.serverInfo());
    }
    return { running: false };
  }

  /* ---------------- calendar ---------------- */

  calendarImportFile(filePath, name) {
    const source = this.calendar.importFile(filePath, { name });
    this._emitCalendar();
    this.shareCalendar('import');
    return source;
  }

  async calendarImportUrl(url, name) {
    const source = await this.calendar.importUrl(url, { name, insecure: Boolean(this.store.get().server.insecure) });
    this._emitCalendar();
    this.shareCalendar('import');
    return source;
  }

  calendarImportText(text, name) {
    const source = this.calendar.importText(text, { name });
    this._emitCalendar();
    this.shareCalendar('import');
    return source;
  }

  calendarRemove(id) {
    const ok = this.calendar.removeSource(id);
    if (ok) this._emitCalendar();
    return { ok };
  }

  calendarToggle(id, enabled) {
    const ok = this.calendar.setEnabled(id, enabled);
    if (ok) this._emitCalendar();
    return { ok };
  }

  async calendarRefresh(id) {
    const res = await this.calendar.refreshSource(id, { insecure: Boolean(this.store.get().server.insecure) });
    this._emitCalendar();
    return res;
  }

  calendarEvents(from, to) {
    return this.calendar.merged(Number(from) || Date.now(), Number(to) || Date.now() + 7 * 86400000);
  }

  calendarShare(enabled) {
    const res = this.calendar.setShare(enabled);
    if (enabled) this.shareCalendar('manual');
    this._emitCalendar();
    return res;
  }

  calendarSetHidePrivate(hide) {
    const res = this.calendar.setHidePrivate(hide);
    this.shareCalendar('privacy');
    this._emitCalendar();
    return res;
  }

  shareCalendar(reason = 'manual') {
    if (!this.link || !this.identity.isPaired || !this.link.online()) return { ok: false, error: 'offline' };
    if (this.calendar.config.share === false) return { ok: false, error: 'sharing disabled' };
    try {
      const payload = this.calendar.buildShareSnapshot({ days: 30 });
      payload.source = this.identity.name;
      this.link.send('calendar', payload);
      return { ok: true, count: payload.events.length, reason };
    } catch (err) {
      this.logger('warn', 'calendar share failed: ' + err.message);
      return { ok: false, error: err.message };
    }
  }

  requestCalendarShare() {
    if (!this.link) return false;
    return !this.link.send('calendar', { request: true, at: Date.now() }).queued;
  }

  setWidgetConfig(patch = {}) {
    const w = this.store.get().calendar.widget;
    for (const key of ['visible', 'pinned', 'x', 'y', 'width', 'height', 'opacity', 'showPartner']) {
      if (patch[key] !== undefined) w[key] = patch[key];
    }
    this.store.saveSoon(0);
    return { ...w };
  }

  /* ---------------- CI ---------------- */

  ciConfig() {
    return this.ci.publicConfig();
  }

  ciConfigure(patch) {
    const res = this.ci.configure(patch || {});
    this._emit('ci-config', res);
    this._emit('ci-status', this.ci.status());
    return res;
  }

  ciStatus() {
    return this.ci.status();
  }

  async ciRun() {
    return this.ci.runNow({ manual: true });
  }

  ciList(opts) {
    return this.ci.list(opts || {});
  }

  ciDelete(id) {
    return { ok: this.ci.delete(id) };
  }

  ciClear() {
    this.ci.clear();
    return { ok: true };
  }

  ciExport() {
    return this.ci.exportAll();
  }

  ciStats() {
    return { ...this.ci.stats(), status: this.ci.status() };
  }

  async ciTest(patch) {
    return this.ci.testCredentials(patch || {});
  }

  /* ---------------- backup ---------------- */

  backupNow() {
    return this.backup.backupNow({ reason: 'manual' });
  }

  backupStatus() {
    return this.backup.status();
  }

  async backupList() {
    return this.backup.listRemote();
  }

  backupRestore() {
    return this.backup.restoreLatest();
  }

  _maybeBackup() {
    const cfg = this.store.get().server;
    if (cfg.autoBackup === false) return;
    if (!this.identity.isPaired) return;
    if (!cfg.url) return; // local-only backups on quit, not on a timer
    const interval = Math.max(15, Number(cfg.backupIntervalMin) || 60) * 60000;
    if (Date.now() - (cfg.lastBackupAt || 0) < interval) return;
    if (this.backup.busy) return;
    this.backup.backupNow({ reason: 'auto' }).catch(() => {});
  }

  /* ---------------- misc ---------------- */

  setVideoConfig(patch = {}) {
    const v = this.store.get().video;
    for (const key of ['quality', 'splitRatio', 'stripSide', 'cameraId', 'micId', 'mirrorSelf', 'startAudioOnly']) {
      if (patch[key] !== undefined) v[key] = patch[key];
    }
    this.store.saveSoon(0);
    return { ...v };
  }

  setNotifyConfig(patch = {}) {
    const n = this.store.get().notify;
    for (const key of ['messages', 'presence', 'ci']) if (patch[key] !== undefined) n[key] = Boolean(patch[key]);
    if (patch.quietHours) Object.assign(n.quietHours, patch.quietHours);
    this.store.saveSoon(0);
    return { ...n };
  }

  setPrivacyConfig(patch = {}) {
    const p = this.store.get().privacy;
    if (patch.chatRetentionDays !== undefined) {
      p.chatRetentionDays = Math.max(0, Number(patch.chatRetentionDays) || 0);
      const removed = this.chat.prune(p.chatRetentionDays);
      if (removed) this._emit('chat-reload', { reason: 'retention', removed });
    }
    this.store.saveSoon(0);
    return { ...p };
  }

  setTransportConfig(patch = {}) {
    const t = this.store.get().transport;
    if (patch.mode) {
      if (!['auto', 'relay', 'lan', 'offline'].includes(patch.mode)) throw new Error('invalid mode');
      t.mode = patch.mode;
    }
    if (Array.isArray(patch.iceServers)) {
      t.iceServers = patch.iceServers
        .filter((s) => s && typeof s.urls === 'string' && s.urls.length < 300)
        .slice(0, 6)
        .map((s) => ({ urls: s.urls }));
    }
    if (patch.turn) {
      t.turn = {
        url: String(patch.turn.url || '').slice(0, 300),
        username: String(patch.turn.username || '').slice(0, 100),
        password: String(patch.turn.password || '').slice(0, 100),
      };
    }
    this.store.saveSoon(0);
    if (this.identity.isPaired) this._startLink();
    return { ...t };
  }

  dataStats() {
    return {
      chat: this.chat.stats(),
      ci: this.ci.stats(),
      calendar: { sources: this.calendar.sources().length, partner: this.calendar.partnerSummary() },
      backup: this.backup.status(),
      paths: this.paths,
    };
  }

  exportChat() {
    return this.chat.exportJson();
  }
}

module.exports = { Session };
