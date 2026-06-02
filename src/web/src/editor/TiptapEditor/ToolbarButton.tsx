import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

interface ToolbarButtonProps {
  active: boolean;
  onClick: () => void;
  label: string;
  children: ReactNode;
}

/**
 * Small toggle button used inside the editor's BubbleMenu. Active state
 * mirrors the corresponding Tiptap mark/node `isActive` lookup so the
 * user gets a visual cue on the current formatting under the cursor.
 *
 * Extracted from `../TiptapEditor.tsx` (2026-05-16, ticket
 * `01KRQYTJYX3NWJW5E1S4V1FDZ9`).
 */
export function ToolbarButton({ active, onClick, label, children }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
        active && 'bg-accent text-foreground',
      )}
    >
      {children}
    </button>
  );
}
