import { fetchOrThrow } from '../http';
import type {
  AutoCodePreflight,
  AutoCodeWorkflowFull,
  AutoCodeWorkflowResolution,
  AutoCodeWorkflowSummary,
  AutoCodeWorkflowTemplate,
} from '../types';

/**
 * Auto-Code workflow registry — shipped template listing + per-folder
 * custom workflow CRUD + preflight (binary + MCP install status).
 */
export const autocodeWorkflowsApi = {
  /** List shipped Auto-Code workflow templates the user can select
   *  per folder. Pro-gated server-side (returns 402 on Free). */
  listAutoCodeWorkflowTemplates: async (): Promise<{
    templates: AutoCodeWorkflowTemplate[];
  }> => {
    const res = await fetchOrThrow('/api/auto-code/workflow-templates');
    return (await res.json()) as { templates: AutoCodeWorkflowTemplate[] };
  },

  // ---- Этап 2: per-folder custom workflows CRUD ----

  listAutoCodeWorkflows: async (
    folderId: string,
  ): Promise<{ workflows: AutoCodeWorkflowSummary[] }> => {
    const res = await fetchOrThrow(
      `/api/auto-code/workflows?folderId=${encodeURIComponent(folderId)}`,
    );
    return (await res.json()) as { workflows: AutoCodeWorkflowSummary[] };
  },

  getAutoCodeWorkflow: async (id: string): Promise<AutoCodeWorkflowFull> => {
    const res = await fetchOrThrow(
      `/api/auto-code/workflows/${encodeURIComponent(id)}`,
    );
    return (await res.json()) as AutoCodeWorkflowFull;
  },

  createAutoCodeWorkflow: async (input: {
    folderId: string;
    name: string;
    definition: unknown;
    isDefault?: boolean;
  }): Promise<AutoCodeWorkflowFull> => {
    const res = await fetchOrThrow('/api/auto-code/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    return (await res.json()) as AutoCodeWorkflowFull;
  },

  updateAutoCodeWorkflow: async (
    id: string,
    patch: { name?: string; definition?: unknown; isDefault?: boolean },
  ): Promise<AutoCodeWorkflowFull> => {
    const res = await fetchOrThrow(
      `/api/auto-code/workflows/${encodeURIComponent(id)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      },
    );
    return (await res.json()) as AutoCodeWorkflowFull;
  },

  deleteAutoCodeWorkflow: async (id: string): Promise<void> => {
    await fetchOrThrow(
      `/api/auto-code/workflows/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
  },

  cloneAutoCodeWorkflow: async (id: string): Promise<AutoCodeWorkflowFull> => {
    const res = await fetchOrThrow(
      `/api/auto-code/workflows/${encodeURIComponent(id)}/clone`,
      { method: 'POST' },
    );
    return (await res.json()) as AutoCodeWorkflowFull;
  },
  getAutoCodePreflight: async (folderId: string): Promise<AutoCodePreflight> => {
    const res = await fetchOrThrow(
      `/api/concierge/folders/${encodeURIComponent(folderId)}/auto-code/preflight`,
    );
    return (await res.json()) as AutoCodePreflight;
  },
  /** Workflow-resolution diagnostic — what the sidecar actually
   *  resolves the folder's stored workflow selection to. Drives the
   *  banner that warns the user when the dropdown selection isn't
   *  what the runner is dispatching (Morion ticket
   *  01KRRXB2K744SKJGAZHW6KET93). */
  getAutoCodeWorkflowResolution: async (
    folderId: string,
  ): Promise<AutoCodeWorkflowResolution> => {
    const res = await fetchOrThrow(
      `/api/concierge/folders/${encodeURIComponent(folderId)}/auto-code/workflow-resolution`,
    );
    return (await res.json()) as AutoCodeWorkflowResolution;
  },
};
