import type { McpToolPlugin } from './types.js';

/**
 * Public OSS build: no auto-code MCP tools. `ALL_TOOLS` is the core
 * surface only (47 tools). Swapped to `index.ts` at export time.
 */
export const toolPlugins: McpToolPlugin[] = [];
