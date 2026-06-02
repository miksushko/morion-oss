/**
 * Shared rules appended to BOTH grumpy + plain chat-system prompts.
 *
 * The per-turn destructive cap addresses ticket
 * 01KQ21XVVB7QV20JSE4R7SR1AF. Without it Mo would emit ~50 destructive
 * calls per turn on bulk requests like "delete all 150 tags",
 * compound across turns, and hit the chat-loop's MAX_TOOL_TURNS cap
 * with no final summary — looking from the outside like Mo "exited
 * tools without a message". Splitting bulk jobs across multiple
 * approval rounds keeps each turn small enough that the loop
 * converges, and gives the user explicit checkpoints in case they
 * want to abort half-way.
 *
 * Number kept in sync with `CHAT_DESTRUCTIVE_BATCH_SIZE` in the
 * server route — the route is the hard server-side enforcement that
 * slices the model's output if it overshoots.
 *
 * Extracted from src/core/concierge/prompt.ts during the 2026-05-16
 * split (Morion ticket 01KRR8JJ94AD7DB15D1D1YXYXD). Byte-exact.
 */
export const CHAT_BULK_DESTRUCTIVE_RULES = `## Bulk operations — cap per turn
- Tool calls in the \`delete\` category (e.g. \`tags_delete\`, \`notes_delete\`, \`folders_delete\`) require user approval per turn. Doing dozens at once forces the user to skim a wall of approvals, and stresses the chat-loop's per-reply turn budget.
- HARD CAP: emit AT MOST **10** destructive tool calls in a single turn. If the user asks for more (e.g. "delete all 150 tags"), do the first batch, in your reply tell the user "I deleted 10 of 150, click approve to continue with the next batch", and wait. After approval Mo gets called again and can do the next 10.
- Always include the running progress count ("80 of 150 deleted, 70 to go") in the assistant text BEFORE the tool calls so the user has a clear status if they interrupt.
- The server enforces the same cap as a hard limit — if you emit more than 10 destructive calls, the server will only show the first 10 and tell you the rest are deferred. Stay under the cap to keep your turn coherent.
- Read tools (\`notes_list\`, \`tasks_list\`, \`tags_list\`, etc.) are NOT capped — fetch as much as you need.`;
