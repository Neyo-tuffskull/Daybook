import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

/**
 * The fast suite: no database, no network, nothing to set up.
 *
 * Integration tests are excluded here rather than merely living elsewhere,
 * because vitest's default glob would otherwise pick them up and run them with
 * no environment, producing a wall of connection errors that people learn to
 * ignore. `pnpm test:integration` runs those, deliberately.
 *
 * The SWC plugin is here for the same reason as in the integration config:
 * esbuild, which vitest uses by default, does not implement
 * `emitDecoratorMetadata`, and Nest cannot inject anything without it.
 */
export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['**/*.integration.test.ts', '**/node_modules/**', 'dist/**'],
  },
});
