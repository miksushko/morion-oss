/**
 * GET /api/auto-code/workflow-templates — static list of shipped
 * workflow templates with per-template binary-availability probe.
 * Extracted from `../auto-code-workflows.ts` so the route file shell
 * stays focused on the workflow-row CRUD handlers.
 */

import type { Hono } from 'hono';
import { detectAgentAvailability } from '../../../../core/auto-code/preflight.js';
import { listWorkflowTemplates } from '../../../../core/auto-code/workflows/templates.js';
import type { ToolContext } from '../../../tools/types.js';

export function registerWorkflowTemplatesRoute(
  app: Hono,
  _ctx: ToolContext,
): void {
  app.get('/api/auto-code/workflow-templates', (c) => {
    // Probe agent binaries once for the whole list — a fresh `which`
    // per template would be wasteful + non-atomic if the user ran
    // `brew install` mid-render.
    const avail = detectAgentAvailability();
    const ready = (a: string): boolean => {
      switch (a) {
        case 'claude':
          return avail.claude.ready;
        case 'codex':
          return avail.codex.ready;
        case 'pi':
          return avail.pi.ready;
        case 'opencode':
          return avail.opencode.ready;
        default:
          return false;
      }
    };
    const templates = listWorkflowTemplates().map((t) => {
      const missing = t.requiredAgents.filter((a) => !ready(a));
      return {
        id: t.id,
        label: t.label,
        description: t.description,
        agentChain: t.agentChain,
        requiredAgents: t.requiredAgents,
        optionalAgents: t.optionalAgents,
        stageCount: t.definition.stages.length,
        available: missing.length === 0,
        unavailableReason:
          missing.length === 0
            ? null
            : `Requires ${missing.join(', ')} (not installed on this machine).`,
      };
    });
    return c.json({ templates });
  });
}
