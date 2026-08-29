import { z } from 'zod';

/**
 * Configuration is validated once, at boot, and the process refuses to start if
 * anything required is missing. A misconfigured deploy should fail loudly on
 * launch rather than quietly at 3am when the first refresh token is presented.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ALLOWED_ORIGINS: z.string().min(1),
  DATABASE_URL: z.string().url(),
  DATABASE_AUTH_URL: z.string().url(),
  AUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  AUTH_REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  AUTH_COOKIE_NAME: z.string().default('db_rt'),
  AUTH_COOKIE_DOMAIN: z.string().optional(),
});

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  logLevel: string;
  corsAllowedOrigins: string[];
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  cookieName: string;
  cookieDomain: string | undefined;
  isProduction: boolean;
}

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
  return {
    env: value.NODE_ENV,
    port: value.API_PORT,
    logLevel: value.LOG_LEVEL,
    corsAllowedOrigins: value.CORS_ALLOWED_ORIGINS.split(',').map((o) => o.trim()),
    accessTokenTtlSeconds: value.AUTH_ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlDays: value.AUTH_REFRESH_TOKEN_TTL_DAYS,
    cookieName: value.AUTH_COOKIE_NAME,
    cookieDomain: value.AUTH_COOKIE_DOMAIN || undefined,
    isProduction: value.NODE_ENV === 'production',
  };
}
