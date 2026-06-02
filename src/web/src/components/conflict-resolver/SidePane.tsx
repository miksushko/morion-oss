/**
 * Read-only side pane (Ours / Theirs) in the conflict resolver.
 *
 * Extracted from ConflictResolverModal.tsx on 2026-05-16. Pure
 * presentational — renders a Monaco read-only editor, with a
 * graceful fallback message when the content is null (file too
 * large OR file added on the other side).
 */
import Editor from '@monaco-editor/react';

export function SidePane({
  title,
  content,
  size,
  language,
}: {
  title: string;
  content: string | null;
  size: number | null;
  language: string;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col border-l first:border-l-0">
      <div className="border-b bg-background/80 px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <div className="min-h-0 flex-1">
        {content === null ? (
          <div className="m-3 rounded-md border border-border bg-muted/40 p-3 text-[11px] text-muted-foreground">
            {size !== null && size > 200 * 1024
              ? `Too large to display (${(size / 1024).toFixed(1)} KB, limit 200 KB).`
              : 'File was added on the other side — no content here.'}
          </div>
        ) : (
          <Editor
            defaultLanguage={language}
            value={content}
            theme="vs-dark"
            options={{
              readOnly: true,
              minimap: { enabled: false },
              fontSize: 12,
              automaticLayout: true,
              scrollBeyondLastLine: false,
              renderLineHighlight: 'none',
            }}
          />
        )}
      </div>
    </div>
  );
}
