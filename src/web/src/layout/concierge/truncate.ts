/** Keep tool-chip previews informative but bounded. The full payload
 *  is still in the DB row; Mo itself saw it untruncated. */
export function truncateResult(s: string): string {
  if (s.length <= 1200) return s;
  return `${s.slice(0, 1200)}\n… (${s.length - 1200} chars truncated)`;
}

/** Approval-card raw-args fallback when the server couldn't resolve a
 *  displayLabel. Pretty-printing is overkill — show the head + ellipsis. */
export function truncateArgs(json: string): string {
  if (!json) return '';
  if (json.length > 80) return `${json.slice(0, 80)}…`;
  return json;
}
