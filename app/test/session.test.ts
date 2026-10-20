import { describe, expect, it } from 'vitest';
import type { PlexAccount } from '../shared/bridge';
import { WrongPinError, fetchHomeUsers } from '../src/core/plex/home';
import { chooseHomeUser, restoreSession, resumeSession } from '../src/core/session';
import { fakeFetch } from './support';

const ACCOUNT: PlexAccount = { uuid: 'admin', username: 'admin', title: 'Admin', token: 'account-token' };
const HOME = {
  users: [
    { uuid: 'admin', title: 'Admin', admin: true, protected: false },
    { uuid: 'kid', title: 'kid', friendlyName: 'Kid', restricted: 1, protected: 1, thumb: 'https://plex.tv/kid.png' },
  ],
};

describe('Plex Home', () => {
  it('parses users, preferring friendly names and coercing flags', async () => {
    const fake = fakeFetch([['GET', /clients\.plex\.tv\/api\/v2\/home\/users$/, () => ({ body: HOME })]]);
    expect(await fetchHomeUsers(fake.context, 'account-token')).toEqual([
      { uuid: 'admin', title: 'Admin', thumb: undefined, admin: true, restricted: false, guest: false, protected: false },
      { uuid: 'kid', title: 'Kid', thumb: 'https://plex.tv/kid.png', admin: false, restricted: true, guest: false, protected: true },
    ]);
  });

  it('falls back to plex.tv when clients.plex.tv is unreachable', async () => {
    const fake = fakeFetch([
      ['GET', /clients\.plex\.tv/, () => new TypeError('network down')],
      ['GET', /^https:\/\/plex\.tv\/api\/v2\/home\/users$/, () => ({ body: HOME })],
    ]);
    expect(await fetchHomeUsers(fake.context, 'account-token')).toHaveLength(2);
  });

  it('switches with a PIN and maps a rejected PIN to WrongPinError', async () => {
    const fake = fakeFetch([
      ['POST', /home\/users\/kid\/switch\?.*pin=1234/, () => ({ body: { authToken: 'kid-token' } })],
      ['POST', /home\/users\/kid\/switch\?.*pin=0000/, () => ({ status: 401 })],
    ]);
    const kid = { uuid: 'kid', title: 'Kid', admin: false, restricted: true, guest: false, protected: true };
    expect(await chooseHomeUser(fake.context, ACCOUNT, kid, '1234')).toEqual({
      uuid: 'kid',
      title: 'Kid',
      thumb: undefined,
      token: 'kid-token',
    });
    await expect(chooseHomeUser(fake.context, ACCOUNT, kid, '0000')).rejects.toBeInstanceOf(WrongPinError);
  });

  it('uses the account token for an unprotected admin without calling switch', async () => {
    const fake = fakeFetch([]);
    const admin = { uuid: 'admin', title: 'Admin', admin: true, restricted: false, guest: false, protected: false };
    expect((await chooseHomeUser(fake.context, ACCOUNT, admin)).token).toBe('account-token');
    expect(fake.calls).toHaveLength(0);
  });
});

describe('resumeSession', () => {
  it('resumes a remembered user from storage alone', () => {
    const user = { uuid: 'kid', title: 'Kid', token: 'kid-token' };
    expect(resumeSession({ account: ACCOUNT, user })).toEqual({ account: ACCOUNT, user, homeUsers: [] });
  });

  it('needs a remembered user', () => {
    expect(resumeSession({ account: ACCOUNT })).toBeNull();
  });
});

describe('restoreSession', () => {
  it('signs out when plex.tv rejects the stored token', async () => {
    const fake = fakeFetch([['GET', /\/user$/, () => ({ status: 401 })]]);
    expect(await restoreSession(fake.context, { account: ACCOUNT })).toEqual({ kind: 'signed-out' });
  });

  it('keeps the stored session when plex.tv is unreachable', async () => {
    const fake = fakeFetch([['GET', /\/user$/, () => new TypeError('offline')]]);
    const user = { uuid: 'kid', title: 'Kid', token: 'kid-token' };
    expect(await restoreSession(fake.context, { account: ACCOUNT, user })).toEqual({
      kind: 'ready',
      session: { account: ACCOUNT, user, homeUsers: [] },
    });
  });

  it('asks who is watching when there is no remembered user in a Plex Home', async () => {
    const fake = fakeFetch([
      ['GET', /\/user$/, () => ({ body: { uuid: 'admin', username: 'admin', title: 'Admin' } })],
      ['GET', /home\/users$/, () => ({ body: HOME })],
    ]);
    const restored = await restoreSession(fake.context, { account: ACCOUNT });
    expect(restored.kind).toBe('choose-user');
  });

  it('resumes as the remembered user', async () => {
    const fake = fakeFetch([
      ['GET', /\/user$/, () => ({ body: { uuid: 'admin', username: 'admin', title: 'Admin' } })],
      ['GET', /home\/users$/, () => ({ body: HOME })],
    ]);
    const user = { uuid: 'kid', title: 'Kid', token: 'kid-token' };
    const restored = await restoreSession(fake.context, { account: ACCOUNT, user });
    expect(restored).toMatchObject({ kind: 'ready', session: { user } });
  });
});
