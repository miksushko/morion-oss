import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  LinearWorkflowError,
  parseLinearWorkflow,
} from '../src/core/auto-code/workflows/parse-linear.js';
import { LEGACY_LINEAR_AUTOCODE_DEFINITION } from '../src/core/auto-code/workflows/default-autocode.js';

const VALID_LINEAR = {
  schemaVersion: 1,
  name: 'Two-stage',
  stages: [
    { id: 'a', kind: 'cli_agent', agent: 'claude', promptTemplate: 'A' },
    { id: 'b', kind: 'cli_agent', agent: 'codex', promptTemplate: 'B' },
  ],
  edges: [{ from: 'a', to: 'b', on: 'success' }],
};

describe('parseLinearWorkflow', () => {
  it('accepts a valid linear definition', () => {
    expect(() => parseLinearWorkflow(VALID_LINEAR)).not.toThrow();
  });

  it('accepts a definition with empty edges (runner walks array order)', () => {
    expect(() =>
      parseLinearWorkflow({ ...VALID_LINEAR, edges: [] }),
    ).not.toThrow();
  });

  it('accepts mcp_tool_call stages (Этап 4 — enabled 2026-05-10)', () => {
    expect(() =>
      parseLinearWorkflow({
        ...VALID_LINEAR,
        stages: [
          {
            id: 'a',
            kind: 'mcp_tool_call',
            toolName: 'notes_create',
            argsTemplate: { question: 'q' },
          },
          { id: 'b', kind: 'cli_agent', agent: 'codex', promptTemplate: 'B' },
        ],
      }),
    ).not.toThrow();
  });

  it('rejects human_gate stages (reserved for L3)', () => {
    // Wired into a full v2 graph (single-in / single-out per spec,
    // both terminals reachable) so v2 invariants pass — the L3
    // reserved-kind gate is the assertion.
    expect(() =>
      parseLinearWorkflow({
        schemaVersion: 1,
        name: 'human-gated',
        stages: [
          {
            id: 'mo_start',
            kind: 'mo_stage',
            instruction: '',
            branches: ['accept', 'reject'],
            postComment: true,
            isStart: true,
            allowedTools: null,
          },
          {
            id: 'a',
            kind: 'human_gate',
            prompt: 'Reply?',
          },
          { id: 'reject', kind: 'reject_sink', commentTemplate: '' },
          { id: 'complete', kind: 'complete_sink', commentTemplate: '' },
        ],
        edges: [
          { from: 'mo_start', to: 'a', on: 'accept' },
          { from: 'mo_start', to: 'reject', on: 'reject' },
          { from: 'a', to: 'complete', on: 'reply' },
        ],
      }),
    ).toThrow(/human_gate|reserved for L3\/L4/);
  });

  it('rejects branch stages (reserved for L4)', () => {
    expect(() =>
      parseLinearWorkflow({
        schemaVersion: 1,
        name: 'branched',
        stages: [
          {
            id: 'a',
            kind: 'branch',
            combinator: 'all',
            conditions: [{ field: 'x', op: 'eq', value: 1 }],
          },
        ],
      }),
    ).toThrow(/branch/);
  });

  it('rejects edge count not matching N-1', () => {
    expect(() =>
      parseLinearWorkflow({
        ...VALID_LINEAR,
        edges: [
          { from: 'a', to: 'b', on: 'success' },
          { from: 'a', to: 'b', on: 'success' },
        ],
      }),
    ).toThrow(/N-1 edges/);
  });

  it('rejects edges that do not match stage-array order', () => {
    expect(() =>
      parseLinearWorkflow({
        ...VALID_LINEAR,
        edges: [{ from: 'b', to: 'a', on: 'success' }],
      }),
    ).toThrow(/linear array order/);
  });

  it('rejects non-success edge labels', () => {
    expect(() =>
      parseLinearWorkflow({
        ...VALID_LINEAR,
        edges: [{ from: 'a', to: 'b', on: 'failure' }],
      }),
    ).toThrow(/on="success"/);
  });

  it('accepts mcp_tool_call stages alongside cli_agent (Этап 4)', () => {
    expect(() =>
      parseLinearWorkflow({
        schemaVersion: 1,
        name: 'Mixed',
        stages: [
          {
            id: 'summary',
            kind: 'mcp_tool_call',
            toolName: 'mo_ask',
            argsTemplate: { question: 'what?' },
          },
          {
            id: 'fix',
            kind: 'cli_agent',
            agent: 'claude',
            promptTemplate: 'Mo said {{stages.summary.output}}',
            maxBudgetUsd: 1,
            maxAttempts: 1,
            allowedTools: [],
          },
        ],
        edges: [{ from: 'summary', to: 'fix', on: 'success' }],
      }),
    ).not.toThrow();
  });

  it('still rejects human_gate / branch stages (L3 / L4 reserved)', () => {
    // human_gate wired into a full v2 graph (single in / single out
    // per the refined v2 spec) so v2 invariants pass — the L3
    // reserved-kind gate is what we're asserting here.
    expect(() =>
      parseLinearWorkflow({
        schemaVersion: 1,
        name: 'Bad',
        stages: [
          {
            id: 'mo_start',
            kind: 'mo_stage',
            instruction: '',
            branches: ['accept', 'reject'],
            postComment: true,
            isStart: true,
            allowedTools: null,
          },
          {
            id: 'gate',
            kind: 'human_gate',
            prompt: 'go?',
          },
          { id: 'reject', kind: 'reject_sink', commentTemplate: '' },
          { id: 'complete', kind: 'complete_sink', commentTemplate: '' },
        ],
        edges: [
          { from: 'mo_start', to: 'gate', on: 'accept' },
          { from: 'mo_start', to: 'reject', on: 'reject' },
          { from: 'gate', to: 'complete', on: 'reply' },
        ],
      }),
    ).toThrow(/cli_agent \+ mcp_tool_call/);
  });

  it('throws ZodError on shape failures (not LinearWorkflowError)', () => {
    expect(() =>
      parseLinearWorkflow({
        schemaVersion: 1,
        name: '',
        stages: [],
      }),
    ).toThrow(z.ZodError);
  });
});

