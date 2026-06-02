/**
 * File list with per-file remaining-conflict-marker badge.
 *
 * Extracted from ConflictResolverModal.tsx on 2026-05-16. Renders
 * once per conflict file; clicking switches the active draft.
 * The badge counts ALL open markers (`^<<<<<<< `), not just the
 * one nearest the cursor — gives the user a "this file is done"
 * green check vs "N regions still open" red number.
 */
import type { AutoCodeConflictFile } from '../../lib/api';
import { cn } from '../../lib/cn';

export function FileSidebar({
  files,
  selected,
  drafts,
  onSelect,
}: {
  files: AutoCodeConflictFile[];
  selected: string;
  drafts: Record<string, string>;
  onSelect: (path: string) => void;
}) {
  return (
    <aside className="w-56 shrink-0 overflow-y-auto border-r bg-muted/20">
      <div className="px-3 py-2 text-[10px] uppercase tracking-wide text-muted-foreground">
        Files
      </div>
      <ul className="space-y-0.5 px-1 pb-2">
        {files.map((f) => {
          const draft = drafts[f.path] ?? f.merged;
          const remaining = (draft.match(/^<{7}\s/gm) ?? []).length;
          const isSelected = f.path === selected;
          return (
            <li key={f.path}>
              <button
                type="button"
                onClick={() => onSelect(f.path)}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-[11px] font-mono',
                  isSelected
                    ? 'bg-background text-foreground'
                    : 'text-muted-foreground hover:bg-background/60',
                )}
                title={f.path}
              >
                <span className="truncate">{f.path}</span>
                <span
                  className={cn(
                    'shrink-0 rounded px-1.5 py-0 text-[9px] font-medium',
                    remaining > 0
                      ? 'bg-destructive/20 text-destructive'
                      : 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-400',
                  )}
                >
                  {remaining > 0 ? remaining : '✓'}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
