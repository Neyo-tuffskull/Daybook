import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  authTransaction,
  consumeEmailVerificationToken,
  consumePasswordResetToken,
  createEmailVerificationToken,
  createPasswordResetToken,
  createUser,
  findUserByEmail,
  findIdentity,
  findUserById,
  getProfile,
  linkIdentity,
  touchIdentity,
  invalidateOutstandingTokens,
  markEmailVerified,
  setPasswordHash,
  updateProfile,
  type AuthUserRow,
  type IdentityProvider,
  type SessionClient,
} from '@daybook/db';
import { assertValidTimeZone } from '@daybook/domain';
import type { AppConfig } from '../config.ts';
import { CONFIG } from '../config.provider.ts';
import { PasswordService } from './password.service.ts';
import { TokenService } from './token.service.ts';
import { SessionService, type IssuedSession, type RefreshContext } from './session.service.ts';
import { MAILER, type Mailer } from './mailer.ts';

export interface SignedInUser {
  id: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
  timezone: string;
}

/**
 * Why a federated sign-in was turned away. The distinction matters to the
 * person: one of these is fixable by them and the other is not.
 */
export type FederatedRefusal = 'unverified_email' | 'account_unavailable';

export interface SignInResult {
  accessToken: string;
  expiresIn: number;
  session: IssuedSession;
  user: SignedInUser;
}

@Injectable()
export class AuthService {
  private readonly log = new Logger(AuthService.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
  ) {}

  // --- Registration --------------------------------------------------------

  /**
   * Creates an account and signs the person in.
   *
   * Signing them in immediately, before the address is verified, is a
   * deliberate choice. Making people go and find an email before they can see
   * anything is where a lot of people give up, and the account is not dangerous
   * yet: verification gates the things that need a real address, which is
   * password reset and, later, notifications.
   *
   * Returns null when the address already has an account, rather than
   * throwing, so that the decision about what to tell the caller lives in one
   * place: the controller, which explains it.
   */
  async register(input: {
    email: string;
    password: string;
    displayName?: string;
    timezone: string;
    client: SessionClient;
    context: RefreshContext;
  }): Promise<SignInResult | null> {
    // Validated here rather than left to the database trigger, so the caller
    // gets a 422 naming the field instead of a 500 from a constraint violation.
    try {
      assertValidTimeZone(input.timezone);
    } catch {
      throw new UnprocessableEntityException(`Unknown IANA timezone: ${input.timezone}`);
    }

    const email = normaliseEmail(input.email);
    const hash = await this.passwords.hash(input.password);
    const user = await createUser(email, hash);

    if (!user) {
      // Address taken. The caller decides what to say; this returns null rather
      // than throwing so that the decision lives in one place.
      return null;
    }

    // The trigger in migration 0003 has already created the profile row; this
    // fills in what the person told us. It runs as the user under row-level
    // security, so it can only ever touch their own row.
    await updateProfile(user.id, {
      displayName: input.displayName ?? null,
      timezone: input.timezone,
    });

    await this.issueEmailVerification(user.id, email);

    return this.completeSignIn(user, input.client, input.context, {
      displayName: input.displayName ?? null,
      timezone: input.timezone,
    });
  }

  // --- Sign in -------------------------------------------------------------

  /**
   * Verifies a password and starts a session.
   *
   * Every failure path does the same work and returns the same answer. An
   * unknown address still runs an Argon2 verification against a decoy hash, a
   * suspended account still verifies the real password, and all three cases
   * return null. Anything else turns this endpoint into a way to find out who
   * has an account, and then which of those accounts are locked.
   */
  async signIn(input: {
    email: string;
    password: string;
    client: SessionClient;
    context: RefreshContext;
  }): Promise<SignInResult | null> {
    const email = normaliseEmail(input.email);
    const user = await findUserByEmail(email);

    if (!user) {
      await this.passwords.burnTime(input.password);
      return null;
    }

    const correct = await this.passwords.verify(user.password_hash, input.password);
    if (!correct) return null;

    if (user.status !== 'active') {
      this.log.warn(
        { userId: user.id, status: user.status },
        'sign-in refused for inactive account',
      );
      return null;
    }

    // The password was right, the user is waiting anyway, and the plaintext is
    // in hand: the only moment an old hash can be upgraded.
    if (user.password_hash && this.passwords.needsRehash(user.password_hash)) {
      const upgraded = await this.passwords.hash(input.password);
      await setPasswordHash(user.id, upgraded);
      this.log.log({ userId: user.id }, 'password hash upgraded to current parameters');
    }

    return this.completeSignIn(user, input.client, input.context);
  }

  // --- Refresh -------------------------------------------------------------

