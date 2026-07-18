import { beforeEach, describe, expect, it } from 'vitest';
import { auditRecentTool, notesCreateTool } from '../src/server/tools/index.js';
import { type Ctx, setup } from './mcp-tools/helpers.js';
import type { AuditRecentEntry } from '../src/core/audit/log.js';
import type { Note } from '../src/core/notes/types.js';
import { WorkflowsRepository } from '../src/core/auto-code/workflows/workflows-repository.js';
import { LEGACY_LINEAR_AUTOCODE_DEFINITION } from '../src/core/auto-code/workflows/default-autocode.js';

/**
 * Workflow audit rows — Mo Workflows epic.
 *
 * `AuditLogger.recordWorkflow` gives the workflows_create/update/
 * copy/delete MCP tools their mandatory audit rows (CLAUDE.md: every
 * MCP mutation writes an audit row with the calling actor). The
 * workflow ULID rides the `note_id` column as a generic subject id —
 * no migration, `audit_recent` surfaces the rows with a null title.
 */

describe('AuditLogger.recordWorkflow', () => {
  let ctx: Ctx;

  beforeEach(() => {
    ctx = setup();
  });

  it('writes a row with the workflow id, action, and calling actor', async () => {
    ctx.tc.audit.recordWorkflow({
      workflowId: '01WFULIDULIDULIDULIDULID00',
      action: 'workflow_create',
      actor: 'mcp:test-client',
    });

    const rows = (await auditRecentTool.handler({}, ctx.tc)) as AuditRecentEntry[];
    const row = rows.find((r) => r.action === 'workflow_create');
    expect(row).toBeTruthy();
    expect(row?.noteId).toBe('01WFULIDULIDULIDULIDULID00');
    expect(row?.actor).toBe('mcp:test-client');
    // No note behind the subject id — join yields null, not a crash.
    expect(row?.noteTitle).toBeNull();
  });

  it('workflow_update rows never coalesce with note update rows', async () => {
    const note = (await notesCreateTool.handler(
      { body: '# n\n\nv1' },
      ctx.tc,
    )) as Note;
    // A note update followed by a workflow_update sharing the actor —
    // the coalesce path keys on action='update', so both survive.
    ctx.tc.audit.record({ noteId: note.id, action: 'update', actor: 'mcp:test-client' });
    ctx.tc.audit.recordWorkflow({
      workflowId: note.id, // worst case: same subject id string
      action: 'workflow_update',
      actor: 'mcp:test-client',
    });
    ctx.tc.audit.recordWorkflow({
      workflowId: note.id,
      action: 'workflow_update',
      actor: 'mcp:test-client',
    });

    const rows = (await auditRecentTool.handler({}, ctx.tc)) as AuditRecentEntry[];
    const wfRows = rows.filter((r) => r.action === 'workflow_update');
    // Discrete events by design — two calls, two rows.
    expect(wfRows.length).toBe(2);
    expect(rows.some((r) => r.action === 'update' && r.noteId === note.id)).toBe(true);
  });

  it('hides workflow rows whose owning folder is MCP-invisible (N4 for workflows)', async () => {
    const hidden = ctx.tc.folders.create('Hidden');
    const open = ctx.tc.folders.create('Open');
    const repo = new WorkflowsRepository(ctx.handle.db);
    const hiddenWf = repo.create({
      folderId: hidden.id,
      name: 'Hidden wf',
      definition: LEGACY_LINEAR_AUTOCODE_DEFINITION,
    });
    const openWf = repo.create({
      folderId: open.id,
      name: 'Open wf',
      definition: LEGACY_LINEAR_AUTOCODE_DEFINITION,
    });
    ctx.tc.folders.setMcpPermissions(hidden.id, {
      visible: false,
      create: true,
      update: true,
      delete: true,
    });
    ctx.tc.audit.recordWorkflow({
      workflowId: hiddenWf.id,
      action: 'workflow_create',
      actor: 'mcp:test-client',
    });
    ctx.tc.audit.recordWorkflow({
      workflowId: openWf.id,
      action: 'workflow_create',
      actor: 'mcp:test-client',
    });

    const rows = (await auditRecentTool.handler({}, ctx.tc)) as AuditRecentEntry[];
    const ids = rows.map((r) => r.noteId);
    expect(ids).not.toContain(hiddenWf.id);
    expect(ids).toContain(openWf.id);

    // The user actor sees both — the gate is MCP-only by design.
    const userRows = (await auditRecentTool.handler(
      {},
      { ...ctx.tc, actor: 'user' },
    )) as AuditRecentEntry[];
    const userIds = userRows.map((r) => r.noteId);
    expect(userIds).toContain(hiddenWf.id);
    expect(userIds).toContain(openWf.id);
  });

  it('all three workflow actions round-trip through audit_recent', async () => {
    for (const action of [
      'workflow_create',
      'workflow_update',
      'workflow_delete',
    ] as const) {
      ctx.tc.audit.recordWorkflow({
        workflowId: `wf-${action}`,
        action,
        actor: 'mcp:test-client',
      });
    }
    const rows = (await auditRecentTool.handler({}, ctx.tc)) as AuditRecentEntry[];
    for (const action of ['workflow_create', 'workflow_update', 'workflow_delete']) {
      expect(rows.some((r) => r.action === action && r.noteId === `wf-${action}`)).toBe(true);
    }
  });
});
