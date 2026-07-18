import { beforeEach, describe, expect, it } from 'vitest';
import { workflowsListTool } from '../src/server/tools/plugins/auto-code.js';
import { activateProForMcp, type Ctx, setup } from './mcp-tools/helpers.js';
import { WorkflowsRepository } from '../src/core/auto-code/workflows/workflows-repository.js';
import { LEGACY_LINEAR_AUTOCODE_DEFINITION } from '../src/core/auto-code/workflows/default-autocode.js';
import { writeFolderWorkflowTemplate } from '../src/server/features/auto-code-template-settings.js';

/**
 * `workflows_list` MCP tool — ticket 01KRWQPDKQ2RZMDBJZ5KN0B7YE.
 *
 * Surfaces every workflow available for a folder (built-in templates
 * + custom rows) so an agent can pick the right one before assigning
 * it per-ticket via `notes_update({workflowId})`. Read-only.
 */

describe('MCP tools — workflows_list', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('returns mcp_access_denied for an unknown folder (visibility gate fires first)', async () => {
    activateProForMcp(ctx.tc);
    const res = (await workflowsListTool.handler(
      { folderId: 'no-such-folder' },
      ctx.tc,
    )) as { error: string };
    // canPerform fires before the existence check (matches the
    // tasks_list pattern) — an unknown folder is indistinguishable
    // from one the caller can't see, so MCP returns the same
    // envelope either way.
    expect(res.error).toBe('mcp_access_denied');
  });

  it('lists built-in templates + custom rows with isFolderDefault flag', async () => {
    activateProForMcp(ctx.tc);
    const folder = ctx.tc.folders.create('F');
    const wfRepo = new WorkflowsRepository(ctx.handle.db);
    const custom = wfRepo.create({
      folderId: folder.id,
      name: 'My custom',
      definition: LEGACY_LINEAR_AUTOCODE_DEFINITION,
    });
    writeFolderWorkflowTemplate(ctx.tc.settings, ctx.handle.db, folder.id, custom.id);

    const res = (await workflowsListTool.handler(
      { folderId: folder.id },
      ctx.tc,
    )) as {
      folderDefaultWorkflowId: string;
      workflows: Array<{
        id: string;
        kind: 'template' | 'custom';
        name: string;
        isFolderDefault: boolean;
      }>;
    };

    expect(res.folderDefaultWorkflowId).toBe(custom.id);
    const customRow = res.workflows.find((w) => w.id === custom.id);
    expect(customRow).toBeTruthy();
    expect(customRow?.kind).toBe('custom');
    expect(customRow?.isFolderDefault).toBe(true);

    // At least one built-in template surfaces too (default-v2).
    const defaultTemplate = res.workflows.find((w) => w.id === 'default-v2');
    expect(defaultTemplate).toBeTruthy();
    expect(defaultTemplate?.kind).toBe('template');
    expect(defaultTemplate?.isFolderDefault).toBe(false);
  });

  it('returns the full WorkflowDefinition for every entry', async () => {
    activateProForMcp(ctx.tc);
    const folder = ctx.tc.folders.create('F');
    const wfRepo = new WorkflowsRepository(ctx.handle.db);
    wfRepo.create({
      folderId: folder.id,
      name: 'Custom',
      definition: LEGACY_LINEAR_AUTOCODE_DEFINITION,
    });

    const res = (await workflowsListTool.handler(
      { folderId: folder.id },
      ctx.tc,
    )) as {
      workflows: Array<{ id: string; definition: { stages: unknown[] } }>;
    };

    for (const w of res.workflows) {
      // Every entry MUST carry stages so the agent can inspect the
      // workflow before pinning it. The Zod shape is enforced at
      // load + write time — here we just check the field exists.
      expect(w.definition).toBeTruthy();
      expect(Array.isArray((w.definition as { stages?: unknown[] }).stages)).toBe(true);
    }
  });
});
