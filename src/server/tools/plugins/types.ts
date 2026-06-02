import type { ZodRawShape } from 'zod';
import type { ToolDef } from '../types.js';

/**
 * A pluggable group of MCP tools appended to the core registry by
 * `tools/index.ts` (`ALL_TOOLS`). The MASTER build loads the auto-code
 * tool plugin; the public OSS export swaps in an empty plugin list
 * (`plugins/index.public.ts`) and excludes `plugins/auto-code.ts`, so
 * `tools/index.ts` ships byte-identical to both repos.
 */
export interface McpToolPlugin {
  tools: ToolDef<ZodRawShape>[];
}
