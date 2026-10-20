import { type BrowserWindow, contentTracing } from 'electron';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import type { Player } from './player';

type Command =
  | { cmd: 'mpv'; args: unknown[] }
  | { cmd: 'key'; key: string }
  | { cmd: 'keys'; keys: string[]; intervalMs: number }
  | { cmd: 'capture'; path: string }
  | { cmd: 'eval'; js: string }
  | { cmd: 'perf-start' }
  | { cmd: 'perf-stop' }
  | { cmd: 'trace-start' }
  | { cmd: 'trace-stop'; path: string }
  | { cmd: 'clear-cache' };

const TRACE_CATEGORIES = ['devtools.timeline', 'blink', 'cc', 'gpu', 'viz', 'disabled-by-default-devtools.timeline'];

// Injected only on request, so frame recording never ships in the app itself.
const RECORDER = `(() => {
  const times = [];
  let running = true;
  const tick = (time) => { if (!running) return; times.push(time); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  window.__playdeckPerf = { stop() { running = false; return times; } };
})()`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Development-only control socket, enabled by PLAYDECK_DEV_CONTROL=<socket path>. It lets a developer
 * drive the UI and take screenshots over SSH while the app runs in Gaming Mode. Newline-delimited JSON.
 */
export async function startDevControl(socketPath: string, win: BrowserWindow, player: Player): Promise<void> {
  await fs.rm(socketPath, { force: true });

  async function handle(command: Command): Promise<unknown> {
    switch (command.cmd) {
      case 'mpv':
        // While mpv has the screen: keypresses, screenshots and properties.
        return player.command(command.args);
      case 'key':
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: command.key });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: command.key });
        return null;
      case 'keys': {
        // CLOCK_MONOTONIC send times, comparable with gamescope present timestamps, and whether each
        // key moved focus (a key that changed nothing starts no animation).
        const serial = () => win.webContents.executeJavaScript('globalThis.__playdeckFocusSerial ?? 0') as Promise<number>;
        const sent: { at: string; moved: boolean }[] = [];
        let before = await serial();
        for (const key of command.keys) {
          const at = process.hrtime.bigint().toString();
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
          await sleep(command.intervalMs);
          const after = await serial();
          sent.push({ at, moved: after !== before });
          before = after;
        }
        return sent;
      }
      case 'perf-start':
        return win.webContents.executeJavaScript(RECORDER);
      case 'perf-stop':
        return win.webContents.executeJavaScript('window.__playdeckPerf.stop()');
      case 'trace-start':
        await contentTracing.startRecording({ included_categories: TRACE_CATEGORIES });
        return null;
      case 'trace-stop':
        return contentTracing.stopRecording(command.path);
      case 'capture': {
        const image = await win.webContents.capturePage();
        await fs.writeFile(command.path, image.toPNG());
        return { path: command.path, size: image.getSize() };
      }
      case 'eval':
        return win.webContents.executeJavaScript(command.js);
      case 'clear-cache':
        // HTTP cache only (posters, art), so a run measures first-visit image loading.
        await win.webContents.session.clearCache();
        return null;
    }
  }

  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', async (chunk) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          socket.write(`${JSON.stringify({ ok: true, result: await handle(JSON.parse(line) as Command) })}\n`);
        } catch (error) {
          socket.write(`${JSON.stringify({ ok: false, error: String(error) })}\n`);
        }
      }
    });
    socket.on('error', () => {});
  });
  server.listen(socketPath);
}
