import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVITY_STATUSES,
  IllegalTransitionError,
  TERMINAL_STATUSES,
  actionsFrom,
  canTransition,
  isInProgress,
  isTerminal,
  nextStatus,
  runningMinutes,
  transition,
  type ActivityAction,
  type ActivityStatus,
  type StatusEvent,
} from '../src/activity.ts';

describe('the activity state machine', () => {
  it('runs a day the way a day actually runs', () => {
    let status: ActivityStatus = 'planned';
    status = transition(status, 'start');
    assert.equal(status, 'active');
    status = transition(status, 'pause');
    assert.equal(status, 'paused');
    status = transition(status, 'resume');
    assert.equal(status, 'active');
    status = transition(status, 'complete');
    assert.equal(status, 'completed');
  });

  it('refuses to reopen finished work', () => {
    // The specific case named in docs/API.md section 4. The API turns this
    // into 409 rather than 400: the request was well formed, the activity was
    // simply not in a state where it could be honoured.
    assert.throws(() => transition('completed', 'start'), IllegalTransitionError);
    assert.equal(canTransition('completed', 'start'), false);
    assert.equal(nextStatus('completed', 'start'), null);
  });

  it('says what would have been allowed instead', () => {
    // The message reaches a person through the error body, so it has to be
    // useful on its own rather than assume somebody has the state diagram.
    try {
      transition('planned', 'resume');
      assert.fail('resume from planned should not be allowed');
    } catch (error) {
      assert.ok(error instanceof IllegalTransitionError);
      assert.equal(error.from, 'planned');
      assert.equal(error.action, 'resume');
      assert.ok(error.allowed.includes('start'));
      assert.match(error.message, /start/);
    }
  });

  it('cannot pause something that never started, or resume something running', () => {
    assert.equal(canTransition('planned', 'pause'), false);
    assert.equal(canTransition('active', 'resume'), false);
    assert.equal(canTransition('paused', 'pause'), false);
    assert.equal(canTransition('paused', 'start'), false);
  });

  it('lets you skip or miss anything not yet finished', () => {
    for (const status of ['planned', 'active', 'paused'] as const) {
      assert.equal(canTransition(status, 'skip'), true, `skip from ${status}`);
      assert.equal(canTransition(status, 'miss'), true, `miss from ${status}`);
    }
    for (const status of TERMINAL_STATUSES) {
      assert.equal(canTransition(status, 'skip'), false, `skip from ${status}`);
      assert.equal(canTransition(status, 'miss'), false, `miss from ${status}`);
    }
  });

  it('treats completed and rescheduled as the only ends', () => {
    // Only two, and both for a reason: `completed` is where analytics has
    // already counted the day, and `rescheduled` means another row carries the
    // work now. Everything else can still be corrected.
    assert.deepEqual([...TERMINAL_STATUSES].sort(), ['completed', 'rescheduled']);
    for (const status of TERMINAL_STATUSES) {
      assert.equal(actionsFrom(status).length, 0, `${status} should offer nothing`);
      assert.equal(isTerminal(status), true);
    }
  });

  it('lets a day be lived out of order', () => {
    // docs/API.md's transition table has allowed all three of these since
    // Phase 1. You skip the gym at 18:00 and do it at 21:00; you mark
    // something done that the sweep had already written off; you half-finish
    // and come back to it.
    assert.equal(transition('skipped', 'reopen'), 'planned');
    assert.equal(transition('missed', 'complete'), 'completed');
    assert.equal(transition('missed', 'completePartially'), 'partial');
    assert.equal(transition('partial', 'complete'), 'completed');
  });

  it('undoes a start without inventing a new state for it', () => {
    // Tapping start by mistake goes back to planned, from either running
    // state, rather than leaving something permanently begun.
    assert.equal(transition('active', 'reopen'), 'planned');
    assert.equal(transition('paused', 'reopen'), 'planned');
    assert.equal(canTransition('planned', 'reopen'), false);
    assert.equal(canTransition('completed', 'reopen'), false);
  });

  it('completes partially from either running state', () => {
    assert.equal(transition('active', 'completePartially'), 'partial');
    assert.equal(transition('paused', 'completePartially'), 'partial');
  });

  it('knows which states mean the activity is under way', () => {
    assert.equal(isInProgress('active'), true);
    assert.equal(isInProgress('paused'), true);
    assert.equal(isInProgress('planned'), false);
    assert.equal(isInProgress('completed'), false);
  });

  it('never produces a status outside the vocabulary', () => {
    // The database has a CHECK constraint listing these. If the machine can
    // produce something the constraint rejects, the disagreement arrives as a
    // 500 on a write rather than as a refusal, so the list is asserted here
    // rather than trusted to stay in step by inspection.
    const actions: ActivityAction[] = [
      'start',
      'pause',
      'resume',
      'complete',
      'completePartially',
      'skip',
      'reopen',
      'reschedule',
      'miss',
    ];
    for (const from of ACTIVITY_STATUSES) {
      for (const action of actions) {
        const next = nextStatus(from, action);
        if (next !== null) {
          assert.ok(ACTIVITY_STATUSES.includes(next), `${from} + ${action} -> ${next}`);
        }
      }
    }
    assert.deepEqual([...ACTIVITY_STATUSES].sort(), [
      'active',
      'completed',
      'missed',
      'partial',
      'paused',
      'planned',
      'rescheduled',
      'skipped',
    ]);
  });

  it('leaves no state stuck with nothing to do', () => {
    for (const status of ACTIVITY_STATUSES) {
      if (!isTerminal(status)) {
        assert.ok(actionsFrom(status).length > 0, `${status} is a dead end`);
      }
    }
  });
});

describe('elapsed time across pauses', () => {
  const at = (minutes: number): Date => new Date(Date.UTC(2026, 8, 7, 9, minutes, 0));

  it('adds up only the stretches that were running', () => {
    const events: StatusEvent[] = [
      { toStatus: 'active', at: at(0) },
      { toStatus: 'paused', at: at(20) },
      { toStatus: 'active', at: at(50) },
      { toStatus: 'completed', at: at(65) },
    ];
    // Twenty minutes, a thirty minute break, then fifteen more. End minus
    // start would say 65, which is the whole reason this function exists.
    assert.equal(runningMinutes(events, at(120)), 35);
  });

  it('counts up to now while an activity is still running', () => {
    assert.equal(runningMinutes([{ toStatus: 'active', at: at(0) }], at(12)), 12);
  });

  it('stops counting while paused', () => {
    const events: StatusEvent[] = [
      { toStatus: 'active', at: at(0) },
      { toStatus: 'paused', at: at(10) },
    ];
    assert.equal(runningMinutes(events, at(600)), 10);
  });

  it('is zero for something that was never started', () => {
    assert.equal(runningMinutes([], at(30)), 0);
    assert.equal(runningMinutes([{ toStatus: 'skipped', at: at(5) }], at(30)), 0);
  });

  it('survives a repeated status without double counting', () => {
    // Phase 12's offline queue can replay a transition. Two consecutive
    // actives must not start a second clock and count the stretch twice.
    const events: StatusEvent[] = [
      { toStatus: 'active', at: at(0) },
      { toStatus: 'active', at: at(5) },
      { toStatus: 'completed', at: at(30) },
    ];
    assert.equal(runningMinutes(events, at(90)), 30);
  });
});
