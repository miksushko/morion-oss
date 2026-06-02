import { describe, it, expect } from 'vitest';
import { WorkflowDefinitionSchema } from '../../src/core/auto-code/workflows/types/index.js';
import {
  moStage,
  rejectSink,
  completeSink,
} from '../helpers/workflow-types-fixtures.js';

describe('Workflow v2 invariants', () => {
  it('requires exactly one mo_stage with isStart=true (zero rejected)', () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        schemaVersion: 1,
        name: 'no-start',
        stages: [
          moStage('decide', { isStart: false }),
          rejectSink(),
          completeSink(),
        ],
        edges: [
          { from: 'decide', to: 'complete', on: 'approve' },
          { from: 'decide', to: 'reject', on: 'reject' },
        ],
      }),
    ).toThrow(/isStart=true|Process Start/i);
  });

  it('requires exactly one mo_stage with isStart=true (two rejected)', () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        schemaVersion: 1,
        name: 'two-starts',
        stages: [
          moStage('start1', { isStart: true }),
          moStage('start2', { isStart: true }),
          rejectSink(),
          completeSink(),
        ],
        edges: [
          { from: 'start1', to: 'complete', on: 'approve' },
          { from: 'start1', to: 'reject', on: 'reject' },
          { from: 'start2', to: 'complete', on: 'approve' },
          { from: 'start2', to: 'reject', on: 'reject' },
        ],
      }),
    ).toThrow(/isStart=true/i);
  });

  it('requires exactly one reject_sink', () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        schemaVersion: 1,
        name: 'two-rejects',
        stages: [
          moStage('start', { isStart: true }),
          rejectSink('r1'),
          rejectSink('r2'),
          completeSink(),
        ],
        edges: [
          { from: 'start', to: 'complete', on: 'approve' },
          { from: 'start', to: 'r1', on: 'reject' },
        ],
      }),
    ).toThrow(/reject_sink/i);
  });

  it('requires exactly one complete_sink', () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        schemaVersion: 1,
        name: 'no-complete',
        stages: [
          moStage('start', { isStart: true }),
          rejectSink(),
        ],
        edges: [
          { from: 'start', to: 'reject', on: 'approve' },
          { from: 'start', to: 'reject', on: 'reject' },
        ],
      }),
    ).toThrow(/complete_sink/i);
  });

  it('rejects outbound edges from terminal sinks', () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        schemaVersion: 1,
        name: 'sink-with-outbound',
        stages: [
          moStage('start', { isStart: true }),
          rejectSink(),
          completeSink(),
        ],
        edges: [
          { from: 'start', to: 'complete', on: 'approve' },
          { from: 'start', to: 'reject', on: 'reject' },
          // Illegal — sink can't fan out.
          { from: 'complete', to: 'reject', on: 'success' },
        ],
      }),
    ).toThrow(/terminal sink|sinks .* cannot have outbound/i);
  });
});
