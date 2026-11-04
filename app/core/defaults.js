'use strict';

/**
 * Default configuration. Every user-visible knob lives here so it can be
 * inspected/edited from Settings and exported for support.
 */
const DEFAULT_CONFIG = {
  version: 1,
  lang: 'zh', // zh | en  (first launch: follows system locale)
  firstRun: true,
  device: {},
  peer: null,
  server: {
    url: '', // e.g. https://ca.example.com or http://192.0.2.10:8787 (RFC 5737 example)
    insecure: false, // accept self-signed TLS (explicit opt-in)
    autoConnect: true,
    autoBackup: true,
    backupIntervalMin: 60,
    lastBackupAt: 0,
    lastBackupBytes: 0,
    lastBackupError: '',
    localRelay: {
      enabled: false,
      port: 8787,
      running: false,
    },
  },
  transport: {
    mode: 'auto', // auto | relay | lan | offline
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    turn: { url: '', username: '', password: '' },
  },
  video: {
    quality: 'auto', // auto | saver | hd
    splitRatio: 0.2, // 1:4 default -> side strip is 20% wide
    stripSide: 'left',
    cameraId: '',
    micId: '',
    mirrorSelf: true,
    startAudioOnly: false,
  },
  ci: {
    enabled: false, // opt-in only, as specified
    provider: 'deepseek', // deepseek | doubao
    baseUrl: '',
    model: 'deepseek-chat',
    intervalMin: 60,
    retentionDays: 90,
    lang: 'auto', // auto | zh | en
    notify: true,
    includeCalendar: true,
    includeStatus: false,
    customPrompt: '',
    lastRunAt: 0,
    lastRunWindow: null,
    lastError: '',
  },
  calendar: {
    sources: [], // {id,name,kind:'ics-file'|'ics-url'|'ics-paste',path,url,color,enabled,lastSyncAt,error}
    share: true,
    hidePrivate: true,
    widget: {
      visible: false,
      pinned: true,
      x: null,
      y: null,
      width: 320,
      height: 226,
      opacity: 0.98,
      showPartner: true,
    },
  },
  status: {
    sharePlace: true,
    manualPlace: '',
    manualState: '', // '' | focus | away
    shareBoot: true,
  },
  notify: {
    messages: true,
    presence: true,
    ci: true,
    quietHours: { enabled: false, from: '23:30', to: '07:30' },
  },
  ui: {
    window: { width: 1180, height: 760, x: null, y: null, maximized: false },
    activeApp: 'chat',
    soundOn: true,
  },
  privacy: {
    chatRetentionDays: 0, // 0 = keep forever
    ciMemoryLocalOnly: true,
  },
};

module.exports = { DEFAULT_CONFIG };
