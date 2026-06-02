# Kanban workflow

Read this when you take, resume, or close a kanban task. Morion kanban folders use 6 columns:

```
note → backlog → todo → doing → review → done
```

## Column semantics

- `note` — reference material. Specs, conventions, context. Default column for new notes in a kanban folder.
- `backlog` — queued executable work. User-curated priority.
- `todo` — ready to start. Next up.
- `doing` — actively being worked on. Use `tasks_claim` to enter.
- `review` — waiting on the human. **YOUR terminal column as an agent.**
- `done` — human-verified complete. **You don't move things here unless explicitly asked.**

## Take-a-task flow ("take a todo" / "pick the next task")

### 1. Find the folder + candidate card

If the folder isn't obvious from context: `folders_list` → pick the kanban-mode one matching scope.

`tasks_list({folderId, status: 'todo'})` — ordered by `position ASC`. Lowest position = highest priority. The user curates the order.

If the user named a specific card: `notes_search` by title.

### 2. Resume context — `mo_get_context({taskId, mode: 'resume'})` is the cheat code

```
mo_get_context({taskId, mode: 'resume'})
→ {
    packetMarkdown: "<synthesised context: where this task is, what's
                     been tried, what's blocking, the obvious next step>",
    citedNoteIds: [...],
    risks: [...],
    bootstrap: {clusterIds, commentCount, auditCount, ...}
  }
```

This replaces:
- `notes_get(id)` (body)
- `notes_list_activity(id)` (comments + status changes)
- Your own LLM call to digest

For a cheap deterministic alternative when you don't need synthesis, use `mo_resolve_task({taskId})` — same task body + folder + clusters + metadata + comment metas, no LLM call.

Critical for `review → todo` bounce-backs: Mo surfaces the bounce reason in the synthesis, so you don't re-try the same approach the user just rejected.

If `mo_get_context` is denied (Mo off / budget out), do the raw chain manually — but always read activity, never just the body. Comments override body when they conflict.

### 3. Claim atomically — `tasks_claim(id)`

```
tasks_claim({id})
→ {claimed: true, currentStatus: 'doing'}  // you own it
or
→ {claimed: false}                          // another agent beat you
```

Race-safe: atomic `UPDATE WHERE status='todo'`. If `claimed: false`, back off, pick a different card.

**Use `tasks_claim`, not `tasks_move`, for `todo → doing`.** `tasks_claim` enforces the race semantics; `tasks_move` does not.

### 4. Post a plan-comment immediately

```
notes_add_comment({noteId: taskId,
                   body: "Starting. Plan: [1-2 lines of what you understood from handoff]."})
```

Lets the user correct scope BEFORE you write code — 10× cheaper than reviewing a wrong implementation.

### 5. Do the work

The handoff + body + activity = your specification. If it turns out unclear, blocked, or larger than expected — STOP, comment what you found, DON'T silently expand scope.

### 6. Spec-note pattern (when applicable)

Many kanban folders have a `note`-status card carrying durable context (goals, conventions, links). Naming: `Spec`, `Context`, `Overview`, `Conventions`, or `<Folder> — spec (living doc)`.

`tasks_list({folderId, status: 'note'})` to spot it. Read ONCE at session start — Anthropic prompt cache keeps it warm for ~5 min, cheaper than re-reading per card. Cards often reference it inline: `see spec: "Title" (01K...)`.

### 7. Finish the task — ALWAYS move to `review`

**You own the column of the card you're working on.** When the work is done, the card goes to `review`. This is non-negotiable unless the user told you otherwise in their CURRENT message ("don't move it", "leave it in doing", "ship straight to done"). "Last week the user said X" does not count.

```
tasks_move({id: taskId, status: 'review',
            message: "<one-sentence summary of what shipped>"})
```

`tasks_move({message})` auto-posts the comment in the same transaction — don't `notes_add_comment` AND `tasks_move` with the same content. Duplicates.

If you need richer detail than fits in a one-sentence move-message, post the long-form comment FIRST, then move with a short message:
```
notes_add_comment({noteId: taskId, body: "<multi-paragraph detail>"})
tasks_move({id: taskId, status: 'review', message: "<one-sentence headline>"})
```

If you spotted concrete out-of-scope work that should become its own ticket, create it explicitly: `notes_create({body, folderId, status: 'backlog'})`. Don't bury follow-up notes inside the closing comment.

