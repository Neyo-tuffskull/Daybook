/**
 * The productivity score.
 *
 * The specification lives in docs/SCORING.md. If this file and that document
 * ever disagree, this file is wrong. Two rules carry most of the design:
 *
 *   1. A component with nothing to measure is dropped and the remaining
 *      weights rescale, so a rest day is not a failed workout day.
 *   2. A day with nothing eligible scores null, not zero. Zero means failure;
 *      null means there was nothing to judge.
 */

export type ComponentName = 'schedule' | 'habits' | 'workout' | 'timeliness';

export const COMPONENTS: readonly ComponentName[] = ['schedule', 'habits', 'workout', 'timeliness'];

export type ScoreWeights = Record<ComponentName, number>;

export const DEFAULT_WEIGHTS: ScoreWeights = {
  schedule: 0.35,
  habits: 0.25,
  workout: 0.2,
  timeliness: 0.2,
};

/** No single category may dominate, and none may be switched off entirely. */
export const WEIGHT_MIN = 0.1;
export const WEIGHT_MAX = 0.4;

export type Priority = 1 | 2 | 3 | 4;

/** Finishing the critical thing counts for more than finishing the easy thing. */
export const PRIORITY_WEIGHT: Record<Priority, number> = { 1: 1, 2: 2, 3: 3, 4: 5 };

// The status vocabulary and the rules for moving between statuses live in
// activity.ts, so there is one definition rather than two that can drift. It is
// imported and not re-exported: the barrel exports it from activity.ts, and two
// `export *` sources offering the same name is an ambiguous re-export.
import type { ActivityStatus } from './activity.ts';

export interface ScoredActivity {
  priority: Priority;
  status: ActivityStatus;
  /** Recorded fraction for a partial completion. Defaults to 0.5. */
  completionRatio?: number | null;
  /** Minutes late. Negative is early. Absent when the activity never started. */
  startDeviationMinutes?: number | null;
  /** True once the planned window has passed. Not-yet-due work is not judged. */
  isDue: boolean;
  /** Sync-created activities record what happened but do not score adherence. */
  source?: 'manual' | 'series' | 'sync';
}

export interface ScoreInput {
  activities: ScoredActivity[];
  habitsDue: number;
  habitsCompleted: number;
  workout:
    | { planned: false }
    | { planned: true; completed: boolean; setsCompleted?: number; setsTarget?: number };
  weights?: Partial<ScoreWeights>;
}

export interface ComponentResult {
  component: ComponentName;
  eligible: boolean;
  raw: number | null;
  weight: number;
  /** Points contributed to the final score, after renormalisation. */
  contribution: number;
}

export interface ScoreResult {
  /** Null when nothing was eligible. Never zero as a stand-in for "no data". */
  score: number | null;
  breakdown: ComponentResult[];
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * Full credit within ten minutes, decaying to zero at an hour. Starting early
 * never costs anything. The grace band exists because a planner that treats a
 * four-minute delay as failure is a planner people stop opening.
 */
export function punctuality(deviationMinutes: number): number {
  if (deviationMinutes <= 10) return 1;
  if (deviationMinutes >= 60) return 0;
  return 1 - (deviationMinutes - 10) / 50;
}

/** User weights are clamped into range, then normalised to sum to one. */
export function normaliseWeights(weights: Partial<ScoreWeights> = {}): ScoreWeights {
  const clamped = COMPONENTS.map((component) => {
    const raw = weights[component] ?? DEFAULT_WEIGHTS[component];
    return [component, clamp(raw, WEIGHT_MIN, WEIGHT_MAX)] as const;
  });
  const total = clamped.reduce((sum, [, value]) => sum + value, 0);
  return Object.fromEntries(
    clamped.map(([component, value]) => [component, value / total]),
  ) as ScoreWeights;
}

function scheduleComponent(activities: ScoredActivity[]): number | null {
  const judged = activities.filter(
    (a) => a.isDue && a.status !== 'rescheduled' && a.source !== 'sync',
  );
  if (judged.length === 0) return null;

  let weighted = 0;
  let total = 0;
  for (const activity of judged) {
    const weight = PRIORITY_WEIGHT[activity.priority];
    total += weight;
    weighted += weight * completionOf(activity);
  }
  return total === 0 ? null : weighted / total;
}

function completionOf(activity: ScoredActivity): number {
  switch (activity.status) {
    case 'completed':
      return 1;
    case 'partial':
      return clamp(activity.completionRatio ?? 0.5, 0, 1);
    // A paused activity is half-done in exactly the way an active one is. Both
    // are named here rather than left to a default, because a default reads as
    // "this never happened" and would score a deliberate pause as a failure.
    // The comment sits above the pair rather than between them: a comment
    // inside an empty case reads to ESLint as an intent to fall through.
    case 'active':
    case 'paused':
      return 0.5;
    case 'planned':
    case 'skipped':
    case 'missed':
    case 'rescheduled':
      return 0;
  }
}

function habitsComponent(due: number, completed: number): number | null {
  if (due <= 0) return null;
  return clamp(completed / due, 0, 1);
}

function workoutComponent(workout: ScoreInput['workout']): number | null {
  if (!workout.planned) return null;
  if (workout.completed) return 1;
  const { setsCompleted, setsTarget } = workout;
  if (setsCompleted !== undefined && setsTarget !== undefined && setsTarget > 0) {
    return clamp(setsCompleted / setsTarget, 0, 1);
  }
  return 0;
}

function timelinessComponent(activities: ScoredActivity[]): number | null {
  const started = activities.filter(
    (a) => a.startDeviationMinutes !== null && a.startDeviationMinutes !== undefined,
  );
  if (started.length === 0) return null;
  const total = started.reduce((sum, a) => sum + punctuality(a.startDeviationMinutes as number), 0);
  return total / started.length;
}

export function calculateScore(input: ScoreInput): ScoreResult {
  const weights = normaliseWeights(input.weights);

  const raws: Record<ComponentName, number | null> = {
    schedule: scheduleComponent(input.activities),
    habits: habitsComponent(input.habitsDue, input.habitsCompleted),
    workout: workoutComponent(input.workout),
    timeliness: timelinessComponent(input.activities),
  };

  const eligible = COMPONENTS.filter((component) => raws[component] !== null);
  const eligibleWeight = eligible.reduce((sum, component) => sum + weights[component], 0);

  if (eligible.length === 0 || eligibleWeight === 0) {
    return {
      score: null,
      breakdown: COMPONENTS.map((component) => ({
        component,
        eligible: false,
        raw: null,
        weight: weights[component],
        contribution: 0,
      })),
    };
  }

  let score = 0;
  const breakdown: ComponentResult[] = COMPONENTS.map((component) => {
    const raw = raws[component];
    if (raw === null) {
      return { component, eligible: false, raw: null, weight: weights[component], contribution: 0 };
    }
    const contribution = (weights[component] / eligibleWeight) * raw * 100;
    score += contribution;
    return {
      component,
      eligible: true,
      raw,
      weight: weights[component],
      // Components are rounded independently, so displayed contributions can
      // differ from the rounded total by up to 0.1. The total is authoritative.
      contribution: round1(contribution),
    };
  });

  return { score: round1(score), breakdown };
}
