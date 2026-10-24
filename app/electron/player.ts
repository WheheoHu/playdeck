import { type ChildProcess, spawn } from 'node:child_process';
import { createWriteStream, existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { CHANNELS, type PlayerEvent, type PlayerOptions, type PlaySession } from '../shared/bridge';
import { GamepadReader } from './gamepad';
import { GamescopeControl, refreshFor } from './gamescope';
import { MpvIpc, type MpvMessage } from './mpvIpc';

const BUNDLED_MPV = '/app/bin/mpv';
/** Fallback Flathub mpv for unpacked development runs outside PlayDeck's Flatpak. */
const FLATPAK_MPV_APP = 'io.mpv.Mpv';
const IPC_TIMEOUT_MS = 20_000;
const VO_TIMEOUT_MS = 15_000;
/** A mode switch takes about 0.6 s and drops frames (S4), so it happens before playback starts. */
const REFRESH_SETTLE_MS = 1000;
const PROGRESS_INTERVAL_MS = 1000;
const STOP_TIMEOUT_MS = 3000;
const OUTPUT_TAIL = 2000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const SUB_COLORS: Record<PlayerOptions['subtitleColor'], string> = {
  white: '#FFFFFFFF',
  yellow: '#FFF5D547',
  gray: '#FFD8D8DC',
};

function subtitleStyleArgs(options: PlayerOptions): string[] {
  const scale = Math.max(0.5, Math.min(2.5, (options.subtitleScale || 100) / 100));
  const color = SUB_COLORS[options.subtitleColor] ?? SUB_COLORS.white;
  const hdrPeak = Math.max(50, Math.min(1000, Math.round(options.hdrSubtitleBrightness || 203)));
  const bg = options.subtitleBackground;
  const borderArgs =
    bg === 'box'
      ? ['--sub-border-style=background-box', '--sub-border-size=4', '--sub-shadow-offset=0', '--sub-back-color=#B0000000']
      : bg === 'none'
        ? ['--sub-border-style=outline-and-shadow', '--sub-border-size=0', '--sub-shadow-offset=0']
        : ['--sub-border-style=outline-and-shadow', '--sub-border-size=2.5', '--sub-shadow-offset=1', '--sub-back-color=#B0000000'];
  return [
    `--sub-scale=${scale}`,
    `--sub-color=${color}`,
    ...borderArgs,
    `--sub-hdr-peak=${hdrPeak}`,
    `--image-subs-hdr-peak=${hdrPeak}`,
  ];
}

export interface PlayerPaths {
  /** The PlayDeck OSD script. */
  script: string;
  /** Private directory for the IPC socket and session files; mpv's sandbox must be able to write it. */
  runDir: string;
  /** mpv's log, in development builds. */
  logDir?: string;
  /** The user's mpv.conf override, included last when it exists. */
  userConf: string;
}

interface Run {
  child: ChildProcess;
  ipc?: MpvIpc;
  options: PlayerOptions;
  frameRate?: number;
  /** A file has loaded and waits, paused on its first frame, for the handoff. */
  loading: boolean;
  /** mpv has the screen and the UI window is hidden. */
  shown: boolean;
  voConfigured: boolean;
  containerFps?: number;
  position: number;
  duration: number;
  paused: boolean;
  reachedEnd: boolean;
  lastProgress: number;
  error?: string;
  /** The end of mpv's output, for the error when it fails to start. */
  output: string;
  /** The UI asked mpv to quit, so an unclean exit is not an error. */
  stopping: boolean;
  finished: boolean;
}

/**
 * Runs mpv for playback (docs/DESIGN.md, section 3.3). mpv starts paused; once its first frame is up
 * the UI window hides, the refresh rate is set, and only then does playback start. When mpv exits, the
 * refresh rate is restored and the UI window comes back.
 */
export class Player {
  private run: Run | null = null;
  private gamescope: Promise<GamescopeControl | null> | undefined;
  /** The frame rate gamescope was asked to match, 0 for the native rate. */
  private refreshTarget = 0;
  private sessionCount = 0;
  private readonly gamepad = new GamepadReader((change) => this.run?.ipc?.send(change.down ? 'keydown' : 'keyup', change.key));

  constructor(
    private readonly win: BrowserWindow,
    private readonly paths: PlayerPaths,
  ) {}

  async start(session: PlaySession, options: PlayerOptions): Promise<void> {
    if (this.run) throw new Error('already playing');
    const { runDir } = this.paths;
    await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
    const sessionFile = await this.writeSession(session);
    const inputConf = path.join(runDir, 'input.conf');
    await fs.writeFile(inputConf, options.inputConf);
    const socket = path.join(runDir, 'mpv.sock');
    await fs.rm(socket, { force: true });

    const args = [
      '--no-config',
      '--idle=yes',
      '--force-window=no',
      '--pause',
      '--fs',
      '--cursor-autohide=always',
      '--vo=gpu-next',
      '--gpu-api=vulkan',
      '--target-colorspace-hint=yes',
      `--hwdec=${options.hardwareDecoding ? 'vaapi' : 'no'}`,
      '--video-sync=display-resample',
      '--keep-open=yes',
      '--cache=yes',
      '--demuxer-max-bytes=400MiB',
      '--demuxer-max-back-bytes=150MiB',
      '--network-timeout=30',
      '--osc=no',
      '--osd-bar=no',
      '--osd-on-seek=no',
      '--input-default-bindings=no',
      '--input-builtin-bindings=no',
      `--input-conf=${inputConf}`,
      '--input-ar-delay=350',
      '--input-ar-rate=11',
      '--ytdl=no',
      '--sub-auto=no',
      '--audio-file-auto=no',
      '--title=PlayDeck',
      '--osd-font=Noto Sans CJK SC',
      '--sub-font=Noto Sans CJK SC',
      ...subtitleStyleArgs(options),
      `--input-ipc-server=${socket}`,
      `--script=${this.paths.script}`,
      `--script-opts=playdeck-session=${sessionFile}`,
      // Not --log-file: it always logs at -v, which includes the HTTP headers and so the token.
      ...(this.paths.logDir ? ['--msg-level=all=info,vo=v'] : []),
      ...(existsSync(this.paths.userConf) ? [`--include=${this.paths.userConf}`] : []),
    ];
    const bundled = existsSync(BUNDLED_MPV);
    const child = bundled
      ? spawn(BUNDLED_MPV, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn('flatpak', ['run', FLATPAK_MPV_APP, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const run: Run = {
      child,
      options,
      frameRate: session.frameRate,
      loading: false,
      shown: false,
      voConfigured: false,
      position: session.start,
      duration: 0,
      paused: true,
      reachedEnd: false,
      lastProgress: 0,
      output: '',
      stopping: false,
      finished: false,
    };
    this.run = run;
    const log = this.paths.logDir ? createWriteStream(path.join(this.paths.logDir, 'mpv.log'), { flags: 'a' }) : undefined;
    // mpv writes its log to stdout; libraries in its process write to stderr.
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk: string) => {
        run.output = (run.output + chunk).slice(-OUTPUT_TAIL);
        log?.write(chunk);
      });
    }
    child.once('exit', () => log?.end());
    child.once('error', (error) => {
      run.error = error.message;
      void this.finish(run);
    });
    child.once('exit', () => void this.finish(run));

    try {
      run.ipc = await MpvIpc.connect(socket, IPC_TIMEOUT_MS, () => this.run === run && !run.finished, (message) =>
        this.onMessage(run, message),
      );
    } catch (error) {
      child.kill();
      throw error;
    }
    for (const name of ['pause', 'time-pos', 'duration', 'eof-reached', 'vo-configured', 'container-fps']) run.ipc.observe(name);
  }

  async next(session: PlaySession): Promise<void> {
    const run = this.run;
    if (!run?.ipc) throw new Error('not playing');
    run.frameRate = session.frameRate;
    run.containerFps = undefined;
    run.ipc.send('script-message-to', 'playdeck', 'load', await this.writeSession(session));
  }

  stop(): void {
    const run = this.run;
    if (!run) return;
    run.stopping = true;
    run.ipc?.send('quit');
    setTimeout(() => {
      if (!run.finished) run.child.kill();
    }, STOP_TIMEOUT_MS);
  }

  /** Development control: raw mpv commands, e.g. keypresses and screenshots. */
  command(args: unknown[]): Promise<unknown> {
    if (!this.run?.ipc) return Promise.reject(new Error('not playing'));
    return this.run.ipc.command(...args);
  }

  /** On app exit: no mpv may outlive the app, and the panel goes back to its native rate. */
  dispose(): void {
    this.gamepad.stop();
    this.run?.child.kill();
    if (this.refreshTarget) void this.restoreRefresh();
  }

  private async writeSession(session: PlaySession): Promise<string> {
    const file = path.join(this.paths.runDir, `session-${++this.sessionCount}.json`);
    await fs.writeFile(file, JSON.stringify(session), { mode: 0o600 });
    return file;
  }

  private emit(event: PlayerEvent): void {
    if (!this.win.isDestroyed()) this.win.webContents.send(CHANNELS.playerEvent, event);
  }

  private progress(run: Run, force = false): void {
    const now = Date.now();
    if (!force && now - run.lastProgress < PROGRESS_INTERVAL_MS) return;
    run.lastProgress = now;
    this.emit({ type: 'progress', position: run.position, duration: run.duration, paused: run.paused });
  }

  private onMessage(run: Run, message: MpvMessage): void {
    switch (message.event) {
      case 'property-change':
        this.onProperty(run, message.name ?? '', message.data);
        return;
      case 'file-loaded':
        run.loading = true;
        run.reachedEnd = false;
        return;
      case 'playback-restart':
        if (run.loading) {
          run.loading = false;
          void this.handoff(run);
        } else {
          this.progress(run, true);
        }
        return;
      case 'end-file':
        if (message.reason === 'error') {
          run.error = message.file_error ?? 'error';
          // With --idle, mpv would otherwise wait with no file and no window.
          run.ipc?.send('quit', 2);
        }
        return;
      case 'client-message': {
        const [name, payload] = message.args ?? [];
        if (name !== 'playdeck-event' || !payload) return;
        const event = JSON.parse(payload) as {
          type: string;
          audio?: unknown;
          subtitle?: unknown;
          on?: unknown;
          scale?: unknown;
        };
        const id = (value: unknown) => (typeof value === 'number' ? value : undefined);
        if (event.type === 'tracks') this.emit({ type: 'tracks', audio: id(event.audio), subtitle: id(event.subtitle) });
        else if (event.type === 'next') this.emit({ type: 'next' });
        else if (event.type === 'networkMonitor') this.emit({ type: 'networkMonitor', on: event.on === true });
        else if (event.type === 'subtitleScale' && typeof event.scale === 'number')
          this.emit({ type: 'subtitleScale', scale: event.scale });
        return;
      }
    }
  }

  private onProperty(run: Run, name: string, value: unknown): void {
    switch (name) {
      case 'pause':
        run.paused = Boolean(value);
        if (!run.loading && run.shown) this.progress(run, true);
        break;
      case 'time-pos':
        if (typeof value === 'number') {
          run.position = value;
          if (run.shown) this.progress(run);
        }
        break;
      case 'duration':
        if (typeof value === 'number') run.duration = value;
        break;
      case 'eof-reached':
        run.reachedEnd = Boolean(value);
        break;
      case 'vo-configured':
        run.voConfigured = Boolean(value);
        break;
      case 'container-fps':
        run.containerFps = typeof value === 'number' && value > 0 ? value : undefined;
        break;
    }
  }

  /** The loaded file is paused on its first frame: take the screen, match the refresh rate, then play. */
  private async handoff(run: Run): Promise<void> {
    if (!run.shown) {
      const deadline = Date.now() + VO_TIMEOUT_MS;
      while (!run.voConfigured && !run.finished && Date.now() < deadline) await sleep(50);
      if (run.finished) return;
      this.win.hide();
      run.shown = true;
      this.gamepad.start();
    }
    if (run.options.refreshSwitching) {
      try {
        await this.matchRefresh(run);
      } catch (error) {
        console.error('refresh switching failed:', error);
      }
    }
    if (run.finished) return;
    run.ipc?.send('set_property', 'pause', false);
    this.emit({ type: 'playing' });
  }

  private control(): Promise<GamescopeControl | null> {
    this.gamescope ??= GamescopeControl.connect().catch((error: unknown) => {
      console.error('gamescope_control unavailable:', error);
      return null;
    });
    return this.gamescope;
  }

  /** Internal panel only; external displays keep their mode and mpv resamples (section 5.3). */
  private async matchRefresh(run: Run): Promise<void> {
    const fps = run.containerFps ?? run.frameRate;
    const control = await this.control();
    const display = control?.display;
    if (!control || !display?.internal || !fps || display.refreshRates.length === 0) return;
    const native = Math.max(...display.refreshRates);
    const rate = refreshFor(fps, display.refreshRates) ?? native;
    const target = rate === native ? 0 : Math.round(fps);
    run.ipc?.send('set_property', 'display-fps-override', rate);
    if (target === this.refreshTarget) return;
    await control.setAppTargetRefreshCycle(target, true);
    this.refreshTarget = target;
    await sleep(REFRESH_SETTLE_MS);
  }

  private async restoreRefresh(): Promise<void> {
    const control = await this.control();
    if (!control || !this.refreshTarget) return;
    await control.setAppTargetRefreshCycle(0, true);
    this.refreshTarget = 0;
  }

  private async finish(run: Run): Promise<void> {
    if (run.finished) return;
    run.finished = true;
    if (this.run === run) this.run = null;
    this.gamepad.stop();
    run.ipc?.close();
    await this.restoreRefresh().catch((error: unknown) => console.error('refresh restore failed:', error));
    if (run.shown && !this.win.isDestroyed()) {
      this.win.show();
      this.win.focus();
    }
    const failedEarly = !run.shown && !run.stopping && run.child.exitCode !== 0;
    const error = run.error ?? (failedEarly ? run.output.trim().split('\n').at(-1) || `mpv exited (${run.child.exitCode})` : undefined);
    this.emit({ type: 'ended', position: run.position, duration: run.duration, reachedEnd: run.reachedEnd, error });
  }
}
