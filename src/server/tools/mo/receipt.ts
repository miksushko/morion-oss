import { createHash } from 'node:crypto';

/**
 * Shared receipt envelope returned by every Mo write tool.
 *
 * The contract is bigger than a normal MCP tool's return because the
 * agent (and the human, via the activity feed) needs to verify three
 * things explicitly:
 *
 *   1. **What changed in the DB.** `wrote[]` lists every row touched —
 *      typically 1-2 entries per call. Lets the agent reason about
 *      blast radius instead of inferring from a free-text response.
 *   2. **Whether Mo wrote what was asked.** `afterHash` (and
 *      optional `beforeHash`) lets the agent verify the persisted body
 *      matches its intent — catches silent transformations like
 *      Phase 1's secret-redaction or Phase 2b's LLM rewrites.
 *   3. **Whether dedup fired.** `deduped: true` + `existingId` is the
 *      capture-tool's signal that a near-duplicate already existed and
 *      no new row was created. The agent can show the existing card
 *      to the user instead of claiming "I saved it."
 *
 * `reason` is a one-sentence human-readable summary the agent can echo
 * to the user without composing one itself.
 *
 * `warnings` mirrors the Phase 1 read-tool warnings array (e.g. "we
 * redacted N secrets from your input before saving").
 */

export type ReceiptEntryKind = 'note' | 'comment' | 'task_move';
export type ReceiptEntryAction = 'created' | 'appended' | 'moved' | 'commented';

export interface ReceiptEntry {
  kind: ReceiptEntryKind;
  id: string;
  action: ReceiptEntryAction;
}

export interface MoReceiptCreated {
  ok: true;
  wrote: ReceiptEntry[];
  /** sha256(prefix-16-hex) of the normalized post-write body. */
  afterHash: string;
  /** Only present for appends / moves where a prior body existed. */
  beforeHash?: string;
  reason: string;
  warnings?: string[];
}

export interface MoReceiptDeduped {
  ok: true;
  wrote: [];
  deduped: true;
  existingId: string;
  /** Hash of the EXISTING body so the agent can verify it's still the
   * same thing it was last shown — catches the "user edited it
   * meanwhile" case in long-running agent sessions. */
  afterHash: string;
  reason: string;
  warnings?: string[];
}

export type MoReceipt = MoReceiptCreated | MoReceiptDeduped;

/**
 * Normalize text before hashing so trivial whitespace / case
 * differences don't change the hash. Same normalization as the dedup
 * trigram step — keeps "did Mo write what I asked?" consistent with
 * "is this a duplicate?" semantics.
 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * 16-hex-char prefix of sha256(normalized text). Long enough that a
 * collision is statistically irrelevant for verification (2^64 space)
 * but short enough to be inline-readable in receipts and audit rows.
 */
export function bodyHash(text: string): string {
  return createHash('sha256').update(normalize(text)).digest('hex').slice(0, 16);
}

export interface BuildCreatedReceiptInput {
  wrote: ReceiptEntry[];
  body: string;
  reason: string;
  warnings?: string[];
  beforeBody?: string;
}

export function buildCreatedReceipt({
  wrote,
  body,
  reason,
  warnings,
  beforeBody,
}: BuildCreatedReceiptInput): MoReceiptCreated {
  const r: MoReceiptCreated = {
    ok: true,
    wrote,
    afterHash: bodyHash(body),
    reason,
  };
  if (beforeBody !== undefined) r.beforeHash = bodyHash(beforeBody);
  if (warnings !== undefined && warnings.length > 0) r.warnings = warnings;
  return r;
}

export interface BuildDedupedReceiptInput {
  existingId: string;
  existingBody: string;
  reason: string;
  warnings?: string[];
}

export function buildDedupedReceipt({
  existingId,
  existingBody,
  reason,
  warnings,
}: BuildDedupedReceiptInput): MoReceiptDeduped {
  const r: MoReceiptDeduped = {
    ok: true,
    wrote: [],
    deduped: true,
    existingId,
    afterHash: bodyHash(existingBody),
    reason,
  };
  if (warnings !== undefined && warnings.length > 0) r.warnings = warnings;
  return r;
}
