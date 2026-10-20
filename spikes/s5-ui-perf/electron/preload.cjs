'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('playdeck', {
  getConfig: () => ipcRenderer.invoke('playdeck:config'),
  ready: () => ipcRenderer.send('harness:ready'),
  onHarness: (callback) => ipcRenderer.on('harness', (_event, message) => callback(message)),
  reportResult: (result) => ipcRenderer.send('harness:result', result),
});
