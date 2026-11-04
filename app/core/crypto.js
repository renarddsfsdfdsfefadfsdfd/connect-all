'use strict';
/*
 * Connect All — cryptography for the couple pair.
 *
 * Design goals:
 *  - No accounts. Two devices derive a shared root with X25519 + HKDF.
 *  - The relay only ever sees ciphertext: every payload is AES-256-GCM sealed
 *    with a subkey derived from the pair root.
 *  - A short numeric SAS is shown on both screens so the humans can verify
 *    there was no man-in-the-middle during the 6-character pairing handshake.
 */

const crypto = require('crypto');

// Crockford base32: generated and typed codes share one canonical alphabet,
// while O->0 and I/L->1 folding makes read-aloud mistakes harmless.
const PAIR_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PAIR_CODE_LENGTH = 6;
const ROOM_TAG = 'connect-all-pair-v1';

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}
function fromB64url(str) {
  return Buffer.from(String(str), 'base64url');
}

function randomBytes(n) {
  return crypto.randomBytes(n);
}

function generatePairingCode() {
  const bytes = crypto.randomBytes(PAIR_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < PAIR_CODE_LENGTH; i++) {
    out += PAIR_ALPHABET[bytes[i] % PAIR_ALPHABET.length];
  }
  return out;
}

function normalizePairingCode(input) {
  const raw = String(input || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  // Crockford-style folding: O -> 0, I/L -> 1, U -> V.
  return raw.replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
}

/** Room id used on the relay; hides the human code from the server operator. */
function pairRoom(code) {
  const normalized = normalizePairingCode(code);
  return crypto.createHmac('sha256', ROOM_TAG).update('room:' + normalized).digest('hex').slice(0, 32);
}

/** Token the client presents to the relay for this pair room. */
function roomToken(code) {
  const normalized = normalizePairingCode(code);
  return crypto.createHmac('sha256', ROOM_TAG).update('token:' + normalized).digest('hex').slice(0, 40);
}

function generateIdentityKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  return { publicKey: pub.x, privateKey: priv.d, publicKeyObject: publicKey, privateKeyObject: privateKey };
}

function publicKeyObject(x) {
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: String(x) }, format: 'jwk' });
}

function privateKeyObject(d, x) {
  return crypto.createPrivateKey({
    key: { kty: 'OKP', crv: 'X25519', x: String(x), d: String(d) },
    format: 'jwk',
  });
}

/**
 * Combine my private key with the peer's public key. Both sides end up with the
 * same 32-byte secret without ever sending it anywhere.
 */
function deriveSharedSecret(myPrivateKeyB64, myPublicKeyB64, peerPublicKeyB64) {
  const priv = privateKeyObject(myPrivateKeyB64, myPublicKeyB64);
  const pub = publicKeyObject(peerPublicKeyB64);
  const shared = crypto.diffieHellman({ privateKey: priv, publicKey: pub });
  return Buffer.from(shared);
}

function deriveKeys(myPrivateKeyB64, myPublicKeyB64, peerPublicKeyB64, myDeviceId, peerDeviceId) {
  const shared = deriveSharedSecret(myPrivateKeyB64, myPublicKeyB64, peerPublicKeyB64);
  // Order-independent salt so both devices derive byte-identical subkeys.
  const ids = [String(myDeviceId), String(peerDeviceId)].sort();
  const salt = Buffer.from('connect-all|' + ids.join('|'), 'utf8');
  const root = Buffer.from(crypto.hkdfSync('sha256', shared, salt, 'connect-all-root', 32));
  const sub = (label) =>
    Buffer.from(crypto.hkdfSync('sha256', root, salt, 'connect-all-' + label, 32));
  return {
    root: b64url(root),
    keys: {
      chat: b64url(sub('chat')),
      memory: b64url(sub('memory')),
      calendar: b64url(sub('calendar')),
      status: b64url(sub('status')),
      signal: b64url(sub('signal')),
      backup: b64url(sub('backup')),
    },
  };
}

function importRoot(rootB64, myDeviceId, peerDeviceId) {
  const ids = [String(myDeviceId), String(peerDeviceId)].sort();
  const salt = Buffer.from('connect-all|' + ids.join('|'), 'utf8');
  const root = fromB64url(rootB64);
  const sub = (label) =>
    Buffer.from(crypto.hkdfSync('sha256', root, salt, 'connect-all-' + label, 32));
  return {
    root: rootB64,
    keys: {
      chat: b64url(sub('chat')),
      memory: b64url(sub('memory')),
      calendar: b64url(sub('calendar')),
      status: b64url(sub('status')),
      signal: b64url(sub('signal')),
      backup: b64url(sub('backup')),
    },
  };
}

/** Numeric short-authentication-string: easy to read aloud in either language. */
function sasFromRoot(rootB64) {
  const root = fromB64url(rootB64);
  const mac = crypto.createHmac('sha256', root).update('connect-all-sas-v1').digest();
  const n = mac.readUIntBE(0, 6) % 100000000;
  const s = String(n).padStart(8, '0');
  return s.slice(0, 4) + ' ' + s.slice(4);
}

function sasDigits(rootB64) {
  return sasFromRoot(rootB64).replace(' ', '');
}

function shortId(rootB64) {
  return fromB64url(rootB64).toString('hex').slice(0, 8).toUpperCase().replace(/(.{4})/, '$1-');
}

function seal(keyB64, plaintext, aad) {
  const key = fromB64url(keyB64);
  if (key.length !== 32) throw new Error('invalid key');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return b64url(Buffer.concat([iv, tag, ct]));
}

function open(keyB64, envelope, aad) {
  try {
    const raw = fromB64url(envelope);
    if (raw.length < 28) return null;
    const key = fromB64url(keyB64);
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    if (aad) decipher.setAAD(Buffer.from(String(aad), 'utf8'));
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch (_) {
    return null;
  }
}

function hmac(keyB64, message) {
  return crypto.createHmac('sha256', fromB64url(keyB64)).update(String(message)).digest('hex');
}

function randomId(bytes = 12) {
  return crypto.randomBytes(bytes).toString('hex');
}

function sha256Hex(str) {
  return crypto.createHash('sha256').update(String(str)).digest('hex');
}

function constantTimeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = {
  PAIR_ALPHABET,
  PAIR_CODE_LENGTH,
  generatePairingCode,
  normalizePairingCode,
  pairRoom,
  roomToken,
  generateIdentityKeyPair,
  deriveKeys,
  deriveSharedSecret,
  importRoot,
  sasFromRoot,
  sasDigits,
  shortId,
  seal,
  open,
  hmac,
  randomId,
  randomBytes,
  sha256Hex,
  constantTimeEqual,
  b64url,
  fromB64url,
};
