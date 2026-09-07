import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

/**
 * A separate config from the unit tests, because these need a real database and
 * take real time. `pnpm test` stays fast and needs nothing; `pnpm
 * test:integration` is the one that proves the system works.
 *
 * The SWC plugin is not optional and not a preference. Vitest transforms
 * TypeScript with esbuild, and esbuild does not implement
 * `emitDecoratorMetadata`. Nest reads the `design:paramtypes` metadata that
 * setting emits to work out what a constructor wants, so without it every
 * injected dependency arrives as undefined and the first property access on one
 * throws. It fails at the first line of the first request rather than at boot,
 * which is why it looks like an application bug rather than a build one.
 */
/**
 * A ceiling, not a budget.
 *
 * These were 30 seconds, calibrated against a database that answered in about
 * 150 milliseconds. The same database now takes 2 to 4 seconds a round trip, so
 * a registration doing ten of them lands at 26 to 39 seconds and the timeout
 * became the thing that failed the test. Fifteen of sixteen failures in the run
 * on 2026-09-06 were this and not a defect.
 *
 * Raising it does not make anything faster and is not meant to. It restores the
 * property that a red test means broken code: a slow environment should produce
 * a slow suite, which is annoying, rather than a failing one, which is a lie.
 * Override with INTEGRATION_TEST_TIMEOUT_MS when the environment is worse still.
 *
 * If this number is ever load-bearing, the database is the thing to fix. Run
 * `pnpm --filter @daybook/db db:latency` to find out where the time goes.
 */
const testTimeout = Number(process.env.INTEGRATION_TEST_TIMEOUT_MS ?? 90_000);

export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        // Mirrors experimentalDecorators and emitDecoratorMetadata in
        // apps/api/tsconfig.json. If those change, these change with them.
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    include: ['test/**/*.integration.test.ts'],
    setupFiles: ['./test/setup-env.ts'],
    testTimeout,
    // The hooks register users and clean up after whole files, so they do
    // several times the work of the slowest test.
    hookTimeout: testTimeout * 2,
    // One file at a time. The tests share a database and several of them count
    // rows; running them in parallel would make failures depend on scheduling.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
