'use strict';

const { app, BrowserWindow } = require('electron');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const env = process.env;
const DEV_ROOT = env.PLAYDECK_DEV_ROOT;
const LOG_DIR = env.PLAYDECK_LOG_DIR;
const CYCLES = Number(env.S1_CYCLES || 20);
const PLAY_SECONDS = Number(env.S1_PLAY_SECONDS || 10);
const START_SECONDS = Number(env.S1_START_SECONDS || 600);
const SETTLE_MS = 3000;
const STEAM_APP_ID = 769;
const SOCKET_PATH = path.join(DEV_ROOT, 'run', 'mpv.sock');
const MEDIA_URL = `${env.PLEX_URL.replace(/\/$/, '')}${env.S1_PART_KEY}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message) {
  fs.appendFileSync(path.join(LOG_DIR, 's1.log'), `${new Date().toISOString()} ${message}\n`);
}

// Focus state is published on the root window of Steam's Xwayland (:0), not the app's.
function gamescopeFocus() {
  const out = execFileSync('xprop', ['-display', ':0', '-root', 'GAMESCOPE_FOCUSED_WINDOW', 'GAMESCOPE_FOCUSED_APP'], {
    encoding: 'utf8',
  });
  const read = (name) => Number((out.match(new RegExp(`${name}\\(CARDINAL\\) = (\\d+)`)) || [])[1] || 0);
  return { window: read('GAMESCOPE_FOCUSED_WINDOW'), app: read('GAMESCOPE_FOCUSED_APP') };
}

class MpvIpc {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.observers = new Map();
    let buffer = '';
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        this.dispatch(JSON.parse(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
      }
    });
    socket.on('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('mpv IPC closed'));
      this.pending.clear();
    });
  }

  static async connect(socketPath, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const socket = await new Promise((resolve, reject) => {
          const candidate = net.createConnection(socketPath, () => resolve(candidate));
          candidate.once('error', reject);
        });
        socket.setEncoding('utf8');
        return new MpvIpc(socket);
      } catch {
        await sleep(100);
      }
    }
    throw new Error(`mpv IPC socket not available after ${timeoutMs} ms`);
  }

  dispatch(message) {
    if (message.request_id !== undefined && this.pending.has(message.request_id)) {
      const { resolve, reject } = this.pending.get(message.request_id);
      this.pending.delete(message.request_id);
      if (message.error === 'success') resolve(message.data);
      else reject(new Error(message.error));
    } else if (message.event === 'property-change') {
      this.observers.get(message.name)?.(message.data);
    }
  }

  command(...args) {
    const request_id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(request_id, { resolve, reject });
      this.socket.write(`${JSON.stringify({ command: args, request_id })}\n`);
    });
  }

  get(name) {
    return this.command('get_property', name).catch(() => null);
  }

  observe(name, callback) {
    this.observers.set(name, callback);
    return this.command('observe_property', this.nextId, name);
  }

  close() {
    this.socket.destroy();
  }
}

function spawnMpv(cycle) {
  fs.rmSync(SOCKET_PATH, { force: true });
  const stderr = fs.openSync(path.join(LOG_DIR, `mpv-${cycle}.stderr.log`), 'a');
  const child = spawn(
    'flatpak',
    [
      'run',
      'io.mpv.Mpv',
      '--no-config',
      `--include=${path.join(DEV_ROOT, 'secrets', 'mpv-plex.conf')}`,
      '--fs',
      '--vo=gpu-next',
      '--gpu-api=vulkan',
      '--target-colorspace-hint=yes',
      '--hwdec=vaapi',
      '--cache=yes',
      '--demuxer-max-bytes=400MiB',
      `--start=${START_SECONDS}`,
      `--length=${PLAY_SECONDS}`,
      `--input-ipc-server=${SOCKET_PATH}`,
      `--log-file=${path.join(LOG_DIR, `mpv-${cycle}.log`)}`,
      '--msg-level=all=info,vo=v',
      MEDIA_URL,
    ],
    { stdio: ['ignore', stderr, stderr] },
  );
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => {
      fs.closeSync(stderr);
      resolve({ code, signal });
    }),
  );
  return { child, exited };
}

async function runCycle(win, electronXid, cycle, setStatus) {
  const result = { cycle, electronXid };

  setStatus(`cycle ${cycle}/${CYCLES}: browsing`);
  await sleep(SETTLE_MS);
  result.beforeFocus = gamescopeFocus();
  result.uiFocusedBefore = result.beforeFocus.window === electronXid;

  setStatus(`cycle ${cycle}/${CYCLES}: starting mpv`);
  const startedAt = Date.now();
  const { exited } = spawnMpv(cycle);
  let mpv;
  try {
    mpv = await MpvIpc.connect(SOCKET_PATH, 20000);
    const configured = new Promise((resolve) => mpv.observe('vo-configured', (value) => value && resolve()));
    const exitedEarly = exited.then(() => {
      throw new Error('mpv exited before configuring its VO');
    });
    exitedEarly.catch(() => {});
    await Promise.race([configured, exitedEarly]);
    result.voConfiguredMs = Date.now() - startedAt;

    win.hide();
    await sleep(SETTLE_MS);
    result.mpvXid = Number((await mpv.get('window-id')) || 0);
    result.playingFocus = gamescopeFocus();
    result.mpvFocused = result.playingFocus.window !== 0 && result.playingFocus.window === result.mpvXid;
    result.targetParams = await mpv.get('video-target-params');
    result.hwdec = await mpv.get('hwdec-current');
    result.droppedFrames = await mpv.get('frame-drop-count');
  } catch (error) {
    result.error = error.message;
  } finally {
    mpv?.close();
  }

  result.mpvExit = await exited;
  win.show();
  win.focus();
  setStatus(`cycle ${cycle}/${CYCLES}: returned`);
  await sleep(SETTLE_MS);
  result.afterFocus = gamescopeFocus();
  result.uiFocusedAfter = result.afterFocus.window === electronXid;

  result.steamUiFocused = [result.beforeFocus, result.playingFocus, result.afterFocus].some(
    (focus) => focus?.app === STEAM_APP_ID,
  );
  result.hdrTarget = result.targetParams?.gamma === 'pq' && result.targetParams?.primaries === 'bt.2020';
  result.pass = !result.error && result.uiFocusedBefore && result.mpvFocused && result.hdrTarget && result.uiFocusedAfter;
  log(JSON.stringify(result));
  return result;
}

async function main() {
  fs.mkdirSync(path.dirname(SOCKET_PATH), { recursive: true });
  const win = new BrowserWindow({ fullscreen: true, frame: false, backgroundColor: '#101014', show: true });
  await win.loadURL(
    'data:text/html,' +
      encodeURIComponent(
        '<body style="margin:0;background:#101014;color:#eee;font:48px system-ui;display:grid;place-items:center;height:100vh">' +
          '<div><div style="opacity:.6;font-size:28px">PlayDeck spike S1 — window handoff</div><div id="s">starting</div></div></body>',
      ),
  );
  const setStatus = (text) =>
    win.webContents.executeJavaScript(`document.getElementById('s').textContent = ${JSON.stringify(text)}`).catch(() => {});
  const handle = win.getNativeWindowHandle();
  const electronXid = handle.length >= 8 ? Number(handle.readBigUInt64LE(0)) : handle.readUInt32LE(0);
  log(`electron xid=${electronXid} cycles=${CYCLES} play=${PLAY_SECONDS}s start=${START_SECONDS}s`);

  const results = [];
  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    results.push(await runCycle(win, electronXid, cycle, setStatus));
  }

  const passed = results.filter((r) => r.pass).length;
  const steamUiInterrupted = results.filter((r) => !r.pass && r.steamUiFocused).length;
  const summary = { passed, steamUiInterrupted, total: results.length, results };
  fs.writeFileSync(path.join(LOG_DIR, 's1-summary.json'), JSON.stringify(summary, null, 2));
  log(`done: ${passed}/${results.length} passed`);
  setStatus(`done: ${passed}/${results.length} passed`);
  await sleep(10000);
  app.quit();
}

process.on('unhandledRejection', (error) => log(`unhandled rejection: ${error?.stack || error}`));

app.whenReady().then(() =>
  main().catch((error) => {
    log(`fatal: ${error.stack}`);
    app.exit(1);
  }),
);
