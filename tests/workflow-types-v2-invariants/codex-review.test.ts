import { describe, it, expect } from 'vitest';
import { WorkflowDefinitionSchema } from '../../src/core/auto-code/workflows/types/index.js';
import {
  isDraftWorkflowDefinition,
  parseLinearWorkflow,
} from '../../src/core/auto-code/workflows/parse-linear.js';
import {
  cliAgentStage,
  moStage,
  rejectSink,
  completeSink,
} from '../helpers/workflow-types-fixtures.js';

describe('Codex review round 2 fixes', () => {
  it('decision stage rejects two outbound edges with the same branch label', () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        schemaVersion: 1,
        name: 'dup-edge',
        stages: [
          moStage('start', { isStart: true, branches: ['approve', 'reject'] }),
          rejectSink(),
          completeSink(),
        ],
        edges: [
          { from: 'start', to: 'complete', on: 'approve' },
          // Second edge with the same label — ambiguous routing.
          { from: 'start', to: 'reject', on: 'approve' },
          { from: 'start', to: 'reject', on: 'reject' },
        ],
      }),
    ).toThrow(/2 outbound edges with on="approve"|at most one|exactly one is required/i);
  });

  it('terminal eject sink rejects outbound edges (unconditional rule)', () => {
    // No v2-proper kinds — the v2 invariants block doesn't fire, but
    // the no-outbound-from-sink rule is now unconditional and covers
    // legacy eject too.
    expect(() =>
      WorkflowDefinitionSchema.parse({
        schemaVersion: 1,
        name: 'legacy-eject-outbound',
        stages: [
          cliAgentStage('fix'),
          { id: 'reject', kind: 'eject', reason: 'gone' } as never,
        ],
        edges: [
          { from: 'fix', to: 'reject', on: 'success' },
          // Illegal — eject has no outbound.
          { from: 'reject', to: 'fix', on: 'success' },
        ],
      }),
    ).toThrow(/terminal sink|cannot have outbound/i);
  });

  it('parseLinearWorkflow accepts cli_agent with non-default Agent Status fields (plumbed in Phase 4)', () => {
    // Phase 4 plumbed provider / model / level / agentInstruction
    // through harness.spawn. The previous "reject silently-ignored
    // user intent" gate is gone — adapters receive the fields and
    // narrow them per their CLI.
    expect(() =>
      parseLinearWorkflow({
        schemaVersion: 1,
        name: 'cli-with-model',
        stages: [
          cliAgentStage('fix', {
            model: 'claude-opus-4-7',
          }),
        ],
        edges: [],
      }),
    ).not.toThrow();
  });

  it('parseLinearWorkflow accepts cli_agent at default Agent Status values', () => {
    expect(() =>
      parseLinearWorkflow({
        schemaVersion: 1,
        name: 'cli-defaults',
        stages: [cliAgentStage('fix')],
        edges: [],
      }),
    ).not.toThrow();
  });

  it('isDraftWorkflowDefinition stays false for cli_agent with non-default Agent Status fields (Phase 4 plumbs them)', () => {
    // Agent Status fields (provider / model / level / agentInstruction)
    // are no longer "draft" markers — runner forwards them through
    // harness.spawn, linear save path accepts them. Only true v2 stage
    // kinds (mo_stage / sinks / human_gate) route to the draft save
    // path now.
    expect(
      isDraftWorkflowDefinition({
        schemaVersion: 1,
        name: 'cli-with-level',
        stages: [cliAgentStage('fix', { level: 'High' })],
        edges: [],
      }),
    ).toBe(false);
  });

  it('isDraftWorkflowDefinition stays false for cli_agent at full defaults', () => {
    expect(
      isDraftWorkflowDefinition({
        schemaVersion: 1,
        name: 'cli-defaults',
        stages: [cliAgentStage('fix')],
        edges: [],
      }),
    ).toBe(false);
  });
});
