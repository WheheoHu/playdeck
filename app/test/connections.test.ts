import { describe, expect, it } from 'vitest';
import { type Prober, connectionCandidates, selectConnection } from '../src/core/plex/connections';
import type { PlexConnection, PlexServer } from '../src/core/plex/servers';

function connection(overrides: Partial<PlexConnection>): PlexConnection {
  return {
    uri: 'https://192-168-1-10.abc.plex.direct:32400',
    protocol: 'https',
    address: '192.168.1.10',
    port: 32400,
    local: true,
    relay: false,
    ipv6: false,
    ...overrides,
  };
}

const SERVER: PlexServer = {
  name: 'Home',
  clientIdentifier: 'machine-1',
  accessToken: 'server-token',
  owned: true,
  connections: [
    connection({ uri: 'https://203-0-113-5.abc.plex.direct:32400', address: '203.0.113.5', local: false }),
    connection({}),
    connection({ uri: 'https://relay.plex.direct:8443', address: '10.0.0.1', port: 8443, local: false, relay: true }),
    connection({ uri: 'https://ipv6.abc.plex.direct:32400', address: 'fd00::10', ipv6: true }),
  ],
};

describe('connectionCandidates', () => {
  it('orders local before remote, adds a LAN-only HTTP fallback and drops relays', () => {
    expect(connectionCandidates(SERVER).map((c) => [c.url, c.networkClass, c.tier])).toEqual([
      ['https://192-168-1-10.abc.plex.direct:32400', 'local', 0],
      ['http://192.168.1.10:32400', 'local', 1],
      ['https://ipv6.abc.plex.direct:32400', 'local', 2],
      ['http://[fd00::10]:32400', 'local', 3],
      ['https://203-0-113-5.abc.plex.direct:32400', 'remote', 4],
    ]);
  });

  it('never synthesizes cleartext fallbacks for remote connections', () => {
    const remoteOnly = { ...SERVER, connections: [SERVER.connections[0]] };
    expect(connectionCandidates(remoteOnly).map((c) => c.url)).toEqual(['https://203-0-113-5.abc.plex.direct:32400']);
  });

  it('tries manually added addresses first', () => {
    expect(connectionCandidates(SERVER, ['http://example.com:32400/'])[0]).toEqual({
      url: 'http://example.com:32400',
      networkClass: 'remote',
      tier: -1,
    });
  });
});

type Behaviour = { after: number; result: 'ok' | 'fail' | 'other-server' | 'hang' };

/** Fake prober on a manual clock: each URL resolves after its delay. */
function scriptedProber(behaviours: Record<string, Behaviour>) {
  let clock = 0;
  const prober: Prober = (url, signal) =>
    new Promise((resolve, reject) => {
      const behaviour = behaviours[url];
      if (behaviour.result === 'hang') {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
        return;
      }
      setTimeout(() => {
        clock = Math.max(clock, behaviour.after);
        if (behaviour.result === 'fail') reject(new Error('unreachable'));
        else resolve(behaviour.result === 'ok' ? 'machine-1' : 'machine-2');
      }, behaviour.after);
    });
  return { prober, now: () => clock };
}

describe('selectConnection', () => {
  const candidates = connectionCandidates(SERVER);
  const [localHttps, localHttp, localV6, localV6Http, remote] = candidates.map((c) => c.url);

  it('prefers a working LAN connection over a faster remote one', async () => {
    const { prober, now } = scriptedProber({
      [localHttps]: { after: 40, result: 'ok' },
      [localHttp]: { after: 30, result: 'ok' },
      [localV6]: { after: 20, result: 'fail' },
      [localV6Http]: { after: 20, result: 'fail' },
      [remote]: { after: 5, result: 'ok' },
    });
    const choice = await selectConnection(SERVER, candidates, prober, { now });
    expect(choice?.url).toBe(localHttps);
    expect(choice?.networkClass).toBe('local');
  });

  it('does not wait for slower candidates once the best tier has answered', async () => {
    const { prober, now } = scriptedProber({
      [localHttps]: { after: 10, result: 'ok' },
      [localHttp]: { after: 10, result: 'hang' },
      [localV6]: { after: 10, result: 'hang' },
      [localV6Http]: { after: 10, result: 'hang' },
      [remote]: { after: 10, result: 'hang' },
    });
    const choice = await selectConnection(SERVER, candidates, prober, { now });
    expect(choice?.url).toBe(localHttps);
  });

  it('falls back to remote when every LAN candidate fails, and rejects other servers', async () => {
    const { prober, now } = scriptedProber({
      [localHttps]: { after: 10, result: 'other-server' },
      [localHttp]: { after: 10, result: 'fail' },
      [localV6]: { after: 10, result: 'fail' },
      [localV6Http]: { after: 10, result: 'fail' },
      [remote]: { after: 30, result: 'ok' },
    });
    const choice = await selectConnection(SERVER, candidates, prober, { now });
    expect(choice).toEqual({ url: remote, networkClass: 'remote', latencyMs: 30 });
  });

  it('times out unreachable candidates and reports the server offline', async () => {
    const { prober } = scriptedProber(Object.fromEntries(candidates.map((c) => [c.url, { after: 0, result: 'hang' }])));
    const choice = await selectConnection(SERVER, candidates, prober, { timeoutMs: { local: 20, remote: 30 } });
    expect(choice).toBeNull();
  });
});
