/**
 * Conflict pane — region nav + accept buttons + three Monaco editors
 * (Ours / Theirs / Merged-editable). Extracted from
 * ConflictResolverModal.tsx on 2026-05-16.
 *
 * The merged pane is a regular Editor (not DiffEditor) so the
 * conflict markers stay visible inline and the user can hand-edit
 * any region. The accept-current / accept-incoming / accept-both
 * buttons replace whichever conflict region the user is currently
 * navigated to.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { ArrowDown, ArrowUp } from 'lucide-react';

import type { AutoCodeConflictFile } from '../../lib/api';
import { inferLanguage } from './language';
import { applyAccept, parseConflictRegions } from './parse';
import { SidePane } from './SidePane';

export function ConflictPane({
  file,
  draft,
  onDraftChange,
}: {
  file: AutoCodeConflictFile;
  draft: string;
  onDraftChange: (next: string) => void;
}) {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const [regionIdx, setRegionIdx] = useState(0);
  const regions = useMemo(() => parseConflictRegions(draft), [draft]);
  const totalRegions = regions.length;

  // Highlight conflict regions with Monaco line decorations.
  const decoCollectionRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  useEffect(() => {
    const ed = editorRef.current;
    const mn = monacoRef.current;
    if (!ed || !mn) return;
    const model = ed.getModel();
    if (!model) return;
    const decorations = regions.map((r, i) => {
      const startLine = model.getPositionAt(r.start).lineNumber;
      const endLine = model.getPositionAt(r.end).lineNumber;
      return {
        range: new mn.Range(startLine, 1, endLine, 1),
        options: {
          isWholeLine: true,
          className:
            i === regionIdx
              ? 'conflict-region-active'
              : 'conflict-region',
          glyphMarginClassName: 'conflict-region-glyph',
        },
      };
    });
    if (decoCollectionRef.current) {
      decoCollectionRef.current.set(decorations);
    } else {
      decoCollectionRef.current = ed.createDecorationsCollection(decorations);
    }
  }, [regions, regionIdx, draft]);

  const goToRegion = useCallback(
    (idx: number) => {
      const ed = editorRef.current;
      if (!ed) return;
      const r = regions[idx];
      if (!r) return;
      const model = ed.getModel();
      if (!model) return;
      const startLine = model.getPositionAt(r.start).lineNumber;
      ed.revealLineInCenter(startLine);
      ed.setPosition({ lineNumber: startLine + 1, column: 1 });
      ed.focus();
      setRegionIdx(idx);
    },
    [regions],
  );

  const acceptCurrent = useCallback(() => {
    if (totalRegions === 0) return;
    const next = applyAccept(draft, regions[regionIdx]!, 'ours');
    onDraftChange(next);
    // After modifying, region count decreases — clamp index.
    setRegionIdx((i) => Math.max(0, Math.min(i, totalRegions - 2)));
  }, [draft, regions, regionIdx, totalRegions, onDraftChange]);

  const acceptIncoming = useCallback(() => {
    if (totalRegions === 0) return;
    const next = applyAccept(draft, regions[regionIdx]!, 'theirs');
    onDraftChange(next);
    setRegionIdx((i) => Math.max(0, Math.min(i, totalRegions - 2)));
  }, [draft, regions, regionIdx, totalRegions, onDraftChange]);

  const acceptBoth = useCallback(() => {
    if (totalRegions === 0) return;
    const next = applyAccept(draft, regions[regionIdx]!, 'both');
    onDraftChange(next);
    setRegionIdx((i) => Math.max(0, Math.min(i, totalRegions - 2)));
  }, [draft, regions, regionIdx, totalRegions, onDraftChange]);

  const onMergedMount: OnMount = (ed, mn) => {
    editorRef.current = ed;
    monacoRef.current = mn;
  };

  const language = useMemo(() => inferLanguage(file.path), [file.path]);

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      {/* Region nav + accept buttons */}
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <div className="text-[11px] text-muted-foreground">
          {totalRegions === 0
            ? 'No conflict regions remaining'
            : `Conflict ${Math.min(regionIdx + 1, totalRegions)} of ${totalRegions}`}
        </div>
        <button
          type="button"
          onClick={() => goToRegion(Math.max(0, regionIdx - 1))}
          disabled={regionIdx === 0 || totalRegions === 0}
          className="rounded p-0.5 text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Previous conflict"
        >
          <ArrowUp className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={() =>
            goToRegion(Math.min(totalRegions - 1, regionIdx + 1))
          }
          disabled={regionIdx >= totalRegions - 1 || totalRegions === 0}
          className="rounded p-0.5 text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Next conflict"
        >
          <ArrowDown className="h-3 w-3" />
        </button>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={acceptCurrent}
            disabled={totalRegions === 0}
            className="rounded border border-border bg-background px-2 py-0.5 text-[11px] hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
            title="Replace this conflict region with the HEAD (ours) version"
          >
            Accept current
          </button>
          <button
            type="button"
            onClick={acceptIncoming}
            disabled={totalRegions === 0}
            className="rounded border border-border bg-background px-2 py-0.5 text-[11px] hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
            title="Replace this conflict region with the incoming (branch) version"
          >
            Accept incoming
          </button>
          <button
            type="button"
            onClick={acceptBoth}
            disabled={totalRegions === 0}
            className="rounded border border-border bg-background px-2 py-0.5 text-[11px] hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
            title="Keep both versions in the merged result"
          >
            Accept both
          </button>
        </div>
      </div>

      {/* Three-pane layout */}
      <div className="flex min-h-0 flex-1">
        {file.binary ? (
          <div className="m-4 flex-1 rounded-md border border-border bg-muted/40 p-3 text-[12px]">
            Binary file — no text-level merge possible. Resolve by
            picking a side manually in your terminal (
            <code>git checkout --ours -- {file.path}</code> or{' '}
            <code>git checkout --theirs -- {file.path}</code>) then
            return here and click Apply.
          </div>
        ) : (
          <>
            <SidePane
              title="Ours (HEAD)"
              content={file.ours}
              size={file.oursSize}
              language={language}
            />
            <SidePane
              title="Theirs (incoming)"
              content={file.theirs}
              size={file.theirsSize}
              language={language}
            />
            <div className="flex min-w-0 flex-1 flex-col border-l">
              <div className="border-b bg-background/80 px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                Merged (edit me)
              </div>
              <div className="flex-1">
                <Editor
                  defaultLanguage={language}
                  value={draft}
                  onChange={(v) => onDraftChange(v ?? '')}
                  onMount={onMergedMount}
                  theme="vs-dark"
                  options={{
                    minimap: { enabled: false },
                    fontSize: 12,
                    glyphMargin: true,
                    automaticLayout: true,
                    scrollBeyondLastLine: false,
                  }}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
