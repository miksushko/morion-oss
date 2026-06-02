import { Play } from 'lucide-react';

export function EmptyState({ hasAnyRuns }: { hasAnyRuns: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <Play className="h-6 w-6 text-muted-foreground" />
      <div className="text-sm font-medium">
        {hasAnyRuns ? 'Pick a run from the picker above' : 'No auto-code runs yet'}
      </div>
      <div className="max-w-xs text-xs text-muted-foreground">
        {hasAnyRuns
          ? 'Once selected, the fix and review session transcripts will stream here live.'
          : 'Drag this ticket to the Todo column on a folder with auto-code enabled to kick off a run.'}
      </div>
    </div>
  );
}
