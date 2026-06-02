import { WelcomeScreen } from './WelcomeScreen';
import { cn } from '../lib/cn';
import type { MobilePane } from '../appShellTypes';

/**
 * Empty-notebook onboarding panel. Shown only when "All notes" is
 * selected with zero notes — a selected empty FOLDER falls through to
 * the NotesList + EditorPane branch instead (NotesList renders a
 * "No notes yet. Hit ⌘N to start." hint, EditorPane shows "Select a
 * note or create a new one." so the user sees the folder chrome
 * instead of a global onboarding panel).
 */
export interface WelcomeViewProps {
  paneClass: (pane: MobilePane) => string;
  onNewNote: () => void | Promise<void>;
  onOpenSearch: () => void;
  onOpenMcpSettings: () => void;
}

export function WelcomeView({ paneClass, onNewNote, onOpenSearch, onOpenMcpSettings }: WelcomeViewProps) {
  return (
    <div className={cn('min-w-0 flex-1', paneClass('notes'), paneClass('editor'))}>
      <WelcomeScreen
        onNewNote={onNewNote}
        onOpenSearch={onOpenSearch}
        onOpenSettings={onOpenMcpSettings}
      />
    </div>
  );
}
