/**
 * The wire contract, defined once.
 *
 * These schemas do three jobs from one definition: runtime validation at the
 * API boundary, TypeScript types for both frontends, and the OpenAPI document.
 * A frontend that sends a renamed field fails to compile rather than failing
 * in production.
 */
import { z } from 'zod';
import { ACTIVITY_STATUSES, type ActivityStatus } from '@daybook/domain';

export const uuid = z.string().uuid();
export const dayKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');
export const instant = z.string().datetime({ offset: true });

export const priority = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);

/**
 * The status vocabulary, derived rather than restated.
 *
 * This file used to spell the seven statuses out again and carry its own
 * `LEGAL_TRANSITIONS` table beside them. Two statements of one rule drift, and
 * these two did: the table here allowed `skipped -> planned` while a later
 * state machine in `@daybook/domain` made it terminal, and nothing failed,
 * because nothing imported this table. Both are now the same object.
 *
 * The cast is because `z.enum` wants a non-empty tuple and `ACTIVITY_STATUSES`
 * is a readonly array. Adding a status in the domain package adds it here.
 */
export const activityStatus = z.enum(
  ACTIVITY_STATUSES as unknown as [ActivityStatus, ...ActivityStatus[]],
);
export type { ActivityStatus };

/**
 * Which transitions are legal lives in `@daybook/domain`, next to the rest of
 * the rules that have nothing to do with HTTP: `transition`, `canTransition`,
 * `actionsFrom` and `IllegalTransitionError`. Both frontends and the API import
 * it from there, so the button a screen disables and the request the server
 * refuses are decided by the same table.
 */

// --- Errors ----------------------------------------------------------------

/** Every error the API returns has this shape. No exceptions, ever. */
export const apiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.array(z.object({ field: z.string().optional(), issue: z.string() })).optional(),
    request_id: z.string(),
  }),
});
export type ApiError = z.infer<typeof apiError>;

// --- Auth ------------------------------------------------------------------

/** Which of the two apps a session belongs to. Both share one identity. */
export const sessionClient = z.enum(['daybook', 'fitness']);
export type SessionClient = z.infer<typeof sessionClient>;

/**
 * Twelve characters, and no composition rules.
 *
 * Length beats character classes: "Tr0ub4dor&3" satisfies every upper, lower,
 * digit and symbol rule and is weaker than "correct horse battery staple".
 * Composition rules mostly teach people to put an exclamation mark on the end.
 * The upper bound exists because Argon2 hashes whatever it is given and a
 * megabyte-long password is a denial-of-service request, not a password.
 */
export const password = z.string().min(12).max(200);

export const registerRequest = z
  .object({
    email: z.string().email().max(320),
    password,
    display_name: z.string().min(1).max(80).optional(),
    timezone: z.string().min(1).max(64),
    client: sessionClient.default('daybook'),
  })
  .strict();

export const loginRequest = z
  .object({
    email: z.string().email().max(320),
    // Not `password`: rejecting a short password at login would tell an
    // attacker that short passwords exist, and would lock out any account
    // created before a future rule change.
    password: z.string().min(1).max(200),
    client: sessionClient.default('daybook'),
  })
  .strict();

/**
 * What a successful sign-in returns.
 *
 * The refresh token is deliberately absent: it goes back as an HttpOnly,
 * SameSite=Lax, Secure cookie that JavaScript cannot read, so a cross-site
 * script that steals the access token gets ten minutes rather than thirty days.
 * The short-lived access token is returned in the body because the client has
 * to attach it to an Authorization header.
 */
export const sessionResponse = z.object({
  access_token: z.string(),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive(),
  user: z.object({
    id: uuid,
    email: z.string().email(),
    email_verified: z.boolean(),
    display_name: z.string().nullable(),
    timezone: z.string(),
  }),
});
export type SessionResponse = z.infer<typeof sessionResponse>;

/**
 * Refresh takes no body at all: the cookie is the whole request.
 *
 * It deliberately does not accept a `client`. A refresh continues the session
 * that already exists, and that session already knows which app started it;
 * letting the caller restate it would let a client relabel somebody else's
 * session in the "signed in here" list. This is also why both apps share one
 * sign-in: the cookie is set on the API's origin, so opening Fitness after
 * signing in to Daybook is a refresh, not a second login.
 */
