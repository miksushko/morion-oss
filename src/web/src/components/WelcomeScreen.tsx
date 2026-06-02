import { FileText, Search, Terminal, Keyboard } from 'lucide-react';

interface Props {
  onNewNote: () => void;
  onOpenSearch: () => void;
  onOpenSettings: () => void;
}

/**
 * Full-pane welcome overlay shown in the editor area when the notebook is
 * empty (first launch). Disappears as soon as the user creates their first
 * note. Intentionally static — no fetch, no state, pure presentation.
 */
export function WelcomeScreen({ onNewNote, onOpenSearch, onOpenSettings }: Props) {
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col items-center justify-center bg-background px-8 text-center">
      <div className="max-w-md space-y-6">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold text-foreground">Welcome to Morion</h1>
          <p className="text-sm text-muted-foreground">
            A local notebook that doubles as an MCP memory server.
            Your notes stay on this machine — no cloud, no account.
          </p>
        </div>

        <div className="space-y-3 text-left">
          <button
            type="button"
            onClick={onNewNote}
            className="flex w-full items-center gap-3 rounded-lg border border-border bg-accent/50 px-4 py-3 text-left transition-colors hover:bg-accent"
          >
            <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">Create your first note</p>
              <p className="text-xs text-muted-foreground">
                Or press <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">⌘N</kbd> anytime
              </p>
            </div>
          </button>

          <button
            type="button"
            onClick={onOpenSearch}
            className="flex w-full items-center gap-3 rounded-lg border border-border px-4 py-3 text-left transition-colors hover:bg-accent"
          >
            <Search className="h-5 w-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">Search your notes</p>
              <p className="text-xs text-muted-foreground">
                <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">⌘K</kbd> hybrid search across everything
              </p>
            </div>
          </button>

          <button
            type="button"
            onClick={onOpenSettings}
            className="flex w-full items-center gap-3 rounded-lg border border-border px-4 py-3 text-left transition-colors hover:bg-accent"
          >
            <Terminal className="h-5 w-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">Connect an LLM client</p>
              <p className="text-xs text-muted-foreground">
                Claude Desktop, Cursor, Cline, Zed — share memory across all your assistants
              </p>
            </div>
          </button>
        </div>

        <div className="flex items-center justify-center gap-4 pt-2 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Keyboard className="h-3 w-3" />
            Keyboard-first
          </span>
          <span>Local-only</span>
          <span>Markdown under the hood</span>
        </div>
      </div>
    </div>
  );
}
