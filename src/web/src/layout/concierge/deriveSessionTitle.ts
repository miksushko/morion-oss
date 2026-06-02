/**
 * Derive a short chat title from the user's first message. Used to
 * auto-fill the placeholder "New chat" after the first send. Strips
 * newlines, caps at 60 chars, cuts on a word boundary when close.
 */
export function deriveSessionTitle(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  if (flat.length <= 60) return flat;
  const slice = flat.slice(0, 60);
  const lastSpace = slice.lastIndexOf(' ');
  return `${lastSpace > 40 ? slice.slice(0, lastSpace) : slice}…`;
}
