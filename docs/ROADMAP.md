# Development Roadmap, Risks and Phase State

**Status:** Phase 1 proposal
**Last updated:** 2026-08-28

This file is the session-to-session handover. Any future session should read it first to know exactly where the build stopped.

---

## 1. Phase state

| Phase | Name | State | Notes |
|---|---|---|---|
| 0 | Project discovery | **complete** | Green field. Nothing existed. Toolchain verified. |
| 1 | Architecture | **complete, awaiting sign-off** | This documentation set. Four open decisions in ARCHITECTURE.md §12. |
| 2 | Project foundation | not started | |
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
Turborepo, pnpm workspaces, four apps and five packages scaffolded, PostgreSQL running locally, Prisma schema translated from DATABASE.md with the first migration applied, ESLint and Prettier and TypeScript strict mode, Vitest and Playwright wired, GitHub Actions running lint plus typecheck plus test on every push, Docker Compose for local development, `.env.example` documented.

**Exit criterion:** `pnpm install && pnpm dev` brings up both frontends, the API and the database on one machine, `pnpm test` passes, and CI is green on a pull request.

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
| R6 | **iOS notification limits.** Web push on iOS needs 16.4+ and home-screen installation, and is less reliable than native. | High | Medium | Set the expectation now (open decision 3); in-app reminders as the baseline; native client as a later option rather than a rewrite, since the API is already separate. |
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

## 5. Open decisions blocking Phase 2

Repeated from ARCHITECTURE.md §12 because they gate the next phase:

1. **Auth model.** Confirm the API-owned JWT plus rotating refresh cookie, or keep Auth.js literally and accept one app hosting identity.
2. **Domain name.** Cross-app single sign-on assumes two subdomains under one parent. Confirm you have or will have a domain, otherwise the plan switches to path-based routing on one host.
3. **Notifications.** Accept web push limits on iOS, or plan for a native client earlier.
4. **Hosting region.** Defaulting to EU. Confirm or change.
5. **GitHub repository.** Needed before Phase 2 so each phase can be committed rather than only archived.
