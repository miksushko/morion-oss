import type { LLMMessage } from '../provider.js';
import type {
  ClusterPanoramaItem,
  HygieneProposal,
  HygieneMergeProposal,
  HygieneDemoteProposal,
} from './types.js';

/** Pure prompt builder. Test-pinned. */
export function buildHygieneMessages(
  panorama: ClusterPanoramaItem[],
  topicExclusions: string,
  blockedPairs: Array<{ source: string; target: string | null }>,
): LLMMessage[] {
  const panoramaList = panorama
    .map((c) => {
      const titles = c.sampleTitles.length > 0
        ? c.sampleTitles.map((t) => `      - ${t.replace(/\n/g, ' ').slice(0, 120)}`).join('\n')
        : '      (no titles available)';
      const pinFlag = c.hasUserPin ? ' [USER-PINNED — merging is a no-op, do not propose]' : '';
      return `- "${c.clusterId}" (${c.noteCount} note${c.noteCount === 1 ? '' : 's'})${pinFlag}\n${titles}`;
    })
    .join('\n');

  const exclusionsBlock = topicExclusions.trim().length > 0
    ? `\n\nUser-set generic-term blocklist for THIS folder (treat words / close paraphrases as candidates for demote_to_tag, NOT merges):\n${topicExclusions.trim()}\n`
    : '';

  const blockedBlock = blockedPairs.length > 0
    ? `\n\nThese pairs already have a recorded decision — do NOT re-propose them:\n${blockedPairs
        .map((p) => `- "${p.source}" ${p.target ? `→ "${p.target}"` : '(demote)'}`)
        .join('\n')}\n`
    : '';

  const system: LLMMessage = {
    role: 'system',
    content: [
      'You are the topic-hygiene proposer for a local-first notebook (Morion).',
      'Your single job: look at the cluster panorama for ONE folder and propose two kinds of cleanup operations:',
      '',
      '  (1) MERGES — pairs of clusters that name the same concept and should collapse.',
      '      Examples of valid merges: {"auto-code", "auto-code-loop"}, {"tiptap-editor", "tiptap"}, {"mo-chat", "mo-chat-loop"}.',
      '      Example of an INVALID merge: {"auto-code", "import-pipeline"} — different subsystems even if both mention infra.',
      '      Example of an INVALID merge: {"mo-chat", "mo-indexing"} — Mo has multiple separate subsystems; do not collapse them.',
      '      Direction: source -> target. Pick the more popular / clearer slug as target. The source cluster will be reassigned to target.',
      '      Confidence 0..1 — be honest. 0.9+ = obvious typo / morphological variant. 0.6-0.8 = same concept worded differently. Below 0.6 = uncertain (still report it; the system will escalate to the user).',
      '',
      '  (2) DEMOTES — clusters that are too generic to help retrieval and should be demoted to a note tag instead.',
      '      Targets: words that describe HOW or WHERE work happens, not WHAT the note is about.',
      "      Examples to demote: 'user-interface', 'backend', 'mobile', 'feature', 'task-management' (in a project-management product), 'customer-issues', 'user-requests', 'app-features'.",
      "      Examples NOT to demote (real subjects): 'tiptap', 'kanban-ui', 'auto-code', 'mo-chat-loop'.",
      '      Suggest a short tag slug (kebab-case ASCII) — typically the cluster name shortened (e.g. user-interface -> ui).',
      '',
      'PRIORITY RULE: when a cluster name itself is a generic descriptor (status, environment, OS, code-layer, ticket-type, audience-bucket like "customer-issues" / "user-requests" / "app-features"), it ALWAYS goes into demotes — NEVER into merges, even if all of its current notes happen to fit some specific subsystem. The cluster name is the contract; "customer-issues" is bad as a topic regardless of whether today every note in it is about Stripe. Tomorrow non-Stripe customer issues will land and the cluster will recreate. Demote it once, let the underlying notes get their proper subsystem topic from Tier 1.',
      '',
      'A USER-PINNED cluster is one the user explicitly created via the chip dropdown — it is marked in the panorama. Merging it is a no-op the system will reject; do not waste a slot proposing it.',
      '',
      'Output JSON ONLY, no prose, no markdown fences. Schema:',
      '{',
      '  "summary": string,                       // 1-2 sentences describing the cleanup pass',
      '  "merges": [',
      '    { "source": string, "target": string, "confidence": number, "reason": string }',
      '  ],',
      '  "demotes": [',
      '    { "source": string, "suggested_tag": string, "confidence": number, "reason": string }',
      '  ]',
      '}',
      '',
      'Empty arrays are valid output ("nothing to clean up here"). Lean conservative — proposing a wrong merge is worse than missing one.',
      exclusionsBlock,
      blockedBlock,
    ].join('\n'),
  };

  const user: LLMMessage = {
    role: 'user',
    content: `Cluster panorama for folder (${panorama.length} clusters):\n\n${panoramaList}\n\nReturn the JSON object now.`,
  };

  return [system, user];
}

const JSON_FENCE = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/;

export function parseHygieneResponse(raw: string): HygieneProposal | null {
  if (!raw || typeof raw !== 'string') return null;
  let body = raw.trim();
  const fence = body.match(JSON_FENCE);
  if (fence) body = (fence[1] ?? '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) return null;
    try {
      parsed = JSON.parse(body.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';

  const merges: HygieneMergeProposal[] = [];
  if (Array.isArray(obj.merges)) {
    for (const raw of obj.merges) {
      if (!raw || typeof raw !== 'object') continue;
      const m = raw as Record<string, unknown>;
      const source = typeof m.source === 'string' ? m.source.trim() : '';
      const target = typeof m.target === 'string' ? m.target.trim() : '';
      const confidence =
        typeof m.confidence === 'number' && Number.isFinite(m.confidence)
          ? Math.min(1, Math.max(0, m.confidence))
          : 0;
      const reason = typeof m.reason === 'string' ? m.reason.trim() : '';
      if (!source || !target || source === target) continue;
      merges.push({ source, target, confidence, reason });
    }
  }

  const demotes: HygieneDemoteProposal[] = [];
  if (Array.isArray(obj.demotes)) {
    for (const raw of obj.demotes) {
      if (!raw || typeof raw !== 'object') continue;
      const d = raw as Record<string, unknown>;
      const source = typeof d.source === 'string' ? d.source.trim() : '';
      const suggestedTag =
        typeof d.suggested_tag === 'string' ? d.suggested_tag.trim() : '';
      const confidence =
        typeof d.confidence === 'number' && Number.isFinite(d.confidence)
          ? Math.min(1, Math.max(0, d.confidence))
          : 0;
      const reason = typeof d.reason === 'string' ? d.reason.trim() : '';
      if (!source || !suggestedTag) continue;
      demotes.push({ source, suggestedTag, confidence, reason });
    }
  }

  return { summary, merges, demotes };
}
