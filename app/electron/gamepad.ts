import { type ChildProcess, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';

/**
 * Reads Steam's virtual gamepad from evdev and reports mpv key names, so mpv can be driven while it
 * has the screen: Flathub mpv is built without SDL gamepad support. Chromium reads the same device,
 * but a hidden window stops polling it, so the two never act on the same press.
 */

const EV_KEY = 1;
const EV_ABS = 3;
/** struct input_event on 64-bit Linux: two 64-bit time fields, then type, code and value. */
const EVENT_SIZE = 24;

/** Linux key codes as the xpad driver (and Steam's virtual X-Box 360 pad) reports them. */
const BUTTONS: Record<number, string> = {
  0x130: 'GAMEPAD_ACTION_DOWN', // A
  0x131: 'GAMEPAD_ACTION_RIGHT', // B
  0x133: 'GAMEPAD_ACTION_LEFT', // X
  0x134: 'GAMEPAD_ACTION_UP', // Y
  0x136: 'GAMEPAD_LEFT_SHOULDER',
  0x137: 'GAMEPAD_RIGHT_SHOULDER',
  0x13a: 'GAMEPAD_BACK',
  0x13b: 'GAMEPAD_START',
  0x13d: 'GAMEPAD_LEFT_STICK',
  0x13e: 'GAMEPAD_RIGHT_STICK',
};

const ABS_X = 0x00;
const ABS_Y = 0x01;
const ABS_Z = 0x02;
const ABS_RZ = 0x05;
const ABS_HAT0X = 0x10;
const ABS_HAT0Y = 0x11;
const STICK_MAX = 32767;
/** Same as the UI's stick threshold (src/ui/input.ts), with a little hysteresis. */
const STICK_ON = 0.6;
const STICK_OFF = 0.45;

export interface KeyChange {
  key: string;
  down: boolean;
}

/** Turns evdev events into key presses and releases; keeps which axis keys are held. */
export class PadState {
  private readonly held = new Set<string>();
  /** Steam's virtual pad reports triggers as 0-255; track the largest value seen in case it differs. */
  private triggerMax = 255;

  handle(type: number, code: number, value: number): KeyChange[] {
    if (type === EV_KEY) {
      const key = BUTTONS[code];
      if (!key || value === 2) return [];
      return this.set(key, value === 1);
    }
    if (type !== EV_ABS) return [];
    switch (code) {
      case ABS_HAT0X:
        return [...this.set('GAMEPAD_DPAD_LEFT', value < 0), ...this.set('GAMEPAD_DPAD_RIGHT', value > 0)];
      case ABS_HAT0Y:
        return [...this.set('GAMEPAD_DPAD_UP', value < 0), ...this.set('GAMEPAD_DPAD_DOWN', value > 0)];
      case ABS_X:
        return this.stick('GAMEPAD_LEFT_STICK_LEFT', 'GAMEPAD_LEFT_STICK_RIGHT', value / STICK_MAX);
      case ABS_Y:
        return this.stick('GAMEPAD_LEFT_STICK_UP', 'GAMEPAD_LEFT_STICK_DOWN', value / STICK_MAX);
      case ABS_Z:
      case ABS_RZ:
        this.triggerMax = Math.max(this.triggerMax, value);
        return this.set(code === ABS_Z ? 'GAMEPAD_LEFT_TRIGGER' : 'GAMEPAD_RIGHT_TRIGGER', value > this.triggerMax / 2);
      default:
        return [];
    }
  }

  /** Releases everything, e.g. when playback ends with a button still down. */
  releaseAll(): KeyChange[] {
    const changes = [...this.held].map((key) => ({ key, down: false }));
    this.held.clear();
    return changes;
  }

  private stick(negative: string, positive: string, position: number): KeyChange[] {
    const on = (key: string, beyond: number) => (this.held.has(key) ? beyond > STICK_OFF : beyond > STICK_ON);
    return [...this.set(negative, on(negative, -position)), ...this.set(positive, on(positive, position))];
  }

  private set(key: string, down: boolean): KeyChange[] {
    if (down === this.held.has(key)) return [];
    if (down) this.held.add(key);
    else this.held.delete(key);
    return [{ key, down }];
  }
}

/** Event devices of joysticks, from /proc/bus/input/devices (a `jsN` handler marks a joystick). */
export function joystickEventDevices(devices: string): string[] {
  return devices
    .split(/\n\s*\n/)
    .flatMap((block) => {
      const handlers = /^H: Handlers=(.*)$/m.exec(block)?.[1].split(/\s+/) ?? [];
      const event = handlers.find((handler) => /^event\d+$/.test(handler));
      return event && handlers.some((handler) => /^js\d+$/.test(handler)) ? [`/dev/input/${event}`] : [];
    });
}

export function parseEvents(chunk: Buffer, onEvent: (type: number, code: number, value: number) => void): void {
  for (let offset = 0; offset + EVENT_SIZE <= chunk.length; offset += EVENT_SIZE) {
    onEvent(chunk.readUInt16LE(offset + 16), chunk.readUInt16LE(offset + 18), chunk.readInt32LE(offset + 20));
  }
}

const RESCAN_MS = 2000;

/**
 * Reads every joystick during playback. Each device is read by a `cat` child: a read of an evdev
 * file in Node blocks a thread-pool thread until the next event, which also keeps the app from
 * exiting, whereas a child is simply killed.
 */
export class GamepadReader {
  private readonly readers = new Map<string, { child: ChildProcess; state: PadState }>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly onKey: (change: KeyChange) => void) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.scan(), RESCAN_MS);
    void this.scan();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const { child, state } of this.readers.values()) {
      child.kill();
      for (const change of state.releaseAll()) this.onKey(change);
    }
    this.readers.clear();
  }

  private async scan(): Promise<void> {
    let devices: string[];
    try {
      devices = joystickEventDevices(await fs.readFile('/proc/bus/input/devices', 'utf8'));
    } catch {
      return;
    }
    for (const device of devices) {
      if (!this.timer || this.readers.has(device)) continue;
      const state = new PadState();
      const child = spawn('cat', [device], { stdio: ['ignore', 'pipe', 'ignore'] });
      let rest: Buffer = Buffer.alloc(0);
      child.stdout?.on('data', (chunk: Buffer) => {
        const data = rest.length ? Buffer.concat([rest, chunk]) : chunk;
        const whole = data.length - (data.length % EVENT_SIZE);
        rest = data.subarray(whole);
        parseEvents(data.subarray(0, whole), (type, code, value) => state.handle(type, code, value).forEach(this.onKey));
      });
      child.once('exit', () => {
        if (this.readers.get(device)?.child === child) this.readers.delete(device);
      });
      child.once('error', () => {});
      this.readers.set(device, { child, state });
    }
  }
}
