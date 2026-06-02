# Mo patterns + denial fallback

Read this when you're about to do something non-trivial in Morion and want to know the right `mo_*` tool, or when you got a denial envelope and need to fall back cleanly.

## The big wins (one mo_* call replaces a chain)

> **`mo_record` is currently disabled.** The one-shot smart-write created mis-attributed lesson/decision notes and duplicate follow-up cards (it had no view of the source task body, of sibling folders, or of existing backlog). A redesigned project-graph version is on the roadmap. For now: close tasks via `notes_add_comment` + `tasks_move({message})` (see the kanban-workflow reference); create follow-up tickets explicitly with `notes_create({status: 'backlog'})` only when the work is genuinely out of scope.

### `mo_ask` replaces notes_search + notes_get × N + manual synthesis

When the user asks "what do we know about X in folder Y", `mo_ask` delegates to the same deep-research gather engine `mo_get_context` uses (Wave 1 cluster analysts + keyword generator → Wave 2 body extractors + cross-folder candidates → synthesis), then returns the synthesised packet as a one-paragraph answer with structured `sources`.

**Before (5+ raw calls + synthesis pass):**
```
notes_search("X")              → 10 hits
notes_get(top 3 hits)          → read full bodies
[your own LLM call]            → synthesise an answer
[manually construct citations]
```

**After (1 mo_ask):**
```
mo_ask({question: "what's the convention for handling Stripe webhook retries here?",
        folderId: "01K..."})
→ {
    ok: true,
    answer: "<synthesised paragraph with [01H...] inline citations>",
    sources: [{kind: 'note', id, title, reason}, ...],
    clusterRoutes: [...],   // bootstrap clusters Mo touched
    notesScanned: N,
    folder: {id, name},
    model: "<synthesis model id>",
    costUsd: 0.018,
    cacheHit: null | {kind: 'exact'} | {kind: 'semantic', similarity},
    risks: [...],
    warnings: [...]
  }
```

Cost: ~$0.013-$0.020/call default; the two-layer cache makes the second identical call free. Hard cap $0.10/call.

When NOT to use `mo_ask`:
- For deterministic lookups ("get me the body of note X") — `notes_get(id)` is free.
- For "what was I just working on" — `notes_recent(10)` is enough.
- When you want the structured packet (cited ids + risks + bootstrap state) for further programmatic processing — `mo_get_context` returns the same engine's output in structured form (paragraph synthesis still in `packetMarkdown`, but you also get `bootstrap`, `capped`, etc.).

### `mo_get_context` is the deep-research packet

The new high-level entry. Two-wave parallel sub-Mo fan-out (cluster analysts + body extractors) on cheap-tier models, then a synthesis call on a stronger model. Two-layer cache (exact + semantic) makes repeated calls free. Hard cap $0.10/call default. Mo is owner-level on reads — sees archived material so the user's exclusion path is per-folder Mo enable.

```
mo_get_context({taskId, mode: 'resume'})         // resume an existing task
mo_get_context({question, folderId})              // free-form research, folder-scoped
mo_get_context({question, scope: 'workspace'})    // free-form, cross-folder
mo_get_context({..., mode: 'thorough'})           // bumps synth to deepseek-v4-pro
mo_get_context({..., force: true})                // bypass both cache layers

→ {
    packetMarkdown: "<full markdown with cited [01H...] note ids>",
    citedNoteIds: ["01HABC", ...],
    risks: ["watch out for X", ...],
    bootstrap: {clusterIds, commentCount, auditCount, ...},
    cacheHit: null | {kind:'exact'} | {kind:'semantic', similarity},
    spentUsd: 0.018,
    capped: null | 'budget_exhausted' | 'body_read_cap' | 'wave_cap',
    warnings: [...]
  }
```

Use at the start of EVERY non-trivial task you take. Replaces the old `mo_get_handoff` (deleted) + `mo_get_work_context` (deprecated) workflow.

For a CHEAP deterministic alternative when you don't need synthesis:
```
mo_resolve_task({taskId})
→ {task: {body, ...}, folder, clusters, metadata, comments, audit}
```

Critical for `review → todo` bounce-backs — Mo surfaces the bounce reason in the synthesis so you don't re-try the same approach the user just rejected.

### Low-level primitives (deterministic, no LLM)

For when you want to drive Mo's loop yourself instead of letting `mo_get_context` do the gather:

- `mo_list_clusters({folderId})` — cluster directory + counts + has-aggregator flag
- `mo_get_cluster({folderId, clusterId})` — aggregator doc body + per-task metas (NO bodies)
- `mo_list_tasks_meta({folderId?, clusterId?, search?, limit?})` — bulk metadata listing (id + title + summary + keywords + clusters)
- `mo_resolve_task({taskId})` — full local resolve of one task

These compose into the same data flow `mo_get_context` runs internally — useful when you need finer control over what gets read or want to keep the LLM cost on your side.

### Removed (no longer callable)

These tools were deleted in v1.4.1; do NOT try to invoke them — they return `unknown_tool`:

- `mo_get_work_context` — was keyword-only one-shot ranking. Replaced by `mo_get_context({question, folderId})`.
- `mo_get_index` — was a raw read of the per-folder `mo:catalog` note body. Use `mo_list_clusters({folderId})` for the cluster directory or `mo_get_context({question, folderId})` for synthesis.
- `mo_get_handoff` — was per-task handoff synthesis. Use `mo_get_context({taskId, mode: 'resume'})`.

