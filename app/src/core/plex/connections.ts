import { type PlexContext, PlexHttpError, requestJson } from './client';
import type { PlexConnection, PlexServer } from './servers';

export type NetworkClass = 'local' | 'remote';

export interface ConnectionCandidate {
  url: string;
  networkClass: NetworkClass;
  /** Lower is preferred: local before remote, IPv4 before IPv6, HTTPS before HTTP. */
  tier: number;
}

export interface ConnectionChoice {
  url: string;
  networkClass: NetworkClass;
  latencyMs: number;
}

function hostOf(connection: PlexConnection): string {
  return connection.ipv6 ? `[${connection.address}]` : connection.address;
}

/**
 * Relay connections are excluded: plex.tv's relay is bandwidth-capped and cannot sustain Direct Play.
 * A cleartext fallback is synthesized only for LAN connections, so a token never crosses the internet
 * unencrypted unless the server itself publishes a plain-HTTP remote endpoint.
 */
export function connectionCandidates(server: PlexServer, extraUrls: string[] = []): ConnectionCandidate[] {
  const candidates: ConnectionCandidate[] = [];
  const seen = new Set<string>();
  const add = (url: string, networkClass: NetworkClass, tier: number) => {
    if (seen.has(url)) return;
    seen.add(url);
    candidates.push({ url, networkClass, tier });
  };

  for (const url of extraUrls) add(url.replace(/\/$/, ''), 'remote', -1);
  for (const connection of server.connections) {
    if (connection.relay) continue;
    const ipv6 = connection.ipv6 ? 1 : 0;
    if (connection.local) {
      add(connection.uri, 'local', connection.protocol === 'https' ? 2 * ipv6 : 1 + 2 * ipv6);
      if (connection.protocol === 'https') add(`http://${hostOf(connection)}:${connection.port}`, 'local', 1 + 2 * ipv6);
    } else {
      add(connection.uri, 'remote', (connection.protocol === 'https' ? 4 : 6) + ipv6);
    }
  }
  return candidates.sort((a, b) => a.tier - b.tier);
}

/** Probes the authenticated root, which proves reachability, token validity and server identity at once. */
export type Prober = (url: string, signal: AbortSignal) => Promise<string | undefined>;

export function plexProber(context: PlexContext, token: string): Prober {
  return async (url, signal) => {
    const root = await requestJson<{ MediaContainer?: { machineIdentifier?: string } }>(context, `${url}/`, {
      token,
      signal,
      timeoutMs: 60_000,
    });
    return root.MediaContainer?.machineIdentifier;
  };
}

export interface SelectOptions {
  timeoutMs?: Record<NetworkClass, number>;
  now?: () => number;
}

// A LAN server answers within tens of milliseconds; a short local timeout bounds how long being away
// from home delays the remote connection.
const DEFAULT_TIMEOUTS: Record<NetworkClass, number> = { local: 1500, remote: 6000 };

/**
 * Probes all candidates concurrently. A success is accepted as soon as every candidate in a better
 * tier has failed, so an unreachable LAN address never delays a working remote one by more than its
 * own timeout, and a working LAN address always wins over a faster remote reply.
 */
export function selectConnection(
  server: Pick<PlexServer, 'clientIdentifier'>,
  candidates: ConnectionCandidate[],
  probe: Prober,
  options: SelectOptions = {},
): Promise<ConnectionChoice | null> {
  const timeouts = options.timeoutMs ?? DEFAULT_TIMEOUTS;
  const now = options.now ?? (() => performance.now());
  if (candidates.length === 0) return Promise.resolve(null);

  return new Promise((resolve) => {
    const controllers = candidates.map(() => new AbortController());
    const outcome: ({ ok: true; latencyMs: number } | { ok: false } | undefined)[] = candidates.map(() => undefined);
    let done = false;

    const finish = (choice: ConnectionChoice | null) => {
      if (done) return;
      done = true;
      controllers.forEach((controller) => controller.abort());
      resolve(choice);
    };

    const decide = () => {
      let best: { index: number; latencyMs: number } | null = null;
      for (let index = 0; index < outcome.length; index++) {
        const result = outcome[index];
        if (!result?.ok) continue;
        const better =
          !best ||
          candidates[index].tier < candidates[best.index].tier ||
          (candidates[index].tier === candidates[best.index].tier && result.latencyMs < best.latencyMs);
        if (better) best = { index, latencyMs: result.latencyMs };
      }
      if (best) {
        const { index, latencyMs } = best;
        const betterPending = candidates.some((c, j) => c.tier < candidates[index].tier && outcome[j] === undefined);
        if (!betterPending) {
          const winner = candidates[index];
          finish({ url: winner.url, networkClass: winner.networkClass, latencyMs: Math.round(latencyMs) });
        }
        return;
      }
      if (outcome.every((result) => result !== undefined)) finish(null);
    };

    candidates.forEach((candidate, i) => {
      const signal = AbortSignal.any([controllers[i].signal, AbortSignal.timeout(timeouts[candidate.networkClass])]);
      const started = now();
      probe(candidate.url, signal)
        .then((machineIdentifier) => {
          outcome[i] =
            machineIdentifier === server.clientIdentifier ? { ok: true, latencyMs: now() - started } : { ok: false };
        })
        .catch(() => {
          outcome[i] = { ok: false };
        })
        .finally(() => !done && decide());
    });
  });
}

export function isTokenRejected(error: unknown): boolean {
  return error instanceof PlexHttpError && error.isAuthError;
}
