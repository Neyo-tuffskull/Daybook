/**
 * The credential data layer.
 *
 * Everything here runs as daybook_auth, the only role permitted to touch
 * auth_sessions, password_reset_tokens and email_verification_tokens. Nothing
 * in the rest of the application imports this module; the API's auth module is
 * its only caller.
 *
 * Written as parameterised SQL rather than generated Prisma models, on purpose.
 * The models in this repository come from `prisma db pull`, which introspects
 * as DATABASE_URL, and DATABASE_URL is daybook_app, which by design cannot see
 * three of the five tables below. Introspection would therefore produce a model
 * set missing exactly the tables the auth code needs. Rather than widen the
 * application role to make a code generator happy, these queries are written
 * out, against a schema in this same package that is the source of truth for
 * the column names. Every value is a bound parameter; no string is ever
 * concatenated into a statement.
 */
import { authDb, TRANSACTION_OPTIONS } from './clients.ts';
import type { Prisma } from './clients.ts';

/** Any Prisma client or transaction. Lets a caller compose several calls atomically. */
export type AuthClient =
  Pick<typeof authDb, '$queryRaw' | '$executeRaw'> | Prisma.TransactionClient;

/**
 * Runs several credential operations in one transaction.
 *
 * Refresh rotation is the reason this exists: reading a session, deciding it is
 * legitimate, issuing its replacement and marking the old one rotated have to
 * be one atomic step, or two concurrent refreshes from the same client both
 * succeed and the second one looks like token theft.
 */
export function authTransaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return authDb.$transaction(work, TRANSACTION_OPTIONS);
}

// --- Users -----------------------------------------------------------------

export interface AuthUserRow {
  id: string;
  email: string;
  password_hash: string | null;
  email_verified_at: Date | null;
  status: 'active' | 'suspended' | 'pending_deletion';
}

export async function findUserByEmail(
  email: string,
  client: AuthClient = authDb,
): Promise<AuthUserRow | null> {
  const rows = await client.$queryRaw<AuthUserRow[]>`
    SELECT id, email::text AS email, password_hash, email_verified_at, status
      FROM users
     WHERE email = ${email}::citext
       AND deleted_at IS NULL
     LIMIT 1`;
  return rows[0] ?? null;
}

export async function findUserById(
  userId: string,
  client: AuthClient = authDb,
): Promise<AuthUserRow | null> {
  const rows = await client.$queryRaw<AuthUserRow[]>`
    SELECT id, email::text AS email, password_hash, email_verified_at, status
      FROM users
     WHERE id = ${userId}::uuid
       AND deleted_at IS NULL
     LIMIT 1`;
  return rows[0] ?? null;
}

/**
 * Creates the account. The companion profile, preferences and notification
 * rows are created by a database trigger in the same transaction, so a caller
 * that stops here still leaves a coherent user behind.
 *
 * Returns null when the address is already taken, rather than throwing, because
 * the caller has to treat that case as an ordinary outcome and not an error.
 */
export async function createUser(
  email: string,
  passwordHash: string | null,
  client: AuthClient = authDb,
): Promise<AuthUserRow | null> {
  const rows = await client.$queryRaw<AuthUserRow[]>`
    INSERT INTO users (email, password_hash)
    VALUES (${email}::citext, ${passwordHash})
    ON CONFLICT (email) WHERE deleted_at IS NULL DO NOTHING
    RETURNING id, email::text AS email, password_hash, email_verified_at, status`;
  return rows[0] ?? null;
}

export async function setPasswordHash(
  userId: string,
  passwordHash: string,
  client: AuthClient = authDb,
): Promise<void> {
  await client.$executeRaw`
    UPDATE users SET password_hash = ${passwordHash}
     WHERE id = ${userId}::uuid AND deleted_at IS NULL`;
}

