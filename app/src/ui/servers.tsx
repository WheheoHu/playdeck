import { type ReactNode, createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { AppCache } from '../../shared/bridge';
import type { LibraryServer } from '../core/plex/library';
import { type ServerEntry, connectServers, libraryServerOf } from '../core/serverRegistry';
import type { Session } from '../core/session';
import { useApp } from './AppContext';

interface Servers {
  /** null until discovery returns. */
  entries: ServerEntry[] | null;
  online: LibraryServer[];
  error: string | null;
  byId(id: string): LibraryServer | undefined;
  refresh(): void;
}

const ServersContext = createContext<Servers | null>(null);

export function useServers(): Servers {
  const servers = useContext(ServersContext);
  if (!servers) throw new Error('useServers outside ServersProvider');
  return servers;
}

const CACHE_WRITE_DELAY_MS = 1000;

/** Connects to the session's servers once, app-wide, and remembers what worked for next launch. */
export function ServersProvider({ session, children }: { session: Session; children: ReactNode }) {
  const { plex, bridge, settings } = useApp();
  const [entries, setEntries] = useState<ServerEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const cache = useRef<AppCache | null>(null);
  const writeTimer = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    (async () => {
      cache.current ??= await bridge.readCache();
      await connectServers(plex, session.user.token, {
        manual: settings.manualServers,
        remembered: cache.current.connections,
        onChange: setEntries,
        onConnected: (id, connection) => {
          cache.current!.connections[id] = { url: connection.url, networkClass: connection.networkClass };
          window.clearTimeout(writeTimer.current);
          writeTimer.current = window.setTimeout(() => bridge.writeCache(cache.current!), CACHE_WRITE_DELAY_MS);
        },
        signal: controller.signal,
      });
    })().catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => controller.abort();
  }, [plex, bridge, session.user.token, settings.manualServers, attempt]);

  const value = useMemo<Servers>(() => {
    const online = (entries ?? []).flatMap((entry) => libraryServerOf(entry) ?? []);
    return {
      entries,
      online,
      error,
      byId: (id) => online.find((server) => server.id === id),
      refresh: () => setAttempt((n) => n + 1),
    };
  }, [entries, error]);

  return <ServersContext.Provider value={value}>{children}</ServersContext.Provider>;
}
