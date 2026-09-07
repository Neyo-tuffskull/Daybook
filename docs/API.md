# Daybook Ecosystem: API Contract

**Status:** Phase 1 proposal
**Base URL:** `https://api.daybook.app/v1`
**Style:** REST over JSON, OpenAPI 3.1 generated from the Zod contracts in `packages/contracts`

---

## 1. Conventions

**Versioning.** The version sits in the path (`/v1`). Additive changes ship inside v1; anything that breaks a client gets `/v2` with v1 supported for a deprecation window announced through a `Sunset` header.

**Authentication.** Every endpoint except those under `/auth` requires `Authorization: Bearer <access_token>`. Access tokens last 10 minutes. Refresh happens against `/auth/refresh` using the `HttpOnly` cookie described in ARCHITECTURE.md §5.

**Client identification.** All requests send `X-Daybook-Client: daybook|fitness` and `X-Client-Version`. The header is required on cookie-bearing endpoints as a CSRF control, and elsewhere it feeds logging and per-client rate limits.

**Idempotency.** Any `POST` that creates something meaningful accepts an `Idempotency-Key` header. The key plus the user id plus the route is stored for 24 hours; a repeat returns the original response with `Idempotency-Replayed: true`. This is mandatory on workout completion and offline replay.

**Dates and times.** Instants are UTC ISO-8601 with an offset (`2026-08-28T17:05:00Z`). Logical days are plain `YYYY-MM-DD` and are interpreted in the user's profile timezone. The two are never mixed in one field.

**Pagination.** Cursor based: `?limit=50&cursor=<opaque>`. Responses carry `{ data: [...], next_cursor: string | null }`. Offset pagination is not offered, because analytics ranges are date-bounded instead.

**Partial updates** use `PATCH` with only the fields being changed. Unknown keys are rejected rather than ignored, so a typo fails loudly.

**Concurrency.** Mutable resources return an `ETag`. `PATCH` and `DELETE` accept `If-Match`; a mismatch returns `409` with the current representation, which is how the offline queue detects a conflict.

### 1.1 Error format

Every error, without exception, is shaped like this:

```json
{
  "error": {
    "code": "activity_not_found",
    "message": "No activity with that id belongs to this account.",
    "details": [{ "field": "occurrence_date", "issue": "must be a valid ISO date" }],
    "request_id": "01J9F2K4T6..."
  }
}
```

`message` is safe to show a user. Stack traces, SQL and internal identifiers never reach the client. `request_id` is the correlation id that also appears in the logs.

| Status | Used for                                                                                |
| ------ | --------------------------------------------------------------------------------------- |
| 400    | malformed request                                                                       |
| 401    | missing or expired access token                                                         |
| 403    | authenticated but not permitted                                                         |
| 404    | not found, or found but not owned by this user (deliberately indistinguishable)         |
| 409    | version conflict, or a state transition that is not legal                               |
| 422    | well-formed but semantically invalid (for example `planned_end` before `planned_start`) |
| 429    | rate limited, with `Retry-After`                                                        |
| 500    | unexpected, logged with the request id                                                  |

### 1.2 Rate limits

Per caller, in two budgets with separate counters, so ordinary API traffic
cannot consume the sign-in allowance.

| Scope                                   | Limit                                               | State            |
| --------------------------------------- | --------------------------------------------------- | ---------------- |
| Every non-`GET` route under `/auth`     | `AUTH_RATE_LIMIT_PER_MINUTE`, 10 by default, per IP | **built**        |
| Everything else                         | 300 per minute per IP                               | **built**        |
| `/healthz`, `/readyz`                   | exempt                                              | **built**        |
| Per-email and per-session-family limits |                                                     | Phase 14         |
| Analytics and export limits             |                                                     | Phases 10 and 13 |

Counters live in memory, which makes the limit per instance. That is correct
for one instance and wrong for several; it moves to Redis when the API is
actually scaled out. Decision D12.

The IP is hashed before it becomes a counter key, so the store is not a list of
who used the API today.

---

## 2. Authentication

