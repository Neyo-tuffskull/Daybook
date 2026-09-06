import { Inject, Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import type { AppConfig } from '../config.ts';
import { CONFIG } from '../config.provider.ts';

/**
 * Password hashing, and the small amount of care that makes login stop leaking.
 *
 * Argon2id, not bcrypt: bcrypt silently truncates at 72 bytes and its cost is
 * pure CPU, which a GPU farm parallelises cheaply. Argon2id's memory cost is
 * what makes that expensive, and it won the Password Hashing Competition on
 * exactly that argument.
 *
 * The parameters are not baked into the code. They live in configuration and
 * are recorded inside every hash string, so raising them later strengthens new
 * passwords without invalidating a single existing one.
 */
@Injectable()
export class PasswordService {
  private readonly options: argon2.Options;

  /**
   * A hash of a password nobody knows, computed once at boot.
   *
   * Login has to take the same time whether or not the address exists. Return
   * early on an unknown address and the endpoint becomes an account
   * enumeration oracle: 4ms means no such user, 90ms means the password was
   * wrong. So an unknown address gets verified against this instead, and the
   * two paths do the same work.
   */
  private readonly decoyHash: Promise<string>;

  constructor(@Inject(CONFIG) config: AppConfig) {
    this.options = {
      type: argon2.argon2id,
      memoryCost: config.argon2.memoryCost,
      timeCost: config.argon2.timeCost,
      parallelism: config.argon2.parallelism,
    };
    this.decoyHash = argon2.hash(
      // Not a constant string: a fixed decoy across all deployments would let
      // someone with the source measure this exact hash and calibrate against it.
      crypto.randomUUID() + crypto.randomUUID(),
      this.options,
    );
  }

  hash(plaintext: string): Promise<string> {
    return argon2.hash(plaintext, this.options);
  }

  /**
   * Verifies a password. Never throws: a malformed hash in the database is a
   * failed verification, not a 500 that tells the caller something unusual
   * about this particular account.
   */
  async verify(hash: string | null, plaintext: string): Promise<boolean> {
    if (hash === null) {
      // An account with no password: created through Google sign-in. Still burn
      // the time, so "this address exists but has no password" is not
      // measurable either.
      await this.burnTime(plaintext);
      return false;
    }
    try {
      return await argon2.verify(hash, plaintext);
    } catch {
      return false;
    }
  }

  /** Spends the same effort a real verification would, and discards it. */
  async burnTime(plaintext: string): Promise<void> {
    try {
      await argon2.verify(await this.decoyHash, plaintext);
    } catch {
      // Expected: the password will not match. The point was the work, not the
      // answer.
    }
  }

  /**
   * True when a hash was made with weaker parameters than the ones now
   * configured, so the caller can quietly upgrade it during a successful login,
   * where the plaintext is available and the user is already waiting.
   */
  needsRehash(hash: string): boolean {
    try {
      return argon2.needsRehash(hash, this.options);
    } catch {
      return false;
    }
  }
}
