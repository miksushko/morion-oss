import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StageKindSchema } from '../src/core/auto-code/workflows/types/stage-kind.js';
import { CliAgentNameSchema } from '../src/core/auto-code/workflows/types/stages/cli-agent.js';
import { parseDraftWorkflow } from '../src/core/auto-code/workflows/parse-linear.js';
import { autoCodeToolPlugin } from '../src/server/tools/plugins/auto-code.js';

/**
 * Drift guard for the `morion-workflows` skill — Mo Workflows epic.
 *
 * The skill teaches external agents to author WorkflowDefinition JSON.
 * If the schema grows a stage kind / agent / tool the docs don't
 * mention (or the docs' example stops validating), agents will emit
 * broken JSON — these pins fail the build instead.
 */

const SKILL_DIR = join(__dirname, '..', 'skills', 'morion-workflows');

function read(rel: string): string {
  return readFileSync(join(SKILL_DIR, rel), 'utf8');
}

describe('morion-workflows skill — drift guards', () => {
  it('stage-kinds.md documents every StageKindSchema kind', () => {
    const doc = read('references/stage-kinds.md');
    for (const kind of StageKindSchema.options) {
      expect(doc, `stage kind "${kind}" missing from stage-kinds.md`).toContain(
        `\`${kind}\``,
      );
    }
  });

  it('agents.md documents every CliAgentNameSchema agent', () => {
    const doc = read('references/agents.md');
    for (const agent of CliAgentNameSchema.options) {
      expect(doc, `agent "${agent}" missing from agents.md`).toContain(
        `\`${agent}\``,
      );
    }
  });

  it('SKILL.md names every workflows_* MCP tool from the auto-code plugin', () => {
    const doc = read('SKILL.md');
    const workflowTools = autoCodeToolPlugin.tools
      .map((t) => t.name)
      .filter((n) => n.startsWith('workflows_'));
    expect(workflowTools.length).toBeGreaterThanOrEqual(6);
    for (const name of workflowTools) {
      expect(doc, `tool "${name}" missing from SKILL.md`).toContain(name);
    }
  });

  it('the annotated example in recipe.md validates as a draft workflow', () => {
    const doc = read('references/recipe.md');
    const fence = doc.match(/```jsonc\n([\s\S]*?)```/);
    expect(fence, 'recipe.md must contain a ```jsonc example block').toBeTruthy();
    // Strip the line comments the annotation uses — the example is
    // JSONC for readability, JSON for the schema.
    const json = fence![1]!.replace(/\s+\/\/[^\n"]*$/gm, '');
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(() => parseDraftWorkflow(parsed)).not.toThrow();
  });

  it('SKILL.md frontmatter declares the morion-workflows name + a version', () => {
    const doc = read('SKILL.md');
    expect(doc).toMatch(/^---\nname: morion-workflows\nversion: \d+\.\d+\.\d+\n/);
  });

  it('stage-kinds.md documents the deterministic context channels ("Mo = router" epic)', () => {
    // These template keys are the load-bearing verbatim channels; if
    // the runner grows/renames one the skill must keep teaching it.
    const doc = read('references/stage-kinds.md');
    for (const key of [
      '{{ticket.priorRuns}}',
      '{{stages.<stageId>.output.diffstat}}',
      '{{reopen.sourceFeedback}}',
      '{{reopen.moRationale}}',
      '{{reopen.userReply}}',
    ]) {
      expect(doc, `context key ${key} missing from stage-kinds.md`).toContain(
        key,
      );
    }
  });
});
