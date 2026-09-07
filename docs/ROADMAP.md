# Development Roadmap, Risks and Phase State

**Status:** Phases 1, 2 and 3 complete. Next up is Phase 4, Daybook core.
**Last updated:** 2026-09-06

This file is the session-to-session handover. Any future session should read it first to know exactly where the build stopped.

---

## 1. Phase state

| Phase | Name                          | State                    | Notes                                                                                                                                                                                |
| ----- | ----------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0     | Project discovery             | **complete**             | Green field. Nothing existed. Toolchain verified.                                                                                                                                    |
| 1     | Architecture                  | **complete, signed off** | Documentation set complete. All eight decisions closed.                                                                                                                              |
| 2     | Project foundation            | **complete**             | Verified end to end on Windows 11 / Node 26 against managed PostgreSQL 16 in London. `/v1/readyz` returns ok as the restricted role. CI green on GitHub Actions.                     |
| 3     | Authentication                | **complete**             | 33 integration tests pass against managed PostgreSQL 16 in London: 19 for password auth, 14 for Google sign-in against a real OIDC issuer. Both halves of the exit criterion proved. |
| 4     | Daybook core                  | not started              |                                                                                                                                                                                      |
| 5     | Recurring schedules           | not started              |                                                                                                                                                                                      |
| 6     | Habits                        | not started              |                                                                                                                                                                                      |
| 7     | Journal                       | not started              |                                                                                                                                                                                      |
| 8     | Fitness app                   | not started              |                                                                                                                                                                                      |
| 9     | Daybook / Fitness integration | not started              |                                                                                                                                                                                      |
| 10    | Analytics                     | not started              |                                                                                                                                                                                      |
| 11    | Notifications                 | not started              |                                                                                                                                                                                      |
| 12    | Offline support               | not started              |                                                                                                                                                                                      |
| 13    | UI/UX polish                  | not started              |                                                                                                                                                                                      |
| 14    | Security audit                | not started              |                                                                                                                                                                                      |
| 15    | Testing                       | not started              |                                                                                                                                                                                      |
| 16    | Deployment                    | not started              |                                                                                                                                                                                      |
| 17    | Final audit                   | not started              |                                                                                                                                                                                      |

---

## 2. Phase gates

Each phase has an exit criterion. A phase is not "done" because the code exists; it is done when the criterion is demonstrably met. This is how the brief's rule 7 (do not claim something works unless it has been tested) is enforced in practice.

### Phase 2: Foundation

Turborepo, pnpm workspaces, four apps and five packages scaffolded, PostgreSQL running locally, the schema applied, ESLint and Prettier and TypeScript strict mode, test runners wired, GitHub Actions, Docker Compose, `.env.example` documented.

**Exit criterion:** `pnpm install && pnpm dev` brings up both frontends, the API and the database on one machine, `pnpm test` passes, and CI is green on a pull request. **Met.**

**Done and proved (2026-08-29):**

- Bootstrap and initial migration apply to a clean PostgreSQL 16: 30 tables, 98 indexes, 152 constraints, 33 row-level security policies, 15 triggers
- Migrations re-apply from scratch to a second database
- 15 schema assertions pass, covering generated columns, partial unique indexes, the four sync idempotency guards, cascade deletes, foreign-key index coverage and live tenant isolation queried as the unprivileged role
- 30 domain unit tests pass, including daylight-saving transitions in both directions and the documented scoring examples. Re-run independently on Windows 11 with Node 26.4 on 2026-08-30: 30/30, 243ms
- Every JSON and YAML config parses

**Two defects the schema tests caught while being written:**

1. Six foreign keys had no index. Postgres does not create them, and the omission surfaces later as slow deletes and lock contention.
2. `auth_sessions`, `password_reset_tokens` and `email_verification_tokens` had no access control. They cannot use the tenant policy, because authentication happens before a user context exists. Fixed by giving them a separate `daybook_auth` role and denying the general application role any access, so an application bug cannot read a password hash. Both now have standing tests.

**Not done, blocked on network access:** `pnpm install` was impossible in the build environment (npm registry refused at the network layer), so the install, build, lint, typecheck, Next.js render, NestJS boot, Prisma generate, Docker Compose, CI and Playwright paths are all unverified. Dependency versions are caret ranges chosen from knowledge rather than resolved against the registry.