export const refreshRequest = z.object({}).strict();

export const logoutRequest = z
  .object({
    /** True ends every session on every device, not just this one. */
    everywhere: z.boolean().default(false),
  })
  .strict();

export const verifyEmailRequest = z.object({ token: z.string().min(16).max(200) }).strict();

export const requestPasswordResetRequest = z
  .object({ email: z.string().email().max(320) })
  .strict();

export const resetPasswordRequest = z
  .object({ token: z.string().min(16).max(200), password })
  .strict();

export const changePasswordRequest = z
  .object({ current_password: z.string().min(1).max(200), new_password: password })
  .strict();

/**
 * Endpoints that must not reveal whether an account exists.
 *
 * Registration, password reset requests and email verification all answer the
 * same way whether or not the address is on file. Anything else turns the form
 * into a tool for discovering who has an account here.
 */
export const acknowledgement = z.object({ status: z.literal('ok'), message: z.string() });

export const activeSession = z.object({
  id: uuid,
  client: sessionClient,
  issued_at: instant,
  expires_at: instant,
  current: z.boolean(),
});
export const activeSessionsResponse = z.object({ sessions: z.array(activeSession) });

// --- Profile ---------------------------------------------------------------

export const meResponse = z.object({
  id: uuid,
  email: z.string().email(),
  email_verified: z.boolean(),
  display_name: z.string().nullable(),
  avatar_url: z.string().nullable(),
  timezone: z.string(),
  locale: z.string(),
  week_start_day: z.number().int().min(1).max(7),
  weight_unit: z.enum(['kg', 'lb']),
  distance_unit: z.enum(['km', 'mi']),
  theme: z.enum(['system', 'light', 'dark']),
});
export type Me = z.infer<typeof meResponse>;

export const updateProfileRequest = z
  .object({
    display_name: z.string().min(1).max(80).nullable(),
    timezone: z.string().min(1).max(64),
    locale: z.string().min(2).max(10),
    week_start_day: z.number().int().min(1).max(7),
    weight_unit: z.enum(['kg', 'lb']),
    distance_unit: z.enum(['km', 'mi']),
    theme: z.enum(['system', 'light', 'dark']),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to update' });

// --- Activities ------------------------------------------------------------

export const createActivityRequest = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().max(4000).optional(),
    category_id: uuid.optional(),
    priority: priority.default(2),
    planned_start: instant,
    planned_end: instant,
    notes: z.string().max(4000).optional(),
    reminder_lead_minutes: z.number().int().min(0).max(1440).optional(),
  })
  .strict()
  .refine((v) => new Date(v.planned_end) > new Date(v.planned_start), {
    message: 'planned_end must be after planned_start',
    path: ['planned_end'],
  });

export const activity = z.object({
  id: uuid,
  title: z.string(),
  description: z.string().nullable(),
  category_id: uuid.nullable(),
  priority,
  occurrence_date: dayKey,
  planned_start: instant,
  planned_end: instant,
  planned_duration_minutes: z.number().int(),
  status: activityStatus,
  completion_ratio: z.number().min(0).max(1).nullable(),
  actual_start: instant.nullable(),
  actual_end: instant.nullable(),
  actual_duration_minutes: z.number().int().nullable(),
  start_deviation_minutes: z.number().int().nullable(),
  source: z.enum(['manual', 'series', 'sync']),
  manually_overridden: z.boolean(),
  sync_issue: z.boolean(),
  workout_session_id: uuid.nullable(),
  notes: z.string().nullable(),
});
export type Activity = z.infer<typeof activity>;

export const currentActivityResponse = z.object({
  current: activity.nullable(),
  next: activity.nullable(),
  previous: activity.nullable(),
  // Returned so the client can correct for device clock skew rather than
  // trusting a phone whose clock is three minutes fast.
  server_time: instant,
});

// --- Recurring series ------------------------------------------------------

export const seriesEditScope = z.enum(['occurrence', 'future', 'all']);

export const createSeriesRequest = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().max(4000).optional(),
    category_id: uuid.optional(),
    priority: priority.default(2),
    rrule: z.string().min(1).max(500),
    start_date: dayKey,
    end_date: dayKey.nullable().optional(),
    start_time: hhmm,
    duration_minutes: z.number().int().min(1).max(1440),
    reminder_lead_minutes: z.number().int().min(0).max(1440).nullable().optional(),
  })
  .strict();

