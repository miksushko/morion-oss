/**
 * Pure formatters for NotesList row metadata. Lifted from the legacy
 * NotesList.tsx so the rules can be pin-tested without mounting the
 * component.
 */

/**
 * Apple-Notes-style preview snippet. Skips the FIRST non-empty line of
 * `body` (treated as the title) and returns the next non-empty line,
 * with leading markdown header markers (`#`, `##`, etc.) stripped.
 *
 *   ""                       → ""    (no body)
 *   "Title only"             → ""    (only title, no snippet)
 *   "Title\n\nbody"          → "body"
 *   "# Title\n\n## Section"  → "Section"   (both `#` markers stripped)
 *   "Title\n\n   \nbody"     → "body"      (skip blank lines between)
 */
export function previewFor(body: string): string {
  const lines = body.split('\n');
  let foundFirst = false;
  for (const raw of lines) {
    const stripped = raw.replace(/^#+\s*/, '').trim();
    if (!stripped) continue;
    if (!foundFirst) {
      foundFirst = true;
      continue; // skip the title line
    }
    return stripped;
  }
  return '';
}

/**
 * Apple-Notes-style relative-time label for a row's `updatedAt` (or
 * `deletedAt` in trash mode).
 *
 *   - Same calendar day as `now` → `HH:MM` (locale time)
 *   - Otherwise                  → `MMM D` (locale short month+day)
 *
 * `now` is overridable for deterministic tests; defaults to the live
 * clock.
 */
export function formatUpdated(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const nowDate = new Date(now);
  const sameDay =
    d.getFullYear() === nowDate.getFullYear() &&
    d.getMonth() === nowDate.getMonth() &&
    d.getDate() === nowDate.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
