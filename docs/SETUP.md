# Setup and Development

**Phase 2 complete.** Verified end to end on Windows 11 / Node 26 against PostgreSQL 16 in London. §5 has the precise accounting.

---

## 1. Prerequisites

| Tool       | Version        | Why                                                                                                                                          |
| ---------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Node       | 22.18 or later | The domain tests use the built-in test runner and native TypeScript stripping, which is on by default from 22.18                             |
| pnpm       | 9.x            | Workspaces. Install with `npm install -g pnpm@9`. Corepack is not bundled with Node from version 25 onward, so `corepack enable` fails there |
| PostgreSQL | 16             | Generated columns, row-level security, partial indexes                                                                                       |
| Docker     | any recent     | Optional, for the local database                                                                                                             |

## 2. First run

```bash
git clone <your repo> daybook && cd daybook
cp .env.example .env              # fill in the blanks, see §3
npm install -g pnpm@9   # corepack is not bundled with Node 25+
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

## 2b. No local PostgreSQL: use a hosted one

A native PostgreSQL installer is a few hundred megabytes and Docker Desktop is
larger still. On a slow connection neither is worth it, and you do not need
either: a free hosted database costs no download, and it is the same managed
Postgres this project deploys to (decision D6, London).

`psql` is not needed either. The Prisma CLI can execute a SQL file against the
datasource, which is what the `db:` scripts below use.

1. Create a project on a hosted Postgres provider, choosing **PostgreSQL 16**
   and the **London (`aws-eu-west-2`)** region. Region is fixed at creation on
   Neon, so getting it right now saves a migration later.
2. Copy the connection string it gives you. It arrives as the project owner,
   which is the role that runs migrations.
3. Create `.env` in the repository root, from `.env.example`, and set all three
   database URLs to that owner string for now:

       DATABASE_URL=postgresql://owner:...@...neon.tech/daybook?sslmode=require
       DATABASE_AUTH_URL=<the same, for now>
       DATABASE_MIGRATION_URL=<the same>

   `.env`, not `.env.local`: the Prisma CLI reads the former. It lives at the
   repository root, and the `db:` scripts point Prisma at it explicitly with
   `dotenv-cli`, because Prisma resolves `.env` relative to the schema or the
   working directory and does not walk up to a workspace root. Without that,
   a command run inside `packages/db` cannot see a root `.env` at all.

4. Create the extensions and the two application roles, then the schema, then
   the application grants:

       pnpm --filter @daybook/db db:bootstrap
       pnpm --filter @daybook/db db:apply
       pnpm --filter @daybook/db db:grants

   `db:grants` states the application role's privileges outright and is safe to
   re-run, so it is also the repair if a grant is ever lost.

5. Prove the schema landed correctly. Fifteen assertions, each of which raises
   on failure, so a clean exit means every one held:

       pnpm --filter @daybook/db db:smoke

6. Give the two application roles real passwords, then point the URLs at them.
   Run this from your provider's SQL console:

       ALTER ROLE daybook_app  WITH PASSWORD 'a long random string';
       ALTER ROLE daybook_auth WITH PASSWORD 'a different long random string';

   Then update `.env` so `DATABASE_URL` uses `daybook_app` and
   `DATABASE_AUTH_URL` uses `daybook_auth`. This is what makes the isolation in
   §3 real rather than theoretical: keeping the owner string everywhere would
   hand the whole application superuser rights and bypass row-level security
   entirely.

7. Generate the Prisma models from the live schema, then the client:

       pnpm --filter @daybook/db db:pull
       pnpm --filter @daybook/db build

8. `pnpm dev`.

**The trade-off, stated plainly.** Every query in development crosses the
internet to London, so the app will feel slower than against a local database,
and you cannot work on it offline. If that becomes annoying, install PostgreSQL
16 locally later and change one line in `.env`. Nothing else in the project
knows the difference.

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

Windows machines usually have no `openssl`, and Node can do it without writing
a private key to disk at all, which is the better habit anyway:

```powershell
node -e "const c=require('crypto');const{publicKey,privateKey}=c.generateKeyPairSync('ed25519');console.log('AUTH_JWT_PRIVATE_KEY_B64='+Buffer.from(privateKey.export({type:'pkcs8',format:'pem'})).toString('base64'));console.log('AUTH_JWT_PUBLIC_KEY_B64='+Buffer.from(publicKey.export({type:'spki',format:'pem'})).toString('base64'))"
```

`AUTH_JWT_KEY_ID` names the key inside every token it signs. Changing keys
means publishing the new one, switching the signer, and only then retiring the
old one; without an id in the header, every token issued under the old key dies
the instant the new one takes over.

**Database passwords.** Three connection strings, three roles, on purpose:

- `DATABASE_URL` connects as `daybook_app`. It owns nothing, so row-level security applies to it, and it has no access at all to the credential tables.
- `DATABASE_AUTH_URL` connects as `daybook_auth`. It can reach `users`, `auth_identities` and the token tables, because a login has to find an account before anyone is authenticated.
- `DATABASE_MIGRATION_URL` connects as the owner. Migrations, introspection and the schema assertions use it. No running service ever does.

A single superuser URL for everything would work and would throw away the protection. Set real passwords with `ALTER ROLE daybook_app WITH PASSWORD '...'`.

`DATABASE_MIGRATION_URL` is not optional, and the tooling will not quietly fall back to `DATABASE_URL` when it is missing. Prisma reads one connection string, and if that string is the application role then `pnpm db:migrate` tries to create tables as a role that cannot create tables. `packages/db/scripts/as-owner.mjs` substitutes the owner URL for the duration of one command, prints which role and database it connected as, and refuses to run at all if the variable is absent. Every `db:` script goes through it.

**VAPID keys** for web push are only needed from Phase 11.

## 4. Everyday commands

| Command                              | What it does                                                           |
| ------------------------------------ | ---------------------------------------------------------------------- |
| `pnpm dev`                           | All four services, watching                                            |
| `pnpm test`                          | Unit tests across the workspace                                        |
| `pnpm test:e2e`                      | Playwright, desktop and mobile viewports                               |
| `pnpm lint`                          | ESLint, including the rule that keeps `packages/domain` framework-free |
| `pnpm typecheck`                     | TypeScript, strict, no emit                                            |
| `pnpm format`                        | Prettier                                                               |
| `pnpm db:migrate`                    | Applies pending migrations in order, as the owner, and records them    |
| `pnpm db:migrate --status`           | What is applied, what is not                                           |
| `pnpm db:smoke`                      | The 18 schema assertions, via Prisma, no psql needed                   |
| `pnpm db:migrate:test`               | The same migrations against the test database                          |
| `pnpm test:integration`              | The auth suite. Needs a test database, see §7                          |
| `pnpm --filter @daybook/domain test` | Domain tests alone. Needs no install, no flags, no build step          |

That last one is worth knowing: the domain package has no dependencies, so its tests run on a fresh checkout before `pnpm install` finishes.

## 5. What has actually been verified

The brief's rule 7 says not to claim something works unless it has been tested.
This section is that accounting, kept honest rather than optimistic.

### Verified by running it

| Check                                                 | Where                                           | Result                                                                                                              |
| ----------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Bootstrap and migration on a clean PostgreSQL 16      | Linux                                           | 30 tables, 98 indexes, 152 constraints, 33 policies, 15 triggers                                                    |
| Migrations re-apply from scratch to a second database | Linux                                           | Clean                                                                                                               |
| 15 schema assertions                                  | Linux                                           | All pass                                                                                                            |
| 30 domain unit tests                                  | Linux, Node 22.22 **and Windows 11, Node 26.4** | All pass                                                                                                            |
| `pnpm install`                                        | Windows 11                                      | 511 packages                                                                                                        |
| `pnpm typecheck`                                      | Windows 11                                      | 10 of 10 tasks                                                                                                      |
| `pnpm test`                                           | Windows 11                                      | 10 of 10 tasks                                                                                                      |
| `pnpm build`                                          | Windows 11                                      | 5 of 5. Both Next apps compiled and prerendered, `nest build` and the worker compile clean, Prisma client generated |
| `pnpm lint`                                           | Windows 11                                      | 10 of 10 tasks                                                                                                      |
| Every JSON and YAML config parses                     | Linux                                           | Clean                                                                                                               |

| Bootstrap, schema and grants on managed PostgreSQL 16 (London) | Neon | Applied |
| 15 schema assertions, run three times in a row | Neon and Linux | 15, 15, 15 |
| `prisma db pull` | Neon | 30 models introspected |
| `pnpm dev` and `GET /v1/readyz` | Windows 11 to London | `{"status":"ok","database":"ok"}` as the restricted role |

### Still not verified

- **Everything in Phase 3a.** Written 2026-09-04 and not yet run: no install
  with the new dependencies, no lint, no typecheck, no build, and the auth
  integration suite has never executed. Until it does, the authentication
  described in this repository is a design, not a working system.
- The three new schema assertions, 16 to 18, and migration 0003
- Docker Compose, since the local path was not used
- Playwright, which arrives with the journeys it will test in Phase 9

### What the verification actually caught

Nine defects, each found by running something rather than by reading it.

| #   | Defect                                                                          | Only findable by                             |
| --- | ------------------------------------------------------------------------------- | -------------------------------------------- |
| 1   | Six foreign keys with no index                                                  | Applying the schema                          |
| 2   | Three credential tables with no access control                                  | A test that queried as the unprivileged role |
| 3   | `--experimental-strip-types` removed in Node 26                                 | A machine running Node 26                    |
| 4   | Corepack not bundled from Node 25                                               | The same                                     |
| 5   | `@eslint/js`, `typescript-eslint` and `@types/node` imported but never declared | Installing                                   |
| 6   | `fastify` imported but never declared                                           | Building under pnpm's isolated linker        |
| 7   | `db` typecheck racing its own `prisma generate`                                 | Running them together                        |
| 8   | Two `prisma generate` processes fighting over one DLL                           | Windows file locking, invisible on Linux     |
| 9   | `require-await` on the placeholder dispatch handler                             | Linting                                      |

Three of those nine needed Windows, and two needed Node 26. Neither was
available where the code was written, which is the case for testing on the
machine the software will actually run on.

## 6. Troubleshooting

**`psql: FATAL: role "daybook_app" does not exist`**
The bootstrap script has not run. It is separate from the migration because roles are cluster-wide rather than per-database.

**`permission denied for table auth_sessions`**
Working as intended. `daybook_app` cannot see the credential tables. Auth code must use the `authDb` client from `@daybook/db`.

**A query returns nothing when rows clearly exist**
Row-level security with no identity set. Every user-scoped query goes through `asUser(userId, ...)`, which sets a transaction-local `app.current_user_id`. Setting it at session scope would leak one user's identity into the next request on a pooled connection.

**`ERROR: invalid IANA timezone`**
A trigger, not a typo. Timezones are validated on write because a bad zone silently corrupts every occurrence built from it.

**`corepack : The term 'corepack' is not recognized`**
Node stopped bundling Corepack from version 25. Use `npm install -g pnpm@9` instead; it does the same job here.

**`Invalid environment configuration` from the API on startup**
It validates everything it needs at boot and refuses to start rather than
failing later on the first request. The dev scripts load the root `.env`
through `dotenv-cli`; in preview and production the platform supplies the
variables directly and no file is involved.

**`permission denied to set role "daybook_app"`**
The migrating role is not a member of the application roles. A superuser can
`SET ROLE` into anything; a managed provider's owner role cannot. The bootstrap
script grants the membership, so re-run `db:bootstrap` against that database.

**`Can't reach database server` on a hosted database, when the host resolves
and the port accepts TCP**
Two causes, in order of likelihood. The compute is asleep and the handshake
outran Prisma's five second default, which `connect_timeout=30` on the URL
fixes. Or the direct (non-pooled) endpoint is not reachable from your network
while the pooled one is, in which case use the pooled host: it serves the
schema work perfectly well.

