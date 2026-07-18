import {
  DEFAULT_AUTOCODE_DEFINITION,
  LEGACY_LINEAR_AUTOCODE_DEFINITION,
} from './default-autocode.js';
import type { CliAgentName, WorkflowDefinition } from './types/index.js';
import {
  FULL_PIPELINE_DEFINITION,
  FIX_REVIEW_DOCS_DEFINITION,
  FIX_REVIEW_DOCS_QA_DEFINITION,
  CODE_ONLY_DEFINITION,
} from './templates/definitions.js';

/**
 * Auto-code Workflow Builder — shipped workflow templates registry.
 *
 * Umbrella: 01KR5F21709BKA6SFHWRFFVVPY (Editor Model v2 spec — Morion
 * note 01KRAQWPXR5AYTFVF6J12TYHJ1).
 *
 * Each template is a v2 `WorkflowDefinition` built via
 * `buildAutocodeV2Template` (see default-autocode.ts), parsed at module
 * load through `parseDraftWorkflow` so the v2 superRefine invariants
 * fire on the shipped definitions before the user ever sees them.
 * Templates ARE drafts — the L2 linear runner can't dispatch them; the
 * Phase 4 DAG runner is the consumer. Until Phase 4 ships,
 * orchestrator.enqueueTicket returns a clean
 * `{kind:'rejected', reason:'workflow_not_runnable'}` envelope with a
 * user-readable message.
 *
 * Per-folder selection lives in a workspace setting
 * `auto_code.workflow_template.<folderId>`; missing value falls back to
 * `DEFAULT_TEMPLATE_ID`.
 *
 * Adding a template:
 *   1. Add a `WorkflowDefinition` constant in `templates/definitions.ts`
 *      (compose via `buildAutocodeV2Template`).
 *   2. If the prompt is reusable across templates, name it in
 *      `templates/prompts.ts`; otherwise inline it with the definition.
 *   3. Append a `WorkflowTemplateMeta` row to `ENTRIES` below.
 *   4. The HTTP route `GET /api/auto-code/workflow-templates` and the
 *      UI dropdown pick it up automatically — no other wiring needed.
 *
 * The L4 visual editor (separate epic) lets users persist their own
 * definitions to the `workflows` table; folder-scoped registry seeding
 * happens once per folder via `seedDefaultsForFolder`.
 */

export interface WorkflowTemplateMeta {
  /** Stable id used by `auto_code.workflow_template.<folderId>` and
   *  the UI dropdown. Lowercase + dashes. NEVER rename a shipped id —
   *  existing folder settings reference it by string. */
  readonly id: string;
  /** Short label for the dropdown ("Default", "Pi (local)", ...). */
  readonly label: string;
  /** One-line description shown under the dropdown / on hover. */
  readonly description: string;
  /** The parsed definition. Immutable; the orchestrator passes it
   *  straight to parseLinearWorkflow at run-start time. For v2 drafts
   *  parseLinearWorkflow throws LinearWorkflowError → orchestrator
   *  catches and returns `workflow_not_runnable`. */
  readonly definition: WorkflowDefinition;
  /** Quick agent summary for UI ("claude → codex"). Derived from
   *  `definition.stages[*].agent`. Computed once at module load. */
  readonly agentChain: readonly CliAgentName[];
  /** De-duplicated set of agents that MUST be installed for this
   *  template to run. A stage with `fallbackAgent` has its primary
   *  treated as OPTIONAL (the runner already routes around codex
   *  Ink-crash by falling back to claude — gating on codex would
   *  contradict that contract); only the fallback ends up in
   *  `requiredAgents`. UI disables the option when any required
   *  agent is unavailable; orchestrator soft-rejects pre-claim. */
  readonly requiredAgents: readonly CliAgentName[];
  /** Agents that participate in the workflow but are not strictly
   *  required (a fallback handles their absence). Surfaced in the
   *  UI as "Optional: codex (auto-falls back to claude)". Empty
   *  when no stage has a fallback. */
  readonly optionalAgents: readonly CliAgentName[];
}

// ---------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------

