'use strict';

const { app, BrowserWindow, ipcMain, net, protocol } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const env = process.env;
const DIST = path.join(__dirname, '..', 'dist');
const LOG_DIR = env.PLAYDECK_LOG_DIR || path.join(__dirname, '..', 'logs');
const SECRETS = path.join(env.PLAYDECK_DEV_ROOT || '', 'secrets', 'mpv-plex.conf');

protocol.registerSchemesAsPrivileged([
  { scheme: 'playdeck', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(path.join(LOG_DIR, 's5.log'), `${new Date().toISOString()} ${message}\n`);
}

function refreshHz() {
  try {
    const match = execFileSync('xrandr', ['--current'], { encoding: 'utf8' }).match(/(\d+\.\d+)\*/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function playdeckConfig() {
  const token = (fs.readFileSync(SECRETS, 'utf8').match(/X-Plex-Token:\s*(\S+)/) || [])[1];
  return { baseUrl: env.PLEX_URL.replace(/\/$/, ''), token, refreshHz: refreshHz() };
}

function serveDist(request) {
  const { pathname } = new URL(request.url);
  const file = path.normalize(path.join(DIST, decodeURIComponent(pathname)));
  if (!file.startsWith(DIST)) return new Response('forbidden', { status: 403 });
  return net.fetch(pathToFileURL(file).toString());
}

// Steps are [key, delayAfterMs]. Keys are Electron accelerator key codes.
function repeat(key, count, delay) {
  return Array.from({ length: count }, () => [key, delay]);
}

const SCRIPT = [
  {
    phase: 'home-rows',
    steps: [
      ...repeat('Right', 29, 120), ['Down', 300],
      ...repeat('Left', 29, 120), ['Down', 300],
      ...repeat('Right', 29, 120), ['Down', 300],
      ...repeat('Left', 29, 120), ['Down', 300],
      ...repeat('Right', 29, 120), ['Down', 300],
      ...repeat('Up', 5, 150),
    ],
  },
  { phase: 'page-transition', steps: [[']', 1500], ['[', 1500], [']', 1500], ['[', 1500], [']', 1500]] },
  {
    phase: 'grid-scroll',
    steps: [
      ...repeat('Down', 150, 100),
      ...repeat('Right', 6, 120), ...repeat('Left', 6, 120),
      ...repeat('Up', 60, 80),
    ],
  },
  { phase: 'grid-to-home', steps: [['[', 1200], ...repeat('Right', 12, 120), ['Down', 300], ...repeat('Right', 12, 120)] },
];

// CLOCK_MONOTONIC timestamps, comparable with the gamescope present sampler.
const keyLog = [];

function press(win, phase, keyCode) {
  keyLog.push({ phase, key: keyCode, ns: process.hrtime.bigint().toString() });
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
}

async function runHarness(win) {
  const send = (message) => win.webContents.send('harness', message);
  await sleep(3000);
  send({ type: 'start' });
  for (const { phase, steps } of SCRIPT) {
    send({ type: 'phase', phase });
    for (const [key, delay] of steps) {
      press(win, phase, key);
      await sleep(delay);
    }
  }
  await sleep(1000);
  send({ type: 'stop' });
  fs.writeFileSync(path.join(LOG_DIR, 's5-keys.json'), JSON.stringify(keyLog));
}

async function main() {
  protocol.handle('playdeck', serveDist);
  ipcMain.handle('playdeck:config', () => playdeckConfig());

  const win = new BrowserWindow({
    fullscreen: true,
    frame: false,
    backgroundColor: '#0b0b0f',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });

  const resultPromise = new Promise((resolve) => ipcMain.once('harness:result', (_event, result) => resolve(result)));
  ipcMain.once('harness:ready', () => {
    if (env.S5_MANUAL) return;
    runHarness(win).catch((error) => log(`harness failed: ${error.stack}`));
  });
  win.webContents.on('console-message', (event) => log(`console: ${event.message}`));

  await win.loadURL('playdeck://app/index.html');
  if (env.S5_MANUAL) return;

  const result = await resultPromise;
  const summary = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    flags: env.S5_CHROMIUM_FLAGS || '',
    gpuFeatureStatus: app.getGPUFeatureStatus(),
    gpuInfo: await app.getGPUInfo('basic'),
    ...result,
  };
  fs.writeFileSync(path.join(LOG_DIR, 's5-summary.json'), JSON.stringify(summary, null, 2));
  log(`done: ${JSON.stringify(result.overall)}`);
  await sleep(3000);
  app.quit();
}

process.on('unhandledRejection', (error) => log(`unhandled rejection: ${error?.stack || error}`));

app.whenReady().then(() =>
  main().catch((error) => {
    log(`fatal: ${error.stack}`);
    app.exit(1);
  }),
);
