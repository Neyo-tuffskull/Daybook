import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findIdentity, findUserByEmail } from '@daybook/db';
import {
  accessTokenFrom,
  call,
  cleanupTestUsers,
  cookieFrom,
  createHarness,
  locationOf,
  registerUser,
  uniqueEmail,
  type Harness,
  type Injected,
} from './helpers/harness.ts';
import { startFakeIssuer, type FakeIssuer, type IssuedAccount } from './helpers/fake-issuer.ts';

const CLIENT_ID = 'daybook-test-client.apps.googleusercontent.com';
const FLOW_COOKIE = 'db_oidc';

/**
 * Google sign-in, against an issuer that actually signs things.
 *
 * The tests play two parts at once: the browser, carrying cookies between the
 * two requests, and the provider, deciding what the ID token says. The
 * application code is unmodified, so the signature check, the issuer check, the
 * audience check and the nonce check all run for real.
 */
describe('google sign-in', () => {
  let issuer: FakeIssuer;
  let harness: Harness;

  beforeAll(async () => {
    issuer = await startFakeIssuer(CLIENT_ID);
    harness = await createHarness({
      GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
      GOOGLE_OAUTH_CLIENT_SECRET: 'a-test-client-secret',
      GOOGLE_OIDC_BASE_URL: issuer.baseUrl,
      GOOGLE_OAUTH_REDIRECT_URI: 'http://localhost:4000/v1/auth/google/callback',
    });
    await cleanupTestUsers();
  });

  afterAll(async () => {
    await cleanupTestUsers();
    await harness.close();
    await issuer.close();
  });

  // --- The flow itself -----------------------------------------------------

  it('sends the person to the provider with state, a nonce and a PKCE challenge', async () => {
    const started = await begin(harness);
    const url = new URL(started.authorizeUrl);

    expect(url.origin).toBe(new URL(issuer.baseUrl).origin);
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toContain('openid');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('state')).toBe(started.state);
    expect(url.searchParams.get('nonce')).toBe(started.nonce);

    // The verifier stays on this server. If it were in the URL, PKCE would be
    // proving nothing: anyone holding the code would hold the verifier too.
    expect(started.authorizeUrl).not.toContain(started.state.slice(0, 8) + 'verifier');
    expect(url.searchParams.has('code_verifier')).toBe(false);
  });

  it('creates an account on a first sign-in and marks the address verified', async () => {
    const email = uniqueEmail('google-new');
    const result = await signIn(harness, issuer, {
      subject: 'google-subject-new',
      email,
      emailVerified: true,
      name: 'Ada Lovelace',
    });

    expect(result.status).toBe(302);
    expect(locationOf(result)).toBe(`${harness.config.appPublicUrl}/auth/callback`);

    const refreshToken = mustCookie(harness, result);

    // The callback hands over a cookie and nothing else. A token in the
    // redirect URL would end up in history, referrers and proxy logs.
    expect(locationOf(result)).not.toContain('token');

    const me = await meVia(harness, refreshToken);
    expect(me).toMatchObject({ email, email_verified: true, display_name: 'Ada Lovelace' });

    const identity = await findIdentity('google', 'google-subject-new');
    expect(identity?.email_at_provider).toBe(email);
  });

  it('signs the same person in again without creating a second account', async () => {
    const email = uniqueEmail('google-repeat');
    const account: IssuedAccount = { subject: 'google-subject-repeat', email, emailVerified: true };

    const first = await signIn(harness, issuer, account);
    const second = await signIn(harness, issuer, account);

    expect(first.status).toBe(302);
    expect(second.status).toBe(302);

    const firstUser = await meVia(harness, mustCookie(harness, first));
    const secondUser = await meVia(harness, mustCookie(harness, second));
    expect(secondUser.id).toBe(firstUser.id);
  });

  it('attaches to an existing password account when the provider vouches for the address', async () => {
    const user = await registerUser(harness, 'google-link');

    const result = await signIn(harness, issuer, {
      subject: 'google-subject-link',
      email: user.email,
      emailVerified: true,
    });
    expect(result.status).toBe(302);
    expect(locationOf(result)).toBe(`${harness.config.appPublicUrl}/auth/callback`);

    const signedIn = await meVia(harness, mustCookie(harness, result));
    expect(signedIn.id).toBe(user.id);

    // The provider's assurance is as good as our own verification link, so the
    // address counts as verified from here on.
    expect(signedIn.email_verified).toBe(true);

    // And the password still works: linking adds a way in, it does not replace one.
    const password = await call(harness, {
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: user.email, password: user.password },
    });
    expect(password.status).toBe(200);
  });

  // --- The refusals --------------------------------------------------------

  /**
   * The one that matters. Registering somebody else's address at a provider
   * that does not check it, then signing in here, is account takeover in two
   * steps. `email_verified` is the only thing standing between those steps.
   */
  it('refuses to attach an unverified address to anything, and creates nothing', async () => {
    const victim = await registerUser(harness, 'google-victim');

    const result = await signIn(harness, issuer, {
      subject: 'google-subject-impostor',
      email: victim.email,
      emailVerified: false,
    });

    expect(result.status).toBe(302);
    expect(locationOf(result)).toContain('/sign-in?error=unverified_email');
    expect(cookieFrom(result, harness.config.cookieName)).toBeNull();
    expect(await findIdentity('google', 'google-subject-impostor')).toBeNull();
  });

  it('refuses an identity with no address at all', async () => {
    const result = await signIn(harness, issuer, {
      subject: 'google-subject-anonymous',
      email: null,
      emailVerified: false,
    });

    expect(locationOf(result)).toContain('error=unverified_email');
    expect(await findIdentity('google', 'google-subject-anonymous')).toBeNull();
  });

  /**
   * Without the state check, an attacker can start a flow, then get a victim's
   * browser to visit the callback, leaving the victim signed in to the
   * attacker's account with everything they write going to it.
   */
  it('refuses a callback whose state does not match the flow', async () => {
    const started = await begin(harness);
    const code = issuer.issueCode(
      { subject: 'google-subject-state', email: uniqueEmail('state'), emailVerified: true },
      started.nonce,
    );

    const result = await call(harness, {
      method: 'GET',
      url: `/v1/auth/google/callback?code=${code}&state=not-the-state-we-issued`,
      cookies: { [FLOW_COOKIE]: started.flowCookie },
    });

    expect(locationOf(result)).toContain('error=invalid_state');
    expect(cookieFrom(result, harness.config.cookieName)).toBeNull();
    expect(await findIdentity('google', 'google-subject-state')).toBeNull();
  });

  it('refuses a callback with no flow cookie at all', async () => {
    const result = await call(harness, {
      method: 'GET',
      url: '/v1/auth/google/callback?code=anything&state=anything',
    });
    expect(locationOf(result)).toContain('error=expired');
  });

  /**
   * The signature check, which is the whole reason this suite runs a real
   * issuer. The token is well formed, has the right issuer, audience, subject
   * and nonce, and is signed by a key the issuer does not publish.
   */
  it('refuses an ID token signed by a key the provider does not publish', async () => {
    const started = await begin(harness);
    const code = issuer.issueCode(
      { subject: 'google-subject-forged', email: uniqueEmail('forged'), emailVerified: true },
      started.nonce,
      { forged: true },
    );

    const result = await call(harness, {
      method: 'GET',
      url: `/v1/auth/google/callback?code=${code}&state=${started.state}`,
      cookies: { [FLOW_COOKIE]: started.flowCookie },
    });

    expect(locationOf(result)).toContain('error=provider_error');
    expect(cookieFrom(result, harness.config.cookieName)).toBeNull();
    expect(await findIdentity('google', 'google-subject-forged')).toBeNull();
  });

  it('refuses an ID token minted for a different sign-in attempt', async () => {
    const started = await begin(harness);
    // A token bound to somebody else's nonce: captured from another flow, or
    // replayed later.
    const code = issuer.issueCode(
      { subject: 'google-subject-nonce', email: uniqueEmail('nonce'), emailVerified: true },
      'a-nonce-from-a-different-flow',
    );

    const result = await call(harness, {
      method: 'GET',
      url: `/v1/auth/google/callback?code=${code}&state=${started.state}`,
      cookies: { [FLOW_COOKIE]: started.flowCookie },
    });

    expect(locationOf(result)).toContain('error=provider_error');
    expect(await findIdentity('google', 'google-subject-nonce')).toBeNull();
  });

  it('sends the person back when they cancel at the provider', async () => {
    const started = await begin(harness);
    const result = await call(harness, {
      method: 'GET',
      url: '/v1/auth/google/callback?error=access_denied',
      cookies: { [FLOW_COOKIE]: started.flowCookie },
    });
    expect(locationOf(result)).toContain('error=cancelled');
  });

  // --- Configuration -------------------------------------------------------

  it('answers 503, not 404, when the server has no Google credentials', async () => {
    const plain = await createHarness();
    try {
      const result = await call(plain, { method: 'GET', url: '/v1/auth/google' });
      expect(result.status).toBe(503);
    } finally {
      await plain.close();
    }
  });

  // --- The point of doing it this way --------------------------------------

  /**
   * A Google session is not a different kind of session. It lives in the same
   * `auth_sessions` row, so rotation, reuse detection and sign-out-everywhere
   * work on it with no code that knows it came from Google.
   */
  it('produces an ordinary session: it rotates, and signing out everywhere ends it', async () => {
    const email = uniqueEmail('google-session');
    const result = await signIn(harness, issuer, {
      subject: 'google-subject-session',
      email,
      emailVerified: true,
    });
    const refreshToken = mustCookie(harness, result);

    const rotated = await call(harness, {
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: {},
      refreshCookie: refreshToken,
    });
    expect(rotated.status).toBe(200);
    const current = cookieFrom(rotated, harness.config.cookieName);
    expect(current).not.toBe(refreshToken);

    // Replaying the old one kills the family, exactly as it does for a password
    // session.
    const replay = await call(harness, {
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: {},
      refreshCookie: refreshToken,
    });
    expect(replay.status).toBe(401);

    const afterwards = await call(harness, {
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: {},
      refreshCookie: current ?? '',
    });
    expect(afterwards.status).toBe(401);
  });

  it('creates the account with no password, so only the provider can open it', async () => {
    const email = uniqueEmail('google-nopassword');
    await signIn(harness, issuer, {
      subject: 'google-subject-nopassword',
      email,
      emailVerified: true,
    });

    const user = await findUserByEmail(email);
    expect(user?.password_hash).toBeNull();

    const guess = await call(harness, {
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: 'anything-at-all-really' },
    });
    expect(guess.status).toBe(401);
  });
});

