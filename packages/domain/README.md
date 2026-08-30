# @daybook/domain

Business logic with no framework attached: recurrence, scoring, streaks,
planned-versus-actual. No imports from Nest, Next, React, Prisma or Node
built-ins, enforced by a lint rule in the root `eslint.config.mjs`.

That boundary is what lets one implementation of the scoring rules run on the
server and in an offline browser without drifting apart.

## Tests

    node --test 'test/*.test.ts'

Node's own test runner, not Vitest. Type stripping is built in and on by default from Node 22.18, so there is no flag and no build step. These are pure functions over plain data,
so they need no DOM, no mocking and no dependencies, which means they run on a
clean checkout before `pnpm install` has finished. Vitest is still used in the
packages that need a DOM.
