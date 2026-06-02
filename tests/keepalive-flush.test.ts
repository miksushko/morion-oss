import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { flushPendingPatchKeepalive } from '../src/web/src/lib/keepaliveFlush';
import * as envModule from '../src/web/src/lib/env';

/**
 * The keepalive flush is the last-gasp save that runs from `pagehide` /
 * `visibilitychange→hidden` listeners when the tab is being torn down.
 * The whole point of `fetch(..., { keepalive: true })` is that the
 * browser keeps the request alive after the document is gone, so the
 * one thing we have to prove is: we actually pass that flag, with the
 * patch in the body, hitting the right URL.
 */
describe('flushPendingPatchKeepalive', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    // jsdom/happy-dom both expose `fetch` on globalThis; either way we
    // overwrite it for the duration of the test.
    (globalThis as unknown as { fetch: typeof fetch }).fetch =
      fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('issues a PATCH /api/notes/:id with keepalive=true and the patch body', () => {
    flushPendingPatchKeepalive('note-1', { body: 'World' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('/api/notes/note-1');
    expect(init.method).toBe('PATCH');
    expect(init.keepalive).toBe(true);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ body: 'World' });
  });

  it('serializes folder + tag patches end-to-end', () => {
    flushPendingPatchKeepalive('note-2', {
      folderId: 'folder-x',
      tags: ['work', 'urgent'],
    });

    const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      folderId: 'folder-x',
      tags: ['work', 'urgent'],
    });
  });

  it('swallows synchronous fetch throws so the unload listener never re-throws', () => {
    fetchMock.mockImplementation(() => {
      throw new Error('synthetic keepalive cap');
    });
    // Silence the console.error noise from the helper while we test it.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => flushPendingPatchKeepalive('note-3', { body: 'x' })).not.toThrow();
    expect(errSpy).toHaveBeenCalled();
  });

  it('attaches X-Morion-Token when a token is resolved (prod Tauri)', () => {
    // Simulate Tauri shell having propagated a token into the env module.
    const spy = vi
      .spyOn(envModule, 'getApiToken')
      .mockReturnValue('deadbeef-cafebabe');
    try {
      flushPendingPatchKeepalive('note-4', { body: 'secret edit' });
      const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['X-Morion-Token']).toBe('deadbeef-cafebabe');
      expect(headers['Content-Type']).toBe('application/json');
    } finally {
      spy.mockRestore();
    }
  });

  it('omits X-Morion-Token in dev mode (empty token)', () => {
    const spy = vi.spyOn(envModule, 'getApiToken').mockReturnValue('');
    try {
      flushPendingPatchKeepalive('note-5', { body: 'dev edit' });
      const [, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect('X-Morion-Token' in headers).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
