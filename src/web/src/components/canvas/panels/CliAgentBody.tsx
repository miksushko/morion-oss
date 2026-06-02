import type { CanvasAgent, CanvasCliAgentStage } from '../types';
import {
  AGENT_OPTIONS,
  SELECT_CLASS,
  providerOptionsFor,
  canonicalProviderFor,
  levelOptionsFor,
  modelPlaceholderFor,
  levelFootnoteFor,
} from '../agent-options';

export function CliAgentBody({
  stage,
  onPatch,
  disabled,
}: {
  stage: CanvasCliAgentStage;
  onPatch: (p: Partial<CanvasCliAgentStage>) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-2">
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        Tool (agent binary)
        <select
          value={stage.agent}
          onChange={(e) => {
            // Switching Tool may invalidate the current Provider choice
            // (e.g. claude → codex when provider was 'openai'). Re-
            // validate: keep provider when it's still in the new tool's
            // option list; otherwise drop to null (= canonical).
            const newAgent = e.target.value as CanvasAgent;
            const newOptions = providerOptionsFor(newAgent);
            const keepProvider =
              stage.provider && newOptions.includes(stage.provider);
            onPatch({
              agent: newAgent,
              ...(keepProvider ? {} : { provider: null }),
            });
          }}
          disabled={disabled}
          className={SELECT_CLASS}
        >
          {AGENT_OPTIONS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        Provider (API/auth path)
        <select
          value={stage.provider ?? canonicalProviderFor(stage.agent)}
          onChange={(e) => {
            const v = e.target.value;
            // Picking the canonical provider for this tool stores null
            // (= no override) so workflows stay L2-runnable. Picking any
            // other valid option stores the explicit value and routes
            // the workflow to draft mode.
            onPatch({
              provider: v === canonicalProviderFor(stage.agent) ? null : v,
            });
          }}
          disabled={disabled || providerOptionsFor(stage.agent).length <= 1}
          className={SELECT_CLASS}
        >
          {providerOptionsFor(stage.agent).map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        Model (vendor id; empty = adapter default)
        <input
          value={stage.model ?? ''}
          onChange={(e) =>
            onPatch({ model: e.target.value === '' ? null : e.target.value })
          }
          disabled={disabled}
          placeholder={modelPlaceholderFor(stage.agent)}
          className="rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground"
        />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        Level (effort/quality; semantics depend on the tool)
        <select
          value={stage.level ?? ''}
          onChange={(e) => {
            const v = e.target.value;
            // 'Default' is a UI synonym for adapter default — map to
            // null in the store so parseLinearWorkflow doesn't treat it
            // as a non-default v2 Agent Status field and route the
            // workflow to draft-only mode.
            onPatch({ level: v === '' || v === 'Default' ? null : v });
          }}
          disabled={disabled || levelOptionsFor(stage.agent).length <= 1}
          className={SELECT_CLASS}
        >
          <option value="">(adapter default)</option>
          {levelOptionsFor(stage.agent)
            .filter((l) => l !== 'Default')
            .map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
        </select>
        {levelFootnoteFor(stage.agent) && (
          <span className="text-[10px] text-muted-foreground/80">
            {levelFootnoteFor(stage.agent)}
          </span>
        )}
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        Agent instruction (free text — appended to the system prompt)
        <textarea
          value={stage.agentInstruction ?? ''}
          onChange={(e) => onPatch({ agentInstruction: e.target.value })}
          disabled={disabled}
          rows={3}
          placeholder='e.g. "Read CLAUDE.md and tasks/todo.md before writing code."'
          className="rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground"
        />
      </label>
      <div className="rounded-md border border-border bg-muted/30 p-2 space-y-2">
        <label className="flex flex-col gap-1 text-[11px] text-foreground">
          Fallback agent (runner spawns this when the primary hits a
          recoverable terminal error — e.g. codex Ink-crash)
          <select
            value={stage.fallbackAgent ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '') {
                // Switching to (none) wipes the fallback config
                // overrides too — otherwise stale Provider / Model /
                // Level / Instruction values silently come back when
                // the user later picks a fallback again.
                onPatch({
                  fallbackAgent: undefined,
                  fallbackProvider: null,
                  fallbackModel: null,
                  fallbackLevel: null,
                  fallbackAgentInstruction: '',
                });
              } else {
                onPatch({ fallbackAgent: v as CanvasAgent });
              }
            }}
            disabled={disabled}
            className={SELECT_CLASS}
          >
            <option value="">(none)</option>
            {AGENT_OPTIONS.filter((a) => a !== stage.agent).map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        {Boolean(stage.fallbackAgent) && (
          <div className="space-y-1.5 border-l-2 border-border pl-2">
            <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
              Fallback provider
              <select
                value={
                  stage.fallbackProvider ??
                  canonicalProviderFor(stage.fallbackAgent as CanvasAgent)
                }
                onChange={(e) => {
                  const v = e.target.value;
                  onPatch({
                    fallbackProvider:
                      v ===
                      canonicalProviderFor(stage.fallbackAgent as CanvasAgent)
                        ? null
                        : v,
                  });
                }}
                disabled={
                  disabled ||
                  providerOptionsFor(stage.fallbackAgent as CanvasAgent).length <= 1
                }
                className={SELECT_CLASS}
              >
                {providerOptionsFor(stage.fallbackAgent as CanvasAgent).map(
                  (p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ),
                )}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
              Fallback model (vendor id; empty = adapter default)
              <input
                value={stage.fallbackModel ?? ''}
                onChange={(e) =>
                  onPatch({
                    fallbackModel:
                      e.target.value === '' ? null : e.target.value,
                  })
                }
                disabled={disabled}
                placeholder={modelPlaceholderFor(stage.fallbackAgent)}
                className="rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground"
              />
            </label>
            <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
              Fallback level
              <select
                value={stage.fallbackLevel ?? ''}
                onChange={(e) => {
                  const v = e.target.value;
                  onPatch({
                    fallbackLevel: v === '' || v === 'Default' ? null : v,
                  });
                }}
                disabled={disabled}
                className={SELECT_CLASS}
              >
                <option value="">(use Tool default)</option>
                {levelOptionsFor(stage.fallbackAgent)
                  .filter((l) => l !== 'Default')
                  .map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[10px] text-muted-foreground">
              Fallback agent instruction
              <textarea
                value={stage.fallbackAgentInstruction ?? ''}
                onChange={(e) =>
                  onPatch({ fallbackAgentInstruction: e.target.value })
                }
                disabled={disabled}
                rows={2}
                placeholder="(empty — fallback uses the primary's instruction)"
                className="rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground"
              />
            </label>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-[11px] text-muted-foreground">
          Budget $
          <input
            type="number"
            min={0}
            step={0.1}
            value={stage.maxBudgetUsd ?? ''}
            onChange={(e) =>
              onPatch({
                maxBudgetUsd:
                  e.target.value === '' ? null : Number(e.target.value),
              })
            }
            disabled={disabled}
            className="rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground"
          />
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-[11px] text-muted-foreground">
          Max attempts
          <input
            type="number"
            min={1}
            value={stage.maxAttempts ?? 1}
            onChange={(e) =>
              onPatch({ maxAttempts: Math.max(1, Number(e.target.value)) })
            }
            disabled={disabled}
            className="rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground"
          />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        Prompt template
        <textarea
          value={stage.promptTemplate}
          onChange={(e) => onPatch({ promptTemplate: e.target.value })}
          disabled={disabled}
          rows={6}
          spellCheck={false}
          className="rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[11px] text-foreground"
        />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        Allowed tools (comma-sep)
        <input
          value={(stage.allowedTools ?? []).join(', ')}
          onChange={(e) =>
            onPatch({
              allowedTools: e.target.value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
          disabled={disabled}
          className="rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground"
        />
      </label>
    </div>
  );
}
