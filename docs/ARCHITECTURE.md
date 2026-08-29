# Daybook Ecosystem: System Architecture

**Status:** Phase 1 proposal, awaiting product owner sign-off
**Version:** 1.0
**Date:** 2026-08-28

---

## 1. Purpose of this document

This document defines the system architecture for the Daybook ecosystem: two user-facing applications (Daybook and Fitness) that share one identity, one API and one database, connected by an event pipeline so that finishing a workout in Fitness marks the corresponding Daybook activity complete without the user typing anything twice.

Nothing in this document is implemented yet. It exists so that architectural mistakes are cheap to fix now rather than expensive to fix in Phase 9.

---

## 2. Product owner decisions already made

| Decision | Choice |
|---|---|
| Platform | Web-first, installable PWA, mobile-ready |
| Authentication hosting | Self-hosted, own PostgreSQL, no identity vendor |
| Code delivery | GitHub repository plus a per-phase archive |
| Session scope | Phase 1 architecture only, no application code |
| Routing | Path-based on one host (`/plan`, `/fit`). No domain yet, revisit at Phase 16 |
| Notifications | Web push accepted with its iOS limits; in-app reminders are the baseline |
| Hosting region | London, `aws-eu-west-2`, API and worker co-located |
| Version control | Scoped fine-grained GitHub token, single repository |

---

## 3. Technology stack

### 3.1 Recommendation summary

| Layer | Choice | Version target |
|---|---|---|
| Monorepo | Turborepo + pnpm workspaces | Turborepo 2.x, pnpm 9.x |
| Frontends | Next.js App Router + React + TypeScript | Next 15, React 19, TS 5.6 |
| Styling | Tailwind CSS + a small in-house component library on Radix primitives | Tailwind 4 |
| Data fetching | TanStack Query + a generated typed client | v5 |
| Backend | NestJS on the Fastify adapter, TypeScript | Nest 11 |
| Validation / contracts | Zod schemas in a shared package, OpenAPI generated from them | Zod 3 |
| Database | PostgreSQL | 16 |
| ORM / migrations | Prisma | 6 |
| Background jobs | pg-boss (job queue inside PostgreSQL) | 10 |
| Auth | API-issued JWT access tokens + rotating opaque refresh cookies, Argon2id password hashing | see §5 |
| Testing | Vitest (unit), Supertest + Testcontainers (integration), Playwright (E2E) | |
| CI/CD | GitHub Actions | |
| Hosting | Vercel (web), Fly.io (API + worker), Neon (Postgres) | |

### 3.2 Why these, and what was rejected

**Next.js for both frontends, rather than React Native or Flutter.**
A web-first PWA gets to daily usability fastest, runs on desktop and phone from one codebase, installs to the home screen, and works offline through a service worker. The cost is honest and worth stating: iOS web push requires iOS 16.4 or later *and* the app added to the home screen, and background reliability is weaker than a native app. Because the API is a separate service, an Expo client can be added later against the same endpoints without touching the backend.

**NestJS as a standalone API, rather than Next.js route handlers.**
Two frontends share this API, and the spec calls for future integrations (wearables, calendar services, health platforms). An API that lives inside one frontend's deployment makes the other frontend a second-class client and couples backend releases to frontend releases. NestJS gives module boundaries that map to the domain, dependency injection that makes the business logic testable without HTTP, guards and interceptors for auth and rate limiting, and OpenAPI generation. Fastify rather than Express for throughput and native schema handling.

**Prisma rather than Drizzle or raw SQL.**
The decisive factor is migration tooling: reproducible, ordered, checked-in migrations with a shadow-database drift check. Drizzle is lighter and closer to SQL, and would be the right call if this were a high-write analytical workload. It is not. Where Prisma's query planner is a poor fit (analytics roll-ups, recurrence window queries), those go through raw parameterised SQL behind a repository method.

**pg-boss rather than Redis + BullMQ.**
The event dispatcher, the recurrence materialiser and the notification scheduler all need a durable job queue. pg-boss puts that queue in PostgreSQL, which means one datastore to run, back up and pay for, and it lets a job and the row it acts on share a transaction. BullMQ is faster and has better tooling, and is the documented migration target if throughput ever justifies a second datastore. For a single-user-scale product it does not.

