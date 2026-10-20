import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { connectServers } from '../../src/core/serverRegistry';
import { APP } from '../support';

// Runs only with `npm run test:live`, against the Plex account in the repository's .env.
const env = Object.fromEntries(
  readFileSync(new URL('../../../.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.includes('=') && !line.startsWith('#'))
    .map((line) => line.split(/=(.*)/s).slice(0, 2).map((part) => part.trim())),
);

const redact = (url: string) => url.replace(/\/\/([^.:/]+)[^:/]*/, (_, first: string) => `//${first.slice(0, 6)}…`);

describe('live Plex account', () => {
  it.each([
    ['published connections only', false],
    ['with the manual address from .env', true],
  ])('discovers servers and picks a direct connection (%s)', async (_label, withManual) => {
    const context = { app: { ...APP, clientIdentifier: 'playdeck-live-test' }, fetch };
    const manual = withManual && env.PLEX_URL ? [{ url: env.PLEX_URL }] : [];
    const started = performance.now();
    const entries = await connectServers(context, env.PLEX_TOKEN, { manual, remembered: {}, onChange: () => {} });
    const elapsed = Math.round(performance.now() - started);

    for (const { server, status } of entries) {
      const detail = status.state === 'online'
        ? `${status.connection.networkClass} ${status.connection.latencyMs} ms via ${redact(status.connection.url)}`
        : status.state;
      console.log(`${server.name} (${server.owned ? 'owned' : 'shared'}, ${server.connections.length} published): ${detail}`);
    }
    console.log(`all servers settled in ${elapsed} ms`);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((entry) => entry.status.state === 'online')).toBe(true);
  }, 30_000);
});
