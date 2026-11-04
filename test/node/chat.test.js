'use strict';
const path = require('path');
const { test, assert } = require('../harness');
const { tmpDir, rmrf } = require('../helpers');
const { ChatStore } = require('../../app/core/chat');
const { JsonlLog, JsonStore } = require('../../app/core/store');

function makeChat(dir) {
  const log = new JsonlLog(path.join(dir, 'chat.jsonl'));
  const state = new JsonStore(path.join(dir, 'state.json'), { lastReadAt: 0 });
  return { chat: new ChatStore({ log, state }), log };
}

test('chat store dedupes ids, tracks unread and delivery states', () => {
  const dir = tmpDir('ca-chat');
  try {
    const { chat, log } = makeChat(dir);
    const a = chat.addOutgoing('hello');
    assert.ok(a.id);
    assert.equal(a.state, 'sending');
    chat.setState(a.id, 'sent');
    chat.markDelivered(a.id);
    assert.equal(chat.byId.get(a.id).state, 'delivered');
    // delivery only applies to my messages
    const b = chat.addIncoming({ id: 'peer-1', text: 'hi', at: Date.now() });
    assert.equal(chat.markDelivered('peer-1'), false);
    assert.equal(chat.addIncoming({ id: 'peer-1', text: 'hi again' }), null);
    assert.equal(chat.unreadCount(), 1);
    chat.markRead();
    assert.equal(chat.unreadCount(), 0);
    assert.equal(chat.list({ limit: 5 }).length, 2);
    assert.equal(chat.search('hello').length, 1);
    chat.flush();
    const reloaded = new ChatStore({
      log: new JsonlLog(path.join(dir, 'chat.jsonl')),
      state: new JsonStore(path.join(dir, 'state.json'), { lastReadAt: 0 }),
    });
    assert.equal(reloaded.list({ limit: 10 }).length, 2);
    assert.equal(reloaded.byId.get(a.id).state, 'delivered');
    assert.equal(reloaded.byId.get('peer-1').text, 'hi');
  } finally {
    rmrf(dir);
  }
});

test('markPendingSent moves queued messages to sent', () => {
  const dir = tmpDir('ca-chat2');
  try {
    const { chat } = makeChat(dir);
    const m = chat.addOutgoing('queued');
    chat.setState(m.id, 'queued');
    assert.equal(chat.markPendingSent(), 1);
    assert.equal(chat.byId.get(m.id).state, 'sent');
  } finally {
    rmrf(dir);
  }
});

test('import merges by id and prune respects age', () => {
  const dir = tmpDir('ca-chat3');
  try {
    const { chat } = makeChat(dir);
    const now = Date.now();
    const added = chat.importMessages([
      { id: 'x1', at: now - 2 * 86400000, from: 'peer', text: 'old' },
      { id: 'x2', at: now, from: 'me', text: 'mine' },
    ]);
    assert.equal(added, 2);
    assert.equal(chat.importMessages([{ id: 'x1', at: now, from: 'peer', text: 'old' }]), 0);
    const removed = chat.prune(1); // 1 day
    assert.ok(removed >= 1);
    // own messages are retained by prune
    assert.ok(chat.list({ limit: 10 }).some((m) => m.id === 'x2'));
  } finally {
    rmrf(dir);
  }
});

test('JsonStore merges defaults and JSONL log reloads', () => {
  const dir = tmpDir('ca-store');
  try {
    const store = new JsonStore(path.join(dir, 'config.json'), { a: 1, nested: { x: 1, y: 2 } });
    store.update({ nested: { x: 9 }, b: 2 });
    store.saveNow();
    const again = new JsonStore(path.join(dir, 'config.json'), { a: 0, nested: { x: 0, y: 0 } });
    assert.equal(again.get().a, 1);
    assert.equal(again.get().nested.x, 9);
    assert.equal(again.get().nested.y, 2);
    assert.equal(again.get().b, 2);
    const log = new JsonlLog(path.join(dir, 'l.jsonl'));
    log.append({ n: 1 });
    log.append({ n: 2 });
    assert.deepEqual(log.readAll(), [{ n: 1 }, { n: 2 }]);
  } finally {
    rmrf(dir);
  }
});
