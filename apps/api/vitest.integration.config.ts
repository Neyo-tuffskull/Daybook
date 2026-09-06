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
    // Argon2 and a managed database in another country: generous, but a
    // timeout here should mean something is wrong, not that the network sighed.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // One file at a time. The tests share a database and several of them count
    // rows; running them in parallel would make failures depend on scheduling.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
