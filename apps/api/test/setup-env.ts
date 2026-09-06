/**
 * Runs before any test file is imported, and therefore before `@daybook/db`
 * constructs its Prisma clients from the environment.
 *
 * Two jobs. It points the process at the test database, and it refuses to run
 * at all if that would be the development database: these tests create users,
 * change passwords and revoke sessions, and a suite that can do that to the
 * database you are developing against will eventually do it on the wrong
 * afternoon.
 *
 * It also mints a throwaway Ed25519 keypair per run, so nobody has to put a
 * signing key in CI, and so a test can never accidentally pass because it was
 * verifying tokens with a production key.
 */
import { generateKeyPairSync } from 'node:crypto';

const testUrl = process.env.TEST_DATABASE_URL;
const testAuthUrl = process.env.TEST_DATABASE_AUTH_URL;

if (!testUrl || !testAuthUrl) {
  throw new Error(
    'Integration tests need TEST_DATABASE_URL and TEST_DATABASE_AUTH_URL in .env.\n' +
      'They must point at a database that exists only for tests. See docs/SETUP.md §7.',
  );
}

if (testUrl === process.env.DATABASE_URL) {
  throw new Error(
    'TEST_DATABASE_URL is the same as DATABASE_URL. These tests delete users; point them elsewhere.',
  );
}

if (!/test/i.test(testUrl)) {
  throw new Error(
    `Refusing to run: TEST_DATABASE_URL does not have "test" in it (${redact(testUrl)}).\n` +
      'The name is the last line of defence against running this against real data.',
  );
}

process.env.DATABASE_URL = withGenerousTimeouts(testUrl);
process.env.DATABASE_AUTH_URL = withGenerousTimeouts(testAuthUrl);
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'fatal';
process.env.CORS_ALLOWED_ORIGINS ??= 'http://localhost:3000';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
process.env.AUTH_JWT_PRIVATE_KEY_B64 = Buffer.from(
  privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
).toString('base64');
process.env.AUTH_JWT_PUBLIC_KEY_B64 = Buffer.from(
  publicKey.export({ type: 'spki', format: 'pem' }).toString(),
).toString('base64');
process.env.AUTH_JWT_KEY_ID = 'test-ed25519';

// The lowest Argon2 settings the configuration schema will accept. Real
// parameters would add roughly a second to every sign-in in the suite, and
// these tests are about the protocol around the hash, not the hash itself.
process.env.AUTH_ARGON2_MEMORY_KIB = '19456';
process.env.AUTH_ARGON2_TIME_COST = '2';
process.env.AUTH_ARGON2_PARALLELISM = '1';

// High enough that the suite's own traffic never trips it. One test lowers it
// deliberately to prove the limit works.
process.env.AUTH_RATE_LIMIT_PER_MINUTE = '1000';

/**
 * Waits for the database to be awake before the first test runs.
 *
 * A serverless Postgres suspends its compute when nobody is using it, and the
 * first connection after that has to wait for it to resume. Prisma's default
 * pool timeout is ten seconds, which is shorter than a cold start, so the
 * suite's very first query failed with a pool timeout and every test was
 * skipped: an outage-shaped failure with no bug behind it.
 *
 * Rather than raise the timeout and hope, this connects, retries with backoff,
 * and says what it is waiting for. Once the compute is up the rest of the suite
 * runs at normal speed.
 */
await warmUpDatabase();

async function warmUpDatabase(): Promise<void> {
  // Imported here, not at the top: the clients are built from the environment
  // at module load, and the environment is only correct a few lines above.
  const { db } = await import('@daybook/db');

  const started = Date.now();
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      await db.$queryRaw`SELECT 1`;
      if (attempt > 1) {
        // stderr, like the message it answers: this is progress chatter about
        // an abnormal condition, not test output.
        console.warn(`Database awake after ${Math.round((Date.now() - started) / 1000)}s.`);
      }
      return;
    } catch (error) {
      if (attempt === 6) {
        throw new Error(
          `Could not reach the test database after ${attempt} attempts over ` +
            `${Math.round((Date.now() - started) / 1000)}s.\n` +
            `Last error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (attempt === 1) {
        console.warn('Waiting for the test database to wake up...');
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
}

/**
 * A cold start can outlast Prisma's ten-second default, and a database in
 * another country makes every query slower than a local one. These are query
 * string parameters rather than a documented `.env` change so that nobody has
 * to remember them, and so they apply only to the test connections.
 */
function withGenerousTimeouts(url: string): string {
  const parsed = new URL(url);
  if (!parsed.searchParams.has('connect_timeout')) {
    parsed.searchParams.set('connect_timeout', '30');
  }
  if (!parsed.searchParams.has('pool_timeout')) {
    parsed.searchParams.set('pool_timeout', '30');
  }
  return parsed.toString();
}

function redact(url: string): string {
  return url.replace(/\/\/[^@]*@/, '//***@');
}
