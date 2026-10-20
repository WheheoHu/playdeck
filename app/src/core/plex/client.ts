import type { AppInfo } from '../../../shared/bridge';

export const PRODUCT = 'PlayDeck';
export const PLEX_TV = 'https://plex.tv/api/v2';
export const CLIENTS_API = 'https://clients.plex.tv/api/v2';

/** Everything a Plex request needs besides its URL: who we are, and how to fetch. */
export interface PlexContext {
  app: AppInfo;
  fetch: typeof fetch;
}

export class PlexHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`Plex request failed: HTTP ${status} for ${url}`);
  }

  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export function plexHeaders(context: PlexContext, token?: string): Record<string, string> {
  const { app } = context;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Plex-Product': PRODUCT,
    'X-Plex-Version': app.version,
    'X-Plex-Client-Identifier': app.clientIdentifier,
    'X-Plex-Platform': app.platform,
    'X-Plex-Platform-Version': app.platformVersion,
    'X-Plex-Device': app.device,
    'X-Plex-Device-Name': app.deviceName,
    'X-Plex-Provides': 'player',
  };
  if (token) headers['X-Plex-Token'] = token;
  return headers;
}

/** The URL without its query string, so tokens passed as parameters never reach logs or errors. */
export function redactUrl(url: string): string {
  return url.split('?')[0];
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  token?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function requestJson<T>(context: PlexContext, url: string, options: RequestOptions = {}): Promise<T> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  const response = await context.fetch(url, {
    method: options.method ?? 'GET',
    headers: plexHeaders(context, options.token),
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  });
  if (!response.ok) throw new PlexHttpError(response.status, redactUrl(url));
  const text = await response.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/** clients.plex.tv is the current account API; plex.tv serves the same paths when it is unreachable. */
export async function requestAccountApi<T>(context: PlexContext, path: string, options: RequestOptions = {}): Promise<T> {
  try {
    return await requestJson<T>(context, `${CLIENTS_API}${path}`, options);
  } catch (error) {
    if (error instanceof PlexHttpError || options.signal?.aborted) throw error;
    return requestJson<T>(context, `${PLEX_TV}${path}`, options);
  }
}
