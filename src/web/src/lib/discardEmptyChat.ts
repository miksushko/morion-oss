/**
 * Ask-Mo counterpart of `discardEmptyNote`. A freshly-created chat that
 * never received a user message is a draft — if the user navigates away
 * without sending anything, hard-delete it so the session list doesn't
 * accumulate empty "New chat" rows.
 *
 * Title defaults to "New chat" on create, or "" if the backend ever
 * stores blank. Either counts as "never meaningfully titled".
 */
export function isEmptyDraftChat(opts: {
  title: string;
  messageCount: number;
}): boolean {
  if (opts.messageCount > 0) return false;
  const t = opts.title.trim();
  return t === '' || t === 'New chat' || t === 'Untitled chat';
}
