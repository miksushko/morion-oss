/**
 * Skeleton placeholders are wrapped in underscores by the backend
 * (e.g. `_Mo will fill this in on the next patrol._`) to round-trip
 * through markdown unchanged. The UI hydrates an empty draft when
 * it sees one so the user starts from a blank textarea, not the
 * marker syntax.
 */
export function stripPlaceholder(text: string): string {
  const trimmed = text.trim();
  if (
    trimmed.length > 0 &&
    trimmed.startsWith('_') &&
    trimmed.endsWith('_') &&
    !trimmed.includes('\n')
  ) {
    return '';
  }
  return text;
}