describe('LEGACY_LINEAR_AUTOCODE_DEFINITION', () => {
  it('is a valid linear workflow', () => {
    // Already parsed at module load — re-parsing through the helper
    // verifies no drift between this snapshot and the parser contract.
    expect(() =>
      parseLinearWorkflow(LEGACY_LINEAR_AUTOCODE_DEFINITION),
    ).not.toThrow();
  });

  it('has fix → review cli_agent stages', () => {
    expect(LEGACY_LINEAR_AUTOCODE_DEFINITION.stages.map((s) => s.id)).toEqual([
      'fix',
      'review',
    ]);
    for (const stage of LEGACY_LINEAR_AUTOCODE_DEFINITION.stages) {
      expect(stage.kind).toBe('cli_agent');
    }
  });

  it('uses claude for fix and codex for review', () => {
    const fix = LEGACY_LINEAR_AUTOCODE_DEFINITION.stages[0];
    const review = LEGACY_LINEAR_AUTOCODE_DEFINITION.stages[1];
    expect(fix.kind).toBe('cli_agent');
    expect(review.kind).toBe('cli_agent');
    if (fix.kind === 'cli_agent') expect(fix.agent).toBe('claude');
    if (review.kind === 'cli_agent') expect(review.agent).toBe('codex');
  });

  it('caps fix at $2 and review at $1', () => {
    const fix = LEGACY_LINEAR_AUTOCODE_DEFINITION.stages[0];
    const review = LEGACY_LINEAR_AUTOCODE_DEFINITION.stages[1];
    if (fix.kind === 'cli_agent') expect(fix.maxBudgetUsd).toBe(2);
    if (review.kind === 'cli_agent') expect(review.maxBudgetUsd).toBe(1);
  });

  it('grants fix the standard write toolset', () => {
    const fix = LEGACY_LINEAR_AUTOCODE_DEFINITION.stages[0];
    if (fix.kind === 'cli_agent') {
      expect(fix.allowedTools).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash']);
    }
  });

  it('grants review a read-only Claude-safe toolset', () => {
    const review = LEGACY_LINEAR_AUTOCODE_DEFINITION.stages[1];
    if (review.kind === 'cli_agent') {
      expect(review.allowedTools).toEqual(['Read', 'Glob', 'Grep', 'Bash']);
    }
  });

  it('configures claude as the review fallback for codex_ink_crash', () => {
    const review = LEGACY_LINEAR_AUTOCODE_DEFINITION.stages[1];
    if (review.kind === 'cli_agent') {
      expect(review.agent).toBe('codex');
      expect(review.fallbackAgent).toBe('claude');
    }
  });
});
