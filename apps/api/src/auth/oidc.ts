import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

/**
 * An OpenID Connect client, written out rather than imported.
 *
 * The flow is Authorization Code with PKCE. The API is the OAuth client, not
 * the frontend, because the client secret cannot live in a browser and a
 * browser cannot keep one. That also means the code exchange happens
 * server-to-server, so the authorization code never has to survive a round
 * trip through the user's address bar as anything but a one-time value.
 *
 * Three things do the security work here, and all three are easy to leave out:
 *
 *   state          proves the callback belongs to a flow this server started,
 *                  which is what stops an attacker completing a sign-in in
 *                  somebody else's browser
 *   PKCE verifier  proves the party redeeming the code is the party that asked
 *                  for it, so a stolen code is worth nothing
 *   nonce          binds the returned ID token to this particular request, so
 *                  a token captured from another flow cannot be replayed here
 *
 * The ID token is verified against the provider's published keys. Reading the
 * claims out of the response body without checking the signature is the single
 * most common way this is got wrong, and it accepts anything anybody sends.
 */

export interface OidcConfig {
  /** The issuer, exactly as it appears in the `iss` claim. */
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface OidcIdentity {
  /** The provider's own id for this account. Stable; the email is not. */
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

export interface AuthorizationRequest {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export class OidcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OidcError';
  }
}

export class OidcClient {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly config: OidcConfig) {
    // Cached and refreshed by jose, so a key rotation at the provider does not
    // need a redeploy here.
    this.jwks = createRemoteJWKSet(new URL(config.jwksUri));
  }

  /**
   * Builds the URL to send the person to, and the three secrets that have to
   * come back to this server for the callback to be believed.
   */
  begin(): AuthorizationRequest {
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

    const url = new URL(this.config.authorizationEndpoint);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return { url: url.toString(), state, nonce, codeVerifier };
  }

  /**
   * Redeems the code and returns the verified identity.
   *
   * Every failure raises rather than returning a partial result: there is no
   * useful halfway state between "this is who they are" and "we could not
   * establish who they are", and code that treats one as the other is how
   * unverified claims end up in a session.
   */
  async complete(code: string, codeVerifier: string, nonce: string): Promise<OidcIdentity> {
    const idToken = await this.exchangeCode(code, codeVerifier);
    return this.verifyIdToken(idToken, nonce);
  }

  private async exchangeCode(code: string, codeVerifier: string): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code_verifier: codeVerifier,
    });

    let response: Response;
    try {
      response = await fetch(this.config.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new OidcError(
        `Could not reach the identity provider: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      // The provider's error body can contain the code and the client id, so
      // it is not repeated. The status is enough to tell a misconfiguration
      // from an expired code, and the rest is in the provider's own logs.
      throw new OidcError(`The identity provider refused the code exchange (${response.status}).`);
    }

    const payload: unknown = await response.json();
    const idToken = (payload as { id_token?: unknown }).id_token;
    if (typeof idToken !== 'string') {
      throw new OidcError('The identity provider returned no ID token.');
    }
    return idToken;
  }

  private async verifyIdToken(idToken: string, nonce: string): Promise<OidcIdentity> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(idToken, this.jwks, {
        issuer: this.config.issuer,
        audience: this.config.clientId,
        // Providers and servers disagree about the time by a second or two far
        // more often than tokens are actually replayed.
        clockTolerance: 30,
      }));
    } catch (error) {
      throw new OidcError(
        `The ID token did not verify: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (payload.nonce !== nonce) {
      throw new OidcError('The ID token belongs to a different sign-in attempt.');
    }

    const subject = payload.sub;
    if (typeof subject !== 'string' || subject.length === 0) {
      throw new OidcError('The ID token carries no subject.');
    }

    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : null;

    /**
     * `email_verified` decides whether this identity may be attached to an
     * existing account, so it is read strictly. Google sends a boolean; some
     * providers send the string "true", and treating any truthy value as
     * verified would accept the string "false".
     */
    const emailVerified = payload.email_verified === true || payload.email_verified === 'true';

    return {
      subject,
      email,
      emailVerified,
      name: typeof payload.name === 'string' ? payload.name : null,
    };
  }
}

/**
 * Google's endpoints.
 *
 * Written out rather than fetched from the discovery document at boot. The
 * discovery document is one more thing that can be unreachable when the
 * process starts, these four URLs have not changed in years, and the JWKS URI
 * is the only one that would matter if it did, which jose already refetches.
 * The issuer is checked against the token, so a wrong value here fails closed.
 */
export const GOOGLE_ENDPOINTS = {
  issuer: 'https://accounts.google.com',
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
} as const;
