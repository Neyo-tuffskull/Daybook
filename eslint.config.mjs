// Flat config, shared by every workspace package. Each package's `lint` script
// runs eslint from its own directory; ESLint walks up to find this file.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import nextPlugin from '@next/eslint-plugin-next';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/generated/**',
      '**/*.generated.ts',
    ],
  },

  js.configs.recommended,

  // Type-aware rules are scoped to TypeScript. Applying them to config files
  // written in plain JavaScript asks the parser for type information that no
  // tsconfig provides, which fails before it can find a real problem.
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ['**/*.ts', '**/*.tsx'],
  })),

  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: {
          // Config files sit outside every tsconfig include. This lets the
          // parser fall back to a default project for them.
          allowDefaultProject: ['*.ts', '*.mjs', '*.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A dropped promise in the sync pipeline is a workout that never reaches
      // the Daybook, with nothing logged. This one earns its keep.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // Config files: plain JavaScript, no type information, module scope.
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },

  {
    // packages/domain is the shared business logic and must stay portable: no
    // framework, no Node built-ins, no browser globals. The boundary is the
    // reason one implementation of the scoring rules can serve both the server
    // and an offline client without the two drifting apart.
    files: ['packages/domain/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@nestjs/*', 'next', 'next/*', 'react', 'react/*', '@prisma/*'],
              message: 'packages/domain must not depend on any framework.',
            },
            {
              group: ['node:*', 'fs', 'path', 'crypto'],
              message: 'packages/domain must run in a browser as well as on the server.',
            },
          ],
        },
      ],
    },
  },

  // The domain tests are the one place in that package allowed to touch Node,
  // because that is what runs them.
  {
    files: ['packages/domain/test/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },

  {
    // node:test's describe() and it() return promises that the runner owns and
    // you are not meant to await. Left on, the rule flags every single test in
    // the file, which trains people to ignore it. It stays on everywhere else,
    // where a dropped promise is a real bug.
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx'],
    rules: { '@typescript-eslint/no-floating-promises': 'off' },
  },

  {
    files: ['apps/daybook/**/*.{ts,tsx}', 'apps/fitness/**/*.{ts,tsx}'],
    plugins: { '@next/next': nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
    },
  },
);