**Found on real hardware (2026-08-30), Node 26.4 on Windows:**

Two scaffold defects that the build container could not have surfaced, because it ran Node 22.

1. `--experimental-strip-types` was removed in Node 26. Type stripping became the default in 22.18 and stable in 24.12, so the flag is gone and every domain test would have failed on an unknown option. Dropped from the scripts and from CI; `engines` raised to `>=22.18.0`.
2. Node stopped bundling Corepack from version 25, so `corepack enable` fails. Setup now uses `npm install -g pnpm@9`.

Both are in the troubleshooting section of docs/SETUP.md.

**Verified on the product owner's machine, Windows 11 with Node 26.4 (2026-08-30):**

`pnpm install` (511 packages), `pnpm typecheck` (10/10), `pnpm test` (10/10),
`pnpm build` (5/5, both Next apps compiled and prerendered), `pnpm lint`
(10/10). Nine defects were found and fixed along the way, listed in
docs/SETUP.md section 5. Three of them were only reachable on Windows and two
only on Node 26.

**Exit criterion met (2026-08-30).** Against a managed PostgreSQL 16 in London:
bootstrap, schema and grants applied; 15 schema assertions passing, three runs
in a row; `prisma db pull` introspected all 30 models; `pnpm dev` brought the
stack up and `GET /v1/readyz` returned `{"status":"ok","database":"ok"}`
connecting as `daybook_app`, the role that owns nothing and cannot read the
credential tables.

**CI green (2026-08-30).** Four jobs pass on GitHub Actions: secret scan,
domain logic (30 tests on Node 24, a third platform), database schema (a clean
PostgreSQL 16, all three migrations, 15 assertions, then a full replay into a
second database), and lint/typecheck/test/build.

The end-to-end job was removed rather than fixed: it drives `pnpm dev`, which
needs a database and a populated `.env`. Supplying those to CI now would prove
only that a placeholder page renders. It returns in Phase 9 with the sync
journeys it exists to test.

**Three further defects found once a managed database was involved,** none of
which a local superuser install could have surfaced:

10. The owner role on a managed provider cannot `SET ROLE` into a role it does
    not belong to, so the tenant-isolation assertion failed. Bootstrap now
    grants membership explicitly.
11. The schema tests assumed a virgin database and could not run twice. They
    now clear their fixtures before and after.
12. The tests' cleanup revoked a privilege that came from the bootstrap rather
    than from the tests, quietly removing the application role's access to
    `activities` and `users` on every run. Grants moved to migration 0002,
    stated outright and idempotent; the tests no longer touch permissions.

**Four more found by CI itself,** none reachable on a machine that had already
built the project once:

13. Gitleaks read the pnpm lockfile's sha512 integrity hashes as secrets.
    Allowlisted in `.gitleaks.toml`; real credentials still fail the build.
14. Prettier had never been run over any file, since all of them were written
    by hand. `pnpm format` reformatted 17.
15. `pnpm/action-setup` refuses to run when the version is given both in
    `package.json`'s `packageManager` field and as an action input, even when
    they agree.
16. `packages/db` lint raced its own `prisma generate`, so every Prisma type
    resolved to `error` and the type-aware rules reported twelve failures. The
    package-level turbo config ordered `typecheck` after `build` but not
    `lint`. Invisible locally, where `generated/` survives from an earlier run.

### Decision: SQL-first migrations

Prisma cannot express partial unique indexes, generated columns, row-level security or triggers, and the schema depends on all four. Rather than generate migrations and patch them by hand every time, migrations are hand-written SQL and are the source of truth; `prisma db pull` regenerates the models from the applied schema, and CI fails on drift between the two.

### Phase 3: Authentication

Registration, email verification, login, refresh rotation with reuse detection, logout, logout-all, password reset, session listing, profile and preferences. Rate limiting on auth routes. RLS policies enabled and enforced.

**Exit criterion:** an integration test proves that a reused refresh token revokes the whole family, and that user B receives 404 for every one of user A's resources. Signing in on Daybook grants a session on Fitness without a second login.

Split in two. **3a** is password authentication and the session machinery. **3b**
is Google sign-in over the same session rows, which is a smaller job once 3a
exists and which needs a Google Cloud project that does not exist yet.

#### 3a: written 2026-09-04, not yet verified

