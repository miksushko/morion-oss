import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TEMPLATE_ID,
  getWorkflowTemplate,
  listWorkflowTemplates,
  resolveWorkflowDefinition,
} from '../src/core/auto-code/workflows/templates.js';
import {
  DEFAULT_AUTOCODE_DEFINITION,
  LEGACY_LINEAR_AUTOCODE_DEFINITION,
} from '../src/core/auto-code/workflows/default-autocode.js';
import { parseDraftWorkflow } from '../src/core/auto-code/workflows/parse-linear.js';

/**
 * Registry tests under the Editor Model v2 spec (Morion note
 * 01KRAQWPXR5AYTFVF6J12TYHJ1) AFTER the 3-template trim
 * (ticket 01KRWRHFAK7HPQYV8GN72BW2VC).
 *
 * Shipped templates:
 *   1. plan-and-review-v2 — plan + plan_review + code + code_review
 *      (4 cli agents, Mo between each, human-in-loop after fix)
 *   2. default-v2        — code + code_review (2 cli agents, Mo,
 *      human-in-loop after fix). The "balanced" default.
 *   3. code-only-v2      — single cli agent, Mo at start + end,
 *      human-in-loop after fix.
 *
 * Every template is a v2 draft — the L2 linear runner can't dispatch
 * them; the Phase 4 DAG runner is the consumer.
 * resolveWorkflowDefinition's miss path falls back to
 * LEGACY_LINEAR_AUTOCODE_DEFINITION so unconfigured / unknown-id
 * folders keep working through the L2 runner until Phase 4 ships.
 */