  /**
   * Exchanges a refresh token for a new access token and a new refresh token.
   *
   * Returns null for every failure, including detected reuse. The client cannot
   * be told which happened: an attacker holding a stolen token would learn from
   * a distinct response that the theft had been noticed.
   */
  async refresh(presentedToken: string, context: RefreshContext): Promise<SignInResult | null> {
    const outcome = await this.sessions.refresh(presentedToken, context);
    if (outcome.kind !== 'rotated') return null;

    const user = await findUserById(outcome.userId);
    if (!user || user.status !== 'active') return null;

    const profile = await getProfile(user.id);
    const accessToken = await this.tokens.signAccessToken({
      sub: user.id,
      cli: outcome.client,
      sid: outcome.issued.sessionId,
      evf: user.email_verified_at !== null,
    });

    return {
      accessToken,
      expiresIn: this.config.accessTokenTtlSeconds,
      session: outcome.issued,
      user: {
        id: user.id,
        email: user.email,
        emailVerified: user.email_verified_at !== null,
        displayName: profile?.display_name ?? null,
        timezone: profile?.timezone ?? 'Europe/London',
      },
    };
  }

  // --- Federated sign-in ---------------------------------------------------

  /**
   * Signs in through an identity a provider has vouched for.
   *
   * Three outcomes, and the one that matters is the refusal. The rules:
   *
   * 1. The provider account is already linked. Sign in as its owner. Nothing
   *    about the email address is consulted, because the link was established
   *    once and the provider's subject id is what identifies the account.
   *
   * 2. The provider account is unknown and the provider says the address is
   *    verified. Attach it to the account with that address, or create one.
   *    "Verified" is the whole basis for doing this: the provider is asserting
   *    that this person controls that mailbox, which is the same thing our own
   *    verification link proves.
   *
   * 3. The provider account is unknown and the address is absent or
   *    unverified. Refuse, and say so. Linking on an unverified address is the
   *    classic account takeover: register `someone@example.com` at a provider
   *    that does not check, sign in here, and inherit their account. The person
   *    can still sign in with their password and link the account deliberately
   *    from settings, which is a Phase 13 screen.
   */
  async signInWithIdentity(input: {
    provider: IdentityProvider;
    subject: string;
    email: string | null;
    emailVerified: boolean;
    displayName: string | null;
    client: SessionClient;
    context: RefreshContext;
  }): Promise<SignInResult | { refused: FederatedRefusal }> {
    const existing = await findIdentity(input.provider, input.subject);
    if (existing) {
      await touchIdentity(existing.id, input.email);
      const user = await findUserById(existing.user_id);
      if (!user || user.status !== 'active') {
        this.log.warn(
          { userId: existing.user_id, provider: input.provider },
          'federated sign-in refused for a missing or inactive account',
        );
        return { refused: 'account_unavailable' };
      }
      return this.completeSignIn(user, input.client, input.context);
    }

    const email = input.email ? normaliseEmail(input.email) : null;
    if (!email || !input.emailVerified) {
      this.log.warn(
        { provider: input.provider, hasEmail: email !== null },
        'federated sign-in refused: the provider did not vouch for an address',
      );
      return { refused: 'unverified_email' };
    }

    const user = await this.attachOrCreate(input.provider, input.subject, email, input.displayName);
    if (!user) return { refused: 'account_unavailable' };

    return this.completeSignIn(user, input.client, input.context);
  }

  /**
   * Finds or creates the account behind a verified provider identity, and
   * attaches the identity to it.
   *
   * One transaction, because a user with no identity and no password is an
   * account nobody can ever sign in to, and a crash between the two writes
   * would create exactly that.
   */
  private async attachOrCreate(
    provider: IdentityProvider,
    subject: string,
    email: string,
    displayName: string | null,
  ): Promise<AuthUserRow | null> {
    const user = await authTransaction(async (tx) => {
      const found = await findUserByEmail(email, tx);
      // No password hash: this account has never had a password, and the reset
      // flow is how its owner sets one if they ever want to sign in without
      // the provider.
      const account = found ?? (await createUser(email, null, tx));
      if (!account) return null;

      const linked = await linkIdentity(
        { userId: account.id, provider, providerAccountId: subject, emailAtProvider: email },
        tx,
      );
      if (!linked) {
        // Somebody else linked this provider account between the lookup and
        // here. Rare, and the second request should simply follow the first.
        return null;
      }

      // The provider vouched for the address, which is the same assurance our
      // own verification link gives. Making them prove it twice teaches people
      // that verification emails are noise.
      await markEmailVerified(account.id, tx);
      return { ...account, email_verified_at: account.email_verified_at ?? new Date() };
    });

    if (user) {
      if (displayName) {
        // Outside the transaction because it runs as the user under row-level
        // security on a different connection, and because a failure here costs
        // a display name rather than an account.
        await updateProfile(user.id, { displayName });
      }
      this.log.log({ userId: user.id, provider }, 'account linked to a federated identity');
      return user;
    }

    // The link raced. Re-read and follow whoever won.
    const identity = await findIdentity(provider, subject);
    return identity ? findUserById(identity.user_id) : null;
  }

  // --- Sign out ------------------------------------------------------------

  async signOut(sessionId: string): Promise<void> {
    await this.sessions.endSession(sessionId);
  }

  signOutEverywhere(userId: string): Promise<number> {
    return this.sessions.endAllSessions(userId, 'logout_all');
  }

