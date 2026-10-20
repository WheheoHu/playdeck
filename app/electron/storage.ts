import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** A JSON document on disk, written atomically and read back merged over defaults. */
export class JsonFile<T extends object> {
  constructor(
    private readonly file: string,
    private readonly defaults: T,
    private readonly mode = 0o644,
  ) {}

  async read(): Promise<T> {
    let text: string;
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(this.defaults);
      throw error;
    }
    try {
      return { ...structuredClone(this.defaults), ...(JSON.parse(text) as Partial<T>) };
    } catch {
      // Keep the unreadable file for the user to inspect instead of silently overwriting it later.
      await fs.rename(this.file, `${this.file}.corrupt-${Date.now()}`);
      return structuredClone(this.defaults);
    }
  }

  async write(value: T): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: this.mode });
    await fs.rename(temporary, this.file);
  }
}

/** Stable per-installation identifier, sent to Plex as X-Plex-Client-Identifier. */
export async function loadClientIdentifier(directory: string): Promise<string> {
  const identity = new JsonFile(path.join(directory, 'identity.json'), { clientIdentifier: '' });
  const current = await identity.read();
  if (current.clientIdentifier) return current.clientIdentifier;
  const clientIdentifier = randomUUID();
  await identity.write({ clientIdentifier });
  return clientIdentifier;
}
