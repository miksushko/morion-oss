---
name: morion
version: 1.3.1
description: Use Morion (local MCP-backed notebook + kanban + Mo agent) as the user's persistent memory and shared work queue. Trigger on save / remember; recall / "what do I know about X"; take a task / pick the next todo; resume a task; log progress; move a card to review / done / reopen; "ask Mo"; or any reference to Morion notes / folders / kanban / tickets. Mo is the entry point — default to mo_* tools before raw notes_* / tasks_*.
---

# Morion — local notebook + kanban, Mo as the entry point

Morion is a local SQLite notebook + kanban that doubles as an MCP memory server. Multiple AI agents write into it; every call is audit-logged with your actor. Read before write, leave meaningful comments on moves, don't rewrite other authors' content, stop at `review` (the human's quality gate).

Mo is the in-app agent broker. Calling one `mo_*` tool runs Mo as a sub-agent that plans, dispatches sub-Mos in parallel, and synthesises — replacing 5+ raw calls with one cited result. **Default to `mo_*`. Raw `notes_*` / `tasks_*` are the escape hatch.**

## Reach for these first

| Want to... | Tool | Replaces |
|---|---|---|
| Get full deep-research context for a task or question | `mo_get_context({taskId? \| question?, folderId?, mode?})` | search + reads + synthesis (Wave 1+2 parallel sub-Mos + cited packet) |
| Answer "what do we know about X in folder F" | `mo_ask({question, folderId?})` | same engine, paragraph-form output |
| Raw search with metadata filtering | `mo_search({query, folderId?, withMetadata})` | hits + summary + keywords + clusters per hit |
| Close a task | `mo_resolve_task({taskId})` after writing your own comment + move; or raw `notes_add_comment` + `tasks_move({status: 'done'/'review'})` | — |
| Resolve everything Mo knows locally about ONE task | `mo_resolve_task({taskId})` | get + activity + clusters + metadata in one call |
| List clusters in a folder (no LLM) | `mo_list_clusters({folderId})` | cluster directory + counts |
| Read one cluster's aggregator + assigned task metas | `mo_get_cluster({folderId, clusterId})` | cluster doc + per-task summaries (no bodies) |
| Bulk metadata listing across notes (filters compose) | `mo_list_tasks_meta({folderId?, clusterId?, search?})` | id + title + summary + keywords + clusters |

`mo_get_context` is the new primary entry for "give me everything I need to start work". It's two-wave parallel fan-out (cluster analysts + body extractors) on cheap-tier sub-Mos with synthesis on a stronger model — typical cost $0.013-$0.020/call, hard cap $0.10. Two-layer cache (exact + semantic, 24h) makes repeated calls free.

Other mo_* (detail in `references/mo-tools.md`): `mo_remember` / `mo_forget` (workspace memory), `mo_request_human` (durable escalation), `mo_check_workflow` (pre-flight permission check before destructive ops), `mo_patrol` / `mo_regenerate_cluster` / `mo_reclassify` / `mo_acknowledge_finding` (index maintenance).

## When Mo is denied

Mo gates on Pro + per-folder enable + monthly $10 budget. Denial returns `mo_pro_required` / `mo_not_enabled_for_folder` / `mo_budget_exceeded` / `mcp_access_denied`. Surface the reason once, fall back to raw `notes_*` / `tasks_*`, never retry the same `mo_*`. Equivalents in `references/mo-tools.md`.

## Non-negotiables

1. **You own the ticket you're working on, end-to-end.** Pickup → progress → handoff to human. The card's column is YOUR responsibility from claim to review.
   - Claim: `tasks_claim(id)` for `todo → doing`. Atomic; if `claimed: false`, pick another card.
   - Mid-work, on finish: **always** `tasks_move({status: 'review', message: "<one-sentence summary>"})`. Stopping in `doing` is a leak — the human can't see the card is done.
   - Blocked / abandoning: move BACK to `todo` with a reason comment. Never silent-abandon in `doing`.
   - The ONLY exception to "move to review on finish" is an explicit instruction in the user's CURRENT turn ("don't move the card", "leave it in doing", "ship straight to done"). Past-conversation instructions don't carry over.
2. **Read activity before claiming a `todo`.** `mo_get_context({taskId, mode: 'resume'})` (or the cheap deterministic `mo_resolve_task({taskId})` when you don't need synthesis) does this. Comments override body when they conflict — cards may be `review → todo` bounce-backs.
3. **Stop at `review`.** Don't move to `done` unless the user explicitly says ship/close/done in the current turn.
4. **Default new tasks to `note`.** `backlog` is executable; `note` is reference. Use `backlog` only when the user says "queue this up".
5. **Folder identity is mandatory for writes.** `mo_request_human` requires explicit `folderId`. Pull from `task.folderId` or ask.
6. **Status moves carry a meaningful one-sentence comment.** `tasks_move({message})` auto-posts the message. `"done"` is not a message.
7. **Don't edit other authors' content.** Append, don't rewrite.
8. **`mo:*` notes are visual trash.** `mo:catalog` / `mo:cluster:*` / `mo:patrol-log` are routing aids — filter them from any user-facing summary. Default `notes_search` / `notes_list` already does.

ULID references in chat must always pair with the title: **`Morion note "Title" (01K...)`**.

If `notes_*` / `mo_*` calls fail with connection errors, Morion's MCP isn't connected — the skill is a no-op; tell the user once and proceed without it.

## Assigning Auto-code workflows per ticket

Folders with Auto-code enabled run a workflow per ticket. The default is the folder's pinned workflow, but you can pin a different one for a single ticket — useful when "prepare auto-code" means routing each card to the workflow that fits its shape.

The registry ships **three** base templates (trimmed from 7 in May 2026, ticket 01KRWRHFAK7HPQYV8GN72BW2VC — most of the old ones were near-duplicates):

| id | Shape | When to pick |
|---|---|---|
| `plan-and-review-v2` | Plan agent → Mo → plan-review agent → Mo (reopen → plan) → code agent → Mo → code-review agent → Mo (reopen → code) | Large or ambiguous tickets where a plan needs scrutiny before code lands |
| `default-v2` | Code agent → Mo → code-review agent → Mo (reopen → code) | The balanced default. Most tickets |
| `code-only-v2` | Single code agent → Mo | Trivial tickets / when you'll review the diff manually |

All three carry a human-in-loop branch after the fix stage (`ask_human` → human_gate → loops back to the Mo decision). Custom workflows the user authored in the editor sit alongside these in the same dropdown.

Flow:
1. `workflows_list({folderId})` — discover every workflow available for the folder (the 3 built-in templates **plus** seeded copies + custom rows). Each entry carries a full `WorkflowDefinition` so you can inspect stages before choosing. `kind: 'template'` = built-in id (`plan-and-review-v2` / `default-v2` / `code-only-v2`); `kind: 'custom'` = ULID owned by the folder.
2. `notes_update({id, workflowId})` — pin the chosen workflow on the ticket. Accepts either a built-in template id OR a custom row ULID. Pass `null` to clear the override (ticket falls back to folder default).

Guardrails (server enforces, you should still know):
- The workflow MUST belong to the ticket's folder (or be a built-in template id). Cross-folder pointers return `workflow_not_owned_by_folder` (422).
- The ticket must NOT be in flight. An active run returns `workflow_locked_during_run` (409) — drag the card out of `todo` / `doing` first, then reassign.
- Deleted workflows are swept automatically: tickets pointing at a deleted custom row revert to "use folder default" on the next admission.
- Retired pre-trim template ids (`bug-fix-v2`, `feature-planning-v2`, `spike-v2`, `docs-only-v2`, `pi-fix-v2`, `claude-solo-v2`) are NO LONGER valid `workflowId` values — assigning one returns `workflow_not_found`. Existing folder settings still pointing at them resolve through the runner's fallback to a legacy linear pipeline, but new per-ticket assignments must use the 3 current ids or a custom ULID.

## Tagging convention — workspace-wide categorial labels, not free-text annotations

Tags are **workspace-wide** (one tag set crosses every folder) and orthogonal to subject matter (subject matter is what Mo topics / clusters are for). Treat the tag set as a small, slowly-growing categorial vocabulary, NOT a place for free-text descriptors. Before tagging anything, call `tags_list` and prefer reusing an existing name — even a near-match like `desktop` over inventing `desktop-app`.

**Allowed categories — extend WITHIN a category, do not invent new categories.** A tag answers "what kind of thing is this, across the whole workspace?", not "what is this about?".

- **Environment** — where the work or problem lives. `mobile`, `desktop`, `web`, `dev`, `staging`, `production`, `ci`, `local`, `tablet`, …
- **OS / install target** — operating system or install vector. `windows`, `linux`, `macos`, `ios`, `android`, `docker`, `appimage`, `deb`, `dmg`, `nsis`, `flatpak`, …
- **Code area / surface** — broad part of the stack. `backend`, `frontend`, `ui`, `ux`, `cli`, `mcp`, `db`, `api`, `infra`, `build`, `release`, `tests`, `docs`, …
- **Ticket type** — the shape of the ticket itself. `bug`, `feature`, `enhancement`, `story`, `epic`, `note`, `data-issue`, `refactor`, `spike`, `chore`, `incident`, …

The example lists are illustrative, not exhaustive — adding `tablet` (Environment) or `flatpak` (OS) is fine when something genuinely new appears. Adding a fifth category is NOT — bring it up with the user instead.

**Forbidden — do NOT tag.**

- **Status / kanban column** — `todo`, `doing`, `review`, `done`, `research`, `blocked`. The board encodes status; tagging it duplicates the truth and goes stale.
- **Module / subsystem / feature name** — `auto-code`, `mo-chat`, `kanban-ui`, `topic-cleanup`, `mo-indexing`. These are Mo's topics / clusters; tagging by module fragments the workspace.
- **Person / agent / actor** — `claude`, `codex`, `mo`. The audit log already tracks actor.
- **Free-text descriptors / priority / mood** — `urgent`, `important`, `nice-to-have`, `wip`. Subjective and inflationary; put priority in the body or status.

**When in doubt, do NOT add a tag.** Tags are optional. If nothing in the four allowed categories clearly fits, add NO tag rather than invent one. A note with zero tags is fine. A note with `tablet-issue` because you felt it needed a tag is workspace pollution. **Always better to skip than to coin a synonym.**

**Naming rules.** Lowercase + dash-separated (`data-issue`, not `Data Issue` or `data_issue`). Reuse over coin: if `tags_list` returns `desktop`, use `desktop` — do not propose `desktop-app`, `desktops`, `for-desktop`. One concept per tag — combine (`mobile` + `ios` + `bug`) instead of coining `mobile-ios-bug`.

## Deep references

- **`references/mo-tools.md`** — concrete `mo_ask` / `mo_get_context` examples, denial envelope handling, folder identity rules.
- **`references/kanban-workflow.md`** — full task lifecycle, status transitions, spec-note pattern, cluster-scoped search.
