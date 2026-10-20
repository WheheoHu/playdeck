import type { AppInfo } from '../shared/bridge';
import type { PlexContext } from '../src/core/plex/client';

export const APP: AppInfo = {
  version: '0.1.0-test',
  platform: 'Linux',
  platformVersion: '7.2.7',
  device: 'Steam Deck OLED',
  deviceName: 'steamdeck',
  clientIdentifier: 'test-client-id',
  locale: 'en-US',
};

type Reply = { status?: number; body?: unknown } | Error;
type Route = [method: string, pattern: RegExp, reply: (url: URL, init: RequestInit) => Reply | Promise<Reply>];

export interface FakeFetch {
  context: PlexContext;
  calls: { method: string; url: string; headers: Record<string, string> }[];
}

/** A fetch that answers from routes, matched in order against "METHOD url". Unmatched requests fail. */
export function fakeFetch(routes: Route[]): FakeFetch {
  const calls: FakeFetch['calls'] = [];
  const impl = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    calls.push({ method, url: url.toString(), headers: (init.headers ?? {}) as Record<string, string> });
    if (init.signal?.aborted) throw init.signal.reason;
    const route = routes.find(([m, pattern]) => m === method && pattern.test(url.toString()));
    if (!route) throw new TypeError(`fetch failed: no route for ${method} ${url}`);
    const reply = await route[2](url, init);
    if (reply instanceof Error) throw reply;
    return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), { status: reply.status ?? 200 });
  };
  return { context: { app: APP, fetch: impl as typeof fetch }, calls };
}
