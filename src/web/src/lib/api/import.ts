import { getApiBaseSync, getApiToken } from '../env';
import { fetchOrThrow } from './http';

/**
 * Markdown / Apple Notes import (Phase 1).
 *
 * The start endpoints do RAW fetch instead of fetchOrThrow so callers
 * can branch on `{ok:false, error, activeBatchId, message}` envelopes
 * without parsing `Error.message`. Returns the structured payload for
 * 202 (success) and 4xx (`409 import_running` etc.) alike.
 */
export const importApi = {
  /**
   * Start a markdown import via browser file picker. The user-selected
   * `File` objects are sent as multipart/form-data with each part
   * keyed `file:<relPath>` so the server can rebuild the directory
   * structure without a separate manifest. For single-file imports
   * `relPath` is just the filename; for folder imports it's the
   * `webkitRelativePath` set by `<input webkitdirectory>`.
   *
   * Returns 409 + envelope when another import is already running.
   */
  startImportUpload: async (input: {
    mode: 'file' | 'folder';
    files: File[];
  }): Promise<
    | { ok: true; batchId: string }
    | { ok: false; error: string; activeBatchId?: string; message?: string }
  > => {
    const fd = new FormData();
    fd.append('mode', input.mode);
    for (const file of input.files) {
      // For folder picker: file.webkitRelativePath is "MyVault/foo.md"
      // (forward-slash, top-level segment is the source folder name).
      // For single file picker: webkitRelativePath is empty; fall back
      // to file.name.
      const relPath = file.webkitRelativePath || file.name;
      fd.append(`file:${relPath}`, file);
    }
    const token = getApiToken();
    const headers: Record<string, string> = {};
    if (token) headers['X-Morion-Token'] = token;
    // Don't set Content-Type — browser sets multipart boundary itself.
    const res = await fetch(`${getApiBaseSync()}/api/import`, {
      method: 'POST',
      headers,
      body: fd,
    });
    if (res.status === 202) {
      const body = (await res.json()) as { batchId: string };
      return { ok: true, batchId: body.batchId };
    }
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      activeBatchId?: string;
      message?: string;
    };
    return {
      ok: false,
      error: body.error ?? `http_${res.status}`,
      activeBatchId: body.activeBatchId,
      message: body.message,
    };
  },

  /**
   * Legacy path-based import. Kept for the future Tauri native dialog
   * code path which returns absolute filesystem paths. Browsers can't
   * hit this from the file picker — see `startImportUpload`.
   */
  startImport: async (input: {
    path: string;
    mode: 'file' | 'folder';
  }): Promise<
    | { ok: true; batchId: string }
    | { ok: false; error: string; activeBatchId?: string; message?: string }
  > => {
    const token = getApiToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) headers['X-Morion-Token'] = token;
    const res = await fetch(`${getApiBaseSync()}/api/import`, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    });
    if (res.status === 202) {
      const body = (await res.json()) as { batchId: string };
      return { ok: true, batchId: body.batchId };
    }
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      activeBatchId?: string;
      message?: string;
    };
    return {
      ok: false,
      error: body.error ?? `http_${res.status}`,
      activeBatchId: body.activeBatchId,
      message: body.message,
    };
  },

  /**
   * Probe Apple Notes for the list of folders + per-folder note counts.
   * macOS-only; returns 400 with `platform_unsupported` elsewhere.
   * Returns 403 with `apple_notes_permission_denied` if the user
   * declined the macOS automation prompt.
   */
  listAppleNotesFolders: async (): Promise<
    | {
        ok: true;
        folders: Array<{
          accountName: string;
          folderName: string;
          folderPath: string;
          noteCount: number;
        }>;
      }
    | { ok: false; error: string; message?: string }
  > => {
    const token = getApiToken();
    const headers: Record<string, string> = {};
    if (token) headers['X-Morion-Token'] = token;
    const res = await fetch(`${getApiBaseSync()}/api/import/apple-notes/folders`, {
      headers,
    });
    if (res.ok) {
      const body = (await res.json()) as {
        folders: Array<{
          accountName: string;
          folderName: string;
          folderPath: string;
          noteCount: number;
        }>;
      };
      return { ok: true, folders: body.folders };
    }
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    return {
      ok: false,
      error: body.error ?? `http_${res.status}`,
      message: body.message,
    };
  },

  startAppleNotesImport: async (input: {
    folders: Array<{ accountName: string; folderPath: string }>;
  }): Promise<
    | { ok: true; batchId: string }
    | { ok: false; error: string; activeBatchId?: string; message?: string }
  > => {
    const token = getApiToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) headers['X-Morion-Token'] = token;
    const res = await fetch(`${getApiBaseSync()}/api/import/apple-notes`, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    });
    if (res.status === 202) {
      const body = (await res.json()) as { batchId: string };
      return { ok: true, batchId: body.batchId };
    }
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      activeBatchId?: string;
      message?: string;
    };
    return {
      ok: false,
      error: body.error ?? `http_${res.status}`,
      activeBatchId: body.activeBatchId,
      message: body.message,
    };
  },

  cancelImport: async (batchId: string): Promise<boolean> => {
    const token = getApiToken();
    const headers: Record<string, string> = {};
    if (token) headers['X-Morion-Token'] = token;
    const res = await fetch(
      `${getApiBaseSync()}/api/import/${encodeURIComponent(batchId)}/cancel`,
      { method: 'POST', headers },
    );
    return res.ok;
  },

  getActiveImport: async (): Promise<{
    busy: boolean;
    active: string | null;
  }> => {
    const res = await fetchOrThrow('/api/import/active');
    return (await res.json()) as { busy: boolean; active: string | null };
  },
};
