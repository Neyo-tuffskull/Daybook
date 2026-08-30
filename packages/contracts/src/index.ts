/**
 * The wire contract, defined once.
 *
 * These schemas do three jobs from one definition: runtime validation at the
 * API boundary, TypeScript types for both frontends, and the OpenAPI document.
 * A frontend that sends a renamed field fails to compile rather than failing
 * in production.
 */
import { z } from 'zod';

export const uuid = z.string().uuid();
export const dayKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');
export const instant = z.string().datetime({ offset: true });

export const priority = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);

export const activityStatus = z.enum([
  'planned',
  'active',
  'completed',
  'partial',
  'skipped',
  'missed',
  'rescheduled',
]);
export type ActivityStatus = z.infer<typeof activityStatus>;

/**
 * Transitions are enforced on the server, not merely in the UI. Completing an
 * activity twice, or reviving a completed one, returns 409 rather than quietly
 * rewriting history that analytics has already counted.
 */
export const LEGAL_TRANSITIONS: Record<ActivityStatus, ActivityStatus[]> = {
  planned: ['active', 'completed', 'partial', 'skipped', 'missed', 'rescheduled'],
  active: ['completed', 'partial', 'skipped', 'planned'],
  completed: [],
  partial: ['completed'],
  skipped: ['planned'],
  missed: ['completed', 'partial', 'skipped'],
  rescheduled: [],
};

export function canTransition(from: ActivityStatus, to: ActivityStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

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

export const registerRequest = z.object({
  email: z.string().email().max(320),
  password: z.string().min(12).max(200),
  display_name: z.string().min(1).max(80).optional(),
  timezone: z.string().min(1).max(64),
});

export const loginRequest = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
});

export const sessionResponse = z.object({
  access_token: z.string(),
  expires_in: z.number().int().positive(),
  user: z.object({
    id: uuid,
    email: z.string().email(),
    display_name: z.string().nullable(),
    timezone: z.string(),
  }),
});

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
