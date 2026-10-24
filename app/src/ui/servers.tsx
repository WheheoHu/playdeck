import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { AppCache, PlexServer, WebDavLibraryConfig } from '../../shared/bridge';
import type { LibraryServer } from '../core/plex/library';
import { type ServerEntry, connectServers, libraryServerOf } from '../core/serverRegistry';
import type { Session } from '../core/session';
import {
  type WebDavScanStatus,
  getWebDavCatalog,
  getWebDavScanStatus,
  initWebDavWatchStore,
  removeWebDavCatalog,
  scanWebDavLibrary,
  subscribeWebDav,
} from '../core/webdav/scanner';
import { useApp } from './AppContext';
import { invalidate } from './resource';

interface Servers {
  /** null until discovery returns. */
  entries: ServerEntry[] | null;
  online: LibraryServer[];
  error: string | null;
  webdavStatus: WebDavScanStatus;
  webdavTick: number;
  byId(id: string): LibraryServer | undefined;
  refresh(): void;
  rescanWebDav(libraryId?: string): void;
}

const ServersContext = createContext<Servers | null>(null);

export function useServers(): Servers {
  const servers = useContext(ServersContext);
  if (!servers) throw new Error('useServers outside ServersProvider');
  return servers;
}

const CACHE_WRITE_DELAY_MS = 1000;

export function webdavServerOf(config: WebDavLibraryConfig): LibraryServer {
  return {
    id: config.id,
    name: config.name,
    baseUrl: config.baseUrl,
    token: '',
    kind: 'webdav',
    webdav: config,
  };
}

interface ProviderProps {
  session: Session;
  /** The session user's server list from last launch. */
  cached?: PlexServer[];
  webdavLibraries?: WebDavLibraryConfig[];
  onServers(userUuid: string, servers: PlexServer[]): void;
  children: ReactNode;
}

/** Connects to the session's servers once, app-wide, and remembers what worked for next launch. */
export function ServersProvider({ session, cached, webdavLibraries = [], onServers, children }: ProviderProps) {
  const { plex, bridge, settings } = useApp();
  const [entries, setEntries] = useState<ServerEntry[] | null>(() => (session.user.token ? null : []));
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [webdavTick, setWebdavTick] = useState(0);
  const cache = useRef<AppCache | null>(null);
  const known = useRef(cached);
  const writeTimer = useRef(0);
  const scannedConfigs = useRef(new Map<string, string>());
  const uuid = session.user.uuid;

  const scheduleCacheWrite = useCallback(() => {
    if (!cache.current) return;
    window.clearTimeout(writeTimer.current);
    writeTimer.current = window.setTimeout(() => {
      if (cache.current) void bridge.writeCache(cache.current);
    }, CACHE_WRITE_DELAY_MS);
  }, [bridge]);

  useEffect(() => {
    let active = true;
    bridge.readCache().then((loaded) => {
      if (!active) return;
      cache.current = loaded;
      initWebDavWatchStore(loaded.webdavWatch, (store) => {
        if (!cache.current) return;
        cache.current.webdavWatch = { ...store };
        scheduleCacheWrite();
      });
    });
    return () => {
      active = false;
    };
  }, [bridge, scheduleCacheWrite]);

  useEffect(() => {
    return subscribeWebDav(() => {
      for (const prefix of ['home:', 'sections:', 'item:', 'children:', 'search:']) {
        invalidate(prefix);
      }
      setWebdavTick((n) => n + 1);
    });
  }, []);

  useEffect(() => {
    const currentIds = new Set(webdavLibraries.map((lib) => lib.id));
    for (const id of [...scannedConfigs.current.keys()]) {
      if (!currentIds.has(id)) {
        scannedConfigs.current.delete(id);
        removeWebDavCatalog(id);
      }
    }
    for (const lib of webdavLibraries) {
      const signature = `${lib.baseUrl}|${lib.rootPath}|${lib.username ?? ''}|${lib.password ?? ''}|${lib.type}`;
      if (scannedConfigs.current.get(lib.id) === signature && getWebDavCatalog(lib.id)) continue;
      scannedConfigs.current.set(lib.id, signature);
      void scanWebDavLibrary((req) => bridge.webdavRequest(req), lib);
    }
  }, [bridge, webdavLibraries]);

  const rescanWebDav = useCallback(
    (libraryId?: string) => {
      for (const lib of webdavLibraries) {
        if (libraryId && lib.id !== libraryId) continue;
        void scanWebDavLibrary((req) => bridge.webdavRequest(req), lib);
      }
    },
    [bridge, webdavLibraries],
  );

  useEffect(() => {
    if (!session.user.token) {
      setEntries([]);
      setError(null);
      return;
    }
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
          scheduleCacheWrite();
        },
        signal: controller.signal,
      });
    })().catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => controller.abort();
  }, [plex, bridge, session.user.token, uuid, onServers, settings.manualServers, attempt, scheduleCacheWrite]);

  const value = useMemo<Servers>(() => {
    const plexOnline = (entries ?? []).flatMap((entry) => libraryServerOf(entry) ?? []);
    const webdavOnline = webdavLibraries.map(webdavServerOf);
    const online = [...plexOnline, ...webdavOnline];
    const webdavStatus = getWebDavScanStatus();
    return {
      entries,
      online,
      error,
      webdavStatus,
      webdavTick,
      byId: (id) => online.find((server) => server.id === id),
      refresh: () => {
        setAttempt((n) => n + 1);
        rescanWebDav();
      },
      rescanWebDav,
    };
  }, [entries, error, webdavLibraries, webdavTick, rescanWebDav]);

  return <ServersContext.Provider value={value}>{children}</ServersContext.Provider>;
}
