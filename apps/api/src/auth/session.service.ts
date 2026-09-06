import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  authTransaction,
  createSession,
  findSessionByTokenHash,
  markRotated,
  revokeAllForUser,
  revokeFamily,
  revokeSession,
  type AuthClient,
  type SessionClient,
} from '@daybook/db';
import type { AppConfig } from '../config.ts';
import { CONFIG } from '../config.provider.ts';
import { TokenService } from './token.service.ts';

export interface IssuedSession {
  sessionId: string;
  refreshToken: string;
  expiresAt: Date;
}

export interface RefreshContext {
  userAgent?: string;
  ip?: string;
}

/**
 * The outcome of presenting a refresh token. Three states, not two, because the
 * caller has to be able to tell an ordinary expiry from a stolen token.
 */
export type RefreshOutcome =
  | { kind: 'rotated'; userId: string; client: SessionClient; issued: IssuedSession }
  | { kind: 'rejected' }
  | { kind: 'reuse_detected'; userId: string; familyId: string; revoked: number };

@Injectable()
export class SessionService {
  private readonly log = new Logger(SessionService.name);

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly tokens: TokenService,
  ) {}

  /** Starts a new family: this is a sign-in, not a continuation. */
  issue(
    userId: string,
    client: SessionClient,
    context: RefreshContext = {},
  ): Promise<IssuedSession> {
    return this.mint(userId, randomUUID(), client, context);
  }

  /**
   * Exchanges a refresh token for its successor.
   *
   * The whole exchange is one transaction. Two tabs refreshing at the same
   * instant would otherwise both read a live session, both mint a successor,
   * and the second one to write would look exactly like an attacker replaying a
   * stolen token, which would sign the user out of everything. Serialising it
   * means the loser sees an already-rotated row and gets a plain rejection.
   *
   * Reuse detection is the reason rotated rows are kept rather than deleted. A
   * token that has already been rotated is either a client replaying a request
   * or somebody else holding a copy, and nothing in the request distinguishes
   * them. So the entire family is revoked: the legitimate user signs in again,
   * and so does the thief, without the password.
   */
  async refresh(presentedToken: string, context: RefreshContext = {}): Promise<RefreshOutcome> {
    const hash = this.tokens.hashToken(presentedToken);

    try {
      return await authTransaction(async (tx): Promise<RefreshOutcome> => {
        const session = await findSessionByTokenHash(hash, tx);
        if (!session) {
          // Unknown token. Not a family we can revoke, and not necessarily an
          // attack: an old cookie from a pruned session looks like this.
          return { kind: 'rejected' };
        }

        if (session.rotated_at !== null) {
          const revoked = await revokeFamily(session.family_id, 'reuse_detected', tx);
          this.log.warn(
            { userId: session.user_id, familyId: session.family_id, revoked },
            'refresh token reuse detected, family revoked',
          );
          return {
            kind: 'reuse_detected',
            userId: session.user_id,
            familyId: session.family_id,
            revoked,
          };
        }

        if (session.revoked_at !== null || session.expires_at.getTime() <= Date.now()) {
          return { kind: 'rejected' };
        }

        const issued = await this.mint(
          session.user_id,
          session.family_id,
          session.client,
          context,
          tx,
        );

        // Conditional on rotated_at still being null, so if a concurrent
        // transaction somehow got there first this update touches nothing and
        // we can tell.
        const marked = await markRotated(session.id, issued.sessionId, tx);
        if (marked !== 1) {
          // Someone else rotated this row inside our transaction window. Roll
          // back rather than leave two live successors behind.
          throw new ConcurrentRotationError();
        }

        return { kind: 'rotated', userId: session.user_id, client: session.client, issued };
      });
    } catch (error) {
      if (error instanceof ConcurrentRotationError) {
        return { kind: 'rejected' };
      }
      throw error;
    }
  }

  /** Ends one session. Used by sign-out on this device. */
  async endSession(sessionId: string): Promise<void> {
    await revokeSession(sessionId, 'logout');
  }

  /** Ends every session the user has anywhere. */
  endAllSessions(userId: string, reason: 'logout_all' | 'password_change'): Promise<number> {
    return revokeAllForUser(userId, reason);
  }

  private async mint(
    userId: string,
    familyId: string,
    client: SessionClient,
    context: RefreshContext,
    tx?: AuthClient,
  ): Promise<IssuedSession> {
    const { token, hash } = this.tokens.newRefreshToken();
    const expiresAt = new Date(Date.now() + this.config.refreshTokenTtlDays * 24 * 60 * 60 * 1000);
    const row = await createSession(
      {
        userId,
        familyId,
        tokenHash: hash,
        expiresAt,
        client,
        userAgentHash: this.tokens.fingerprint(context.userAgent),
        ipHash: this.tokens.fingerprint(context.ip),
      },
      tx,
    );
    return { sessionId: row.id, refreshToken: token, expiresAt };
  }
}

/** Internal signal, never surfaced: it exists to roll the transaction back. */
class ConcurrentRotationError extends Error {
  constructor() {
    super('another request rotated this session first');
  }
}
