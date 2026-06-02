import { useEffect, useState } from 'react';
import type {
  CanvasAgent,
  CanvasMoStage,
  CanvasMoModelOverride,
} from '../types';
import {
  SELECT_CLASS,
  providerOptionsFor,
  canonicalProviderFor,
  levelOptionsFor,
} from '../agent-options';

export function MoStageBody({
  stage,
  onPatch,
  disabled,
}: {
  stage: CanvasMoStage;
  onPatch: (p: Partial<CanvasMoStage>) => void;
  disabled?: boolean;
}) {
  const override = stage.modelOverride ?? { useDefault: true as const };
  const useDefaultModel = override.useDefault;
  const overrideTool = !override.useDefault ? override.tool ?? '' : '';
  const overrideProvider = !override.useDefault
    ? override.provider ?? ''
    : '';
  const overrideModel = !override.useDefault ? override.model ?? '' : '';
  const overrideLevel = !override.useDefault ? override.level ?? '' : '';
  const allowedToolsValue =
    stage.allowedTools === null || stage.allowedTools === undefined
      ? ''
      : stage.allowedTools.join(', ');
  // Local raw-text buffer for the comma-separated branches input.
  // Without this the input.value derives from `stage.branches.join(', ')`
  // on every keystroke and the `.filter(Boolean)` parse strips trailing
  // empty strings — meaning the moment the user types "," after a
  // branch name the input re-renders without the comma, making it
  // impossible to add a second branch through keyboard input. We keep
  // the raw typing buffer + still patch a clean (filtered) array
  // upstream so the schema sees valid `branches: string[]` at all times.
  const branchesKey = (stage.branches ?? []).join('|');
  const [branchesText, setBranchesText] = useState(
    (stage.branches ?? []).join(', '),
  );
  useEffect(() => {
    setBranchesText((stage.branches ?? []).join(', '));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchesKey]);
  const patchOverride = (next: CanvasMoModelOverride | undefined) => {
    onPatch({ modelOverride: next });
  };
  return (
    <div className="space-y-2">
      <div className="rounded-md border border-fuchsia-500/30 bg-fuchsia-500/10 p-2 text-[10px] text-fuchsia-700 dark:text-fuchsia-300">
        {stage.isStart
          ? 'Process Start Mo — the workflow entry node. Pinned to one per definition; you can move it but not duplicate or delete it.'
          : 'Mo decision stage. Mo reads the ticket context + your instruction + the branches list, picks one branch, and the runner advances along the matching outbound edge. DAG runtime lands with Phase 4.'}
      </div>
      <label className="flex items-center gap-2 text-[11px] text-foreground">
        <input
          type="checkbox"
          checked={stage.postComment !== false}
          onChange={(e) => onPatch({ postComment: e.target.checked })}
          disabled={disabled}
          className="h-3.5 w-3.5"
        />
        Post comment on the ticket after deciding
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        Instruction (what Mo should decide)
        <textarea
          value={stage.instruction}
          onChange={(e) => onPatch({ instruction: e.target.value })}
          disabled={disabled}
          rows={4}
          placeholder="e.g. If the ticket has acceptance criteria, take 'approve'; otherwise 'reject'."
          className="rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground"
        />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        Branches (comma-separated; min 2, unique)
        <input
          value={branchesText}
          onChange={(e) => {
            const text = e.target.value;
            setBranchesText(text);
            const branches = text
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            onPatch({ branches });
          }}
          disabled={disabled}
          placeholder="approve, reject"
          className="rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground"
        />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        Allowed MCP tools (comma-separated; empty = default set; "none" = pure LLM)
        <input
          value={allowedToolsValue}
          onChange={(e) => {
            const raw = e.target.value.trim();
            if (raw === '') {
              onPatch({ allowedTools: null });
              return;
            }
            if (raw.toLowerCase() === 'none') {
              onPatch({ allowedTools: [] });
              return;
            }
            const tools = raw
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            onPatch({ allowedTools: tools });
          }}
          disabled={disabled}
          placeholder="(folder default)"
          className="rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground"
        />
      </label>
      <div className="rounded-md border border-border bg-muted/30 p-2 space-y-2">
        <label className="flex items-center gap-2 text-[11px] text-foreground">
          <input
            type="checkbox"
            checked={useDefaultModel}
            onChange={(e) => {
              if (e.target.checked) {
                patchOverride({ useDefault: true });
              } else {
                patchOverride({ useDefault: false });
              }
            }}
            disabled={disabled}
            className="h-3.5 w-3.5"
          />
          Use folder default Mo model
        </label>
        {!useDefaultModel && (
          <div className="space-y-1.5">
            <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
              Tool
              <select
                value={overrideTool || 'claude'}
                onChange={(e) => {
                  const newTool = e.target.value as CanvasAgent;
                  const newOptions = providerOptionsFor(newTool);
                  const keepProvider =
                    overrideProvider && newOptions.includes(overrideProvider);
                  patchOverride({
                    useDefault: false,
                    tool: newTool,
                    provider: keepProvider ? overrideProvider : undefined,
                    model: overrideModel || undefined,
                    level: overrideLevel || undefined,
                  });
                }}
                disabled={disabled}
                className={SELECT_CLASS}
              >
                <option value="claude">claude</option>
                <option value="codex">codex</option>
                <option value="pi">pi</option>
                <option value="opencode">opencode</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
              Provider
              <select
                value={
                  overrideProvider ||
                  canonicalProviderFor((overrideTool || 'claude') as CanvasAgent)
                }
                onChange={(e) => {
                  const v = e.target.value;
                  const tool = (overrideTool || 'claude') as CanvasAgent;
                  patchOverride({
                    useDefault: false,
                    tool: overrideTool || undefined,
                    provider: v === canonicalProviderFor(tool) ? undefined : v,
                    model: overrideModel || undefined,
                    level: overrideLevel || undefined,
                  });
                }}
                disabled={
                  disabled ||
                  providerOptionsFor((overrideTool || 'claude') as CanvasAgent)
                    .length <= 1
                }
                className={SELECT_CLASS}
              >
                {providerOptionsFor((overrideTool || 'claude') as CanvasAgent).map(
                  (p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ),
                )}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
              Model
              <input
                value={overrideModel}
                onChange={(e) =>
                  patchOverride({
                    useDefault: false,
                    tool: overrideTool || undefined,
                    provider: overrideProvider || undefined,
                    model: e.target.value || undefined,
                    level: overrideLevel || undefined,
                  })
                }
                disabled={disabled}
                placeholder="(vendor id — e.g. claude-opus-4-7, gpt-5)"
                className="rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground"
              />
            </label>
            <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
              Level
              <select
                value={overrideLevel}
                onChange={(e) => {
                  const v = e.target.value;
                  // 'Default' === adapter default → drop to undefined.
                  // Storing the literal 'Default' string makes the
                  // schema discriminated union flag the override as
                  // "non-default" even though semantically nothing was
                  // overridden.
                  const level = v === '' || v === 'Default' ? undefined : v;
                  patchOverride({
                    useDefault: false,
                    tool: overrideTool || undefined,
                    provider: overrideProvider || undefined,
                    model: overrideModel || undefined,
                    level,
                  });
                }}
                disabled={disabled}
                className="rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground"
              >
                <option value="">(adapter default)</option>
                {levelOptionsFor(overrideTool)
                  .filter((l) => l !== 'Default')
                  .map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
              </select>
            </label>
          </div>
        )}
      </div>
    </div>
  );
}
