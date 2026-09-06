import { createHash } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { HttpErrorFilter } from './common/http-error.filter.ts';
import type { AppConfig } from './config.ts';

/**
 * Everything that turns a Nest application into this API: prefix, error shape,
 * security headers, cookies, rate limits, CORS.
 *
 * It lives here rather than inline in main.ts so the integration tests can boot
 * the same thing. A test harness that skips the composition root proves the
 * controllers work and says nothing about the application anyone deploys, which
 * is exactly where the interesting bugs are: a guard that was never registered,
 * a rate limit that never applied, a cookie plugin that was not loaded.
 */
export async function configureApp(app: NestFastifyApplication, config: AppConfig): Promise<void> {
  app.setGlobalPrefix('v1');
  app.useGlobalFilters(new HttpErrorFilter());

  await app.register(helmet, {
    contentSecurityPolicy: false, // The API serves JSON; the frontends set their own CSP.
    hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
  });
  await app.register(cookie, { secret: undefined, parseOptions: {} });

  /**
   * Rate limiting, with the credential routes held to a much tighter budget.
   *
   * The general limit stops one misbehaving client flattening the API. The auth
   * limit is a security control: password guessing, credential stuffing and
   * account enumeration are all volume attacks, and registration answers
   * honestly when an address is already taken, so this limit is what stops that
   * answer being harvested at scale.
   *
   * The store is in-memory, which means the limit is per instance. That is
   * correct for one instance and wrong for several, so it moves to Redis when
   * the API is actually scaled out rather than being described as done now.
   */
  await app.register(rateLimit, {
    global: true,
    timeWindow: '1 minute',
    // Two budgets, and therefore two counters per caller. One shared counter
    // would let a handful of ordinary API calls consume the sign-in allowance.
    // Scoping by route prefix rather than by a declaration on each route means
    // a credential route added later is covered the moment it exists.
    keyGenerator: (request) => {
      const scope = isCredentialRoute(request.method, request.url) ? 'auth' : 'general';
      // Hashed, so the counter store is not a list of who used the API today.
      const who = createHash('sha256').update(request.ip).digest('base64url').slice(0, 22);
      return `${scope}:${who}`;
    },
    max: (request) =>
      isCredentialRoute(request.method, request.url) ? config.authRateLimitPerMinute : 300,
    allowList: (request) => request.url === '/v1/healthz' || request.url === '/v1/readyz',
    /**
     * The object returned here is thrown, not sent. It reaches the error
     * filter, which builds the response body, so what it needs to carry is the
     * status and the message rather than the finished shape: returning the
     * finished shape produced a correct-looking 429 payload with a 500 status
     * on it, because nothing in it said 429.
     */
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      message: `Too many requests. Try again in ${Math.ceil(context.ttl / 1000)} seconds.`,
    }),
  });

  app.enableCors({
    origin: config.corsAllowedOrigins,
    credentials: true,
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'If-Match',
      'X-Daybook-Client',
      'X-Client-Version',
    ],
    exposedHeaders: ['ETag', 'Idempotency-Replayed', 'Retry-After'],
  });
}

/**
 * Which routes get the strict budget: everything under /v1/auth that changes
 * something. Listing your own sessions is a read by an already-authenticated
 * caller and has no business competing with sign-in attempts for an allowance.
 */
export function isCredentialRoute(method: string, url: string): boolean {
  return method !== 'GET' && url.startsWith('/v1/auth/');
}
