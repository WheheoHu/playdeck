import type { ManualServer, RememberedConnection } from '../../shared/bridge';
import { type PlexContext, requestJson } from './plex/client';
import { type ConnectionChoice, connectionCandidates, plexProber, selectConnection } from './plex/connections';
import type { LibraryServer } from './plex/library';
import { type PlexServer, fetchServers } from './plex/servers';

export type ServerStatus =
  | { state: 'connecting' }
  | { state: 'online'; connection: ConnectionChoice }
  | { state: 'offline' };

export interface ServerEntry {
  server: PlexServer;
  status: ServerStatus;
}

export function libraryServerOf(entry: ServerEntry): LibraryServer | null {
  if (entry.status.state !== 'online') return null;
  return {
    id: entry.server.clientIdentifier,
    name: entry.server.name,
    baseUrl: entry.status.connection.url,
    token: entry.server.accessToken,
  };
}

interface Identity {
  url: string;
  machineIdentifier: string;
}

/** /identity needs no token, so it identifies a manually entered address even for shared servers. */
async function identify(context: PlexContext, manual: ManualServer[], signal?: AbortSignal): Promise<Identity[]> {
  const results = await Promise.allSettled(
    manual.map(async ({ url }) => {
      const base = url.replace(/\/$/, '');
      const identity = await requestJson<{ MediaContainer?: { machineIdentifier?: string } }>(context, `${base}/identity`, {
        signal,
        timeoutMs: 6000,
      });
      const machineIdentifier = identity.MediaContainer?.machineIdentifier;
      if (!machineIdentifier) throw new Error('no machineIdentifier');
      return { url: base, machineIdentifier };
    }),
  );
  return results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
}

/** A remembered remote connection gives way only to a LAN connection, so moving home upgrades it. */
function preferred(quick: ConnectionChoice | null, full: ConnectionChoice | null): ConnectionChoice | null {
  if (!quick || !full) return quick ?? full;
  return quick.networkClass === 'remote' && full.networkClass === 'local' ? full : quick;
}

export interface ConnectOptions {
  manual: ManualServer[];
  remembered: Record<string, RememberedConnection>;
  /** The list plex.tv returned last time; connecting starts from it while plex.tv is asked again. */
  cached?: PlexServer[];
  /** Receives a fresh array whenever the set of servers or any server's status changes. */
  onChange: (entries: ServerEntry[]) => void;
  onConnected?: (serverId: string, connection: ConnectionChoice) => void;
  /** Receives the list plex.tv returned, for next launch's `cached`. */
  onServers?: (servers: PlexServer[]) => void;
  signal?: AbortSignal;
}

function sameServer(a: PlexServer, b: PlexServer): boolean {
  const uris = (server: PlexServer) => server.connections.map((connection) => connection.uri).join(' ');
  return a.name === b.name && a.accessToken === b.accessToken && uris(a) === uris(b);
}

/**
 * Discovers the user's servers and connects to each in parallel. A server's remembered connection is
 * tried on its own first so it comes online without waiting for the full selection, which still runs
 * and can upgrade it. Manually added addresses are tried before published ones. With a cached server
 * list nothing waits for plex.tv: its answer only adds, drops or reconnects servers that changed.
 */
export async function connectServers(context: PlexContext, userToken: string, options: ConnectOptions): Promise<ServerEntry[]> {
  const { signal } = options;
  const cached = options.cached ?? [];
  const fresh = fetchServers(context, userToken, signal);
  fresh.catch(() => {});
  const identities = await identify(context, options.manual, signal);

  let entries: ServerEntry[] = [];
  const pending: Promise<void>[] = [];
  const publish = () => {
    if (!signal?.aborted) options.onChange(entries);
  };
  const setStatus = (server: PlexServer, status: ServerStatus) => {
    entries = entries.map((entry) => (entry.server === server ? { ...entry, status } : entry));
    publish();
  };
  const isCurrent = (server: PlexServer) => !signal?.aborted && entries.some((entry) => entry.server === server);

  const connect = async (server: PlexServer) => {
    const prober = plexProber(context, server.accessToken);
    const remembered = options.remembered[server.clientIdentifier];
    const extraUrls = identities.filter((i) => i.machineIdentifier === server.clientIdentifier).map((i) => i.url);
    const full = selectConnection(server, connectionCandidates(server, extraUrls), prober);
    const quick = remembered ? await selectConnection(server, [{ ...remembered, tier: -2 }], prober) : null;
    if (quick && isCurrent(server)) setStatus(server, { state: 'online', connection: quick });

    const choice = preferred(quick, await full);
    if (!isCurrent(server)) return;
    if (choice !== quick || !quick) setStatus(server, choice ? { state: 'online', connection: choice } : { state: 'offline' });
    if (choice) options.onConnected?.(server.clientIdentifier, choice);
  };
  const add = (server: PlexServer) => {
    entries = [...entries, { server, status: { state: 'connecting' } }];
    pending.push(connect(server));
  };
  const addManual = () => {
    for (const identity of identities) {
      if (entries.some((entry) => entry.server.clientIdentifier === identity.machineIdentifier)) continue;
      add({
        name: new URL(identity.url).hostname,
        clientIdentifier: identity.machineIdentifier,
        accessToken: userToken,
        owned: false,
        connections: [],
      });
    }
  };

  if (cached.length > 0) {
    cached.forEach(add);
    addManual();
    publish();
    // Unreachable plex.tv keeps the cached list; a revoked token is the session's business.
    const servers = await fresh.catch(() => null);
    if (servers && !signal?.aborted) {
      const listed = (server: PlexServer) => servers.some((next) => next.clientIdentifier === server.clientIdentifier);
      const manualOnly = (server: PlexServer) =>
        identities.some((identity) => identity.machineIdentifier === server.clientIdentifier) && !listed(server);
      const before = entries;
      entries = entries.filter(({ server }) => servers.some((next) => sameServer(next, server)) || manualOnly(server));
      for (const server of servers) {
        if (!entries.some((entry) => entry.server.clientIdentifier === server.clientIdentifier)) add(server);
      }
      if (entries.length !== before.length || entries.some((entry, i) => entry !== before[i])) publish();
      options.onServers?.(servers);
    }
  } else {
    const servers = await fresh;
    servers.forEach(add);
    addManual();
    publish();
    options.onServers?.(servers);
  }

  await Promise.all(pending);
  return entries;
}
