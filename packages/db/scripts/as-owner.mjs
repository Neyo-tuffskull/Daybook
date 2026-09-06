#!/usr/bin/env node
/**
 * Runs one Prisma CLI command as the database owner.
 *
 *   node scripts/as-owner.mjs db execute --schema prisma/schema.prisma --file X
 *   node scripts/as-owner.mjs --target=test db execute --file X
 *
 * Why this exists at all is explained in scripts/owner-url.mjs.
 */
import { describe, resolveOwnerUrl, takeTarget } from './owner-url.mjs';
import { runPrisma } from './run-prisma.mjs';

try {
  const { target, rest } = takeTarget(process.argv.slice(2));

  if (rest.length === 0) {
    console.error('Usage: node scripts/as-owner.mjs [--target=dev|test] <prisma arguments...>');
    process.exit(1);
  }

  const { url } = resolveOwnerUrl(target);
  console.log(`-> ${describe(url)}`);
  process.exit(await runPrisma(rest, url));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
