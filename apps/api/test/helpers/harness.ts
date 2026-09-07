import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';
import { authDb } from '@daybook/db';
import { AppModule } from '../../src/app.module.ts';
import { configureApp } from '../../src/bootstrap.ts';
import { loadConfig, type AppConfig } from '../../src/config.ts';
import { CONFIG } from '../../src/config.provider.ts';
import { MAILER, type Mailer } from '../../src/auth/mailer.ts';

/**
 * Records what would have been emailed, so a test can follow a link the way a
 * person would.
 *
 * This is the one thing the tests substitute, and only because there is no mail
 * provider yet. Everything else is the real application: the same modules, the
 * same global guard, the same rate limiter, the same error filter, the same
 * database. A harness that assembles a simplified version of the app proves the
 * simplified version works, which is not a claim worth making.
 */
export class RecordingMailer implements Mailer {
  readonly verifications: { email: string; link: string }[] = [];
  readonly resets: { email: string; link: string }[] = [];
  readonly resetsForUnknown: string[] = [];

  sendEmailVerification(email: string, link: string): Promise<void> {
    this.verifications.push({ email, link });
    return Promise.resolve();
  }

  sendPasswordReset(email: string, link: string): Promise<void> {
    this.resets.push({ email, link });
    return Promise.resolve();
  }

  sendPasswordResetForUnknownAddress(email: string): Promise<void> {
    this.resetsForUnknown.push(email);
    return Promise.resolve();
  }

  /** The token from the most recent link of a kind, as the recipient would read it. */
  lastToken(kind: 'verify' | 'reset'): string | null {
    const list = kind === 'verify' ? this.verifications : this.resets;
    const last = list.at(-1);
    if (!last) return null;
    return new URL(last.link).searchParams.get('token');
  }

  clear(): void {
    this.verifications.length = 0;
    this.resets.length = 0;
    this.resetsForUnknown.length = 0;
  }
}

export interface Harness {
  app: NestFastifyApplication;
  mailer: RecordingMailer;
  config: AppConfig;
  close: () => Promise<void>;
}

export async function createHarness(overrides: Partial<NodeJS.ProcessEnv> = {}): Promise<Harness> {
  const mailer = new RecordingMailer();
  const config = loadConfig({ ...process.env, ...overrides });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAILER)
    .useValue(mailer)
    .overrideProvider(CONFIG)
    .useValue(config)
    .compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    // trustProxy matches production, where the API sits behind a load balancer.
    // It is also what lets a test present a different caller address, which the
    // rate-limit test needs and which no amount of mocking would prove.
    new FastifyAdapter({ genReqId: () => randomUUID(), trustProxy: true }),
    { logger: false },
  );
  await configureApp(app, config);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  return {
    app,
    mailer,
    config,
    close: async () => {
      await app.close();
    },
  };
}

// --- Making requests -------------------------------------------------------

export interface Injected {
  status: number;
  body: unknown;
  cookies: { name: string; value: string; expires?: Date }[];
  /** Needed for redirects, where the whole answer is the location header. */
  headers: Record<string, unknown>;
}

export interface CallOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  payload?: unknown;
  accessToken?: string;
  refreshCookie?: string;
  /** Any other cookie the request should carry, such as an in-flight OIDC flow. */
  cookies?: Record<string, string>;
  /** Lets a test look like a different caller, so rate limits do not bleed across tests. */
  ip?: string;
}

export async function call(harness: Harness, options: CallOptions): Promise<Injected> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.accessToken) headers.authorization = `Bearer ${options.accessToken}`;
  if (options.ip) headers['x-forwarded-for'] = options.ip;

  const response = await harness.app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: options.method,
      url: options.url,
      headers,
      payload: options.payload === undefined ? undefined : JSON.stringify(options.payload),
      cookies: {
        ...(options.refreshCookie ? { [harness.config.cookieName]: options.refreshCookie } : {}),
        ...options.cookies,
      },
    });

  return {
    status: response.statusCode,
    body: parseBody(response.body),
    cookies: response.cookies,
    headers: response.headers,
  };
}

/** The value a response set for a named cookie, or null if it set or cleared none. */
export function cookieFrom(response: Injected, name: string): string | null {
  const found = response.cookies.find((cookie) => cookie.name === name);
  if (!found || found.value === '') return null;
  return found.value;
}

/** Where a redirect points. */
export function locationOf(response: Injected): string {
  const location = response.headers.location;
  if (typeof location !== 'string') {
    throw new Error(`Response was ${response.status} with no location header`);
  }
  return location;
}

/** The refresh token a response set, or null if it cleared or never set one. */
export function refreshCookieFrom(response: Injected, name = 'db_rt'): string | null {
  const found = response.cookies.find((cookie) => cookie.name === name);
  if (!found || found.value === '') return null;
  return found.value;
}

export function accessTokenFrom(response: Injected): string {
  const body = response.body as { access_token?: unknown };
  if (typeof body?.access_token !== 'string') {
    throw new Error(`No access token in response: ${JSON.stringify(response.body)}`);
  }
  return body.access_token;
}

function parseBody(raw: string): unknown {
  if (raw === '') return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

// --- Fixtures --------------------------------------------------------------

/** A fresh address per test, so a failed cleanup cannot break the next run. */
export function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}@daybook.test`;
}

export interface RegisteredUser {
  id: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
}

export async function registerUser(
  harness: Harness,
  prefix = 'user',
  ip?: string,
): Promise<RegisteredUser> {
  const email = uniqueEmail(prefix);
  const password = 'a-perfectly-ordinary-passphrase';
  const response = await call(harness, {
    method: 'POST',
    url: '/v1/auth/register',
    ip,
    payload: { email, password, display_name: prefix, timezone: 'Europe/London' },
  });
  if (response.status !== 201) {
    throw new Error(`Registration failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  const refreshToken = refreshCookieFrom(response, harness.config.cookieName);
  if (!refreshToken) throw new Error('Registration set no refresh cookie');
  const body = response.body as { user: { id: string } };
  return {
    id: body.user.id,
    email,
    password,
    accessToken: accessTokenFrom(response),
    refreshToken,
  };
}

/**
 * Removes every account these tests created.
 *
 * Scoped to the .test address suffix rather than deleting everything, so
 * pointing the suite at a database with anything else in it is survivable. The
 * guards in setup-env.ts are the first line; this is the second.
 */
export async function cleanupTestUsers(): Promise<void> {
  await authDb.$executeRaw`DELETE FROM users WHERE email::text LIKE '%@daybook.test'`;
}
