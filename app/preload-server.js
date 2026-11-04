'use strict';
/* Preload for the private-server assistant window. Deliberately minimal. */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);
const on = (channel, cb) => {
  const handler = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('caServer', {
  platform: (typeof process !== 'undefined' && process.platform) || 'darwin',
  snapshot: () => invoke('ca:server-window-snapshot'),
  set: (patch) => invoke('ca:server-set', patch || {}),
  test: (url, insecure) => invoke('ca:server-test', { url, insecure }),
  localStart: (port) => invoke('ca:server-local-start', { port }),
  localStop: () => invoke('ca:server-local-stop'),
  backupNow: () => invoke('ca:backup-now'),
  backupStatus: () => invoke('ca:backup-status'),
  backupList: () => invoke('ca:backup-list'),
  backupRestore: () => invoke('ca:backup-restore'),
  setLang: (lang) => invoke('ca:set-lang', { lang }),
  copy: (text) => invoke('ca:copy', { text }),
  openExternal: (url) => invoke('ca:open-external', { url }),
  close: () => invoke('ca:server-window-close'),
  onEvent: (cb) => on('ca:event', cb),
});
