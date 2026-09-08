/**
 * Which connection string to use, and a way to say so out loud.
 *
 * Prisma reads one variable, `DATABASE_URL`, and in this repository that is
 * `daybook_app`: the role that owns nothing, is subject to row-level security,
 * and cannot see the credential tables. All three are exactly what you want
 * from the role a web process connects as, and all three make it useless for
 * creating a table, granting a privilege or inserting a user.
 *
 * So anything that changes the schema resolves the owner URL through here
 * instead, and refuses to run rather than falling back to the wrong role.
 */

import { withGenerousTimeouts } from './database-ready.mjs';

/** Reads `--target=dev|test` out of an argument list, returning the rest. */
export function takeTarget(args) {
  const index = args.findIndex((arg) => arg.startsWith('--target='));
  if (index === -1) return { target: 'dev', rest: args };
  const target = args[index].slice('--target='.length);
  const rest = args.slice(0, index).concat(args.slice(index + 1));
  if (target !== 'dev' && target !== 'test') {
    throw new Error(`Unknown --target=${target}. Use dev or test.`);
  }
  return { target, rest };
}

export function ownerUrlVariable(target) {
  return target === 'test' ? 'TEST_DATABASE_MIGRATION_URL' : 'DATABASE_MIGRATION_URL';
}

export function resolveOwnerUrl(target) {
  const variable = ownerUrlVariable(target);
  const url = process.env[variable];

  if (!url) {
    throw new Error(
      [
        `${variable} is not set.`,
        '',
        'Migrations and schema tests run as the database owner, not as the',
        'application role. Add the owner connection string to .env:',
        '',
        `  ${variable}=postgresql://<owner>:<password>@<host>/<database>`,
        '',
        'On a managed provider this is the role the provider created the',
        'database with. See docs/SETUP.md section 3.',
      ].join('\n'),
    );
  }

  try {
    new URL(url);
  } catch {
    throw new Error(`${variable} is not a valid connection string.`);
  }

  // Every caller of this function talks to a database that is allowed to be
  // asleep, so the timeouts are raised here rather than in each of them.
  return { url: withGenerousTimeouts(url), variable };
}

/**
 * Role and database, never the password. It stays out of the terminal, out of
 * scrollback, and out of anything anyone later pastes into a chat window.
 */
export function describe(url) {
  const parsed = new URL(url);
  return `${parsed.username} @ ${parsed.pathname.slice(1)}`;
}
