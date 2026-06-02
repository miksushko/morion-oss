import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolDef } from '../../../server/tools/types.js';
import type { LLMToolDefinition } from '../provider.js';

/**
 * One tool call emitted by the chat LLM, before dispatcher routing.
 */
export interface MoToolInvocation {
  /** Name of the tool as it appears in the LLMToolDefinition list. */
  name: string;
  /** Raw JSON string of the call arguments as the model emitted them. */
  argumentsJson: string;
}

/**
 * Build the LLMToolDefinition array Mo sends to the provider from
 * the server's ALL_TOOLS registry.
 *
 * Harmony-compat tweaks: strip `default`, flatten nullable unions.
 * zod-to-json-schema produces schemas that most OpenAI-compatible
 * endpoints accept, but Groq's gpt-oss tokenizer rejects a handful
 * of JSON Schema keywords (see chat-tools.ts comment block). We
 * walk the output recursively and prune those.
 *
 * Schema target: **jsonSchema7** (NOT openApi3). The original code
 * picked `target: 'openApi3'` which renders Zod's `.positive()` /
 * `.gt()` / `.lt()` as draft-04-style `exclusiveMinimum: true`
 * (boolean) paired with `minimum: 0`. Most providers tolerate this,
 * but OpenAI's strict tool-validator (api.openai.com /v1/chat/completions)
 * rejects with `"True is not of type 'number'"` because draft-2020-12
 * expects `exclusiveMinimum: <number>`. jsonSchema7 emits the
 * numeric form natively → all providers happy. 2026-04-26.
 */
export function buildMoToolDefinitions(
  tools: ReadonlyArray<ToolDef<z.ZodRawShape>>,
): LLMToolDefinition[] {
  return tools.map((def) => {
    const zod = z.object(def.inputShape);
    const schema = zodToJsonSchema(zod, {
      $refStrategy: 'none',
      target: 'jsonSchema7',
    }) as Record<string, unknown>;
    return {
      name: def.name,
      description: def.description,
      parameters: harmonyCompat(schema),
    };
  });
}

/**
 * Walk the JSON Schema tree and:
 *   - drop `default` (harmony rejects)
 *   - flatten `type: ['string','null']` → `type: 'string'` + nullable note
 *   - drop `additionalProperties: true` (some endpoints choke)
 *   - keep `additionalProperties: false` where present
 */
function harmonyCompat(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return {} as Record<string, unknown>;
  const input = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (k === 'default') continue;
    if (k === '$schema') continue;
    if (k === 'type' && Array.isArray(v)) {
      // ['string', 'null'] → 'string' (dispatcher treats missing/empty as null)
      const nonNull = v.filter((x) => x !== 'null');
      out.type = nonNull.length === 1 ? nonNull[0] : nonNull;
      continue;
    }
    if (k === 'additionalProperties' && v === true) continue;
    out[k] = harmonyTransformValue(v);
  }
  return out;
}

function harmonyTransformValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(harmonyTransformValue);
  if (v && typeof v === 'object') return harmonyCompat(v);
  return v;
}
