import { contextBridge, ipcRenderer } from 'electron';
import { BRIDGE_VERSION, CHANNELS, type PlayDeckBridge } from '../shared/bridge';

const bridge: PlayDeckBridge = {
  version: BRIDGE_VERSION,
  getAppInfo: () => ipcRenderer.invoke(CHANNELS.appInfo),
  readSettings: () => ipcRenderer.invoke(CHANNELS.readSettings),
  writeSettings: (settings) => ipcRenderer.invoke(CHANNELS.writeSettings, settings),
  readCredentials: () => ipcRenderer.invoke(CHANNELS.readCredentials),
  writeCredentials: (credentials) => ipcRenderer.invoke(CHANNELS.writeCredentials, credentials),
  readCache: () => ipcRenderer.invoke(CHANNELS.readCache),
  writeCache: (cache) => ipcRenderer.invoke(CHANNELS.writeCache, cache),
  quit: () => ipcRenderer.send(CHANNELS.quit),
};

contextBridge.exposeInMainWorld('playdeck', bridge);
