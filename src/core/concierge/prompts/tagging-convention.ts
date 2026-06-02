/**
 * Tagging convention — workspace-wide categorial labels, NOT free-text
 * annotations. Drift in this surface is the failure mode that tag
 * cleanup tickets exist to correct (`01KQKHZKZ01DBZ556RPQGCMQ9M`):
 * agents invent `tablet-issue` / `customer-feedback` / `urgent` per
 * note, the workspace tag list balloons, search-by-tag becomes
 * useless. Same shape as Tier 1 topic prevention — explain the
 * principle + give examples per allowed category + name the forbidden
 * categories with reasons + spell out the "if no tag fits, do NOT
 * invent one" rule. Examples are illustrative, NOT a hardcoded
 * whitelist — extending WITHIN a category (e.g. adding `flatpak` to OS
 * targets) is fine; adding a fifth category is not.
 *
 * Mirrored verbatim in `skills/morion/SKILL.md` so third-party MCP
 * agents (Claude Code, Cursor, Codex, etc.) see the same convention.
 * Both surfaces drift together — when you edit one, edit the other.
 *
 * Extracted from src/core/concierge/prompt.ts during the 2026-05-16
 * split (Morion ticket 01KRR8JJ94AD7DB15D1D1YXYXD). Byte-exact.
 */
export const TAGGING_CONVENTION_BLOCK = `## Tagging convention — workspace-wide categorial labels, not free-text annotations

Tags are **workspace-wide** (one tag set crosses every folder) and orthogonal to subject matter (subject matter is what Mo topics / clusters are for). Treat the tag set as a small, slowly-growing categorial vocabulary, NOT a place for free-text descriptors. Before tagging anything, call \`tags_list\` and prefer reusing an existing name — even a near-match like \`desktop\` over inventing \`desktop-app\`.

### Allowed categories (with examples — extend WITHIN a category, do not invent new categories)

A tag answers "what kind of thing is this, across the whole workspace?", not "what is this about?". Pick from one of these four shapes:

- **Environment** — where the work or problem lives.
  \`mobile\`, \`desktop\`, \`web\`, \`dev\`, \`staging\`, \`production\`, \`ci\`, \`local\`, \`tablet\`, …
- **OS / install target** — operating system or install vector.
  \`windows\`, \`linux\`, \`macos\`, \`ios\`, \`android\`, \`docker\`, \`appimage\`, \`deb\`, \`dmg\`, \`nsis\`, \`flatpak\`, …
- **Code area / surface** — broad part of the stack the work touches.
  \`backend\`, \`frontend\`, \`ui\`, \`ux\`, \`cli\`, \`mcp\`, \`db\`, \`api\`, \`infra\`, \`build\`, \`release\`, \`tests\`, \`docs\`, …
- **Ticket type** — the shape of the ticket itself.
  \`bug\`, \`feature\`, \`enhancement\`, \`story\`, \`epic\`, \`note\`, \`data-issue\`, \`refactor\`, \`spike\`, \`chore\`, \`incident\`, …

The example lists are illustrative, not exhaustive — adding \`tablet\` (Environment) or \`flatpak\` (OS) is fine when something genuinely new appears. Adding a fifth category is NOT — bring it up with the user instead.

### Forbidden — do NOT tag

- **Status / kanban column** — \`todo\`, \`doing\`, \`review\`, \`done\`, \`research\`, \`blocked\`. The kanban board encodes status already; tagging duplicates the truth and goes stale fast.
- **Module / subsystem / feature name** — \`auto-code\`, \`mo-chat\`, \`kanban-ui\`, \`topic-cleanup\`, \`mo-indexing\`. These are Mo's topics / clusters; tagging by module fragments the workspace into a long tail of one-offs.
- **Person / agent / actor** — \`claude\`, \`codex\`, \`mo\`, \`mikalai\`. The audit log already tracks actor.
- **Free-text descriptors / priority / mood** — \`urgent\`, \`important\`, \`nice-to-have\`, \`weekend-work\`, \`wip\`. Subjective and inflationary; put priority in the body or status.

### When in doubt, do NOT add a tag

Tags are optional. If nothing in the four allowed categories clearly fits, add NO tag rather than invent one. A note with zero tags is fine. A note with \`tablet-issue\` because you felt it needed a tag is workspace pollution — and the user has to clean it up later. **It is always better to skip the tag than to coin a synonym of an existing one.**

### Naming rules

- Lowercase, dash-separated: \`data-issue\`, not \`Data Issue\` or \`data_issue\`.
- Reuse over coin: if \`tags_list\` returns \`desktop\`, use \`desktop\` (do not propose \`desktop-app\`, \`desktops\`, \`for-desktop\`).
- One concept per tag — combine tags (\`mobile\` + \`ios\` + \`bug\`) instead of coining \`mobile-ios-bug\`.`;
