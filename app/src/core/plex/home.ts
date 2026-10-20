import { type PlexContext, CLIENTS_API, PlexHttpError, requestAccountApi, requestJson } from './client';

export interface HomeUser {
  uuid: string;
  title: string;
  thumb?: string;
  admin: boolean;
  restricted: boolean;
  guest: boolean;
  /** A PIN is required to switch to this user. */
  protected: boolean;
}

interface HomeUsersResponse {
  users?: {
    uuid?: string;
    title?: string;
    friendlyName?: string;
    username?: string;
    thumb?: string;
    admin?: boolean | number;
    restricted?: boolean | number;
    guest?: boolean | number;
    protected?: boolean | number;
  }[];
}

/** Lists the Plex Home users of an account. Accounts without Plex Home return just themselves. */
export async function fetchHomeUsers(context: PlexContext, accountToken: string): Promise<HomeUser[]> {
  const response = await requestAccountApi<HomeUsersResponse>(context, '/home/users', { token: accountToken });
  return (response.users ?? [])
    .filter((user) => user.uuid)
    .map((user) => ({
      uuid: user.uuid!,
      title: user.friendlyName?.trim() || user.title?.trim() || user.username || '',
      thumb: user.thumb || undefined,
      admin: Boolean(user.admin),
      restricted: Boolean(user.restricted),
      guest: Boolean(user.guest),
      protected: Boolean(user.protected),
    }));
}

export class WrongPinError extends Error {
  constructor() {
    super('Wrong Plex Home PIN');
  }
}

/** Mints a token for a Plex Home user. Server access tokens must be re-fetched with it afterwards. */
export async function switchHomeUser(
  context: PlexContext,
  accountToken: string,
  uuid: string,
  pin?: string,
): Promise<string> {
  const params = new URLSearchParams({ includeSettings: '1' });
  if (pin) params.set('pin', pin);
  try {
    const response = await requestJson<{ authToken?: string }>(
      context,
      `${CLIENTS_API}/home/users/${encodeURIComponent(uuid)}/switch?${params}`,
      { method: 'POST', token: accountToken },
    );
    if (!response.authToken) throw new Error('Plex Home switch returned no token');
    return response.authToken;
  } catch (error) {
    if (pin && error instanceof PlexHttpError && error.isAuthError) throw new WrongPinError();
    throw error;
  }
}
