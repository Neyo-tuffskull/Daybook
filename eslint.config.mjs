// Flat config, shared by every workspace package.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/*.generated.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // packages/domain is the shared business logic and must stay portable:
    // no framework, no Node built-ins, no browser globals. The boundary is the
    // reason one implementation of the scoring rules can serve server and client.
    files: ['packages/domain/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@nestjs/*', 'next', 'next/*', 'react', 'react/*', '@prisma/*'],
              message: 'packages/domain must not depend on any framework.' },
            { group: ['node:*', 'fs', 'path', 'crypto'],
              message: 'packages/domain must run in a browser as well as on the server.' },
          ],
        },
      ],
    },
  },
);
