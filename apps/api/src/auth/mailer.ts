import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AppConfig } from '../config.ts';
import { CONFIG } from '../config.provider.ts';

export interface Mailer {
  sendEmailVerification(email: string, link: string): Promise<void>;
  sendPasswordReset(email: string, link: string): Promise<void>;
  /** Sent when a reset is requested for an address with no account. */
  sendPasswordResetForUnknownAddress(email: string): Promise<void>;
}

export const MAILER = Symbol('MAILER');

/**
 * Development delivery: the link goes to the log.
 *
 * A real provider is Phase 11 work, and standing one up now would mean a
 * verified sending domain, DKIM records and a paid account before anyone can
 * register a test user. The interface above is what a provider will implement,
 * so nothing outside this file changes when that happens.
 *
 * The important part is that the flow is real. The token is generated, stored
 * hashed, expires and is single-use; only the transport is a console line. That
 * is the difference between a placeholder and a lie about what works.
 */
@Injectable()
export class ConsoleMailer implements Mailer {
  private readonly log = new Logger('Mailer');

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  sendEmailVerification(email: string, link: string): Promise<void> {
    this.deliver('verify your email', email, link);
    return Promise.resolve();
  }

  sendPasswordReset(email: string, link: string): Promise<void> {
    this.deliver('reset your password', email, link);
    return Promise.resolve();
  }

  sendPasswordResetForUnknownAddress(email: string): Promise<void> {
    // A real provider sends "someone asked to reset a password for this
    // address, but there is no account here". It matters: it tells a person
    // whose address was mistyped by someone else what happened, and it keeps
    // the API's answer identical whether or not the account exists.
    this.log.log(`[mail] to ${email}: a reset was requested, but no account exists here`);
    return Promise.resolve();
  }

  private deliver(subject: string, email: string, link: string): void {
    if (this.config.isProduction) {
      // Refusing loudly beats logging a live password-reset link into a
      // production log aggregator that half the company can read.
      this.log.error(
        `Refusing to log a ${subject} link in production. Configure a real mail provider.`,
      );
      return;
    }
    this.log.log(`\n[mail] to ${email}\n[mail] ${subject}: ${link}\n`);
  }
}
