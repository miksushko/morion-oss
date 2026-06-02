import type { DrawerSessionEntry } from './types';
import { renderSessionStatusDot, sessionEntryKey } from './helpers';

/**
 * Phase 5 follow-up — dropdown that replaces the hardcoded
 * Fix/Review tabs. Workflows are now DAG-shaped with potentially
 * many stages (mo_start, fix, mo_after_fix, review, human_gate
 * pauses, mo_tools, etc.); some of them have associated sessions
 * (transcripts or Ask Mo chats). The selector lists every session
 * the current run has produced — labelled by stage id + agent name
 * (or "stageId — chat" for human_gate) — so the user can scrub
 * through any stage's transcript instead of being limited to
 * fix/review.
 *
 * Hidden when there are zero sessions (a freshly-claimed run
 * before any stage has spawned) — the empty-state above takes
 * over the body.
 *
 * Status indicator: an inline coloured dot before each label —
 * running (blue spinner), done (green dot), failed (red dot),
 * cancelled (gray), pending (gray). Lets the user identify the
 * active stage at a glance without opening it.
 */
interface SessionSelectorProps {
  sessions: DrawerSessionEntry[];
  selected: DrawerSessionEntry | null;
  onChange: (s: DrawerSessionEntry) => void;
}

export function SessionSelector({ sessions, selected, onChange }: SessionSelectorProps) {
  if (sessions.length === 0) {
    // Nothing to show — the parent renders an empty-state in the
    // transcript area instead.
    return null;
  }
  const selectedKey = selected ? sessionEntryKey(selected) : '';
  return (
    <div className="flex items-center gap-2 border-b px-4 py-2 text-sm">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">
        Session
      </span>
      <select
        value={selectedKey}
        onChange={(e) => {
          const next = sessions.find((s) => sessionEntryKey(s) === e.target.value);
          if (next) onChange(next);
        }}
        className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm focus:border-primary focus:outline-none"
      >
        {sessions.map((s) => (
          <option key={sessionEntryKey(s)} value={sessionEntryKey(s)}>
            {renderSessionStatusDot(s.status)} {s.label} · {s.status}
          </option>
        ))}
      </select>
    </div>
  );
}
