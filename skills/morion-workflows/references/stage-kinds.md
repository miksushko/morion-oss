# Stage kinds — the full catalog

A `WorkflowDefinition` is `{schemaVersion: 1, name, description, stages: [...], edges: [{from, to, on}], layout?}`. Stages are a discriminated union on `kind`. Edges route by the source stage's outcome label (`on`); plain sequential stages emit `on: "success"`.

## Active kinds (use these)

### `cli_agent` — a coding agent works in the repo worktree

```jsonc
{
  "id": "fix",                    // stable, unique, referenced by edges
  "kind": "cli_agent",
  "agent": "claude",              // claude | codex | pi | opencode
  "provider": null,               // pi/opencode only: anthropic | openai | openrouter | groq | ollama; null = adapter default
  "model": null,                  // free-text vendor id; null = agent's own default. NEVER guess — ask or reuse configured
  "level": null,                  // effort knob, per-agent semantics (see agents.md); null = Default
  "agentInstruction": "",         // extra system-prompt text prepended for this stage
  "promptTemplate": "...",        // REQUIRED. Mustache over run context (see below)
  "maxBudgetUsd": 2,              // per-stage cap; null = inherit folder budget
  "maxAttempts": 3,               // retry cap for recoverable spawn errors (int >= 1)
  "allowedTools": ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
  "fallbackAgent": "claude",      // optional: retried with this agent on recoverable errors
  "fallbackProvider": null,       // per-fallback overrides (same semantics as primary)
  "fallbackModel": null,
  "fallbackLevel": null,
  "fallbackAgentInstruction": "",
  "verdictPolicy": {              // optional — only for review-style stages emitting a JSON verdict
    "onReopen": { "reopenStageId": "fix", "maxAttempts": 3 },  // must point at an EARLIER cli_agent
    "onEscalate": "fail-run"
  }
}
```

Mustache context available in `promptTemplate`:

- `{{ticket.id}}`, `{{ticket.title}}`, `{{ticket.body}}` — the ticket.
- `{{ticket.recentComments}}` — newest 20 comments (all authors, including auto-code's own — they're a shared agent/user channel), each body capped ~1000 chars.
- `{{ticket.priorRuns}}` — deterministic digest of this ticket's previous terminal runs (last 3): outcome / reject reasons / Mo verdicts / diffstats + transcript paths for full detail. Empty on the first run. Put it in fix/plan prompts so a re-run doesn't repeat a prior mistake.
- `{{stages.<stageId>.output.summary}}` — any earlier stage's full final message, verbatim (not a Mo summary).
- `{{stages.<stageId>.output.diffstat}}` / `{{stages.<stageId>.output.filesChanged}}` — for cli_agent stages: the `git diff --stat` and changed-file list the runner captured after that stage, verbatim facts. Reviewers/docs/QA should reference the fixer's diffstat.
- `{{reopen.reason}}` — on a loop-back: the full verbatim output of the stage this reopen came from (e.g. the reviewer's whole verdict, banner-wrapped) + the user's verbatim reply if it came via human_gate + Mo's one-line routing rationale. Empty otherwise. Also addressable split: `{{reopen.sourceFeedback}}` (source stage output), `{{reopen.moRationale}}` (Mo's one-liner), `{{reopen.userReply}}` (verbatim user answer).

When to use: any stage that reads/writes the repo — implementing, reviewing, writing docs, writing tests.

### `mo_stage` — Mo (the in-app LLM broker) makes a routing decision

```jsonc
{
  "id": "mo_after_fix",
  "kind": "mo_stage",
  "instruction": "Read the fix summary. Pick \"review\" when ... Pick \"reject\" when ...",
  "branches": ["review", "reject"],   // >= 2, unique; each needs a matching outbound edge label to be routable
  "postComment": true,                // Mo posts its decision as a ticket comment
  "isStart": false,                   // EXACTLY ONE mo_stage in the workflow has isStart: true (the Process Start gate)
  "modelOverride": null,              // optional {useDefault: true} | {useDefault: false, backend, model}; null = folder default
  "allowedTools": []                  // MCP tools Mo may call in this stage ([] = pure LLM decision; e.g. ["tasks_move", "notes_add_comment"] for a record-result stage)
}
```

When to use: every handoff between agents (accept/reject gate at start, approve/reopen/reject after a review, done/tools_failed at the end). The instruction must tell Mo how to choose between EXACTLY the labels in `branches`.

### `human_gate` — pause and chat with the human

```jsonc
{ "id": "human_chat", "kind": "human_gate", "guidance": "optional hint to Mo about what to ask" }
```

Single inbound edge, single outbound edge (conventionally `on: "reply"` looping back to the mo_stage that routed here). The run pauses, Mo opens a chat with the user, the reply re-enters the graph. Use for "ask the user mid-run" flows.

### `mcp_tool_call` — deterministic MCP call, no LLM

```jsonc
{
  "id": "tag_ticket",
  "kind": "mcp_tool_call",
  "toolName": "notes_add_comment",
  "argsTemplate": { "noteId": "{{ticket.id}}", "body": "..." },  // Mustache on string values
  "maxAttempts": 1,
  "maxBudgetUsd": null
}
```

When to use: a fixed side effect (comment, move, update) that needs no judgement. For LLM-mediated tool use, prefer a `mo_stage` with `allowedTools`.

### `reject_sink` / `complete_sink` — the two mandatory terminals

```jsonc
{ "id": "reject_terminal",   "kind": "reject_sink",   "commentTemplate": "" }
{ "id": "complete_terminal", "kind": "complete_sink", "commentTemplate": "" }
```

`reject_sink`: ticket → backlog. `complete_sink`: ticket → done. Exactly one of each per workflow; no outbound edges. Empty `commentTemplate` is deliberate — Mo's last decision comment is the user-facing explanation; a non-empty template posts an EXTRA closing comment.

### `branch` — typed condition routing (reserved)

```jsonc
{ "id": "b1", "kind": "branch", "combinator": "all", "conditions": [{ "field": "...", "op": "eq", "value": "..." }] }
```

Ops: `eq | neq | in | gt | lt | contains`. Parses and saves, but the current runner does NOT dispatch it — `workflows_validate` reports `runnable: false`. Don't use it unless the user explicitly wants a draft for later.

## Deprecated kinds (never emit these)

- `mo_router` — superseded by `mo_stage` (same branches contract, fewer knobs). The runner still routes old drafts, new definitions must use `mo_stage`.
- `eject` — superseded by `reject_sink`. Treated as a reject sink at dispatch.