/** Idempotent: verifying an already-verified address is a no-op, not an error. */
export async function markEmailVerified(
  userId: string,
  client: AuthClient = authDb,
): Promise<void> {
  await client.$executeRaw`
    UPDATE users SET email_verified_at = now()
     WHERE id = ${userId}::uuid AND email_verified_at IS NULL`;
}

// --- Sessions --------------------------------------------------------------

export type SessionClient = 'daybook' | 'fitness';

export type RevokeReason =
  'logout' | 'logout_all' | 'rotation' | 'reuse_detected' | 'password_change' | 'account_deleted';

export interface SessionRow {
  id: string;
  user_id: string;
  family_id: string;
  issued_at: Date;
  expires_at: Date;
  rotated_at: Date | null;
  revoked_at: Date | null;
  revoked_reason: RevokeReason | null;
  client: SessionClient;
}

export interface CreateSessionInput {
  userId: string;
  familyId: string;
  tokenHash: Uint8Array;
  expiresAt: Date;
  client: SessionClient;
  userAgentHash: Uint8Array | null;
  ipHash: Uint8Array | null;
}

export async function createSession(
  input: CreateSessionInput,
  client: AuthClient = authDb,
): Promise<SessionRow> {
  const rows = await client.$queryRaw<SessionRow[]>`
    INSERT INTO auth_sessions
      (user_id, family_id, refresh_token_hash, expires_at, client, user_agent_hash, ip_hash)
    VALUES (${input.userId}::uuid, ${input.familyId}::uuid, ${Buffer.from(input.tokenHash)},
            ${input.expiresAt}, ${input.client}, ${toBufferOrNull(input.userAgentHash)},
            ${toBufferOrNull(input.ipHash)})
    RETURNING id, user_id, family_id, issued_at, expires_at, rotated_at,
              revoked_at, revoked_reason, client`;
  const row = rows[0];
  if (!row) {
    // RETURNING on a plain INSERT always yields a row; if it did not, something
    // is wrong that silently returning undefined would only hide.
    throw new Error('createSession inserted no row');
  }
  return row;
}

/**
 * Looks a session up by the hash of the presented token.
 *
 * Deliberately returns revoked, rotated and expired sessions too. The caller
 * has to be able to tell "this token is unknown" from "this token was already
 * used", because those mean very different things: the first is a stale client,
 * the second is a stolen token.
 */
export async function findSessionByTokenHash(
  tokenHash: Uint8Array,
  client: AuthClient = authDb,
): Promise<SessionRow | null> {
  const rows = await client.$queryRaw<SessionRow[]>`
    SELECT id, user_id, family_id, issued_at, expires_at, rotated_at,
           revoked_at, revoked_reason, client
      FROM auth_sessions
     WHERE refresh_token_hash = ${Buffer.from(tokenHash)}
     LIMIT 1`;
  return rows[0] ?? null;
}

/** Marks the old session rotated and points it at its replacement. */
export function markRotated(
  sessionId: string,
  replacedBy: string,
  client: AuthClient = authDb,
): Promise<number> {
  return client.$executeRaw`
    UPDATE auth_sessions
       SET rotated_at = now(), replaced_by = ${replacedBy}::uuid
     WHERE id = ${sessionId}::uuid
       AND rotated_at IS NULL
       AND revoked_at IS NULL`;
}

export function revokeSession(
  sessionId: string,
  reason: RevokeReason,
  client: AuthClient = authDb,
): Promise<number> {
  return client.$executeRaw`
    UPDATE auth_sessions
       SET revoked_at = now(), revoked_reason = ${reason}
     WHERE id = ${sessionId}::uuid AND revoked_at IS NULL`;
}

/**
 * Revokes an entire token family.
 *
 * A family is one chain of rotations: sign in once, refresh forty times, and
 * all forty-one rows share a family_id. Presenting a token that has already
 * been rotated means either the client replayed a request or somebody else has
 * a copy, and there is no way to tell which from the request alone. So the
 * whole chain dies and both the legitimate user and the thief have to sign in
 * again. Signing in again is a small cost; leaving a thief with a live session
 * is not.
 */
