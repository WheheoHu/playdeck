import net from 'node:net';
import path from 'node:path';

/**
 * Client for gamescope's private gamescope_control Wayland protocol, spoken in the raw wire format
 * (docs/DESIGN.md, section 5.3). Only requests without file descriptors are used, so no libwayland
 * binding is needed. Ported from spikes/lib/gamescope_control.py.
 */

const WL_DISPLAY = 1;
const WL_DISPLAY_SYNC = 0;
const WL_DISPLAY_GET_REGISTRY = 1;
const WL_DISPLAY_ERROR = 0;
const WL_REGISTRY_BIND = 0;
const WL_REGISTRY_GLOBAL = 0;
const WL_CALLBACK_DONE = 0;
const CONTROL_SET_APP_TARGET_REFRESH_CYCLE = 1;
const CONTROL_EVENT_ACTIVE_DISPLAY_INFO = 1;

const FLAG_INTERNAL_DISPLAY = 0x1;
const FLAG_ALLOW_REFRESH_SWITCHING = 0x2;
const FLAG_ONLY_CHANGE_REFRESH_RATE = 0x4;

export interface DisplayInfo {
  connector: string;
  make: string;
  model: string;
  internal: boolean;
  hdr: boolean;
  vrr: boolean;
  refreshRates: number[];
}

function encodeString(value: string): Buffer {
  const data = Buffer.from(`${value}\0`);
  const padded = Buffer.alloc(4 + Math.ceil(data.length / 4) * 4);
  padded.writeUInt32LE(data.length, 0);
  data.copy(padded, 4);
  return padded;
}

function u32(...values: number[]): Buffer {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => buffer.writeUInt32LE(value >>> 0, i * 4));
  return buffer;
}

function readBlob(body: Buffer, offset: number): [Buffer, number] {
  const length = body.readUInt32LE(offset);
  const start = offset + 4;
  return [body.subarray(start, start + length), start + Math.ceil(length / 4) * 4];
}

const text = (blob: Buffer) => blob.toString('utf8').replace(/\0+$/, '');

export function parseDisplayInfo(body: Buffer): DisplayInfo {
  const [connector, afterConnector] = readBlob(body, 0);
  const [make, afterMake] = readBlob(body, afterConnector);
  const [model, afterModel] = readBlob(body, afterMake);
  const flags = body.readUInt32LE(afterModel);
  const [rates] = readBlob(body, afterModel + 4);
  const refreshRates: number[] = [];
  for (let offset = 0; offset + 4 <= rates.length; offset += 4) refreshRates.push(rates.readUInt32LE(offset));
  return {
    connector: text(connector),
    make: text(make),
    model: text(model),
    internal: Boolean(flags & 0x1),
    hdr: Boolean(flags & 0x2),
    vrr: Boolean(flags & 0x4),
    refreshRates,
  };
}

/** The rate gamescope picks for a target frame rate: the highest valid rate that is a multiple of it. */
export function refreshFor(fps: number, rates: number[]): number | undefined {
  const target = Math.round(fps);
  if (target <= 0) return undefined;
  return [...rates].sort((a, b) => b - a).find((rate) => rate % target === 0);
}

type Handler = (objectId: number, opcode: number, body: Buffer) => boolean;

export class GamescopeControl {
  display: DisplayInfo | null = null;
  private buffer = Buffer.alloc(0);
  private nextId = 2;
  private registry = 0;
  private control = 0;
  private readonly handlers = new Set<Handler>();

  private constructor(private readonly socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    socket.on('error', () => {});
  }