**Zod contracts in a shared package rather than hand-written types on each side.**
One definition of `CreateActivityRequest` is used by the API for runtime validation, by the OpenAPI generator for documentation, and by both frontends for compile-time types. Drift between client and server becomes a type error rather than a production bug.

---

## 4. Repository layout

```
daybook/
├── apps/
│   ├── daybook/            Next.js: planner, timeline, habits, journal, analytics
│   ├── fitness/            Next.js: exercise library, routines, live workout, PRs
│   ├── api/                NestJS: REST API, auth, domain services
│   └── worker/             pg-boss consumers: event dispatch, materialiser, notifications
├── packages/
│   ├── domain/             Pure TypeScript business logic, zero framework imports
│   ├── contracts/          Zod schemas, DTO types, event schemas, generated client
│   ├── db/                 Prisma schema, migrations, seed, generated client
│   ├── ui/                 Design tokens, primitives, charts, shared by both apps
│   └── config/             eslint, tsconfig, tailwind preset, vitest base config
├── docs/                   This documentation set
├── infra/                  Dockerfiles, compose, GitHub Actions, deploy config
└── e2e/                    Playwright suites spanning both apps
```

### 4.1 The `domain` package is the important one

Recurrence expansion, productivity scoring, streak calculation, planned-versus-actual deltas, personal-record detection and volume maths live in `packages/domain` as pure functions over plain data. They import nothing from Nest, Next, Prisma or the browser.

This matters for three reasons. It keeps one implementation of each rule instead of a server copy and a client copy that drift. It makes the highest-risk logic (recurrence across daylight-saving boundaries, score renormalisation) testable in milliseconds without a database. And it lets the frontend compute an optimistic score offline using exactly the code the server will use when it reconnects.

Dependency rule, enforced in CI by an import-boundary lint rule:

```
apps/*  →  packages/contracts, packages/ui, packages/domain
apps/api, apps/worker  →  packages/db
packages/domain  →  nothing
packages/db  →  nothing but Prisma
```

---

## 5. Authentication architecture

### 5.1 Decided: the API owns identity (D8, 2026-08-29)

The original brief said "self-hosted Auth.js + PostgreSQL". After review the decision is to keep every property that phrase was reaching for, self-hosted, own PostgreSQL, no vendor, no cost, and move session ownership into the API. The reasoning is recorded here because it affects security and the shape of the API.

Auth.js is coupled to the Next.js request lifecycle. It would place session ownership inside one frontend, which means either the Fitness app trusts the Daybook app as its identity provider (Daybook becomes a runtime dependency of Fitness), or each app runs its own Auth.js instance (two session systems, two sets of cookies, no single logout).

The decisive constraint is narrower and harder. Auth.js's Credentials provider only supports the JWT session strategy; database sessions are not available with it. No server-side session row means nothing to revoke: no sign-out-everywhere, no actionable device list, no refresh-token reuse detection, and a password change that leaves other sessions live. Auth.js also does not hash passwords, register users, or run reset and verification flows, so most of that code is written either way.

The accepted cost is that this auth layer is written rather than imported. Phase 3's exit criteria and the Phase 14 audit exist to contain it.

### 5.2 The recommended model

**Password storage:** Argon2id, memory 64 MiB, time cost 3, parallelism 1. Never MD5, SHA or bcrypt.

**Access token:** JWT, 10 minute lifetime, signed EdDSA (Ed25519), held in memory by the client only, never in `localStorage`. Claims: `sub`, `sid`, `iat`, `exp`, `aud` (`daybook` or `fitness`), `scope`.

**Refresh token:** 256 bits of CSPRNG randomness, stored in PostgreSQL as a SHA-256 hash, delivered as a cookie that is `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/v1/auth`, and scoped to the parent domain (`.daybook.app`) so `app.daybook.app` and `fit.daybook.app` share one session. 30 day sliding lifetime.

**Rotation and reuse detection:** every refresh issues a new token and revokes the old one. Tokens belong to a `family_id`. If a token that has already been rotated is presented again, that is the signature of a stolen cookie: the entire family is revoked immediately and the user is signed out of both apps. This is the single highest-value control in the auth design.

