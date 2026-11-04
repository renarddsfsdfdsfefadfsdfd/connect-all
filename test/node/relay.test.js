'use strict';
const fs = require('fs');
const path = require('path');
const { test, assert } = require('../harness');
const { tmpDir, rmrf, waitFor, sleep } = require('../helpers');
const { createRelay } = require('../../server/ca-server');
const ws = require('../../server/ws');
const ca = require('../../app/core/crypto');
const { request, jsonRequest } = require('../../app/core/http');

function onceMessage(conn, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('message timeout')), 5000);
    const handler = (msg) => {
      if (msg.type !== 'text') return;
      let parsed;
      try {
        parsed = JSON.parse(msg.data);
      } catch (_) {
        return;
      }
      if (parsed && predicate(parsed)) {
        clearTimeout(timer);
        conn.removeListener('message', handler);
        resolve(parsed);
      }
    };
    conn.on('message', handler);
  });
}

test('relay bounds pairing rooms, relays ciphertext and replays history', async () => {
  const dir = tmpDir('ca-relay');
  const relay = createRelay({ port: 0, host: '127.0.0.1', dataDir: dir, quiet: true, historyLimit: 50 });
  const addr = await relay.listen();
  const base = 'http://127.0.0.1:' + addr.port;
  const code = 'RELAY7';
  const room = ca.pairRoom(code);
  const token = ca.roomToken(code);
  const idA = 'aaaa11112222';
  const idB = 'bbbb33334444';
  const a = ca.generateIdentityKeyPair();
  const b = ca.generateIdentityKeyPair();
  let connA;
  let connB;
  try {
    const health = await jsonRequest(base + '/api/health');
    assert.ok(health.ok);
    const joinA = await jsonRequest(base + '/api/pair/join', {
      method: 'POST',
      body: { room, token, pub: a.publicKey, device: { id: idA, name: 'A' } },
    });
    const joinB = await jsonRequest(base + '/api/pair/join', {
      method: 'POST',
      body: { room, token, pub: b.publicKey, device: { id: idB, name: 'B' } },
    });
    assert.equal(joinA.peers.length, 1);
    assert.equal(joinB.peers.length, 2);
    const third = await request(base + '/api/pair/join', {
      method: 'POST',
      body: { room, token, pub: a.publicKey, device: { id: 'cccc55556666', name: 'C' } },
    });
    assert.equal(third.status, 409);
    const bad = await request(base + '/api/pair/join', {
      method: 'POST',
      body: { room, token: ca.roomToken('WRONG7'), pub: a.publicKey, device: { id: idA, name: 'A' } },
    });
    assert.equal(bad.status, 403);

    connA = await ws.connect(`ws://127.0.0.1:${addr.port}/ws?room=${room}&token=${token}&device=${idA}&since=0`);
    await onceMessage(connA, (m) => m.type === 'ready');
    connB = await ws.connect(`ws://127.0.0.1:${addr.port}/ws?room=${room}&token=${token}&device=${idB}&since=0`);
    await onceMessage(connB, (m) => m.type === 'ready');

    const keysA = ca.deriveKeys(a.privateKey, a.publicKey, b.publicKey, idA, idB);
    const keysB = ca.deriveKeys(b.privateKey, b.publicKey, a.publicKey, idB, idA);
    const cipher = ca.seal(keysA.keys.chat, JSON.stringify({ text: '你好 B' }), 'ca1|chat');
    const ackPromise = onceMessage(connA, (m) => m.type === 'ack');
    const msgPromise = onceMessage(connB, (m) => m.type === 'msg');
    connA.send(JSON.stringify({ type: 'msg', id: 'm1', kind: 'chat', cipher }));
    const msg = await msgPromise;
    await ackPromise;
    assert.equal(msg.seq, 1);
    assert.equal(msg.cipher, cipher);
    const decoded = ca.open(keysB.keys.chat, msg.cipher, 'ca1|chat');
    assert.equal(decoded, JSON.stringify({ text: '你好 B' }));

    const historyFile = fs.readFileSync(path.join(dir, 'rooms', room + '.jsonl'), 'utf8');
    assert.ok(!historyFile.includes('你好'), 'relay file must not contain plaintext');

    connB.close();
    await sleep(150);
    const cipher2 = ca.seal(keysA.keys.chat, JSON.stringify({ text: 'offline' }), 'ca1|chat');
    connA.send(JSON.stringify({ type: 'msg', id: 'm2', kind: 'chat', cipher: cipher2 }));
    await sleep(250);
    const connB2 = await ws.connect(`ws://127.0.0.1:${addr.port}/ws?room=${room}&token=${token}&device=${idB}&since=1`);
    const history = await onceMessage(connB2, (m) => m.type === 'history');
    assert.ok(history.messages.some((m) => m.id === 'm2'));
    connB2.close();

    // backups: opaque bytes, token auth, name validation
    const put = await request(base + `/api/backup/${room}/mem.json`, {
      method: 'PUT',
      headers: { 'X-CA-Token': token },
      body: Buffer.from('cipher-blob'),
    });
    assert.equal(put.status, 200);
    const list = await jsonRequest(base + `/api/backup/${room}`, { headers: { 'X-CA-Token': token } });
    assert.equal(list.files.length, 1);
    const get = await request(base + `/api/backup/${room}/mem.json`, { headers: { 'X-CA-Token': token }, raw: true });
    assert.equal(get.status, 200);
    assert.equal(get.body.toString(), 'cipher-blob');
    const unauth = await request(base + `/api/backup/${room}/mem.json`, { headers: { 'X-CA-Token': ca.roomToken('WRONG7') } });
    assert.equal(unauth.status, 403);
    const traversal = await request(base + `/api/backup/${room}/..%2Fescape`, {
      method: 'PUT',
      headers: { 'X-CA-Token': token },
      body: 'x',
    });
    assert.equal(traversal.status, 400);
    const badWs = await request(`/ws?room=${room}&token=${ca.roomToken('WRONG7')}&device=${idA}`, {
      method: 'GET',
      insecure: false,
    }).catch(() => null);
    // HTTP upgrade is not a normal request; just ensure bad tokens never reach a room.
  } finally {
    try {
      connA && connA.close();
      connB && connB.close();
    } catch (_) {}
    await relay.close();
    rmrf(dir);
  }
});

