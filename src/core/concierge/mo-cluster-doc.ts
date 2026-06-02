/**
 * Mo Indexing Redesign — Phase 3 cluster aggregator note format.
 *
 * Cluster notes (`mo:cluster:<theme>`, source `mo:cluster`) are
 * markdown bodies with anchored sections that Mo regenerates;
 * everything outside the anchors is user-owned and preserved
 * byte-for-byte across regens.
 *
 * Anchor format mirrors the existing brief module so a user familiar
 * with one knows the other:
 *
 *   <!-- mo:section-start id="<section-id>" -->
 *   ...regenerated body...
 *   <!-- mo:section-end id="<section-id>" -->
 *
 * Section ids for cluster docs:
 *
 *   overview  — what this cluster IS (1-2 sentences, durable)
 *   state     — current counts + recent activity (refreshed each tick)
 *   open      — open work / blockers / next priorities
 *   notes     — index of source note ULIDs in this cluster
 *
 * Same merge contract as brief.ts: an empty section body in the LLM
 * response is treated as "no update", preserving the prior content.
 */

export const CLUSTER_DOC_SECTIONS = [
  'overview',
  'state',
  'open',
  'notes',
] as const;
export type ClusterDocSectionId = (typeof CLUSTER_DOC_SECTIONS)[number];

export type ClusterDocSectionMap = Record<ClusterDocSectionId, string>;

const SECTION_PLACEHOLDERS: Record<ClusterDocSectionId, string> = {
  overview: '_Mo will fill this in on the next patrol._',
  state: '_No state recorded yet._',
  open: '_No open work tracked yet._',
  notes: '_Source notes will be indexed here._',
};

/** Build an empty cluster-doc body with all sections present and
 *  placeholder copy. Used when first creating a cluster aggregator
 *  note before any LLM call. */
export function clusterDocSkeleton(clusterId: string): string {
  const heading = `# Cluster: ${clusterId}\n\n_Auto-maintained by Mo. Sections inside \`<!-- mo:section-* -->\` markers are regenerated; prose outside is preserved._\n\n`;
  const sections = CLUSTER_DOC_SECTIONS.map((id) =>
    renderSection(id, SECTION_PLACEHOLDERS[id]),
  ).join('\n\n');
  return heading + sections + '\n';
}

export function startMarker(id: ClusterDocSectionId): string {
  return `<!-- mo:section-start id="${id}" -->`;
}

export function endMarker(id: ClusterDocSectionId): string {
  return `<!-- mo:section-end id="${id}" -->`;
}

/** Render a single anchored section. Empty body is rendered (we still
 *  output the markers) so a future regen can target the slot. */
export function renderSection(id: ClusterDocSectionId, body: string): string {
  return `${startMarker(id)}\n${body.trim()}\n${endMarker(id)}`;
}

export interface ParsedClusterDoc {
  preamble: string;
  sections: ClusterDocSectionMap;
  trailing: string;
}

const ANCHORED_SECTION_RE =
  /<!--\s*mo:section-start\s+id="([a-z][a-z0-9_-]*)"\s*-->([\s\S]*?)<!--\s*mo:section-end\s+id="\1"\s*-->/g;

/** Parse a cluster doc into preamble + sections + trailing. Sections
 *  not present in the body get an empty string. Bodies without any
 *  anchors are treated as a single preamble (preserves user-only
 *  notes that haven't been touched by Mo yet). */
export function parseClusterDoc(body: string): ParsedClusterDoc {
  const sections: ClusterDocSectionMap = {
    overview: '',
    state: '',
    open: '',
    notes: '',
  };
  if (!body.match(ANCHORED_SECTION_RE)) {
    return { preamble: body, sections, trailing: '' };
  }
  const firstAnchor = body.search(/<!--\s*mo:section-start\s+id="/);
  const preamble = firstAnchor > 0 ? body.slice(0, firstAnchor) : '';

  let lastEnd = -1;
  ANCHORED_SECTION_RE.lastIndex = 0;
  for (const match of body.matchAll(ANCHORED_SECTION_RE)) {
    const id = match[1] as ClusterDocSectionId;
    if (CLUSTER_DOC_SECTIONS.includes(id)) {
      sections[id] = (match[2] ?? '').trim();
    }
    lastEnd = (match.index ?? 0) + match[0].length;
  }
  const trailing = lastEnd >= 0 ? body.slice(lastEnd) : '';
  return {
    preamble: preamble.replace(/\n+$/, '\n'),
    sections,
    trailing: trailing.replace(/^\n+/, '\n'),
  };
}

export interface RenderClusterDocInput {
  clusterId: string;
  preamble: string;
  sections: ClusterDocSectionMap;
  trailing: string;
}

/** Re-emit a cluster doc body with the canonical layout. Drops a
 *  default heading into the preamble if the user removed it. */
export function renderClusterDoc(parts: RenderClusterDocInput): string {
  const heading = parts.preamble.trim().length > 0
    ? parts.preamble.replace(/\n+$/, '\n')
    : `# Cluster: ${parts.clusterId}\n\n`;
  const sections = CLUSTER_DOC_SECTIONS.map((id) =>
    renderSection(id, parts.sections[id] || SECTION_PLACEHOLDERS[id]),
  ).join('\n\n');
  const trailing = parts.trailing.trim().length > 0
    ? '\n\n' + parts.trailing.replace(/^\n+/, '')
    : '\n';
  return heading + sections + trailing;
}

const SECTION_HARD_CAP = 8000;

/** Merge an LLM-generated cluster-doc body into the current one,
 *  preserving user prose outside the anchors. Empty sections in the
 *  LLM response → no update (existing body retained). Identical
 *  contract to brief.ts mergeDigest. */
export function mergeClusterDoc(
  current: string,
  llmResponse: string,
  clusterId: string,
): string {
  const parsed = parseClusterDoc(current);
  const llm = parseClusterDoc(llmResponse);
  const merged: ClusterDocSectionMap = { ...parsed.sections };
  for (const id of CLUSTER_DOC_SECTIONS) {
    const next = llm.sections[id].trim();
    if (next.length > 0) {
      merged[id] = trimSectionIfOversized(next);
    }
  }
  return renderClusterDoc({
    clusterId,
    preamble: parsed.preamble,
    sections: merged,
    trailing: parsed.trailing,
  });
}

/** True iff at least one Mo-owned section has non-placeholder content.
 *  Used by the catalog writer (Phase 4) to decide whether the cluster
 *  is "real" vs "stub waiting for first patrol". */
export function clusterDocHasContent(body: string): boolean {
  if (!body.trim()) return false;
  const { sections } = parseClusterDoc(body);
  for (const id of CLUSTER_DOC_SECTIONS) {
    const v = sections[id].trim();
    if (v.length > 0 && !v.startsWith('_') && !v.endsWith('_')) return true;
  }
  return false;
}

function trimSectionIfOversized(body: string): string {
  if (body.length <= SECTION_HARD_CAP) return body;
  const lines = body.split('\n');
  // Drop leading bullets until under the cap. Bounded by `lines.length`
  // — once we're down to a single line the loop exits even if that
  // line alone exceeds the cap (the alternative is silently dropping
  // the only content). brief.ts uses a 1000-line guard; cluster docs
  // can carry per-note bullet lists for large clusters so we don't
  // arbitrarily cap the iteration here.
  while (
    lines.length > 1 &&
    lines.join('\n').length > SECTION_HARD_CAP
  ) {
    lines.shift();
  }
  return lines.join('\n');
}
