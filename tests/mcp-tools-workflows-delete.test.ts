import { beforeEach, describe, expect, it } from 'vitest';
import {
  workflowsCreateTool,
  workflowsDeleteTool,
} from '../src/server/tools/plugins/auto-code.js';
import { auditRecentTool, notesCreateTool, notesUpdateTool } from '../src/server/tools/index.js';
import { type Ctx, setup } from './mcp-tools/helpers.js';
import { DEFAULT_TEMPLATE_ID } from '../src/core/auto-code/workflows/templates.js';
import { LEGACY_LINEAR_AUTOCODE_DEFINITION } from '../src/core/auto-code/workflows/default-autocode.js';
import { WorkflowsRepository } from '../src/core/auto-code/workflows/workflows-repository.js';
import { readFolderWorkflowTemplate } from '../src/server/features/auto-code-template-settings.js';
import type { WorkflowRow } from '../src/core/auto-code/workflows/types/index.js';
import type { AuditRecentEntry } from '../src/core/audit/log.js';
import type { Note } from '../src/core/notes/types.js';

/**
 * `workflows_delete` MCP tool — Mo Workflows epic.
 *
 * MCP mirror of the HTTP DELETE route: default-setting reset,
 * per-ticket override sweep, sticky-delete bookkeeping, audit row.
 */

interface DeleteResult {
  ok?: boolean;
  deletedWorkflowId?: string;
  clearedFolderDefault?: boolean;
  clearedTicketCount?: number;
  error?: string;
  message?: string;
}

describe('MCP tools — workflows_delete', () => {
  let ctx: Ctx;
  let folderId: string;
  let row: WorkflowRow;

  beforeEach(async () => {
    ctx = setup();
    folderId = ctx.tc.folders.create('F').id;
    const created = (await workflowsCreateTool.handler(
      {
        folderId,
        name: 'Doomed',
        definition: LEGACY_LINEAR_AUTOCODE_DEFINITION as unknown as Record<
          string,
          unknown
        >,
      },
      ctx.tc,
    )) as { workflow: WorkflowRow };
    row = created.workflow;
  });

  it('deletes the row, resets a pointing folder default, sweeps ticket overrides, audits', async () => {
    // Pin as folder default + attach to a ticket.
    const pin = (await workflowsCreateTool.handler(
      {
        folderId,
        name: 'Pinned victim',
        definition: LEGACY_LINEAR_AUTOCODE_DEFINITION as unknown as Record<
          string,
          unknown
        >,
        setAsFolderDefault: true,
      },
      ctx.tc,
    )) as { workflow: WorkflowRow };
    const note = (await notesCreateTool.handler(
      { body: '# ticket', folderId },
      ctx.tc,
    )) as Note;
    await notesUpdateTool.handler(
      { id: note.id, workflowId: pin.workflow.id },
      ctx.tc,
    );

    const res = (await workflowsDeleteTool.handler(
      { workflowId: pin.workflow.id, folderId },
      ctx.tc,
    )) as DeleteResult;

    expect(res.ok).toBe(true);
    expect(res.deletedWorkflowId).toBe(pin.workflow.id);
    expect(res.clearedFolderDefault).toBe(true);
    expect(res.clearedTicketCount).toBe(1);
    expect(readFolderWorkflowTemplate(ctx.tc.settings, folderId)).toBe(
      DEFAULT_TEMPLATE_ID,
    );
    expect(
      new WorkflowsRepository(ctx.handle.db).getById(pin.workflow.id),
    ).toBeNull();
    const rows = (await auditRecentTool.handler({}, ctx.tc)) as AuditRecentEntry[];
    expect(
      rows.some(
        (r) => r.action === 'workflow_delete' && r.noteId === pin.workflow.id,
      ),
    ).toBe(true);
  });

  it('leaves an unrelated folder default untouched', async () => {
    const res = (await workflowsDeleteTool.handler(
      { workflowId: row.id, folderId },
      ctx.tc,
    )) as DeleteResult;
    expect(res.ok).toBe(true);
    expect(res.clearedFolderDefault).toBe(false);
    expect(res.clearedTicketCount).toBe(0);
  });

  it('refuses built-in template ids with template_immutable', async () => {
    const res = (await workflowsDeleteTool.handler(
      { workflowId: DEFAULT_TEMPLATE_ID, folderId },
      ctx.tc,
    )) as DeleteResult;
    expect(res.error).toBe('template_immutable');
  });

  it('enforces folder isolation', async () => {
    const other = ctx.tc.folders.create('Other').id;
    const res = (await workflowsDeleteTool.handler(
      { workflowId: row.id, folderId: other },
      ctx.tc,
    )) as DeleteResult;
    expect(res.error).toBe('workflow_not_found');
    expect(new WorkflowsRepository(ctx.handle.db).getById(row.id)).toBeTruthy();
  });

  it('gates on the folder delete permission for MCP actors', async () => {
    ctx.tc.folders.setMcpPermissions(folderId, {
      visible: true,
      create: true,
      update: true,
      delete: false,
    });
    const res = (await workflowsDeleteTool.handler(
      { workflowId: row.id, folderId },
      ctx.tc,
    )) as DeleteResult;
    expect(res.error).toBe('mcp_access_denied');
    expect(new WorkflowsRepository(ctx.handle.db).getById(row.id)).toBeTruthy();
  });

  it('records sticky-delete for seeded-template-derived rows', async () => {
    // Simulate seeding provenance: mark the row as derived from a
    // template, then delete it and check the tracker.
    ctx.tc.settings.set(
      `auto_code.seeded_row_provenance.${folderId}`,
      JSON.stringify({ [row.id]: DEFAULT_TEMPLATE_ID }),
    );
    const res = (await workflowsDeleteTool.handler(
      { workflowId: row.id, folderId },
      ctx.tc,
    )) as DeleteResult;
    expect(res.ok).toBe(true);
    const tracker = ctx.tc.settings.get<string>(
      `auto_code.seeded_templates.${folderId}`,
      '',
    );
    expect(tracker.split(',')).toContain(DEFAULT_TEMPLATE_ID);
  });
});
