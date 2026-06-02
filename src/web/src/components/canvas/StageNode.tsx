import { useEffect } from 'react';
import {
  Handle,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react';
import type { CanvasStage } from './types';
import { KIND_LABELS, KIND_STYLES } from './agent-options';
import { NODE_WIDTH, NODE_HEIGHT, HANDLE_STYLE } from './marshal';

/**
 * Canvas node renderer. Drives:
 *  - per-kind colour + label via KIND_STYLES / KIND_LABELS,
 *  - Process Start (mo_stage.isStart) visual override,
 *  - multi-out routing handles for mo_stage / mo_router (one per branch,
 *    stable 60px slots so existing edges don't reflow when a new branch
 *    is added),
 *  - terminal sinks with NO source handle (eject / reject / complete),
 *  - side-attached human_gate (Left/Right handles so the dialog can sit
 *    beside its calling Mo node without crossing the canvas diagonally),
 *  - useUpdateNodeInternals on branch/isStart change so xyflow re-measures
 *    dynamically-added labelled handles (otherwise the new handle's
 *    drag target stays stuck at the position it had on first mount).
 *
 *  Pre-v2 decorative nodes (mo_orchestrator / mo_cancelled_sink) were
 *  removed 2026-05-16 — they had no live callers and xyflow v12 renders
 *  unknown node types as default fallback (not a crash) so legacy
 *  localStorage with those types degrades gracefully.
 */

function StageNode({ id, data, selected }: NodeProps) {
  const stage = (data as { stage: CanvasStage }).stage;
  // Tell xyflow to re-measure this node's handles whenever the
  // branch/option list changes. Without this, dynamically added
  // labelled source handles aren't draggable on first edit — xyflow
  // caches handle positions on initial mount and doesn't notice new
  // ones until the next force-refresh.
  const updateNodeInternals = useUpdateNodeInternals();
  const branchKey =
    stage.kind === 'mo_stage' || stage.kind === 'mo_router'
      ? (stage.branches ?? []).join('|')
      : '';
  const isStartKey =
    stage.kind === 'mo_stage' && stage.isStart ? '1' : '0';
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, branchKey, isStartKey, updateNodeInternals]);
  let kindStyle: string = KIND_STYLES[stage.kind];
  let kindLabel: string = KIND_LABELS[stage.kind];
  // Process Start Step — visually distinct so the entry node stands
  // out from regular Mo decision nodes.
  if (stage.kind === 'mo_stage' && stage.isStart) {
    kindLabel = 'Mo · Process Start';
    kindStyle =
      'border-amber-400/70 bg-amber-400/15 ring-1 ring-amber-400/40';
  }
  const subtitle =
    stage.kind === 'cli_agent'
      ? stage.agent
      : stage.kind === 'mcp_tool_call'
        ? `Mo · ${stage.toolName}`
        : stage.kind === 'human_gate'
          ? 'Mo asks the user · text dialog'
          : stage.kind === 'mo_router'
            ? `${stage.branches?.length ?? 0} branches`
            : stage.kind === 'eject'
              ? 'Cancel ticket'
              : stage.kind === 'mo_stage'
                ? `${stage.branches?.length ?? 0} branches${stage.isStart ? ' · entry' : ''}`
                : stage.kind === 'reject_sink'
                  ? 'Backlog + Mo comment'
                  : stage.kind === 'complete_sink'
                    ? 'Done + Mo comment'
                    : `${stage.conditions?.length ?? 0} cond.`;
  const isDecision = stage.kind === 'mo_router' || stage.kind === 'mo_stage';
  const isMultiOut = isDecision;
  const isTerminalSink =
    stage.kind === 'eject' ||
    stage.kind === 'reject_sink' ||
    stage.kind === 'complete_sink';
  const branches = isDecision ? stage.branches : null;
  // Human In The Loop sits as a side-attached dialog on the Mo stage
  // that asked the question.
  const isSideAttached = stage.kind === 'human_gate';
  return (
    <div
      style={{
        // Multi-out nodes widen to fit all branch handles at stable
        // 60px slots (start at 30px, 30+60*N for the Nth). 30px right
        // margin so handles don't clip the border.
        width:
          isMultiOut && branches && branches.length > 0
            ? Math.max(NODE_WIDTH, 30 + branches.length * 60 + 30)
            : NODE_WIDTH,
        minHeight: NODE_HEIGHT,
        paddingBottom: isMultiOut ? 18 : undefined,
      }}
      className={
        'relative rounded-md border-2 px-3 py-2 text-[11px] shadow-sm ' +
        kindStyle +
        (selected ? ' ring-2 ring-ring' : '')
      }
    >
      {/* Process Start mo_stage is the workflow entry — no upstream
          node to receive an inbound edge, so hide the target handle. */}
      {!(stage.kind === 'mo_stage' && stage.isStart) && (
        <Handle
          type="target"
          position={isSideAttached ? Position.Left : Position.Top}
          style={HANDLE_STYLE}
        />
      )}
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wide opacity-75">
        <span>{kindLabel}</span>
        <span className="font-mono">{stage.id}</span>
      </div>
      <div className="mt-1 truncate font-mono text-[12px] font-medium">
        {subtitle}
      </div>
      {!isMultiOut && !isTerminalSink && (
        <Handle
          type="source"
          position={isSideAttached ? Position.Right : Position.Bottom}
          style={HANDLE_STYLE}
        />
      )}
      {isMultiOut && branches && branches.length > 0 && (
        <>
          {branches.map((branch, idx) => {
            // Stable per-slot offset from the LEFT edge — first handle
            // at 30px, subsequent every 60px to the right so existing
            // edges don't slide when a new branch is added.
            const left = 30 + idx * 60;
            return (
              <div key={branch}>
                <span
                  className="pointer-events-none absolute text-[9px] font-medium"
                  style={{
                    left,
                    bottom: 4,
                    transform: 'translateX(-50%)',
                  }}
                >
                  {branch}
                </span>
                <Handle
                  type="source"
                  position={Position.Bottom}
                  id={branch}
                  style={{ ...HANDLE_STYLE, left }}
                />
              </div>
            );
          })}
        </>
      )}
      {isMultiOut && (!branches || branches.length === 0) && (
        // Empty multi-out stage — render a single anchor so the user
        // can wire a placeholder edge while filling in branches.
        <Handle
          type="source"
          position={Position.Bottom}
          style={HANDLE_STYLE}
        />
      )}
    </div>
  );
}

export const NODE_TYPES = {
  stage: StageNode,
};