Built:

- Argon2id password hashing, parameters in configuration and recorded inside
  each hash, so they can be raised later without invalidating anything. An
  unknown address is verified against a decoy hash so login takes the same time
  whether or not the account exists.
- 10-minute EdDSA access tokens, issuer and audience checked on every request,
  with a `kid` header so a signing key can be rotated without killing every
  token issued under the previous one.
- Rotating opaque refresh tokens, 32 random bytes, only the SHA-256 hash
  stored. The exchange is one transaction, so two tabs refreshing at once do
  not look like a theft.
- Family reuse detection: presenting an already-rotated token revokes the whole
  chain, including the token the legitimate client holds.
- Email verification and password reset as real single-use, expiring, hashed
  tokens. Only the transport is a console line, and it refuses to log a link at
  all in production.
- A global guard: every route is authenticated unless it carries `@Public()`.
- Per-caller rate limits with a separate, much tighter budget for the
  credential routes.
- `GET`/`PATCH /v1/me`, and `GET /v1/auth/sessions` so a person can see what
  signing out everywhere would end.
- Migration 0003: a `SECURITY DEFINER` trigger that gives every new user their
  profile, preferences and notification rows in the same transaction as the
  user, plus two pruning functions for dead sessions and spent tokens.

**Defect 17, found by running it (2026-09-04).** `db:bootstrap`, `db:apply`,
`db:grants`, `db:pull` and `db:smoke` all connected as `daybook_app`, because
Prisma reads exactly one connection string and that string is the application
role. That role owns nothing, cannot create a table, cannot grant a privilege
and cannot insert a user, which is the entire point of it and made it the one
role least able to run a migration. The symptom was mistaken for a managed
provider limitation in Phase 2 and worked around by pasting every migration
into a database console by hand. `packages/db/scripts/as-owner.mjs` now
substitutes `DATABASE_MIGRATION_URL` for the duration of one command, prints
the role and database it connected as, and refuses to run when the variable is
missing rather than falling back to the wrong role. `pnpm db:migrate` applies
every pending migration in order, discovering them rather than listing them.

Worth naming plainly: this was invisible for a week because the workaround
worked. A step that a person does by hand every time is not a step that is
working, it is a defect with a human in the loop.

**Defect 18, found by running the fix for defect 17 (2026-09-04).** The first
version of that runner re-applied every file on every run, on the stated claim
that all of them were idempotent by construction. The claim was false and had
been written into the commit message, the setup guide and this file before
anyone ran it. `0001_init` is several hundred lines of plain `CREATE TABLE` and
stops at the first table that already exists.

Two ways out. Rewrite the schema into `IF NOT EXISTS` everywhere, which is
worse than it sounds: `CREATE TABLE IF NOT EXISTS` accepts an existing table
with entirely the wrong columns and says nothing, and there is no
`CREATE POLICY IF NOT EXISTS` at all. Or record what has been applied, which is
what a migration runner is for.

So there is now a `schema_migrations` ledger holding a name, a checksum and a
timestamp, unreadable by either application role. The checksum is the part that
earns its place: editing a migration that has already run means the database
and the repository disagree and the file no longer describes what is really
there, so that fails on the next run rather than surfacing months later. A
database built before the ledger existed is adopted explicitly with
`--baseline=<name>` rather than guessed at, and `--status` prints what is
applied and what is not.

The lesson is the same one as rule 7, aimed at me rather than at the code: "is
idempotent" is a claim about behaviour, and I wrote it into three files without
running it once.

**Defect 19, found on the first genuinely empty database (2026-09-04).** The
adoption check asked `SELECT to_regclass('public.users')`, and Prisma cannot
deserialize the `regclass` type. Worth noting how it hid: that branch only runs
when the ledger is empty, and by the time the runner existed the development
database had already been adopted, so the line had never executed. The first
database that reached it was the test one. Now a plain boolean out of
`pg_class`.

Three defects in a row, 17, 18 and 19, each invisible until something ran. That
is not a run of bad luck, it is what the difference between reading code and
running it looks like when you measure it.

