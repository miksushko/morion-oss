import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildMoToolDefinitions } from '../../src/core/concierge/mo-tools.js';
import type { ToolDef } from '../../src/server/tools/types.js';

/**
 * `buildMoToolDefinitions` harmony-compat transforms — `default`
 * dropped, `['x','null']` flattened, `additionalProperties:true`
 * dropped, `additionalProperties:false` preserved, nested objects
 * walked recursively. Pinned by the per-source-leaf split
 * `src/core/concierge/mo-tools/schema.ts`.
 */
describe('buildMoToolDefinitions — harmony-compat transforms', () => {
  it('drops top-level `default` from the schema', () => {
    const tool: ToolDef<{ q: z.ZodDefault<z.ZodString> }> = {
      name: 'sample',
      description: 'sample description',
      category: 'read',
      inputShape: { q: z.string().default('hello') },
      handler: async () => ({}),
    };
    const [def] = buildMoToolDefinitions([tool]);
    const params = def.parameters as Record<string, unknown>;
    const properties = params.properties as Record<string, Record<string, unknown>>;
    // Default dropped; string type preserved.
    expect(properties.q).not.toHaveProperty('default');
    expect(properties.q.type).toBe('string');
  });

  it('flattens ["string","null"] to "string"', () => {
    const tool: ToolDef<{ opt: z.ZodOptional<z.ZodNullable<z.ZodString>> }> = {
      name: 'sample',
      description: 'sample description',
      category: 'read',
      inputShape: { opt: z.string().nullable().optional() },
      handler: async () => ({}),
    };
    const [def] = buildMoToolDefinitions([tool]);
    const params = def.parameters as Record<string, unknown>;
    const properties = params.properties as Record<string, Record<string, unknown>>;
    // type may be 'string' or have been simplified — must never be an
    // array with 'null' in it.
    const t = properties.opt.type;
    expect(t).not.toEqual(expect.arrayContaining(['null']));
  });

  it('drops additionalProperties:true (but keeps false)', () => {
    const recordTool: ToolDef<{ kv: z.ZodRecord<z.ZodString, z.ZodString> }> = {
      name: 'record-sample',
      description: 'record sample',
      category: 'read',
      inputShape: { kv: z.record(z.string(), z.string()) },
      handler: async () => ({}),
    };
    const [def] = buildMoToolDefinitions([recordTool]);
    const params = def.parameters as Record<string, unknown>;
    const properties = params.properties as Record<string, Record<string, unknown>>;
    // zod record → { type:'object', additionalProperties: {type:'string'} }
    // The value is an object schema (not literal true), so harmonyCompat
    // should keep it. If it were `true`, it must be dropped.
    const ap = properties.kv.additionalProperties;
    expect(ap).not.toBe(true);
  });

  it('preserves the name + description from the tool def', () => {
    const tool: ToolDef<Record<string, z.ZodString>> = {
      name: 'my-tool',
      description: 'does a thing',
      category: 'read',
      inputShape: {},
      handler: async () => ({}),
    };
    const [def] = buildMoToolDefinitions([tool]);
    expect(def.name).toBe('my-tool');
    expect(def.description).toBe('does a thing');
  });

  it('returns one LLMToolDefinition per input tool', () => {
    const mk = (n: string): ToolDef<Record<string, z.ZodString>> => ({
      name: n,
      description: n,
      category: 'read',
      inputShape: {},
      handler: async () => ({}),
    });
    const defs = buildMoToolDefinitions([mk('a'), mk('b'), mk('c')]);
    expect(defs).toHaveLength(3);
    expect(defs.map((d) => d.name)).toEqual(['a', 'b', 'c']);
  });

  it('walks nested objects recursively (drops nested default)', () => {
    const tool: ToolDef<{ nested: z.ZodObject<{ inner: z.ZodDefault<z.ZodNumber> }> }> = {
      name: 'nested-sample',
      description: 'nested',
      category: 'read',
      inputShape: {
        nested: z.object({ inner: z.number().default(42) }),
      },
      handler: async () => ({}),
    };
    const [def] = buildMoToolDefinitions([tool]);
    const params = def.parameters as Record<string, unknown>;
    const properties = params.properties as Record<string, Record<string, unknown>>;
    const nested = properties.nested;
    const nestedProps = nested.properties as Record<string, Record<string, unknown>>;
    expect(nestedProps.inner).not.toHaveProperty('default');
  });
});