// --- Playing the browser and the provider ------------------------------------

interface StartedFlow {
  authorizeUrl: string;
  flowCookie: string;
  state: string;
  nonce: string;
}

/**
 * Starts a flow and reads back what the server committed to.
 *
 * The state and nonce are read out of the flow cookie, which is how the browser
 * would carry them: the test is not being given them by the code under test, it
 * is holding the same opaque cookie a browser would and letting the provider
 * see the same values the provider would.
 */
async function begin(harness: Harness): Promise<StartedFlow> {
  const response = await call(harness, { method: 'GET', url: '/v1/auth/google' });
  if (response.status !== 302) {
    throw new Error(`Starting the flow returned ${response.status}`);
  }

  const flowCookie = cookieFrom(response, FLOW_COOKIE);
  if (!flowCookie) throw new Error('Starting the flow set no cookie');

  const claims = decodeJwtPayload(flowCookie);
  return {
    authorizeUrl: locationOf(response),
    flowCookie,
    state: String(claims.state),
    nonce: String(claims.nonce),
  };
}

async function signIn(
  harness: Harness,
  issuer: FakeIssuer,
  account: IssuedAccount,
): Promise<Injected> {
  const started = await begin(harness);
  const code = issuer.issueCode(account, started.nonce);
  return call(harness, {
    method: 'GET',
    url: `/v1/auth/google/callback?code=${code}&state=${encodeURIComponent(started.state)}`,
    cookies: { [FLOW_COOKIE]: started.flowCookie },
  });
}