**CSRF:** the refresh and logout endpoints are `POST` only, require a custom header (`X-Daybook-Client`) that a cross-site form cannot set, and validate the `Origin` header against an allowlist. All other endpoints are bearer-token authenticated and therefore not cookie-driven.

**Single sign-on across the two apps:** with path-based routing (decision D4), both apps share one origin, so a single origin-scoped refresh cookie covers both and `SameSite` tightens from `Lax` to `Strict`. Opening Fitness after signing in to Daybook silently refreshes into a Fitness-audience access token. Logout revokes the family, which ends both sessions. If the apps later move to subdomains, the cookie gains a parent-domain scope and `SameSite` returns to `Lax`: a configuration change, not a redesign.

**Google sign-in** is built in Phase 3 alongside password login, not deferred. The API is the OAuth client: Authorization Code flow with PKCE, plus `state` and `nonce` validation, with the redirect URI pointing at the API rather than at either frontend. A verified Google login ends in exactly the same place a password login does, an `auth_sessions` row, so a Google session is revocable, appears in the device list, and carries the same reuse detection.

Identities are stored in `auth_identities` (see DATABASE.md), matched on the provider's subject id rather than on email, with the linking rule and unlink guard documented there. Building this in Phase 3 rather than later is deliberate: retrofitting account linking onto live accounts is materially harder than designing the table in from the start.

Apple sign-in is the same shape and waits until a native client needs it.

**Defence in depth at the database:** see §6.

---

## 6. Data access and tenant isolation

Every user-owned table carries a `user_id` column, including tables reachable only through a parent (for example `workout_sets`). This is deliberate denormalisation. It buys two things: queries never need a three-table join just to prove ownership, and PostgreSQL row-level security can be switched on uniformly.

RLS is enabled on all user-owned tables with a policy of `user_id = current_setting('app.current_user_id')::uuid`. The API sets that setting at the start of each request transaction. Application-level authorisation checks stay in place; RLS exists so that a missing `where user_id = ?` in one repository method returns zero rows instead of another user's data.

Soft delete via `deleted_at timestamptz` on user content, with partial unique indexes written as `where deleted_at is null`. Account deletion (§28 of the brief) is a genuine hard delete executed by a background job, cascading through every table, with an exported archive offered first.

---

## 7. Runtime topology

```
┌──────────────────┐        ┌──────────────────┐
│  Daybook PWA     │        │  Fitness PWA     │
│  Next.js         │        │  Next.js         │
│  service worker  │        │  service worker  │
│  IndexedDB queue │        │  IndexedDB queue │
└────────┬─────────┘        └─────────┬────────┘
         │  HTTPS, bearer access token          │
         └───────────────┬──────────────────────┘
                         ▼
              ┌──────────────────────┐
              │   API (NestJS)       │
              │  auth · activities   │
              │  habits · journal    │
              │  workouts · analytics│
              └──────────┬───────────┘
                         │ same transaction
                         ▼
              ┌──────────────────────┐
              │   PostgreSQL 16      │
              │  domain tables       │
              │  domain_events       │  ← transactional outbox
              │  pg-boss job tables  │
              └──────────┬───────────┘
                         │ polled / notified
                         ▼
              ┌──────────────────────┐
              │   Worker             │
              │  event dispatcher    │
              │  recurrence job      │
              │  summary roll-ups    │
              │  notification sender │
              └──────────────────────┘
```

The worker is a separate process from the API, sharing the same code packages. It scales and fails independently, so a stuck sync job cannot slow down the request path.

---

## 8. Frontend architecture

**Rendering:** React Server Components for shells and static structure, client components for anything interactive or time-aware. The timeline, the current-activity card and the live workout screen are client-side, because they re-render against the clock and must work offline.

**State:** TanStack Query owns server state, with optimistic updates on every status change. A small Zustand store owns genuinely local state (the live workout timer, unsent journal drafts). No global Redux-shaped store.

