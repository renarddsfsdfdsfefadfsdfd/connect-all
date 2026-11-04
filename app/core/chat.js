'use strict';
/*
 * Local chat log. One append-only JSONL file, newest state kept in memory.
 * Messages are stored in plaintext on this device only; the relay only ever
 * sees AES-GCM ciphertext.
 */

const { EventEmitter } = require('events');
const ca = require('./crypto');

const MAX_MESSAGES = 5000;
const MAX_TEXT = 4000;

function cleanText(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .slice(0, MAX_TEXT)
    .trim();
}

class ChatStore extends EventEmitter {
  constructor({ log, state, maxMessages = MAX_MESSAGES }) {
    super();
    this.logFile = log;
    this.state = state; // JsonStore for lastReadAt etc.
    this.maxMessages = maxMessages;
    this.messages = log.readAll().filter((m) => m && m.id).slice(-maxMessages);
    this.byId = new Map(this.messages.map((m) => [m.id, m]));
    this._dirty = false;
    this._flushTimer = null;
    this._flush = this._flush.bind(this);
  }

  start() {
    this._flushTimer = setInterval(this._flush, 30000);
    if (this._flushTimer.unref) this._flushTimer.unref();
  }

  stop() {
    if (this._flushTimer) clearInterval(this._flushTimer);
    this._flushTimer = null;
    this.flush();
  }

  _flush() {
    if (!this._dirty) return;
    try {
      this.logFile.rewrite(this.messages);
      this._dirty = false;
    } catch (_) {}
  }

  flush() {
    this._flush();
  }

  _persistNew(message) {
    try {
      // append only new records; state updates are flushed in bulk
      const last = this._lastAppended;
      if (!last || last.id !== message.id) {
        this.logFile.append(message);
        this._lastAppended = message;
        this._dirty = true;
      }
    } catch (_) {}
  }

  _push(message) {
    if (this.byId.has(message.id)) return null;
    this.messages.push(message);
    this.byId.set(message.id, message);
    this._persistNew(message);
    if (this.messages.length > this.maxMessages) {
      const removed = this.messages.splice(0, this.messages.length - this.maxMessages);
      for (const old of removed) this.byId.delete(old.id);
      this._dirty = true;
    }
    this.emit('message', message);
    this.emit('update', { type: 'new', message });
    return message;
  }

  addOutgoing(text, { kind = 'text', clientId } = {}) {
    const body = cleanText(text);
    if (!body) return null;
    return this._push({
      id: clientId || ca.randomId(10),
      at: Date.now(),
      from: 'me',
      kind,
      text: body,
      state: 'sending',
    });
  }

  addIncoming(payload) {
    if (!payload || !payload.id) return null;
    const body = cleanText(payload.text);
    if (!body) return null;
    if (this.byId.has(payload.id)) return null;
    return this._push({
      id: String(payload.id).slice(0, 80),
      at: Number(payload.at) || Date.now(),
      from: 'peer',
      kind: payload.kind === 'text' ? 'text' : 'text',
      text: body,
      state: 'received',
    });
  }

  addSystem(text, meta = {}) {
    return this._push({
      id: 'sys_' + ca.randomId(8),
      at: Date.now(),
      from: 'system',
      kind: 'system',
      text: cleanText(text).slice(0, 500),
      state: 'received',
      meta,
    });
  }

  setState(id, state) {
    const msg = this.byId.get(id);
    if (!msg || msg.state === state) return false;
    msg.state = state;
    this._dirty = true;
    this.emit('update', { type: 'state', message: msg });
    return true;
  }

  markPendingSent() {
    let changed = 0;
    for (const m of this.messages) {
      if (m.from === 'me' && (m.state === 'sending' || m.state === 'queued')) {
        m.state = 'sent';
        changed++;
      }
    }
    if (changed) {
      this._dirty = true;
      this.emit('update', { type: 'pending-sent', count: changed });
    }
    return changed;
  }

