import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair, type KeyLike } from 'jose';

/**
 * A real OpenID Connect issuer, small enough to run inside a test.
 *
 * The alternative is to mock the OIDC client and assert that the controller
 * called it. That proves the controller calls a function. It says nothing about
 * whether we verify a signature, check the issuer, check the audience, check
 * the nonce, or accept a token signed by anybody at all, which is the entire
 * set of things worth getting right here.
 *
 * So this serves a JWKS, exchanges codes for ID tokens it signs with its own
 * key, and lets a test deliberately sign one wrongly. The production code runs
 * unmodified against it, including `createRemoteJWKSet` fetching the keys over
 * HTTP.
 */
export interface IssuedAccount {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name?: string | null;
}

export interface FakeIssuer {
  baseUrl: string;
  /**
   * Queues an account for the next code exchange and returns the code, as if
   * the person had just finished signing in at the provider.
   */
  issueCode(account: IssuedAccount, nonce: string, options?: { forged?: boolean }): string;
  /** Every request the client made, so a test can assert on the exchange. */
  readonly tokenRequests: Record<string, string>[];
  close(): Promise<void>;
}

export async function startFakeIssuer(clientId: string): Promise<FakeIssuer> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const foreign = await generateKeyPair('RS256');
  const kid = 'fake-issuer-key';

  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  const pending = new Map<string, { account: IssuedAccount; nonce: string; forged: boolean }>();
  const tokenRequests: Record<string, string>[] = [];

  // Assigned once the server is listening and the port is known, because the
  // issuer has to put its own URL in the `iss` claim.
  let baseUrl = '';

  const sign = (key: KeyLike, account: IssuedAccount, nonce: string): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = { nonce };
    if (account.email !== null) {
      claims.email = account.email;
      claims.email_verified = account.emailVerified;
    }
    if (account.name) claims.name = account.name;

    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid })
      .setSubject(account.subject)
      .setIssuer(baseUrl)
      .setAudience(clientId)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(key);
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', baseUrl || 'http://localhost');

    if (url.pathname === '/jwks') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        const form = Object.fromEntries(new URLSearchParams(body));
        tokenRequests.push(form);

        const queued = pending.get(form.code ?? '');
        if (!queued) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        pending.delete(form.code ?? '');

        // A forged code is answered with a token signed by a key this issuer
        // does not publish, which is the closest thing to an attacker handing
        // us a plausible-looking ID token.
        const key = queued.forged ? foreign.privateKey : privateKey;
        void sign(key, queued.account, queued.nonce).then((idToken) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id_token: idToken, token_type: 'Bearer', expires_in: 3600 }));
        });
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the fake issuer did not bind a port');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    issueCode(account, nonce, options) {
      const code = randomUUID();
      pending.set(code, { account, nonce, forged: options?.forged === true });
      return code;
    },
    tokenRequests,
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
