/**
 * Pins the 5-field cron parser + matcher + next-fire contracts.
 *
 * Phase 1 of the Scheduler epic (ticket 01KSX1WJF0TR6949TDQS7Z1TXS).
 * Pure-function tests — no DB, no scheduler. Cases cover the four
 * common shapes the scheduler tick will produce (every minute, hourly,
 * daily at H:M, weekdays only, step-N) plus the cron tradition that
 * trips integrations: OR-semantics on day-of-month + day-of-week, and
 * 7 normalising to Sunday.
 */
import { describe, expect, it } from 'vitest';
import {
  CronParseError,
  matchesCron,
  nextFireAt,
  parseCron,
} from '../src/core/auto-code/schedules/cron';

// Helper: build a local-time Date at minute resolution.
function at(y: number, mon: number, d: number, h: number, m: number): Date {
  return new Date(y, mon - 1, d, h, m, 0, 0);
}

describe('parseCron — field expansion', () => {
  it('expands "*" to the full range of each field', () => {
    const c = parseCron('* * * * *');
    expect(c.minutes.length).toBe(60);
    expect(c.minutes[0]).toBe(0);
    expect(c.minutes[59]).toBe(59);
    expect(c.hours.length).toBe(24);
    expect(c.daysOfMonth.length).toBe(31);
    expect(c.months.length).toBe(12);
    expect(c.daysOfWeek.length).toBe(7);
    expect(c.domWasStar).toBe(true);
    expect(c.dowWasStar).toBe(true);
  });

  it('expands a single value', () => {
    const c = parseCron('30 9 * * *');
    expect(c.minutes).toEqual([30]);
    expect(c.hours).toEqual([9]);
  });

  it('expands a range "N-M"', () => {
    const c = parseCron('* 9-17 * * *');
    expect(c.hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it('expands a step "*/S"', () => {
    const c = parseCron('*/15 * * * *');
    expect(c.minutes).toEqual([0, 15, 30, 45]);
  });

  it('expands a range-with-step "N-M/S"', () => {
    const c = parseCron('0-30/5 * * * *');
    expect(c.minutes).toEqual([0, 5, 10, 15, 20, 25, 30]);
  });

  it('expands a comma-list', () => {
    const c = parseCron('0,15,30,45 * * * *');
    expect(c.minutes).toEqual([0, 15, 30, 45]);
  });

  it('normalises day-of-week 7 to 0 (Sunday)', () => {
    // Both `7` (legacy) and `0` are valid Sunday spellings.
    const c = parseCron('0 9 * * 7');
    expect(c.daysOfWeek).toEqual([0]);
  });

  it('handles "N/S" as "from N to max, step S"', () => {
    // Common cron extension semantics — Vixie cron treats `5/15` as
    // "starting at 5, every 15 minutes" i.e. 5, 20, 35, 50.
    const c = parseCron('5/15 * * * *');
    expect(c.minutes).toEqual([5, 20, 35, 50]);
  });

  it('preserves the domWasStar / dowWasStar flags', () => {
    expect(parseCron('* * 5 * *').domWasStar).toBe(false);
    expect(parseCron('* * * * 1').dowWasStar).toBe(false);
    expect(parseCron('* * * * *').domWasStar).toBe(true);
    expect(parseCron('* * * * *').dowWasStar).toBe(true);
    // `*/5` on a day field still counts as "star" for OR-semantics —
    // it doesn't restrict to specific days, just thins the universe.
    expect(parseCron('* * */5 * *').domWasStar).toBe(true);
  });
});

describe('parseCron — errors', () => {
  it('rejects empty string', () => {
    expect(() => parseCron('')).toThrow(CronParseError);
  });

  it('rejects descriptors like @daily', () => {
    expect(() => parseCron('@daily')).toThrow(/expected 5 fields/);
  });

  it('rejects 4-field and 6-field expressions', () => {
    expect(() => parseCron('* * * *')).toThrow(/expected 5 fields/);
    expect(() => parseCron('* * * * * *')).toThrow(/expected 5 fields/);
  });

  it('rejects out-of-range values', () => {
    expect(() => parseCron('60 * * * *')).toThrow(/out of range/);
    expect(() => parseCron('* 24 * * *')).toThrow(/out of range/);
    expect(() => parseCron('* * 0 * *')).toThrow(/out of range/);
    expect(() => parseCron('* * 32 * *')).toThrow(/out of range/);
    expect(() => parseCron('* * * 0 *')).toThrow(/out of range/);
    expect(() => parseCron('* * * 13 *')).toThrow(/out of range/);
    expect(() => parseCron('* * * * 8')).toThrow(/out of range/);
  });

  it('rejects reversed ranges', () => {
    expect(() => parseCron('30-15 * * * *')).toThrow(/range start.*>.*end/);
  });

  it('rejects zero or negative step', () => {
    expect(() => parseCron('*/0 * * * *')).toThrow(/step must be > 0/);
  });

  it('rejects non-integer values', () => {
    expect(() => parseCron('a * * * *')).toThrow(/expected integer/);
    expect(() => parseCron('* * * * 1.5')).toThrow(/expected integer/);
  });

  it('rejects empty list entries', () => {
    expect(() => parseCron('1,,3 * * * *')).toThrow(/empty list entry/);
  });
});

describe('matchesCron — minute/hour/day/month gates', () => {
  it('matches "every minute" for any time', () => {
    const c = parseCron('* * * * *');
    expect(matchesCron(c, at(2026, 5, 28, 0, 0))).toBe(true);
    expect(matchesCron(c, at(2026, 12, 31, 23, 59))).toBe(true);
  });

  it('matches "every day at 9:00" only at that minute', () => {
    const c = parseCron('0 9 * * *');
    expect(matchesCron(c, at(2026, 5, 28, 9, 0))).toBe(true);
    expect(matchesCron(c, at(2026, 5, 28, 9, 1))).toBe(false);
    expect(matchesCron(c, at(2026, 5, 28, 8, 0))).toBe(false);
    expect(matchesCron(c, at(2026, 5, 28, 10, 0))).toBe(false);
  });

  it('matches "weekdays at 9am" — Monday through Friday only', () => {
    // 2026-05-28 is a Thursday (day 4) — should fire.
    // 2026-05-30 is a Saturday (day 6) — should not.
    const c = parseCron('0 9 * * 1-5');
    expect(matchesCron(c, at(2026, 5, 28, 9, 0))).toBe(true); // Thu
    expect(matchesCron(c, at(2026, 5, 29, 9, 0))).toBe(true); // Fri
    expect(matchesCron(c, at(2026, 5, 30, 9, 0))).toBe(false); // Sat
    expect(matchesCron(c, at(2026, 5, 31, 9, 0))).toBe(false); // Sun
    expect(matchesCron(c, at(2026, 6, 1, 9, 0))).toBe(true); // Mon
  });

  it('matches every 15 minutes', () => {
    const c = parseCron('*/15 * * * *');
    expect(matchesCron(c, at(2026, 5, 28, 14, 0))).toBe(true);
    expect(matchesCron(c, at(2026, 5, 28, 14, 15))).toBe(true);
    expect(matchesCron(c, at(2026, 5, 28, 14, 30))).toBe(true);
    expect(matchesCron(c, at(2026, 5, 28, 14, 45))).toBe(true);
    expect(matchesCron(c, at(2026, 5, 28, 14, 1))).toBe(false);
    expect(matchesCron(c, at(2026, 5, 28, 14, 14))).toBe(false);
  });
});

describe('matchesCron — OR-semantics for day-of-month + day-of-week', () => {
  // The classic cron gotcha: when both dom AND dow are restricted
  // (not `*`), unix cron tradition fires if EITHER matches. When one is
  // `*`, it AND's with the other (the star is a no-op).
  it("AND's when day-of-month is restricted and day-of-week is *", () => {
    // Only the 15th, any weekday.
    const c = parseCron('0 9 15 * *');
    expect(matchesCron(c, at(2026, 5, 15, 9, 0))).toBe(true);
    expect(matchesCron(c, at(2026, 5, 14, 9, 0))).toBe(false);
    expect(matchesCron(c, at(2026, 5, 16, 9, 0))).toBe(false);
  });

  it("AND's when day-of-week is restricted and day-of-month is *", () => {
    // Every Monday (day 1), any day-of-month.
    const c = parseCron('0 9 * * 1');
    // 2026-05-25 is Monday, 2026-05-26 is Tuesday.
    expect(matchesCron(c, at(2026, 5, 25, 9, 0))).toBe(true);
    expect(matchesCron(c, at(2026, 5, 26, 9, 0))).toBe(false);
  });

  it("OR's when BOTH day-of-month AND day-of-week are restricted", () => {
    // "1st of month OR any Monday at 9am" — historical unix semantics.
    const c = parseCron('0 9 1 * 1');
    expect(matchesCron(c, at(2026, 6, 1, 9, 0))).toBe(true); // 1st of June
    expect(matchesCron(c, at(2026, 5, 25, 9, 0))).toBe(true); // a Monday
    expect(matchesCron(c, at(2026, 5, 28, 9, 0))).toBe(false); // Thu, not 1st
    expect(matchesCron(c, at(2026, 5, 1, 9, 0))).toBe(true); // 1st of May (a Friday)
  });
});

describe('nextFireAt — forward scan', () => {
  it('returns the next minute when expression is "* * * * *"', () => {
    const c = parseCron('* * * * *');
    const start = at(2026, 5, 28, 14, 30);
    const next = nextFireAt(c, start);
    expect(next).not.toBeNull();
    // "after" semantics — strictly later than `start`.
    expect(next!.getTime()).toBe(at(2026, 5, 28, 14, 31).getTime());
  });

  it('skips ahead to the next 9:00 for "0 9 * * *"', () => {
    const c = parseCron('0 9 * * *');
    // From mid-morning — next fire is tomorrow 9:00.
    const next = nextFireAt(c, at(2026, 5, 28, 10, 15));
    expect(next!.getTime()).toBe(at(2026, 5, 29, 9, 0).getTime());
  });

  it('skips Saturday + Sunday for weekday-only cron', () => {
    const c = parseCron('0 9 * * 1-5');
    // Friday 10am → next is Monday 9am, not Saturday.
    const next = nextFireAt(c, at(2026, 5, 29, 10, 0));
    // 2026-05-29 is Fri; +3 days = Mon 2026-06-01.
    expect(next!.getTime()).toBe(at(2026, 6, 1, 9, 0).getTime());
  });

  it('returns null for impossible expressions within window', () => {
    // Feb 31st never occurs.
    const c = parseCron('0 0 31 2 *');
    const next = nextFireAt(c, at(2026, 1, 1, 0, 0), 366 * 24 * 60);
    expect(next).toBeNull();
  });

  it('does not return the same minute twice (after = strictly after)', () => {
    const c = parseCron('* * * * *');
    const start = at(2026, 5, 28, 14, 30);
    const next = nextFireAt(c, start);
    expect(next!.getTime()).toBeGreaterThan(start.getTime());
  });
});