**`Environment variable not found: DATABASE_URL`**
Either `.env` does not exist at the repository root yet, or it exists and has
no value on that line. The `db:` scripts load it through `dotenv-cli`; run them
from the repository root with `pnpm --filter @daybook/db <script>` rather than
calling `prisma` directly, which would look for `.env` in the wrong place.

**A wall of `no-unsafe-*` lint errors in `packages/db/src/index.ts`**
Same root cause as the missing-module error below: the Prisma client has not
been generated, so every type in that file resolves to `error` and the
type-aware rules report each use of it. `packages/db/turbo.json` makes both
`lint` and `typecheck` wait for the package's own `build`. It reproduces only
on a clean checkout, because a local machine usually has `generated/` left over
from an earlier run.

**`Cannot find module '../generated/client/index.js'` in @daybook/db**
The Prisma client has not been generated. `pnpm --filter @daybook/db build`
does it, and it reads only the schema file, so no database needs to be running.
`pnpm typecheck` from the root orders this for you; running `tsc` inside the
package directly does not.

**`EPERM: operation not permitted, rename ... query_engine-windows.dll.node.tmp`**
Two `prisma generate` runs writing the engine binary at the same time. Windows
locks a file that is open; Linux and macOS would silently tolerate it. Only
`build` may generate, and `packages/db/turbo.json` orders `typecheck` after it.
If you hit this after adding a script, check that nothing else calls
`prisma generate`.