  // --- Email verification --------------------------------------------------

  async issueEmailVerification(userId: string, email: string): Promise<void> {
    // Any earlier link stops working. Otherwise "resend" leaves a trail of live
    // links, each one a way in for anyone who saw any of those emails.
    await invalidateOutstandingTokens(userId, 'email_verification_tokens');

    const { token, hash } = this.tokens.newLinkToken();
    const expiresAt = new Date(Date.now() + this.config.emailTokenTtlHours * 60 * 60 * 1000);
    await createEmailVerificationToken(userId, hash, expiresAt);
    await this.mailer.sendEmailVerification(
      email,
      `${this.config.appPublicUrl}/verify-email?token=${token}`,
    );
  }

  /** True if the token was good. Consumption is atomic, so a link works once. */
  async verifyEmail(token: string): Promise<boolean> {
    const userId = await consumeEmailVerificationToken(this.tokens.hashToken(token));
    if (!userId) return false;
    await markEmailVerified(userId);
    return true;
  }

  async resendVerification(userId: string): Promise<void> {
    const user = await findUserById(userId);
    if (!user || user.email_verified_at !== null) return;
    await this.issueEmailVerification(user.id, user.email);
  }

  // --- Password reset ------------------------------------------------------

  /**
   * Always succeeds from the caller's point of view, whether or not the address
   * is on file. The alternative is a form that answers "is this person a user
   * here", which is the sort of thing that matters to somebody eventually.
   */
  async requestPasswordReset(rawEmail: string): Promise<void> {
    const email = normaliseEmail(rawEmail);
    const user = await findUserByEmail(email);

    if (!user) {
      await this.mailer.sendPasswordResetForUnknownAddress(email);
      return;
    }

    await invalidateOutstandingTokens(user.id, 'password_reset_tokens');
    const { token, hash } = this.tokens.newLinkToken();
    const expiresAt = new Date(Date.now() + this.config.resetTokenTtlMinutes * 60 * 1000);
    await createPasswordResetToken(user.id, hash, expiresAt);
    await this.mailer.sendPasswordReset(
      email,
      `${this.config.appPublicUrl}/reset-password?token=${token}`,
    );
  }

  /**
   * Sets a new password and ends every existing session.
   *
   * Ending the sessions is the point of a reset as much as the new password is.
   * Somebody resetting a password they think was compromised expects it to
   * remove whoever else was signed in; leaving thirty days of live refresh
   * tokens in place would make the reset cosmetic.
   */
  async resetPassword(token: string, newPassword: string): Promise<boolean> {
    const userId = await consumePasswordResetToken(this.tokens.hashToken(token));
    if (!userId) return false;

    const hash = await this.passwords.hash(newPassword);
    await setPasswordHash(userId, hash);
    const revoked = await this.sessions.endAllSessions(userId, 'password_change');

    // A reset link only reaches the address on the account, so using one proves
    // control of that address as surely as the verification link does.
    await markEmailVerified(userId);

    this.log.log({ userId, revoked }, 'password reset, all sessions ended');
    return true;
  }

  /** Signed-in password change. Requires the current password, not just a session. */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<boolean> {
    const user = await findUserById(userId);
    if (!user) throw new UnauthorizedException('Not signed in.');

    const correct = await this.passwords.verify(user.password_hash, currentPassword);
    if (!correct) return false;

    await setPasswordHash(userId, await this.passwords.hash(newPassword));
    const revoked = await this.sessions.endAllSessions(userId, 'password_change');
    this.log.log({ userId, revoked }, 'password changed, all sessions ended');
    return true;
  }

  // --- Shared --------------------------------------------------------------

  private async completeSignIn(
    user: AuthUserRow,
    client: SessionClient,
    context: RefreshContext,
    known?: { displayName: string | null; timezone: string },
  ): Promise<SignInResult> {
    const session = await this.sessions.issue(user.id, client, context);
    const accessToken = await this.tokens.signAccessToken({
      sub: user.id,
      cli: client,
      sid: session.sessionId,
      evf: user.email_verified_at !== null,
    });

    // Registration already knows the timezone and display name it just wrote,
    // so it passes them in rather than paying for a read-back.
    const profile = known ? null : await getProfile(user.id);

    return {
      accessToken,
      expiresIn: this.config.accessTokenTtlSeconds,
      session,
      user: {
        id: user.id,
        email: user.email,
        emailVerified: user.email_verified_at !== null,
        displayName: known ? known.displayName : (profile?.display_name ?? null),
        // The fallback is the column default, and it is only reachable if the
        // profile row vanished between the trigger creating it and this read.
        timezone: known ? known.timezone : (profile?.timezone ?? 'Europe/London'),
      },
    };
  }
}

/**
 * The email column is citext, so the database already compares
 * case-insensitively. Trimming and lowercasing here as well means the stored
 * value looks like what the person typed rather than like whatever their
 * keyboard did, and that two rows can never differ by whitespace alone.
 */
function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}