describe('workflow templates registry (v2, 3-template trim)', () => {
  it('lists exactly the 3 base templates', () => {
    const ids = listWorkflowTemplates().map((t) => t.id);
    expect(ids).toEqual(['plan-and-review-v2', DEFAULT_TEMPLATE_ID, 'code-only-v2']);
  });

  it('DEFAULT_TEMPLATE_ID stays at "default-v2" (folder settings keyed on it)', () => {
    expect(DEFAULT_TEMPLATE_ID).toBe('default-v2');
  });

  it('every template parses as a v2 draft workflow', () => {
    for (const tpl of listWorkflowTemplates()) {
      expect(() => parseDraftWorkflow(tpl.definition)).not.toThrow();
      expect(tpl.definition.stages.length).toBeGreaterThan(0);
      // agentChain counts cli_agent stages only.
      const cliAgentCount = tpl.definition.stages.filter(
        (s) => s.kind === 'cli_agent',
      ).length;
      expect(tpl.agentChain.length).toBe(cliAgentCount);
    }
  });

  it('every template has exactly one Process Start mo_stage + one reject_sink + one complete_sink', () => {
    for (const tpl of listWorkflowTemplates()) {
      const starts = tpl.definition.stages.filter(
        (s) => s.kind === 'mo_stage' && s.isStart === true,
      );
      const rejects = tpl.definition.stages.filter(
        (s) => s.kind === 'reject_sink',
      );
      const completes = tpl.definition.stages.filter(
        (s) => s.kind === 'complete_sink',
      );
      expect(starts.length).toBe(1);
      expect(rejects.length).toBe(1);
      expect(completes.length).toBe(1);
    }
  });

  it('default-v2 (code + code review) has 2 cli_agent stages + 4 Mo stages', () => {
    const meta = getWorkflowTemplate(DEFAULT_TEMPLATE_ID);
    expect(meta).not.toBeNull();
    expect(meta!.definition).toBe(DEFAULT_AUTOCODE_DEFINITION);
    expect(meta!.agentChain).toEqual(['claude', 'codex']);
    const moStages = meta!.definition.stages.filter((s) => s.kind === 'mo_stage');
    expect(moStages.map((s) => s.id).sort()).toEqual([
      'mo_after_fix',
      'mo_after_review',
      'mo_start',
      'mo_tools',
    ]);
  });

  it('plan-and-review-v2 has 4 cli_agent stages + 6 Mo stages (extra mo_after_plan + mo_after_plan_review)', () => {
    const meta = getWorkflowTemplate('plan-and-review-v2');
    expect(meta).not.toBeNull();
    expect(meta!.agentChain).toEqual(['plan', 'plan_review', 'fix', 'review'].map(() => 'claude').map((_, i) => (i === 1 || i === 3 ? 'codex' : 'claude')));
    const cliStages = meta!.definition.stages.filter((s) => s.kind === 'cli_agent');
    expect(cliStages.map((s) => s.id).sort()).toEqual([
      'fix',
      'plan',
      'plan_review',
      'review',
    ]);
    const moStages = meta!.definition.stages.filter((s) => s.kind === 'mo_stage');
    expect(moStages.map((s) => s.id).sort()).toEqual([
      'mo_after_fix',
      'mo_after_plan',
      'mo_after_plan_review',
      'mo_after_review',
      'mo_start',
      'mo_tools',
    ]);
  });

  it('plan-and-review-v2 wires plan-review back-edge: mo_after_plan_review reopen → plan', () => {
    const meta = getWorkflowTemplate('plan-and-review-v2');
    expect(meta).not.toBeNull();
    const edges = meta!.definition.edges;
    const reopenEdge = edges.find(
      (e) => e.from === 'mo_after_plan_review' && e.on === 'reopen',
    );
    expect(reopenEdge?.to).toBe('plan');
    const approveEdge = edges.find(
      (e) => e.from === 'mo_after_plan_review' && e.on === 'approve',
    );
    expect(approveEdge?.to).toBe('fix');
  });

  it('code-only-v2 has 1 cli_agent + 3 Mo stages (no mo_after_review)', () => {
    const meta = getWorkflowTemplate('code-only-v2');
    expect(meta).not.toBeNull();
    expect(meta!.agentChain).toEqual(['claude']);
    const moStages = meta!.definition.stages.filter((s) => s.kind === 'mo_stage');
    expect(moStages.map((s) => s.id).sort()).toEqual([
      'mo_after_fix',
      'mo_start',
      'mo_tools',
    ]);
  });

  it('getWorkflowTemplate returns null on unknown / retired ids', () => {
    expect(getWorkflowTemplate(null)).toBeNull();
    expect(getWorkflowTemplate(undefined)).toBeNull();
    expect(getWorkflowTemplate('')).toBeNull();
    expect(getWorkflowTemplate('does-not-exist')).toBeNull();
    // Pre-trim template ids retired in ticket 01KRWRHFAK7HPQYV8GN72BW2VC —
    // existing folder settings pointing at them fall back through the
    // resolver's miss path to LEGACY_LINEAR.
    expect(getWorkflowTemplate('pi-fix-v2')).toBeNull();
    expect(getWorkflowTemplate('bug-fix-v2')).toBeNull();
    expect(getWorkflowTemplate('feature-planning-v2')).toBeNull();
    expect(getWorkflowTemplate('spike-v2')).toBeNull();
    expect(getWorkflowTemplate('docs-only-v2')).toBeNull();
    expect(getWorkflowTemplate('claude-solo-v2')).toBeNull();
    // Pre-v2 legacy ids never shipped to v2.
    expect(getWorkflowTemplate('default')).toBeNull();
    expect(getWorkflowTemplate('bug-fix')).toBeNull();
  });

  it('requiredAgents excludes primaries that have a fallbackAgent', () => {
    const def = getWorkflowTemplate(DEFAULT_TEMPLATE_ID);
    expect(def?.requiredAgents).toEqual(['claude']);
    expect(def?.optionalAgents).toEqual(['codex']);

    const full = getWorkflowTemplate('plan-and-review-v2');
    expect(full?.requiredAgents).toEqual(['claude']);
    expect(full?.optionalAgents).toEqual(['codex']);

    const solo = getWorkflowTemplate('code-only-v2');
    expect(solo?.requiredAgents).toEqual(['claude']);
    expect(solo?.optionalAgents).toEqual([]);
  });

  it('resolveWorkflowDefinition falls back to LEGACY_LINEAR on miss (bridge until Phase 4)', () => {
    // Miss path returns LEGACY linear — keeps unconfigured / retired-id
    // folders dispatching through the L2 runner.
    expect(resolveWorkflowDefinition('does-not-exist')).toBe(
      LEGACY_LINEAR_AUTOCODE_DEFINITION,
    );
    expect(resolveWorkflowDefinition(null)).toBe(
      LEGACY_LINEAR_AUTOCODE_DEFINITION,
    );
    expect(resolveWorkflowDefinition('default')).toBe(
      LEGACY_LINEAR_AUTOCODE_DEFINITION,
    );
    // Retired template ids ALSO fall back.
    expect(resolveWorkflowDefinition('pi-fix-v2')).toBe(
      LEGACY_LINEAR_AUTOCODE_DEFINITION,
    );
    // Hit path returns the v2 template definition.
    expect(resolveWorkflowDefinition(DEFAULT_TEMPLATE_ID)).toBe(
      DEFAULT_AUTOCODE_DEFINITION,
    );
    expect(resolveWorkflowDefinition('plan-and-review-v2')).not.toBe(
      LEGACY_LINEAR_AUTOCODE_DEFINITION,
    );
    expect(resolveWorkflowDefinition('code-only-v2')).not.toBe(
      LEGACY_LINEAR_AUTOCODE_DEFINITION,
    );
  });
});