// v2 template ids carry a `-v2` suffix so seedDefaultsForFolder
// inserts them alongside any pre-v2 rows the folder already has.
// Old folders keep their existing default (the legacy linear shape);
// new folders pick `default-v2` as the seeded default automatically.
// The legacy registry ids ('default', 'bug-fix', etc.) are no longer
// shipped — folders pointing at them via stored `auto_code.workflow_template`
// settings fall back to LEGACY_LINEAR_AUTOCODE_DEFINITION via
// resolveWorkflowDefinition's miss path.
export const DEFAULT_TEMPLATE_ID = 'default-v2' as const;

function deriveAgentChain(def: WorkflowDefinition): readonly CliAgentName[] {
  return def.stages
    .filter((s): s is Extract<typeof s, { kind: 'cli_agent' }> => s.kind === 'cli_agent')
    .map((s) => s.agent);
}

/** Walk stages and split agents into hard-required vs optional.
 *
 * Rule (Codex P1 round 2, 2026-05-10): a stage with `fallbackAgent`
 * advertises a backup path the runner already takes on recoverable
 * spawn errors (codex Ink-crash → claude). Treating the primary as
 * hard-required would contradict that contract — a folder could
 * pick the default template on a machine without codex AND it would
 * still execute fine via the claude fallback. So:
 *
 *   - stage with fallback     → primary is OPTIONAL, fallback is REQUIRED.
 *   - stage without fallback  → primary is REQUIRED.
 *
 * Returns stable arrays sorted by enum order for deterministic UI +
 * test output.
 */
function splitAgents(
  def: WorkflowDefinition,
): { required: readonly CliAgentName[]; optional: readonly CliAgentName[] } {
  const required = new Set<CliAgentName>();
  const optional = new Set<CliAgentName>();
  for (const s of def.stages) {
    if (s.kind !== 'cli_agent') continue;
    if (s.fallbackAgent) {
      optional.add(s.agent);
      required.add(s.fallbackAgent);
    } else {
      required.add(s.agent);
    }
  }
  for (const r of required) optional.delete(r);
  const order: readonly CliAgentName[] = ['claude', 'codex', 'pi', 'opencode'];
  return {
    required: order.filter((a) => required.has(a)),
    optional: order.filter((a) => optional.has(a)),
  };
}

function deriveRequiredAgents(def: WorkflowDefinition): readonly CliAgentName[] {
  return splitAgents(def).required;
}

function deriveOptionalAgents(def: WorkflowDefinition): readonly CliAgentName[] {
  return splitAgents(def).optional;
}

