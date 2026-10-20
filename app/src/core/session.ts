import type { Credentials, PlexAccount, PlexUserSession } from '../../shared/bridge';
import { fetchAccount } from './plex/auth';
import { type PlexContext, PlexHttpError } from './plex/client';
import { type HomeUser, fetchHomeUsers, switchHomeUser } from './plex/home';

export interface Session {
  account: PlexAccount;
  user: PlexUserSession;
  /** Empty when the account has no Plex Home or the list could not be fetched. */
  homeUsers: HomeUser[];
}

export type RestoredSession =
  | { kind: 'signed-out' }
  | { kind: 'choose-user'; account: PlexAccount; users: HomeUser[] }
  | { kind: 'ready'; session: Session };

export function accountAsUser(account: PlexAccount): PlexUserSession {
  return { uuid: account.uuid, title: account.title, thumb: account.thumb, token: account.token };
}

/** After sign-in, or with no remembered user: pick a Plex Home user only if there is a choice to make. */
export async function afterSignIn(context: PlexContext, account: PlexAccount): Promise<RestoredSession> {
  const users = await fetchHomeUsers(context, account.token).catch(() => []);
  if (users.length > 1) return { kind: 'choose-user', account, users };
  return { kind: 'ready', session: { account, user: accountAsUser(account), homeUsers: users } };
}

/**
 * Revalidates stored credentials. A rejected token signs out; an unreachable plex.tv keeps the stored
 * session so the app still works when only the servers are reachable.
 */
export async function restoreSession(context: PlexContext, credentials: Credentials): Promise<RestoredSession> {
  if (!credentials.account) return { kind: 'signed-out' };
  let account: PlexAccount;
  try {
    account = await fetchAccount(context, credentials.account.token);
  } catch (error) {
    if (error instanceof PlexHttpError && error.isAuthError) return { kind: 'signed-out' };
    const user = credentials.user ?? accountAsUser(credentials.account);
    return { kind: 'ready', session: { account: credentials.account, user, homeUsers: [] } };
  }

  const users = await fetchHomeUsers(context, account.token).catch(() => []);
  const remembered = credentials.user;
  if (remembered && (users.length === 0 || users.some((user) => user.uuid === remembered.uuid))) {
    return { kind: 'ready', session: { account, user: remembered, homeUsers: users } };
  }
  if (users.length > 1) return { kind: 'choose-user', account, users };
  return { kind: 'ready', session: { account, user: accountAsUser(account), homeUsers: users } };
}

export async function chooseHomeUser(
  context: PlexContext,
  account: PlexAccount,
  user: HomeUser,
  pin?: string,
): Promise<PlexUserSession> {
  if (user.uuid === account.uuid && !user.protected) return accountAsUser(account);
  const token = await switchHomeUser(context, account.token, user.uuid, pin);
  return { uuid: user.uuid, title: user.title, thumb: user.thumb, token };
}
