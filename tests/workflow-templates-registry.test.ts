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
 * 01KRAQWPXR5AYTFVF6J12TYHJ1). Trimmed to 3 base shapes in ticket
 * 01KRWRHFAK7HPQYV8GN72BW2VC, extended to 5 composition-distinct
 * flows in the Mo Workflows epic:
 *
 *   1. plan-and-review-v2     — plan + plan_review + code + code_review
 *   2. fix-review-docs-qa-v2  — code + review + docs + QA
 *   3. fix-review-docs-v2     — code + review + docs
 *   4. default-v2             — code + code_review. The default.
 *   5. code-only-v2           — single cli agent, Mo at start + end.
 *
 * resolveWorkflowDefinition's miss path falls back to
 * LEGACY_LINEAR_AUTOCODE_DEFINITION so unconfigured / unknown-id
 * folders keep working through the L2 runner.
 */

describe('workflow templates registry (v2, 5 canonical flows)', () => {
  it('lists exactly the 5 canonical flows in decreasing-complexity order', () => {
    const ids = listWorkflowTemplates().map((t) => t.id);
    expect(ids).toEqual([
      'plan-and-review-v2',
      'fix-review-docs-qa-v2',
      'fix-review-docs-v2',
      DEFAULT_TEMPLATE_ID,
      'code-only-v2',
    ]);
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

  it('fix-review-docs-v2 has 3 cli_agent stages + 5 Mo stages (mo_after_docs, no QA)', () => {
    const meta = getWorkflowTemplate('fix-review-docs-v2');
    expect(meta).not.toBeNull();
    expect(meta!.agentChain).toEqual(['claude', 'codex', 'claude']);
    const cliStages = meta!.definition.stages.filter((s) => s.kind === 'cli_agent');
    expect(cliStages.map((s) => s.id).sort()).toEqual(['docs', 'fix', 'review']);
    const moStages = meta!.definition.stages.filter((s) => s.kind === 'mo_stage');
    expect(moStages.map((s) => s.id).sort()).toEqual([
      'mo_after_docs',
      'mo_after_fix',
      'mo_after_review',
      'mo_start',
      'mo_tools',
    ]);
    // Review approval routes into docs, not straight to mo_tools.
    const approveEdge = meta!.definition.edges.find(
      (e) => e.from === 'mo_after_review' && e.on === 'approve',
    );
    expect(approveEdge?.to).toBe('docs');
    // Docs decision advances to mo_tools and can reopen the docs agent.
    const finishEdge = meta!.definition.edges.find(
      (e) => e.from === 'mo_after_docs' && e.on === 'finish',
    );
    expect(finishEdge?.to).toBe('mo_tools');
    const reopenEdge = meta!.definition.edges.find(
      (e) => e.from === 'mo_after_docs' && e.on === 'reopen',
    );
    expect(reopenEdge?.to).toBe('docs');
  });

  it('fix-review-docs-qa-v2 has 4 cli_agent stages + 6 Mo stages and chains docs → qa → mo_tools', () => {
    const meta = getWorkflowTemplate('fix-review-docs-qa-v2');
    expect(meta).not.toBeNull();
    expect(meta!.agentChain).toEqual(['claude', 'codex', 'claude', 'claude']);
    const cliStages = meta!.definition.stages.filter((s) => s.kind === 'cli_agent');
    expect(cliStages.map((s) => s.id).sort()).toEqual([
      'docs',
      'fix',
      'qa',
      'review',
    ]);
    const moStages = meta!.definition.stages.filter((s) => s.kind === 'mo_stage');
    expect(moStages.map((s) => s.id).sort()).toEqual([
      'mo_after_docs',
      'mo_after_fix',
      'mo_after_qa',
      'mo_after_review',
      'mo_start',
      'mo_tools',
    ]);
    const edges = meta!.definition.edges;
    // docs decision advances into qa (labelled "qa"), qa decision
    // finishes into mo_tools, and both stages have reopen back-edges.
    expect(
      edges.find((e) => e.from === 'mo_after_docs' && e.on === 'qa')?.to,
    ).toBe('qa');
    expect(
      edges.find((e) => e.from === 'mo_after_qa' && e.on === 'finish')?.to,
    ).toBe('mo_tools');
    expect(
      edges.find((e) => e.from === 'mo_after_qa' && e.on === 'reopen')?.to,
    ).toBe('qa');
  });

  it('shipped fix + review prompts wire the deterministic channels (priorRuns + diffstat)', () => {
    // "Mo = router, not narrator" epic — every fixer prompt reads
    // prior-run memory; every reviewer/docs/qa prompt reads the
    // fixer's diffstat facts. Guards against a template edit dropping
    // the channels.
    for (const tpl of listWorkflowTemplates()) {
      const cliStages = tpl.definition.stages.filter(
        (s): s is Extract<typeof s, { kind: 'cli_agent' }> =>
          s.kind === 'cli_agent',
      );
      const fixLike = cliStages.filter(
        (s) => s.id === 'fix' || s.id === 'plan',
      );
      for (const s of fixLike) {
        expect(
          s.promptTemplate,
          `${tpl.id}/${s.id} should read {{ticket.priorRuns}}`,
        ).toContain('{{ticket.priorRuns}}');
      }
      const reviewLike = cliStages.filter((s) =>
        ['review', 'docs', 'qa', 'plan_review'].includes(s.id),
      );
      for (const s of reviewLike) {
        // plan_review reviews the PLAN (no diff yet) — exempt.
        if (s.id === 'plan_review') continue;
        expect(
          s.promptTemplate,
          `${tpl.id}/${s.id} should read {{stages.fix.output.diffstat}}`,
        ).toContain('{{stages.fix.output.diffstat}}');
      }
    }
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
