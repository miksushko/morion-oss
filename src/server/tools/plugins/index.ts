import { autoCodeToolPlugin } from './auto-code.js';
import type { McpToolPlugin } from './types.js';

/**
 * MCP tool plugins loaded in the MASTER (full) build. The public OSS
 * export swaps this file for `index.public.ts` (an empty list) via the
 * scripts/export-public.mjs SWAP map, and EXCLUDES `auto-code.ts`, so
 * `tools/index.ts` (the registry) ships byte-identical to both repos.
 */
export const toolPlugins: McpToolPlugin[] = [autoCodeToolPlugin];
