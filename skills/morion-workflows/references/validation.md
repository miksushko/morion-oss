# Validation invariants — pass on the first try

`workflows_validate` (and every write) runs the full Zod schema plus these graph refinements, in order. Violations come back as `issues: [{path, message}]`.

## Structural

1. **Stage ids unique.** Duplicate `id` anywhere fails.
2. **Edge endpoints exist.** Every `edges[].from` / `edges[].to` must name a stage id.
3. **Closed shapes.** Unknown keys on stages / definition fail — don't invent fields.
4. `stages` non-empty; `name` non-empty; `schemaVersion` is `1`.

## v2 graph invariants (fire when the workflow contains any of mo_stage / sinks / human_gate / deprecated aliases)

5. **Exactly one `mo_stage` with `isStart: true`** — the Process Start gate. Not zero, not two.
6. **Exactly one `reject_sink` AND exactly one `complete_sink`.**
7. **Sinks have no outbound edges** (applies to `eject` too).
8. **Decision-edge alignment.** For every `mo_stage` / `mo_router`: each outbound edge's `on` label MUST be one of the stage's `branches`; at most one outbound edge per label. An edge label that isn't a declared branch fails; a declared branch with no edge is allowed (unrouted branch = Mo can still pick it, run ends unroutable — avoid in practice).
9. **`human_gate` has exactly one outbound edge.**
10. **Terminal reachability.** BFS from the start stage along edges must reach BOTH the complete_sink AND the reject_sink. Back-edges (reopen loops) are fine — this is reachability, not acyclicity.

## Verdict policy (only when a `cli_agent` sets `verdictPolicy`)

11. `onReopen.reopenStageId` must exist, be a `cli_agent`, and appear EARLIER in the stages array than the reviewing stage.
12. Every stage inside the reopen loop needs `maxAttempts >= onReopen.maxAttempts`.

## Linear-only rules (fire ONLY when the definition has NO v2 stage kinds — pure cli_agent / mcp_tool_call)

13. `edges` are either empty (runner walks array order) or exactly the forward chain `stages[0]→stages[1]→...` with every `on: "success"`. Anything else is a DAG and needs the v2 shape (add the start mo_stage + sinks).

## Saveable vs runnable

`workflows_validate` also reports `summary.runnable`. A definition can be VALID and saveable but not yet dispatchable — today that means it contains a `branch` stage (reserved). `runnableReason` carries the exact message. Prefer shipping runnable graphs; only save drafts when the user asks.