**Time handling:** the user's IANA timezone from their profile is the single source of truth, never the browser's. All timestamps cross the wire as UTC ISO-8601; all display and all "which day is this" decisions go through one `dayKey(instant, tz)` helper in `packages/domain`. This rule exists because timezone bugs in a planner are silent and corrupt history.

**Offline:** a service worker caches the app shell and the current day plus the surrounding week. Writes go into an IndexedDB outbox keyed by a client-generated UUID and replay on reconnect. Offline writes are limited on purpose to activity status changes, habit ticks, workout set logging and journal text. Recurrence edits, routine edits and account changes require connectivity, because merging those offline is complexity without payoff.

**Accessibility:** WCAG 2.2 AA as a build gate, not a polish item. Contrast checked in CI with axe, full keyboard operability on the timeline and workout logger, focus management on dialogs, `prefers-reduced-motion` respected.

---

## 9. Design direction

The interface should read as a calm daily instrument rather than an analytics console. Concretely, that means: one accent colour and a neutral ramp rather than gradients; type at 16px minimum with a clear three-level hierarchy; generous vertical rhythm on the timeline so the current activity is obvious at a glance from arm's length; state carried by shape and label as well as colour, so completion is legible without relying on green; charts limited to what answers a question the user actually asked. Dark and light themes are both first-class, defined as design tokens in `packages/ui`, not as a stylesheet override.

---

## 10. Deployment and environments

| Environment | Web | API + worker | Database |
|---|---|---|---|
| Local | `pnpm dev` | `pnpm dev` | Docker Postgres, or local instance |
| Preview | Vercel preview per PR | Fly.io preview app, `lhr` | Neon branch per PR |
| Production | Vercel | Fly.io `lhr` (London), 2 machines minimum | Neon `aws-eu-west-2` (London), PITR enabled |

Region is London throughout (decision D6). Neon has no African region, and London is the nearest available with good subsea routing from West Africa, as well as the obviously right choice if the product owner ends up UK-based. A Neon project's region is fixed at creation: changing it later means creating a new project and migrating, so this is worth getting right now rather than later.

Container images are built for the API and worker so the whole stack stays portable to a single VPS if hosting economics change. Docker Compose covers local development.

**Secrets:** `.env.example` is committed with every variable documented and no values. Real values live in platform environment configuration. A `gitleaks` scan runs in CI on every push.

**Observability:** structured JSON logs (Pino) with a request-scoped correlation ID that follows an event from HTTP request through outbox row to worker handler. Redaction list covers passwords, tokens, cookies and email addresses. Sentry for errors, OpenTelemetry traces on API and worker, and health endpoints at `/healthz` (liveness) and `/readyz` (database and queue reachability).

**Backups:** managed point-in-time recovery on the database, plus a weekly logical dump to object storage. A restore is rehearsed once before production launch, because an unrehearsed backup is a hope, not a backup.

---

## 11. Security controls summary

| Control | Implementation |
|---|---|
| Password hashing | Argon2id, tuned parameters |
| Session theft detection | Refresh token family revocation on reuse |
| Transport | HTTPS only, HSTS with preload |
| Headers | CSP with nonces, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` |
| Input validation | Zod at every API boundary, reject unknown keys |
| SQL injection | Parameterised queries only, via Prisma or tagged raw SQL |
| XSS | React escaping by default, no `dangerouslySetInnerHTML`, journal text sanitised on render |
| CSRF | `SameSite=Lax` + custom header + origin check on cookie endpoints |
| Authorisation | Guard per route, plus PostgreSQL RLS as a second layer |
| Rate limiting | Per IP and per user, strict on auth endpoints, sliding window in Postgres |
| Enumeration | Login and password reset return identical responses and timing whether or not the account exists |
| Secrets | Environment variables only, `gitleaks` in CI, no secrets in logs |
| Dependencies | Dependabot, `pnpm audit` gate in CI |

---

## 12. Decisions

All Phase 1 decisions are closed. See the decisions log in ROADMAP.md §5: platform, auth hosting, delivery, routing, notifications, hosting region, version control, and session ownership.

Two items are scheduled rather than open. A domain name is needed at Phase 16, and whether to add a native client is revisited after the product has been in daily use for a month.