**`ECONNRESET`, `socket hang up`, or `ERR_PNPM_META_FETCH_FAIL` during install**
A connection problem, not a dependency problem. `.npmrc` already lowers
`network-concurrency` to 4 and raises the retry budget, which is what makes a
first install survive a domestic or mobile link. If it still dies, just run
`pnpm install` again: pnpm caches every package it has already fetched, so each
attempt resumes rather than restarting. Installing the heavy packages on their
own first also helps:

    pnpm install --filter @daybook/db
    pnpm install --filter @daybook/api
    pnpm install

**`bad option: --experimental-strip-types`**
That flag was removed in Node 26, because type stripping became the default and then stable. Run `node --test 'test/*.test.ts'` with no flag. If you are on a Node older than 22.18, upgrade rather than adding the flag back.

---

## 7. The test database

The integration tests create accounts, change passwords and revoke sessions.
They get their own database, because a suite that can do that to the database
you develop against will eventually do it on the wrong afternoon.

Three guards, in order. `TEST_DATABASE_URL` must be set, must differ from
`DATABASE_URL`, and must have the word `test` in it; the suite refuses to start
otherwise. The cleanup only ever deletes accounts whose address ends
`@daybook.test`.

**On a managed provider.** Create a second database in the same project. The
roles are project-wide, so `daybook_app` and `daybook_auth` already exist and
the bootstrap is close to a no-op, but run it anyway: it is idempotent and it
grants the role membership the tenant-isolation assertion needs.

