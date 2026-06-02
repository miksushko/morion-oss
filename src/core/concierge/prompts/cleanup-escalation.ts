/**
 * Topic-cleanup escalation context — public types + the prompt block
 * inserted into the chat system prompt when the assistant's previous
 * turn opened a cleanup proposal that the user is now replying to in
 * free-text.
 *
 * Extracted from src/core/concierge/prompt.ts during the 2026-05-16
 * split (Morion ticket 01KRR8JJ94AD7DB15D1D1YXYXD). String content is
 * byte-exact verbatim — output snapshots must not drift.
 */

/**
 * Pending topic-cleanup escalation seen on the most recent assistant
 * turn. The chat tier needs this to interpret the user's free-text
 * reply ("удали оба", "use the first one", etc.) as intent for one
 * of the proposer's quick-action buttons — without it, Mo loses the
 * structured choice context and can hallucinate denials.
 */
export interface CleanupEscalationContext {
  /** Folder where the cleanup proposer ran. Always Mo-enabled by
   *  definition (the proposer can't run otherwise) — the prompt block
   *  hard-codes this so chat-tier Mo can't confabulate "Mo not enabled". */
  folderName: string | null;
  /** One entry per still-unresolved decision card the user is looking
   *  at. The chat tier names these back to the user (button labels)
   *  when their custom text matches a clear option. */
  decisions: CleanupEscalationDecision[];
}

export type CleanupEscalationDecision =
  | {
      kind: 'merge-bundle';
      /** Cluster ids in the bundle (proposer-suggested similar topics). */
      topics: string[];
      /** Cluster id the proposer flagged as the recommended main. */
      recommendedMain: string;
    }
  | {
      kind: 'demote';
      /** Source cluster the proposer wants to retire as a cluster and
       *  re-tag as a regular tag. */
      source: string;
      /** Suggested tag name the demote would apply. */
      suggestedTag: string;
    };

export function buildCleanupEscalationBlock(ctx: CleanupEscalationContext): string {
  const folderTag = ctx.folderName ? `\`${ctx.folderName}\`` : 'this folder';
  const lines: string[] = [];
  lines.push(
    `## Pending topic-cleanup escalation — ${folderTag}`,
  );
  lines.push(
    `Mo's topic-cleanup proposer just opened this chat session because some merge / demote candidates were below the auto-apply threshold. The user is now replying with custom text instead of clicking one of the offered buttons. Your job is to interpret their intent against the SPECIFIC pending decisions below and either name the right button OR explain the constraint.`,
  );
  lines.push('');
  lines.push('### Pending decisions');
  ctx.decisions.forEach((d, idx) => {
    if (d.kind === 'merge-bundle') {
      const others = d.topics.filter((t) => t !== d.recommendedMain);
      lines.push(
        `${idx + 1}. **Merge bundle** — similar topics ${d.topics.map((t) => `\`${t}\``).join(', ')}. Recommended main: \`${d.recommendedMain}\`. Buttons: "Use \`${d.recommendedMain}\` as main (recommended)"${others.length > 0 ? `, ${others.map((t) => `"Use \`${t}\` as main"`).join(', ')}` : ''}, "Keep all separate".`,
      );
    } else {
      lines.push(
        `${idx + 1}. **Demote** — retire cluster \`${d.source}\` and turn it into tag \`${d.suggestedTag}\`. Buttons: "Demote to tag \`${d.suggestedTag}\`", "Keep as topic".`,
      );
    }
  });
  lines.push('');
  lines.push('### Hard rules for THIS turn');
  lines.push(
    `- The folder ${folderTag} IS Mo-enabled. The cleanup proposer cannot run on a Mo-disabled folder, so seeing this escalation is proof Mo is enabled here. NEVER tell the user "Mo is not enabled for this folder" or ask them to "turn on AI Access" — that's wrong and breaks trust.`,
  );
  lines.push(
    `- There is NO chat-tier tool that directly merges, demotes, or deletes a cluster. The cleanup pipeline applies decisions through the buttons above (or auto when confidence ≥ 0.8). Do NOT call \`mo_forget\` / \`mo_remember\` to "save" the user's cleanup intent — those tools won't do anything cluster-level.`,
  );
  lines.push(
    `- Read the user's text against the pending decisions above. Map natural-language intent to button labels:`,
  );
  lines.push(
    `  - "delete both" / "оба useless" / "remove them" on a 2-topic merge bundle ⇒ ambiguous between "Keep all separate + delete via tags later" and "merge into one then delete the merged note". Ask the user: "do you want to merge them under one name first, or just demote both to tags? Buttons above pick the path."`,
  );
  lines.push(
    `  - "use the first one" / "use X" / "X main" ⇒ name the matching "Use \`X\` as main" button.`,
  );
  lines.push(
    `  - "keep them" / "оставь как есть" / "leave it" ⇒ name the "Keep all separate" or "Keep as topic" button.`,
  );
  lines.push(
    `  - "skip" / "later" / "ignore" ⇒ tell the user that cleanup escalations stay open until decided; if they want to defer, just close the chat.`,
  );
  lines.push(
    `- If the intent is genuinely unclear (the user hasn't said anything actionable about these clusters), ask ONE concise clarifying question that names the cluster ids verbatim. Don't summarise the proposer's prose back at them — they already saw it.`,
  );
  lines.push(
    `- Reply length: 1-3 short sentences. The user is mid-decision, not in a chat session.`,
  );
  return lines.join('\n');
}