| Method | Path                        | Purpose                                                        | State     |
| ------ | --------------------------- | -------------------------------------------------------------- | --------- |
| POST   | `/auth/register`            | create account, sign in, send verification link                | **built** |
| POST   | `/auth/login`               | issue access token, set refresh cookie                         | **built** |
| POST   | `/auth/refresh`             | rotate refresh token, issue new access token                   | **built** |
| POST   | `/auth/logout`              | end this session, or every session with `{"everywhere": true}` | **built** |
| GET    | `/auth/sessions`            | list live sessions, marking the current one                    | **built** |
| POST   | `/auth/verify-email`        | consume a verification token                                   | **built** |
| POST   | `/auth/verify-email/resend` | issue a fresh link, invalidating the previous one              | **built** |
| POST   | `/auth/password/forgot`     | always 202, whether or not the address exists                  | **built** |
| POST   | `/auth/password/reset`      | consume token, set password, end every session                 | **built** |
| POST   | `/auth/password/change`     | signed in, requires the current password                       | **built** |
| GET    | `/auth/google`              | begin OIDC, Authorization Code with PKCE                       | **built** |
| GET    | `/auth/google/callback`     | complete OIDC, link or create the account                      | **built** |
| DELETE | `/auth/sessions/:id`        | end one named session from the device list                     | Phase 4   |

Sign-out everywhere is a flag on `/auth/logout` rather than a second endpoint,
because it is the same operation over a different set of rows, and two paths
that must stay in step is one more thing to get wrong.

`POST /auth/login` request and response:

```jsonc
// request
{ "email": "user@example.com", "password": "...", "client": "daybook" }

// 200
{
  "access_token": "eyJ...",
  "token_type": "Bearer",
  "expires_in": 600,
  "user": {
    "id": "...",
    "email": "...",
    "email_verified": false,
    "display_name": "Ore",
    "timezone": "Africa/Lagos"
  }
}
// plus Set-Cookie: db_rt=<opaque>; HttpOnly; Secure; SameSite=Lax; Path=/v1/auth
```

The refresh token never appears in a response body. It is an `HttpOnly` cookie
scoped to `/v1/auth`, so it rides on the three endpoints that need it rather
than on every request the app makes for the next thirty days, and a
cross-site script that steals the access token gets ten minutes rather than a
month.

`POST /auth/refresh` takes no body. It deliberately does not accept a `client`:
a refresh continues a session that already knows which app started it, and
accepting one would let a caller relabel a session in somebody else's device
list. This is also how one sign-in covers both apps. Both frontends call the
same API origin, so opening Fitness after signing in to Daybook is a refresh,
not a second login.

**What each failure says.** Login answers identically whether the address is
unknown, the password is wrong, or the account is suspended, and takes the same
time in all three cases: an unknown address is still verified against a decoy
hash. Refresh answers identically whether the token is unknown, expired,
revoked, or has been detected as reused, because telling an attacker their
theft was noticed helps only them. Registration is the exception and says when
an address is taken; decision D11 explains why.

**Refresh token reuse.** Presenting a token that has already been rotated
revokes the entire family, which is every token in that chain of rotations
back to the sign-in that started it. Both the legitimate user and whoever else
has a copy must sign in again. That is the correct trade: signing in again
costs a moment, and leaving a thief with a live session does not.

### 2.1 Google sign-in

`GET /auth/google` redirects to Google. `?client=fitness` marks the resulting
session as belonging to the Fitness app; anything else means Daybook.

`GET /auth/google/callback` is the redirect URI registered with Google. It
answers with a redirect and never a body:

| Outcome       | Redirect                                                |
| ------------- | ------------------------------------------------------- |
| Signed in     | `APP_PUBLIC_URL/auth/callback`, plus the refresh cookie |
| Anything else | `APP_PUBLIC_URL/sign-in?error=<code>`                   |

The error codes are `cancelled`, `expired`, `invalid_state`, `provider_error`,
`unverified_email` and `account_unavailable`. They are codes rather than
sentences because this URL lands in browser history, and the detail belongs in
the logs.

**The callback returns no token.** It sets the refresh cookie and redirects, and
the app then calls `/auth/refresh` like any other page load. Putting an access
token in the redirect would be simpler and would write a credential into the
browser history, the referrer of whatever the page loads next, and any proxy log
in between.

**The API is the OAuth client, not the frontend.** A browser cannot keep a
client secret, so the code exchange happens server to server and the redirect
URI points at the API.

**Account linking.** The lookup is on Google's subject id, never on the email
address: a subject id is stable and belongs to the provider, while an address
can be changed, released and re-registered by somebody else. An unknown subject
is attached to an existing account **only** when Google asserts
`email_verified`. That assertion is the same assurance our own verification link
provides, and without it, registering somebody else's address at a provider that
does not check would be account takeover in two steps. A refusal is not a dead
end: the person can sign in with their password and link the account
deliberately from settings, which is a Phase 13 screen.

