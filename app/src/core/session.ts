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

/** A remembered user starts without waiting on plex.tv; revalidateSession catches up afterwards. */
export function resumeSession(credentials: Credentials): Session | null {
  if (!credentials.account || !credentials.user) return null;
  return { account: credentials.account, user: credentials.user, homeUsers: credentials.homeUsers ?? [] };
}

/**
 * Checks stored credentials against plex.tv. A rejected token signs out; an unreachable plex.tv keeps
 * the stored session so the app still works when only the servers are reachable.
 */
export async function restoreSession(context: PlexContext, credentials: Credentials): Promise<RestoredSession> {
  if (!credentials.account) return { kind: 'signed-out' };
  const stored = credentials.account;
  const [account, users] = await Promise.allSettled([
    fetchAccount(context, stored.token),
    fetchHomeUsers(context, stored.token),
  ]);
  if (account.status === 'rejected') {
    const { reason } = account;
    if (reason instanceof PlexHttpError && reason.isAuthError) return { kind: 'signed-out' };
    const user = credentials.user ?? accountAsUser(stored);
    return { kind: 'ready', session: { account: stored, user, homeUsers: credentials.homeUsers ?? [] } };
  }

  const current = account.value;
  const homeUsers = users.status === 'fulfilled' ? users.value : (credentials.homeUsers ?? []);
  const remembered = credentials.user;
  if (remembered && (homeUsers.length === 0 || homeUsers.some((user) => user.uuid === remembered.uuid))) {
    return { kind: 'ready', session: { account: current, user: remembered, homeUsers } };
  }
  if (homeUsers.length > 1) return { kind: 'choose-user', account: current, users: homeUsers };
  return { kind: 'ready', session: { account: current, user: accountAsUser(current), homeUsers } };
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
