# Development Roadmap, Risks and Phase State

**Status:** Phase 1 signed off, Phase 2 in progress
**Last updated:** 2026-08-29

This file is the session-to-session handover. Any future session should read it first to know exactly where the build stopped.

---

## 1. Phase state

| Phase | Name | State | Notes |
|---|---|---|---|
| 0 | Project discovery | **complete** | Green field. Nothing existed. Toolchain verified. |
| 1 | Architecture | **complete, signed off** | Documentation set complete. All eight decisions closed. |
| 2 | Project foundation | **partially complete** | Database and domain layers verified against a live PostgreSQL 16. Install path unverified: the build environment had no npm registry access. See docs/SETUP.md section 5. |
| 3 | Authentication | not started | |
| 4 | Daybook core | not started | |
| 5 | Recurring schedules | not started | |
| 6 | Habits | not started | |
| 7 | Journal | not started | |
| 8 | Fitness app | not started | |
| 9 | Daybook / Fitness integration | not started | |
| 10 | Analytics | not started | |
| 11 | Notifications | not started | |
| 12 | Offline support | not started | |
| 13 | UI/UX polish | not started | |
| 14 | Security audit | not started | |
| 15 | Testing | not started | |
| 16 | Deployment | not started | |
| 17 | Final audit | not started | |

---

## 2. Phase gates

Each phase has an exit criterion. A phase is not "done" because the code exists; it is done when the criterion is demonstrably met. This is how the brief's rule 7 (do not claim something works unless it has been tested) is enforced in practice.

### Phase 2: Foundation
Turborepo, pnpm workspaces, four apps and five packages scaffolded, PostgreSQL running locally, the schema applied, ESLint and Prettier and TypeScript strict mode, test runners wired, GitHub Actions, Docker Compose, `.env.example` documented.

**Exit criterion:** `pnpm install && pnpm dev` brings up both frontends, the API and the database on one machine, `pnpm test` passes, and CI is green on a pull request. **Not yet met.**

**Done and proved (2026-08-29):**

- Bootstrap and initial migration apply to a clean PostgreSQL 16: 30 tables, 98 indexes, 152 constraints, 33 row-level security policies, 15 triggers
- Migrations re-apply from scratch to a second database
- 15 schema assertions pass, covering generated columns, partial unique indexes, the four sync idempotency guards, cascade deletes, foreign-key index coverage and live tenant isolation queried as the unprivileged role
- 30 domain unit tests pass, including daylight-saving transitions in both directions and the documented scoring examples
- Every JSON and YAML config parses

**Two defects the schema tests caught while being written:**

1. Six foreign keys had no index. Postgres does not create them, and the omission surfaces later as slow deletes and lock contention.
2. `auth_sessions`, `password_reset_tokens` and `email_verification_tokens` had no access control. They cannot use the tenant policy, because authentication happens before a user context exists. Fixed by giving them a separate `daybook_auth` role and denying the general application role any access, so an application bug cannot read a password hash. Both now have standing tests.

**Not done, blocked on network access:** `pnpm install` was impossible in the build environment (npm registry refused at the network layer), so the install, build, lint, typecheck, Next.js render, NestJS boot, Prisma generate, Docker Compose, CI and Playwright paths are all unverified. Dependency versions are caret ranges chosen from knowledge rather than resolved against the registry.

**To close this phase:** run `pnpm install && pnpm dev` on a machine with network access and report failures.

### Decision: SQL-first migrations

Prisma cannot express partial unique indexes, generated columns, row-level security or triggers, and the schema depends on all four. Rather than generate migrations and patch them by hand every time, migrations are hand-written SQL and are the source of truth; `prisma db pull` regenerates the models from the applied schema, and CI fails on drift between the two.

### Phase 3: Authentication
Registration, email verification, login, refresh rotation with reuse detection, logout, logout-all, password reset, session listing, profile and preferences. Rate limiting on auth routes. RLS policies enabled and enforced.

