import { describe, it, expect } from 'vitest';
import { WorkflowDefinitionSchema } from '../../src/core/auto-code/workflows/types/index.js';
import {
  moStage,
  rejectSink,
  completeSink,
} from '../helpers/workflow-types-fixtures.js';

describe('Decision-stage edge.on ↔ branches validation', () => {
  it('rejects an outbound edge whose label is not a declared branch', () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        schemaVersion: 1,
        name: 'edge-extra-label',
        stages: [
          moStage('start', {
            isStart: true,
            branches: ['approve', 'reject'],
          }),
          rejectSink(),
          completeSink(),
        ],
        edges: [
          { from: 'start', to: 'complete', on: 'approve' },
          { from: 'start', to: 'reject', on: 'reject' },
          // "maybe" is not a declared branch.
          { from: 'start', to: 'complete', on: 'maybe' },
        ],
      }),
    ).toThrow(/not a declared branch/i);
  });

  it('accepts a declared branch with no outbound edge (allowed since 2026-05-11; reachability covers the real risk)', () => {
    // Relaxed per user feedback: branches without an edge are fine
    // at save time as long as the workflow still has a path from
    // Start to both terminals. Previously rejected; now treated as
    // a mid-edit state.
    expect(() =>
      WorkflowDefinitionSchema.parse({
        schemaVersion: 1,
        name: 'orphan-branch',
        stages: [
          moStage('start', {
            isStart: true,
            branches: ['approve', 'reject', 'maybe'],
          }),
          rejectSink(),
          completeSink(),
        ],
        edges: [
          { from: 'start', to: 'complete', on: 'approve' },
          { from: 'start', to: 'reject', on: 'reject' },
          // "maybe" branch declared but has no outbound edge — OK.
        ],
      }),
    ).not.toThrow();
  });

  it('rejects when no path from Start reaches a complete_sink', () => {
    // Workflow-level terminal reachability check (replaces the
    // strict per-branch rule). Graph wires Start -> Reject only;
    // Complete has no inbound path.
    expect(() =>
      WorkflowDefinitionSchema.parse({
        schemaVersion: 1,
        name: 'no-path-to-complete',
        stages: [
          moStage('start', { isStart: true, branches: ['approve', 'reject'] }),
          rejectSink(),
          completeSink(),
        ],
        edges: [
          // Both branches go to reject — Complete is unreachable.
          { from: 'start', to: 'reject', on: 'approve' },
          { from: 'start', to: 'reject', on: 'reject' },
        ],
      }),
    ).toThrow(/no path.*complete_sink/i);
  });

  it('rejects when no path from Start reaches a reject_sink', () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        schemaVersion: 1,
        name: 'no-path-to-reject',
        stages: [
          moStage('start', { isStart: true, branches: ['approve', 'reject'] }),
          rejectSink(),
          completeSink(),
        ],
        edges: [
          { from: 'start', to: 'complete', on: 'approve' },
          { from: 'start', to: 'complete', on: 'reject' },
        ],
      }),
    ).toThrow(/no path.*reject_sink/i);
  });

  it('accepts a v2 workflow with branches and edges fully aligned', () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        schemaVersion: 1,
        name: 'aligned',
        stages: [
          moStage('start', {
            isStart: true,
            branches: ['approve', 'reject'],
          }),
          rejectSink(),
          completeSink(),
        ],
        edges: [
          { from: 'start', to: 'complete', on: 'approve' },
          { from: 'start', to: 'reject', on: 'reject' },
        ],
      }),
    ).not.toThrow();
  });
});
