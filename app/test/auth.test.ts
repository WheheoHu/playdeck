import { describe, expect, it } from 'vitest';
import { PinExpiredError, authAppUrl, checkPin, createPin } from '../src/core/plex/auth';
import { runSignIn, type SignInState } from '../src/core/signIn';
import { fakeFetch } from './support';

describe('PIN sign-in', () => {
  it('creates strong and short PINs with identifying headers', async () => {
    const fake = fakeFetch([
      ['POST', /pins\?strong=true$/, () => ({ status: 201, body: { id: 1, code: 'longcode', expiresIn: 1800 } })],
      ['POST', /pins$/, () => ({ status: 201, body: { id: 2, code: 'AB12', expiresIn: 900 } })],
    ]);
    const strong = await createPin(fake.context, true, 1_000);
    const short = await createPin(fake.context, false, 1_000);
    expect(strong).toEqual({ id: 1, code: 'longcode', expiresAt: 1_801_000 });
    expect(short).toEqual({ id: 2, code: 'AB12', expiresAt: 901_000 });
    expect(fake.calls[0].headers).toMatchObject({
      'X-Plex-Product': 'PlayDeck',
      'X-Plex-Client-Identifier': 'test-client-id',
      'X-Plex-Device': 'Steam Deck OLED',
    });
  });

  it('builds the Plex auth app URL for the QR code', () => {
    const { context } = fakeFetch([]);
    expect(authAppUrl(context, 'longcode')).toBe(
      'https://app.plex.tv/auth#?clientID=test-client-id&code=longcode&context%5Bdevice%5D%5Bproduct%5D=PlayDeck',
    );
  });

  it('reports an expired PIN', async () => {
    const fake = fakeFetch([['GET', /pins\/7$/, () => ({ status: 404 })]]);
    await expect(checkPin(fake.context, { id: 7, code: 'X', expiresAt: 0 })).rejects.toBeInstanceOf(PinExpiredError);
  });

  it('signs in with whichever PIN is approved first and validates the token', async () => {
    let polls = 0;
    const fake = fakeFetch([
      ['POST', /pins\?strong=true$/, () => ({ status: 201, body: { id: 1, code: 'longcode', expiresIn: 1800 } })],
      ['POST', /pins$/, () => ({ status: 201, body: { id: 2, code: 'AB12', expiresIn: 900 } })],
      ['GET', /pins\/1$/, () => ({ body: { id: 1, code: 'longcode', authToken: null } })],
      ['GET', /pins\/2$/, () => ({ body: { id: 2, code: 'AB12', authToken: ++polls >= 2 ? 'account-token' : null } })],
      ['GET', /\/user$/, () => ({ body: { uuid: 'u1', username: 'alice', title: 'Alice' } })],
    ]);
    const states: SignInState[] = [];
    const account = await runSignIn(fake.context, (state) => states.push(state), new AbortController().signal, {
      sleep: async () => {},
    });
    expect(account).toEqual({ uuid: 'u1', username: 'alice', title: 'Alice', thumb: undefined, token: 'account-token' });
    expect(states.map((s) => s.status)).toEqual(['creating', 'waiting', 'signing-in']);
    expect(states[1]).toMatchObject({ linkCode: 'AB12' });
    const userCall = fake.calls.find((call) => call.url.endsWith('/user'));
    expect(userCall?.headers['X-Plex-Token']).toBe('account-token');
  });

  it('replaces expired PINs', async () => {
    let created = 0;
    const fake = fakeFetch([
      ['POST', /pins/, () => ({ status: 201, body: { id: ++created, code: `C${created}`, expiresIn: 900 } })],
      ['GET', /pins\/[12]$/, () => ({ status: 410 })],
      ['GET', /pins\/[34]$/, () => ({ body: { authToken: 'token' } })],
      ['GET', /\/user$/, () => ({ body: { uuid: 'u1', username: 'u' } })],
    ]);
    const states: SignInState[] = [];
    await runSignIn(fake.context, (state) => states.push(state), new AbortController().signal, { sleep: async () => {} });
    expect(states.filter((s) => s.status === 'waiting')).toHaveLength(2);
  });
});
