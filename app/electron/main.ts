import { app, BrowserWindow, ipcMain, net, protocol } from 'electron';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type AppCache,
  type AppInfo,
  type Credentials,
  type Settings,
  CHANNELS,
  DEFAULT_CACHE,
  DEFAULT_SETTINGS,
} from '../shared/bridge';
import { startDevControl } from './devControl';
import { JsonFile, loadClientIdentifier } from './storage';

const RENDERER_DIR = path.join(__dirname, '..', 'dist');
const SCHEME = 'playdeck';
const IN_GAMESCOPE = Boolean(process.env.GAMESCOPE_WAYLAND_DISPLAY);

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);
app.setName('PlayDeck');

function serveRenderer(request: Request): Promise<Response> | Response {
  const { pathname } = new URL(request.url);
  const file = path.normalize(path.join(RENDERER_DIR, decodeURIComponent(pathname)));
  if (!file.startsWith(RENDERER_DIR + path.sep)) return new Response('forbidden', { status: 403 });
  return net.fetch(pathToFileURL(file).toString());
}

function deviceName(): string {
  try {
    const product = readFileSync('/sys/devices/virtual/dmi/id/product_name', 'utf8').trim();
    if (product === 'Galileo') return 'Steam Deck OLED';
    if (product === 'Jupiter') return 'Steam Deck';
    return product || os.type();
  } catch {
    return os.type();
  }
}

async function registerBridge(): Promise<void> {
  const dataDir = app.getPath('userData');
  const settings = new JsonFile<Settings>(path.join(dataDir, 'settings.json'), DEFAULT_SETTINGS);
  const credentials = new JsonFile<Credentials>(path.join(dataDir, 'credentials.json'), {}, 0o600);
  const cache = new JsonFile<AppCache>(path.join(dataDir, 'cache.json'), DEFAULT_CACHE);
  const appInfo: AppInfo = {
    version: app.getVersion(),
    platform: 'Linux',
    platformVersion: os.release(),
    device: deviceName(),
    deviceName: os.hostname(),
    clientIdentifier: await loadClientIdentifier(dataDir),
    locale: app.getLocale(),
  };

  ipcMain.handle(CHANNELS.appInfo, () => appInfo);
  ipcMain.handle(CHANNELS.readSettings, () => settings.read());
  ipcMain.handle(CHANNELS.writeSettings, (_event, value: Settings) => settings.write(value));
  ipcMain.handle(CHANNELS.readCredentials, () => credentials.read());
  ipcMain.handle(CHANNELS.writeCredentials, (_event, value: Credentials) => credentials.write(value));
  ipcMain.handle(CHANNELS.readCache, () => cache.read());
  ipcMain.handle(CHANNELS.writeCache, (_event, value: AppCache) => cache.write(value));
  ipcMain.on(CHANNELS.quit, () => app.quit());
}

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    fullscreen: IN_GAMESCOPE,
    frame: !IN_GAMESCOPE,
    backgroundColor: '#0b0b0f',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  await win.loadURL(`${SCHEME}://app/index.html`);
  return win;
}

async function main(): Promise<void> {
  protocol.handle(SCHEME, serveRenderer);
  await registerBridge();
  const win = await createWindow();
  if (process.env.PLAYDECK_DEV_CONTROL) await startDevControl(process.env.PLAYDECK_DEV_CONTROL, win);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(main, (error: unknown) => {
    console.error(error);
    app.exit(1);
  });
}
