import { Bot, X } from 'lucide-react';
import type { AutoCodeQueueRow } from '../../lib/api';

interface DrawerHeaderProps {
  taskTitle: string;
  runs: AutoCodeQueueRow[];
  selectedRowId: string | null;
  onSelectRow: (id: string) => void;
  onClose: () => void;
}

export function DrawerHeader({
  taskTitle,
  runs,
  selectedRowId,
  onSelectRow,
  onClose,
}: DrawerHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
          <Bot className="h-3.5 w-3.5" /> Mo · auto-code activity
        </div>
        <div className="mt-1 truncate text-sm font-medium" title={taskTitle}>
          {taskTitle}
        </div>
        {runs.length > 1 && (
          <div className="mt-2 flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Run:</span>
            <select
              value={selectedRowId ?? ''}
              onChange={(e) => onSelectRow(e.target.value)}
              className="rounded border bg-background px-2 py-1 text-xs"
            >
              {runs.map((r, idx) => (
                <option key={r.id} value={r.id}>
                  #{runs.length - idx} · {r.state} · {new Date(r.createdAt).toLocaleString()}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onClose}
        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label="Close"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