## Memory tools (workspace-wide, not per-folder)

`mo_remember` and `mo_forget` are workspace-scoped. They write to `mo.memory` settings KV which is read fresh into EVERY Mo prompt builder (`mo_ask` / `mo_get_context` gather synthesizer, the Ask Mo chat, autonomous Concierge ticks). User edits in the Mo Settings popup → Mo Memory tab take effect immediately on the next turn — no session restart.

### `mo_remember({fact, override?})`

Use when:
- The user explicitly asks you to remember / save / store / not forget something.
- You spot a durable preference worth surviving sessions ("I prefer DuckDB over ClickHouse", "address me as 'sir'", working hours, etc.).

Returns one of:
- `added` — new fact stored
- `deduped` — fact is already in memory verbatim or near-verbatim
- `conflict` — fact contradicts existing memory; receipt includes `existingItems` and `proposed`

On `conflict`: surface the question to the user verbatim ("You said X before; now you're saying Y. Replace?"). When they confirm, re-call `mo_remember({fact, override: true})` — Mo's OVERRIDE mode replaces contradicting items.

DO NOT encode "forget X" as a `mo_remember` meta-fact. Use `mo_forget`.

### `mo_forget({all?, pattern?})`

- `mo_forget({all: true})` — deterministic full wipe. No LLM call. Free. Returns `cleared` count.
- `mo_forget({pattern: "<topic>"})` — LLM-tier selective. Sub-Mo decides which lines match. Returns `removed[]` array for audit.

Destructive — `category: 'delete'` so chat-tier Mo requires user approval before running. Direct MCP calls execute immediately.

Use when the user says: "forget everything" / "clear memory" / "forget X" / "drop the memory about Y".

## Pre-flight permission check — `mo_check_workflow`

Use BEFORE a destructive operation (delete, mass move, archive of N items) when you're unsure whether the folder's MCP permissions allow it. Deterministic, cheap, no LLM call.

```
mo_check_workflow({folderId, intendedAction: 'delete', summary: '...', targetIds?: [...]})
→ {
    decision: 'allow' | 'deny' | 'ask_user',
    reason: '<short prose>',
    permissions: {visible, update, delete},
    workflow: null,        // legacy — always null since 2026-04-28
  }
```

The `workflow` text field is retired (2026-04-28); the per-folder house-style now lives in the `mo:catalog` overview section (editable via Folder Settings → Project Summary). Only the `decision` + `permissions` are load-bearing now. Mass operations (`targetIds.length > threshold`) auto-escalate to `ask_user`.

## Denial fallback

Every `mo_*` tool can return one of these envelopes instead of the success shape:

```
{ error: "mo_pro_required", message: "..." }
{ error: "mo_not_enabled_for_folder", folderId: "...", message: "..." }
{ error: "mo_budget_exceeded", remainingBudget: 0, message: "..." }
{ error: "mcp_access_denied", message: "..." }
```

**Handling rule:** surface the reason to the user in one short sentence, then proceed with raw tools. Do NOT retry the same `mo_*` call.

| Denial | What to tell the user | What to do instead |
|---|---|---|
| `mo_pro_required` | "Mo is a Pro feature; this workspace is on Free. Falling back to raw search." | Use `notes_search` + `notes_get` + your own synthesis |
| `mo_not_enabled_for_folder` | "Mo is disabled on this folder. To turn it on: Folder Settings → AI Access → Enable Mo." | Use raw tools for THIS folder; Mo still works on other folders |
| `mo_budget_exceeded` | "Mo's monthly budget is exhausted. Falling back to raw tools until next month / until the user resets." | Use raw tools across the board |
| `mcp_access_denied` | "This folder is hidden from MCP. I can't see it without permission changes in Folder Settings → AI Access." | Don't retry; the user must toggle visibility |

### Raw fallback equivalents

| `mo_*` | Raw equivalent (when denied) |
|---|---|
| `mo_get_context` / `mo_ask` | `notes_search(query)` + `notes_get(top 3 hits)` + your synthesis |
| `mo_resolve_task` | `notes_get(taskId)` + `notes_list_activity(taskId)` + manual stitch |
| `mo_list_clusters` / `mo_get_cluster` | (no clean fallback — depends on Mo Indexing being live) |
| `mo_request_human` | `notes_add_comment(taskId, "USER: <question>")` or `notes_create({status: 'backlog'})` — durable, but no special "needs human" signalling |
| `mo_remember` | (no equivalent — Mo Memory is Pro-only by design) |
| `mo_forget` | (no equivalent) |

The raw fallback is functionally complete but loses Mo's synthesis, routing, and per-folder workflow awareness. Tell the user once that you're on raw mode — they may want to fix the denial reason instead of accepting degraded behaviour.

## Folder identity rules

`mo_request_human` REQUIRES `folderId`. Don't guess. If the user asks "save this" without context:

1. If you're working on a kanban task → use that task's `folderId`
2. If a folder was named earlier in the conversation → use that
3. Otherwise: ask. "Save to which folder?" Don't dump in unfiled — Mo writes never fall back to that bucket.

`mo_ask` / `mo_get_context` / `mo_search` accept optional `folderId` — passing it scopes the search; omitting it gives global / pinned-only context (`mo_ask`) or workspace-wide scope (`mo_get_context` / `mo_search`).
