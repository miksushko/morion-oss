/**
 * Stage factory fixtures for workflow v2 invariant tests.
 *
 * Each builder returns a minimal stage shape the WorkflowDefinitionSchema
 * accepts as-is plus an `extras` slot for per-test overrides. Centralised
 * here so all 9 v2 invariant scenario files share the same defaults.
 */
export const cliAgentStage = (id: string, extras: Record<string, unknown> = {}) => ({
  id,
  kind: 'cli_agent' as const,
  agent: 'claude' as const,
  promptTemplate: 'do work',
  maxBudgetUsd: null,
  maxAttempts: 1,
  allowedTools: [],
  ...extras,
});

export const moStage = (id: string, extras: Record<string, unknown> = {}) => ({
  id,
  kind: 'mo_stage' as const,
  instruction: '',
  branches: ['approve', 'reject'],
  postComment: true,
  isStart: false,
  allowedTools: null,
  ...extras,
});

export const rejectSink = (id = 'reject', extras: Record<string, unknown> = {}) => ({
  id,
  kind: 'reject_sink' as const,
  commentTemplate: '',
  ...extras,
});

export const completeSink = (id = 'complete', extras: Record<string, unknown> = {}) => ({
  id,
  kind: 'complete_sink' as const,
  commentTemplate: '',
  ...extras,
});
