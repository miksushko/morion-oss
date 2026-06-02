#!/usr/bin/env node
/**
 * Emit the `tools` array for the MCPB manifest by reading the live tool
 * defs. Keeps the manifest in sync with whatever tools ship in the code
 * — no hand-maintained list to drift out of date.
 *
 * Printed to stdout as JSON (a single array). Stderr is used for any
 * diagnostics so `package-mcpb.mjs` can pipe stdout straight into
 * `JSON.parse`.
 *
 * Annotations mirror what `src/server/mcp.ts` passes to `registerTool`
 * — category-derived defaults + per-tool overrides. The MCPB manifest
 * spec allows a `tools` array for directory listings; we include name +
 * description only (annotations live on the actual tool registration
 * inside the bundled server, not the manifest).
 */

import { ALL_TOOLS } from '../src/server/tools/index.ts';

const tools = ALL_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
}));

process.stdout.write(JSON.stringify(tools, null, 2));
