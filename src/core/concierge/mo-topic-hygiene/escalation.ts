import type Database from 'better-sqlite3';
import type { ConciergeQuickAction } from '../types.js';
import type {
  HygieneMergeProposal,
  HygieneDemoteProposal,
  RunTopicHygieneDeps,
} from './types.js';
import { bundleMergeProposals } from './bundle.js';

/**
 * Bundle the merge edge cases via union-find — multiple proposals
 * about the same family of topics collapse into one group with a
 * single N+1 decision (Use X as main / Use Y as main / ... / Keep
 * all separate) instead of N pairwise prompts.
 *
 * Posts one Ask Mo session per hygiene run with quick-action chips
 * for every bundle + each pending demote. Returns the new session id,
 * or `null` if there were no edge cases (or sessions/messages repos
 * were not provided in deps).
 */
export async function maybeOpenEscalationChat(
  deps: RunTopicHygieneDeps,
  folderId: string,
  edgeCases: Array<HygieneMergeProposal | HygieneDemoteProposal>,
  summary: string,
  now: number,
): Promise<string | null> {
  if (edgeCases.length === 0) return null;
  if (!deps.sessions || !deps.messages) return null;

  const merges = edgeCases.filter((e): e is HygieneMergeProposal => 'target' in e);
  const demotes = edgeCases.filter((e): e is HygieneDemoteProposal => !('target' in e));
  const bundles = bundleMergeProposals(merges);

  // Pull the folder name so the escalation message identifies WHICH
  // folder needs cleanup — the user has many Mo-enabled folders + the
  // session list shows multiple cleanups in flight, so a "Topic
  // cleanup needs your call" line without the folder name is
  // ambiguous (dogfood report 2026-05-04).
  const folderName = lookupFolderName(deps.db, folderId);

  const lines: string[] = [];
  const headlineCount = bundles.length + demotes.length;
  const folderTag = folderName ? ` in folder \`${folderName}\`` : '';
  lines.push(
    `Topic cleanup needs your call on ${headlineCount} item${headlineCount === 1 ? '' : 's'}${folderTag}.`,
  );
  if (summary) {
    lines.push(`> ${summary}`);
  }
  lines.push('');

  // Quick actions:
  //   bundle:N:use-<topicId>    — single-click apply (merge all
  //                                non-main topics into <topicId>)
  //   bundle:N:keep-all          — record kept_separate for every
  //                                pair in the bundle
  //   demote:N:apply             — apply demote
  //   demote:N:keep              — record kept_separate (no target)
  // The UI groups by id prefix (`bundle:N` / `demote:N`) into one
  // bordered card per item, vertical option list, single-select.
  const quickActions: ConciergeQuickAction[] = [];

  bundles.forEach((b, bIdx) => {
    const topicChips = b.topics.map((t) => `\`${t}\``).join(', ');
    lines.push(`### ${b.topics.length} similar topics  ·  conf ${b.confidence.toFixed(2)}`);
    lines.push(`Topics: ${topicChips}`);
    if (b.reasoning) {
      lines.push(`*Why:* ${b.reasoning}`);
    }
    lines.push('');

    for (const t of b.topics) {
      const others = b.topics.filter((x) => x !== t);
      const recommended = t === b.recommendedMain ? '  (recommended)' : '';
      quickActions.push({
        id: `bundle:${bIdx}:use-${t}`,
        label: `Use \`${t}\` as main${recommended}`,
        kind: t === b.recommendedMain ? 'primary' : 'secondary',
        payload: {
          kind: 'cleanup-bundle-merge',
          folderId,
          topics: b.topics,
          target: t,
          mergedSources: others,
        },
      });
    }
    quickActions.push({
      id: `bundle:${bIdx}:keep-all`,
      label: 'Keep all separate',
      kind: 'secondary',
      payload: {
        kind: 'cleanup-bundle-keep',
        folderId,
        topics: b.topics,
      },
    });
  });

  demotes.forEach((d, dIdx) => {
    lines.push(
      `### Demote \`${d.source}\` → tag \`${d.suggestedTag}\`  ·  conf ${d.confidence.toFixed(2)}`,
    );
    lines.push(`*Why:* ${d.reason}`);
    lines.push('');

    quickActions.push({
      id: `demote:${dIdx}:apply`,
      label: `Demote to tag \`${d.suggestedTag}\``,
      kind: 'primary',
      payload: {
        kind: 'cleanup-demote',
        folderId,
        source: d.source,
        suggestedTag: d.suggestedTag,
      },
    });
    quickActions.push({
      id: `demote:${dIdx}:keep`,
      label: 'Keep as topic',
      kind: 'secondary',
      payload: {
        kind: 'cleanup-keep',
        folderId,
        source: d.source,
        target: null,
      },
    });
  });

  if (quickActions.length > 0) {
    lines.push("Doesn't fit? Type a custom decision below — Mo will read it.");
  }

  const session = deps.sessions.create(
    {
      folderId,
      title: `Topic cleanup — ${edgeCases.length} edge case${edgeCases.length === 1 ? '' : 's'}`,
      openedBy: 'concierge',
      needsHuman: true,
    },
    now,
  );

  deps.messages.create(
    {
      sessionId: session.id,
      role: 'assistant',
      content: lines.join('\n').trimEnd(),
      costUsd: 0,
      quickActions,
    },
    now,
  );

  return session.id;
}

function lookupFolderName(db: Database.Database, folderId: string): string | null {
  const row = db
    .prepare('SELECT name FROM folders WHERE id = ?')
    .get(folderId) as { name: string } | undefined;
  return row?.name ?? null;
}
