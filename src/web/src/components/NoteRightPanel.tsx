import { useEffect, useState } from 'react';
import { Bot, ChevronLeft, FileText, MessageCircle } from 'lucide-react';
import { ActivityPanel } from './ActivityPanel';
import { MetaDataPanel } from './MetaDataPanel';
import { AutoCodeDrawer } from './AutoCodeDrawer';
import { api } from '../lib/api';
import { cn } from '../lib/cn';

/**
 * Phase 6.5 — wrapper around the per-note right rail. Holds tab
 * state (Activity / Meta Data) and the collapsed-rail rendering for
 * both. Replaces the direct `<ActivityPanel />` injection in
 * `App.tsx` so the EditorPane gets one slot for both panels.
 *
 * Collapse semantics are preserved: when collapsed, a 40px rail
 * shows two stacked icons (one per tab). Clicking either expands the
 * panel with that tab active. When expanded, a 2-button tab strip
 * sits in the panel header; tab body fills the rest.
 */

type RightPanelTab = 'activity' | 'metadata';

export interface NoteRightPanelProps {
  noteId: string;
  /** Note title — passed straight to the AutoCodeDrawer header so
   *  the drawer doesn't have to fetch the note again. */
  noteTitle?: string;
  /** Bumped on `db.changed` WS broadcast — both panels refetch. */
  liveRev?: number;
  collapsed: boolean;
  onToggleCollapse: () => void;
  className?: string;
  /** ActivityPanel needs the current actor for Edit/Delete visibility
   *  on own posts. */
  currentActor: string;
  /** Toast hook for image upload failures inside the comment composer. */
  onUploadError?: (message: string) => void;
}

export function NoteRightPanel({
  noteId,
  noteTitle,
  liveRev,
  collapsed,
  onToggleCollapse,
  className,
  currentActor,
  onUploadError,
}: NoteRightPanelProps) {
  const [tab, setTab] = useState<RightPanelTab>('activity');
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Lightweight presence check: if the note has at least one
  // mo_agent_queue row we surface the "Watch auto-code" button.
  // Free users + non-auto-code folders never have rows so the
  // button stays hidden — no Pro upsell on a feature they can't use.
  const [hasRuns, setHasRuns] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api
      .getAutoCodeRuns(noteId)
      .then(({ rows }) => {
        if (!cancelled) setHasRuns(rows.length > 0);
      })
      .catch(() => {
        // 402 (not Pro) / 404 / etc — treat as "no runs" silently.
        if (!cancelled) setHasRuns(false);
      });
    return () => {
      cancelled = true;
    };
  }, [noteId, liveRev]);

  const drawer = drawerOpen ? (
    <AutoCodeDrawer
      taskId={noteId}
      taskTitle={noteTitle ?? 'Untitled'}
      onClose={() => setDrawerOpen(false)}
    />
  ) : null;
  const autoCodeButton = hasRuns ? (
    <button
      type="button"
      onClick={() => setDrawerOpen(true)}
      className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
      title="Watch auto-code activity"
    >
      <Bot className="h-3 w-3" />
      auto-code
    </button>
  ) : null;

  if (collapsed) {
    return (
      <>
        <div
          className={cn(
            'flex w-10 shrink-0 flex-col items-center gap-2 border-l border-border bg-card py-3 text-muted-foreground',
            className,
          )}
        >
          <button
            type="button"
            onClick={onToggleCollapse}
            className="flex h-6 w-6 items-center justify-center text-muted-foreground hover:text-foreground"
            aria-label="Expand panel"
          >
            <ChevronLeft className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => {
              setTab('activity');
              onToggleCollapse();
            }}
            className="flex h-6 w-6 items-center justify-center hover:text-foreground"
            aria-label="Open Activity"
            title="Activity"
          >
            <MessageCircle className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              setTab('metadata');
              onToggleCollapse();
            }}
            className="flex h-6 w-6 items-center justify-center hover:text-foreground"
            aria-label="Open Meta Data"
            title="Meta Data"
          >
            <FileText className="h-3.5 w-3.5" />
          </button>
          {hasRuns && (
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="flex h-6 w-6 items-center justify-center hover:text-foreground"
              aria-label="Watch auto-code activity"
              title="Auto-code activity"
            >
              <Bot className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {drawer}
      </>
    );
  }

  // Expanded: render the active panel directly (Activity owns its own
  // header + composer; Meta Data uses a lightweight tab header here).
  if (tab === 'activity') {
    return (
      <>
        <ActivityPanel
          noteId={noteId}
          currentActor={currentActor}
          liveRev={liveRev}
          collapsed={false}
          onToggleCollapse={onToggleCollapse}
          className={className}
          onUploadError={onUploadError}
          // Tab strip slot — rendered next to the activity-panel chrome
          // via a render prop so the panel layout stays stable.
          tabSlot={
            <div className="flex items-center gap-2">
              <RightPanelTabStrip activeTab={tab} onChange={setTab} />
              {autoCodeButton}
            </div>
          }
        />
        {drawer}
      </>
    );
  }

  return (
    <>
      <aside
        className={cn(
          'flex shrink-0 flex-col border-l border-border bg-card',
          className,
        )}
      >
        <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <div className="flex items-center gap-2">
            <RightPanelTabStrip activeTab={tab} onChange={setTab} />
            {autoCodeButton}
          </div>
          <button
            type="button"
            onClick={onToggleCollapse}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Collapse panel"
            title="Collapse"
          >
            <ChevronLeft className="h-3 w-3" />
          </button>
        </header>
        <MetaDataPanel
          noteId={noteId}
          liveRev={liveRev}
        />
      </aside>
      {drawer}
    </>
  );
}

function RightPanelTabStrip({
  activeTab,
  onChange,
}: {
  activeTab: RightPanelTab;
  onChange: (next: RightPanelTab) => void;
}) {
  return (
    <div className="flex items-center gap-1 text-[11px]">
      <TabPill
        label="Activity"
        active={activeTab === 'activity'}
        onClick={() => onChange('activity')}
      />
      <TabPill
        label="Meta Data"
        active={activeTab === 'metadata'}
        onClick={() => onChange('metadata')}
      />
    </div>
  );
}

function TabPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-6 items-center rounded-md px-2 font-medium uppercase tracking-wide transition-colors',
        active
          ? 'bg-primary/15 text-primary'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {label}
    </button>
  );
}
