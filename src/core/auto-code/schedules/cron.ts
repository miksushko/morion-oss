/**
 * 5-field cron expression parser + matcher + next-fire computer.
 *
 * Phase 1 of the Scheduler epic (ticket 01KSX1WJF0TR6949TDQS7Z1TXS).
 * Standalone module — no SQLite, no scheduler hooks, no React. Pure
 * functions over (string, Date). Vitest-friendly.
 *
 * Format: `minute hour day-of-month month day-of-week`
 *   minute       0-59
 *   hour         0-23
 *   day-of-month 1-31
 *   month        1-12 (Jan = 1)
 *   day-of-week  0-6  (Sun = 0; both 0 and 7 accepted for Sunday)
 *
 * Each field supports:
 *   *           — every value in the field's range
 *   N           — exact value
 *   N-M         — range (inclusive)
 *   N-M/S       — range with step
 *   * /S        — every Sth value over the full range
 *   A,B,C,...   — comma-list of any of the above
 *
 * NOT supported (intentional — keeps Phase 1 small):
 *   - descriptors (@daily / @reboot / @weekly)
 *   - L / W / # day-of-week qualifiers
 *   - seconds field (6-field cron)
 *   - month/day-of-week name aliases (JAN / MON)
 *
 * Day-of-month + day-of-week semantics: historical UNIX cron OR's them
 * when both are restricted (not `*`). We match that. Example:
 *   `0 9 1 * 1` → fires at 9:00 on the 1st of every month OR every
 *   Monday, not "the 1st only when that day is also Monday".
 *
 * Timezone: matcher reads local time from the Date passed in. The
 * caller (scheduler tick) is responsible for using whichever zone it
 * wants — typically `new Date()` for local. UTC schedules would pass
 * a UTC-equivalent Date.
 */

export interface CronExpr {
  /** Sorted unique minutes (0-59) the expression accepts. */
  readonly minutes: readonly number[];
  /** Sorted unique hours (0-23). */
  readonly hours: readonly number[];
  /** Sorted unique days of month (1-31). */
  readonly daysOfMonth: readonly number[];
  /** Sorted unique months (1-12). */
  readonly months: readonly number[];
  /** Sorted unique days of week (0-6, Sun=0). */
  readonly daysOfWeek: readonly number[];
  /** True iff the original day-of-month field was `*`. Combined with
   *  `dowWasStar` to drive the OR-semantics on match. */
  readonly domWasStar: boolean;
  readonly dowWasStar: boolean;
}

export class CronParseError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`cron field "${field}": ${message}`);
    this.name = 'CronParseError';
    this.field = field;
  }
}

interface FieldSpec {
  readonly name: string;
  readonly min: number;
  readonly max: number;
}

const SPECS: readonly [FieldSpec, FieldSpec, FieldSpec, FieldSpec, FieldSpec] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 6 },
] as const;

/**
 * Parse a 5-field cron expression. Throws `CronParseError` on any
 * structural or out-of-range issue.
 */
export function parseCron(expr: string): CronExpr {
  if (typeof expr !== 'string') {
    throw new CronParseError('input', 'expected string');
  }
  const trimmed = expr.trim();
  if (trimmed.length === 0) {
    throw new CronParseError('input', 'empty expression');
  }
  // Multiple whitespace between fields is fine — split on any whitespace run.
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    throw new CronParseError(
      'input',
      `expected 5 fields, got ${fields.length} (descriptors like @daily are not supported)`,
    );
  }

  const [mField, hField, domField, monField, dowField] = fields;
  const minutes = parseField(mField!, SPECS[0]);
  const hours = parseField(hField!, SPECS[1]);
  const daysOfMonth = parseField(domField!, SPECS[2]);
  // Month field is 1-12 — same as spec.
  const months = parseField(monField!, SPECS[3]);
  // Day-of-week: spec is 0-6 but cron tradition accepts 7 as Sunday too.
  // Normalize 7 → 0 before validation.
  const dowRaw = dowField!.replace(/(^|[,\-/])7(?=$|[,\-/])/g, (_m, p1) => `${p1}0`);
  const daysOfWeek = parseField(dowRaw, SPECS[4]);

  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    domWasStar: isStarField(domField!),
    dowWasStar: isStarField(dowField!),
  };
}

function isStarField(raw: string): boolean {
  // `*` or `*/N` — both mean "no restriction on this field" for the
  // OR-semantics check on dom/dow. A list like `*,5` is still a star
  // in spirit but the unix convention treats explicit values as
  // restrictions. Be strict: only the literal `*` (or `*/N`) counts.
  return raw === '*' || /^\*\/\d+$/.test(raw);
}

