/**
 * Conservative secret-shape redaction for note bodies before they go
 * into a Work Context Packet handed back to an external agent. False
 * positives (a hex SHA in a normal note gets `[REDACTED]`) are
 * acceptable; a leaked API key is not.
 *
 * Patterns:
 *   - `sk-…` keys (OpenAI / Anthropic / Groq style)
 *   - `AKIA…` AWS access key prefix
 *   - `Bearer …` HTTP Authorization values
 *   - JWT-shaped three-part tokens (header.payload.sig)
 *   - Long bare hex strings (32+ chars, common for SHA / MD5 / API tokens)
 *
 * If a real false positive bites in dogfooding, narrow the pattern OR
 * give the user an opt-out per-folder — never widen by relaxing here.
 */

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_\-]{16,}\b/g,
  /\bAKIA[A-Z0-9]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._\-]{16,}\b/gi,
  /\b[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\b/g,
  /\b[A-Fa-f0-9]{32,}\b/g,
];

export const REDACTED_PLACEHOLDER = '[REDACTED — possible secret]';

export interface RedactResult {
  text: string;
  /** Number of substitutions made. `> 0` means the caller should add
   * a "we redacted N suspicious string(s)" warning to the packet. */
  hits: number;
}

export function redactSecrets(input: string): RedactResult {
  let hits = 0;
  let out = input;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, () => {
      hits += 1;
      return REDACTED_PLACEHOLDER;
    });
  }
  return { text: out, hits };
}
