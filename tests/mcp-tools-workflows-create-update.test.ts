import { beforeEach, describe, expect, it } from 'vitest';
import {
  workflowsCreateTool,
  workflowsUpdateTool,
} from '../src/server/tools/plugins/auto-code.js';
import { auditRecentTool } from '../src/server/tools/index.js';
import { type Ctx, setup } from './mcp-tools/helpers.js';
import {
  DEFAULT_AUTOCODE_DEFINITION,
  LEGACY_LINEAR_AUTOCODE_DEFINITION,
} from '../src/core/auto-code/workflows/default-autocode.js';
import { DEFAULT_TEMPLATE_ID } from '../src/core/auto-code/workflows/templates.js';
import { WorkflowsRepository } from '../src/core/auto-code/workflows/workflows-repository.js';
import { readFolderWorkflowTemplate } from '../src/server/features/auto-code-template-settings.js';
import type { WorkflowRow } from '../src/core/auto-code/workflows/types/index.js';
import type { AuditRecentEntry } from '../src/core/audit/log.js';

/**
 * `workflows_create` + `workflows_update` MCP tools — Mo Workflows
 * epic.
 *
 * First MCP write path for workflow definitions: folder-bit gating,
 * repository validation with structured envelopes, folder-default
 * mirroring, template immutability, workflow_* audit rows.
 */

interface WriteResult {
  ok?: boolean;
  workflow?: WorkflowRow;
  error?: string;
  message?: string;
  issues?: Array<{ path: string; message: string }>;
}

describe('MCP tools — workflows_create', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  it('creates a workflow row, audits it, and leaves the folder default alone', async () => {
    const folder = ctx.tc.folders.create('F');
    const res = (await workflowsCreateTool.handler(
      {
        folderId: folder.id,
        name: 'My flow',
        definition: LEGACY_LINEAR_AUTOCODE_DEFINITION as unknown as Record<
          string,
          unknown
        >,
      },
      ctx.tc,
    )) as WriteResult;

    expect(res.ok).toBe(true);
    expect(res.workflow?.name).toBe('My flow');
    expect(res.workflow?.folderId).toBe(folder.id);
    expect(res.workflow?.isDefault).toBe(false);
    // Folder default untouched without setAsFolderDefault.
    expect(readFolderWorkflowTemplate(ctx.tc.settings, folder.id)).toBe(
      DEFAULT_TEMPLATE_ID,
    );
    // Audit row with the calling actor.
    const rows = (await auditRecentTool.handler({}, ctx.tc)) as AuditRecentEntry[];
    const audit = rows.find((r) => r.action === 'workflow_create');
    expect(audit?.noteId).toBe(res.workflow?.id);
    expect(audit?.actor).toBe('mcp:test-client');
  });

  it('setAsFolderDefault pins the row badge AND the folder settings selection', async () => {
    const folder = ctx.tc.folders.create('F');
    const res = (await workflowsCreateTool.handler(
      {
        folderId: folder.id,
        name: 'Pinned',
        definition: DEFAULT_AUTOCODE_DEFINITION as unknown as Record<
          string,
          unknown
        >,
        setAsFolderDefault: true,
      },
      ctx.tc,
    )) as WriteResult;

    expect(res.ok).toBe(true);
    expect(res.workflow?.isDefault).toBe(true);
    expect(readFolderWorkflowTemplate(ctx.tc.settings, folder.id)).toBe(
      res.workflow?.id,
    );
  });

  it('maps validation failures to the structured envelope and writes nothing', async () => {
    const folder = ctx.tc.folders.create('F');
    const bad = structuredClone(DEFAULT_AUTOCODE_DEFINITION);
    bad.stages[1].id = bad.stages[0].id; // duplicate ids
    const res = (await workflowsCreateTool.handler(
      {
        folderId: folder.id,
        name: 'Broken',
        definition: bad as unknown as Record<string, unknown>,
      },
      ctx.tc,
    )) as WriteResult;

    expect(res.error).toBe('invalid_workflow_definition');
    expect(res.issues?.length).toBeGreaterThan(0);
    expect(
      new WorkflowsRepository(ctx.handle.db).listForFolder(folder.id).length,
    ).toBe(0);
  });

  it('gates on the folder create permission for MCP actors', async () => {
    const folder = ctx.tc.folders.create('F');
    ctx.tc.folders.setMcpPermissions(folder.id, {
      visible: true,
      create: false,
      update: true,
      delete: true,
    });
    const res = (await workflowsCreateTool.handler(
      {
        folderId: folder.id,
        name: 'Nope',
        definition: LEGACY_LINEAR_AUTOCODE_DEFINITION as unknown as Record<
          string,
          unknown
        >,
      },
      ctx.tc,
    )) as WriteResult;
    expect(res.error).toBe('mcp_access_denied');

    // The user actor is never gated.
    const asUser = (await workflowsCreateTool.handler(
      {
        folderId: folder.id,
        name: 'User flow',
        definition: LEGACY_LINEAR_AUTOCODE_DEFINITION as unknown as Record<
          string,
          unknown
        >,
      },
      { ...ctx.tc, actor: 'user' },
    )) as WriteResult;
    expect(asUser.ok).toBe(true);
  });

  it('returns folder_not_found for a missing folder (user actor path)', async () => {
    const res = (await workflowsCreateTool.handler(
      {
        folderId: 'no-such-folder',
        name: 'X',
        definition: LEGACY_LINEAR_AUTOCODE_DEFINITION as unknown as Record<
          string,
          unknown
        >,
      },
      { ...ctx.tc, actor: 'user' },
    )) as WriteResult;
    expect(res.error).toBe('folder_not_found');
  });
});

