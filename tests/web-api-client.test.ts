/**
 * Contract tests for src/web/src/lib/api.ts (the frontend HTTP client).
 *
 * Scope: pin the behavior of the shared request helper + a representative
 * sample of non-trivial methods (query-string assembly, FormData uploads,
 * blob fetch, transcript stream URL). Pure GET/POST wrappers that just
 * forward path + JSON body to the request helper are covered transitively
 * via the request helper tests — adding a fetch-mock test per method
 * would be busywork.
 *
 * Added before splitting api.ts into domain modules so the refactor has
 * a behavior pin.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '../src/web/src/lib/api';

type FetchCall = { url: string; init: RequestInit | undefined };

const lastCall = (mock: ReturnType<typeof vi.fn>): FetchCall => {
  const call = mock.mock.calls[mock.mock.calls.length - 1] as [string, RequestInit | undefined];
  return { url: call[0], init: call[1] };
};

const jsonResponse = (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response => {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
};

const originalFetch = globalThis.fetch;

describe('web api client — request helper + headers', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends application/json content-type for non-FormData bodies', async () => {
    await api.createNote({ body: 'hello' });
    const { init } = lastCall(fetchMock);
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ body: 'hello' }));
  });

  it('omits Content-Type for FormData bodies (browser sets multipart boundary)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 'att_1',
        url: '/api/attachments/att_1',
        mimeType: 'image/png',
        sizeBytes: 1,
        width: null,
        height: null,
      }),
    );
    const file = new File([new Blob(['x'])], 'x.png', { type: 'image/png' });
    await api.uploadAttachment(file, 'note_1');
    const { init, url } = lastCall(fetchMock);
    const headers = init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined();
    expect(init?.body).toBeInstanceOf(FormData);
    expect(url).toBe('/api/attachments?noteId=note_1');
  });

  it('throws with status code and parsed message on non-2xx responses', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'validation_failed', message: 'tags: required' }), {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(api.createNote({ body: 'x' })).rejects.toThrow(/422.*tags: required/);
  });

  it('throws with raw status on non-JSON error body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await expect(api.getNote('n_1')).rejects.toThrow(/500/);
  });
});

describe('web api client — URL + query-string assembly', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('listNotes builds query string + reads X-Total-Count', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Total-Count': '42' },
      }),
    );
    const result = await api.listNotes({ folderId: 'f1', tag: 't1', limit: 10, offset: 20, includeArchived: true });
    const { url } = lastCall(fetchMock);
    expect(url).toContain('/api/notes?');
    expect(url).toContain('folderId=f1');
    expect(url).toContain('tag=t1');
    expect(url).toContain('limit=10');
    expect(url).toContain('offset=20');
    expect(url).toContain('includeArchived=1');
    expect(result.total).toBe(42);
  });

  it('listNotes falls back to notes.length when X-Total-Count is missing', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ id: 'n1' }, { id: 'n2' }]));
    const result = await api.listNotes();
    expect(result.total).toBe(2);
    const { url } = lastCall(fetchMock);
    expect(url).toBe('/api/notes');
  });

  it('getAllNotesCount returns the X-Total-Count header value', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('[]', {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Total-Count': '777' },
      }),
    );
    const n = await api.getAllNotesCount();
    expect(n).toBe(777);
  });

  it('listFolders toggles includeArchived query', async () => {
    fetchMock.mockImplementation(async () => jsonResponse([]));
    await api.listFolders();
    expect(lastCall(fetchMock).url).toBe('/api/folders');
    await api.listFolders({ includeArchived: true });
    expect(lastCall(fetchMock).url).toBe('/api/folders?includeArchived=1');
  });

  it('deleteFolder appends purgeNotes flag when requested', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ ok: true, deletedNoteCount: 0 }));
    await api.deleteFolder('f1');
    expect(lastCall(fetchMock).url).toBe('/api/folders/f1');
    await api.deleteFolder('f1', { purgeNotes: true });
    expect(lastCall(fetchMock).url).toBe('/api/folders/f1?purgeNotes=true');
  });

  it('search encodes the query parameter', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await api.search('hello world & more');
    expect(lastCall(fetchMock).url).toBe('/api/search?q=hello%20world%20%26%20more');
  });

  it('getMcpAudit accepts a custom limit', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    await api.getMcpAudit(123);
    expect(lastCall(fetchMock).url).toBe('/api/audit/mcp?limit=123');
  });

  it('fetchAttachment returns a Blob (raw response, not JSON)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('binarydata', { status: 200, headers: { 'Content-Type': 'image/png' } }),
    );
    const blob = await api.fetchAttachment('att_1');
    expect(blob).toBeInstanceOf(Blob);
    expect(lastCall(fetchMock).url).toBe('/api/attachments/att_1');
  });

  it('autoCodeTranscriptStreamUrl encodes fix/review session as a query', () => {
    const url = api.autoCodeTranscriptStreamUrl('row 1', 'review');
    expect(url).toBe('/api/auto-code/queue/row%201/transcript/stream?session=review');
  });

  it('autoCodeTranscriptStreamUrl encodes stage selectors', () => {
    const url = api.autoCodeTranscriptStreamUrl('row1', { stageId: 'stage/a', stageRowId: 's:row 2' });
    expect(url).toContain('/api/auto-code/queue/row1/transcript/stream?');
    expect(url).toContain('stageId=stage%2Fa');
    expect(url).toContain('stageRowId=s%3Arow%202');
  });
});