export function revokeFamily(
  familyId: string,
  reason: RevokeReason,
  client: AuthClient = authDb,
): Promise<number> {
  return client.$executeRaw`
    UPDATE auth_sessions
       SET revoked_at = now(), revoked_reason = ${reason}
     WHERE family_id = ${familyId}::uuid AND revoked_at IS NULL`;
}

export function revokeAllForUser(
  userId: string,
  reason: RevokeReason,
  client: AuthClient = authDb,
): Promise<number> {
  return client.$executeRaw`
    UPDATE auth_sessions
       SET revoked_at = now(), revoked_reason = ${reason}
     WHERE user_id = ${userId}::uuid AND revoked_at IS NULL`;
}

export interface ActiveSessionRow {
  id: string;
  client: SessionClient;
  issued_at: Date;
  expires_at: Date;
}

/** What "sign out everywhere" is about to close, shown to the user first. */
export function listActiveSessions(
  userId: string,
  client: AuthClient = authDb,
): Promise<ActiveSessionRow[]> {
  return client.$queryRaw<ActiveSessionRow[]>`
    SELECT id, client, issued_at, expires_at
      FROM auth_sessions
     WHERE user_id = ${userId}::uuid
       AND revoked_at IS NULL
       AND rotated_at IS NULL
       AND expires_at > now()
     ORDER BY issued_at DESC`;
}

// --- Single-use tokens -----------------------------------------------------

/**
 * Email verification and password reset are the same shape twice: a hash, an
 * expiry and a used_at stamp. They stay in separate tables because they have
 * different lifetimes and very different consequences, and one table with a
 * `kind` column invites a bug where a verification link resets a password.
 */
type TokenTable = 'email_verification_tokens' | 'password_reset_tokens';

export interface TokenRow {
  id: string;
  user_id: string;
  expires_at: Date;
  used_at: Date | null;
}

export async function createEmailVerificationToken(
  userId: string,
  tokenHash: Uint8Array,
  expiresAt: Date,
  client: AuthClient = authDb,
): Promise<void> {
  await client.$executeRaw`
    INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
    VALUES (${userId}::uuid, ${Buffer.from(tokenHash)}, ${expiresAt})`;
}

export async function createPasswordResetToken(
  userId: string,
  tokenHash: Uint8Array,
  expiresAt: Date,
  client: AuthClient = authDb,
): Promise<void> {
  await client.$executeRaw`
    INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
    VALUES (${userId}::uuid, ${Buffer.from(tokenHash)}, ${expiresAt})`;
}

/**
 * Claims a token: marks it used and returns whose it was, or null if it was
 * unknown, expired or already used.
 *
 * The check and the claim are one UPDATE rather than a SELECT followed by an
 * UPDATE, so two simultaneous uses of the same reset link cannot both win.
 */
export async function consumeEmailVerificationToken(
  tokenHash: Uint8Array,
  client: AuthClient = authDb,
): Promise<string | null> {
  const rows = await client.$queryRaw<{ user_id: string }[]>`
    UPDATE email_verification_tokens
       SET used_at = now()
     WHERE token_hash = ${Buffer.from(tokenHash)}
       AND used_at IS NULL
       AND expires_at > now()
    RETURNING user_id`;
  return rows[0]?.user_id ?? null;
}

export async function consumePasswordResetToken(
  tokenHash: Uint8Array,
  client: AuthClient = authDb,
): Promise<string | null> {
  const rows = await client.$queryRaw<{ user_id: string }[]>`
    UPDATE password_reset_tokens
       SET used_at = now()
     WHERE token_hash = ${Buffer.from(tokenHash)}
       AND used_at IS NULL
       AND expires_at > now()
    RETURNING user_id`;
  return rows[0]?.user_id ?? null;
}