An account created through Google has no password. Its owner can set one with
the ordinary password-reset flow, which proves control of the address.

**Not configured is not the same as not built.** With no
`GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`, both routes answer
503 rather than 404.

---

## 3. Profile and preferences

| Method | Path                | Purpose                                                  | State     |
| ------ | ------------------- | -------------------------------------------------------- | --------- |
| GET    | `/me`               | the signed-in person's account and profile               | **built** |
| PATCH  | `/me`               | display name, timezone, locale, week start, units, theme | **built** |
| GET    | `/me/preferences`   | score weights, analytics start of day                    | Phase 10  |
| PATCH  | `/me/preferences`   |                                                          | Phase 10  |
| PATCH  | `/me/notifications` | reminder toggles, lead times, quiet hours                | Phase 11  |
| POST   | `/me/avatar`        | signed upload                                            | Phase 13  |
| POST   | `/me/export`        | request a JSON or CSV export, returns a job id           | Phase 13  |
| GET    | `/me/export/:id`    | status, then a short-lived download URL                  | Phase 13  |
| DELETE | `/me`               | schedule deletion, requires the password, 7 day grace    | Phase 13  |

No endpoint here takes a user id. It comes from the verified access token, and
the queries run under row-level security as that user, so there is no request
that reaches another person's row: not a missing `WHERE` clause, not an id in a
path, not an extra field in a body. The request schemas are strict, so a body
carrying `user_id` is rejected with 422 rather than ignored.

`PATCH /me` distinguishes an absent field from an explicit `null`. Omitting
`display_name` leaves it alone; sending `"display_name": null` clears it.

---

## 4. Daybook: categories, series, activities

### Categories

`GET /categories`, `POST /categories`, `PATCH /categories/:id`, `DELETE /categories/:id`.
Deleting a category reassigns its activities to Uncategorised rather than cascading.

### Recurring series

| Method | Path                   | Purpose                              |
| ------ | ---------------------- | ------------------------------------ |
| GET    | `/activity-series`     | list, `?active=true`                 |
| POST   | `/activity-series`     | create and materialise the horizon   |
| GET    | `/activity-series/:id` | detail, plus the next 10 occurrences |
| PATCH  | `/activity-series/:id` | requires a `scope` (see below)       |
| DELETE | `/activity-series/:id` | requires a `scope`                   |

`POST /activity-series`:

```jsonc
{
  "title": "Gym",
  "category_id": "...",
  "priority": 3,
  "rrule": "FREQ=WEEKLY;BYDAY=MO,WE,TH,SA",
  "start_date": "2026-09-01",
  "end_date": null,
  "start_time": "18:00",
  "duration_minutes": 90,
  "reminder_lead_minutes": 15,
}
```

**Edit scope** is the part most planner APIs get wrong, so it is explicit here. `PATCH` and `DELETE` on a series require `?scope=` one of:

- `occurrence`: applies to one date only. The occurrence row is edited and flagged `is_detached`, and a `series_exceptions` row is written so re-materialisation leaves it alone.
- `future`: the existing series gets `end_date` set to the day before, and a new series is created from that date with the new values. History is preserved exactly as it was lived.
- `all`: the series is updated and every future occurrence that is not detached is re-materialised. Past occurrences are never rewritten.

### Activities (occurrences)

| Method | Path                          | Purpose                                                                        |
| ------ | ----------------------------- | ------------------------------------------------------------------------------ |
| GET    | `/activities?date=2026-08-28` | the day timeline                                                               |
| GET    | `/activities?from=&to=`       | range, for week and month views                                                |
| GET    | `/activities/current`         | the activity whose planned window contains now, plus next and previous         |
| POST   | `/activities`                 | one-off activity                                                               |
| GET    | `/activities/:id`             | detail with status history                                                     |
| PATCH  | `/activities/:id`             | edit fields, move, resize                                                      |
| DELETE | `/activities/:id`             | soft delete                                                                    |
| POST   | `/activities/:id/start`       | status → `active`, stamps `actual_start`                                       |
| POST   | `/activities/:id/pause`       | accumulates elapsed time                                                       |
| POST   | `/activities/:id/resume`      |                                                                                |
| POST   | `/activities/:id/complete`    | body may carry `completion_ratio`, `actual_end`, `notes`                       |
| POST   | `/activities/:id/skip`        | body may carry a reason                                                        |
| POST   | `/activities/:id/reschedule`  | body carries the new `planned_start`                                           |
| POST   | `/activities/bulk-status`     | for the offline queue: an array of status transitions with client mutation ids |

