'use strict';
/* Preload for the floating calendar widget. Read-only data + pin/close. */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);
const on = (channel, cb) => {
  const handler = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('caWidget', {
  platform: (typeof process !== 'undefined' && process.platform) || 'darwin',
  state: () => invoke('ca:widget-state'),
  pin: (pinned) => invoke('ca:widget-pin', { pinned }),
  close: () => invoke('ca:widget-close'),
  openMain: () => invoke('ca:widget-open-main'),
  onState: (cb) => on('ca:widget', cb),
});