// --- Workouts --------------------------------------------------------------

export const startWorkoutRequest = z
  .object({
    routine_id: uuid.optional(),
    /** Links this session to the Daybook slot it was started from. */
    activity_id: uuid.optional(),
    /** Generated by the client so an offline start replays exactly once. */
    client_session_uuid: uuid.optional(),
    started_at: instant.optional(),
    name: z.string().max(200).optional(),
  })
  .strict();

export const upsertSetRequest = z
  .object({
    session_exercise_id: uuid,
    set_number: z.number().int().positive(),
    set_type: z.enum(['working', 'warmup', 'drop', 'failure']).default('working'),
    reps: z.number().int().min(0).optional(),
    weight_kg: z.number().min(0).max(1000).optional(),
    duration_seconds: z.number().int().min(0).optional(),
    distance_m: z.number().int().min(0).optional(),
    rpe: z.number().min(1).max(10).optional(),
    completed: z.boolean().default(true),
  })
  .strict();

export const completeWorkoutResponse = z.object({
  workout: z.object({
    id: uuid,
    status: z.literal('completed'),
    started_at: instant,
    ended_at: instant,
    duration_seconds: z.number().int(),
    total_sets: z.number().int(),
    total_reps: z.number().int(),
    total_volume_kg: z.number(),
  }),
  personal_records: z.array(
    z.object({
      exercise: z.string(),
      metric: z.string(),
      value: z.number(),
      previous_value: z.number().nullable(),
    }),
  ),
  // "queued", never "done": the projection is asynchronous, and claiming
  // otherwise would be a lie the UI eventually contradicts.
  daybook_link: z.object({
    activity_id: uuid.nullable(),
    sync_status: z.enum(['queued', 'not_applicable']),
  }),
});

// --- Analytics -------------------------------------------------------------

export const scoreComponent = z.object({
  component: z.enum(['schedule', 'habits', 'workout', 'timeliness']),
  eligible: z.boolean(),
  raw: z.number().nullable(),
  weight: z.number(),
  contribution: z.number(),
});

export const dailyAnalytics = z.object({
  date: dayKey,
  completion_pct: z.number().nullable(),
  counts: z.object({
    planned: z.number().int(),
    completed: z.number().int(),
    partial: z.number().int(),
    skipped: z.number().int(),
    missed: z.number().int(),
  }),
  productive_minutes: z.number().int(),
  productivity_score: z.number().nullable(),
  score_breakdown: z.array(scoreComponent),
});

// --- Events ----------------------------------------------------------------

export const eventType = z.enum([
  'WORKOUT_STARTED',
  'WORKOUT_COMPLETED',
  'WORKOUT_ABANDONED',
  'WORKOUT_UPDATED',
  'WORKOUT_DELETED',
  'ACTIVITY_COMPLETED',
  'ACTIVITY_SKIPPED',
  'HABIT_COMPLETED',
  'SLEEP_LOGGED',
]);

export const domainEventEnvelope = z.object({
  id: uuid,
  event_type: eventType,
  schema_version: z.number().int().positive(),
  user_id: uuid,
  aggregate_type: z.string(),
  aggregate_id: uuid,
  // Separate on purpose: analytics needs when it happened, operations needs
  // when we heard about it, and for an offline replay those differ by hours.
  occurred_at: instant,
  recorded_at: instant,
  source_app: z.enum(['daybook', 'fitness', 'system']),
  payload: z.record(z.unknown()),
});

export const workoutCompletedPayload = z.object({
  workout_session_id: uuid,
  routine_name: z.string().nullable(),
  activity_id: uuid.nullable(),
  started_at: instant,
  ended_at: instant,
  duration_seconds: z.number().int(),
  exercise_count: z.number().int(),
  total_sets: z.number().int(),
  total_reps: z.number().int(),
  total_volume_kg: z.number(),
  // Carried in the payload so the consumer never has to guess which day a
  // 23:40 workout belongs to.
  local_date: dayKey,
  timezone: z.string(),
});
export type WorkoutCompletedPayload = z.infer<typeof workoutCompletedPayload>;