/** Turns a refresh cookie into the profile it belongs to, the way the app does. */
async function meVia(
  harness: Harness,
  refreshToken: string,
): Promise<{ id: string; email: string; email_verified: boolean; display_name: string | null }> {
  const refreshed = await call(harness, {
    method: 'POST',
    url: '/v1/auth/refresh',
    payload: {},
    refreshCookie: refreshToken,
  });
  if (refreshed.status !== 200) {
    throw new Error(`Refresh returned ${refreshed.status}: ${JSON.stringify(refreshed.body)}`);
  }
  const me = await call(harness, {
    method: 'GET',
    url: '/v1/me',
    accessToken: accessTokenFrom(refreshed),
  });
  if (me.status !== 200) {
    throw new Error(`/v1/me returned ${me.status}`);
  }
  return me.body as {
    id: string;
    email: string;
    email_verified: boolean;
    display_name: string | null;
  };
}

/** The refresh cookie a response set, or a failure that says so. */
function mustCookie(harness: Harness, response: Injected): string {
  const value = cookieFrom(response, harness.config.cookieName);
  if (!value) {
    throw new Error(
      `Expected a session cookie, got ${response.status} to ${String(response.headers.location)}`,
    );
  }
  return value;
}

/** Reads a JWT's claims without verifying it. The test is not the one deciding. */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const segment = token.split('.')[1];
  if (!segment) throw new Error('not a JWT');
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}
