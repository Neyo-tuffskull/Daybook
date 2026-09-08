/**
 * Waiting for a database that is allowed to be asleep.
 *
 * A serverless PostgreSQL suspends its compute when nobody is using it, and the
 * first connection afterwards waits for it to resume. Prisma's defaults are a
 * five second connect timeout and a ten second pool timeout, both of which are
 * shorter than a cold start, so the first command anybody runs after a quiet
 * afternoon fails with `P1001 can't reach database server` or a pool timeout.
 *
 * Neither message says "it is waking up". They read like an outage, and the
 * natural response to them is to go and check the provider's console, which is
 * two days of this project's history.
 *
 * The integration suite has waited properly since defect 24. These scripts did
 * not, so the same fault arrived again through the one door still open. This
 * module is that door closed, and it is shared rather than copied so the next
 * script to need it inherits the fix.
 */

/**
 * Raises the two timeouts that a cold start exceeds.
 *
 * Query string parameters rather than a documented `.env` change, so nobody has
 * to remember them and so they apply only where they are needed. An explicit
 * value already in the URL is left alone.
 */
export function withGenerousTimeouts(url) {
  const parsed = new URL(url);
  if (!parsed.searchParams.has('connect_timeout')) {
    parsed.searchParams.set('connect_timeout', '30');
  }
  if (!parsed.searchParams.has('pool_timeout')) {
    parsed.searchParams.set('pool_timeout', '30');
  }
  return parsed.toString();
}

/**
 * Connects, retrying with backoff, and says out loud what it is waiting for.
 *
 * Returns true once the database answers. Returns false, without throwing, when
 * the generated client is not available: this runs before `prisma generate` on
 * a fresh checkout, and a warm-up that cannot run is not a reason to stop the
 * command that needed it. The command itself will produce a better error.
 */
export async function waitForDatabase(url, { attempts = 6, quiet = false } = {}) {
  let PrismaClient;
  try {
    ({ PrismaClient } = await import('../generated/client/index.js'));
  } catch {
    return false;
  }

  const client = new PrismaClient({ datasources: { db: { url } } });
  const started = Date.now();

  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await client.$queryRaw`SELECT 1`;
        if (attempt > 1 && !quiet) {
          console.log(`   awake after ${Math.round((Date.now() - started) / 1000)}s`);
        }
        return true;
      } catch (error) {
        if (attempt === attempts) {
          throw new Error(
            `Could not reach the database after ${attempts} attempts over ` +
              `${Math.round((Date.now() - started) / 1000)}s.\n` +
              `Last error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (attempt === 1 && !quiet) {
          console.log('   waiting for the database to wake up...');
        }
        await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
      }
    }
    return false;
  } finally {
    await client.$disconnect();
  }
}
