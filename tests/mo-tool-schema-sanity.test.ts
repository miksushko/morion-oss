/**
 * Regression: OpenAI's strict tool-validator rejected Mo's tool
 * schemas with `"True is not of type 'number'"`. Root cause:
 * `zodToJsonSchema(zod, { target: 'openApi3' })` produced draft-04-style
 * `exclusiveMinimum: true` (boolean) paired with `minimum: 0` from
 * Zod's `.positive()` / `.gt()` constructs. Modern providers (and
 * draft-2020-12 in general) require `exclusiveMinimum: <number>`.
 *
 * Fix: switched to `target: 'jsonSchema7'`. Test enforces that no
 * generated tool schema carries the draft-04 boolean form anywhere
 * in its tree, for ANY tool in ALL_TOOLS — adding a future tool that
 * accidentally re-introduces draft-04 leakage will fail this.
 *
 * Ticket `01KQ2ZZ969G4RCC20C67M5SJV2` follow-up.
 */
import { describe, it, expect } from 'vitest';
import { buildMoToolDefinitions } from '../src/core/concierge/mo-tools.js';
import { ALL_TOOLS } from '../src/server/tools/index.js';

function walk(node: unknown, visit: (n: Record<string, unknown>, path: string) => void, path = '$'): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item, visit, `${path}[${i}]`));
    return;
  }
  const obj = node as Record<string, unknown>;
  visit(obj, path);
  for (const [k, v] of Object.entries(obj)) {
    walk(v, visit, `${path}.${k}`);
  }
}

describe('Mo tool JSON Schema sanity (no draft-04 leakage)', () => {
  const defs = buildMoToolDefinitions(ALL_TOOLS);

  it('every tool produces a valid parameters object', () => {
    expect(defs.length).toBeGreaterThan(0);
    for (const def of defs) {
      expect(def.name).toBeTruthy();
      expect(def.parameters).toBeDefined();
      expect(typeof def.parameters).toBe('object');
    }
  });

  it('NO tool has draft-04 boolean exclusiveMinimum / exclusiveMaximum (the OpenAI 400 bug class)', () => {
    const violations: Array<{ tool: string; path: string; key: string; value: unknown }> = [];
    for (const def of defs) {
      walk(def.parameters, (n, path) => {
        if (typeof n.exclusiveMinimum === 'boolean') {
          violations.push({
            tool: def.name,
            path,
            key: 'exclusiveMinimum',
            value: n.exclusiveMinimum,
          });
        }
        if (typeof n.exclusiveMaximum === 'boolean') {
          violations.push({
            tool: def.name,
            path,
            key: 'exclusiveMaximum',
            value: n.exclusiveMaximum,
          });
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it('NO tool carries `nullable` (OpenAPI 3 keyword) — strict providers reject', () => {
    // Same family of issue: `nullable: true` is OpenAPI 3, not
    // JSON Schema. Switching to jsonSchema7 should remove it
    // (replaced by `type: ["string", "null"]` etc which we
    // flatten in harmonyCompat). Pin so it doesn't sneak back.
    const violations: Array<{ tool: string; path: string }> = [];
    for (const def of defs) {
      walk(def.parameters, (n, path) => {
        if ('nullable' in n) violations.push({ tool: def.name, path });
      });
    }
    expect(violations).toEqual([]);
  });

  it('mo_search.limit pins the original-bug-class shape — `exclusiveMinimum: <number>`, not boolean', () => {
    // mo_ask.maxNotes was the original triggering tool; after the
    // Phase 10 mo_ask refactor that field is gone. Re-target the pin
    // at mo_search.limit which carries the same `z.number().int()
    // .positive().max(50)` shape — same regression class, same SQL.
    const moSearch = defs.find((d) => d.name === 'mo_search');
    expect(moSearch).toBeDefined();
    const props = (moSearch!.parameters as Record<string, unknown>).properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    expect(props).toBeDefined();
    const limit = props!.limit;
    expect(limit).toBeDefined();
    if ('exclusiveMinimum' in limit) {
      expect(typeof limit.exclusiveMinimum).toBe('number');
    }
    if ('maximum' in limit) {
      expect(typeof limit.maximum).toBe('number');
    }
  });
});
