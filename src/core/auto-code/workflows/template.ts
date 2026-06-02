/**
 * Auto-code Workflow Builder L2.T4 — tiny Mustache-lite template renderer
 * for workflow stage prompts.
 *
 * Supports `{{a.b.c}}` deep-key substitution. No conditionals, no loops,
 * no escaping logic — workflow prompts are LLM-bound text where HTML
 * escaping would corrupt code blocks. Per cross-layer invariant #7
 * (typed primitives, no runtime expression language) this stays
 * intentionally minimal.
 *
 * Missing keys substitute the empty string AND record the missing path
 * in the result so the workflow runner can log "prompt referenced
 * stages.fix.output.diff but stage hadn't produced one yet" rather
 * than silently shipping a half-rendered prompt.
 */

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_$][\w.$]*)\s*\}\}/g;

export interface RenderResult {
  output: string;
  /** Distinct dotted keys referenced in the template that were not
   *  found in the context. Empty array on a fully-satisfied render. */
  missingKeys: readonly string[];
}

export function renderPromptTemplate(
  template: string,
  context: Readonly<Record<string, unknown>>,
): RenderResult {
  const missing = new Set<string>();
  const output = template.replace(PLACEHOLDER_RE, (_match, path: string) => {
    const resolved = lookupPath(context, path);
    if (resolved === undefined) {
      missing.add(path);
      return '';
    }
    return formatScalar(resolved);
  });
  return { output, missingKeys: [...missing] };
}

function lookupPath(root: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = root;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Objects + arrays serialise as JSON. Useful for stages.fix.output
  // (object) being interpolated into a review prompt.
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}
