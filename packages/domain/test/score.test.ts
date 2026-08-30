import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateScore,
  normaliseWeights,
  punctuality,
  type ScoredActivity,
  type ScoreInput,
} from '../src/score.ts';

const due = (over: Partial<ScoredActivity> = {}): ScoredActivity => ({
  priority: 2,
  status: 'completed',
  isDue: true,
  ...over,
});

describe('punctuality', () => {
  it('gives full credit inside the ten minute grace band', () => {
    assert.equal(punctuality(0), 1);
    assert.equal(punctuality(10), 1);
  });

  it('never penalises starting early', () => {
    assert.equal(punctuality(-30), 1);
  });

  it('decays linearly to zero at an hour', () => {
    assert.equal(punctuality(35), 0.5);
    assert.equal(punctuality(60), 0);
    assert.equal(punctuality(180), 0);
  });
});

describe('normaliseWeights', () => {
  it('sums to one', () => {
    const total = Object.values(normaliseWeights()).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-9);
  });

  it('clamps a weight nobody should be allowed to set', () => {
    // Asking for 0.9 on schedule would let one category decide the whole score.
    const weights = normaliseWeights({ schedule: 0.9, habits: 0, workout: 0, timeliness: 0 });
    assert.ok(weights.schedule <= 0.4 / (0.4 + 0.1 + 0.1 + 0.1) + 1e-9);
    assert.ok(weights.habits > 0, 'a zeroed category is floored, not removed');
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-9);
  });
});

describe('calculateScore', () => {
  // A realistic day, modelled activity by activity, to check that priority
  // weighting behaves the way the specification describes.
  const realDay: ScoreInput = {
    activities: [
      ...Array.from({ length: 10 }, () => due({ priority: 3, status: 'completed' })),
      due({ priority: 1, status: 'completed' }),
      due({ priority: 2, status: 'missed' }),
      due({ priority: 2, status: 'missed' }),
      due({ priority: 1, status: 'skipped' }),
    ],
    habitsDue: 4,
    habitsCompleted: 3,
    workout: { planned: true, completed: true },
  };

  it('weights completion by priority rather than counting heads', () => {
    const { score, breakdown } = calculateScore(realDay);
    const schedule = breakdown.find((c) => c.component === 'schedule');
    assert.ok(schedule?.eligible);

    // Eleven of fourteen activities finished is 0.786 by headcount. By priority
    // weight it is 31 of 36, because the ten that got done were the important
    // ones. That gap is the whole point of weighting.
    assert.equal(Math.round((schedule.raw as number) * 1000) / 1000, 0.861);

    const habits = breakdown.find((c) => c.component === 'habits');
    assert.equal(habits?.raw, 0.75);

    assert.ok(score !== null && score > 0 && score <= 100);
  });

  it('is unmoved by timeliness when nothing recorded an actual start', () => {
    const timeliness = calculateScore(realDay).breakdown.find((c) => c.component === 'timeliness');
    assert.equal(timeliness?.eligible, false);
  });

  it('scores the exact documented figures for the four component values', () => {
    // Feeding the component values straight in isolates the arithmetic from
    // the activity modelling above.
    const result = calculateScore({
      activities: [
        due({ priority: 1, status: 'partial', completionRatio: 0.83, startDeviationMinutes: 29 }),
      ],
      habitsDue: 4,
      habitsCompleted: 3,
      workout: { planned: true, completed: true },
    });
    const raws = Object.fromEntries(result.breakdown.map((c) => [c.component, c.raw]));
    assert.equal(raws.schedule, 0.83);
    assert.equal(raws.habits, 0.75);
    assert.equal(raws.workout, 1);
    assert.equal(raws.timeliness, 0.62);
    // 0.83(0.35) + 0.75(0.25) + 1.00(0.20) + 0.62(0.20) = 0.802
    assert.equal(result.score, 80.2);
  });

  it('drops the workout component on a rest day and rescales the rest', () => {
    const result = calculateScore({
      activities: [
        due({ priority: 1, status: 'partial', completionRatio: 0.83, startDeviationMinutes: 29 }),
      ],
      habitsDue: 4,
      habitsCompleted: 3,
      workout: { planned: false },
    });
    const workout = result.breakdown.find((c) => c.component === 'workout');
    assert.equal(workout?.eligible, false);
    assert.equal(workout?.contribution, 0);
    // (0.2905 + 0.1875 + 0.124) / 0.80 = 0.7525
    assert.equal(result.score, 75.3);
    assert.ok(
      (result.score as number) > 0,
      'a rest day must not be punished for a workout that was never planned',
    );
  });

  it('returns null, not zero, for a day with nothing to judge', () => {
    const result = calculateScore({
      activities: [],
      habitsDue: 0,
      habitsCompleted: 0,
      workout: { planned: false },
    });
    assert.equal(result.score, null);
    assert.ok(result.breakdown.every((c) => !c.eligible));
  });

  it('does not judge activities that are not yet due', () => {
    const result = calculateScore({
      activities: [due({ status: 'planned', isDue: false })],
      habitsDue: 0,
      habitsCompleted: 0,
      workout: { planned: false },
    });
    assert.equal(result.score, null, 'a morning with an unfinished afternoon is not a failure');
  });

  it('excludes sync-created and rescheduled activities from adherence', () => {
    const result = calculateScore({
      activities: [
        due({ status: 'completed', source: 'sync' }),
        due({ status: 'completed', source: 'manual' }),
        due({ status: 'missed' }),
        due({ status: 'rescheduled' }),
      ],
      habitsDue: 0,
      habitsCompleted: 0,
      workout: { planned: false },
    });
    const schedule = result.breakdown.find((c) => c.component === 'schedule');
    // One completed and one missed of equal priority: 0.5, not 0.67 (which an
    // unplanned workout would have inflated it to) and not 0.33.
    assert.equal(schedule?.raw, 0.5);
  });

  it('gives an abandoned workout partial credit for the sets that were done', () => {
    const result = calculateScore({
      activities: [],
      habitsDue: 0,
      habitsCompleted: 0,
      workout: { planned: true, completed: false, setsCompleted: 9, setsTarget: 15 },
    });
    const workout = result.breakdown.find((c) => c.component === 'workout');
    assert.equal(workout?.raw, 0.6);
    assert.equal(result.score, 60);
  });

  it('scores zero for a planned workout with nothing recorded', () => {
    const result = calculateScore({
      activities: [],
      habitsDue: 0,
      habitsCompleted: 0,
      workout: { planned: true, completed: false },
    });
    assert.equal(result.score, 0);
  });

  it('stays within bounds for any combination', () => {
    const statuses: ScoredActivity['status'][] = [
      'completed',
      'partial',
      'active',
      'skipped',
      'missed',
    ];
    for (const status of statuses) {
      for (const priority of [1, 2, 3, 4] as const) {
        for (const deviation of [-20, 0, 12, 45, 90]) {
          const result = calculateScore({
            activities: [due({ status, priority, startDeviationMinutes: deviation })],
            habitsDue: 3,
            habitsCompleted: 1,
            workout: { planned: true, completed: status === 'completed' },
          });
          assert.ok(
            result.score !== null && result.score >= 0 && result.score <= 100,
            `score out of range for ${status}/${priority}/${deviation}: ${result.score}`,
          );
        }
      }
    }
  });
});
