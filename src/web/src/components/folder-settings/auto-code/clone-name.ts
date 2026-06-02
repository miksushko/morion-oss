/**
 * Compute the name for a clone of a workflow based ONLY on the source
 * name. Pure — no list scanning, no API.
 *
 *   "Foo"            → "Foo (Copy)"
 *   "Foo (Copy)"     → "Foo (Copy 2)"
 *   "Foo (Copy 2)"   → "Foo (Copy 3)"
 *   "Foo (Copy 99)"  → "Foo (Copy 100)"
 *
 * Rationale: avoid the "(Copy)(Copy)" double-suffix the user
 * complained about, and stay deterministic on the source name so
 * repeated clones across delete/recreate cycles don't accumulate
 * surprising counters.
 *
 * Ticket: 01KRYBG9N6HMQG308ZTSQSMMND
 */
export function nextCloneName(name: string): string {
  const m = name.match(/^(.*?)\s*\(Copy(?:\s+(\d+))?\)\s*$/);
  if (!m) return `${name} (Copy)`;
  const base = m[1].trim();
  const n = m[2] ? Number(m[2]) : 1;
  return `${base} (Copy ${n + 1})`;
}
