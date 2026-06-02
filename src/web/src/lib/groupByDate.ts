/**
 * Apple-Notes-style relative-date grouping.
 *
 * Groups a pre-sorted item array into labelled buckets:
 *   Today > Yesterday > Previous 7 Days > Previous 30 Days >
 *   {month names within current year} > {year labels for older}.
 *
 * Empty buckets are skipped. The order of returned groups follows the
 * order items were first encountered, so the caller controls the
 * top-to-bottom flow by sorting input newest-first before calling.
 *
 * Originally lived inside `NotesList.tsx` (where it was specialized to
 * `Note` + a `pinned` carve-out). Lifted here in v1.4.7 (Mo Chat
 * redesign — tickets 01KQXV7W + siblings) so the chat sidebar +
 * notes list + future "Recent activity" surfaces share one date-
 * bucketing implementation. Adding a new caller is a one-liner:
 *
 *   const groups = groupByDate(sessions, (s) => s.updatedAt);
 *
 * Optional `pinFn` carve-out lets the notes-list path keep its
 * "Pinned" header at the top (chat sidebar doesn't pin sessions).
 */

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export interface DateGroup<T> {
  label: string;
  items: T[];
}

export interface GroupByDateOptions<T> {
  /** When set, items where `pinFn(item) === true` are bucketed under
   *  the "Pinned" label first and skip the date bucketing. Caller
   *  responsible for sorting pinned items in the desired sub-order
   *  before passing to this helper. */
  pinFn?: (item: T) => boolean;
  /** Override `Date.now()` for tests so the bucket boundaries are
   *  deterministic. Defaults to live clock. */
  now?: number;
}

export function groupByDate<T>(
  items: readonly T[],
  getTs: (item: T) => number,
  opts: GroupByDateOptions<T> = {},
): DateGroup<T>[] {
  if (items.length === 0) return [];

  const nowMs = opts.now ?? Date.now();
  const now = new Date(nowMs);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86_400_000;
  const prev7Start = todayStart - 7 * 86_400_000;
  const prev30Start = todayStart - 30 * 86_400_000;
  const currentYear = now.getFullYear();
  const yearStart = new Date(currentYear, 0, 1).getTime();

  const buckets = new Map<string, T[]>();
  const order: string[] = [];

  const push = (label: string, item: T): void => {
    let arr = buckets.get(label);
    if (!arr) {
      arr = [];
      buckets.set(label, arr);
      order.push(label);
    }
    arr.push(item);
  };

  for (const item of items) {
    if (opts.pinFn?.(item)) {
      push('Pinned', item);
      continue;
    }
    const ts = getTs(item);
    if (ts >= todayStart) {
      push('Today', item);
    } else if (ts >= yesterdayStart) {
      push('Yesterday', item);
    } else if (ts >= prev7Start) {
      push('Previous 7 Days', item);
    } else if (ts >= prev30Start) {
      push('Previous 30 Days', item);
    } else if (ts >= yearStart) {
      const d = new Date(ts);
      push(MONTH_NAMES[d.getMonth()]!, item);
    } else {
      const d = new Date(ts);
      push(String(d.getFullYear()), item);
    }
  }

  return order.map((label) => ({ label, items: buckets.get(label)! }));
}
