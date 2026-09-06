import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { asUser } from '@daybook/db';
import {
  accessTokenFrom,
  call,
  cleanupTestUsers,
  createHarness,
  refreshCookieFrom,
  registerUser,
  uniqueEmail,
  type Harness,
} from './helpers/harness.ts';

/**
 * Phase 3a, proved rather than asserted.
 *
 * These run against a real PostgreSQL database with the real migrations
 * applied, through the real application. Nothing is mocked except the mail
 * transport, which does not exist yet.
 */
describe('authentication', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
    await cleanupTestUsers();
  });

  afterAll(async () => {
    await cleanupTestUsers();
    await harness.close();
  });

  // --- Registration and sign-in -------------------------------------------

  it('registers a person, signs them in, and gives them a profile', async () => {
    const email = uniqueEmail('ada');
    const response = await call(harness, {
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email,
        password: 'the-quick-brown-fox-jumped',
        display_name: 'Ada',
        timezone: 'Africa/Lagos',
      },
    });

    expect(response.status).toBe(201);
    const body = response.body as {
      access_token: string;
      token_type: string;
      expires_in: number;
      user: { id: string; email: string; email_verified: boolean; timezone: string };
    };
    expect(body.token_type).toBe('Bearer');
    expect(body.user.email).toBe(email);
    expect(body.user.email_verified).toBe(false);
    expect(body.user.timezone).toBe('Africa/Lagos');

    // The refresh token is a cookie and nothing else. If it ever appears in the
    // body, a cross-site script gets thirty days instead of ten minutes.
    expect(JSON.stringify(response.body)).not.toContain('db_rt');
    const cookie = response.cookies.find((c) => c.name === harness.config.cookieName);
    expect(cookie).toBeDefined();
    expect(cookie?.value.length).toBeGreaterThan(20);

    // The trigger from migration 0003 created the profile; registration filled it in.
    const me = await call(harness, {
      method: 'GET',
      url: '/v1/me',
      accessToken: body.access_token,
    });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ email, display_name: 'Ada', timezone: 'Africa/Lagos' });
  });

  it('rejects a timezone that does not exist, by name', async () => {
    const response = await call(harness, {
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: uniqueEmail('mars'),
        password: 'the-quick-brown-fox-jumped',
        timezone: 'Mars/Olympus_Mons',
      },
    });
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).toContain('Mars/Olympus_Mons');
  });

  it('refuses a second account on the same address, whatever the casing', async () => {
    const user = await registerUser(harness, 'twice');
    const response = await call(harness, {
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: user.email.toUpperCase(),
        password: 'a-different-passphrase-entirely',
        timezone: 'Europe/London',
      },
    });
    expect(response.status).toBe(409);
  });

  it('signs in with the right password and refuses the wrong one', async () => {
    const user = await registerUser(harness, 'login');

    const good = await call(harness, {
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: user.email, password: user.password },
    });
    expect(good.status).toBe(200);
    expect(refreshCookieFrom(good, harness.config.cookieName)).toBeTruthy();

    const bad = await call(harness, {
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: user.email, password: 'not-the-password-at-all' },
    });
    expect(bad.status).toBe(401);
    expect(refreshCookieFrom(bad, harness.config.cookieName)).toBeNull();
  });

  it('answers identically for a wrong password and an address with no account', async () => {
    const user = await registerUser(harness, 'enumerate');

    const wrongPassword = await call(harness, {
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: user.email, password: 'not-the-password-at-all' },
    });
    const noSuchAccount = await call(harness, {
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: uniqueEmail('nobody'), password: 'not-the-password-at-all' },
    });

    expect(wrongPassword.status).toBe(noSuchAccount.status);
    // Compare the message rather than the whole body: the request id differs.
    expect(errorMessage(wrongPassword.body)).toBe(errorMessage(noSuchAccount.body));
  });

  // --- Guards -------------------------------------------------------------

  it('closes every route by default', async () => {
    const noToken = await call(harness, { method: 'GET', url: '/v1/me' });
    expect(noToken.status).toBe(401);

    const nonsense = await call(harness, {
      method: 'GET',
      url: '/v1/me',
      accessToken: 'not.a.token',
    });
    expect(nonsense.status).toBe(401);

    // A structurally perfect token, signed with a different key. This is the
    // one that would pass if anybody ever swapped EdDSA verification for
    // decoding without checking the signature.
    const foreign = generateKeyPairSync('ed25519');
    const other = await createHarness({
      AUTH_JWT_PRIVATE_KEY_B64: Buffer.from(
        foreign.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      ).toString('base64'),
      AUTH_JWT_PUBLIC_KEY_B64: Buffer.from(
        foreign.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      ).toString('base64'),
    });
    try {
      const stranger = await registerUser(other, 'stranger');
      // Valid on the harness that minted it.
      expect(
        (await call(other, { method: 'GET', url: '/v1/me', accessToken: stranger.accessToken }))
          .status,
      ).toBe(200);
      // Worthless on this one.
      expect(
        (await call(harness, { method: 'GET', url: '/v1/me', accessToken: stranger.accessToken }))
          .status,
      ).toBe(401);
    } finally {
      await other.close();
    }
  });

  it('leaves the health endpoints open, because a load balancer has no token', async () => {
    const health = await call(harness, { method: 'GET', url: '/v1/healthz' });
    expect(health.status).toBe(200);
  });

  // --- Refresh rotation ---------------------------------------------------

  it('rotates the refresh token on every use', async () => {
    const user = await registerUser(harness, 'rotate');

    const first = await call(harness, {
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: {},
      refreshCookie: user.refreshToken,
    });
    expect(first.status).toBe(200);

    const second = refreshCookieFrom(first, harness.config.cookieName);
    expect(second).toBeTruthy();
    expect(second).not.toBe(user.refreshToken);

    // The new access token works.
    const me = await call(harness, {
      method: 'GET',
      url: '/v1/me',
      accessToken: accessTokenFrom(first),
    });
    expect(me.status).toBe(200);
  });

  /**
   * The Phase 3 exit criterion.
   *
   * Presenting a refresh token that has already been rotated is either a
   * replay or a theft, and nothing in the request tells them apart. So the
   * whole chain dies, including the token the legitimate client is holding.
   */
  it('kills the entire family when a rotated refresh token is presented again', async () => {
    const user = await registerUser(harness, 'reuse');

    const rotated = await call(harness, {
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: {},
      refreshCookie: user.refreshToken,
    });
    expect(rotated.status).toBe(200);
    const current = refreshCookieFrom(rotated, harness.config.cookieName);
    expect(current).toBeTruthy();

    // The thief replays the old token.
    const replay = await call(harness, {
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: {},
      refreshCookie: user.refreshToken,
    });
    expect(replay.status).toBe(401);

    // And the legitimate client's current token is now dead too. This is the
    // assertion that matters: revoking only the replayed token would leave the
    // thief's copy working if the thief had been the one to rotate.
    const afterwards = await call(harness, {
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: {},
      refreshCookie: current ?? '',
    });
    expect(afterwards.status).toBe(401);

    // Signing in again works, and starts a new family.
    const back = await call(harness, {
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: user.email, password: user.password },
    });
    expect(back.status).toBe(200);
  });

  it('refuses a refresh token that was never issued', async () => {
    const response = await call(harness, {
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: {},
      refreshCookie: 'aGVsbG8tdGhpcy1pcy1ub3QtYS1yZWFsLXRva2Vu',
    });
    expect(response.status).toBe(401);
  });

  /**
   * The second half of the exit criterion: one sign-in, both apps.
   *
   * Both frontends talk to this API, so the refresh cookie is set on one
   * origin and presented by both. Opening Fitness after signing in to Daybook
   * is a refresh, not a second login.
   */
  it('gives the other app a session from the same cookie, with no second sign-in', async () => {
    const user = await registerUser(harness, 'shared');

    const fitness = await call(harness, {
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: {},
      refreshCookie: user.refreshToken,
    });
    expect(fitness.status).toBe(200);

    const me = await call(harness, {
      method: 'GET',
      url: '/v1/me',
      accessToken: accessTokenFrom(fitness),
    });
    expect(me.status).toBe(200);
    expect((me.body as { email: string }).email).toBe(user.email);
  });

  // --- Signing out --------------------------------------------------------

  it('ends this session on sign-out, and every session on sign-out everywhere', async () => {
    const user = await registerUser(harness, 'logout');

    // A second device: a separate sign-in, and therefore a separate family.
    const second = await call(harness, {
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: user.email, password: user.password },
    });
    const secondToken = refreshCookieFrom(second, harness.config.cookieName);
    expect(secondToken).toBeTruthy();

    const sessions = await call(harness, {
      method: 'GET',
      url: '/v1/auth/sessions',
      accessToken: user.accessToken,
    });
    expect((sessions.body as { sessions: unknown[] }).sessions).toHaveLength(2);

    // Signing out of this one leaves the other alone.
    const out = await call(harness, {
      method: 'POST',
      url: '/v1/auth/logout',
      payload: { everywhere: false },
      accessToken: user.accessToken,
    });
    expect(out.status).toBe(204);

    expect(
      (
        await call(harness, {
          method: 'POST',
          url: '/v1/auth/refresh',
          payload: {},
          refreshCookie: user.refreshToken,
        })
      ).status,
    ).toBe(401);

    const stillAlive = await call(harness, {
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: {},
      refreshCookie: secondToken ?? '',
    });
    expect(stillAlive.status).toBe(200);

    // Everywhere means everywhere.
    await call(harness, {
      method: 'POST',
      url: '/v1/auth/logout',
      payload: { everywhere: true },
      accessToken: accessTokenFrom(stillAlive),
    });
    expect(
      (
        await call(harness, {
          method: 'POST',
          url: '/v1/auth/refresh',
          payload: {},
          refreshCookie: refreshCookieFrom(stillAlive, harness.config.cookieName) ?? '',
        })
      ).status,
    ).toBe(401);
  });

  // --- Email verification -------------------------------------------------

  it('verifies an address once, and only once', async () => {
    harness.mailer.clear();
    const user = await registerUser(harness, 'verify');

    const token = harness.mailer.lastToken('verify');
    expect(token).toBeTruthy();

    const first = await call(harness, {
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token },
    });
    expect(first.status).toBe(200);
    expect((first.body as { message: string }).message).toContain('verified');

    // Reusing the link does not verify anything a second time, and does not
    // error either: the person clicked a link twice, which is not a fault.
    const again = await call(harness, {
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token },
    });
    expect(again.status).toBe(200);
    expect((again.body as { message: string }).message).toContain('expired');

    // The claim reaches the client after a refresh, because it is in the token.
    const refreshed = await call(harness, {
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: {},
      refreshCookie: user.refreshToken,
    });
    expect((refreshed.body as { user: { email_verified: boolean } }).user.email_verified).toBe(
      true,
    );
  });

  // --- Password reset -----------------------------------------------------

  it('resets a password, ends every session, and burns the link', async () => {
    harness.mailer.clear();
    const user = await registerUser(harness, 'reset');

    const requested = await call(harness, {
      method: 'POST',
      url: '/v1/auth/password/forgot',
      payload: { email: user.email },
    });
    expect(requested.status).toBe(202);

    const token = harness.mailer.lastToken('reset');
    expect(token).toBeTruthy();

    const newPassword = 'an-entirely-different-passphrase';
    const reset = await call(harness, {
      method: 'POST',
      url: '/v1/auth/password/reset',
      payload: { token, password: newPassword },
    });
    expect(reset.status).toBe(200);

    // The old sessions are gone. A reset that left them alive would be
    // cosmetic for anyone resetting because they think they were compromised.
    expect(
      (
        await call(harness, {
          method: 'POST',
          url: '/v1/auth/refresh',
          payload: {},
          refreshCookie: user.refreshToken,
        })
      ).status,
    ).toBe(401);

    // The old password is gone, the new one works.
    expect(
      (
        await call(harness, {
          method: 'POST',
          url: '/v1/auth/login',
          payload: { email: user.email, password: user.password },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call(harness, {
          method: 'POST',
          url: '/v1/auth/login',
          payload: { email: user.email, password: newPassword },
        })
      ).status,
    ).toBe(200);

    // And the link is spent.
    expect(
      (
        await call(harness, {
          method: 'POST',
          url: '/v1/auth/password/reset',
          payload: { token, password: 'yet-another-passphrase-here' },
        })
      ).status,
    ).toBe(401);
  });

  it('answers a reset request the same way for an address with no account', async () => {
    harness.mailer.clear();
    const user = await registerUser(harness, 'known');

    const known = await call(harness, {
      method: 'POST',
      url: '/v1/auth/password/forgot',
      payload: { email: user.email },
    });
    const unknown = await call(harness, {
      method: 'POST',
      url: '/v1/auth/password/forgot',
      payload: { email: uniqueEmail('ghost') },
    });

    expect(known.status).toBe(unknown.status);
    expect(known.body).toEqual(unknown.body);
    // The difference is in what was sent, not in what was said.
    expect(harness.mailer.resets).toHaveLength(1);
    expect(harness.mailer.resetsForUnknown).toHaveLength(1);
  });

  it('changes a password only with the current one, and signs the person out', async () => {
    const user = await registerUser(harness, 'change');

    const wrong = await call(harness, {
      method: 'POST',
      url: '/v1/auth/password/change',
      accessToken: user.accessToken,
      payload: { current_password: 'wrong', new_password: 'a-brand-new-passphrase' },
    });
    expect(wrong.status).toBe(401);

    const right = await call(harness, {
      method: 'POST',
      url: '/v1/auth/password/change',
      accessToken: user.accessToken,
      payload: { current_password: user.password, new_password: 'a-brand-new-passphrase' },
    });
    expect(right.status).toBe(200);

    expect(
      (
        await call(harness, {
          method: 'POST',
          url: '/v1/auth/refresh',
          payload: {},
          refreshCookie: user.refreshToken,
        })
      ).status,
    ).toBe(401);
  });

  // --- Isolation ----------------------------------------------------------

  /**
   * The other half of the exit criterion, at the layer that enforces it.
   *
   * There are no activity endpoints until Phase 4, so this checks the boundary
   * itself: two accounts, one row belonging to the first, and the second
   * account querying through the same code path the API uses. Row-level
   * security, not a WHERE clause, is what returns nothing. When Phase 4 adds
   * the endpoints, the same property is asserted over HTTP as a 404.
   */
  it('shows one account nothing belonging to another', async () => {
    const ada = await registerUser(harness, 'ada-iso');
    const grace = await registerUser(harness, 'grace-iso');

    await asUser(ada.id, async (tx) => {
      await tx.$executeRaw`
        INSERT INTO activities (user_id, occurrence_date, title, planned_start, planned_end)
        VALUES (${ada.id}::uuid, CURRENT_DATE, 'Ada''s private plan',
                now(), now() + interval '1 hour')`;
    });

    const adaSees = await asUser(
      ada.id,
      (tx) => tx.$queryRaw<{ count: bigint }[]>`SELECT count(*) AS count FROM activities`,
    );
    expect(Number(adaSees[0]?.count ?? 0)).toBeGreaterThan(0);

    const graceSees = await asUser(
      grace.id,
      (tx) => tx.$queryRaw<{ count: bigint }[]>`SELECT count(*) AS count FROM activities`,
    );
    expect(Number(graceSees[0]?.count ?? 0)).toBe(0);

    // Even by primary key, with the id in hand.
    const byId = await asUser(
      grace.id,
      (tx) =>
        tx.$queryRaw<{ id: string }[]>`SELECT id FROM activities WHERE user_id = ${ada.id}::uuid`,
    );
    expect(byId).toHaveLength(0);

    // And over HTTP: Grace's token returns Grace, never Ada.
    const me = await call(harness, {
      method: 'GET',
      url: '/v1/me',
      accessToken: grace.accessToken,
    });
    expect((me.body as { email: string }).email).toBe(grace.email);
    expect(JSON.stringify(me.body)).not.toContain(ada.email);
  });

  it('will not let a request name a different user', async () => {
    const ada = await registerUser(harness, 'ada-patch');
    const grace = await registerUser(harness, 'grace-patch');

    // An extra field naming somebody else is rejected outright, because the
    // contract schemas are strict. Silently ignoring it would be worse: the
    // next person to add a field would not know it had been arriving all along.
    const smuggled = await call(harness, {
      method: 'PATCH',
      url: '/v1/me',
      accessToken: grace.accessToken,
      payload: { display_name: 'Grace', user_id: ada.id },
    });
    expect(smuggled.status).toBe(422);

    const legitimate = await call(harness, {
      method: 'PATCH',
      url: '/v1/me',
      accessToken: grace.accessToken,
      payload: { display_name: 'Grace Hopper', theme: 'dark' },
    });
    expect(legitimate.status).toBe(200);
    expect(legitimate.body).toMatchObject({ display_name: 'Grace Hopper', theme: 'dark' });

    // Ada is untouched.
    const adaNow = await call(harness, {
      method: 'GET',
      url: '/v1/me',
      accessToken: ada.accessToken,
    });
    expect((adaNow.body as { display_name: string }).display_name).toBe('ada-patch');
  });

  // --- Rate limiting ------------------------------------------------------

  it('stops repeated sign-in attempts', async () => {
    const strict = await createHarness({ AUTH_RATE_LIMIT_PER_MINUTE: '5' });
    try {
      const ip = '203.0.113.7';
      const attempts = [];
      for (let i = 0; i < 8; i += 1) {
        attempts.push(
          await call(strict, {
            method: 'POST',
            url: '/v1/auth/login',
            ip,
            payload: { email: uniqueEmail('flood'), password: 'guessing-away' },
          }),
        );
      }
      const limited = attempts.filter((response) => response.status === 429);
      expect(limited.length).toBeGreaterThan(0);
      expect(errorCode(limited[0]?.body)).toBe('rate_limited');

      // A different caller is unaffected.
      const elsewhere = await call(strict, {
        method: 'POST',
        url: '/v1/auth/login',
        ip: '198.51.100.4',
        payload: { email: uniqueEmail('elsewhere'), password: 'guessing-away' },
      });
      expect(elsewhere.status).toBe(401);
    } finally {
      await strict.close();
    }
  });
});

function errorMessage(body: unknown): string | undefined {
  return (body as { error?: { message?: string } } | null)?.error?.message;
}

function errorCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } } | null)?.error?.code;
}
