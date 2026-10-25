import { app, BrowserWindow, ipcMain, net, protocol } from 'electron';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type AppCache,
  type AppInfo,
  type Credentials,
  type PlayerOptions,
  type PlaySession,
  type Settings,
  type WebDavLibraryConfig,
  type WebDavRequest,
  type WebDavResponse,
  CHANNELS,
  DEFAULT_CACHE,
  DEFAULT_SETTINGS,
} from '../shared/bridge';
import { startDevControl } from './devControl';
import { Player } from './player';
import { JsonFile, loadClientIdentifier, sanitizeSettings } from './storage';

const RENDERER_DIR = path.join(__dirname, '..', 'dist');
const MPV_SCRIPT = path.join(__dirname, '..', 'mpv', 'playdeck.lua');
const SCHEME = 'playdeck';
const IN_GAMESCOPE = Boolean(process.env.GAMESCOPE_WAYLAND_DISPLAY);

declare const __PLAYDECK_VERSION__: string | undefined;

let webdavLibraries: WebDavLibraryConfig[] = [];

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);
app.setName('PlayDeck');
app.setPath('userData', path.join(os.homedir(), '.config', 'PlayDeck'));

function basicAuthHeader(username?: string, password?: string): string | undefined {
  if (!username && !password) return undefined;
  return `Basic ${Buffer.from(`${username ?? ''}:${password ?? ''}`, 'utf8').toString('base64')}`;
}

function serveRenderer(request: Request): Promise<Response> | Response {
  const parsed = new URL(request.url);
  if (parsed.pathname === '/__webdav__') {
    const libId = parsed.searchParams.get('lib');
    const targetUrl = parsed.searchParams.get('url');
    const lib = libId ? webdavLibraries.find((entry) => entry.id === libId) : undefined;
    if (!lib || !targetUrl) return new Response('not found', { status: 404 });
    try {
      const baseOrigin = new URL(lib.baseUrl).origin;
      if (new URL(targetUrl).origin !== baseOrigin) return new Response('forbidden', { status: 403 });
    } catch {
      return new Response('bad request', { status: 400 });
    }
    const headers: Record<string, string> = {};
    const auth = basicAuthHeader(lib.username, lib.password);
    if (auth) headers.Authorization = auth;
    return net.fetch(targetUrl, { headers });
  }
  const { pathname } = parsed;
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
    version: typeof __PLAYDECK_VERSION__ === 'string' ? __PLAYDECK_VERSION__ : app.getVersion(),
    platform: 'Linux',
    platformVersion: os.release(),
    device: deviceName(),
    deviceName: os.hostname(),
    clientIdentifier: await loadClientIdentifier(dataDir),
    locale: app.getLocale(),
  };

  ipcMain.handle(CHANNELS.appInfo, () => appInfo);
  ipcMain.handle(CHANNELS.readSettings, async () => sanitizeSettings(await settings.read()));
  ipcMain.handle(CHANNELS.writeSettings, (_event, value: Settings) => settings.write(sanitizeSettings(value)));
  ipcMain.handle(CHANNELS.readCredentials, async () => {
    const loaded = await credentials.read();
    webdavLibraries = loaded.webdavLibraries ?? [];
    return loaded;
  });
  ipcMain.handle(CHANNELS.writeCredentials, async (_event, value: Credentials) => {
    webdavLibraries = value.webdavLibraries ?? [];
    await credentials.write(value);
  });
  ipcMain.handle(CHANNELS.readCache, () => cache.read());
  ipcMain.handle(CHANNELS.writeCache, (_event, value: AppCache) => cache.write(value));
  ipcMain.handle(CHANNELS.webdavRequest, async (_event, request: WebDavRequest): Promise<WebDavResponse> => {
    const timeout = AbortSignal.timeout(request.timeoutMs ?? 15_000);
    const response = await net.fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: timeout,
    });
    const body = await response.text();
    return { status: response.status, body };
  });
  ipcMain.on(CHANNELS.quit, () => app.quit());
}

/**
 * In the PlayDeck Flatpak, mpv runs in the same sandbox and shares /tmp; in unpacked dev builds
 * outside Flatpak, Flathub mpv runs in its own sandbox and shares PLAYDECK_DEV_ROOT/run.
 */
function createPlayer(win: BrowserWindow): Player {
  const devRoot = process.env.PLAYDECK_DEV_ROOT;
  const player = new Player(win, {
    script: MPV_SCRIPT,
    runDir: devRoot ? path.join(devRoot, 'run') : path.join(os.tmpdir(), `playdeck-${os.userInfo().uid}`),
    logDir: process.env.PLAYDECK_LOG_DIR,
    userConf: path.join(app.getPath('userData'), 'mpv.conf'),
  });
  ipcMain.handle(CHANNELS.playerStart, (_event, session: PlaySession, options: PlayerOptions) => player.start(session, options));
  ipcMain.handle(CHANNELS.playerNext, (_event, session: PlaySession) => player.next(session));
  ipcMain.on(CHANNELS.playerStop, () => player.stop());
  app.on('before-quit', () => player.dispose());
  return player;
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
  // Development builds log to launch.log; the renderer's own console is otherwise out of reach.
  if (process.env.PLAYDECK_LOG_DIR) {
    win.webContents.on('console-message', (details) => {
      if (details.level !== 'debug') console.log(`[renderer ${details.level}] ${details.message}`);
    });
  }
  await win.loadURL(`${SCHEME}://app/index.html`);
  return win;
}

async function main(): Promise<void> {
  protocol.handle(SCHEME, serveRenderer);
  await registerBridge();
  const win = await createWindow();
  const player = createPlayer(win);
  if (process.env.PLAYDECK_DEV_CONTROL) await startDevControl(process.env.PLAYDECK_DEV_CONTROL, win, player);
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
