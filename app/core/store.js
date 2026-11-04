'use strict';
/*
 * Persistent local state. Plain JSON files with atomic writes — inspectable,
 * easy to back up, and no database dependency to ship on three platforms.
 * Everything here is pure Node so it can be unit-tested without Electron.
 */

const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    // Keep the damaged file for the user instead of silently deleting evidence.
    try {
      fs.renameSync(file, file + '.corrupt-' + Date.now());
    } catch (_) {}
    return fallback;
  }
}

function writeJsonAtomic(file, data, { pretty = true } = {}) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(data, null, pretty ? 2 : 0));
  fs.renameSync(tmp, file);
}

class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults || {};
    const loaded = readJsonSafe(file, null);
    this.data = deepMerge(clone(this.defaults), loaded && typeof loaded === 'object' ? loaded : {});
    this._timer = null;
    this._dirty = false;
  }

  get() {
    return this.data;
  }

  saveSoon(delay = 150) {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.saveNow();
    }, delay);
    if (this._timer.unref) this._timer.unref();
  }

  saveNow() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    writeJsonAtomic(this.file, this.data);
    this._dirty = false;
  }

  update(patch) {
    this.data = deepMerge(this.data, patch || {});
    this.saveSoon();
    return this.data;
  }

  set(keyPath, value) {
    const parts = String(keyPath).split('.');
    let node = this.data;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = value;
    this.saveSoon();
    return value;
  }
}

class JsonlLog {
  constructor(file, { maxEntries = 20000, maxBytes = 8 * 1024 * 1024 } = {}) {
    this.file = file;
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    ensureDir(path.dirname(file));
  }

  append(entry) {
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(this.file, line);
    this._maybeRotate();
  }

  readAll() {
    let text = '';
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (_) {
      return [];
    }
    const out = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed));
      } catch (_) {}
    }
    return out;
  }

  readTail(n) {
    const all = this.readAll();
    return all.slice(Math.max(0, all.length - n));
  }

  rewrite(entries) {
    ensureDir(path.dirname(this.file));
    const tmp = this.file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
    fs.renameSync(tmp, this.file);
  }

  get sizeBytes() {
    try {
      return fs.statSync(this.file).size;
    } catch (_) {
      return 0;
    }
  }

  _maybeRotate() {
    if (this._rotating) return;
    let stat;
    try {
      stat = fs.statSync(this.file);
    } catch (_) {
      return;
    }
    if (stat.size <= this.maxBytes) return;
    this._rotating = true;
    try {
      const entries = this.readAll().slice(-Math.floor(this.maxEntries * 0.8));
      this.rewrite(entries);
    } catch (_) {
    } finally {
      this._rotating = false;
    }
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function deepMerge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) base = {};
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      base[key] = deepMerge(base[key], value);
    } else {
      base[key] = value;
    }
  }
  return base;
}

function createPaths(baseDir) {
  const dir = path.resolve(baseDir);
  return {
    base: dir,
    config: path.join(dir, 'config.json'),
    state: path.join(dir, 'state.json'),
    secrets: path.join(dir, 'secrets.json'),
    chat: path.join(dir, 'chat.jsonl'),
    ci: path.join(dir, 'ci.jsonl'),
    calendarDir: path.join(dir, 'calendar'),
    calendar: path.join(dir, 'calendar', 'sources.json'),
    memoryDir: path.join(dir, 'memory'),
    logs: path.join(dir, 'logs'),
    log: path.join(dir, 'logs', 'app.log'),
    backups: path.join(dir, 'backups'),
  };
}

function appendLog(file, level, message, extra) {
  try {
    ensureDir(path.dirname(file));
    const stat = fs.existsSync(file) ? fs.statSync(file) : { size: 0 };
    if (stat.size > 2 * 1024 * 1024) {
      fs.renameSync(file, file + '.1');
    }
    const line =
      new Date().toISOString() +
      ' [' +
      level +
      '] ' +
      message +
      (extra ? ' ' + JSON.stringify(extra) : '') +
      '\n';
    fs.appendFileSync(file, line);
  } catch (_) {}
}

module.exports = {
  JsonStore,
  JsonlLog,
  createPaths,
  readJsonSafe,
  writeJsonAtomic,
  ensureDir,
  appendLog,
  clone,
  deepMerge,
};
