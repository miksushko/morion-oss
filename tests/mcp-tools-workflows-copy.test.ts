import { beforeEach, describe, expect, it } from 'vitest';
import { workflowsCopyTool } from '../src/server/tools/plugins/auto-code.js';
import { auditRecentTool } from '../src/server/tools/index.js';
import { type Ctx, setup } from './mcp-tools/helpers.js';
import {
  DEFAULT_TEMPLATE_ID,
  getWorkflowTemplate,
} from '../src/core/auto-code/workflows/templates.js';
import { LEGACY_LINEAR_AUTOCODE_DEFINITION } from '../src/core/auto-code/workflows/default-autocode.js';
import { WorkflowsRepository } from '../src/core/auto-code/workflows/workflows-repository.js';
import { readFolderWorkflowTemplate } from '../src/server/features/auto-code-template-settings.js';
import type { WorkflowRow } from '../src/core/auto-code/workflows/types/index.js';
import type { AuditRecentEntry } from '../src/core/audit/log.js';

/**
 * `workflows_copy` MCP tool — Mo Workflows epic.
 *
 * Template → folder copy plus the first CROSS-FOLDER workflow path
 * (HTTP clone is same-folder only). Read gate on the source folder,
 * create gate on the target.
 */

interface CopyResult {
  ok?: boolean;
  workflow?: WorkflowRow;
  error?: string;
  message?: string;
}

describe('MCP tools — workflows_copy', () => {
  let ctx: Ctx;
  let targetId: string;

  beforeEach(() => {
    ctx = setup();
    targetId = ctx.tc.folders.create('Target').id;
  });

  it('copies a built-in template into the folder as an editable row', async () => {
    const res = (await workflowsCopyTool.handler(
      { sourceWorkflowId: DEFAULT_TEMPLATE_ID, targetFolderId: targetId },
      ctx.tc,
    )) as CopyResult;

    expect(res.ok).toBe(true);
    const template = getWorkflowTemplate(DEFAULT_TEMPLATE_ID)!;
    expect(res.workflow?.name).toBe(template.label);
    expect(res.workflow?.folderId).toBe(targetId);
    expect(res.workflow?.id).not.toBe(DEFAULT_TEMPLATE_ID);
    expect(res.workflow?.definition.stages.length).toBe(
      template.definition.stages.length,
    );
    expect(res.workflow?.isDefault).toBe(false);

    // Audited as a create with the calling actor.
    const rows = (await auditRecentTool.handler({}, ctx.tc)) as AuditRecentEntry[];
    expect(
      rows.some(
        (r) => r.action === 'workflow_create' && r.noteId === res.workflow?.id,
      ),
    ).toBe(true);
  });

  it('copies a custom row across folders with a fresh ULID', async () => {
    const source = ctx.tc.folders.create('Source').id;
    const repo = new WorkflowsRepository(ctx.handle.db);
    const original = repo.create({
      folderId: source,
      name: 'Cross me',
      definition: LEGACY_LINEAR_AUTOCODE_DEFINITION,
    });

    const res = (await workflowsCopyTool.handler(
      { sourceWorkflowId: original.id, targetFolderId: targetId },
      ctx.tc,
    )) as CopyResult;

    expect(res.ok).toBe(true);
    expect(res.workflow?.folderId).toBe(targetId);
    expect(res.workflow?.id).not.toBe(original.id);
    expect(res.workflow?.name).toBe('Cross me');
    // Source row untouched.
    expect(repo.getByIdForFolder(original.id, source)).toBeTruthy();
  });

  it('de-collides the default name with " (copy)" suffixes', async () => {
    const repo = new WorkflowsRepository(ctx.handle.db);
    const original = repo.create({
      folderId: targetId,
      name: 'Same name',
      definition: LEGACY_LINEAR_AUTOCODE_DEFINITION,
    });

    const first = (await workflowsCopyTool.handler(
      { sourceWorkflowId: original.id, targetFolderId: targetId },
      ctx.tc,
    )) as CopyResult;
    expect(first.workflow?.name).toBe('Same name (copy)');

    const second = (await workflowsCopyTool.handler(
      { sourceWorkflowId: original.id, targetFolderId: targetId },
      ctx.tc,
    )) as CopyResult;
    expect(second.workflow?.name).toBe('Same name (copy 2)');
  });

  it('setAsFolderDefault pins the copy on the target folder', async () => {
    const res = (await workflowsCopyTool.handler(
      {
        sourceWorkflowId: DEFAULT_TEMPLATE_ID,
        targetFolderId: targetId,
        setAsFolderDefault: true,
      },
      ctx.tc,
    )) as CopyResult;
    expect(res.workflow?.isDefault).toBe(true);
    expect(readFolderWorkflowTemplate(ctx.tc.settings, targetId)).toBe(
      res.workflow?.id,
    );
  });

  it('hides sources in MCP-invisible folders behind workflow_not_found', async () => {
    const hidden = ctx.tc.folders.create('Hidden').id;
    const repo = new WorkflowsRepository(ctx.handle.db);
    const secret = repo.create({
      folderId: hidden,
      name: 'Secret',
      definition: LEGACY_LINEAR_AUTOCODE_DEFINITION,
    });
    ctx.tc.folders.setMcpPermissions(hidden, {
      visible: false,
      create: true,
      update: true,
      delete: true,
    });

    const res = (await workflowsCopyTool.handler(
      { sourceWorkflowId: secret.id, targetFolderId: targetId },
      ctx.tc,
    )) as CopyResult;
    // Same envelope as a truly missing id — hidden-folder existence
    // must not leak through the error shape.
    expect(res.error).toBe('workflow_not_found');

    // The user actor is not gated and can copy it.
    const asUser = (await workflowsCopyTool.handler(
      { sourceWorkflowId: secret.id, targetFolderId: targetId },
      { ...ctx.tc, actor: 'user' },
    )) as CopyResult;
    expect(asUser.ok).toBe(true);
  });

  it('gates on the target folder create permission', async () => {
    ctx.tc.folders.setMcpPermissions(targetId, {
      visible: true,
      create: false,
      update: true,
      delete: true,
    });
    const res = (await workflowsCopyTool.handler(
      { sourceWorkflowId: DEFAULT_TEMPLATE_ID, targetFolderId: targetId },
      ctx.tc,
    )) as CopyResult;
    expect(res.error).toBe('mcp_access_denied');
  });

  it('returns workflow_not_found for an unknown source id', async () => {
    const res = (await workflowsCopyTool.handler(
      { sourceWorkflowId: 'nope', targetFolderId: targetId },
      ctx.tc,
    )) as CopyResult;
    expect(res.error).toBe('workflow_not_found');
  });
});
