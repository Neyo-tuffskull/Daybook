import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Finds the Prisma CLI's JavaScript entry point so it can be run directly.
 *
 * The obvious way to run a CLI from a script is to spawn its name with
 * `shell: true`, because on Windows `prisma` is a `.cmd` shim that cannot be
 * executed any other way. Node 24 deprecated that combination, and it deserved
 * to be: with a shell in the middle the arguments are concatenated into a
 * command line rather than passed as a vector, so anything containing a quote
 * or an ampersand changes the meaning of the command.
 *
 * Running `node <cli>.js` instead skips the shim and the shell entirely, and
 * behaves identically on all three platforms. If the file cannot be found, the
 * caller falls back rather than failing: a noisy deprecation warning is a much
 * smaller problem than a migration tool that will not start.
 */
function findPrismaCli() {
  const candidates = [
    join(here, '..', 'node_modules', 'prisma', 'build', 'index.js'),
    join(here, '..', '..', '..', 'node_modules', 'prisma', 'build', 'index.js'),
    join(here, '..', 'node_modules', '.pnpm', 'node_modules', 'prisma', 'build', 'index.js'),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

/**
 * Runs the Prisma CLI with the owner connection string substituted in, for the
 * duration of this one process. `.env` is never touched.
 */
export function runPrisma(args, ownerUrl) {
  const cli = findPrismaCli();
  const [command, commandArgs] = cli ? [process.execPath, [cli, ...args]] : ['prisma', args];

  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      stdio: 'inherit',
      shell: cli === null && process.platform === 'win32',
      env: { ...process.env, DATABASE_URL: ownerUrl },
    });
    child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
    child.on('error', (error) => {
      console.error(`Could not run prisma: ${error.message}`);
      resolve(1);
    });
  });
}