**If you got blocked / abandoning the work**, do NOT leave it in `doing`. Move BACK to `todo` with a reason:
```
tasks_move({id: taskId, status: 'todo', message: "Blocked on <reason>. Reopening for re-pickup."})
```

Silent-abandoning a card in `doing` is the worst failure mode — the human assumes work is in progress when it isn't.

> NOTE: `mo_record` (one-shot smart-write) is currently disabled — it created mis-attributed lesson/decision notes and duplicate follow-up cards. A redesigned project-graph version is on the roadmap.

### 8. STOP at review. Do not move to done.

`done` is the human's quality gate. They verify → move to done themselves (or bounce back to `todo` with feedback).

Only exception: user explicitly says "ship it" / "close it" / "move to done". Then `tasks_move({id, status: 'done', message: "<reason>"})`.

## Status transitions reference

| From | To | Who | Note |
|---|---|---|---|
| anywhere | `todo` | user, or agent on reopen | Leave reason comment if bouncing back |
| `todo` | `doing` | agent | **`tasks_claim`**, not `tasks_move` |
| `doing` | `review` | agent | `tasks_move({status: 'review', message})` |
| `review` | `done` | **user only** | Don't autonomously |
| `review` | `todo` | user, or agent retrying after new info | Leave reason |
| `done` | anywhere | user only | |

If the user reopens a `review` or `done` card, use `tasks_move({id, status: 'todo', message: "<why>"})` — never edit the card body to show the reopen.

## Creating new tasks

`notes_create({body, folderId, status: 'note'})` — default to `note` column. Don't auto-drop into `backlog` / `todo` unless the user said "add to backlog" / "queue this up" / "create a todo".

If the new task shares context with existing cards, reference the spec: `see spec: "Spec title" (01K...)` in the body. Keeps cards small, context-cache-friendly.

## Showing board status

When user asks "what's on my board" / "status of X":

- `tasks_list({folderId})` — grouped by status.
- Summarise column counts + name 2-3 top cards per ACTIVE column (`backlog` / `todo` / `doing` / `review`).
- Don't dump the whole board — that's what the UI is for.
- Filter out `mo:*` system notes (catalog/cluster/risks/patrol-log) from your summary unless the user explicitly asks for the catalog.

## Folder index awareness

Modern Mo-enabled folders auto-maintain four index notes:

- `mo:catalog` — LLM-written project summary (overview / clusters / recent / risks)
- `mo:cluster:<theme>` — per-theme aggregator notes
- `mo:risks` — merged into catalog risks section
- `mo:patrol-log` — append-only deterministic findings

These are filtered out of `notes_list` / `notes_search` / folder badge counts by default. They're index aids; ground-truth retrieval still goes through live search. To navigate large folders by theme:

```
mo_list_clusters({folderId})
→ {clusters: [{clusterId, taskCount, hasAggregator}, ...], totalClusters}
```

```
mo_get_cluster({folderId, clusterId})
→ {aggregatorBody, tasks: [{noteId, title, summary, keywords, ...}]}
```

```
mo_search({query, folderId, cluster: ['kanban-ui', 'mcp-surface']})
→ ranked hits scoped to those clusters (now also includes per-hit summary + keywords by default)
```

For deep research synthesised across clusters, use `mo_get_context({question, folderId})` — Mo runs Wave 1 cluster analysts + Wave 2 body extractors and returns a cited markdown packet.

When you need `tag` / date filters use raw `notes_search({query, folderId?, tag?, createdAfter?, updatedBefore?, ...})` — Mo's tools focus on relevance ranking, not metadata filters.

## Permissions + archive edge cases

- **`{error: 'mcp_access_denied'}`** — folder/note marked MCP-invisible or MCP-action-disabled. Don't retry. Tell user: "This [folder/note] is set to hide from AI. You'll need to toggle AI access in [folder] settings if you want me to work with it."
- **Archived resource** — same behaviour as hidden. Don't offer to restore; the unarchive action is UI-only. User archived on purpose.
- **Comment edit/delete fails** — likely actor-mismatch (you're trying to edit someone else's comment). Don't retry; tell user.

## Anti-patterns specific to kanban

- Don't skip `doing` — go through `tasks_claim` first so the user sees the card was actually worked on.
- Don't create cards in `backlog` / `todo` without being asked. User owns prioritisation.
- Don't move `todo → review` via `tasks_move` (skipping `doing`). Always claim first.
- Don't fabricate "I tested it" / "I verified it" in your closing comment. Honesty rule applies — if you didn't run the tests, say so.
