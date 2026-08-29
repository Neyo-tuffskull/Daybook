import { PrismaClient } from '../generated/client/index.js';

export type { PrismaClient };

/**
 * Two clients, two roles, on purpose.
 *
 * `db` connects as daybook_app, which owns nothing and has no access at all to
 * auth_sessions, password_reset_tokens or email_verification_tokens. `authDb`
 * connects as daybook_auth, which can reach exactly those tables plus users,
 * because a login has to find an account before anyone is authenticated.
 *
 * The split means a bug in an activity handler cannot read a password hash.
 */
export const db = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

export const authDb = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_AUTH_URL } },
});

/**
 * Runs a callback inside a transaction that carries the caller's identity, so
 * the row-level security policies apply.
 *
 * `set_config(..., true)` makes the setting transaction-local. Connections are
 * pooled and reused across requests, so a session-scoped setting would leak one
 * user's identity into the next user's queries. That is the single most
 * dangerous mistake available in this file, which is why nothing else in the
 * codebase is allowed to call `set_config` directly.
 */
export async function asUser<T>(
  userId: string,
  work: (tx: Omit<PrismaClient, '$connect' | '$disconnect' | '$transaction'>) => Promise<T>,
): Promise<T> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    throw new Error('asUser requires a UUID');
  }
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT set_config('app.current_user_id', $1, true)", userId);
    return work(tx);
  });
}

/** Liveness probe for /readyz. */
export async function pingDatabase(): Promise<boolean> {
  try {
    await db.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