/**
 * Invalidates a user's outstanding tokens of one kind.
 *
 * Requesting a second reset link should make the first one dead, or a link
 * from an email the user has since decided was suspicious keeps working.
 */
export function invalidateOutstandingTokens(
  userId: string,
  table: TokenTable,
  client: AuthClient = authDb,
): Promise<number> {
  // The table name is not a bindable parameter, so it is not interpolated: the
  // two statements are written out and chosen between.
  if (table === 'email_verification_tokens') {
    return client.$executeRaw`
      UPDATE email_verification_tokens SET used_at = now()
       WHERE user_id = ${userId}::uuid AND used_at IS NULL`;
  }
  return client.$executeRaw`
    UPDATE password_reset_tokens SET used_at = now()
     WHERE user_id = ${userId}::uuid AND used_at IS NULL`;
}

// --- Federated identities --------------------------------------------------

export type IdentityProvider = 'google' | 'apple';

export interface IdentityRow {
  id: string;
  user_id: string;
  provider: IdentityProvider;
  provider_account_id: string;
  email_at_provider: string | null;
}

/**
 * Finds an identity by what the provider calls the account.
 *
 * The lookup is on the provider's subject id, never on the email address. A
 * subject id is stable and belongs to the provider; an email address can be
 * changed at the provider, released and re-registered by somebody else, or
 * simply be an alias. Matching on it is how one person ends up signed in to
 * another person's account.
 */
export async function findIdentity(
  provider: IdentityProvider,
  providerAccountId: string,
  client: AuthClient = authDb,
): Promise<IdentityRow | null> {
  const rows = await client.$queryRaw<IdentityRow[]>`
    SELECT id, user_id, provider, provider_account_id,
           email_at_provider::text AS email_at_provider
      FROM auth_identities
     WHERE provider = ${provider}
       AND provider_account_id = ${providerAccountId}
     LIMIT 1`;
  return rows[0] ?? null;
}

/** Every identity a user has, for the account settings page. */
export function listIdentities(
  userId: string,
  client: AuthClient = authDb,
): Promise<IdentityRow[]> {
  return client.$queryRaw<IdentityRow[]>`
    SELECT id, user_id, provider, provider_account_id,
           email_at_provider::text AS email_at_provider
      FROM auth_identities
     WHERE user_id = ${userId}::uuid
     ORDER BY linked_at`;
}

/**
 * Attaches a provider account to a user.
 *
 * Returns null when that provider account is already attached to somebody,
 * rather than throwing, because two people racing the same sign-in is an
 * ordinary outcome and the caller has to handle it either way.
 */
export async function linkIdentity(
  input: {
    userId: string;
    provider: IdentityProvider;
    providerAccountId: string;
    emailAtProvider: string | null;
  },
  client: AuthClient = authDb,
): Promise<IdentityRow | null> {
  const rows = await client.$queryRaw<IdentityRow[]>`
    INSERT INTO auth_identities
      (user_id, provider, provider_account_id, email_at_provider, last_login_at)
    VALUES (${input.userId}::uuid, ${input.provider}, ${input.providerAccountId},
            ${input.emailAtProvider}::citext, now())
    ON CONFLICT (provider, provider_account_id) DO NOTHING
    RETURNING id, user_id, provider, provider_account_id,
              email_at_provider::text AS email_at_provider`;
  return rows[0] ?? null;
}

/**
 * Records a sign-in through this identity, and keeps the provider's idea of
 * the address current so the settings page can show which account it is.
 */
export function touchIdentity(
  identityId: string,
  emailAtProvider: string | null,
  client: AuthClient = authDb,
): Promise<number> {
  return client.$executeRaw`
    UPDATE auth_identities
       SET last_login_at = now(),
           email_at_provider = COALESCE(${emailAtProvider}::citext, email_at_provider)
     WHERE id = ${identityId}::uuid`;
}

function toBufferOrNull(value: Uint8Array | null): Buffer | null {
  return value === null ? null : Buffer.from(value);
}
