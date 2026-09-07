import { z } from 'zod';
import { GOOGLE_ENDPOINTS } from './auth/oidc.ts';

/**
 * Configuration is validated once, at boot, and the process refuses to start if
 * anything required is missing. A misconfigured deploy should fail loudly on
 * launch rather than quietly at 3am when the first refresh token is presented.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  APP_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ALLOWED_ORIGINS: z.string().min(1),
  DATABASE_URL: z.string().url(),
  DATABASE_AUTH_URL: z.string().url(),

  // Base64-encoded PEM, so a multi-line key survives a single-line environment
  // variable without anyone having to invent an escaping scheme.
  AUTH_JWT_PRIVATE_KEY_B64: z.string().min(1),
  AUTH_JWT_PUBLIC_KEY_B64: z.string().min(1),
  /**
   * Names the key that signed a token. Rotating keys means publishing the new
   * one, switching the signer, and only then retiring the old one; without an
   * id in the header, every token issued under the old key dies the moment the
   * new one takes over.
   */
  AUTH_JWT_KEY_ID: z.string().min(1).default('daybook-ed25519-1'),

  AUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(600),
  AUTH_REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().max(365).default(30),
  AUTH_EMAIL_TOKEN_TTL_HOURS: z.coerce.number().int().positive().default(24),
  AUTH_RESET_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(60),
  AUTH_COOKIE_NAME: z.string().default('db_rt'),
  AUTH_COOKIE_DOMAIN: z.string().optional(),

  // OWASP's floor for Argon2id is 19 MiB and one pass. These defaults sit well
  // above it; they can be raised on stronger hardware without invalidating
  // existing hashes, because the parameters are stored inside each hash.
  AUTH_ARGON2_MEMORY_KIB: z.coerce.number().int().min(19456).default(65536),
  AUTH_ARGON2_TIME_COST: z.coerce.number().int().min(2).default(3),
  AUTH_ARGON2_PARALLELISM: z.coerce.number().int().min(1).max(16).default(1),

  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),

  // Google sign-in is optional. With no client id and secret the routes are
  // still registered but answer 503, which is a truthful "this deployment does
  // not offer that" rather than a 404 pretending the feature does not exist.
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().url().optional(),
  /**
   * Points the OIDC client at a different issuer. This exists so the tests can
   * run a real issuer of their own and have the real verification code check a
   * real signature against a real JWKS. Unset in every other case.
   */
  GOOGLE_OIDC_BASE_URL: z.string().url().optional(),
});

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  apiPublicUrl: string;
  appPublicUrl: string;
  logLevel: string;
  corsAllowedOrigins: string[];
  jwt: {
    privateKeyPem: string;
    publicKeyPem: string;
    keyId: string;
    issuer: string;
    audience: string;
  };
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  emailTokenTtlHours: number;
  resetTokenTtlMinutes: number;
  cookieName: string;
  cookieDomain: string | undefined;
  argon2: { memoryCost: number; timeCost: number; parallelism: number };
  authRateLimitPerMinute: number;
  /** Null when this deployment has no Google credentials configured. */
  google: GoogleConfig | null;
  isProduction: boolean;
}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
}

export const JWT_ISSUER = 'daybook';
export const JWT_AUDIENCE = 'daybook-api';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    // Names only. Printing the values would put secrets in the boot logs.
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  const value = parsed.data;

  const privateKeyPem = decodePem(value.AUTH_JWT_PRIVATE_KEY_B64, 'AUTH_JWT_PRIVATE_KEY_B64');
  const publicKeyPem = decodePem(value.AUTH_JWT_PUBLIC_KEY_B64, 'AUTH_JWT_PUBLIC_KEY_B64');

  return {
    env: value.NODE_ENV,
    port: value.API_PORT,
    apiPublicUrl: stripTrailingSlash(value.API_PUBLIC_URL),
    appPublicUrl: stripTrailingSlash(value.APP_PUBLIC_URL),
    logLevel: value.LOG_LEVEL,
    corsAllowedOrigins: value.CORS_ALLOWED_ORIGINS.split(',').map((o) => o.trim()),
    jwt: {
      privateKeyPem,
      publicKeyPem,
      keyId: value.AUTH_JWT_KEY_ID,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    },
    accessTokenTtlSeconds: value.AUTH_ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlDays: value.AUTH_REFRESH_TOKEN_TTL_DAYS,
    emailTokenTtlHours: value.AUTH_EMAIL_TOKEN_TTL_HOURS,
    resetTokenTtlMinutes: value.AUTH_RESET_TOKEN_TTL_MINUTES,
    cookieName: value.AUTH_COOKIE_NAME,
    cookieDomain: value.AUTH_COOKIE_DOMAIN || undefined,
    argon2: {
      memoryCost: value.AUTH_ARGON2_MEMORY_KIB,
      timeCost: value.AUTH_ARGON2_TIME_COST,
      parallelism: value.AUTH_ARGON2_PARALLELISM,
    },
    authRateLimitPerMinute: value.AUTH_RATE_LIMIT_PER_MINUTE,
    google: googleConfig(value),
    isProduction: value.NODE_ENV === 'production',
  };
}

/**
 * Google sign-in is configured or it is not; there is no partly configured
 * state worth supporting. A client id without a secret is a mistake that would
 * otherwise surface as a failed code exchange in front of a user.
 */
function googleConfig(value: z.infer<typeof schema>): GoogleConfig | null {
  const clientId = value.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = value.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret) {
    throw new Error(
      'Google sign-in needs both GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET, or neither.',
    );
  }

  const base = value.GOOGLE_OIDC_BASE_URL;
  const endpoints = base
    ? {
        issuer: stripTrailingSlash(base),
        authorizationEndpoint: `${stripTrailingSlash(base)}/authorize`,
        tokenEndpoint: `${stripTrailingSlash(base)}/token`,
        jwksUri: `${stripTrailingSlash(base)}/jwks`,
      }
    : GOOGLE_ENDPOINTS;

  return {
    clientId,
    clientSecret,
    redirectUri:
      value.GOOGLE_OAUTH_REDIRECT_URI ??
      `${stripTrailingSlash(value.API_PUBLIC_URL)}/v1/auth/google/callback`,
    ...endpoints,
  };
}

/**
 * Decodes and sanity-checks a key. Catching a truncated or wrongly-pasted key
 * here costs one line; catching it at the first sign-in costs an outage, and
 * the error at that point says nothing more useful than "invalid key".
 */
function decodePem(base64: string, name: string): string {
  let pem: string;
  try {
    pem = Buffer.from(base64, 'base64').toString('utf8');
  } catch {
    throw new Error(`${name} is not valid base64`);
  }
  if (!pem.includes('-----BEGIN') || !pem.includes('-----END')) {
    throw new Error(
      `${name} did not decode to a PEM block. Generate it with:\n` +
        '  openssl genpkey -algorithm ed25519 -out private.pem\n' +
        '  openssl pkey -in private.pem -pubout -out public.pem\n' +
        '  base64 -w0 private.pem',
    );
  }
  return pem;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
