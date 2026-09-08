#!/usr/bin/env node
/**
 * Applies pending migrations, in order, as the database owner.
 *
 *   node scripts/migrate.mjs                      apply what is pending
 *   node scripts/migrate.mjs --target=test        the same, on the test database
 *   node scripts/migrate.mjs --status             what is applied and what is not
 *   node scripts/migrate.mjs --baseline=<name>    adopt a database that predates this
 *
 * The first version of this script re-ran every file every time, on the claim
 * that they were all idempotent by construction. That claim was false:
 * `0001_init` is several hundred lines of plain `CREATE TABLE`, and re-running
 * it stops at the first one that already exists. Rather than rewrite the schema
 * into `IF NOT EXISTS` everywhere, which weakens it (a `CREATE TABLE IF NOT
 * EXISTS` silently accepts a table with the wrong columns) and cannot express
 * `CREATE POLICY` at all, the runner now records what it has applied.
 *
 * The ledger is `schema_migrations`: a name, a checksum, and when it ran. The
 * checksum is what makes it more than a to-do list. Editing a migration that
 * has already been applied means the database no longer matches the repository,
 * and every later reader of that file is being lied to about what is in the
 * database. That fails here rather than being discovered months later.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, resolveOwnerUrl, takeTarget } from './owner-url.mjs';
import { waitForDatabase } from './database-ready.mjs';
import { runPrisma } from './run-prisma.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsRoot = join(here, '..', 'migrations');

/**
 * The generated client does not exist on a fresh checkout, and the error Node
 * gives for a missing module says nothing about what to do next.
 */
async function loadPrismaClient() {
  try {
    const module = await import('../generated/client/index.js');
    return module.PrismaClient;
  } catch {
    throw new Error(
      'The Prisma client has not been generated yet. Run:\n\n' +
        '  pnpm --filter @daybook/db build\n\n' +
        'It reads only the schema file, so it needs no running database.',
    );
  }
}

const LEDGER = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name       text PRIMARY KEY,
    checksum   text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;

// The application roles have no business reading, let alone writing, the record
// of what has been applied. Wrapped because on a brand new database this runs
// before the bootstrap that creates those roles.
const SEAL_LEDGER = `
  DO $$
  BEGIN
    REVOKE ALL ON schema_migrations FROM daybook_app, daybook_auth;
  EXCEPTION WHEN undefined_object THEN
    NULL;
  END $$`;

function discover() {
  return readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .flatMap((name) => {
      // The bootstrap is named differently because it is not a schema change:
      // it creates roles and extensions, which exist before any table does.
      const path = ['migration.sql', 'bootstrap.sql']
        .map((file) => join(migrationsRoot, name, file))
        .find(existsSync);
      return path ? [{ name, path, checksum: checksumOf(path) }] : [];
    });
}

/**
 * Line endings are normalised before hashing. A checkout with `core.autocrlf`
 * on, and one without, hold the same migration; a checksum that disagreed about
 * that would fail on Windows for a reason that has nothing to do with the
 * schema.
 */
function checksumOf(path) {
  const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

async function main() {
  const argv = process.argv.slice(2);
  const { target, rest } = takeTarget(argv);
  const statusOnly = rest.includes('--status');
  const baselineArg = rest.find((arg) => arg.startsWith('--baseline='));
  const baselineTo = baselineArg ? baselineArg.slice('--baseline='.length) : null;

  const { url } = resolveOwnerUrl(target);
  console.log(`-> ${describe(url)}\n`);

  const migrations = discover();
  if (migrations.length === 0) {
    throw new Error(`No migrations found under ${migrationsRoot}`);
  }

  // Before the ledger, before anything: a suspended compute answers the first
  // query with a pool timeout, which reads as an outage rather than as a nap.
  await waitForDatabase(url);

  const PrismaClient = await loadPrismaClient();
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    await prisma.$executeRawUnsafe(LEDGER);
    await prisma.$executeRawUnsafe(SEAL_LEDGER);

    const applied = new Map(
      (await prisma.$queryRaw`SELECT name, checksum FROM schema_migrations`).map((row) => [
        row.name,
        row.checksum,
      ]),
    );

    // A migration that has been applied and then edited means the database and
    // the repository disagree, and the file no longer describes what is really
    // there. Changing it further compounds that; the fix is a new migration.
    const altered = migrations.filter(
      (migration) =>
        applied.has(migration.name) && applied.get(migration.name) !== migration.checksum,
    );
    if (altered.length > 0 && !baselineTo) {
      throw new Error(
        [
          'These migrations have changed since they were applied:',
          ...altered.map((migration) => `  ${migration.name}`),
          '',
          'The database no longer matches the repository. Add a new migration',
          'that makes the change, rather than editing one that has already run.',
        ].join('\n'),
      );
    }

    if (statusOnly) {
      for (const migration of migrations) {
        const state = applied.has(migration.name) ? 'applied' : 'pending';
        console.log(`  ${state.padEnd(8)} ${migration.name}`);
      }
      return 0;
    }

    if (baselineTo) {
      const index = migrations.findIndex((migration) => migration.name === baselineTo);
      if (index === -1) {
        throw new Error(
          [
            `No migration named ${baselineTo}. Available:`,
            ...migrations.map((m) => `  ${m.name}`),
          ].join('\n'),
        );
      }
      for (const migration of migrations.slice(0, index + 1)) {
        await record(prisma, migration);
        console.log(`  recorded ${migration.name} (not run)`);
      }
      console.log(
        `\nAdopted an existing database up to ${baselineTo}. Run again with no\n` +
          'arguments to apply anything after it.',
      );
      return 0;
    }

    const pending = migrations.filter((migration) => !applied.has(migration.name));

    // An empty ledger against a database that already has tables means someone
    // built it before this runner existed. Applying 0001 would fail on the
    // first CREATE TABLE, and guessing which migrations are already in there
    // would be worse: it would be silently wrong when the guess is off.
    if (applied.size === 0 && pending.length === migrations.length) {
      // A boolean, not to_regclass(): that returns type `regclass`, which the
      // Prisma client cannot deserialize, and the error it raises names a
      // problem with your schema rather than with this query.
      const rows = await prisma.$queryRaw`
        SELECT EXISTS (
          SELECT 1 FROM pg_class
           WHERE relname = 'users' AND relnamespace = 'public'::regnamespace
        ) AS present`;
      if (rows[0]?.present === true) {
        throw new Error(
          [
            'This database already has tables, but no record of which migrations',
            'built them. It predates this runner.',
            '',
            'Tell it where the database currently stands, then run it again:',
            '',
            `  pnpm --filter @daybook/db db:migrate --baseline=<name>`,
            '',
            'Available:',
            ...migrations.map((migration) => `  ${migration.name}`),
          ].join('\n'),
        );
      }
    }

    if (pending.length === 0) {
      console.log('Nothing to apply. Everything is up to date.');
      return 0;
    }

    for (const migration of pending) {
      console.log(`-- ${migration.name}`);
      const code = await runPrisma(
        ['db', 'execute', '--schema', 'prisma/schema.prisma', '--file', migration.path],
        url,
      );
      if (code !== 0) {
        console.error(`\n${migration.name} failed. Nothing after it was applied.`);
        return code;
      }
      await record(prisma, migration);
    }

    console.log(`\nApplied ${pending.length} migration${pending.length === 1 ? '' : 's'}.`);
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

function record(prisma, migration) {
  return prisma.$executeRaw`
    INSERT INTO schema_migrations (name, checksum)
    VALUES (${migration.name}, ${migration.checksum})
    ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()`;
}

try {
  process.exit(await main());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
