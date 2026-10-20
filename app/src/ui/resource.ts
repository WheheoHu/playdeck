import { useEffect, useReducer } from 'react';

interface Entry {
  value?: unknown;
  error?: unknown;
  loadedAt: number;
  pending?: Promise<void>;
  loader?: () => Promise<unknown>;
  listeners: Set<() => void>;
}

const STALE_MS = 60_000;
const entries = new Map<string, Entry>();

function entryFor(key: string): Entry {
  let entry = entries.get(key);
  if (!entry) {
    entry = { loadedAt: 0, listeners: new Set() };
    entries.set(key, entry);
  }
  return entry;
}

function load(entry: Entry): void {
  if (entry.pending || !entry.loader) return;
  entry.pending = entry.loader().then(
    (value) => {
      entry.value = value;
      entry.error = undefined;
      entry.loadedAt = Date.now();
    },
    (error: unknown) => {
      entry.error = error;
    },
  );
  entry.pending.finally(() => {
    entry.pending = undefined;
    entry.listeners.forEach((listener) => listener());
  });
}

export interface Resource<T> {
  data: T | undefined;
  error: unknown;
  /** True only while there is nothing to show yet; background refreshes keep showing the old data. */
  loading: boolean;
  reload(): void;
}

/**
 * Cached async data keyed by `key`. Cached values render immediately and are refreshed in the
 * background once stale, so returning to a screen never flashes a spinner.
 */
export function useResource<T>(key: string | null, loader: () => Promise<T>): Resource<T> {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const entry = key ? entryFor(key) : null;
  if (entry) entry.loader = loader;

  useEffect(() => {
    if (!entry) return;
    entry.listeners.add(rerender);
    if (Date.now() - entry.loadedAt > STALE_MS) load(entry);
    return () => {
      entry.listeners.delete(rerender);
    };
  }, [entry]);

  return {
    data: entry?.value as T | undefined,
    error: entry?.error,
    loading: Boolean(entry && entry.value === undefined && !entry.error),
    reload: () => {
      if (!entry) return;
      entry.loadedAt = 0;
      load(entry);
    },
  };
}

/** Marks cached data stale and refreshes whatever is on screen, e.g. after changing watched state. */
export function invalidate(prefix: string): void {
  for (const [key, entry] of entries) {
    if (!key.startsWith(prefix)) continue;
    entry.loadedAt = 0;
    if (entry.listeners.size > 0) load(entry);
  }
}
