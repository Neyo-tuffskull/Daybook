# Setup and Development

**Phase 2 status: partially verified.** Read §5 before trusting anything here.

---

## 1. Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node | 22.6 or later | The domain tests use the built-in test runner and native TypeScript stripping |
| pnpm | 9.x | Workspaces. `corepack enable` will install it |
| PostgreSQL | 16 | Generated columns, row-level security, partial indexes |
| Docker | any recent | Optional, for the local database |

## 2. First run

```bash
git clone <your repo> daybook && cd daybook
cp .env.example .env.local        # fill in the blanks, see §3
pnpm install

docker compose up -d postgres     # or point at your own PostgreSQL 16

# Extensions and the two application roles. Once per database.
psql -v ON_ERROR_STOP=1 -d daybook_dev -f packages/db/migrations/0000_bootstrap/bootstrap.sql

# Schema.
psql -v ON_ERROR_STOP=1 -d daybook_dev -f packages/db/migrations/0001_init/migration.sql

# Prove it landed correctly. 15 assertions, all should print "ok".
psql -v ON_ERROR_STOP=1 -d daybook_dev -f packages/db/tests/schema_smoke.sql

# Generate the Prisma models from the live schema, then the client.
pnpm --filter @daybook/db db:pull
pnpm --filter @daybook/db build

pnpm dev
```

That last command starts four processes: the Daybook app on 3000, the Fitness app on 3001, the API on 4000 and the worker.

## 3. Environment

Every variable is documented in `.env.example`. Three need generating rather than inventing.

**Signing keys for access tokens.** Ed25519, not RSA: shorter keys, faster verification, and no key-size decision to get wrong.

```bash
openssl genpkey -algorithm ed25519 -out private.pem
openssl pkey -in private.pem -pubout -out public.pem
echo "AUTH_JWT_PRIVATE_KEY_B64=$(base64 -w0 private.pem)"
echo "AUTH_JWT_PUBLIC_KEY_B64=$(base64 -w0 public.pem)"
rm private.pem public.pem
```

**Database passwords.** Three connection strings, three roles, on purpose:

- `DATABASE_URL` connects as `daybook_app`. It owns nothing, so row-level security applies to it, and it has no access at all to the credential tables.
- `DATABASE_AUTH_URL` connects as `daybook_auth`. It can reach `users`, `auth_identities` and the token tables, because a login has to find an account before anyone is authenticated.
- `DATABASE_MIGRATION_URL` connects as the owner. Used by migrations only, never by a running service.

A single superuser URL for everything would work and would throw away the protection. Set real passwords with `ALTER ROLE daybook_app WITH PASSWORD '...'`.

**VAPID keys** for web push are only needed from Phase 11.

## 4. Everyday commands

| Command | What it does |
|---|---|
| `pnpm dev` | All four services, watching |
| `pnpm test` | Unit tests across the workspace |
| `pnpm test:e2e` | Playwright, desktop and mobile viewports |
| `pnpm lint` | ESLint, including the rule that keeps `packages/domain` framework-free |
| `pnpm typecheck` | TypeScript, strict, no emit |
| `pnpm format` | Prettier |
| `pnpm db:smoke` | The 15 schema assertions |
| `pnpm --filter @daybook/domain test` | Domain tests alone. Needs no install |

That last one is worth knowing: the domain package has no dependencies, so its tests run on a fresh checkout before `pnpm install` finishes.

## 5. What has actually been verified

The brief's rule 7 says not to claim something works unless it has been tested. Phase 2 was built in an environment with no access to the npm registry, so the install path could not be exercised. Here is the honest split.

### Verified by running it

| Check | Result |
|---|---|
| Bootstrap and migration apply to a clean PostgreSQL 16 | 30 tables, 98 indexes, 152 constraints, 33 policies, 15 triggers |
| Migrations re-apply from scratch to a second database | Clean |
| 15 schema assertions | All pass |
| Domain unit tests, 30 cases | All pass |
| Every JSON and YAML config parses | Clean |

Two of the schema assertions found real defects while being written: six foreign keys had no index, and three credential tables had no access control. Both are fixed, and both now have a standing test.

### Not verified, because nothing could be installed

- `pnpm install` and the lockfile it produces
- `pnpm dev`, `pnpm build`, `pnpm lint`, `pnpm typecheck`
- The NestJS API booting
- Either Next.js app rendering
- `prisma db pull` and client generation
- Docker Compose
- The CI workflow
- Playwright

Dependency versions in the manifests are caret ranges chosen from knowledge, not resolved against the registry. The first `pnpm install` is what pins them, and it may well surface a version that needs adjusting.

**Phase 2 stays open until `pnpm install && pnpm dev` runs cleanly on a machine with network access and the exit criterion is met.** Send me whatever breaks.

## 6. Troubleshooting

**`psql: FATAL: role "daybook_app" does not exist`**
The bootstrap script has not run. It is separate from the migration because roles are cluster-wide rather than per-database.

**`permission denied for table auth_sessions`**
Working as intended. `daybook_app` cannot see the credential tables. Auth code must use the `authDb` client from `@daybook/db`.

**A query returns nothing when rows clearly exist**
Row-level security with no identity set. Every user-scoped query goes through `asUser(userId, ...)`, which sets a transaction-local `app.current_user_id`. Setting it at session scope would leak one user's identity into the next request on a pooled connection.

**`ERROR: invalid IANA timezone`**
A trigger, not a typo. Timezones are validated on write because a bad zone silently corrupts every occurrence built from it.
