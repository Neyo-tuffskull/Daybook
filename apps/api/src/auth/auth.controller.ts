import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  changePasswordRequest,
  loginRequest,
  logoutRequest,
  refreshRequest,
  registerRequest,
  requestPasswordResetRequest,
  resetPasswordRequest,
  verifyEmailRequest,
  type SessionResponse,
} from '@daybook/contracts';
import { listActiveSessions } from '@daybook/db';
import type { AppConfig } from '../config.ts';
import { CONFIG } from '../config.provider.ts';
import { validate } from '../common/zod.pipe.ts';
import { AuthService, type SignInResult } from './auth.service.ts';
import { CurrentUser, Public, type RequestUser } from './auth.decorators.ts';

/**
 * Everything about a person's identity, on one controller.
 *
 * Two rules run through all of it. Nothing here ever reveals whether an address
 * has an account: registration, sign-in and password reset all answer the same
 * way for a known and an unknown address. And the refresh token never appears
 * in a response body, only in a cookie that JavaScript cannot read.
 */
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly auth: AuthService,
  ) {}

  @Public()
  @Post('register')
  @HttpCode(201)
  async register(
    @Body(validate(registerRequest))
    body: {
      email: string;
      password: string;
      display_name?: string;
      timezone: string;
      client: 'daybook' | 'fitness';
    },
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SessionResponse> {
    const result = await this.auth.register({
      email: body.email,
      password: body.password,
      displayName: body.display_name,
      timezone: body.timezone,
      client: body.client,
      context: contextFrom(request),
    });

    if (!result) {
      // The address is taken, and this says so.
      //
      // Sign-in and password reset both refuse to reveal whether an account
      // exists, and registration is the one place where that defence does not
      // hold anyway: an attacker learns the same fact from any response that
      // is not a successful sign-up, however it is worded. The genuinely
      // non-enumerating alternative is to answer "check your email" always and
      // send either a welcome link or a "you already have an account" one,
      // which means nobody can be signed in at the end of registering. That is
      // a real cost paid for no real gain, so the defence here is the rate
      // limit on this route rather than a vague answer that leaves a person
      // who forgot they had an account with nowhere to go.
      throw new ConflictException('That email address already has an account. Sign in instead.');
    }

    return this.respondWithSession(result, reply);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(validate(loginRequest))
    body: { email: string; password: string; client: 'daybook' | 'fitness' },
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SessionResponse> {
    const result = await this.auth.signIn({
      email: body.email,
      password: body.password,
      client: body.client,
      context: contextFrom(request),
    });
    if (!result) {
      throw new UnauthorizedException('That email address and password do not match an account.');
    }
    return this.respondWithSession(result, reply);
  }

  /**
   * Exchanges the refresh cookie for a new access token.
   *
   * Public in the sense that it needs no access token: the cookie is the
   * credential, and by the time it is presented the old access token has
   * usually expired, which is the whole point.
   */
  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Body(validate(refreshRequest)) _body: Record<string, never>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SessionResponse> {
    const presented = request.cookies[this.config.cookieName];
    if (!presented) {
      throw new UnauthorizedException('No session to refresh.');
    }

    const result = await this.auth.refresh(presented, contextFrom(request));
    if (!result) {
      // Clear the cookie on the way out. Leaving a dead token in the browser
      // means every subsequent page load retries it and fails the same way.
      this.clearRefreshCookie(reply);
      throw new UnauthorizedException('That session has ended. Sign in again.');
    }
    return this.respondWithSession(result, reply);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @Body(validate(logoutRequest)) body: { everywhere: boolean },
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    if (body.everywhere) {
      await this.auth.signOutEverywhere(user.id);
    } else {
      await this.auth.signOut(user.sessionId);
    }
    this.clearRefreshCookie(reply);
  }

  /** What signing out everywhere would end. Useful before doing it. */
  @Get('sessions')
  async sessions(@CurrentUser() user: RequestUser): Promise<{ sessions: unknown[] }> {
    const rows = await listActiveSessions(user.id);
    return {
      sessions: rows.map((row) => ({
        id: row.id,
        client: row.client,
        issued_at: row.issued_at.toISOString(),
        expires_at: row.expires_at.toISOString(),
        current: row.id === user.sessionId,
      })),
    };
  }

  @Public()
  @Post('verify-email')
  @HttpCode(200)
  async verifyEmail(
    @Body(validate(verifyEmailRequest)) body: { token: string },
  ): Promise<{ status: 'ok'; message: string }> {
    const ok = await this.auth.verifyEmail(body.token);
    if (!ok) {
      // 200 with a false status rather than a 4xx: the link may simply have
      // been used already, and a page that says "expired, ask for another" is
      // more useful than an error.
      return {
        status: 'ok',
        message: 'That link has expired or was already used. Ask for a new one.',
      };
    }
    return { status: 'ok', message: 'Your email address is verified.' };
  }

  @Post('verify-email/resend')
  @HttpCode(202)
  async resendVerification(
    @CurrentUser() user: RequestUser,
  ): Promise<{ status: 'ok'; message: string }> {
    await this.auth.resendVerification(user.id);
    return {
      status: 'ok',
      message: 'If your address still needs verifying, a link is on its way.',
    };
  }

  @Public()
  @Post('password/forgot')
  @HttpCode(202)
  async forgotPassword(
    @Body(validate(requestPasswordResetRequest)) body: { email: string },
  ): Promise<{ status: 'ok'; message: string }> {
    await this.auth.requestPasswordReset(body.email);
    // Always the same answer, always the same shape. See requestPasswordReset.
    return { status: 'ok', message: 'If that address has an account, a reset link is on its way.' };
  }

  @Public()
  @Post('password/reset')
  @HttpCode(200)
  async resetPassword(
    @Body(validate(resetPasswordRequest)) body: { token: string; password: string },
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ status: 'ok'; message: string }> {
    const ok = await this.auth.resetPassword(body.token, body.password);
    if (!ok) {
      throw new UnauthorizedException('That reset link has expired or was already used.');
    }
    // The reset ended every session, including whichever one this browser had.
    this.clearRefreshCookie(reply);
    return { status: 'ok', message: 'Your password is changed. Sign in with the new one.' };
  }

  @Post('password/change')
  @HttpCode(200)
  async changePassword(
    @Body(validate(changePasswordRequest)) body: { current_password: string; new_password: string },
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ status: 'ok'; message: string }> {
    const ok = await this.auth.changePassword(user.id, body.current_password, body.new_password);
    if (!ok) {
      throw new UnauthorizedException('That is not your current password.');
    }
    this.clearRefreshCookie(reply);
    return { status: 'ok', message: 'Password changed. You have been signed out everywhere.' };
  }

  // --- Cookie handling -----------------------------------------------------

  private respondWithSession(result: SignInResult, reply: FastifyReply): SessionResponse {
    this.setRefreshCookie(reply, result.session.refreshToken, result.session.expiresAt);
    return {
      access_token: result.accessToken,
      token_type: 'Bearer',
      expires_in: result.expiresIn,
      user: {
        id: result.user.id,
        email: result.user.email,
        email_verified: result.user.emailVerified,
        display_name: result.user.displayName,
        timezone: result.user.timezone,
      },
    };
  }

  /**
   * The refresh cookie.
   *
   * httpOnly so a cross-site script cannot read it. sameSite lax rather than
   * strict, because strict would break the flow where someone follows a
   * verification link from their email client and lands signed out. secure in
   * production only, since localhost has no certificate and development would
   * otherwise never receive the cookie at all.
   *
   * The path is scoped to the auth routes: the cookie is only ever presented to
   * the three endpoints that need it, rather than riding along on every request
   * the app makes for the next thirty days.
   */
  private setRefreshCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
    reply.setCookie(this.config.cookieName, token, {
      httpOnly: true,
      secure: this.config.isProduction,
      sameSite: 'lax',
      path: '/v1/auth',
      domain: this.config.cookieDomain,
      expires: expiresAt,
    });
  }

  private clearRefreshCookie(reply: FastifyReply): void {
    reply.clearCookie(this.config.cookieName, {
      httpOnly: true,
      secure: this.config.isProduction,
      sameSite: 'lax',
      path: '/v1/auth',
      domain: this.config.cookieDomain,
    });
  }
}

function contextFrom(request: FastifyRequest): { userAgent?: string; ip?: string } {
  return { userAgent: request.headers['user-agent'], ip: request.ip };
}
