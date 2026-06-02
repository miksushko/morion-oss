import { describe, it, expect, beforeEach } from 'vitest';
import {
  activateProForMcp,
  setup,
  type Ctx,
} from './mcp-tools/helpers.js';
import { WorkflowsRepository } from '../src/core/auto-code/workflows/workflows-repository.js';
import { LEGACY_LINEAR_AUTOCODE_DEFINITION } from '../src/core/auto-code/workflows/default-autocode.js';
import {
  readFolderWorkflowTemplate,
  syncRowDefaultWithFolderSelection,
  writeFolderWorkflowTemplate,
} from '../src/server/features/auto-code-template-settings.js';

/**
 * `settings.workflowTemplate` (the "Default workflow" dropdown in
 * Folder Settings → Auto-code tab) MUST stay in sync with
 * `workflows.is_default` (the badge in the workflows list popup) —
 * the two surfaces used to drift, which left users staring at a
 * dropdown that disagreed with the badge. User feedback 2026-05-18
 * on follow-up to ticket 01KRWQPDKQ2RZMDBJZ5KN0B7YE.
 *
 * The HTTP routes wire `syncRowDefaultWithFolderSelection` after
 * every `writeFolderWorkflowTemplate` write, and mirror
 * `is_default=true` from the workflow create/update routes onto
 * `settings.workflowTemplate`. These tests pin the underlying
 * primitive in both directions.
 */

describe('folder default workflow sync', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
    activateProForMcp(ctx.tc);
  });

  it('selecting a custom workflow row marks that row is_default + clears siblings', () => {
    const folder = ctx.tc.folders.create('F');
    const repo = new WorkflowsRepository(ctx.handle.db);
    const a = repo.create({
      folderId: folder.id,
      name: 'A',
      definition: LEGACY_LINEAR_AUTOCODE_DEFINITION,
      isDefault: true,
    });
    const b = repo.create({
      folderId: folder.id,
      name: 'B',
      definition: { ...LEGACY_LINEAR_AUTOCODE_DEFINITION, name: 'B' },
    });
    expect(repo.getById(a.id)?.isDefault).toBe(true);
    expect(repo.getById(b.id)?.isDefault).toBe(false);

    // User picks B via the Default workflow dropdown.
    writeFolderWorkflowTemplate(ctx.tc.settings, ctx.handle.db, folder.id, b.id);
    syncRowDefaultWithFolderSelection(ctx.handle.db, folder.id, b.id);

    expect(repo.getById(a.id)?.isDefault).toBe(false);
    expect(repo.getById(b.id)?.isDefault).toBe(true);
    expect(readFolderWorkflowTemplate(ctx.tc.settings, folder.id)).toBe(b.id);
  });

  it('selecting a built-in template id clears is_default from every row in the folder', () => {
    const folder = ctx.tc.folders.create('F');
    const repo = new WorkflowsRepository(ctx.handle.db);
    const a = repo.create({
      folderId: folder.id,
      name: 'A',
      definition: LEGACY_LINEAR_AUTOCODE_DEFINITION,
      isDefault: true,
    });

    writeFolderWorkflowTemplate(
      ctx.tc.settings,
      ctx.handle.db,
      folder.id,
      'code-only-v2',
    );
    syncRowDefaultWithFolderSelection(
      ctx.handle.db,
      folder.id,
      'code-only-v2',
    );

    // Badge stripped from the previously-default row.
    expect(repo.getById(a.id)?.isDefault).toBe(false);
    // Setting persisted.
    expect(readFolderWorkflowTemplate(ctx.tc.settings, folder.id)).toBe(
      'code-only-v2',
    );
  });

  it('built-in pick does NOT touch rows in OTHER folders', () => {
    const f1 = ctx.tc.folders.create('F1');
    const f2 = ctx.tc.folders.create('F2');
    const repo = new WorkflowsRepository(ctx.handle.db);
    const f2Default = repo.create({
      folderId: f2.id,
      name: 'F2-default',
      definition: LEGACY_LINEAR_AUTOCODE_DEFINITION,
      isDefault: true,
    });

    syncRowDefaultWithFolderSelection(ctx.handle.db, f1.id, 'code-only-v2');

    // F2's badge untouched.
    expect(repo.getById(f2Default.id)?.isDefault).toBe(true);
  });

  it('passing an unresolvable selection is a no-op (defensive)', () => {
    const folder = ctx.tc.folders.create('F');
    const repo = new WorkflowsRepository(ctx.handle.db);
    const a = repo.create({
      folderId: folder.id,
      name: 'A',
      definition: LEGACY_LINEAR_AUTOCODE_DEFINITION,
      isDefault: true,
    });

    // Junk id — not a template, not a row.
    syncRowDefaultWithFolderSelection(ctx.handle.db, folder.id, 'junk-id');

    expect(repo.getById(a.id)?.isDefault).toBe(true);
  });
});
