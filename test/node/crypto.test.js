'use strict';
const { test, assert } = require('../harness');

test('pairing codes normalize Crockford lookalikes and derive stable rooms', () => {
  const ca = require('../../app/core/crypto');
  assert.equal(ca.normalizePairingCode('ab-cd ef'), 'ABCDEF');
  assert.equal(ca.normalizePairingCode('O0IL'), '0011');
  const a = ca.pairRoom('LOVE42');
  const b = ca.pairRoom('love42');
  assert.equal(a, b);
  assert.ok(/^[a-f0-9]{32}$/.test(a));
  assert.equal(ca.roomToken('LOVE42'), ca.roomToken('love-42'));
});

test('X25519 + HKDF derives identical roots and topic keys on both sides', () => {
  const ca = require('../../app/core/crypto');
  const alice = ca.generateIdentityKeyPair();
  const bob = ca.generateIdentityKeyPair();
  const a = ca.deriveKeys(alice.privateKey, alice.publicKey, bob.publicKey, 'alice-id', 'bob-id');
  const b = ca.deriveKeys(bob.privateKey, bob.publicKey, alice.publicKey, 'bob-id', 'alice-id');
  assert.equal(a.root, b.root);
  assert.equal(a.keys.chat, b.keys.chat);
  assert.equal(a.keys.backup, b.keys.backup);
  assert.equal(ca.sasFromRoot(a.root), ca.sasFromRoot(b.root));
  assert.ok(/^\d{4} \d{4}$/.test(ca.sasFromRoot(a.root)));
  // persistence path
  const again = ca.importRoot(a.root, 'bob-id', 'alice-id');
  assert.equal(again.keys.signal, a.keys.signal);
});

test('AES-256-GCM rejects tampering and wrong AAD', () => {
  const ca = require('../../app/core/crypto');
  const key = ca.b64url(require('crypto').randomBytes(32));
  const sealed = ca.seal(key, JSON.stringify({ text: 'hi 世界' }), 'ca1|chat');
  assert.equal(ca.open(key, sealed, 'ca1|chat'), JSON.stringify({ text: 'hi 世界' }));
  assert.equal(ca.open(key, sealed, 'ca1|status'), null);
  const bytes = ca.fromB64url(sealed);
  bytes[bytes.length - 1] ^= 1;
  assert.equal(ca.open(key, ca.b64url(bytes), 'ca1|chat'), null);
  assert.equal(ca.open('not-a-key', sealed, 'ca1|chat'), null);
});

test('HMAC room credentials are derived per topic and never leak the root', () => {
  const ca = require('../../app/core/crypto');
  const root = ca.b64url(require('crypto').randomBytes(32));
  const relay = ca.hmac(root, 'relay-room');
  const backup = ca.hmac(root, 'backup-room');
  assert.ok(/^[a-f0-9]{64}$/.test(relay));
  assert.ok(relay !== backup);
  assert.ok(!relay.includes(root));
});