**Exit criterion:** an integration test proves that a reused refresh token revokes the whole family, and that user B receives 404 for every one of user A's resources. Signing in on Daybook grants a session on Fitness without a second login.

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

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | **Recurrence, timezones and daylight saving.** The classic source of silent data corruption in planners: an activity quietly shifts by an hour and the user's history becomes wrong. | High | High | Wall-clock time plus IANA zone stored on the series; occurrences materialised to absolute instants by a tested library (`rrule` + Luxon); a single `dayKey()` helper used everywhere; DST transition dates in the test fixtures from Phase 5 onward. |
| R2 | **Materialiser falls behind or fails**, leaving days with no activities. | Medium | High | Rolling horizon with a watermark per series; lazy read-time expansion as a fallback; nightly integrity job alerts on any active series whose watermark is under 14 days out. |
| R3 | **Duplicate or lost sync events** producing double Daybook entries or a workout that never lands. | Medium | High | Four layers of idempotency (SYNC.md §5); transactional outbox so the event cannot be lost; dead-letter surfaced in the UI with one-tap manual linking. |
| R4 | **Scope.** The brief describes roughly a year of work for a team. Attempting it linearly stalls before anything is usable. | High | High | Phase gates with hard exit criteria; a usable slice by Phase 5 (plan a day, execute it, see it) that is worth using even if the project paused there. |
| R5 | **Offline conflict complexity** expanding without bound. | Medium | Medium | Offline writes restricted to a fixed list; everything else requires connectivity; conflicts surfaced to the user rather than auto-merged. |
| R6 | **iOS notification limits.** Web push on iOS needs 16.4+ and home-screen installation, and is less reliable than native. | High | Medium | Set the expectation now (decision D5); in-app reminders as the baseline; native client as a later option rather than a rewrite, since the API is already separate. |
| R7 | **The score demotivates rather than informs.** | Medium | Medium | Null on unplanned days, component renormalisation, no streak-shaming, breakdown always visible, weights user-configurable. |
| R8 | **Analytics drift**, where roll-ups and raw data disagree after a bug fix. | Medium | Medium | `daily_summaries` is a cache, never a source of truth; a rebuild command recomputes any range from `activity_status_events` and `domain_events`; a test asserts incremental equals rebuilt. |
| R9 | **Single developer, ephemeral build environment.** Work is lost if it does not leave the session. | High | High | Every phase committed to GitHub and archived; this file carries the handover state. |
| R10 | **Security regression** as surface area grows across two apps. | Medium | High | RLS as a second layer under application checks; an ownership test per endpoint as a CI requirement, not a Phase 14 activity; `gitleaks` and dependency audit in CI from Phase 2. |
| R11 | **Hosting cost creep** across Vercel, Fly and Neon. | Low | Low | All three have workable free tiers at single-user scale; the whole stack is containerised so it can collapse onto one VPS if needed. |

---

## 4. What ships when: the usable-early principle

The order above front-loads usefulness. After Phase 5 you have a working planner you can run your actual days on: recurring schedules, a live timeline, real completion tracking. Everything after that adds depth to something already in daily use, which is the best possible way to find out whether the design is right.

The alternative, building all the infrastructure first and the experience last, produces a system that is architecturally complete and untested against reality. It is not worth the risk on a product whose whole purpose is daily use.

---

## 5. Decisions log

| # | Decision | Resolution | Date |
|---|---|---|---|
| D1 | Platform | Web-first installable PWA, two Next.js apps, mobile-ready | 2026-08-28 |
| D2 | Auth hosting | Self-hosted, own PostgreSQL, no identity vendor | 2026-08-28 |
| D3 | Delivery | GitHub repository plus a per-phase archive | 2026-08-28 |
| D4 | **Domain and routing** | **No domain yet. Build for path-based routing on one host: `/plan` and `/fit`. Revisit at Phase 16.** | 2026-08-28 |
| D5 | **Notifications** | **Accept web push limits. iOS requires 16.4+ and Home Screen installation. In-app reminders are the baseline; a native client stays a later option.** | 2026-08-28 |
| D6 | **Hosting region** | **London, `aws-eu-west-2`. API and worker co-located in London so the API-to-database hop stays in region.** | 2026-08-28 |
| D7 | **Version control** | **Scoped fine-grained GitHub token, single repository, Contents and Workflows read/write, short expiry, revoked when the project pauses.** | 2026-08-28 |
| D8 | **Session ownership** | **The API owns identity. Argon2id passwords, 10-minute EdDSA access tokens, rotating opaque refresh cookie with family reuse detection, sessions in `auth_sessions`. Google sign-in via OIDC in Phase 3, landing in the same session row. Not Auth.js.** | 2026-08-29 |

### Consequences of D4 for the auth design

Path-based routing on one host removes the parent-domain cookie, and simplifies things rather than complicating them. Both apps are served from the same origin, so one `HttpOnly` refresh cookie scoped to that origin covers both. `SameSite` can be tightened from `Lax` to `Strict` because there is no cross-subdomain hop. The JWT `aud` claim still distinguishes the two apps for logging and per-client rate limits.

Moving to subdomains later means changing the cookie `Domain` attribute, the CORS allowlist and the deploy configuration. It is a configuration change, not a redesign, which is why deferring costs nothing.

### Why D8 went the way it did

Auth.js is strongest at OAuth. The moment email and password enters the picture its Credentials provider forces the JWT session strategy, database sessions are not supported, and with no server-side session row there is nothing to revoke: no sign-out-everywhere, no device list, no reuse detection, and a password change leaves other sessions alive. Auth.js also does not hash passwords, register users, or handle reset and verification, so that code gets written either way.

The cost of D8 is that the auth layer is written rather than imported. It is contained by where it sits: Phase 3 does not close until an integration test proves that a reused refresh token revokes the whole family and that cross-account access returns 404, and Phase 14 audits the same surface again.

### Still open

Nothing blocking. Remaining decisions (domain name, native client) are scheduled at the phases that need them.