  /** Connects to the gamescope that runs this app, or returns null outside gamescope. */
  static async connect(): Promise<GamescopeControl | null> {
    const display = process.env.GAMESCOPE_WAYLAND_DISPLAY;
    const runtime = process.env.XDG_RUNTIME_DIR;
    if (!display || !runtime) return null;
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const candidate = net.createConnection(path.join(runtime, display), () => resolve(candidate));
      candidate.once('error', reject);
    });
    const client = new GamescopeControl(socket);
    try {
      await client.bind();
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  private async bind(): Promise<void> {
    this.registry = this.newId();
    this.send(WL_DISPLAY, WL_DISPLAY_GET_REGISTRY, u32(this.registry));
    const globals = new Map<string, { name: number; version: number }>();
    const onGlobal: Handler = (objectId, opcode, body) => {
      if (objectId !== this.registry || opcode !== WL_REGISTRY_GLOBAL) return false;
      const name = body.readUInt32LE(0);
      const [interfaceName, afterName] = readBlob(body, 4);
      globals.set(text(interfaceName), { name, version: body.readUInt32LE(afterName) });
      return false;
    };
    this.handlers.add(onGlobal);
    await this.roundtrip();
    this.handlers.delete(onGlobal);

    const global = globals.get('gamescope_control');
    if (!global) throw new Error('gamescope_control is not advertised');
    if (global.version < 2) throw new Error(`gamescope_control v${global.version} lacks set_app_target_refresh_cycle`);
    this.control = this.newId();
    this.send(
      this.registry,
      WL_REGISTRY_BIND,
      Buffer.concat([u32(global.name), encodeString('gamescope_control'), u32(Math.min(global.version, 7), this.control)]),
    );
    this.handlers.add((objectId, opcode, body) => {
      if (objectId === this.control && opcode === CONTROL_EVENT_ACTIVE_DISPLAY_INFO) this.display = parseDisplayInfo(body);
      return false;
    });
    await this.roundtrip();
  }

  /** fps 0 restores the native rate. Only the refresh rate changes; no frame limiter is applied. */
  async setAppTargetRefreshCycle(fps: number, internalDisplay: boolean): Promise<void> {
    let flags = FLAG_ALLOW_REFRESH_SWITCHING | FLAG_ONLY_CHANGE_REFRESH_RATE;
    if (internalDisplay) flags |= FLAG_INTERNAL_DISPLAY;
    this.send(this.control, CONTROL_SET_APP_TARGET_REFRESH_CYCLE, u32(Math.round(fps), flags));
    await this.roundtrip();
  }

  close(): void {
    this.socket.destroy();
  }

  private newId(): number {
    return this.nextId++;
  }

  private send(objectId: number, opcode: number, payload: Buffer = Buffer.alloc(0)): void {
    this.socket.write(Buffer.concat([u32(objectId, ((8 + payload.length) << 16) | opcode), payload]));
  }

  private roundtrip(timeoutMs = 2000): Promise<void> {
    const callback = this.newId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handlers.delete(done);
        reject(new Error('gamescope did not answer'));
      }, timeoutMs);
      const done: Handler = (objectId, opcode) => {
        if (objectId !== callback || opcode !== WL_CALLBACK_DONE) return false;
        clearTimeout(timer);
        resolve();
        return true;
      };
      this.handlers.add(done);
      this.send(WL_DISPLAY, WL_DISPLAY_SYNC, u32(callback));
    });
  }

  private drain(): void {
    while (this.buffer.length >= 8) {
      const objectId = this.buffer.readUInt32LE(0);
      const header = this.buffer.readUInt32LE(4);
      const size = header >>> 16;
      if (this.buffer.length < size) return;
      const opcode = header & 0xffff;
      const body = this.buffer.subarray(8, size);
      this.buffer = this.buffer.subarray(size);
      if (objectId === WL_DISPLAY && opcode === WL_DISPLAY_ERROR) {
        const [message] = readBlob(body, 8);
        this.socket.destroy(new Error(`wl_display error ${body.readUInt32LE(4)}: ${text(message)}`));
        return;
      }
      for (const handler of this.handlers) if (handler(objectId, opcode, body)) this.handlers.delete(handler);
    }
  }
}
