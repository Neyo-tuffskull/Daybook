import { PrismaClient, type Prisma } from '../generated/client/index.js';

export type { PrismaClient, Prisma };

/**
 * This module imports from `../generated/client`, which does not exist on a
 * fresh checkout. Run `pnpm --filter @daybook/db build` (that is
 * `prisma generate`) before typechecking. Turbo enforces the ordering, so
 * `pnpm typecheck` from the root handles it for you.
 *
 * Generation reads only the schema file, so it needs no running database.
 */

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  // Guarding the shape here matters: the value is interpolated into a
  // set_config call, and a UUID check is a cheap, total defence.
  if (!UUID.test(userId)) {
    throw new Error('asUser requires a UUID');
  }
  return db.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
    return work(tx);
  });
}

/** Readiness probe for /readyz. */
export async function pingDatabase(): Promise<boolean> {
  try {
    await db.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