  markSent(ids) {
    let changed = false;
    for (const id of [].concat(ids)) if (this.setState(id, 'sent')) changed = true;
    return changed;
  }

  markDelivered(id) {
    const msg = this.byId.get(id);
    if (!msg || msg.from !== 'me') return false;
    if (msg.state === 'delivered') return false;
    msg.state = 'delivered';
    this._dirty = true;
    this.emit('update', { type: 'state', message: msg });
    return true;
  }

  between(fromMs, toMs) {
    return this.messages.filter((m) => m.at >= fromMs && m.at <= toMs);
  }

  recent(n = 200) {
    return this.messages.slice(-n);
  }

  list({ limit = 200, before = 0 } = {}) {
    let items = this.messages;
    if (before) items = items.filter((m) => m.at < before);
    return items.slice(-limit);
  }

  search(query, limit = 100) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    return this.messages
      .filter((m) => (m.text || '').toLowerCase().includes(q))
      .slice(-limit)
      .reverse();
  }

  lastReadAt() {
    return Number(this.state.get().lastReadAt || 0);
  }

  markRead(at = Date.now()) {
    const st = this.state.get();
    if ((st.lastReadAt || 0) >= at) return 0;
    st.lastReadAt = at;
    this.state.saveSoon();
    this.emit('update', { type: 'read' });
    return this.unreadCount();
  }

  unreadCount() {
    const lastRead = this.lastReadAt();
    let n = 0;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.at <= lastRead) break;
      if (m.from === 'peer') n++;
    }
    return n;
  }

  lastPeerMessage() {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].from === 'peer') return this.messages[i];
    }
    return null;
  }

  lastMessage() {
    return this.messages.length ? this.messages[this.messages.length - 1] : null;
  }

  stats() {
    return {
      count: this.messages.length,
      unread: this.unreadCount(),
      bytes: this.logFile.sizeBytes,
      firstAt: this.messages.length ? this.messages[0].at : 0,
      lastAt: this.messages.length ? this.messages[this.messages.length - 1].at : 0,
      lastPeerAt: this.lastPeerMessage() ? this.lastPeerMessage().at : 0,
    };
  }

  clear() {
    this.messages = [];
    this.byId.clear();
    this.logFile.rewrite([]);
    this._dirty = false;
    this.emit('update', { type: 'clear' });
  }

  prune(days) {
    if (!days || days <= 0) return 0;
    const cutoff = Date.now() - days * 86400000;
    const kept = this.messages.filter((m) => m.at >= cutoff);
    const removed = this.messages.length - kept.length;
    if (removed > 0) {
      this.messages = kept;
      this.byId = new Map(kept.map((m) => [m.id, m]));
      this.logFile.rewrite(kept);
      this._dirty = false;
      this.emit('update', { type: 'prune', removed });
    }
    return removed;
  }

  exportJson() {
    return {
      app: 'Connect All',
      format: 'ca-chat-v1',
      exportedAt: Date.now(),
      messages: this.messages,
    };
  }

  importMessages(list) {
    let added = 0;
    for (const raw of Array.isArray(list) ? list : []) {
      if (!raw || !raw.id || !raw.text) continue;
      if (this.byId.has(raw.id)) continue;
      const msg = {
        id: String(raw.id).slice(0, 80),
        at: Number(raw.at) || Date.now(),
        from: raw.from === 'me' ? 'me' : raw.from === 'system' ? 'system' : 'peer',
        kind: 'text',
        text: cleanText(raw.text),
        state: raw.from === 'me' ? 'sent' : 'received',
      };
      if (!msg.text) continue;
      this.messages.push(msg);
      this.byId.set(msg.id, msg);
      added++;
    }
    if (added) {
      this.messages.sort((a, b) => a.at - b.at);
      this._dirty = true;
      this.flush();
      this.emit('update', { type: 'import', added });
    }
    return added;
  }
}

module.exports = { ChatStore, cleanText, MAX_TEXT };
