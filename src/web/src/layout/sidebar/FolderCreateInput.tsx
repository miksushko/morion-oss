import { useEffect, useRef, useState } from 'react';
import { Folder as FolderIcon, LayoutGrid } from 'lucide-react';
import type { FolderViewMode } from '../../lib/api';

/** Inline create input — appears at the bottom of the relevant group
 *  (Folders or Kanban) when the user clicks the section's "+" button.
 *  Submits on Enter / blur, cancels on Escape. */
export function FolderCreateInput({
  onSubmit,
  onCancel,
  placeholder = 'Folder name',
  viewMode = 'list',
}: {
  onSubmit: (name: string) => Promise<void> | void;
  onCancel: () => void;
  placeholder?: string;
  viewMode?: FolderViewMode;
}) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div className="flex items-center gap-2 px-3 py-1">
      {viewMode === 'kanban' ? (
        <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <FolderIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
      <input
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => onSubmit(value.trim())}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onSubmit(value.trim());
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder={placeholder}
        className="flex-1 rounded-sm border border-border bg-background px-1 py-0.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
      />
    </div>
  );
}