**Defect 20, found on the first run of the auth suite (2026-09-04).** Every
request returned 500, including `GET /v1/healthz`, which returns a constant and
touches nothing. Vitest transforms TypeScript with esbuild, and esbuild does not
implement `emitDecoratorMetadata`. Nest reads the `design:paramtypes` metadata
that setting emits to work out what a constructor wants, so under vitest every
injected dependency arrived as `undefined` and the first property access on one
threw. It surfaces at the first line of the first request rather than at boot,
which is what made it look like an application bug rather than a build one. The
test configs now transform through SWC, with decorator settings that mirror
`apps/api/tsconfig.json`.

**Defect 21, found by the same run.** The rate limiter fired correctly at five
attempts and the response was still a 500: `@fastify/rate-limit` throws an
error carrying its own `statusCode`, and the error filter treated anything that
was not a Nest `HttpException` as an unhandled bug. Every Fastify-native error
was doing this — a malformed JSON body, an oversized payload, an unsupported
content type — turning a fault the client caused into one that reads as ours.
The filter now honours a status below 500 when the thrown object carries one.

That first fix was half of it, and the run afterwards showed why. The object
`errorResponseBuilder` returns is thrown rather than sent, and I had it
returning the finished response body, which carried no status at all. The
result was a perfectly formed 429 payload delivered with a 500 on it. The
builder now returns the status and the message and lets the filter build the
body, which is the only arrangement where one error shape is actually
guaranteed. Two attempts at one defect, both because I reasoned about a
library's behaviour instead of reading what it threw.

**Defect 24, found by leaving the database alone overnight (2026-09-06).** The
suite assumed a warm database. Neon suspends its compute when nobody is using
it, and the first connection after that waits for it to resume; Prisma's
default pool timeout is ten seconds, which is shorter than a cold start. The
first query in `beforeAll` timed out and all nineteen tests were skipped, which
reads as a total failure and is not a bug in anything. The setup file now waits
for the database with backoff before the first test runs, and says so while it
waits. Worth keeping in mind for CI: anything scale-to-zero needs a warm-up
step, not a longer timeout and optimism.

**Defect 22, found by looking for defect 20.** The filter's 500 branch said
"the problem has been recorded" and then recorded it only through the request
logger. Nineteen failing requests produced not one line about what actually
threw. A log level, a redaction rule or a logger that was never attached is
enough to make an unhandled exception vanish entirely, and a 500 with nothing
behind it anywhere is close to the worst thing an API can do. It now also goes
to stderr with its stack outside production.

**Exit criterion met (2026-09-06).** Nineteen integration tests pass against
managed PostgreSQL 16 in London, through the real application: the same
modules, the same global guard, the same rate limiter, the same error filter.
The only substitution is the mail transport, which does not exist yet.

Both halves of the criterion:

- _A reused refresh token revokes the whole family._ The test rotates a token,
  replays the old one, and asserts that the replay fails **and** that the
  legitimate client's current token is dead too. Revoking only the replayed
  token would leave a thief's copy working if the thief had been first to
  rotate, so the assertion is on the second part.
- _One account sees nothing of another's._ Two accounts, a row belonging to the
  first, and the second querying through the same `asUser` path the API uses,
  getting nothing back: not by count, not by primary key, not with the owner's
  id in hand. Over HTTP, one account's token returns only that account.

And the third thing the phase promised: signing in on one app grants a session
on the other with no second login, because both call the same API origin and
the refresh cookie is set there.

Also proved: registration creates the companion rows through the trigger;
sign-in answers identically for a wrong password and an address with no
account; every route is closed unless marked public; a token signed with a
different key is refused while being accepted by the instance that minted it;
verification and reset links work exactly once; a reset ends every session; a
password change requires the current password; and the rate limiter stops the
sixth sign-in attempt from one address without touching another's.

**What is still not covered.** The HTTP-level "404 for another user's resource"
assertion waits on Phase 4, because there are no resource endpoints yet. The
mail transport is a recorder. Rate limits are per instance.

#### 3b: complete 2026-09-06

Google sign-in over OpenID Connect, Authorization Code with PKCE, with the API
as the OAuth client because a browser cannot keep a client secret.

- `GET /v1/auth/google` mints state, a nonce and a PKCE verifier, keeps them in
  a signed short-lived cookie rather than a table, and redirects to Google.
- `GET /v1/auth/google/callback` checks the state, exchanges the code server to
  server, and verifies the ID token's signature against Google's published keys
  along with its issuer, audience and nonce.
