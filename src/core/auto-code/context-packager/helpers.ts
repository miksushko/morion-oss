import { ACCEPTANCE_SECTION_RE, type SectionDiagnostic } from './types.js';

export interface AcceptanceSplit {
  acceptance: string;
  taskBodyWithoutAcceptance: string;
}

/**
 * Find a `## Acceptance` (or `## Acceptance criteria`) section in
 * the task body and lift it out. The hoisted text goes in section 6
 * of the prompt; the rest of the body lives in section 7.
 *
 * If no acceptance heading exists, returns the body verbatim with
 * empty acceptance.
 */
export function extractAcceptanceSection(body: string): AcceptanceSplit {
  const match = body.match(ACCEPTANCE_SECTION_RE);
  if (!match) {
    return { acceptance: '', taskBodyWithoutAcceptance: body };
  }
  const acceptance = (match[2] ?? '').trim();
  // Splice the matched block out of the body.
  const start = match.index ?? 0;
  const end = start + match[0].length;
  const before = body.slice(0, start);
  const after = body.slice(end);
  // Drop the orphan blank line the splice may leave behind.
  const stitched = (before + after).replace(/\n{3,}/g, '\n\n').trim();
  return { acceptance, taskBodyWithoutAcceptance: stitched };
}

export function computeTotal(
  rendered: Record<SectionDiagnostic['id'], string>,
  dropped: Set<SectionDiagnostic['id']>,
): number {
  // Approximate — joining with '\n\n' adds 2 chars per included
  // pair. Close enough for budget enforcement; real measurement
  // happens after compose.
  let total = 0;
  let count = 0;
  for (const id of Object.keys(rendered) as Array<SectionDiagnostic['id']>) {
    if (dropped.has(id)) continue;
    if (rendered[id].length === 0) continue;
    total += rendered[id].length;
    count++;
  }
  return total + Math.max(0, count - 1) * 2;
}
