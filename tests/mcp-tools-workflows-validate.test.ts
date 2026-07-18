import { describe, expect, it } from 'vitest';
import { workflowsValidateTool } from '../src/server/tools/plugins/auto-code.js';
import { setup } from './mcp-tools/helpers.js';
import {
  DEFAULT_AUTOCODE_DEFINITION,
  LEGACY_LINEAR_AUTOCODE_DEFINITION,
} from '../src/core/auto-code/workflows/default-autocode.js';
import type { WorkflowDefinition } from '../src/core/auto-code/workflows/types/index.js';

/**
 * `workflows_validate` MCP tool — Mo Workflows epic.
 *
 * The dry-run half of the external agent's build → validate → fix →
 * create loop. The individual superRefine invariants are pinned in
 * tests/workflow-types-v2-invariants.test.ts — here we pin the
 * ENVELOPE mapping: ok/summary on success, structured issues on
 * failure, and the saveable-but-not-runnable draft distinction.
 */

const tc = setup().tc;

function clone(def: WorkflowDefinition): WorkflowDefinition {
  return structuredClone(def) as WorkflowDefinition;
}

interface ValidateResult {
  ok?: boolean;
  summary?: {
    stageCount: number;
    agentChain: string[];
    isDraft: boolean;
    runnable: boolean;
    runnableReason: string | null;
  };
  error?: string;
  message?: string;
  issues?: Array<{ path: string; message: string }>;
}

async function run(definition: unknown): Promise<ValidateResult> {
  return (await workflowsValidateTool.handler(
    { definition: definition as Record<string, unknown> },
    tc,
  )) as ValidateResult;
}

describe('MCP tools — workflows_validate', () => {
  it('accepts the shipped v2 default template: draft + runnable', async () => {
    const res = await run(DEFAULT_AUTOCODE_DEFINITION);
    expect(res.ok).toBe(true);
    expect(res.summary?.stageCount).toBe(
      DEFAULT_AUTOCODE_DEFINITION.stages.length,
    );
    expect(res.summary?.isDraft).toBe(true);
    expect(res.summary?.runnable).toBe(true);
    expect(res.summary?.runnableReason).toBeNull();
    expect(res.summary?.agentChain.length).toBeGreaterThan(0);
  });

  it('accepts the legacy linear definition: non-draft + runnable', async () => {
    const res = await run(LEGACY_LINEAR_AUTOCODE_DEFINITION);
    expect(res.ok).toBe(true);
    expect(res.summary?.isDraft).toBe(false);
    expect(res.summary?.runnable).toBe(true);
  });

  it('maps Zod schema failures to structured issues (duplicate stage ids)', async () => {
    const def = clone(DEFAULT_AUTOCODE_DEFINITION);
    def.stages[1].id = def.stages[0].id;
    const res = await run(def);
    expect(res.error).toBe('invalid_workflow_definition');
    expect(res.issues?.length).toBeGreaterThan(0);
    expect(typeof res.issues?.[0].path).toBe('string');
    expect(typeof res.issues?.[0].message).toBe('string');
    expect(res.message).toBeTruthy();
  });

  it('rejects edges pointing at unknown stages', async () => {
    const def = clone(DEFAULT_AUTOCODE_DEFINITION);
    def.edges.push({ from: def.stages[0].id, to: 'no-such-stage', on: 'success' });
    const res = await run(def);
    expect(res.error).toBe('invalid_workflow_definition');
    expect(
      res.issues?.some((i) => i.message.includes('no-such-stage')),
    ).toBe(true);
  });

  it('rejects a v2 graph missing its complete_sink (cardinality invariant)', async () => {
    const def = clone(DEFAULT_AUTOCODE_DEFINITION);
    def.stages = def.stages.filter((s) => s.kind !== 'complete_sink');
    // Drop edges whose endpoints vanished with the sink.
    const ids = new Set(def.stages.map((s) => s.id));
    def.edges = def.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    const res = await run(def);
    expect(res.error).toBe('invalid_workflow_definition');
  });

  it('rejects terminal sinks with outbound edges', async () => {
    const def = clone(DEFAULT_AUTOCODE_DEFINITION);
    const sink = def.stages.find((s) => s.kind === 'complete_sink');
    def.edges.push({ from: sink!.id, to: def.stages[0].id, on: 'success' });
    const res = await run(def);
    expect(res.error).toBe('invalid_workflow_definition');
  });

  it('rejects graphs where a terminal sink is unreachable', async () => {
    const def = clone(DEFAULT_AUTOCODE_DEFINITION);
    const sink = def.stages.find((s) => s.kind === 'complete_sink');
    def.edges = def.edges.filter((e) => e.to !== sink!.id);
    const res = await run(def);
    expect(res.error).toBe('invalid_workflow_definition');
  });

  it('rejects a non-draft linear definition with out-of-order edges (create would throw too)', async () => {
    const def = clone(LEGACY_LINEAR_AUTOCODE_DEFINITION);
    expect(def.stages.length).toBeGreaterThanOrEqual(2);
    def.edges = [
      { from: def.stages[1].id, to: def.stages[0].id, on: 'success' },
    ];
    const res = await run(def);
    expect(res.error).toBe('invalid_workflow_definition');
    expect(res.issues?.length).toBe(1);
  });

  it('reports a saveable draft with a reserved stage kind as runnable:false', async () => {
    const def = clone(DEFAULT_AUTOCODE_DEFINITION);
    // `branch` parses (schema accepts it) but the runner reserves it —
    // saveable draft, not yet dispatchable.
    def.stages.push({
      id: 'branch_1',
      kind: 'branch',
      combinator: 'all',
      conditions: [{ field: 'status', op: 'eq', value: 'todo' }],
    } as WorkflowDefinition['stages'][number]);
    const res = await run(def);
    expect(res.ok).toBe(true);
    expect(res.summary?.isDraft).toBe(true);
    expect(res.summary?.runnable).toBe(false);
    expect(res.summary?.runnableReason).toContain('branch');
  });

  it('rejects garbage input with a structured envelope, never a throw', async () => {
    const res = await run({ not: 'a workflow' });
    expect(res.error).toBe('invalid_workflow_definition');
    expect(res.issues?.length).toBeGreaterThan(0);
  });
});