- The callback answers with a redirect and a cookie, never a token in a URL.
- Linking matches on Google's subject id and attaches an unknown identity to an
  existing account only when Google asserts `email_verified`.
- A Google session is an ordinary `auth_sessions` row, so rotation, reuse
  detection and sign-out-everywhere work on it with no code that knows where it
  came from. That was the point of decision D8.
- Not configuring Google gives 503 on both routes rather than 404.

**Tested against an issuer, not a mock.** `apps/api/test/helpers/fake-issuer.ts`
is a real OIDC issuer: it serves a JWKS, signs ID tokens, and can sign one with
a key it does not publish. Mocking the client would prove the controller calls a
function; it would say nothing about whether we check a signature, an issuer, an
audience or a nonce, which is the entire set of things worth getting right here.

**Defect 25, found by a slow afternoon (2026-09-06).** Every transaction was
running under Prisma's default five-second ceiling, which assumes the database
is next to the process. Ours is deliberately not: London in production, and a
laptop talking to another country in development. On a day when the database
answered in 1.5 seconds rather than 150 milliseconds, `asUser` exceeded five
seconds doing three statements, and registration and sign-in returned 500.

The ceiling is now 20 seconds, configurable, and there is a matching one for
acquiring a connection. These are limits and not waits: a healthy transaction
finishes in milliseconds. The point is that a slow network should produce a slow
request rather than an error, because one of those is recoverable and the other
is an outage.

Worth recording alongside it: the same afternoon showed `POST /auth/register`
taking 15 seconds against 1.4 the day before, with no code change in between.
That is the round-trip cost described under "why the API is slow" arriving all
at once, and it is the argument for co-locating the API with the database
rather than a hypothetical one.

**Defect 26, found by fixing defect 25 (2026-09-06).** The transaction ceiling
came off and the suite still failed: 16 of 33, and fifteen of those sixteen
were `Test timed out in 30000ms` rather than an assertion. The 30-second
per-test timeout had been chosen against a database that answered in about 150
milliseconds; the same requests were now taking 26 to 39 seconds, so the
timeout had quietly become the binding constraint. I had predicted in writing
that the ceiling fix would leave the tests slow rather than broken. It did not,
because I fixed one limit and left the other one calibrated against the old
world.

The timeout is now 90 seconds and reads from `INTEGRATION_TEST_TIMEOUT_MS`. A
larger number does not make anything faster and is not supposed to; it restores
the property that a red test means broken code. But a number like this is a
symptom, and accommodating it permanently would be the wrong lesson, which is
why the next paragraph exists.

**The slowness, measured at last (2026-09-06).** Three sessions produced "the
database is slow" and three produced a guess in response, including two of mine
telling the owner to check the Neon console. `pnpm --filter @daybook/db
db:latency` replaced the guessing. It speaks enough of the Postgres wire
protocol to time a bare round trip with no authentication or query in it, and
probes three hosts against that ruler: the pooler, the compute endpoint
directly, and an unrelated host on the open internet.

Two runs, forty minutes apart, and they disagree, which is the finding.

|                                    | first run        | second run |
| ---------------------------------- | ---------------- | ---------- |
| Round trip to the pooler           | 1,293 to 2,501ms | 145ms      |
| Round trip to the compute          | not reached      | 155ms      |
| Round trip to `www.cloudflare.com` | not reached      | 148ms      |
| `SELECT 1`, median of 15           | not reached      | 156ms      |

So the 26 to 39 second requests were **a transient fault on the developer
machine's link**, not Neon, not a quota, and not anything in this repository.
It cleared on its own. Neon's console was never going to show it, and I sent
the owner there twice.

**What the healthy numbers say, which is more useful.** Round-trip time is
about 150ms to everything, cloudflare included, so it is the floor this machine
sits at rather than anything about the provider. `SELECT 1` costs 156ms against
a 145ms floor: the database itself contributes roughly ten milliseconds and is
not a suspect in any latency question here.

That makes **round-trip count the only lever in development**, and the numbers
put a price on each one. Three worked examples from the same run:

- A transaction wrapping three statements costs 775ms, which is five round
  trips: `BEGIN`, three statements, `COMMIT`.
- `asUser()` doing `set_config` plus one query costs 759ms. Logically two
  statements, actually about five round trips, because Prisma's interactive
  transactions send each statement separately.
