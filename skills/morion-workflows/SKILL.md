---
name: morion-workflows
version: 1.1.0
description: Author Auto-code workflows in Morion via MCP — build, validate, and install WorkflowDefinition JSON that drives Morion's kanban → cli-agent coding pipelines. Trigger when the user asks to create, edit, copy, tune, or set up an auto-code workflow / coding pipeline / agent process in Morion, or to pick which workflow a ticket or folder runs. Not needed for everyday notes/kanban work — that's the `morion` skill.
---

# Morion Auto-code — workflow authoring over MCP

Morion runs coding pipelines on kanban tickets: a ticket dragged to `todo` spawns a DAG of stages — CLI coding agents (claude / codex / pi / opencode), Mo decision nodes, human gates, MCP tool calls — ending in a complete or reject sink. The pipeline is a `WorkflowDefinition` JSON stored per folder. Your job with this skill: author that JSON safely through the `workflows_*` MCP tools.

## The five tools (+ two you already know)

| Tool | Use for |
|---|---|
| `workflows_environment({folderId?})` | ALWAYS FIRST. Which CLI agents are installed (`claude/codex/pi/opencode` ready/path/error), which LLM backends have keys (booleans), folder auto-code state (enabled, linked repo, default workflow, preflight blockers). Never propose an agent that isn't ready. |
| `workflows_list({folderId})` | Built-in templates + the folder's custom workflows, full definitions included. Pick a base here. |
| `workflows_copy({sourceWorkflowId, targetFolderId, name?, setAsFolderDefault?})` | Start from a template (`default-v2`, ...) or copy a custom workflow from another folder. Templates are immutable — copy first, then edit the copy. |
| `workflows_validate({definition})` | Dry-run the exact save-time validation. Returns `{ok, summary}` or `{error, issues: [{path, message}]}`. Loop: build → validate → fix → repeat until ok. |
| `workflows_create({folderId, name, definition, setAsFolderDefault?})` / `workflows_update({workflowId, folderId, ...})` / `workflows_delete({workflowId, folderId})` | The writes. All errors come back as structured envelopes — read `issues[]` and self-correct, never guess. |

Attach a workflow to work: `setAsFolderDefault: true` pins it for the whole folder; `notes_update({id, workflowId})` overrides per-ticket. Editing a workflow never breaks in-flight runs (each run snapshots its graph at start).

## Golden path

1. `workflows_environment` — check what the machine can run.
2. `workflows_list` — inspect the 5 shipped templates; pick the closest by STAGE COMPOSITION (plan+review / fix+review+docs+qa / fix+review+docs / fix+review / fix-only).
3. `workflows_copy` the base into the target folder.
4. Edit the copy: prompts (`promptTemplate`, Mustache over `{{ticket.*}}` / `{{stages.<id>.output.summary}}` / `{{reopen.reason}}`), agents, budgets, Mo instructions.
5. `workflows_validate` until `ok: true` (also check `summary.runnable`).
6. `workflows_update` the copy (or `workflows_create` if built from scratch).
7. Pin: `setAsFolderDefault: true` or per-ticket `notes_update({workflowId})`.

Prefer modifying a template over authoring from zero — the shipped graphs already satisfy every validation invariant.

## References (read on demand)

- `references/stage-kinds.md` — all 9 stage kinds: config shape, semantics, when to use, which are deprecated.
- `references/validation.md` — every validation invariant the schema enforces, so your JSON passes on the first try.
- `references/agents.md` — agent matrix: claude / codex / pi / opencode, providers, auth, `level` semantics, `allowedTools` vocabulary, fallback rules.
- `references/recipe.md` — the golden path in detail + a fully annotated fix-review WorkflowDefinition example.

## Non-negotiables

1. **Environment first.** Never emit a definition using an agent whose `ready` is false, or a Mo-dependent stage (`mo_stage`) when the folder has no configured Mo provider.
2. **Templates are immutable.** `workflows_update` on `default-v2` etc. returns `template_immutable` — copy first.
3. **Validate before writing.** `workflows_validate` ok → `workflows_create` is guaranteed to accept the same JSON.
4. **Model ids are free-text and never guessed.** There is no model catalog by design. Reuse what the user configured (see environment output) or ask the user which model to put in a stage.
5. **Deleting is destructive** — the definition JSON is gone and per-ticket overrides reset. Confirm with the user unless they explicitly asked for deletion.
6. **Don't invent fields.** The schema is closed — unknown keys fail validation. Everything you may set is listed in `references/stage-kinds.md`.
