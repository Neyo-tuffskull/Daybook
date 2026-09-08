/**
 * The activity status state machine.
 *
 * Which transitions are legal is a domain rule, not an HTTP rule, so it lives
 * here as pure functions with no framework imports. The API layer's only job is
 * to translate a refusal into 409, and the offline queue in Phase 12 will ask
 * the same questions of the same functions before it replays anything.
 *
 * The specification is docs/API.md section 4 and docs/DATABASE.md section 4.
 * `planned -> active -> completed` is legal; `completed -> active` is not.
 */

export type ActivityStatus =
  'planned' | 'active' | 'paused' | 'completed' | 'partial' | 'skipped' | 'missed' | 'rescheduled';

/**
 * What somebody can do to an activity.
 *
 * `complete` and `completePartially` are separate actions rather than one
 * action carrying a ratio, because they land on different statuses and the
 * machine's job is to say which. The ratio itself is the caller's business.
 *
 * `miss` is not a user action. The end-of-day sweep applies it to work whose
 * window has passed untouched, which is why it is legal from the three states
 * that mean "not finished" and from nowhere else.
 */
export type ActivityAction =
  'start' | 'pause' | 'resume' | 'complete' | 'completePartially' | 'skip' | 'reschedule' | 'miss';

/**
 * The whole machine, as data.
 *
 * A table rather than a switch because it can be read as a specification, and
 * because a missing entry is then an absence rather than a fallthrough. The
 * cost of the alternative is visible two files away: `completionOf` in
 * score.ts ends in a default case, which is exactly how a status can be added
 * to the system and silently score as a failure.
 */
const TRANSITIONS: Readonly<
  Record<ActivityStatus, Readonly<Partial<Record<ActivityAction, ActivityStatus>>>>
> = {
  planned: {
    start: 'active',
    skip: 'skipped',
    reschedule: 'rescheduled',
    miss: 'missed',
  },
  active: {
    pause: 'paused',
    complete: 'completed',
    completePartially: 'partial',
    skip: 'skipped',
    miss: 'missed',
  },
  paused: {
    resume: 'active',
    complete: 'completed',
    completePartially: 'partial',
    skip: 'skipped',
    miss: 'missed',
  },
  // Everything below is an end state. Correcting one is an explicit reopen
  // action, which does not exist yet: see docs/ROADMAP.md, Phase 4.
  completed: {},
  partial: {},
  skipped: {},
  missed: {},
  rescheduled: {},
};

export const ACTIVITY_STATUSES = Object.keys(TRANSITIONS) as readonly ActivityStatus[];

/** States from which nothing further can happen. */
export const TERMINAL_STATUSES: readonly ActivityStatus[] = ACTIVITY_STATUSES.filter(
  (status) => Object.keys(TRANSITIONS[status]).length === 0,
);

/** True while the clock is meaningfully running or stopped mid-activity. */
export function isInProgress(status: ActivityStatus): boolean {
  return status === 'active' || status === 'paused';
}

export function isTerminal(status: ActivityStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** The status this action would produce, or null if it is not allowed here. */
export function nextStatus(from: ActivityStatus, action: ActivityAction): ActivityStatus | null {
  return TRANSITIONS[from][action] ?? null;
}

export function canTransition(from: ActivityStatus, action: ActivityAction): boolean {
  return nextStatus(from, action) !== null;
}

/** Every action legal from here. Lets the UI disable buttons rather than guess. */
export function actionsFrom(from: ActivityStatus): readonly ActivityAction[] {
  return Object.keys(TRANSITIONS[from]) as ActivityAction[];
}

/**
 * Thrown rather than returned, because a caller that ignores an illegal
 * transition writes a wrong status to the database. The API maps this to 409.
 */
export class IllegalTransitionError extends Error {
  readonly from: ActivityStatus;
  readonly action: ActivityAction;
  readonly allowed: readonly ActivityAction[];

  constructor(from: ActivityStatus, action: ActivityAction) {
    const allowed = actionsFrom(from);
    super(
      allowed.length === 0
        ? `Cannot ${action} an activity that is already ${from}.`
        : `Cannot ${action} an activity that is ${from}. Allowed: ${allowed.join(', ')}.`,
    );
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.action = action;
    this.allowed = allowed;
  }
}

export function transition(from: ActivityStatus, action: ActivityAction): ActivityStatus {
  const next = nextStatus(from, action);
  if (next === null) {
    throw new IllegalTransitionError(from, action);
  }
  return next;
}

/**
 * How much of the planned time an activity has actually consumed.
 *
 * Elapsed time cannot be `end - start`, because a pause stops the clock and
 * an activity may be paused and resumed several times. The status event log is
 * the source of truth: this walks it and adds up the stretches spent running.
 *
 * `now` is a parameter rather than a call to Date.now(), so the calculation is
 * testable and so a replayed offline queue can compute the same answer it would
 * have computed at the time.
 */
export interface StatusEvent {
  toStatus: ActivityStatus;
  at: Date;
}

export function runningMinutes(events: readonly StatusEvent[], now: Date): number {
  let total = 0;
  let runningSince: Date | null = null;

  for (const event of events) {
    const wasRunning = runningSince !== null;
    const isRunning = event.toStatus === 'active';

    if (isRunning && !wasRunning) {
      runningSince = event.at;
    } else if (!isRunning && wasRunning) {
      total += event.at.getTime() - (runningSince as Date).getTime();
      runningSince = null;
    }
  }

  if (runningSince !== null) {
    total += now.getTime() - runningSince.getTime();
  }

  return Math.max(0, Math.round(total / 60_000));
}