// Ticket 01KRWRHFAK7HPQYV8GN72BW2VC trimmed the registry from 7
// agent-permutation templates to base SHAPES; the Mo Workflows epic
// (2026-07-14) extended it to five flows
// that differ by STAGE COMPOSITION only — never ship two templates
// that differ just by which agent fills a slot (that was the original
// 7-template mistake; agent slots are editable per-stage).
// Order matters: registry order drives UI dropdown order — sorted by
// decreasing pipeline complexity (4 agents → 1 agent).
const ENTRIES: readonly WorkflowTemplateMeta[] = [
  {
    id: 'plan-and-review-v2',
    label: 'Plan + plan review + code + code review · Mo-driven',
    description:
      'Four cli agents (plan → plan review → code → code review) with Mo between every handoff + human-in-the-loop after fix. Plan reviewer can reopen the planner; code reviewer can reopen the implementer. Best for large or ambiguous tickets.',
    definition: FULL_PIPELINE_DEFINITION,
    agentChain: deriveAgentChain(FULL_PIPELINE_DEFINITION),
    requiredAgents: deriveRequiredAgents(FULL_PIPELINE_DEFINITION),
    optionalAgents: deriveOptionalAgents(FULL_PIPELINE_DEFINITION),
  },
  {
    id: 'fix-review-docs-qa-v2',
    label: 'Code + review + docs + QA · Mo-driven',
    description:
      'Four cli agents: implementer → code review (claude-fallback) → docs agent aligns the documentation → QA agent writes functional tests (playwright specs or a manual checklist). Human-in-the-loop after fix. The full assembly line for user-visible features.',
    definition: FIX_REVIEW_DOCS_QA_DEFINITION,
    agentChain: deriveAgentChain(FIX_REVIEW_DOCS_QA_DEFINITION),
    requiredAgents: deriveRequiredAgents(FIX_REVIEW_DOCS_QA_DEFINITION),
    optionalAgents: deriveOptionalAgents(FIX_REVIEW_DOCS_QA_DEFINITION),
  },
  {
    id: 'fix-review-docs-v2',
    label: 'Code + review + docs · Mo-driven',
    description:
      'Three cli agents: implementer → code review (claude-fallback, can reopen the implementer) → docs agent updates README / docs / changelogs to match what shipped. Human-in-the-loop after fix. Use when user-facing docs must not drift.',
    definition: FIX_REVIEW_DOCS_DEFINITION,
    agentChain: deriveAgentChain(FIX_REVIEW_DOCS_DEFINITION),
    requiredAgents: deriveRequiredAgents(FIX_REVIEW_DOCS_DEFINITION),
    optionalAgents: deriveOptionalAgents(FIX_REVIEW_DOCS_DEFINITION),
  },
  {
    id: DEFAULT_TEMPLATE_ID,
    label: 'Code + code review · Mo-driven',
    description:
      'Two cli agents with Mo between them + human-in-the-loop after fix: Mo gate → Claude writes the diff → Mo decision → Codex review (claude-fallback) → Mo decision → Mo Tools → Complete. Reviewer can reopen the implementer; every Mo decision has a reject path. The default for new folders.',
    definition: DEFAULT_AUTOCODE_DEFINITION,
    agentChain: deriveAgentChain(DEFAULT_AUTOCODE_DEFINITION),
    requiredAgents: deriveRequiredAgents(DEFAULT_AUTOCODE_DEFINITION),
    optionalAgents: deriveOptionalAgents(DEFAULT_AUTOCODE_DEFINITION),
  },
  {
    id: 'code-only-v2',
    label: 'Code only · Mo-driven',
    description:
      'Single cli agent with Mo only at the start + end and human-in-the-loop where the agent surfaces a question. No reviewer pass. Best for trivial tickets or when you trust the upstream spec.',
    definition: CODE_ONLY_DEFINITION,
    agentChain: deriveAgentChain(CODE_ONLY_DEFINITION),
    requiredAgents: deriveRequiredAgents(CODE_ONLY_DEFINITION),
    optionalAgents: deriveOptionalAgents(CODE_ONLY_DEFINITION),
  },
] as const;

const REGISTRY: ReadonlyMap<string, WorkflowTemplateMeta> = new Map(
  ENTRIES.map((e) => [e.id, e]),
);

/** All shipped templates in registry order. UI dropdown + HTTP list
 *  endpoint consume this directly. */
export function listWorkflowTemplates(): readonly WorkflowTemplateMeta[] {
  return ENTRIES;
}

/** Look up a template by id. Returns the meta on hit, `null` on miss
 *  (typo in stored setting / template was removed in a later release).
 *  Callers should fall back to `DEFAULT_TEMPLATE_ID` on null. */
export function getWorkflowTemplate(id: string | null | undefined): WorkflowTemplateMeta | null {
  if (!id) return null;
  return REGISTRY.get(id) ?? null;
}

/** Resolve `id` to a definition with default fallback. Used by the
 *  WorkflowOrchestrator's resolveDefinition seam.
 *
 *  Unknown / missing id falls back to LEGACY_LINEAR_AUTOCODE_DEFINITION
 *  (not the v2 default) so folders that haven't been re-seeded with v2
 *  templates yet keep running on the L2 linear runner. Once Phase 4
 *  lands the fallback flips to DEFAULT_AUTOCODE_DEFINITION. */
export function resolveWorkflowDefinition(
  id: string | null | undefined,
): WorkflowDefinition {
  const meta = getWorkflowTemplate(id);
  if (meta) return meta.definition;
  return LEGACY_LINEAR_AUTOCODE_DEFINITION;
}
