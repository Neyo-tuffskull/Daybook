import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertValidTimeZone, dayKey, eachDay, minutesBetween } from '../src/time.ts';

describe('dayKey', () => {
  it('uses the given zone, not the machine zone', () => {
    // 23:30 UTC is already the next day in Lagos (UTC+1).
    const instant = new Date('2026-08-28T23:30:00Z');
    assert.equal(dayKey(instant, 'Africa/Lagos'), '2026-08-29');
    assert.equal(dayKey(instant, 'Europe/London'), '2026-08-29');
    assert.equal(dayKey(instant, 'America/New_York'), '2026-08-28');
  });

  it('respects a custom start of day for a night owl', () => {
    const lateNight = new Date('2026-08-29T01:30:00+01:00');
    assert.equal(dayKey(lateNight, 'Africa/Lagos'), '2026-08-29');
    assert.equal(dayKey(lateNight, 'Africa/Lagos', { startOfDay: '04:00' }), '2026-08-28');
  });

  it('rolls back across a month boundary', () => {
    const justAfterMidnight = new Date('2026-09-01T00:30:00+01:00');
    assert.equal(
      dayKey(justAfterMidnight, 'Africa/Lagos', { startOfDay: '04:00' }),
      '2026-08-31',
    );
  });

  it('rolls back across a year boundary', () => {
    const newYear = new Date('2027-01-01T02:00:00Z');
    assert.equal(dayKey(newYear, 'Europe/London', { startOfDay: '04:00' }), '2026-12-31');
  });

  // The highest-risk behaviour in the whole product. 2026-10-25 is the day
  // British Summer Time ends: 02:00 BST becomes 01:00 GMT, so 01:30 UTC occurs
  // once at 02:30 BST and the local clock repeats the 01:00 hour.
  describe('across a daylight-saving transition', () => {
    it('keeps the calendar day correct on the long day', () => {
      const beforeShift = new Date('2026-10-25T00:30:00Z'); // 01:30 BST
      const afterShift = new Date('2026-10-25T01:30:00Z'); // 01:30 GMT
      assert.equal(dayKey(beforeShift, 'Europe/London'), '2026-10-25');
      assert.equal(dayKey(afterShift, 'Europe/London'), '2026-10-25');
    });

    it('applies the start-of-day cutoff to local wall-clock time, not UTC', () => {
      // 02:30 BST is before a 04:00 cutoff, so it belongs to the previous day.
      const earlyBst = new Date('2026-10-25T01:30:00Z');
      assert.equal(dayKey(earlyBst, 'Europe/London', { startOfDay: '04:00' }), '2026-10-24');
    });

    it('handles the spring transition, when 01:00 to 02:00 does not exist', () => {
      // 2026-03-29: 01:00 GMT becomes 02:00 BST.
      const duringSpringForward = new Date('2026-03-29T01:30:00Z'); // 02:30 BST
      assert.equal(dayKey(duringSpringForward, 'Europe/London'), '2026-03-29');
      assert.equal(
        dayKey(duringSpringForward, 'Europe/London', { startOfDay: '04:00' }),
        '2026-03-28',
      );
    });

    it('is unaffected in a zone with no daylight saving', () => {
      const instant = new Date('2026-10-25T01:30:00Z');
      assert.equal(dayKey(instant, 'Africa/Lagos'), '2026-10-25');
    });
  });

  it('rejects a start-of-day that is not HH:MM', () => {
    const instant = new Date('2026-08-28T12:00:00Z');
    assert.throws(() => dayKey(instant, 'Africa/Lagos', { startOfDay: '4am' }), RangeError);
    assert.throws(() => dayKey(instant, 'Africa/Lagos', { startOfDay: '25:00' }), RangeError);
  });
});

describe('assertValidTimeZone', () => {
  it('accepts real zones and rejects invented ones', () => {
    assert.doesNotThrow(() => assertValidTimeZone('Africa/Lagos'));
    assert.throws(() => assertValidTimeZone('Mars/Olympus_Mons'), RangeError);
  });
});

describe('minutesBetween', () => {
  it('is signed, and rounds to whole minutes', () => {
    const planned = new Date('2026-08-28T18:00:00Z');
    assert.equal(minutesBetween(planned, new Date('2026-08-28T18:05:00Z')), 5);
    assert.equal(minutesBetween(planned, new Date('2026-08-28T17:52:00Z')), -8);
    assert.equal(minutesBetween(planned, new Date('2026-08-28T18:00:40Z')), 1);
  });
});

describe('eachDay', () => {
  it('is inclusive at both ends', () => {
    assert.deepEqual(eachDay('2026-08-28', '2026-08-31'), [
      '2026-08-28',
      '2026-08-29',
      '2026-08-30',
      '2026-08-31',
    ]);
  });

  it('spans a month boundary', () => {
    assert.deepEqual(eachDay('2026-08-30', '2026-09-02'), [
      '2026-08-30',
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
    ]);
  });

  it('returns a single day when the bounds match', () => {
    assert.deepEqual(eachDay('2026-08-28', '2026-08-28'), ['2026-08-28']);
  });

  it('does not lose a day across a daylight-saving change', () => {
    assert.equal(eachDay('2026-10-24', '2026-10-26').length, 3);
    assert.equal(eachDay('2026-03-28', '2026-03-30').length, 3);
  });
});