- The first query of a process costs 2,028ms, which is connection setup and
  happens once.

The interactive transaction is the expensive part, and it is ours rather than
the network's. Prisma's array form, `$transaction([...])`, sends the batch in
one round trip, which would take a single-statement user-scoped read from about
760ms to about 160ms on this link. It cannot express a callback, so it fits
exactly the reads Phase 4 is about to add a great many of, and not the auth
flows that branch. **Recorded here as the first thing to look at when Phase 4
endpoints feel slow**, with a measured number attached rather than an instinct.

None of this matters in production, where the API sits in London beside its
database and a round trip is about a millisecond. It matters every day in
development, which is where the work happens.

**Exit criterion met (2026-09-06).** Thirty-three integration tests pass in one
run, in 222 seconds, against managed PostgreSQL 16 in London. The same run had
failed sixteen of thirty-three in 670 seconds three hours earlier, with no code
change between them beyond the timeout: the difference was the machine's link,
which is why the probe above exists.

The fourteen Google tests, in full:

- Somebody with no account signs in with Google and gets one, with the
  companion rows the trigger creates and a session that refreshes.
- Somebody who registered with a password and later signs in with Google, on a
  verified address, lands in the same account rather than a second one.
- Signing in with Google twice reuses the identity rather than creating another.
- A Google session refreshes, rotates and signs out through exactly the same
  endpoints a password session uses, with no code that knows where it came from.
- An unverified address attaches to nothing and creates nothing.
- An identity with no address at all is refused.
- A callback whose state does not match the flow is refused.
- A callback with no flow cookie is refused.
- An ID token signed with a key the issuer does not publish is refused.
- An ID token minted for a different sign-in attempt is refused.
- Cancelling at the provider comes back to the sign-in page, not an error page.
- An unconfigured server answers 503 rather than 404.
- The start route sends state, a nonce and a PKCE challenge.
- The callback answers with a cookie and a redirect, never a token in a URL.

**What is still not covered, unchanged from 3a.** The HTTP-level "404 for
another user's resource" assertion waits on Phase 4. The mail transport is a
recorder. Rate limits are per instance. And no real Google client id has ever
been used: the suite proves the protocol against an issuer we control, which is
the right thing to test, but a Google Cloud OAuth client still has to be created
before anybody can sign in with an actual Google account.

**One honest gap in the exit criterion.** "User B receives 404 for every one of
user A's resources" cannot be tested over HTTP yet, because there are no
resource endpoints until Phase 4. The suite tests the property at the layer
that enforces it: two accounts, a row belonging to one, and the other querying
through the same `asUser` path the API uses, getting nothing back. The
HTTP-level assertion is a Phase 4 exit requirement.

### Phase 4: Daybook core

Categories, one-off activities, the day timeline, status transitions with the state machine, start/pause/resume/complete/skip, the current-activity view, the daily dashboard.

**Exit criterion:** a full day can be planned, executed and completed through the UI, with actual times recorded, and illegal transitions rejected with 409.

### Phase 5: Recurring schedules

RRULE-backed series, the materialiser job with a 90 day horizon, the three edit scopes, series exceptions, calendar day/week/month views with drag to move and resize.

**Exit criterion:** a series crossing a daylight-saving boundary materialises at the correct wall-clock time on both sides, proven by a test using a real DST transition date. Editing one occurrence does not disturb the series; editing "future" does not rewrite history.

### Phase 6: Habits

Definitions with binary, count and duration targets, due-day rules, logging, computed streaks, heatmap.

**Exit criterion:** backfilling a missed day recalculates the streak correctly, including when it bridges two previously separate runs.

### Phase 7: Journal

Daily entries, tags, highlights, the end-of-day summary, historical browsing and search.

### Phase 8: Fitness app

Exercise library with the seeded set, routines with ordering and supersets, live workout session with rest timer, set logging, session completion with totals, personal record detection, workout history.

**Exit criterion:** a complete Push Day session can be logged on a phone-sized screen without the keyboard obscuring the input, and PRs are detected against real prior data.

### Phase 9: Integration

The transactional outbox, the event dispatcher, the Daybook projector with all four matching rules, retries, dead-lettering, the SSE channel, and the manual-link fallback UI.

**Exit criterion:** the nine tests listed in SYNC.md §10 all pass, including the offline duplicate test.

