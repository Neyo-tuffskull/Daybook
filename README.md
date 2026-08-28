# Daybook

A personal planning and performance system: a daily planner that knows what you meant to do, a fitness tracker that knows what you actually lifted, and an event pipeline that makes the second one update the first without you typing anything twice.

**Plan → Execute → Log → Analyse → Improve.**

---

## Current state

**Phase 1 (architecture) is complete and awaiting sign-off. No application code exists yet.** This repository currently contains the design documentation set. Implementation begins at Phase 2 once the open decisions are closed.

## Documentation

| Document | What it covers |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Technology stack and the reasoning behind each choice, monorepo layout, authentication design, runtime topology, deployment, security controls, open decisions |
| [docs/DATABASE.md](docs/DATABASE.md) | The full PostgreSQL schema, the ERD, every table with keys, indexes and constraints, row-level security, soft delete, migration strategy |
| [docs/API.md](docs/API.md) | The complete REST contract, error format, rate limits, idempotency and concurrency rules, sample payloads |
| [docs/SYNC.md](docs/SYNC.md) | The Fitness to Daybook event pipeline: transactional outbox, event catalogue, activity matching rules, idempotency layers, retries, conflict policy, offline replay |
| [docs/SCORING.md](docs/SCORING.md) | The productivity score formula in full, with worked examples, and the rules governing planned-versus-actual analysis |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phase state, exit criteria per phase, risk register, open decisions |

Start with ARCHITECTURE.md. Read SYNC.md next: it is the part of the system everything else exists to support.

## The shape of it

Two Next.js progressive web apps, Daybook and Fitness, over one NestJS API, one PostgreSQL database and one background worker. Shared identity, shared design system, shared business logic in a framework-free `domain` package. Workout completion writes a domain event in the same transaction as the workout itself; the worker projects that event onto the matching Daybook activity, idempotently, with retries.

## Open decisions

Five, listed in [docs/ROADMAP.md](docs/ROADMAP.md) §5. They gate Phase 2.
