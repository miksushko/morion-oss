import { describe, it, expect } from 'vitest';
import {
  isDraftWorkflowDefinition,
  parseDraftWorkflow,
  parseLinearWorkflow,
} from '../../src/core/auto-code/workflows/parse-linear.js';
import {
  cliAgentStage,
  moStage,
  rejectSink,
  completeSink,
} from '../helpers/workflow-types-fixtures.js';

describe('Draft-save path (parseDraftWorkflow / isDraftWorkflowDefinition)', () => {
  const aV2Workflow = {
    schemaVersion: 1,
    name: 'v2-draft',
    stages: [
      moStage('start', { isStart: true }),
      rejectSink(),
      completeSink(),
    ],
    edges: [
      { from: 'start', to: 'complete', on: 'approve' },
      { from: 'start', to: 'reject', on: 'reject' },
    ],
  };

  const aLegacyLinearWorkflow = {
    schemaVersion: 1,
    name: 'legacy',
    stages: [cliAgentStage('fix')],
    edges: [],
  };

  it('isDraftWorkflowDefinition returns true for any v2 stage kind', () => {
    expect(isDraftWorkflowDefinition(aV2Workflow)).toBe(true);
    expect(
      isDraftWorkflowDefinition({
        ...aLegacyLinearWorkflow,
        stages: [{ id: 'r', kind: 'mo_router', prompt: '', branches: [] }],
      }),
    ).toBe(true); // deprecated alias counts as v2
    expect(
      isDraftWorkflowDefinition({
        ...aLegacyLinearWorkflow,
        stages: [{ id: 'e', kind: 'eject', reason: 'gone' }],
      }),
    ).toBe(true); // deprecated alias counts as v2
  });

  it('isDraftWorkflowDefinition returns false for legacy linear workflows', () => {
    expect(isDraftWorkflowDefinition(aLegacyLinearWorkflow)).toBe(false);
  });

  it('isDraftWorkflowDefinition returns false for malformed input (no crash)', () => {
    expect(isDraftWorkflowDefinition(null)).toBe(false);
    expect(isDraftWorkflowDefinition({})).toBe(false);
    expect(isDraftWorkflowDefinition({ stages: 'oops' })).toBe(false);
    expect(isDraftWorkflowDefinition({ stages: [{}] })).toBe(false);
  });

  it('parseDraftWorkflow accepts a v2 workflow (full Zod validation)', () => {
    expect(() => parseDraftWorkflow(aV2Workflow)).not.toThrow();
  });

  it('parseDraftWorkflow still applies v2 superRefine invariants', () => {
    // Two start markers — caught by the v2 invariants block even on the
    // draft-save path.
    expect(() =>
      parseDraftWorkflow({
        schemaVersion: 1,
        name: 'two-starts',
        stages: [
          moStage('s1', { isStart: true }),
          moStage('s2', { isStart: true }),
          rejectSink(),
          completeSink(),
        ],
        edges: [
          { from: 's1', to: 'complete', on: 'approve' },
          { from: 's1', to: 'reject', on: 'reject' },
          { from: 's2', to: 'complete', on: 'approve' },
          { from: 's2', to: 'reject', on: 'reject' },
        ],
      }),
    ).toThrow(/isStart=true/i);
  });

  it('parseLinearWorkflow rejects v2 drafts at dispatch with a clean L3/L4 message', () => {
    expect(() => parseLinearWorkflow(aV2Workflow)).toThrow(
      /reserved for L3\/L4|mo_stage/i,
    );
  });
});
