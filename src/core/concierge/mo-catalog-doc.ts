/**
 * Mo Indexing Redesign — Phase 4 catalog note format.
 *
 * One `mo:catalog` note per folder, source `mo:catalog`. Markdown body
 * with anchored sections that the Tier 2.5 writer regenerates;
 * everything outside anchors is user-owned and preserved
 * byte-for-byte across regens (same contract as brief.ts and
 * mo-cluster-doc.ts).
 *
 * Section ids:
 *
 *   overview  — durable folder identity (1-3 sentences). Preserved
 *               most aggressively — stable across regens unless the
 *               LLM has a substantively different read of the project.
 *   clusters  — the routing index: every cluster id with a 1-line
 *               summary + key ULIDs. This is what `mo_ask` reads to
 *               pick which clusters to live-search.
 *   recent    — recent activity / decisions / shipped work.
 *   risks     — LLM-synthesized cross-task risks (replaces the legacy
 *               brief `risks` section).
 */

export const CATALOG_DOC_SECTIONS = [
  'overview',
  'clusters',
  'recent',
  'risks',
] as const;
export type CatalogDocSectionId = (typeof CATALOG_DOC_SECTIONS)[number];

export type CatalogDocSectionMap = Record<CatalogDocSectionId, string>;

const SECTION_PLACEHOLDERS: Record<CatalogDocSectionId, string> = {
  overview: '_Mo will fill this in on the next patrol._',
  clusters: '_No clusters mapped yet._',
  recent: '_No recent activity recorded yet._',
  risks: '_No risks identified yet._',
};

export function catalogDocSkeleton(folderName: string): string {
  const heading = `# Mo Catalog — ${folderName}\n\n_Auto-maintained by Mo. Sections inside \`<!-- mo:section-* -->\` markers are regenerated; prose outside is preserved._\n\n`;
  const sections = CATALOG_DOC_SECTIONS.map((id) =>
    renderSection(id, SECTION_PLACEHOLDERS[id]),
  ).join('\n\n');
  return heading + sections + '\n';
}

export function startMarker(id: CatalogDocSectionId): string {
  return `<!-- mo:section-start id="${id}" -->`;
}

export function endMarker(id: CatalogDocSectionId): string {
  return `<!-- mo:section-end id="${id}" -->`;
}

export function renderSection(id: CatalogDocSectionId, body: string): string {
  return `${startMarker(id)}\n${body.trim()}\n${endMarker(id)}`;
}

export interface ParsedCatalogDoc {
  preamble: string;
  sections: CatalogDocSectionMap;
  trailing: string;
}

const ANCHORED_SECTION_RE =
  /<!--\s*mo:section-start\s+id="([a-z][a-z0-9_-]*)"\s*-->([\s\S]*?)<!--\s*mo:section-end\s+id="\1"\s*-->/g;

export function parseCatalogDoc(body: string): ParsedCatalogDoc {
  const sections: CatalogDocSectionMap = {
    overview: '',
    clusters: '',
    recent: '',
    risks: '',
  };
  if (!body.match(ANCHORED_SECTION_RE)) {
    return { preamble: body, sections, trailing: '' };
  }
  const firstAnchor = body.search(/<!--\s*mo:section-start\s+id="/);
  const preamble = firstAnchor > 0 ? body.slice(0, firstAnchor) : '';

  let lastEnd = -1;
  ANCHORED_SECTION_RE.lastIndex = 0;
  for (const match of body.matchAll(ANCHORED_SECTION_RE)) {
    const id = match[1] as CatalogDocSectionId;
    if (CATALOG_DOC_SECTIONS.includes(id)) {
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

export interface RenderCatalogDocInput {
  folderName: string;
  preamble: string;
  sections: CatalogDocSectionMap;
  trailing: string;
}

export function renderCatalogDoc(parts: RenderCatalogDocInput): string {
  const heading = parts.preamble.trim().length > 0
    ? parts.preamble.replace(/\n+$/, '\n')
    : `# Mo Catalog — ${parts.folderName}\n\n`;
  const sections = CATALOG_DOC_SECTIONS.map((id) =>
    renderSection(id, parts.sections[id] || SECTION_PLACEHOLDERS[id]),
  ).join('\n\n');
  const trailing = parts.trailing.trim().length > 0
    ? '\n\n' + parts.trailing.replace(/^\n+/, '')
    : '\n';
  return heading + sections + trailing;
}

const SECTION_HARD_CAP = 12_000;

export function mergeCatalogDoc(
  current: string,
  llmResponse: string,
  folderName: string,
): string {
  const parsed = parseCatalogDoc(current);
  const llm = parseCatalogDoc(llmResponse);
  const merged: CatalogDocSectionMap = { ...parsed.sections };
  for (const id of CATALOG_DOC_SECTIONS) {
    const next = llm.sections[id].trim();
    if (next.length > 0) {
      merged[id] = trimSectionIfOversized(next);
    }
  }
  return renderCatalogDoc({
    folderName,
    preamble: parsed.preamble,
    sections: merged,
    trailing: parsed.trailing,
  });
}

export function catalogDocHasContent(body: string): boolean {
  if (!body.trim()) return false;
  const { sections } = parseCatalogDoc(body);
  for (const id of CATALOG_DOC_SECTIONS) {
    const v = sections[id].trim();
    if (v.length > 0 && !v.startsWith('_') && !v.endsWith('_')) return true;
  }
  return false;
}

function trimSectionIfOversized(body: string): string {
  if (body.length <= SECTION_HARD_CAP) return body;
  const lines = body.split('\n');
  while (
    lines.length > 1 &&
    lines.join('\n').length > SECTION_HARD_CAP
  ) {
    lines.shift();
  }
  return lines.join('\n');
}
