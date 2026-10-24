import { contextBridge, ipcRenderer, webFrame } from 'electron';
import { BRIDGE_VERSION, CHANNELS, type PlayDeckBridge, type PlayerEvent } from '../shared/bridge';

const bridge: PlayDeckBridge = {
  version: BRIDGE_VERSION,
  getAppInfo: () => ipcRenderer.invoke(CHANNELS.appInfo),
  readSettings: () => ipcRenderer.invoke(CHANNELS.readSettings),
  writeSettings: (settings) => ipcRenderer.invoke(CHANNELS.writeSettings, settings),
  readCredentials: () => ipcRenderer.invoke(CHANNELS.readCredentials),
  writeCredentials: (credentials) => ipcRenderer.invoke(CHANNELS.writeCredentials, credentials),
  readCache: () => ipcRenderer.invoke(CHANNELS.readCache),
  writeCache: (cache) => ipcRenderer.invoke(CHANNELS.writeCache, cache),
  setUiScale: (scale) => {
    webFrame.setZoomFactor(Math.max(0.9, Math.min(1.5, scale / 100)));
    window.dispatchEvent(new Event('resize'));
  },
  quit: () => ipcRenderer.send(CHANNELS.quit),
  player: {
    start: (session, options) => ipcRenderer.invoke(CHANNELS.playerStart, session, options),
    next: (session) => ipcRenderer.invoke(CHANNELS.playerNext, session),
    stop: () => ipcRenderer.send(CHANNELS.playerStop),
    onEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, value: PlayerEvent) => listener(value);
      ipcRenderer.on(CHANNELS.playerEvent, handler);
      return () => {
        ipcRenderer.removeListener(CHANNELS.playerEvent, handler);
      };
    },
  },
};

contextBridge.exposeInMainWorld('playdeck', bridge);
