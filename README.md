# Daybook

A personal planning and performance system: a daily planner that knows what you meant to do, a fitness tracker that knows what you actually lifted, and an event pipeline that makes the second one update the first without you typing anything twice.

**Plan → Execute → Log → Analyse → Improve.**

---

## Current state

**Phase 1 complete and signed off. Phase 2 partially complete.**

The database and the shared business logic are built and verified against a live PostgreSQL 16: schema, row-level security, 15 schema assertions, 30 domain unit tests. The workspace, API, worker and both frontends are scaffolded but unverified, because the build environment had no access to the npm registry. [docs/SETUP.md](docs/SETUP.md) section 5 has the exact split between what was proved and what was only written.

Getting started: [docs/SETUP.md](docs/SETUP.md).

## Documentation

| Document | What it covers |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Technology stack and the reasoning behind each choice, monorepo layout, authentication design, runtime topology, deployment, security controls |
| [docs/DATABASE.md](docs/DATABASE.md) | The full PostgreSQL schema, the ERD, every table with keys, indexes and constraints, row-level security, soft delete, migration strategy |
| [docs/API.md](docs/API.md) | The complete REST contract, error format, rate limits, idempotency and concurrency rules, sample payloads |
| [docs/SYNC.md](docs/SYNC.md) | The Fitness to Daybook event pipeline: transactional outbox, event catalogue, activity matching rules, idempotency layers, retries, conflict policy, offline replay |
| [docs/SCORING.md](docs/SCORING.md) | The productivity score formula in full, with worked examples, and the rules governing planned-versus-actual analysis |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phase state, exit criteria per phase, risk register, decisions log |
| [docs/SETUP.md](docs/SETUP.md) | Prerequisites, first run, environment variables, what is and is not verified, troubleshooting |

Start with ARCHITECTURE.md. Read SYNC.md next: it is the part of the system everything else exists to support.

## The shape of it

Two Next.js progressive web apps, Daybook and Fitness, over one NestJS API, one PostgreSQL database and one background worker. Shared identity, shared design system, shared business logic in a framework-free `domain` package. Workout completion writes a domain event in the same transaction as the workout itself; the worker projects that event onto the matching Daybook activity, idempotently, with retries.

## Layout

```
apps/       daybook · fitness · api · worker
packages/   domain · contracts · db · ui · config
docs/       the documentation set above
e2e/        Playwright, desktop and mobile
```

`packages/domain` is the one to understand first. Recurrence, scoring, streaks and planned-versus-actual live there as pure functions with no framework imports, enforced by a lint rule. That boundary is what lets the same scoring code run on the server and in an offline browser without the two drifting apart. It also has no dependencies, so its tests run before `pnpm install` finishes:

```bash
cd packages/domain && node --experimental-strip-types --test 'test/*.test.ts'
```

## Decisions

Eight, logged in [docs/ROADMAP.md](docs/ROADMAP.md) §5, including why the API owns identity rather than Auth.js and why migrations are hand-written SQL.
