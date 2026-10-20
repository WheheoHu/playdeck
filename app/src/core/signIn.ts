import type { PlexAccount } from '../../shared/bridge';
import { type PlexPin, PinExpiredError, authAppUrl, checkPin, createPin, fetchAccount } from './plex/auth';
import type { PlexContext } from './plex/client';

export type SignInState =
  | { status: 'creating' }
  | { status: 'waiting'; linkCode: string; qrUrl: string; expiresAt: number }
  | { status: 'signing-in' };

export interface SignInOptions {
  initialIntervalMs?: number;
  maxIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** Returns a token if either PIN was claimed; throws PinExpiredError if one of them has expired. */
async function pollPins(context: PlexContext, pins: PlexPin[], signal: AbortSignal): Promise<string | null> {
  for (const pin of pins) {
    try {
      const token = await checkPin(context, pin, signal);
      if (token) return token;
    } catch (error) {
      if (error instanceof PinExpiredError || signal.aborted) throw error;
      // A dropped poll is inconclusive: the user may still be approving on their phone.
    }
  }
  return null;
}

/**
 * Shows two ways to sign in at once: a QR code for the Plex auth app (strong PIN) and a short code for
 * plex.tv/link. Whichever is approved first wins. Expired codes are replaced until the signal aborts.
 */
export async function runSignIn(
  context: PlexContext,
  onState: (state: SignInState) => void,
  signal: AbortSignal,
  options: SignInOptions = {},
): Promise<PlexAccount> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const initialInterval = options.initialIntervalMs ?? 1000;
  const maxInterval = options.maxIntervalMs ?? 3000;

  for (;;) {
    onState({ status: 'creating' });
    const [strong, short] = await Promise.all([createPin(context, true), createPin(context, false)]);
    const expiresAt = Math.min(strong.expiresAt, short.expiresAt);
    onState({ status: 'waiting', linkCode: short.code, qrUrl: authAppUrl(context, strong.code), expiresAt });

    let interval = initialInterval;
    while (now() < expiresAt) {
      await sleep(interval, signal);
      interval = Math.min(interval * 1.5, maxInterval);
      let token: string | null;
      try {
        token = await pollPins(context, [strong, short], signal);
      } catch (error) {
        if (error instanceof PinExpiredError) break;
        throw error;
      }
      if (token) {
        onState({ status: 'signing-in' });
        return fetchAccount(context, token);
      }
    }
  }
}
