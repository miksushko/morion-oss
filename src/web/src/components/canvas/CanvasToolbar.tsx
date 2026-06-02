import type { CanvasStage } from './types';

/**
 * "+ kind" button row above the canvas. Each row maps to one entry
 * in `TOOLBAR_BUTTONS`; the editor passes the disabled flag for
 * pinned-singleton kinds (reject_sink / complete_sink already present
 * on the canvas).
 */

interface ToolbarButton {
  kind: CanvasStage['kind'];
  label: string;
  classes: string;
  title?: string;
  /** Pinned singleton kinds — when already on canvas the button
   *  disables. */
  singleton?: 'reject_sink' | 'complete_sink';
  /** Title shown when this kind is locked because the canvas already
   *  has one (sinks are pinned at exactly-one per workflow). */
  disabledTitle?: string;
}

const TOOLBAR_BUTTONS: readonly ToolbarButton[] = [
  {
    kind: 'cli_agent',
    label: '+ cli_agent',
    classes:
      'border border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20',
  },
  {
    kind: 'mcp_tool_call',
    label: '+ mcp_tool_call',
    classes:
      'border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20',
  },
  {
    kind: 'mo_stage',
    label: '+ Mo stage',
    title:
      'Mo decision node — picks one of the declared branches at runtime',
    classes:
      'border border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300 hover:bg-fuchsia-500/20',
  },
  {
    kind: 'reject_sink',
    label: '+ Reject sink',
    singleton: 'reject_sink',
    title:
      'Terminal sink — ticket → backlog + Mo comment. Always present once added',
    disabledTitle:
      'Reject sink already present — v2 workflows have exactly one',
    classes:
      'border border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-destructive/10',
  },
  {
    kind: 'complete_sink',
    label: '+ Complete sink',
    singleton: 'complete_sink',
    title: 'Terminal sink — ticket → done + Mo comment',
    disabledTitle:
      'Complete sink already present — v2 workflows have exactly one',
    classes:
      'border border-emerald-600/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-emerald-500/15',
  },
  {
    kind: 'human_gate',
    label: '+ human_gate',
    title: 'Visual support; runtime is L3 follow-up',
    classes:
      'border border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20',
  },
  {
    kind: 'branch',
    label: '+ branch',
    title: 'Visual support; runtime is L4 DAG follow-up',
    classes:
      'border border-purple-500/40 bg-purple-500/10 text-purple-700 dark:text-purple-300 hover:bg-purple-500/20',
  },
];

export function CanvasToolbar({
  onAdd,
  disabled,
  hasRejectSink,
  hasCompleteSink,
}: {
  onAdd: (kind: CanvasStage['kind']) => void;
  disabled?: boolean;
  hasRejectSink: boolean;
  hasCompleteSink: boolean;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      {TOOLBAR_BUTTONS.map((btn) => {
        const locked =
          (btn.singleton === 'reject_sink' && hasRejectSink) ||
          (btn.singleton === 'complete_sink' && hasCompleteSink);
        return (
          <button
            key={btn.kind + btn.label}
            type="button"
            onClick={() => onAdd(btn.kind)}
            disabled={disabled || locked}
            className={
              'rounded-md px-2.5 py-1 text-[11px] ' + btn.classes
            }
            title={locked ? btn.disabledTitle : btn.title}
          >
            {btn.label}
          </button>
        );
      })}
    </div>
  );
}
