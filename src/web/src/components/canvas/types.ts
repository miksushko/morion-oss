/**
 * Workflow canvas definition types — mirror server-side WorkflowDefinition
 * shapes (src/core/auto-code/workflows/types/) but stay UI-only so the
 * editor can round-trip legacy + v2 stage kinds without dragging the Zod
 * runtime into the bundle.
 *
 * Editor Model v2 spec: Morion note 01KRAQWPXR5AYTFVF6J12TYHJ1.
 * Umbrella ticket: 01KR5F21709BKA6SFHWRFFVVPY.
 */

export type CanvasAgent = 'claude' | 'codex' | 'pi' | 'opencode';

export interface CanvasCliAgentStage {
  id: string;
  kind: 'cli_agent';
  agent: CanvasAgent;
  promptTemplate: string;
  maxBudgetUsd?: number | null;
  maxAttempts?: number;
  allowedTools?: string[];
  fallbackAgent?: CanvasAgent;
  verdictPolicy?: {
    onReopen?: { reopenStageId: string; maxAttempts?: number };
    onEscalate?: 'fail-run';
  };
  /** Phase 3 — Editor Model v2 Agent Status fields. All four nullable /
   *  optional; NULL = adapter default. Schema-level documentation in
   *  src/core/auto-code/workflows/types/ CliAgentStageSchema. */
  provider?: string | null;
  model?: string | null;
  level?: string | null;
  agentInstruction?: string;
  /** Same shape, applied when the fallback agent is spawned. */
  fallbackProvider?: string | null;
  fallbackModel?: string | null;
  fallbackLevel?: string | null;
  fallbackAgentInstruction?: string;
}

export interface CanvasMcpToolStage {
  id: string;
  kind: 'mcp_tool_call';
  toolName: string;
  argsTemplate?: Record<string, unknown>;
  maxAttempts?: number;
  maxBudgetUsd?: number | null;
}

export interface CanvasHumanGateStage {
  id: string;
  kind: 'human_gate';
  /** Phase 6 V2 — optional workflow-author hint to Mo about WHAT to ask
   *  the user. Empty = compose purely from context. Replaces the legacy
   *  static `prompt` field. */
  guidance?: string;
  /** Legacy — round-tripped so v1 workflow rows load. Editor promotes
   *  its content into `guidance` on save; new saves shouldn't emit it. */
  prompt?: string;
  /** Deprecated — kept optional so legacy rows round-trip cleanly.
   *  Per the refined v2 spec Human Loop is single-in / single-out. */
  options?: string[];
}

export interface CanvasBranchStage {
  id: string;
  kind: 'branch';
  combinator?: 'all' | 'any';
  conditions: Array<{
    field: string;
    op: 'eq' | 'neq' | 'in' | 'gt' | 'lt' | 'contains';
    value: string | number | boolean | string[];
  }>;
}

/** Mo-driven router stage (legacy). Visually the only stage with multiple
 *  outbound source handles — agents stay strictly 1-in / 1-out. */
export interface CanvasMoRouterStage {
  id: string;
  kind: 'mo_router';
  prompt: string;
  branches: string[];
}

/** Terminal "eject" sink (deprecated by `reject_sink`). Kept so existing
 *  canvas drafts open without errors; new flows should use `reject_sink`. */
export interface CanvasEjectStage {
  id: string;
  kind: 'eject';
  reason: string;
}

/** Per-stage model override for Mo decision stages. Discriminated union
 *  on useDefault to prevent the silent-ignore trap where
 *  {useDefault: true, level: 'High'} parses but override fields get
 *  dropped. */
export type CanvasMoModelOverride =
  | { useDefault: true }
  | {
      useDefault: false;
      tool?: string;
      provider?: string;
      model?: string;
      level?: string;
    };

/** Mo decision stage — replaces deprecated `mo_router`. Configurable
 *  per-stage model + optional allow-list of MCP tools. `isStart=true`
 *  pins one mo_stage as the canvas entry node; editor delete-guard
 *  prevents removal. */
export interface CanvasMoStage {
  id: string;
  kind: 'mo_stage';
  instruction: string;
  branches: string[];
  modelOverride?: CanvasMoModelOverride;
  postComment?: boolean;
  isStart?: boolean;
  allowedTools?: string[] | null;
}

/** Terminal reject sink — ticket → backlog + Mo comment. Pinned
 *  non-deletable. */
export interface CanvasRejectSinkStage {
  id: string;
  kind: 'reject_sink';
  commentTemplate?: string;
}

/** Terminal complete sink — ticket → done + Mo comment. Pinned
 *  non-deletable. */
export interface CanvasCompleteSinkStage {
  id: string;
  kind: 'complete_sink';
  commentTemplate?: string;
}

export type CanvasStage =
  | CanvasCliAgentStage
  | CanvasMcpToolStage
  | CanvasHumanGateStage
  | CanvasBranchStage
  | CanvasMoRouterStage
  | CanvasEjectStage
  | CanvasMoStage
  | CanvasRejectSinkStage
  | CanvasCompleteSinkStage;

export interface CanvasLayout {
  nodes?: Record<string, { x: number; y: number }>;
  edges?: Record<string, { cx: number; cy: number }>;
}

export interface CanvasDefinition {
  schemaVersion: 1;
  name: string;
  description?: string;
  stages: CanvasStage[];
  edges?: Array<{ from: string; to: string; on?: string }>;
  /** User-arranged canvas positions. Round-tripped through
   *  graphToDefinition / definitionToGraph so dragging a node + saving
   *  persists across reloads. Runtime ignores. */
  layout?: CanvasLayout;
}
