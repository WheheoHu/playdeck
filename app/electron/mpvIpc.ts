import net from 'node:net';

export interface MpvMessage {
  event?: string;
  name?: string;
  data?: unknown;
  args?: string[];
  reason?: string;
  file_error?: string;
  request_id?: number;
  error?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** mpv's JSON IPC over its Unix socket: commands with replies, plus events and observed properties. */
export class MpvIpc {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private buffer = '';

  private constructor(
    private readonly socket: net.Socket,
    private readonly onMessage: (message: MpvMessage) => void,
  ) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line) this.dispatch(JSON.parse(line) as MpvMessage);
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('mpv IPC closed'));
      this.pending.clear();
    });
  }

  /** Retries until mpv has created its socket, or gives up when `alive()` turns false. */
  static async connect(path: string, timeoutMs: number, alive: () => boolean, onMessage: (message: MpvMessage) => void) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && alive()) {
      try {
        const socket = await new Promise<net.Socket>((resolve, reject) => {
          const candidate = net.createConnection(path, () => resolve(candidate));
          candidate.once('error', reject);
        });
        return new MpvIpc(socket, onMessage);
      } catch {
        await sleep(100);
      }
    }
    throw new Error(alive() ? `mpv IPC socket not available after ${timeoutMs} ms` : 'mpv exited during startup');
  }

  private dispatch(message: MpvMessage): void {
    const waiter = message.request_id !== undefined ? this.pending.get(message.request_id) : undefined;
    if (waiter && message.event === undefined) {
      this.pending.delete(message.request_id!);
      if (message.error === 'success') waiter.resolve(message.data);
      else waiter.reject(new Error(message.error ?? 'mpv command failed'));
      return;
    }
    this.onMessage(message);
  }

  command(...args: unknown[]): Promise<unknown> {
    const request_id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(request_id, { resolve, reject });
      this.socket.write(`${JSON.stringify({ command: args, request_id })}\n`);
    });
  }

  /** Fire and forget, for input and other commands whose replies do not matter. */
  send(...args: unknown[]): void {
    this.command(...args).catch(() => {});
  }

  observe(name: string): void {
    this.send('observe_property', this.nextId, name);
  }

  close(): void {
    this.socket.destroy();
  }
}
