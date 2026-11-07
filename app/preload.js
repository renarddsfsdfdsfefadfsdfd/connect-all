'use strict';
/*
 * Preload for the main window. Only an explicit, minimal API is exposed to the
 * renderer: no Node, no ipcRenderer, no filesystem.
 */

const { contextBridge, ipcRenderer } = require('electron');

const params = new URLSearchParams(location.search);
const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);
const on = (channel, cb) => {
  const handler = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

const platform =
  (typeof process !== 'undefined' && process.platform) ||
  (navigator.userAgent.includes('Mac') ? 'darwin' : navigator.userAgent.includes('Win') ? 'win32' : 'linux');

contextBridge.exposeInMainWorld('ca', {
  env: {
    platform,
    activeApp: params.get('app') || '',
    langOverride: params.get('lang') || '',
  },
  onEvent: (cb) => on('ca:event', cb),
  snapshot: () => invoke('ca:snapshot'),
  setLang: (lang) => invoke('ca:set-lang', { lang }),
  reload: () => invoke('ca:reload-window'),
  quit: () => invoke('ca:quit'),
  about: () => invoke('ca:about'),
  openExternal: (url) => invoke('ca:open-external', { url }),
  networkInfo: () => invoke('ca:network-info'),
  copy: (text) => invoke('ca:copy', { text }),
  openPath: (target) => invoke('ca:open-path', { target }),

  chat: {
    send: (text) => invoke('ca:chat-send', { text }),
    list: (opts) => invoke('ca:chat-list', opts || {}),
    markRead: () => invoke('ca:chat-read'),
    typing: (typing) => invoke('ca:chat-typing', { typing: Boolean(typing) }),
    search: (query) => invoke('ca:chat-search', { query }),
    clear: () => invoke('ca:chat-clear'),
    export: () => invoke('ca:chat-export'),
  },

  presence: {
    set: (patch) => invoke('ca:presence-set', patch || {}),
    tick: () => invoke('ca:presence-tick'),
  },

  pairing: {
    status: () => invoke('ca:pairing-status'),
    start: (code) => invoke('ca:pairing-start', { code }),
    createInvite: () => invoke('ca:pairing-create-invite'),
    acceptInvite: (text) => invoke('ca:pairing-accept-invite', { text }),
    acceptReply: (text) => invoke('ca:pairing-accept-reply', { text }),
    confirm: () => invoke('ca:pairing-confirm'),
    cancel: () => invoke('ca:pairing-cancel'),
    unpair: () => invoke('ca:pairing-unpair'),
  },

  server: {
    info: () => invoke('ca:server-info'),
    set: (patch) => invoke('ca:server-set', patch || {}),
    test: (url, insecure) => invoke('ca:server-test', { url, insecure }),
    localStart: (port) => invoke('ca:server-local-start', { port }),
    localStop: () => invoke('ca:server-local-stop'),
    backupNow: () => invoke('ca:backup-now'),
    backupStatus: () => invoke('ca:backup-status'),
    backupList: () => invoke('ca:backup-list'),
    backupRestore: () => invoke('ca:backup-restore'),
  },

  calendar: {
    importFile: () => invoke('ca:calendar-import-file'),
    importUrl: (url, name) => invoke('ca:calendar-import-url', { url, name }),
    importText: (text, name) => invoke('ca:calendar-import-text', { text, name }),
    remove: (id) => invoke('ca:calendar-remove', { id }),
    toggle: (id, enabled) => invoke('ca:calendar-toggle', { id, enabled }),
    refresh: (id) => invoke('ca:calendar-refresh', { id }),
    events: (from, to) => invoke('ca:calendar-events', { from, to }),
    share: (enabled) => invoke('ca:calendar-share', { enabled }),
    hidePrivate: (hide) => invoke('ca:calendar-hide-private', { hide }),
    requestShare: () => invoke('ca:calendar-request-share'),
    setWidget: (patch) => invoke('ca:calendar-widget-set', patch || {}),
  },

  widget: {
    show: () => invoke('ca:widget-show'),
    hide: () => invoke('ca:widget-hide'),
    toggle: () => invoke('ca:widget-toggle'),
  },

  ci: {
    config: () => invoke('ca:ci-config'),
    configure: (patch) => invoke('ca:ci-configure', patch || {}),
    status: () => invoke('ca:ci-status'),
    run: () => invoke('ca:ci-run'),
    list: (opts) => invoke('ca:ci-list', opts || {}),
    remove: (id) => invoke('ca:ci-delete', { id }),
    clear: () => invoke('ca:ci-clear'),
    export: () => invoke('ca:ci-export'),
    test: (patch) => invoke('ca:ci-test', patch || {}),
  },

  video: {
    sources: () => invoke('ca:video-sources'),
    setSource: (id) => invoke('ca:video-set-source', { id }),
    ice: () => invoke('ca:video-ice'),
    pickAudio: () => invoke('ca:video-pick-file'),
    mediaAccess: () => invoke('ca:media-access'),
    openPrivacySettings: (kind) => invoke('ca:open-media-settings', { kind }),
    signal: (payload) => invoke('ca:rtc-signal', payload),
    mediaSync: (payload) => invoke('ca:rtc-media', payload),
  },

  settings: {
    setDevice: (name) => invoke('ca:set-device', { name }),
    setVideo: (patch) => invoke('ca:set-video', patch || {}),
    setNotify: (patch) => invoke('ca:set-notify', patch || {}),
    setPrivacy: (patch) => invoke('ca:set-privacy', patch || {}),
    setTransport: (patch) => invoke('ca:set-transport', patch || {}),
    setActivity: (patch) => invoke('ca:set-activity', patch || {}),
    dataStats: () => invoke('ca:data-stats'),
    loginItemGet: () => invoke('ca:login-item-get'),
    loginItemSet: (enabled) => invoke('ca:login-item-set', { enabled: Boolean(enabled) }),
  },

  window: {
    openServer: () => invoke('ca:window-server'),
    minimize: () => invoke('ca:window-minimize'),
    close: () => invoke('ca:window-close'),
    show: () => invoke('ca:window-show'),
  },
});
