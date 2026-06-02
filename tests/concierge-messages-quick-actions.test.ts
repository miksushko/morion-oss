import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DbHandle } from '../src/core/db/client.js';
import {
  ConciergeSessionsRepository,
  ConciergeMessagesRepository,
} from '../src/core/concierge/index.js';
import type { ConciergeQuickAction } from '../src/core/concierge/index.js';

/**
 * Mo Chat — quick-action button schema round-trip.
 *
 * Pins migration 0025 + repo extension:
 *   - assistant message persists `quick_actions` JSON + reads back as
 *     a typed array; corrupt JSON returns null without throwing.
 *   - user message can carry `replied_action_id`; default is null.
 *   - listRepliedActionIds returns the distinct set per session for
 *     the UI's button-collapse logic.
 */

interface Ctx {
  handle: DbHandle;
  sessions: ConciergeSessionsRepository;
  messages: ConciergeMessagesRepository;
}

function setup(): Ctx {
  const handle = openDb({ path: ':memory:' });
  return {
    handle,
    sessions: new ConciergeSessionsRepository(handle.db),
    messages: new ConciergeMessagesRepository(handle.db),
  };
}

const sampleActions: ConciergeQuickAction[] = [
  { id: '1:merge', label: '1. Merge', kind: 'primary', payload: { kind: 'cleanup-merge', folderId: 'F', source: 'a', target: 'b' } },
  { id: '1:keep', label: '1. Keep', kind: 'secondary', payload: { kind: 'cleanup-keep', folderId: 'F', source: 'a', target: 'b' } },
  { id: '2:demote', label: '2. Demote', kind: 'primary', payload: { kind: 'cleanup-demote', folderId: 'F', source: 'ui', suggestedTag: 'ui' } },
];

describe('concierge_messages quick_actions', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });

  it('round-trips quickActions on assistant message', () => {
    const session = ctx.sessions.create({ openedBy: 'concierge' });
    const msg = ctx.messages.create({
      sessionId: session.id,
      role: 'assistant',
      content: 'Pick something',
      quickActions: sampleActions,
    });
    expect(msg.quickActions).toEqual(sampleActions);
    expect(msg.repliedActionId).toBeNull();

    // Re-read via getById.
    const fetched = ctx.messages.getById(msg.id);
    expect(fetched?.quickActions).toEqual(sampleActions);
  });

  it('default null on legacy create call (no quickActions field)', () => {
    const session = ctx.sessions.create({ openedBy: 'user' });
    const msg = ctx.messages.create({
      sessionId: session.id,
      role: 'assistant',
      content: 'normal message',
    });
    expect(msg.quickActions).toBeNull();
    expect(msg.repliedActionId).toBeNull();
  });

  it('user message persists repliedActionId; listRepliedActionIds finds it', () => {
    const session = ctx.sessions.create({ openedBy: 'concierge' });
    ctx.messages.create({
      sessionId: session.id,
      role: 'assistant',
      content: 'Pick',
      quickActions: sampleActions,
    });

    expect(ctx.messages.listRepliedActionIds(session.id)).toEqual([]);

    ctx.messages.create({
      sessionId: session.id,
      role: 'user',
      content: '1. Merge',
      repliedActionId: '1:merge',
    });

    const replied = ctx.messages.listRepliedActionIds(session.id);
    expect(replied).toEqual(['1:merge']);

    // A second action click in the same session adds another.
    ctx.messages.create({
      sessionId: session.id,
      role: 'user',
      content: '2. Demote',
      repliedActionId: '2:demote',
    });
    expect(ctx.messages.listRepliedActionIds(session.id).sort()).toEqual([
      '1:merge',
      '2:demote',
    ]);
  });

  it('corrupt quick_actions JSON in DB does not throw on read', () => {
    const session = ctx.sessions.create({ openedBy: 'concierge' });
    const msg = ctx.messages.create({
      sessionId: session.id,
      role: 'assistant',
      content: 'x',
      quickActions: sampleActions,
    });
    // Stomp the row with garbage to simulate a corrupt write.
    ctx.handle.db
      .prepare('UPDATE concierge_messages SET quick_actions = ? WHERE id = ?')
      .run('not json {{', msg.id);

    const fetched = ctx.messages.getById(msg.id);
    expect(fetched?.quickActions).toBeNull();
  });

  it('listRepliedActionIds returns sibling ids that share a group prefix — pins the contract the route uses for group-level dedup (Codex finding 2026-05-03)', () => {
    // The /quick-action route extracts group key as the first two
    // colon-separated segments (`bundle:0:use-a` -> `bundle:0`) and
    // refuses any incoming click whose group already has a sibling
    // applied. This test pins that the underlying repo surface is
    // sufficient — listRepliedActionIds returns the raw sibling id
    // and the route reads its prefix.
    const session = ctx.sessions.create({ openedBy: 'concierge' });
    ctx.messages.create({
      sessionId: session.id,
      role: 'user',
      content: 'Use A as main',
      repliedActionId: 'bundle:0:use-a',
    });
    const replied = ctx.messages.listRepliedActionIds(session.id);
    expect(replied).toEqual(['bundle:0:use-a']);

    const groupKey = (id: string): string => {
      const parts = id.split(':');
      return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : id;
    };
    // Sibling actions of the same group ALL produce the same group
    // key — the route blocks any of them post-pick.
    expect(groupKey('bundle:0:use-a')).toBe('bundle:0');
    expect(groupKey('bundle:0:keep-all')).toBe('bundle:0');
    expect(groupKey('bundle:0:custom')).toBe('bundle:0');
    // Different groups stay independent.
    expect(groupKey('bundle:1:use-x')).toBe('bundle:1');
    expect(groupKey('demote:0:apply')).toBe('demote:0');

    // The route's contract: any replied id whose group key matches
    // the incoming action's group key blocks the new click.
    const wouldConflict = (incomingId: string): boolean => {
      const incomingGroup = groupKey(incomingId);
      return replied.some((rid) => groupKey(rid) === incomingGroup);
    };
    expect(wouldConflict('bundle:0:keep-all')).toBe(true);
    expect(wouldConflict('bundle:0:custom')).toBe(true);
    expect(wouldConflict('bundle:0:use-a')).toBe(true); // exact same
    expect(wouldConflict('bundle:1:use-x')).toBe(false);
    expect(wouldConflict('demote:0:apply')).toBe(false);
  });

  it('listRepliedActionIds is per-session (no cross-session leak)', () => {
    const a = ctx.sessions.create({ openedBy: 'user' });
    const b = ctx.sessions.create({ openedBy: 'user' });
    ctx.messages.create({
      sessionId: a.id,
      role: 'user',
      content: 'x',
      repliedActionId: 'a:click',
    });
    ctx.messages.create({
      sessionId: b.id,
      role: 'user',
      content: 'y',
      repliedActionId: 'b:click',
    });
    expect(ctx.messages.listRepliedActionIds(a.id)).toEqual(['a:click']);
    expect(ctx.messages.listRepliedActionIds(b.id)).toEqual(['b:click']);
  });
});
