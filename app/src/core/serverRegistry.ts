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
  /** Receives a fresh array whenever any server's status changes. */
  onChange: (entries: ServerEntry[]) => void;
  onConnected?: (serverId: string, connection: ConnectionChoice) => void;
  signal?: AbortSignal;
}

/**
 * Discovers the user's servers and connects to each in parallel. A server's remembered connection is
 * tried on its own first so it comes online without waiting for the full selection, which still runs
 * and can upgrade it. Manually added addresses are tried before published ones.
 */
export async function connectServers(context: PlexContext, userToken: string, options: ConnectOptions): Promise<ServerEntry[]> {
  const { signal } = options;
  const [servers, identities] = await Promise.all([
    fetchServers(context, userToken, signal),
    identify(context, options.manual, signal),
  ]);

  for (const identity of identities) {
    if (servers.some((server) => server.clientIdentifier === identity.machineIdentifier)) continue;
    servers.push({
      name: new URL(identity.url).hostname,
      clientIdentifier: identity.machineIdentifier,
      accessToken: userToken,
      owned: false,
      connections: [],
    });
  }

  let entries: ServerEntry[] = servers.map((server) => ({ server, status: { state: 'connecting' } }));
  options.onChange(entries);
  const update = (index: number, status: ServerStatus) => {
    if (signal?.aborted) return;
    entries = entries.map((entry, i) => (i === index ? { ...entry, status } : entry));
    options.onChange(entries);
  };

  await Promise.all(
    servers.map(async (server, index) => {
      const prober = plexProber(context, server.accessToken);
      const remembered = options.remembered[server.clientIdentifier];
      const extraUrls = identities.filter((i) => i.machineIdentifier === server.clientIdentifier).map((i) => i.url);
      const full = selectConnection(server, connectionCandidates(server, extraUrls), prober);
      const quick = remembered
        ? await selectConnection(server, [{ ...remembered, tier: -2 }], prober)
        : null;
      if (quick) update(index, { state: 'online', connection: quick });

      const choice = preferred(quick, await full);
      if (choice !== quick || !quick) update(index, choice ? { state: 'online', connection: choice } : { state: 'offline' });
      if (choice && !signal?.aborted) options.onConnected?.(server.clientIdentifier, choice);
    }),
  );
  return entries;
}
