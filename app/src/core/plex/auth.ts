import type { PlexAccount } from '../../../shared/bridge';
import { type PlexContext, PLEX_TV, PRODUCT, PlexHttpError, requestJson } from './client';

export const LINK_URL = 'https://plex.tv/link';

export interface PlexPin {
  id: number;
  code: string;
  expiresAt: number;
}

export class PinExpiredError extends Error {
  constructor() {
    super('Plex PIN expired');
  }
}

interface PinResponse {
  id: number;
  code: string;
  expiresIn?: number;
  expiresAt?: string;
  authToken?: string | null;
}

/**
 * A strong PIN is a long code meant for the Plex auth app URL (the QR code); a short PIN is a
 * four-character code the user types at plex.tv/link.
 */
export async function createPin(context: PlexContext, strong: boolean, now = Date.now()): Promise<PlexPin> {
  const pin = await requestJson<PinResponse>(context, `${PLEX_TV}/pins${strong ? '?strong=true' : ''}`, {
    method: 'POST',
  });
  const expiresAt = pin.expiresAt ? Date.parse(pin.expiresAt) : now + (pin.expiresIn ?? 900) * 1000;
  return { id: pin.id, code: pin.code, expiresAt };
}

export function authAppUrl(context: PlexContext, code: string): string {
  const params = new URLSearchParams({
    clientID: context.app.clientIdentifier,
    code,
    'context[device][product]': PRODUCT,
  });
  return `https://app.plex.tv/auth#?${params}`;
}

/** Returns the account token once the PIN has been claimed, or null while it is still pending. */
export async function checkPin(context: PlexContext, pin: PlexPin, signal?: AbortSignal): Promise<string | null> {
  try {
    const result = await requestJson<PinResponse>(context, `${PLEX_TV}/pins/${pin.id}`, { signal });
    return result.authToken || null;
  } catch (error) {
    if (error instanceof PlexHttpError && (error.status === 404 || error.status === 410)) throw new PinExpiredError();
    throw error;
  }
}

interface UserResponse {
  uuid: string;
  username?: string;
  title?: string;
  thumb?: string;
}

/** Validates an account token and returns the account it belongs to. */
export async function fetchAccount(context: PlexContext, token: string): Promise<PlexAccount> {
  const user = await requestJson<UserResponse>(context, `${PLEX_TV}/user`, { token });
  const username = user.username ?? user.title ?? '';
  return { uuid: user.uuid, username, title: user.title || username, thumb: user.thumb, token };
}
