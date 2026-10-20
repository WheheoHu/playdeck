import { describe, expect, it, vi } from 'vitest';
import type { PlexServer } from '../shared/bridge';
import { parseServers } from '../src/core/plex/servers';
import { type ServerEntry, connectServers, libraryServerOf } from '../src/core/serverRegistry';
import { fakeFetch } from './support';

const RESOURCES = [
  {
    name: 'Home',
    clientIdentifier: 'machine-1',
    accessToken: 'server-token',
    provides: 'server',
    owned: true,
    connections: [
      { uri: 'https://lan.plex.direct:32400', protocol: 'https', address: '192.168.1.10', port: 32400, local: true },
      { uri: 'https://wan.plex.direct:32400', protocol: 'https', address: '203.0.113.5', port: 32400, local: false },
    ],
  },
  { name: 'Phone', clientIdentifier: 'phone', accessToken: 't', provides: 'player', connections: [] },
];

const IDENTITY = { MediaContainer: { machineIdentifier: 'machine-1' } };

function routes(lanReachable: boolean) {
  return fakeFetch([
    ['GET', /\/resources\?/, () => ({ body: RESOURCES })],
    ['GET', /^https:\/\/wan\.plex\.direct:32400\/$/, () => ({ body: IDENTITY })],
    ['GET', /^https:\/\/lan\.plex\.direct:32400\/$/, () => (lanReachable ? { body: IDENTITY } : new TypeError('unreachable'))],
    ['GET', /^http:\/\/192\.168\.1\.10:32400\/$/, () => (lanReachable ? { body: IDENTITY } : new TypeError('unreachable'))],
  ]);
}

describe('connectServers', () => {
  it('connects every server and exposes it as a library server', async () => {
    const fake = routes(true);
    const connected: string[] = [];
    const entries = await connectServers(fake.context, 'user-token', {
      manual: [],
      remembered: {},
      onChange: () => {},
      onConnected: (id, connection) => connected.push(`${id}=${connection.url}`),
    });
    expect(entries).toHaveLength(1);
    expect(libraryServerOf(entries[0])).toEqual({
      id: 'machine-1',
      name: 'Home',
      baseUrl: 'https://lan.plex.direct:32400',
      token: 'server-token',
    });
    expect(connected).toEqual(['machine-1=https://lan.plex.direct:32400']);
  });

  it('comes online through the remembered connection, then upgrades to the LAN', async () => {
    const fake = routes(true);
    const updates: ServerEntry['status'][] = [];
    const entries = await connectServers(fake.context, 'user-token', {
      manual: [],
      remembered: { 'machine-1': { url: 'https://wan.plex.direct:32400', networkClass: 'remote' } },
      onChange: (list) => updates.push(list[0].status),
    });
    const urls = updates.flatMap((status) => (status.state === 'online' ? [status.connection.url] : [status.state]));
    expect(urls).toEqual(['connecting', 'https://wan.plex.direct:32400', 'https://lan.plex.direct:32400']);
    expect(libraryServerOf(entries[0])?.baseUrl).toBe('https://lan.plex.direct:32400');
  });

  it('starts from the cached list without waiting for plex.tv, then applies its answer', async () => {
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const fake = fakeFetch([
      ['GET', /\/resources\?/, async () => (await answered, { body: RESOURCES })],
      ['GET', /^https:\/\/wan\.plex\.direct:32400\/$/, () => ({ body: IDENTITY })],
      ['GET', /./, () => new TypeError('unreachable')],
    ]);
    const gone: PlexServer = { name: 'Old', clientIdentifier: 'gone', accessToken: 't', owned: false, connections: [] };
    const snapshots: string[][] = [];
    let stored: PlexServer[] | undefined;
    const done = connectServers(fake.context, 'user-token', {
      manual: [],
      remembered: { 'machine-1': { url: 'https://wan.plex.direct:32400', networkClass: 'remote' } },
      cached: [...parseServers(RESOURCES), gone],
      onChange: (list) => snapshots.push(list.map((entry) => `${entry.server.clientIdentifier}:${entry.status.state}`)),
      onServers: (servers) => {
        stored = servers;
      },
    });
    await vi.waitFor(() => expect(snapshots.at(-1)).toContain('machine-1:online'));
    expect(stored).toBeUndefined();

    answer();
    const entries = await done;
    expect(entries.map((entry) => entry.server.clientIdentifier)).toEqual(['machine-1']);
    expect(libraryServerOf(entries[0])?.baseUrl).toBe('https://wan.plex.direct:32400');
    expect(stored?.map((server) => server.clientIdentifier)).toEqual(['machine-1']);
  });

  it('keeps the cached list when plex.tv is unreachable', async () => {
    const fake = fakeFetch([
      ['GET', /\/resources\?/, () => new TypeError('offline')],
      ['GET', /^https:\/\/wan\.plex\.direct:32400\/$/, () => ({ body: IDENTITY })],
      ['GET', /./, () => new TypeError('unreachable')],
    ]);
    const entries = await connectServers(fake.context, 'user-token', {
      manual: [],
      remembered: {},
      cached: parseServers(RESOURCES),
      onChange: () => {},
    });
    expect(libraryServerOf(entries[0])?.baseUrl).toBe('https://wan.plex.direct:32400');
  });

  it('keeps a working remembered connection when the LAN is unreachable', async () => {
    const fake = routes(false);
    const entries = await connectServers(fake.context, 'user-token', {
      manual: [],
      remembered: { 'machine-1': { url: 'https://wan.plex.direct:32400', networkClass: 'remote' } },
      onChange: () => {},
    });
    expect(libraryServerOf(entries[0])?.baseUrl).toBe('https://wan.plex.direct:32400');
  });
});