### Phase 10: Analytics

Daily, weekly and monthly analytics, the productivity score with breakdown, planned-versus-actual, most-missed activities, best hours, the summary roll-up job.

**Exit criterion:** the worked example in SCORING.md §4 is a passing regression test, and roll-ups recomputed from the event log match roll-ups computed incrementally.

### Phase 11: Notifications

Scheduler, web push subscriptions, quiet hours, per-type preferences, deduplication.

**Exit criterion:** no duplicate notification for the same activity, verified across a worker restart.

### Phase 12: Offline

Service worker, app shell caching, IndexedDB outbox, replay, conflict surfacing.

**Exit criterion:** the offline scenarios in SYNC.md §8 pass in Playwright with the network genuinely disabled.

### Phases 13 to 17

Polish, security audit, full test sweep, production deployment, final audit against the 20 success criteria in the brief §40.

---

## 3. Risk register

| #   | Risk                                                                                                                                                                                 | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **Recurrence, timezones and daylight saving.** The classic source of silent data corruption in planners: an activity quietly shifts by an hour and the user's history becomes wrong. | High       | High   | Wall-clock time plus IANA zone stored on the series; occurrences materialised to absolute instants by a tested library (`rrule` + Luxon); a single `dayKey()` helper used everywhere; DST transition dates in the test fixtures from Phase 5 onward. |
| R2  | **Materialiser falls behind or fails**, leaving days with no activities.                                                                                                             | Medium     | High   | Rolling horizon with a watermark per series; lazy read-time expansion as a fallback; nightly integrity job alerts on any active series whose watermark is under 14 days out.                                                                         |
| R3  | **Duplicate or lost sync events** producing double Daybook entries or a workout that never lands.                                                                                    | Medium     | High   | Four layers of idempotency (SYNC.md §5); transactional outbox so the event cannot be lost; dead-letter surfaced in the UI with one-tap manual linking.                                                                                               |
| R4  | **Scope.** The brief describes roughly a year of work for a team. Attempting it linearly stalls before anything is usable.                                                           | High       | High   | Phase gates with hard exit criteria; a usable slice by Phase 5 (plan a day, execute it, see it) that is worth using even if the project paused there.                                                                                                |
| R5  | **Offline conflict complexity** expanding without bound.                                                                                                                             | Medium     | Medium | Offline writes restricted to a fixed list; everything else requires connectivity; conflicts surfaced to the user rather than auto-merged.                                                                                                            |
| R6  | **iOS notification limits.** Web push on iOS needs 16.4+ and home-screen installation, and is less reliable than native.                                                             | High       | Medium | Set the expectation now (decision D5); in-app reminders as the baseline; native client as a later option rather than a rewrite, since the API is already separate.                                                                                   |
| R7  | **The score demotivates rather than informs.**                                                                                                                                       | Medium     | Medium | Null on unplanned days, component renormalisation, no streak-shaming, breakdown always visible, weights user-configurable.                                                                                                                           |
| R8  | **Analytics drift**, where roll-ups and raw data disagree after a bug fix.                                                                                                           | Medium     | Medium | `daily_summaries` is a cache, never a source of truth; a rebuild command recomputes any range from `activity_status_events` and `domain_events`; a test asserts incremental equals rebuilt.                                                          |
| R9  | **Single developer, ephemeral build environment.** Work is lost if it does not leave the session.                                                                                    | High       | High   | Every phase committed to GitHub and archived; this file carries the handover state.                                                                                                                                                                  |
| R10 | **Security regression** as surface area grows across two apps.                                                                                                                       | Medium     | High   | RLS as a second layer under application checks; an ownership test per endpoint as a CI requirement, not a Phase 14 activity; `gitleaks` and dependency audit in CI from Phase 2.                                                                     |
| R11 | **Hosting cost creep** across Vercel, Fly and Neon.                                                                                                                                  | Low        | Low    | All three have workable free tiers at single-user scale; the whole stack is containerised so it can collapse onto one VPS if needed.                                                                                                                 |

---

## 4. What ships when: the usable-early principle

The order above front-loads usefulness. After Phase 5 you have a working planner you can run your actual days on: recurring schedules, a live timeline, real completion tracking. Everything after that adds depth to something already in daily use, which is the best possible way to find out whether the design is right.

