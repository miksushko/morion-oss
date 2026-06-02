import type {
  CanvasBranchStage,
  CanvasCliAgentStage,
  CanvasCompleteSinkStage,
  CanvasEjectStage,
  CanvasHumanGateStage,
  CanvasMcpToolStage,
  CanvasMoRouterStage,
  CanvasMoStage,
  CanvasRejectSinkStage,
  CanvasStage,
} from '../types';
import { KIND_LABELS } from '../agent-options';
import { SYNTHETIC_NODE_IDS } from '../marshal';
import { CliAgentBody } from './CliAgentBody';
import { McpToolBody } from './McpToolBody';
import { HumanGateBody } from './HumanGateBody';
import { BranchBody } from './BranchBody';
import { MoRouterBody } from './MoRouterBody';
import { EjectBody } from './EjectBody';
import { MoStageBody } from './MoStageBody';
import { SinkBody } from './SinkBody';

/**
 * Side panel dispatcher — shared header (kind badge + Delete + Close)
 * + a stage-id input + one of the per-kind body components.
 */
export function StagePanel({
  stage,
  onPatch,
  onRemove,
  canRemove,
  disabled,
  onClose,
}: {
  stage: CanvasStage;
  onPatch: (patch: Partial<CanvasStage>) => void;
  onRemove: () => void;
  canRemove: boolean;
  disabled?: boolean;
  onClose?: () => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wide">
          {KIND_LABELS[stage.kind]}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onRemove}
            disabled={disabled || !canRemove}
            className="rounded-md border border-destructive/50 bg-destructive/10 px-2 py-0.5 text-[11px] text-destructive hover:bg-destructive/20 disabled:opacity-40"
            title={!canRemove ? 'Need at least one stage' : 'Delete stage'}
          >
            Delete
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close panel"
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              ×
            </button>
          )}
        </div>
      </div>
      <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
        Stage id
        <input
          value={stage.id}
          onChange={(e) => {
            const next = e.target.value;
            // Block reserved synthetic ids — graphToDefinition strips
            // nodes matching these on save, so allowing a rename into
            // them would silently drop the stage. Refuse the keystroke.
            if (SYNTHETIC_NODE_IDS.has(next)) return;
            onPatch({ id: next } as Partial<CanvasStage>);
          }}
          disabled={disabled}
          className="rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground"
        />
        <span className="text-[10px] text-muted-foreground">
          Letters, digits, dashes / underscores. Reserved ids
          (<code className="font-mono">__mo_orchestrator__</code>,{' '}
          <code className="font-mono">__mo_cancelled__</code>) are blocked.
        </span>
      </label>
      {stage.kind === 'cli_agent' && (
        <CliAgentBody
          stage={stage}
          onPatch={onPatch as (p: Partial<CanvasCliAgentStage>) => void}
          disabled={disabled}
        />
      )}
      {stage.kind === 'mcp_tool_call' && (
        <McpToolBody
          stage={stage}
          onPatch={onPatch as (p: Partial<CanvasMcpToolStage>) => void}
          disabled={disabled}
        />
      )}
      {stage.kind === 'human_gate' && (
        <HumanGateBody
          stage={stage}
          onPatch={onPatch as (p: Partial<CanvasHumanGateStage>) => void}
          disabled={disabled}
        />
      )}
      {stage.kind === 'branch' && (
        <BranchBody
          stage={stage}
          onPatch={onPatch as (p: Partial<CanvasBranchStage>) => void}
          disabled={disabled}
        />
      )}
      {stage.kind === 'mo_router' && (
        <MoRouterBody
          stage={stage}
          onPatch={onPatch as (p: Partial<CanvasMoRouterStage>) => void}
          disabled={disabled}
        />
      )}
      {stage.kind === 'eject' && (
        <EjectBody
          stage={stage}
          onPatch={onPatch as (p: Partial<CanvasEjectStage>) => void}
          disabled={disabled}
        />
      )}
      {stage.kind === 'mo_stage' && (
        <MoStageBody
          stage={stage}
          onPatch={onPatch as (p: Partial<CanvasMoStage>) => void}
          disabled={disabled}
        />
      )}
      {stage.kind === 'reject_sink' && (
        <SinkBody
          stage={stage}
          onPatch={onPatch as (p: Partial<CanvasRejectSinkStage>) => void}
          disabled={disabled}
          variant="reject"
        />
      )}
      {stage.kind === 'complete_sink' && (
        <SinkBody
          stage={stage}
          onPatch={onPatch as (p: Partial<CanvasCompleteSinkStage>) => void}
          disabled={disabled}
          variant="complete"
        />
      )}
    </div>
  );
}
