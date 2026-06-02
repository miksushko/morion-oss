import { useEffect } from 'react';
import type { AppView } from '../appShellTypes';

/**
 * Pure parser for the concierge deep-link hash. Returns the action to
 * take (or null if the hash isn't a concierge intent). Extracted so
 * the regex + accepted shapes are testable without a DOM. Accepted:
 *   `#/concierge`                       → { view: 'concierge' }
 *   `#/concierge/sessions/<sessionId>`  → { view: 'concierge', sessionId }
 * Anything else → null. SessionId charset matches what the rest of the
 * app uses for ULID/cs-prefixed session ids (alnum + `-` + `_`).
 */
export function parseConciergeHash(
  hash: string,
): { view: 'concierge'; sessionId?: string } | null {
  const m = hash.match(/^#\/concierge(?:\/sessions\/([\w-]+))?\/?$/);
  if (!m) return null;
  return m[1] ? { view: 'concierge', sessionId: m[1] } : { view: 'concierge' };
}

/**
 * Translates `#/concierge` and `#/concierge/sessions/<id>` URL-hash
 * intents into the App's view state. PausedAskUserCTA (the
 * "Open chat to reply" banner inside AutoCodeDrawer) writes the hash
 * as a deep-link intent because the drawer is three component layers
 * away from App and prop-drilling a chat-navigation callback through
 * NoteRightPanel + KanbanView would change a lot of intermediate
 * prop interfaces.
 *
 * Without this listener nothing reacted to those hashes and the
 * button was a silent no-op (broken since the CTA shipped — no
 * handler ever existed on the App side).
 *
 * Behaviour:
 *   - On mount and on every `hashchange`, parses the current hash.
 *   - `#/concierge`                      → switches view to 'concierge'.
 *   - `#/concierge/sessions/<sessionId>` → switches view + preselects
 *     the session in the sidebar (driven by ConciergePanel's
 *     `preselectSessionId` prop, owned by useConciergeChat).
 *   - After handling, clears the hash via history.replaceState so a
 *     refresh doesn't re-fire the intent and the URL stays clean.
 */
export function useConciergeHashRoute(args: {
  selectView: (next: AppView) => void;
  setPreselectSessionId: (id: string | null) => void;
}) {
  const { selectView, setPreselectSessionId } = args;
  useEffect(() => {
    const dispatch = () => {
      const action = parseConciergeHash(window.location.hash);
      if (!action) return;
      selectView('concierge');
      if (action.sessionId) setPreselectSessionId(action.sessionId);
      history.replaceState(null, '', window.location.pathname + window.location.search);
    };
    dispatch();
    window.addEventListener('hashchange', dispatch);
    return () => window.removeEventListener('hashchange', dispatch);
  }, [selectView, setPreselectSessionId]);
}
