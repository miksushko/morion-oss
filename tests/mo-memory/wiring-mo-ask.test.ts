import { describe, it, expect } from 'vitest';
import { moAskTool } from '../../src/server/tools/index.js';
import { activatePro, setup } from '../helpers/mo-memory-setup.js';

describe('memory wiring into mo_ask', () => {
  // Phase 10 (ticket `01KQFQ1RJV7EH0X3WF2H1A476J`): mo_ask now
  // delegates to gatherContext. Mo memory is propagated into the
  // gather-synthesizer's USER scope (not its system prompt) so we
  // grep for it on the user message.
  it('gather synthesizer prompt includes Mo memory block when present', async () => {
    const ctx = setup();
    activatePro(ctx.tc);
    ctx.memory.write('## Preferences\n- always cite ULIDs inline\n- prefer terse answers');
    const folder = ctx.tc.folders.create('F');
    ctx.tc.concierge!.folderSettings.update(folder.id, { enabled: true });
    ctx.tc.notes.create(
      { body: '# X\n\nbody about X', folderId: folder.id, source: 'user', pinned: true },
      'user',
    );
    let synthesizerUserScope = '';
    ctx.provider.responseFor = (req) => {
      const sys = req.messages[0]!.content;
      if (sys.includes('gather-synthesizer')) {
        synthesizerUserScope = req.messages[1]!.content;
        return {
          content: JSON.stringify({
            packetMarkdown: 'ok',
            citedNoteIds: [],
            risks: [],
          }),
          costUsd: 0.001,
        };
      }
      // All other roles return canonical empty/no-op shapes.
      if (sys.includes('keyword-generator')) {
        return { content: '{"keywords":["X"]}', costUsd: 0.001 };
      }
      if (sys.includes('body-extractor')) {
        return {
          content:
            '{"chunks":["body about X"],"why":"mentions X","isWarning":false}',
          costUsd: 0.001,
        };
      }
      return { content: '{}', costUsd: 0.001 };
    };
    await moAskTool.handler({ question: 'tell me about X', folderId: folder.id }, ctx.tc);
    expect(synthesizerUserScope).toContain('Mo memory (workspace-wide');
    expect(synthesizerUserScope).toContain('always cite ULIDs');
  });

  it('gather synthesizer prompt OMITS Mo memory block when memory empty', async () => {
    const ctx = setup();
    activatePro(ctx.tc);
    const folder = ctx.tc.folders.create('F');
    ctx.tc.concierge!.folderSettings.update(folder.id, { enabled: true });
    ctx.tc.notes.create(
      { body: '# X\n\nbody', folderId: folder.id, source: 'user', pinned: true },
      'user',
    );
    let synthesizerUserScope = '';
    ctx.provider.responseFor = (req) => {
      const sys = req.messages[0]!.content;
      if (sys.includes('gather-synthesizer')) {
        synthesizerUserScope = req.messages[1]!.content;
        return {
          content: JSON.stringify({
            packetMarkdown: 's',
            citedNoteIds: [],
            risks: [],
          }),
          costUsd: 0.001,
        };
      }
      if (sys.includes('keyword-generator')) {
        return { content: '{"keywords":["X"]}', costUsd: 0.001 };
      }
      if (sys.includes('body-extractor')) {
        return {
          content: '{"chunks":["body"],"why":"x","isWarning":false}',
          costUsd: 0.001,
        };
      }
      return { content: '{}', costUsd: 0.001 };
    };
    await moAskTool.handler({ question: 'tell me about X', folderId: folder.id }, ctx.tc);
    expect(synthesizerUserScope).not.toContain('Mo memory (workspace-wide');
  });
});
