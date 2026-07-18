# Agent matrix — what fills a `cli_agent` slot

Check `workflows_environment` FIRST: it reports per-agent `{ready, path, error}` for this machine plus which LLM backends have keys configured. Never emit a stage whose agent isn't ready (unless a ready `fallbackAgent` covers it).

| Agent | Binary | Auth | `provider` field | `level` values | Cost reporting |
|---|---|---|---|---|---|
| `claude` | Claude Code CLI | OAuth keychain (Max plan) or `ANTHROPIC_API_KEY` — the adapter lets the CLI pick | ignored (always Anthropic) | `Default`, `Think`, `ThinkHard`, `ThinkHarder`, `Ultrathink` (prompt idioms) | real USD from CLI output |
| `codex` | Codex CLI (via `@openai/codex-sdk`) | ChatGPT OAuth (`~/.codex/auth.json`) or `OPENAI_API_KEY` | ignored (always OpenAI) | `Default`, `Low`, `Medium`, `High` (reasoning effort) | informational $0 |
| `pi` | Pi CLI | provider API keys from env — Morion injects the Mo-configured keys automatically at spawn | `anthropic` \| `openai` \| `openrouter` \| `groq` \| `ollama` | `Default` only | OpenRouter cost when available, else $0 |
| `opencode` | OpenCode CLI | same env-key injection as pi | same as pi | `Default` only | $0 |

Notes:

- **Fallbacks change requirements.** A stage with `fallbackAgent` treats its primary as OPTIONAL — the shipped templates run `codex` review with `fallbackAgent: "claude"`, so codex missing does not block the workflow. Only agents without a fallback are hard requirements.
- **Models are free-text, no catalog.** `model: null` uses the agent's own default. Setting a model: reuse what the user configured for Mo (visible as backend selection in `workflows_environment`) or ask the user. A namespaced model like `deepseek/deepseek-v3` with no provider and an OpenRouter key configured routes via OpenRouter automatically.
- **Local/OSS routing:** `pi` + `provider: "ollama"` runs against the local Ollama at its default base URL — the fully-offline slot.
- **`allowedTools` vocabulary is canonical claude-style names**, mapped per-adapter to native equivalents: `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`. Read-only stages (review, planning) get `["Read", "Glob", "Grep", "Bash"]`; implementing stages add `Write`, `Edit`. Empty array = adapter default (unrestricted) — prefer explicit lists.
- **`agentInstruction`** is appended to the agent's system prompt — use it for stage-scoped rules ("do not modify application code — tests only"), keep task content in `promptTemplate`.
- **Budgets:** `maxBudgetUsd` is enforced natively by claude (`--max-budget-usd`); other agents are tracked post-hoc. Typical shipped values: fix 2–2.5, review/docs 1, qa 1.5.

## Mo stages need a Mo provider

`mo_stage` decisions run on the folder's Mo backend (openrouter / groq / openai / anthropic / ollama — key + model set in Settings → Mo). `workflows_environment` reports `moBackends.selectedReady`. If Mo isn't configured, a v2 workflow can't dispatch — either help the user configure a backend or fall back to a pure-linear cli_agent workflow (no mo_stage / sinks).