Legal transitions are enforced server-side. `planned → active → completed` is legal; `completed → active` is not, and returns 409. `missed` is applied by a background job, never by the client, once an activity's planned window has fully passed with no interaction.

`GET /activities/current` response:

```jsonc
{
  "current": {
    "id": "...",
    "title": "Project Work",
    "status": "active",
    "planned_start": "2026-08-28T13:00:00Z",
    "planned_end": "2026-08-28T15:00:00Z",
    "actual_start": "2026-08-28T13:07:00Z",
    "elapsed_minutes": 46,
  },
  "next": { "id": "...", "title": "Gym", "planned_start": "2026-08-28T17:00:00Z" },
  "previous": { "id": "...", "title": "Lunch", "status": "completed" },
  "server_time": "2026-08-28T13:53:00Z",
}
```

`server_time` is returned so the client can correct for device clock skew rather than trusting it.

---

## 5. Habits and journal

| Method | Path                         | Purpose                                                   |
| ------ | ---------------------------- | --------------------------------------------------------- |
| GET    | `/habits`                    | list with today's log state and current streak            |
| POST   | `/habits`                    |                                                           |
| PATCH  | `/habits/:id`                |                                                           |
| DELETE | `/habits/:id`                | archives rather than destroying history                   |
| GET    | `/habits/:id/logs?from=&to=` | for the heatmap                                           |
| PUT    | `/habits/:id/logs/:date`     | upsert a day, idempotent by construction                  |
| DELETE | `/habits/:id/logs/:date`     | clear a day                                               |
| GET    | `/habits/:id/stats`          | current streak, longest streak, 30/90 day completion rate |

| Method | Path                     | Purpose                                |
| ------ | ------------------------ | -------------------------------------- |
| GET    | `/journal?from=&to=`     | list                                   |
| GET    | `/journal/:date`         | one day                                |
| PUT    | `/journal/:date`         | upsert                                 |
| DELETE | `/journal/:date`         |                                        |
| GET    | `/journal/:date/summary` | the generated end-of-day summary block |

`PUT` on a dated resource rather than `POST` is deliberate: it makes habit ticks and journal saves naturally idempotent, which is what the offline queue needs.

---

## 6. Fitness

### Exercise library

`GET /exercises?search=&modality=&muscle=`, `POST /exercises`, `PATCH /exercises/:id`, `DELETE /exercises/:id`.
System rows are read-only; editing one creates a user-owned copy.

### Routines

| Method | Path                      | Purpose                                                   |
| ------ | ------------------------- | --------------------------------------------------------- |
| GET    | `/routines`               |                                                           |
| POST   | `/routines`               | nested `exercises[]` accepted in one call                 |
| GET    | `/routines/:id`           |                                                           |
| PATCH  | `/routines/:id`           |                                                           |
| POST   | `/routines/:id/duplicate` |                                                           |
| DELETE | `/routines/:id`           | archives                                                  |
| POST   | `/routines/:id/schedule`  | creates an `activity_series` in Daybook from this routine |

`POST /routines/:id/schedule` is the reverse direction of the integration: planning a workout from the Fitness side writes the Daybook series and pre-links it, so the eventual completion event matches by explicit link rather than heuristics.

### Workout sessions

| Method | Path                                  | Purpose                                                                                   |
| ------ | ------------------------------------- | ----------------------------------------------------------------------------------------- |
| POST   | `/workouts`                           | start a session. Accepts `routine_id`, `activity_id`, `client_session_uuid`, `started_at` |
| GET    | `/workouts?from=&to=`                 | history                                                                                   |
| GET    | `/workouts/active`                    | the in-progress session, for resuming after a refresh                                     |
| GET    | `/workouts/:id`                       | full session with exercises and sets                                                      |
| PATCH  | `/workouts/:id`                       | notes, name                                                                               |
| POST   | `/workouts/:id/exercises`             | add an exercise mid-session                                                               |
| PUT    | `/workouts/:id/sets/:client_set_uuid` | upsert a set, idempotent, the offline-friendly write                                      |
| DELETE | `/workouts/:id/sets/:set_id`          |                                                                                           |
| POST   | `/workouts/:id/complete`              | finalise, compute totals, detect PRs, emit `WORKOUT_COMPLETED`                            |
| POST   | `/workouts/:id/abandon`               |                                                                                           |
| DELETE | `/workouts/:id`                       | soft delete, emits a compensating event                                                   |

