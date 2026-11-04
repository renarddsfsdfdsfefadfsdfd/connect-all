'use strict';
/*
 * Secret storage. The desktop shell injects an encryptor backed by the OS
 * keychain (Electron safeStorage); tests inject a deterministic fake.
 * Values are stored encrypted-at-rest in secrets.json, never in config.json.
 */

const fs = require('fs');
const path = require('path');
const { ensureDir, readJsonSafe, writeJsonAtomic } = require('./store');

function createSecretStore({ file, encryptor, logger = () => {} }) {
  let data = readJsonSafe(file, {}) || {};
  if (typeof data !== 'object' || Array.isArray(data)) data = {};
  let saved = JSON.stringify(data);

  function save() {
    ensureDir(path.dirname(file));
    writeJsonAtomic(file, data);
    saved = JSON.stringify(data);
  }

  return {
    available() {
      try {
        return Boolean(encryptor && encryptor.available && encryptor.available());
      } catch (_) {
        return false;
      }
    },
    get(key) {
      const rec = data[key];
      if (!rec) return null;
      try {
        if (rec.enc) {
          if (!encryptor || !encryptor.available()) {
            logger('warn', 'secret is encrypted but OS keychain is unavailable: ' + key);
            return null;
          }
          const value = encryptor.decrypt(rec.v);
          return typeof value === 'string' ? value : null;
        }
        return typeof rec.v === 'string' ? rec.v : null;
      } catch (err) {
        logger('warn', 'failed to decrypt secret ' + key + ': ' + err.message);
        return null;
      }
    },
    has(key) {
      return Boolean(data[key]);
    },
    set(key, value) {
      if (value === null || value === undefined || value === '') {
        delete data[key];
        save();
        return;
      }
      const canEnc = Boolean(encryptor && encryptor.available && encryptor.available());
      let rec;
      if (canEnc) {
        rec = { enc: true, v: encryptor.encrypt(String(value)) };
      } else {
        rec = { enc: false, v: String(value) };
        logger('warn', 'OS keychain unavailable — storing secret without OS encryption: ' + key);
      }
      data[key] = rec;
      save();
    },
    delete(key) {
      delete data[key];
      save();
    },
    hints() {
      const out = {};
      for (const key of Object.keys(data)) {
        out[key] = { enc: Boolean(data[key] && data[key].enc) };
      }
      return out;
    },
  };
}

module.exports = { createSecretStore };
