import { z } from 'zod';

/** Per-stage model override for `mo_stage`. Discriminated by `useDefault`:
 *  when `true` the runner uses the folder's default Mo model (concierge
 *  backend config) and the override fields are absent (closed shape — passing
 *  them with `useDefault: true` is a parse error, preventing the silent-ignore
 *  trap where a future runner sees `{ useDefault: true, level: 'High' }` and
 *  picks one branch or the other inconsistently).
 *
 *  When `useDefault: false` the listed fields override: `tool` selects the
 *  CLI binary (claude/codex/pi/opencode/antigravity), `provider` the API/
 *  auth path (anthropic/openrouter/groq/etc.), `model` the vendor id, `level`
 *  a quality knob whose semantics depend on `tool`:
 *    - claude: 'Default' | 'Think' | 'ThinkHard' | 'ThinkHarder' | 'Ultrathink'
 *              (Claude Code CLI extended-thinking budgets — "think" idioms
 *              inlined into the prompt at dispatch time)
 *    - codex:  'Default' | 'Low' | 'Medium' | 'High'
 *              (Codex CLI `reasoning_effort` for o1/o3/o4/gpt-5 family)
 *    - pi / opencode / antigravity / openrouter-generic: 'Default' only
 *  Editor renders a tool-discriminated dropdown; DB stores the string verbatim.
 *  All override fields stay optional individually — a user might want
 *  "default everything except level=High". */
export const MoModelOverrideSchema = z.discriminatedUnion('useDefault', [
  z.object({ useDefault: z.literal(true) }).strict(),
  z
    .object({
      useDefault: z.literal(false),
      tool: z.string().optional(),
      provider: z.string().optional(),
      model: z.string().optional(),
      level: z.string().optional(),
    })
    .strict(),
]);

/** Mo decision stage. Mo reads ticket context + the user's free-text
 *  `instruction` + the list of `branches`, picks one, and the runner
 *  advances along the matching outbound edge. Subsumes the older
 *  `mo_router` kind — `mo_stage` adds the per-stage model override
 *  contract from the editor spec.
 *
 *  Runtime support arrives with the DAG runner (L4 follow-up);
 *  `parseLinearWorkflow` rejects mo_stage today with a clean error. */
export const MoStageSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('mo_stage'),
  /** Free-text instruction the user writes inside the node. Mo reads
   *  this verbatim as part of the decision prompt. */
  instruction: z.string().default(''),
  /** Legal outbound branch labels. Each becomes a labelled source handle
   *  on the canvas; Mo's decision must match one of them. Min 2 (a
   *  one-branch decision node is degenerate — it's not deciding anything);
   *  values must be unique within a stage (duplicate labels collapse
   *  handles + make edge routing ambiguous). */
  branches: z
    .array(z.string().min(1))
    .min(2)
    .default([])
    .superRefine((branches, ctx) => {
      const seen = new Set<string>();
      branches.forEach((b, idx) => {
        if (seen.has(b)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [idx],
            message: `duplicate branch label "${b}" — branch labels must be unique within a mo_stage`,
          });
        }
        seen.add(b);
      });
    }),
  /** Optional model override (see MoModelOverrideSchema). When absent
   *  Mo uses the folder's default Mo model. */
  modelOverride: MoModelOverrideSchema.optional(),
  /** When true (default), Mo posts a comment to the ticket after deciding,
   *  citing the chosen branch + a one-line reason. Per spec: "Mo всегда
   *  после всех своих действий должен писать коммент в тикете". */
  postComment: z.boolean().default(true),
  /** Marks the workflow entry stage ("Process Start Step"). Exactly one
   *  stage per workflow should carry `isStart: true`. The editor pins
   *  the marker to a single node — user can move the node around the
   *  canvas but can't delete it. Per spec: "Process Start Step (can't
   *  be removed)". */
  isStart: z.boolean().default(false),
  /** Optional allow-list of MCP tools this Mo stage may invoke during
   *  its decision turn. When omitted (null/undefined) the runner uses
   *  the folder's default Mo tool set. When [] the stage runs as a
   *  pure-LLM decision with no tool access (cheapest path, smallest
   *  context). When [...] the stage is restricted to the listed tool
   *  names — useful for keeping decision-only stages from polluting
   *  their context with notes_search results, while letting "Mo Tools"-
   *  style stages enumerate the specific tools they need. */
  allowedTools: z.array(z.string()).nullable().default(null),
});
