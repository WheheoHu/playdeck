import { type ReactNode, createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { AppCache, PlexServer } from '../../shared/bridge';
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

interface ProviderProps {
  session: Session;
  /** The session user's server list from last launch. */
  cached?: PlexServer[];
  onServers(userUuid: string, servers: PlexServer[]): void;
  children: ReactNode;
}

/** Connects to the session's servers once, app-wide, and remembers what worked for next launch. */
export function ServersProvider({ session, cached, onServers, children }: ProviderProps) {
  const { plex, bridge, settings } = useApp();
  const [entries, setEntries] = useState<ServerEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const cache = useRef<AppCache | null>(null);
  const known = useRef(cached);
  const writeTimer = useRef(0);
  const uuid = session.user.uuid;

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    (async () => {
      cache.current ??= await bridge.readCache();
      await connectServers(plex, session.user.token, {
        manual: settings.manualServers,
        remembered: cache.current.connections,
        cached: known.current,
        onServers: (servers) => {
          known.current = servers;
          onServers(uuid, servers);
        },
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
  }, [plex, bridge, session.user.token, uuid, onServers, settings.manualServers, attempt]);

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