`POST /workouts/:id/complete` response:

```jsonc
{
  "workout": {
    "id": "...",
    "status": "completed",
    "started_at": "2026-08-28T17:05:00Z",
    "ended_at": "2026-08-28T18:12:00Z",
    "duration_seconds": 4020,
    "total_sets": 15,
    "total_reps": 168,
    "total_volume_kg": 8420.5,
  },
  "personal_records": [
    { "exercise": "Bench Press", "metric": "max_weight", "value": 85, "previous_value": 82.5 },
  ],
  "daybook_link": { "activity_id": "...", "sync_status": "queued" },
}
```

`sync_status` is `queued` rather than `done` because the projection is asynchronous. The client polls `/activities/:id` or receives the update over the realtime channel. Claiming synchronous success here would be a lie the UI would eventually contradict.

### Personal records

`GET /personal-records?exercise_id=&metric=`, `GET /exercises/:id/history` (chart-ready series of best set per session).

---

## 7. Analytics

| Method | Path                                                  | Purpose                                                                             |
| ------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| GET    | `/analytics/daily?date=`                              | completion, counts, productive minutes, score with full breakdown                   |
| GET    | `/analytics/weekly?week_start=`                       | daily series, average completion, best and worst day, habit and workout consistency |
| GET    | `/analytics/monthly?month=2026-08`                    | trend, streaks, workout frequency, most-missed activities                           |
| GET    | `/analytics/planned-vs-actual?from=&to=&category_id=` | deviation distribution per series or category                                       |
| GET    | `/analytics/habits?from=&to=`                         | heatmap and streak data                                                             |
| GET    | `/analytics/workouts?from=&to=`                       | frequency, volume trend, muscle-group distribution                                  |

`GET /analytics/daily` returns the score with its components exposed:

```jsonc
{
  "date": "2026-08-28",
  "completion_pct": 78.6,
  "counts": { "planned": 14, "completed": 11, "partial": 0, "skipped": 1, "missed": 2 },
  "productive_minutes": 412,
  "productivity_score": 81.5,
  "score_breakdown": [
    {
      "component": "schedule",
      "raw": 0.83,
      "weight": 0.35,
      "contribution": 29.1,
      "eligible": true,
    },
    { "component": "habits", "raw": 0.8, "weight": 0.25, "contribution": 20.0, "eligible": true },
    { "component": "workout", "raw": 1.0, "weight": 0.2, "contribution": 20.0, "eligible": true },
    {
      "component": "timeliness",
      "raw": 0.62,
      "weight": 0.2,
      "contribution": 12.4,
      "eligible": true,
    },
  ],
}
```

Analytics reads come from `daily_summaries` where possible, falling back to live computation for the current day. A `Cache-Control: private, max-age=60` header on historical ranges keeps repeated dashboard loads cheap.

---

## 8. Events and realtime

| Method | Path                           | Purpose                                                   |
| ------ | ------------------------------ | --------------------------------------------------------- |
| POST   | `/events`                      | ingest an event from a client, requires `Idempotency-Key` |
| GET    | `/events?from=&type=`          | the user's own event history, for debugging and export    |
| GET    | `/events/stream`               | Server-Sent Events channel for live cross-app updates     |
| GET    | `/sync/changes?since=<cursor>` | delta pull for offline reconciliation                     |
| POST   | `/sync/mutations`              | batch replay of the offline queue                         |

`/events/stream` is SSE rather than WebSockets: the traffic is one-directional server-to-client, SSE reconnects automatically, and it survives proxies that mishandle upgrades. It is how the Daybook tab updates the moment a workout finishes in the Fitness tab.

---

## 9. Documentation and testing of the contract

- OpenAPI 3.1 is generated from the Zod schemas at build time and published at `/v1/openapi.json`, with a Scalar reference UI at `/v1/docs`.
- The typed client in `packages/contracts` is generated from the same source, so a frontend calling a renamed field fails to compile.
- Contract tests assert that every documented endpoint exists, requires the documented auth, and returns the documented error shape on a deliberately malformed request.
- Every endpoint has an authorisation test that asserts user B receives 404 for user A's resource.
