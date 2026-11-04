'use strict';
/*
 * Calendar service. Reads local ICS files / URLs, expands recurrences, and
 * shares a privacy-trimmed snapshot with the partner over the encrypted link.
 * The desktop widget is just another view on this data.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const ics = require('./ics');
const { request } = require('./http');
const { ensureDir, readJsonSafe, writeJsonAtomic } = require('./store');
const ca = require('./crypto');

const MAX_ICS_BYTES = 8 * 1024 * 1024;

function clip(value, max) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function sanitizeSource(source) {
  return {
    id: source.id,
    name: clip(source.name, 60),
    kind: source.kind,
    path: source.path || '',
    url: source.url || '',
    enabled: source.enabled !== false,
    lastSyncAt: source.lastSyncAt || 0,
    lastError: clip(source.lastError, 200),
    eventCount: source.eventCount || 0,
    meta: { name: clip(source.meta && source.meta.name, 60), timezone: source.meta && source.meta.timezone },
  };
}

function sanitizeSharedEvent(ev, owner) {
  return {
    id: String(ev.id || ev.uid || ''),
    uid: String(ev.uid || ''),
    summary: clip(ev.summary, 120),
    start: Number(ev.start) || 0,
    end: Number(ev.end) || 0,
    allDay: Boolean(ev.allDay),
    location: clip(ev.location, 80),
    recurring: Boolean(ev.recurring),
    class: ev.class === 'PRIVATE' ? 'PRIVATE' : 'PUBLIC',
    owner,
  };
}

class CalendarService extends EventEmitter {
  constructor({ store, paths, logger = () => {}, getPartnerName = () => 'Partner', identityName = '' }) {
    super();
    this.store = store;
    this.paths = paths;
    this.logger = logger;
    this.getPartnerName = getPartnerName;
    this.identityName = identityName;
    this.partnerFile = path.join(paths.calendarDir, 'partner.json');
    this.partner = readJsonSafe(this.partnerFile, null);
    this._cache = new Map();
    this._refreshTimer = null;
    ensureDir(paths.calendarDir);
  }

  setIdentityName(name) {
    this.identityName = name || '';
  }

  start() {
    this._refreshTimer = setInterval(() => this.refreshAll().catch(() => {}), 6 * 3600000);
    if (this._refreshTimer.unref) this._refreshTimer.unref();
    this.refreshAll().catch(() => {});
  }

  stop() {
    if (this._refreshTimer) clearInterval(this._refreshTimer);
    this._refreshTimer = null;
  }

  get config() {
    return this.store.get().calendar;
  }

  sources() {
    return (this.config.sources || []).map(sanitizeSource);
  }

  _rawPath(id) {
    return path.join(this.paths.calendarDir, id + '.ics');
  }

  _sourceById(id) {
    return (this.config.sources || []).find((s) => s.id === id) || null;
  }

  _parseSource(source) {
    const file = this._rawPath(source.id);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (_) {
      return { events: [], meta: { name: source.name } };
    }
    const cached = this._cache.get(source.id);
    if (cached && cached.mtime === stat.mtimeMs) return cached;
    const text = fs.readFileSync(file, 'utf8');
    const parsed = ics.parseCalendar(text, { id: source.id, name: source.name });
    const entry = {
      mtime: stat.mtimeMs,
      events: parsed.events,
      meta: parsed.meta,
      count: parsed.events.length,
    };
    this._cache.set(source.id, entry);
    return entry;
  }

  /** All local occurrences in [from, to). */
  ownEvents(from, to, { hidePrivate = true } = {}) {
    const out = [];
    for (const source of this.config.sources || []) {
      if (source.enabled === false) continue;
      try {
        const parsed = this._parseSource(source);
        const events = ics.expandCalendar(parsed.events, from, to, { hidePrivate });
        for (const ev of events) {
          out.push({
            ...ev,
            owner: 'me',
            sourceName: source.name,
            calendarId: source.id,
          });
        }
      } catch (err) {
        this.logger('warn', 'calendar parse failed for ' + source.id + ': ' + err.message);
      }
    }
    out.sort((a, b) => a.start - b.start);
    return out;
  }

  partnerEvents(from, to) {
    if (!this.partner || !Array.isArray(this.partner.events)) return [];
    const out = [];
    for (const ev of this.partner.events) {
      if (!ev || !ev.start || ev.end <= from || ev.start >= to) continue;
      if (ev.class === 'PRIVATE' && this.config.hidePrivate !== false) continue;
      out.push({ ...sanitizeSharedEvent(ev, 'peer'), sourceName: this.partner.source || 'Partner' });
    }
    out.sort((a, b) => a.start - b.start);
    return out;
  }

  merged(from, to) {
    const mine = this.ownEvents(from, to, { hidePrivate: this.config.hidePrivate !== false });
    const partner = this.partnerEvents(from, to);
    return {
      mine,
      partner,
      all: [...mine, ...partner].sort((a, b) => a.start - b.start),
      partnerSnapshotAt: this.partner ? this.partner.receivedAt : 0,
    };
  }

  upcoming(days = 7) {
    const now = Date.now();
    return this.merged(now, now + days * 86400000);
  }

  /* ---------------- importing ---------------- */

  importText(text, { name, kind = 'ics-paste', filePath = '', url = '' } = {}) {
    if (!text || typeof text !== 'string') throw new Error('empty calendar');
    if (Buffer.byteLength(text, 'utf8') > MAX_ICS_BYTES) throw new Error('calendar too large');
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('不是有效的 ICS 文件 / Not a valid ICS file');
    const id = ca.randomId(6);
    ensureDir(this.paths.calendarDir);
    fs.writeFileSync(this._rawPath(id), text, 'utf8');
    const parsed = ics.parseCalendar(text, { id, name: name || `Calendar ${id.slice(0, 4)}` });
    const source = {
      id,
      name: clip(name || parsed.meta.name || 'Calendar', 60),
      kind,
      path: filePath,
      url,
      enabled: true,
      lastSyncAt: Date.now(),
      lastError: '',
      eventCount: parsed.events.length,
      meta: parsed.meta,
    };
    this.config.sources.push(source);
    this.store.saveSoon(0);
    this.emit('sources', this.sources());
    this.emit('change', { reason: 'import', source: sanitizeSource(source) });
    return sanitizeSource(source);
  }

  importFile(filePath, { name } = {}) {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_ICS_BYTES) throw new Error('file too large');
    const text = fs.readFileSync(filePath, 'utf8');
    return this.importText(text, {
      name: name || path.basename(filePath, path.extname(filePath)),
      kind: 'ics-file',
      filePath,
    });
  }

  async fetchUrl(url, { insecure = false } = {}) {
    let target = String(url || '').trim();
    if (!target) throw new Error('empty url');
    if (/^webcal:/i.test(target)) target = 'https://' + target.slice(7);
    let redirects = 0;
    while (true) {
      const res = await request(target, { timeout: 20000, insecure, raw: true, maxBytes: MAX_ICS_BYTES });
      if (res.status >= 300 && res.status < 400 && res.headers.location && redirects < 4) {
        target = new URL(res.headers.location, target).toString();
        redirects++;
        continue;
      }
      if (res.status !== 200) throw new Error('HTTP ' + res.status);
      return { text: res.body.toString('utf8'), finalUrl: target };
    }
  }

  async importUrl(url, { name, insecure = false } = {}) {
    const { text, finalUrl } = await this.fetchUrl(url, { insecure });
    return this.importText(text, {
      name: name || finalUrl.replace(/^https?:\/\//, '').slice(0, 40),
      kind: 'ics-url',
      url: finalUrl,
    });
  }

  removeSource(id) {
    const sources = this.config.sources || [];
    const idx = sources.findIndex((s) => s.id === id);
    if (idx < 0) return false;
    sources.splice(idx, 1);
    this._cache.delete(id);
    try {
      fs.unlinkSync(this._rawPath(id));
    } catch (_) {}
    this.store.saveSoon(0);
    this.emit('sources', this.sources());
    this.emit('change', { reason: 'remove', id });
    return true;
  }

  setEnabled(id, enabled) {
    const src = this._sourceById(id);
    if (!src) return false;
    src.enabled = Boolean(enabled);
    this.store.saveSoon(0);
    this.emit('sources', this.sources());
    this.emit('change', { reason: 'toggle', id, enabled: src.enabled });
    return true;
  }

  async refreshSource(id, { insecure = false } = {}) {
    const src = this._sourceById(id);
    if (!src) return { ok: false, error: 'not found' };
    try {
      if (src.kind === 'ics-url' && src.url) {
        const { text, finalUrl } = await this.fetchUrl(src.url, { insecure });
        fs.writeFileSync(this._rawPath(id), text, 'utf8');
        const parsed = ics.parseCalendar(text, { id, name: src.name });
        src.url = finalUrl;
        src.lastSyncAt = Date.now();
        src.lastError = '';
        src.eventCount = parsed.events.length;
        src.meta = parsed.meta;
        this._cache.delete(id);
        this.store.saveSoon(0);
        this.emit('sources', this.sources());
        this.emit('change', { reason: 'refresh', source: sanitizeSource(src) });
        return { ok: true, count: parsed.events.length };
      }
      if (src.kind === 'ics-file' && src.path) {
        const text = fs.readFileSync(src.path, 'utf8');
        fs.writeFileSync(this._rawPath(id), text, 'utf8');
        const parsed = ics.parseCalendar(text, { id, name: src.name });
        src.lastSyncAt = Date.now();
        src.lastError = '';
        src.eventCount = parsed.events.length;
        src.meta = parsed.meta;
        this._cache.delete(id);
        this.store.saveSoon(0);
        this.emit('sources', this.sources());
        this.emit('change', { reason: 'refresh', source: sanitizeSource(src) });
        return { ok: true, count: parsed.events.length };
      }
      return { ok: true, count: src.eventCount || 0 };
    } catch (err) {
      src.lastError = err.message;
      src.lastSyncAt = Date.now();
      this.store.saveSoon(0);
      this.emit('sources', this.sources());
      return { ok: false, error: err.message };
    }
  }

  async refreshAll() {
    const results = [];
    for (const src of this.config.sources || []) {
      if (src.kind === 'ics-url') results.push({ id: src.id, ...(await this.refreshSource(src.id)) });
    }
    if (results.length) this.emit('refreshed', results);
    return results;
  }

  /* ---------------- sharing ---------------- */

  buildShareSnapshot({ days = 30 } = {}) {
    const from = Date.now() - 6 * 3600000;
    const to = Date.now() + days * 86400000;
    const hidePrivate = this.config.hidePrivate !== false;
    const events = this.ownEvents(from, to, { hidePrivate }).map((ev) => sanitizeSharedEvent(ev, 'me'));
    return {
      v: 1,
      kind: 'ca-calendar',
      generatedAt: Date.now(),
      source: this.identityName || '',
      events: events.slice(0, 500),
    };
  }

  applyPartnerSnapshot(payload) {
    if (!payload || payload.kind !== 'ca-calendar' || !Array.isArray(payload.events)) return 0;
    const events = [];
    const now = Date.now();
    for (const ev of payload.events.slice(0, 500)) {
      if (!ev || !Number.isFinite(ev.start) || !Number.isFinite(ev.end)) continue;
      if (ev.end <= now - 7 * 86400000) continue; // drop long-past events
      events.push(sanitizeSharedEvent(ev, 'peer'));
    }
    this.partner = {
      receivedAt: now,
      generatedAt: payload.generatedAt || now,
      source: clip(payload.source, 60),
      events,
    };
    writeJsonAtomic(this.partnerFile, this.partner);
    this.emit('change', { reason: 'partner', count: events.length });
    this.emit('partner', this.partnerSummary());
    return events.length;
  }

  partnerSummary() {
    if (!this.partner) return { receivedAt: 0, count: 0, source: '' };
    return {
      receivedAt: this.partner.receivedAt,
      count: this.partner.events.length,
      source: this.partner.source,
      name: this.getPartnerName(),
    };
  }

  clearPartner() {
    this.partner = null;
    try {
      fs.unlinkSync(this.partnerFile);
    } catch (_) {}
    this.emit('change', { reason: 'partner-cleared' });
  }

  shareConfig() {
    return {
      share: this.config.share !== false,
      hidePrivate: this.config.hidePrivate !== false,
      widget: { ...this.config.widget },
      partner: this.partnerSummary(),
    };
  }

  setShare(enabled) {
    this.config.share = Boolean(enabled);
    this.store.saveSoon(0);
    this.emit('change', { reason: 'share' });
    return this.shareConfig();
  }

  setHidePrivate(enabled) {
    this.config.hidePrivate = Boolean(enabled);
    this.store.saveSoon(0);
    this.emit('change', { reason: 'hidePrivate' });
    return this.shareConfig();
  }
}

module.exports = { CalendarService, sanitizeSharedEvent, MAX_ICS_BYTES };
