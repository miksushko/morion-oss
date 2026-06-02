import { describe, it, expect } from 'vitest';
import { buildTier1Messages } from '../../src/core/concierge/index.js';

describe('buildTier1Messages', () => {
  it('puts known cluster ids verbatim into the system prompt', () => {
    const msgs = buildTier1Messages('body', ['kanban-ui', 'mo-chat-loop']);
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[0]!.content).toContain('"kanban-ui"');
    expect(msgs[0]!.content).toContain('"mo-chat-loop"');
  });

  it('falls back to "no clusters yet" copy when known list is empty', () => {
    const msgs = buildTier1Messages('body', []);
    expect(msgs[0]!.content).toContain('No clusters exist in this folder yet');
  });

  it('places the body inside the user turn', () => {
    const msgs = buildTier1Messages('SAMPLE BODY 12345', []);
    expect(msgs[1]!.role).toBe('user');
    expect(msgs[1]!.content).toContain('SAMPLE BODY 12345');
  });

  it('always describes WHAT a topic is and WHAT IT IS NOT in the system prompt', () => {
    // The principle blocks must be present regardless of whether the
    // folder has known clusters or per-folder exclusions. Future drift
    // would silently lose them — pin the load-bearing phrasing.
    const msgs = buildTier1Messages('body', []);
    const sys = msgs[0]!.content as string;
    expect(sys).toContain('WHAT A TOPIC IS');
    expect(sys).toContain('WHAT A TOPIC IS NOT');
    expect(sys).toMatch(/research|todo|doing|review|done/);
    expect(sys).toMatch(/development|production|mobile/);
    expect(sys).toMatch(/windows|linux|macos|ios|android/i);
    expect(sys).toMatch(/backend|frontend|ui|ux|api/);
    expect(sys).toMatch(/bug|feature|enhancement/);
  });

  it('inlines the per-folder exclusions verbatim when supplied', () => {
    const msgs = buildTier1Messages(
      'body',
      ['kanban-ui'],
      'task management, project management, agile, workflow management',
    );
    const sys = msgs[0]!.content as string;
    expect(sys).toContain('ADDITIONAL per-folder generic terms');
    expect(sys).toContain('task management');
    expect(sys).toContain('agile');
    expect(sys).toContain('workflow management');
  });

  it('omits the per-folder exclusions block entirely when empty / whitespace', () => {
    const msgsEmpty = buildTier1Messages('body', ['kanban-ui'], '');
    const msgsBlank = buildTier1Messages('body', ['kanban-ui'], '   \n  ');
    const sysEmpty = msgsEmpty[0]!.content as string;
    const sysBlank = msgsBlank[0]!.content as string;
    expect(sysEmpty).not.toContain('ADDITIONAL per-folder generic terms');
    expect(sysBlank).not.toContain('ADDITIONAL per-folder generic terms');
  });
});
