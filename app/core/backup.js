'use strict';
/*
 * Encrypted memory backup.
 *
 * The couple can store a sealed snapshot on their own server (and locally).
 * The server only ever holds AES-256-GCM blobs; without the pair root they are
 * indistinguishable from random bytes. Restore merges by id, never overwrites
 * newer local memories.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const ca = require('./crypto');
const { request } = require('./http');
const { ensureDir, readJsonSafe, writeJsonAtomic } = require('./store');

const MAX_BACKUP_BYTES = 3 * 1024 * 1024;

function clipPayload(payload, { maxMessages = 300, maxSummaries = 200 } = {}) {
  payload.chat = { messages: (payload.chat && payload.chat.messages ? payload.chat.messages : []).slice(-maxMessages) };
  payload.ci = { summaries: (payload.ci && payload.ci.summaries ? payload.ci.summaries : []).slice(-maxSummaries) };
  let text = JSON.stringify(payload);
  while (text.length > MAX_BACKUP_BYTES) {
    if (payload.chat.messages.length > 40) payload.chat.messages.shift();
    else if (payload.ci.summaries.length > 20) payload.ci.summaries.shift();
    else break;
    text = JSON.stringify(payload);
  }
  return text;
}

class BackupService extends EventEmitter {
  constructor({ identity, store, paths, logger = () => {}, chat, ci, calendar }) {
    super();
    this.identity = identity;
    this.store = store;
    this.paths = paths;
    this.logger = logger;
    this.chat = chat;
    this.ci = ci;
    this.calendar = calendar;
    this.busy = false;
    ensureDir(paths.backups);
  }

  get serverUrl() {
    return String((this.store.get().server || {}).url || '').replace(/\/+$/, '');
  }

  get insecure() {
    return Boolean((this.store.get().server || {}).insecure);
  }

  get creds() {
    return this.identity.backupCredentials();
  }

  localFiles() {
    try {
      return fs
        .readdirSync(this.paths.backups)
        .filter((f) => f.endsWith('.ca'))
        .map((f) => {
          const st = fs.statSync(path.join(this.paths.backups, f));
          return { name: f, size: st.size, mtime: st.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch (_) {
      return [];
    }
  }

  buildSnapshot() {
    const partner = this.calendar && this.calendar.partner ? this.calendar.partner : null;
    const payload = {
      format: 'ca-backup-v1',
      createdAt: Date.now(),
      device: { id: this.identity.id, name: this.identity.name, platform: this.identity.platform },
      peer: this.identity.peer ? { id: this.identity.peer.id, name: this.identity.peer.name } : null,
      ci: { summaries: this.ci ? this.ci.summaries : [] },
      chat: { messages: this.chat ? this.chat.recent(300) : [] },
      calendar: partner ? { partner: { receivedAt: partner.receivedAt, events: partner.events } } : null,
    };
    return clipPayload(payload);
  }

  _seal(plaintext) {
    const keys = this.identity.keys();
    if (!keys || !keys.backup) throw new Error('this device is not paired');
    return ca.seal(keys.backup, plaintext, 'ca1|backup');
  }

  _unseal(blob) {
    const keys = this.identity.keys();
    if (!keys || !keys.backup) throw new Error('this device is not paired');
    const text = ca.open(keys.backup, blob, 'ca1|backup');
    if (text == null) throw new Error('备份无法解密（密钥不匹配）/ Cannot decrypt backup (key mismatch)');
    const payload = JSON.parse(text);
    if (payload.format !== 'ca-backup-v1') throw new Error('unsupported backup format');
    return payload;
  }

  _filename(ts) {
    const short = this.identity.id.slice(0, 8);
    return { latest: `latest-${short}.bin`, archive: `ca-${short}-${ts}.bin` };
  }

  async backupNow({ reason = 'manual' } = {}) {
    if (this.busy) return { ok: false, error: 'busy' };
    if (!this.identity.isPaired) return { ok: false, error: 'not paired' };
    this.busy = true;
    const cfg = this.store.get().server;
    try {
      const plaintext = this.buildSnapshot();
      const blob = this._seal(plaintext);
      const ts = Date.now();
      const names = this._filename(ts);
      // Always keep a local sealed copy, even if the server is unreachable.
      const localFile = path.join(this.paths.backups, `${ts}.ca`);
      fs.writeFileSync(localFile, blob, 'utf8');
      this._pruneLocal(6);
      let serverResult = null;
      if (this.serverUrl && this.creds) {
        const url = `${this.serverUrl}/api/backup/${this.creds.room}`;
        const headers = { 'X-CA-Token': this.creds.token };
        await request(`${url}/${names.latest}`, {
          method: 'PUT',
          headers,
          body: Buffer.from(blob),
          insecure: this.insecure,
          timeout: 30000,
          raw: true,
        }).then((res) => {
          if (res.status !== 200) throw new Error('HTTP ' + res.status);
        });
        await request(`${url}/${names.archive}`, {
          method: 'PUT',
          headers,
          body: Buffer.from(blob),
          insecure: this.insecure,
          timeout: 30000,
          raw: true,
        }).then((res) => {
          if (res.status !== 200) throw new Error('HTTP ' + res.status);
        });
        await this._pruneServer(10).catch(() => {});
        serverResult = { ok: true };
      }
      const now = Date.now();
      cfg.lastBackupAt = now;
      cfg.lastBackupBytes = Buffer.byteLength(blob);
      cfg.lastBackupError = '';
      cfg.lastBackupLocal = localFile;
      this.store.saveSoon(0);
      this.emit('backup', { at: now, bytes: cfg.lastBackupBytes, server: serverResult, reason });
      return { ok: true, at: now, bytes: cfg.lastBackupBytes, local: localFile, server: serverResult };
    } catch (err) {
      const cfg2 = this.store.get().server;
      cfg2.lastBackupError = err.message;
      this.store.saveSoon(0);
      this.emit('backup-error', { message: err.message });
      return { ok: false, error: err.message };
    } finally {
      this.busy = false;
      this.emit('state', this.status());
    }
  }

  _pruneLocal(keep) {
    const files = this.localFiles();
    for (const f of files.slice(keep)) {
      try {
        fs.unlinkSync(path.join(this.paths.backups, f.name));
      } catch (_) {}
    }
  }

  async _pruneServer(keep) {
    if (!this.serverUrl || !this.creds) return;
    try {
      const res = await request(`${this.serverUrl}/api/backup/${this.creds.room}`, {
        headers: { 'X-CA-Token': this.creds.token },
        insecure: this.insecure,
        timeout: 15000,
      });
      if (res.status !== 200 || !res.body || !Array.isArray(res.body.files)) return;
      const archives = res.body.files
        .filter((f) => /^ca-.+\.bin$/.test(f.name))
        .sort((a, b) => b.mtime - a.mtime);
      for (const f of archives.slice(keep)) {
        await request(`${this.serverUrl}/api/backup/${this.creds.room}/${f.name}`, {
          method: 'DELETE',
          headers: { 'X-CA-Token': this.creds.token },
          insecure: this.insecure,
          timeout: 10000,
        }).catch(() => {});
      }
    } catch (_) {}
  }

  async listRemote() {
    if (!this.serverUrl || !this.creds) return { ok: false, error: 'no server', files: [] };
    try {
      const res = await request(`${this.serverUrl}/api/backup/${this.creds.room}`, {
        headers: { 'X-CA-Token': this.creds.token },
        insecure: this.insecure,
        timeout: 15000,
      });
      if (res.status !== 200 || !res.body) throw new Error('HTTP ' + res.status);
      return { ok: true, used: res.body.used, quota: res.body.quota, files: res.body.files || [] };
    } catch (err) {
      return { ok: false, error: err.message, files: [] };
    }
  }

  async _download(name) {
    const res = await request(`${this.serverUrl}/api/backup/${this.creds.room}/${name}`, {
      headers: { 'X-CA-Token': this.creds.token },
      insecure: this.insecure,
      timeout: 30000,
      raw: true,
    });
    if (res.status !== 200) throw new Error('HTTP ' + res.status);
    return res.body.toString('utf8');
  }

  async restoreLatest() {
    if (!this.identity.isPaired) return { ok: false, error: 'not paired' };
    let blob = null;
    let from = '';
    try {
      const list = await this.listRemote();
      if (list.ok) {
        const candidates = (list.files || [])
          .filter((f) => f.name.endsWith('.bin'))
          .sort((a, b) => b.mtime - a.mtime);
        if (candidates.length) {
          blob = await this._download(candidates[0].name);
          from = candidates[0].name;
        }
      }
    } catch (err) {
      this.logger('warn', 'remote restore failed: ' + err.message);
    }
    if (!blob) {
      const locals = this.localFiles();
      if (!locals.length) return { ok: false, error: '没有找到备份 / No backups found' };
      blob = fs.readFileSync(path.join(this.paths.backups, locals[0].name), 'utf8');
      from = locals[0].name;
    }
    const payload = this._unseal(blob);
    const result = {
      createdAt: payload.createdAt,
      device: payload.device,
      from,
      ciAdded: 0,
      chatAdded: 0,
      calendarApplied: 0,
    };
    if (this.ci && payload.ci && Array.isArray(payload.ci.summaries)) {
      result.ciAdded = this.ci.importSummaries(payload.ci.summaries);
    }
    if (this.chat && payload.chat && Array.isArray(payload.chat.messages)) {
      result.chatAdded = this.chat.importMessages(payload.chat.messages);
    }
    if (this.calendar && payload.calendar && payload.calendar.partner) {
      result.calendarApplied = this.calendar.applyPartnerSnapshot({
        v: 1,
        kind: 'ca-calendar',
        events: payload.calendar.partner.events || [],
        generatedAt: payload.calendar.partner.receivedAt || 0,
        source: payload.device ? payload.device.name : '',
      });
    }
    this.emit('restore', result);
    return { ok: true, ...result };
  }

  status() {
    const cfg = this.store.get().server || {};
    return {
      busy: this.busy,
      lastBackupAt: cfg.lastBackupAt || 0,
      lastBackupBytes: cfg.lastBackupBytes || 0,
      lastBackupError: cfg.lastBackupError || '',
      hasLocal: this.localFiles().length > 0,
      localCount: this.localFiles().length,
      serverConfigured: Boolean(this.serverUrl),
      autoBackup: cfg.autoBackup !== false,
      intervalMin: cfg.backupIntervalMin || 60,
      roomShort: this.creds ? this.creds.room.slice(0, 8) : '',
    };
  }
}

module.exports = { BackupService, MAX_BACKUP_BYTES };