describe('MCP tools — workflows_update', () => {
  let ctx: Ctx;
  let folderId: string;
  let rowId: string;

  beforeEach(async () => {
    ctx = setup();
    folderId = ctx.tc.folders.create('F').id;
    const created = (await workflowsCreateTool.handler(
      {
        folderId,
        name: 'Editable',
        definition: DEFAULT_AUTOCODE_DEFINITION as unknown as Record<
          string,
          unknown
        >,
      },
      ctx.tc,
    )) as WriteResult;
    rowId = created.workflow!.id;
  });

  it('renames without touching the definition', async () => {
    const res = (await workflowsUpdateTool.handler(
      { workflowId: rowId, folderId, name: 'Renamed' },
      ctx.tc,
    )) as WriteResult;
    expect(res.ok).toBe(true);
    expect(res.workflow?.name).toBe('Renamed');
    expect(res.workflow?.definition.stages.length).toBe(
      DEFAULT_AUTOCODE_DEFINITION.stages.length,
    );
    // Audit row present.
    const rows = (await auditRecentTool.handler({}, ctx.tc)) as AuditRecentEntry[];
    expect(
      rows.some((r) => r.action === 'workflow_update' && r.noteId === rowId),
    ).toBe(true);
  });

  it('rejects an invalid replacement definition and keeps the row intact', async () => {
    const bad = structuredClone(DEFAULT_AUTOCODE_DEFINITION);
    bad.stages = bad.stages.filter((s) => s.kind !== 'reject_sink');
    const ids = new Set(bad.stages.map((s) => s.id));
    bad.edges = bad.edges.filter((e) => ids.has(e.from) && ids.has(e.to));

    const res = (await workflowsUpdateTool.handler(
      {
        workflowId: rowId,
        folderId,
        definition: bad as unknown as Record<string, unknown>,
      },
      ctx.tc,
    )) as WriteResult;
    expect(res.error).toBe('invalid_workflow_definition');

    const row = new WorkflowsRepository(ctx.handle.db).getById(rowId);
    expect(row?.definition.stages.length).toBe(
      DEFAULT_AUTOCODE_DEFINITION.stages.length,
    );
  });

  it('refuses built-in template ids with template_immutable', async () => {
    const res = (await workflowsUpdateTool.handler(
      { workflowId: DEFAULT_TEMPLATE_ID, folderId, name: 'Hack' },
      ctx.tc,
    )) as WriteResult;
    expect(res.error).toBe('template_immutable');
    expect(res.message).toContain('workflows_copy');
  });

  it('enforces folder isolation: a workflow from another folder is not found', async () => {
    const otherFolder = ctx.tc.folders.create('Other').id;
    const res = (await workflowsUpdateTool.handler(
      { workflowId: rowId, folderId: otherFolder, name: 'Steal' },
      ctx.tc,
    )) as WriteResult;
    expect(res.error).toBe('workflow_not_found');
  });

  it('setAsFolderDefault: true mirrors to settings; omitted leaves it alone', async () => {
    let res = (await workflowsUpdateTool.handler(
      { workflowId: rowId, folderId, setAsFolderDefault: true },
      ctx.tc,
    )) as WriteResult;
    expect(res.ok).toBe(true);
    expect(res.workflow?.isDefault).toBe(true);
    expect(readFolderWorkflowTemplate(ctx.tc.settings, folderId)).toBe(rowId);

    // A later rename without the flag must not reset the selection.
    res = (await workflowsUpdateTool.handler(
      { workflowId: rowId, folderId, name: 'Still default' },
      ctx.tc,
    )) as WriteResult;
    expect(res.ok).toBe(true);
    expect(readFolderWorkflowTemplate(ctx.tc.settings, folderId)).toBe(rowId);
  });

  it('gates on the folder update permission for MCP actors', async () => {
    ctx.tc.folders.setMcpPermissions(folderId, {
      visible: true,
      create: true,
      update: false,
      delete: true,
    });
    const res = (await workflowsUpdateTool.handler(
      { workflowId: rowId, folderId, name: 'Nope' },
      ctx.tc,
    )) as WriteResult;
    expect(res.error).toBe('mcp_access_denied');
  });
});
