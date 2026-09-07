import {
  Controller,
  Get,
  Inject,
  Logger,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.ts';
import { CONFIG } from '../config.provider.ts';
import { AuthService } from './auth.service.ts';
import { Public } from './auth.decorators.ts';
import { OidcClient, OidcError, type OidcIdentity } from './oidc.ts';
import { TokenService } from './token.service.ts';

/** How long someone has to finish signing in at Google before the flow expires. */
const FLOW_TTL_SECONDS = 600;

/** Carries the state, nonce and PKCE verifier between the two requests. */
const FLOW_COOKIE = 'db_oidc';

/**
 * Google sign-in.
 *
 * Two routes, both public, because by definition nobody is authenticated yet.
 *
 * The callback does not return a token. It sets the refresh cookie and
 * redirects into the app, which then calls `/v1/auth/refresh` like any other
 * page load. Putting an access token in the redirect URL would be simpler and
 * would also write a credential into the browser history, into the referrer of
 * whatever the page loads next, and into any proxy log along the way. Cookies
 * exist precisely so credentials do not travel in URLs.
 *
 * Both routes take full control of the reply rather than returning a value,
 * because both of them answer with a redirect and no body.
 */
@Controller('auth/google')
export class GoogleController {
  private readonly log = new Logger(GoogleController.name);
  private readonly client: OidcClient | null;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly tokens: TokenService,
    private readonly auth: AuthService,
  ) {
    this.client = config.google ? new OidcClient(config.google) : null;
  }

  /**
   * Starts the flow: mint state, nonce and a PKCE verifier, remember them in a
   * signed cookie, and send the person to Google.
   */
  @Public()
  @Get()
  async start(
    @Query('client') client: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const oidc = this.require();
    const { url, state, nonce, codeVerifier } = oidc.begin();
    const app = client === 'fitness' ? 'fitness' : 'daybook';

    const flowToken = await this.tokens.signFlowToken(
      { state, nonce, codeVerifier, client: app },
      FLOW_TTL_SECONDS,
    );

    reply.setCookie(FLOW_COOKIE, flowToken, {
      httpOnly: true,
      secure: this.config.isProduction,
      // Strict would drop this cookie on the way back from Google, because the
      // callback arrives as a cross-site navigation. Lax is what makes the
      // round trip work at all, and the flow token is signed and expires in ten
      // minutes.
      sameSite: 'lax',
      path: '/v1/auth/google',
      domain: this.config.cookieDomain,
      maxAge: FLOW_TTL_SECONDS,
    });
    await reply.redirect(url, 302);
  }

  /**
   * Completes the flow.
   *
   * Every failure ends in a redirect to the sign-in page carrying a short code,
   * never a message and never the provider's own error text: this URL is about
   * to be in somebody's history, and the detail belongs in the logs.
   */
  @Public()
  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') providerError: string | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const oidc = this.require();
    const flowToken = request.cookies[FLOW_COOKIE];
    this.clearFlowCookie(reply);

    if (providerError) {
      // Usually somebody pressed cancel. Not an error worth logging as one.
      this.log.log({ providerError }, 'google sign-in did not complete at the provider');
      return this.fail(reply, 'cancelled');
    }

    if (!code || !state || !flowToken) {
      return this.fail(reply, 'expired');
    }

    const flow = await this.tokens.verifyFlowToken(flowToken);
    if (!flow) {
      return this.fail(reply, 'expired');
    }

    // The state check ties this callback to a flow this server started. Without
    // it, somebody can complete their own sign-in inside another person's
    // browser and leave them logged in to the attacker's account, where
    // everything they then write belongs to the attacker.
    if (typeof flow.state !== 'string' || flow.state !== state) {
      this.log.warn('google callback carried a state that did not match the flow');
      return this.fail(reply, 'invalid_state');
    }

    if (typeof flow.nonce !== 'string' || typeof flow.codeVerifier !== 'string') {
      return this.fail(reply, 'expired');
    }

    let identity: OidcIdentity;
    try {
      identity = await oidc.complete(code, flow.codeVerifier, flow.nonce);
    } catch (error) {
      if (error instanceof OidcError) {
        this.log.warn({ err: error }, 'google sign-in failed');
        return this.fail(reply, 'provider_error');
      }
      throw error;
    }

    const result = await this.auth.signInWithIdentity({
      provider: 'google',
      subject: identity.subject,
      email: identity.email,
      emailVerified: identity.emailVerified,
      displayName: identity.name,
      client: flow.client === 'fitness' ? 'fitness' : 'daybook',
      context: { userAgent: request.headers['user-agent'], ip: request.ip },
    });

    if ('refused' in result) {
      return this.fail(reply, result.refused);
    }

    reply.setCookie(this.config.cookieName, result.session.refreshToken, {
      httpOnly: true,
      secure: this.config.isProduction,
      sameSite: 'lax',
      path: '/v1/auth',
      domain: this.config.cookieDomain,
      expires: result.session.expiresAt,
    });
    await reply.redirect(`${this.config.appPublicUrl}/auth/callback`, 302);
  }

  private require(): OidcClient {
    if (!this.client) {
      // 503 rather than 404: the route exists, this deployment has not been
      // given credentials to serve it, and saying so is more useful to whoever
      // is configuring it than pretending the feature was never built.
      throw new ServiceUnavailableException('Google sign-in is not configured on this server.');
    }
    return this.client;
  }

  private async fail(reply: FastifyReply, reason: string): Promise<void> {
    await reply.redirect(`${this.config.appPublicUrl}/sign-in?error=${reason}`, 302);
  }

  private clearFlowCookie(reply: FastifyReply): void {
    reply.clearCookie(FLOW_COOKIE, {
      httpOnly: true,
      secure: this.config.isProduction,
      sameSite: 'lax',
      path: '/v1/auth/google',
      domain: this.config.cookieDomain,
    });
  }
}
