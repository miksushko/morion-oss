import { describe, it, expect } from 'vitest';
import { WorkflowDefinitionSchema } from '../../src/core/auto-code/workflows/types/index.js';
import {
  moStage,
  rejectSink,
  completeSink,
} from '../helpers/workflow-types-fixtures.js';

describe('mo_stage.branches refinements', () => {
  it('rejects fewer than 2 branches (degenerate decision node)', () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        schemaVersion: 1,
        name: 'one-branch',
        stages: [
          moStage('start', { isStart: true, branches: ['only-one'] }),
          rejectSink(),
          completeSink(),
        ],
        edges: [{ from: 'start', to: 'complete', on: 'only-one' }],
      }),
    ).toThrow(/at least 2|min/i);
  });

  it('rejects duplicate branch labels', () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        schemaVersion: 1,
        name: 'dup-branches',
        stages: [
          moStage('start', {
            isStart: true,
            branches: ['approve', 'approve'],
          }),
          rejectSink(),
          completeSink(),
        ],
        edges: [
          { from: 'start', to: 'complete', on: 'approve' },
          { from: 'start', to: 'reject', on: 'approve' },
        ],
      }),
    ).toThrow(/duplicate branch label/i);
  });
});