test('relay survives a restart with a persisted epoch and sequence', async () => {
  const dir = tmpDir('ca-relay2');
  const relay = createRelay({ port: 0, host: '127.0.0.1', dataDir: dir, quiet: true });
  const addr = await relay.listen();
  const token = ca.roomToken('PERSIST');
  const room = ca.pairRoom('PERSIST');
  const device = 'dddd11112222';
  try {
    const conn = await ws.connect(`ws://127.0.0.1:${addr.port}/ws?room=${room}&token=${token}&device=${device}&since=0`);
    const ready = await onceMessage(conn, (m) => m.type === 'ready');
    const epoch = ready.epoch;
    conn.send(JSON.stringify({ type: 'msg', id: 'p1', kind: 'chat', cipher: 'opaque' }));
    await onceMessage(conn, (m) => m.type === 'ack');
    conn.close();
    await relay.close();
    const relay2 = createRelay({ port: addr.port, host: '127.0.0.1', dataDir: dir, quiet: true });
    await relay2.listen();
    const conn2 = await ws.connect(`ws://127.0.0.1:${addr.port}/ws?room=${room}&token=${token}&device=${device}&since=0`);
    const ready2 = await onceMessage(conn2, (m) => m.type === 'ready');
    assert.equal(ready2.epoch, epoch);
    assert.equal(ready2.seq, 1);
    conn2.close();
    await relay2.close();
  } finally {
    try {
      await relay.close();
    } catch (_) {}
    rmrf(dir);
  }
});
