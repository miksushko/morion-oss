# Recipe — from "set up my process" to a pinned workflow

## Step by step

1. **`workflows_environment({folderId})`** — confirm: target agents `ready`, `moBackends.selectedReady` true (v2 graphs need Mo), folder `autoCodeEnabled` + `linkedRepoPath` set (if not, the user must link a repo in Folder Settings → Auto-code first; that's a UI step, not yours).
2. **`workflows_list({folderId})`** — five shipped templates, by stage composition:
   - `plan-and-review-v2` — plan → plan review → code → code review (big/ambiguous tickets)
   - `fix-review-docs-qa-v2` — code → review → docs → functional tests
   - `fix-review-docs-v2` — code → review → docs
   - `default-v2` — code → review (the folder default out of the box)
   - `code-only-v2` — single agent, no review
3. **`workflows_copy({sourceWorkflowId, targetFolderId, name})`** — copy the closest base. Cross-folder copy of a custom workflow works too (needs read access to the source folder).
4. **Edit the copy** — usual knobs, in order of impact:
   - `promptTemplate` of each cli_agent (project-specific acceptance criteria, verification commands);
   - `agent` / `model` / `level` per stage (ask the user about models — never guess ids);
   - `instruction` of each mo_stage (what to check before picking each branch);
   - `maxBudgetUsd` / `maxAttempts`;
   - add/remove stages — keep the invariants from `validation.md` in mind (start gate, two sinks, edge labels = branches).
5. **`workflows_validate({definition})`** — loop until `{ok: true}`; check `summary.runnable` too. Fix exactly what `issues[].path` points at.
6. **`workflows_update({workflowId, folderId, definition})`** — save the copy (or `workflows_create` for from-scratch).
7. **Pin it** — `setAsFolderDefault: true` on the write, or per-ticket `notes_update({id, workflowId})`.

## Annotated example — minimal fix-review flow

The canonical two-agent shape (what `default-v2` is, minus the human-in-the-loop branch). Start gate → implementer → Mo decision → reviewer → Mo decision (with reopen loop) → record-result Mo stage → sinks:

```jsonc
{
  "schemaVersion": 1,
  "name": "Fix + review (custom)",
  "description": "Claude implements, Codex reviews (claude fallback), Mo gates every handoff.",
  "stages": [
    { "id": "mo_start", "kind": "mo_stage", "isStart": true,
      "instruction": "Read the ticket. \"accept\" any ticket with actionable content; \"reject\" only when literally empty.",
      "branches": ["accept", "reject"], "postComment": true, "allowedTools": [] },

    { "id": "fix", "kind": "cli_agent", "agent": "claude",
      "promptTemplate": "You are working on Morion ticket \"{{ticket.title}}\" ({{ticket.id}}).\n\n{{ticket.body}}\n\n--- Recent comments ---\n{{ticket.recentComments}}\n\n--- Previous auto-code runs ---\n{{ticket.priorRuns}}\n\n{{reopen.reason}}",
      "maxBudgetUsd": 2, "maxAttempts": 3,
      "allowedTools": ["Read", "Write", "Edit", "Glob", "Grep", "Bash"] },

    { "id": "mo_after_fix", "kind": "mo_stage",
      "instruction": "Read the fix summary. \"review\" when a diff was produced; \"reject\" when the stage failed or produced nothing.",
      "branches": ["review", "reject"], "postComment": true, "allowedTools": [] },

    { "id": "review", "kind": "cli_agent", "agent": "codex", "fallbackAgent": "claude",
      "promptTemplate": "Review the work of the fix stage for ticket \"{{ticket.title}}\".\n\nFix summary:\n---\n{{stages.fix.output.summary}}\n---\n\nFiles changed:\n---\n{{stages.fix.output.diffstat}}\n---\n\nRead the worktree to verify. Summarise: criteria met? issues needing another pass? blockers?",
      "maxBudgetUsd": 1, "maxAttempts": 3,
      "allowedTools": ["Read", "Glob", "Grep", "Bash"] },

    { "id": "mo_after_review", "kind": "mo_stage",
      "instruction": "Read the reviewer summary. \"approve\" on sign-off; \"reopen\" when another fix pass could close cited gaps; \"reject\" when the reviewer escalates.",
      "branches": ["approve", "reopen", "reject"], "postComment": true, "allowedTools": [] },

    { "id": "mo_tools", "kind": "mo_stage",
      "instruction": "Record the result: move the ticket and post a closing comment. \"done\" on MCP success, \"tools_failed\" on error.",
      "branches": ["done", "tools_failed"], "postComment": true,
      "allowedTools": ["notes_update", "notes_add_comment", "tasks_move"] },

    { "id": "reject_terminal",   "kind": "reject_sink",   "commentTemplate": "" },
    { "id": "complete_terminal", "kind": "complete_sink", "commentTemplate": "" }
  ],
  "edges": [
    { "from": "mo_start",        "to": "fix",               "on": "accept"  },
    { "from": "mo_start",        "to": "reject_terminal",   "on": "reject"  },
    { "from": "fix",             "to": "mo_after_fix",      "on": "success" },
    { "from": "mo_after_fix",    "to": "review",            "on": "review"  },
    { "from": "mo_after_fix",    "to": "reject_terminal",   "on": "reject"  },
    { "from": "review",          "to": "mo_after_review",   "on": "success" },
    { "from": "mo_after_review", "to": "mo_tools",          "on": "approve" },
    { "from": "mo_after_review", "to": "fix",               "on": "reopen"  },  // back-edge: reviewer reopens implementer
    { "from": "mo_after_review", "to": "reject_terminal",   "on": "reject"  },
    { "from": "mo_tools",        "to": "complete_terminal", "on": "done"    },
    { "from": "mo_tools",        "to": "reject_terminal",   "on": "tools_failed" }
  ]
}
```

Why it validates: one `isStart` mo_stage; one sink of each kind with no outbound edges; every mo_stage edge label matches a declared branch; both terminals reachable from `mo_start`; the reopen back-edge is legal (reachability, not acyclicity).

## Common failures and fixes

- `invalid_workflow_definition` + `issues[0].path: "stages"` mentioning isStart → you have zero or two start gates.
- issue about a sink with outbound edges → you routed FROM a terminal; terminals only receive.
- issue "edge ... label ... not in branches" → the `on` label on a mo_stage's outbound edge doesn't match `branches` exactly (case-sensitive).
- reachability error → some path never reaches one of the sinks; usually a missing `reject` edge from a decision stage.
- `template_immutable` → you tried to update/delete a built-in id; `workflows_copy` first.
- `mcp_access_denied` → the folder's MCP permission bits deny this category for you; tell the user which toggle to flip (folder settings → MCP access).