function parseField(raw: string, spec: FieldSpec): number[] {
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    if (part.length === 0) {
      throw new CronParseError(spec.name, `empty list entry in "${raw}"`);
    }
    expandPart(part, spec, values);
  }
  if (values.size === 0) {
    throw new CronParseError(spec.name, `no values matched "${raw}"`);
  }
  return [...values].sort((a, b) => a - b);
}

function expandPart(part: string, spec: FieldSpec, out: Set<number>): void {
  // Split off step: `range/step` or `*/step`.
  let step = 1;
  let rangePart = part;
  const slashIdx = part.indexOf('/');
  if (slashIdx !== -1) {
    rangePart = part.slice(0, slashIdx);
    const stepStr = part.slice(slashIdx + 1);
    if (!/^\d+$/.test(stepStr)) {
      throw new CronParseError(spec.name, `step must be a positive integer, got "${stepStr}"`);
    }
    step = parseInt(stepStr, 10);
    if (step <= 0) {
      throw new CronParseError(spec.name, `step must be > 0, got ${step}`);
    }
  }

  let lo: number;
  let hi: number;
  if (rangePart === '*') {
    lo = spec.min;
    hi = spec.max;
  } else {
    const dashIdx = rangePart.indexOf('-');
    if (dashIdx === -1) {
      // Single value. With a step `N/S` this is "N, N+S, N+2S, ... up to max"
      // per common cron extension semantics.
      const n = parseInteger(rangePart, spec);
      lo = n;
      hi = step === 1 ? n : spec.max;
    } else {
      const loStr = rangePart.slice(0, dashIdx);
      const hiStr = rangePart.slice(dashIdx + 1);
      lo = parseInteger(loStr, spec);
      hi = parseInteger(hiStr, spec);
      if (lo > hi) {
        throw new CronParseError(spec.name, `range start ${lo} > end ${hi} in "${rangePart}"`);
      }
    }
  }
  for (let v = lo; v <= hi; v += step) {
    out.add(v);
  }
}

function parseInteger(s: string, spec: FieldSpec): number {
  if (!/^\d+$/.test(s)) {
    throw new CronParseError(spec.name, `expected integer, got "${s}"`);
  }
  const n = parseInt(s, 10);
  if (n < spec.min || n > spec.max) {
    throw new CronParseError(
      spec.name,
      `value ${n} out of range ${spec.min}-${spec.max}`,
    );
  }
  return n;
}

/**
 * Does the given local-time Date match this expression? Compares
 * minute, hour, month from the Date's local fields and combines
 * day-of-month / day-of-week with OR-semantics when both fields are
 * restricted (matches UNIX cron tradition).
 *
 * Seconds and milliseconds of `date` are ignored — the caller is
 * expected to drive matches at minute granularity (e.g. truncate to
 * the start of the minute before calling, or just call once per minute
 * from the scheduler tick).
 */
export function matchesCron(expr: CronExpr, date: Date): boolean {
  const m = date.getMinutes();
  const h = date.getHours();
  const dom = date.getDate();
  const mon = date.getMonth() + 1;
  const dow = date.getDay();

  if (!includes(expr.minutes, m)) return false;
  if (!includes(expr.hours, h)) return false;
  if (!includes(expr.months, mon)) return false;

  const domMatch = includes(expr.daysOfMonth, dom);
  const dowMatch = includes(expr.daysOfWeek, dow);

  // OR-semantics when both day fields are restricted (not `*`):
  // unix cron fires when either day predicate matches. When at least
  // one field is `*` it's effectively AND (the star is a no-op).
  if (expr.domWasStar && expr.dowWasStar) {
    return true; // both stars — any day works (already filtered hour/min/month)
  }
  if (expr.domWasStar) return dowMatch;
  if (expr.dowWasStar) return domMatch;
  return domMatch || dowMatch;
}

function includes(arr: readonly number[], n: number): boolean {
  // Linear scan is fine — fields are tiny (max 60 entries).
  for (const v of arr) {
    if (v === n) return true;
  }
  return false;
}

/**
 * Next minute-boundary timestamp at-or-after `after` that matches the
 * expression. Searches forward up to `maxLookaheadMinutes` minutes
 * (default 366*24*60 = one year). Returns null if no match found in
 * the window — that only happens for impossible expressions like
 * `0 0 31 2 *` (Feb 31st) and we'd rather caller see null than spin.
 */
export function nextFireAt(
  expr: CronExpr,
  after: Date,
  maxLookaheadMinutes: number = 366 * 24 * 60,
): Date | null {
  // Start at the next minute boundary after `after`. If `after` is
  // exactly on a minute boundary, we still advance — "after" semantics,
  // not "at-or-after". Scheduler tick that just fired wants the NEXT
  // fire, not the same one again.
  const start = new Date(after.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  for (let i = 0; i < maxLookaheadMinutes; i++) {
    if (matchesCron(expr, start)) return new Date(start.getTime());
    start.setMinutes(start.getMinutes() + 1);
  }
  return null;
}
