import {
  Bot,
  CheckSquare,
  ChevronLeft,
  Plus,
  Share2,
  Sparkles,
} from 'lucide-react';
import type { Folder } from '../../lib/api';
import { cn } from '../../lib/cn';
import { ViewModeToggle } from '../../components/ViewModeToggle';

export function KanbanHeader({
  folder,
  notesCount,
  autoCodeEnabled,
  onOpenAutoCodeSettings,
  selectMode,
  onToggleSelectMode,
  onOpenConciergeSettings,
  conciergeEnabled,
  conciergeNeedsHuman,
  onChangeFolderViewMode,
  onShareFolderWithLLM,
  onNewNote,
  onMobileBack,
}: {
  folder: Folder;
  notesCount: number;
  autoCodeEnabled?: boolean;
  onOpenAutoCodeSettings?: () => void;
  selectMode: boolean;
  onToggleSelectMode: () => void;
  onOpenConciergeSettings?: () => void;
  conciergeEnabled?: boolean;
  conciergeNeedsHuman?: boolean;
  onChangeFolderViewMode: (next: 'list' | 'kanban') => Promise<void> | void;
  onShareFolderWithLLM: () => void;
  onNewNote: () => void;
  onMobileBack: () => void;
}) {
  return (
    <header className="relative flex h-14 shrink-0 items-center gap-2 border-b border-border px-3 pl-4 pr-3">
      <button
        type="button"
        onClick={onMobileBack}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
        aria-label="Back"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <h2 className="truncate text-sm font-semibold">{folder.name}</h2>
      <span className="text-xs text-muted-foreground">
        {notesCount} {notesCount === 1 ? 'card' : 'cards'}
      </span>
      {autoCodeEnabled !== undefined && onOpenAutoCodeSettings && (
        <button
          type="button"
          onClick={onOpenAutoCodeSettings}
          title={
            autoCodeEnabled
              ? 'Auto-code is ON — click to open settings, workflows, visual editor'
              : 'Auto-code is OFF — click to open settings and enable'
          }
          aria-label="Auto-code settings"
          className={cn(
            'ml-2 inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors',
            autoCodeEnabled
              ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300'
              : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          <Bot className="h-3.5 w-3.5" />
          Auto-code {autoCodeEnabled ? 'on' : 'off'}
        </button>
      )}
      <div className="ml-auto flex items-center gap-1">
        <ViewModeToggle
          value="kanban"
          onChange={(next) => void onChangeFolderViewMode(next)}
          className="mr-1"
        />
        <button
          type="button"
          onClick={onToggleSelectMode}
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium transition-colors',
            selectMode
              ? 'border-primary bg-primary/10 text-primary hover:bg-primary/15'
              : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
          title={selectMode ? 'Exit selection mode' : 'Select cards for bulk actions'}
          aria-pressed={selectMode}
        >
          <CheckSquare className="h-3.5 w-3.5" />
          {selectMode ? 'Cancel' : 'Select'}
        </button>
        {/* AI settings + Share — both ghost-style icon buttons. Status of
            Mo is communicated by a small dot inside the icon button, not
            by tinting the whole pill (which made it visually compete with
            primary CTAs). */}
        {onOpenConciergeSettings && (
          <button
            type="button"
            onClick={onOpenConciergeSettings}
            className="relative inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            title={
              conciergeEnabled
                ? 'Mo indexes this folder — open Folder Settings'
                : 'Folder Settings'
            }
            aria-label="Folder Settings"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {conciergeEnabled && (
              <span
                className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-emerald-500"
                aria-hidden
              />
            )}
            {conciergeNeedsHuman && (
              <span
                className="absolute -right-0.5 -top-0.5 inline-flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold text-primary-foreground"
                title="Mo is awaiting your reply"
              >
                !
              </span>
            )}
          </button>
        )}
        <button
          type="button"
          onClick={onShareFolderWithLLM}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Share folder with LLM"
          aria-label="Share folder with LLM"
        >
          <Share2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onNewNote}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-xs font-medium text-foreground hover:bg-accent"
          title="New note in this folder"
        >
          <Plus className="h-4 w-4" />
          New
        </button>
      </div>
    </header>
  );
}
