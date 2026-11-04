'use strict';
/*
 * Device identity + the couple pair.
 *
 * One secret (the pair root) lives in the OS keychain; every subkey is derived
 * from it on demand. Nothing about the pair is stored on any server.
 */

const os = require('os');
const crypto = require('crypto');
const ca = require('./crypto');

function defaultDeviceName() {
  const host = os.hostname().replace(/\.local$/i, '');
  return host || 'Connect All';
}

function platformLabel() {
  switch (process.platform) {
    case 'darwin':
      return 'macOS';
    case 'win32':
      return 'Windows';
    case 'linux':
      return 'Linux';
    default:
      return process.platform;
  }
}

class Identity {
  constructor({ store, secrets, logger = () => {}, deviceName }) {
    this.store = store;
    this.secrets = secrets;
    this.logger = logger;
    this._deviceName = deviceName || null;
    this._keys = null;
    this.init();
  }

  init() {
    const data = this.store.get();
    if (!data.device) data.device = {};
    const device = data.device;
    let changed = false;
    if (!device.id) {
      device.id = crypto.randomBytes(6).toString('hex');
      changed = true;
    }
    if (!device.name) {
      device.name = this._deviceName || defaultDeviceName();
      changed = true;
    }
    if (!device.platform) {
      device.platform = platformLabel();
      changed = true;
    }
    if (!device.publicKey || !this.secrets.has('device.privateKey')) {
      const kp = ca.generateIdentityKeyPair();
      device.publicKey = kp.publicKey;
      this.secrets.set('device.privateKey', kp.privateKey);
      changed = true;
    }
    if (!device.createdAt) {
      device.createdAt = Date.now();
      changed = true;
    }
    if (changed) this.store.saveSoon(0);
    this.device = device;
  }

  get publicKey() {
    return this.device.publicKey;
  }

  get id() {
    return this.device.id;
  }

  get name() {
    return this.device.name;
  }

  get platform() {
    return this.device.platform;
  }

  privateKey() {
    return this.secrets.get('device.privateKey');
  }

  get peer() {
    const peer = this.store.get().peer;
    return peer && peer.id && peer.rootKeyRef !== false ? peer : null;
  }

  get isPaired() {
    return Boolean(this.peer && this.secrets.has('peer.rootKey'));
  }

  /** Derive keys with a peer public key, without persisting anything. */
  deriveWith(peer) {
    const priv = this.privateKey();
    if (!priv) throw new Error('device private key missing');
    const derived = ca.deriveKeys(priv, this.publicKey, peer.publicKey, this.id, peer.id);
    return derived;
  }

  /** Persist a completed pairing. */
  completePairing(peer, { serverUrl } = {}) {
    const derived = this.deriveWith(peer);
    this.secrets.set('peer.rootKey', derived.root);
    this.store.update({
      peer: {
        id: peer.id,
        name: peer.name || 'Partner',
        platform: peer.platform || '',
        publicKey: peer.publicKey,
        sas: ca.sasFromRoot(derived.root),
        shortId: ca.shortId(derived.root),
        pairedAt: Date.now(),
        serverUrl: serverUrl || '',
        transportMode: 'auto',
      },
    });
    this._keys = derived.keys;
    return { peer: this.store.get().peer, keys: derived.keys };
  }

  /** Called at boot: re-derive subkeys from the stored root. */
  loadKeys() {
    if (this._keys) return this._keys;
    const peer = this.peer;
    const root = this.secrets.get('peer.rootKey');
    if (!peer || !root) return null;
    const derived = ca.importRoot(root, this.id, peer.id);
    this._keys = derived.keys;
    return this._keys;
  }

  keys() {
    return this.loadKeys();
  }

  sas() {
    const root = this.secrets.get('peer.rootKey');
    return root ? ca.sasFromRoot(root) : '';
  }

  shortId() {
    const root = this.secrets.get('peer.rootKey');
    return root ? ca.shortId(root) : '';
  }

  rootKey() {
    return this.secrets.get('peer.rootKey');
  }

  /** Relay room + token derived from the pair root; the server never sees the root. */
  relayCredentials() {
    const root = this.rootKey();
    if (!root) return null;
    return {
      room: ca.hmac(root, 'relay-room').slice(0, 40),
      token: ca.hmac(root, 'relay-token').slice(0, 40),
    };
  }

  lanTag() {
    const root = this.rootKey();
    return root ? ca.hmac(root, 'lan-tag').slice(0, 24) : '';
  }

  backupCredentials() {
    const root = this.rootKey();
    if (!root) return null;
    return {
      room: ca.hmac(root, 'backup-room').slice(0, 40),
      token: ca.hmac(root, 'backup-token').slice(0, 40),
    };
  }

  unpair() {
    this.secrets.delete('peer.rootKey');
    this._keys = null;
    this.store.update({ peer: null });
  }

  updatePeer(patch) {
    const peer = this.store.get().peer;
    if (!peer) return null;
    Object.assign(peer, patch);
    this.store.saveSoon();
    return peer;
  }

  roster() {
    const peer = this.peer;
    return {
      me: {
        id: this.id,
        name: this.name,
        platform: this.platform,
        publicKey: this.publicKey,
      },
      peer: peer
        ? {
            id: peer.id,
            name: peer.name,
            platform: peer.platform,
            sas: peer.sas,
            shortId: peer.shortId,
            pairedAt: peer.pairedAt,
            lastSeenAt: peer.lastSeenAt || 0,
          }
        : null,
      paired: this.isPaired,
    };
  }
}

module.exports = { Identity, defaultDeviceName, platformLabel };