Add three connection strings to `.env`, pointing at the new database rather
than the development one:

```
TEST_DATABASE_URL=postgresql://daybook_app:...@.../daybook_test?sslmode=require
TEST_DATABASE_AUTH_URL=postgresql://daybook_auth:...@.../daybook_test?sslmode=require
TEST_DATABASE_MIGRATION_URL=postgresql://<owner>:...@.../daybook_test?sslmode=require
```

Then:

```bash
pnpm db:migrate:test          # bootstrap and every migration, in order
pnpm --filter @daybook/db db:smoke:test
pnpm test:integration
```

### The migration ledger

`db:migrate` records what it has applied in a `schema_migrations` table, so it
applies each file once and no more. Neither application role can read it.

The migrations are not all re-runnable: `0001_init` is plain `CREATE TABLE` and
stops at the first table that already exists. Making them re-runnable would
mean `IF NOT EXISTS` everywhere, which accepts an existing table with the wrong
columns without complaint, and which `CREATE POLICY` does not support at all.
Recording what ran is both simpler and stricter.

The recorded checksum is checked on every run. Editing an already-applied
migration fails, because at that point the database and the repository disagree
and the file no longer describes what is actually there. Add a new migration
instead.

**Adopting a database that predates the ledger.** If the tables were created
before this runner existed, tell it where things stand rather than letting it
guess:

```bash
pnpm --filter @daybook/db db:migrate --baseline=0002_app_grants
pnpm db:migrate
```

The first records everything up to and including that migration without running
any of it. The second applies whatever comes after.

The suite mints its own throwaway signing keypair per run, so no key from
`.env` is used and none is needed in CI. It also drops the Argon2 parameters to
the lowest the configuration will accept, because these tests are about the
protocol around the hash rather than the hash itself; real parameters would add
about a second to every sign-in in the suite.