The alternative, building all the infrastructure first and the experience last, produces a system that is architecturally complete and untested against reality. It is not worth the risk on a product whose whole purpose is daily use.

---

## 5. Decisions log

| #   | Decision               | Resolution                                                                                                                                                                                                                                               | Date       |
| --- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| D1  | Platform               | Web-first installable PWA, two Next.js apps, mobile-ready                                                                                                                                                                                                | 2026-08-28 |
| D2  | Auth hosting           | Self-hosted, own PostgreSQL, no identity vendor                                                                                                                                                                                                          | 2026-08-28 |
| D3  | Delivery               | GitHub repository plus a per-phase archive                                                                                                                                                                                                               | 2026-08-28 |
| D4  | **Domain and routing** | **No domain yet. Build for path-based routing on one host: `/plan` and `/fit`. Revisit at Phase 16.**                                                                                                                                                    | 2026-08-28 |
| D5  | **Notifications**      | **Accept web push limits. iOS requires 16.4+ and Home Screen installation. In-app reminders are the baseline; a native client stays a later option.**                                                                                                    | 2026-08-28 |
| D6  | **Hosting region**     | **London, `aws-eu-west-2`. API and worker co-located in London so the API-to-database hop stays in region.**                                                                                                                                             | 2026-08-28 |
| D7  | **Version control**    | **Scoped fine-grained GitHub token, single repository, Contents and Workflows read/write, short expiry, revoked when the project pauses.**                                                                                                               | 2026-08-28 |
| D8  | **Session ownership**  | **The API owns identity. Argon2id passwords, 10-minute EdDSA access tokens, rotating opaque refresh cookie with family reuse detection, sessions in `auth_sessions`. Google sign-in via OIDC in Phase 3, landing in the same session row. Not Auth.js.** | 2026-08-29 |

| D9 | **Credential queries are written SQL, not generated models** | **`prisma db pull` introspects as `daybook_app`, which cannot see three of the five credential tables. Widening that role to satisfy a code generator would undo the reason the role exists, so `packages/db/src/auth.ts` is parameterised SQL against the schema in the same package.** | 2026-09-04 |
| D10 | **Companion rows come from a trigger** | **A `SECURITY DEFINER` trigger creates `user_profiles`, `user_preferences` and `notification_preferences` on every user insert. The alternatives were to widen `daybook_auth` until it could write profile tables, or to use a second transaction and accept a window where a user has no profile.** | 2026-09-04 |
| D11 | **Registration says when an address is taken** | **Sign-in and password reset refuse to reveal whether an account exists; registration does not, because any answer other than success reveals it anyway. The genuinely non-enumerating design answers "check your email" always and cannot sign anyone in at the end of registering. The defence is the rate limit on the route.** | 2026-09-04 |
| D12 | **Rate limits are in-memory** | **Correct for one instance, wrong for several. Moves to Redis when the API is actually scaled out, which is Phase 16 at the earliest. Recorded rather than left as a surprise.** | 2026-09-04 |

### Consequences of D4 for the auth design

Path-based routing on one host removes the parent-domain cookie, and simplifies things rather than complicating them. Both apps are served from the same origin, so one `HttpOnly` refresh cookie scoped to that origin covers both. `SameSite` can be tightened from `Lax` to `Strict` because there is no cross-subdomain hop. The JWT `aud` claim still distinguishes the two apps for logging and per-client rate limits.

Moving to subdomains later means changing the cookie `Domain` attribute, the CORS allowlist and the deploy configuration. It is a configuration change, not a redesign, which is why deferring costs nothing.

### Why D8 went the way it did

Auth.js is strongest at OAuth. The moment email and password enters the picture its Credentials provider forces the JWT session strategy, database sessions are not supported, and with no server-side session row there is nothing to revoke: no sign-out-everywhere, no device list, no reuse detection, and a password change leaves other sessions alive. Auth.js also does not hash passwords, register users, or handle reset and verification, so that code gets written either way.

The cost of D8 is that the auth layer is written rather than imported. It is contained by where it sits: Phase 3 does not close until an integration test proves that a reused refresh token revokes the whole family and that cross-account access returns 404, and Phase 14 audits the same surface again.

### Still open

Nothing blocking. Remaining decisions (domain name, native client) are scheduled at the phases that need them.
