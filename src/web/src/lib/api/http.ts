import { getApiBaseSync, getApiToken } from '../env';

/**
 * Shared low-level HTTP helpers used by every domain client module.
 *
 * - `fetchOrThrow` is the raw fetch (returns `Response` so callers that need
 *   headers — pagination, `X-Total-Count`, blob payloads — can read them).
 * - `request<T>` wraps `fetchOrThrow` with `.json()` for the common case.
 *
 * Auth: the X-Morion-Token header is injected from env.getApiToken(). In
 * dev / browser mode the token is empty and the sidecar's auth middleware
 * accepts unauthenticated requests.
 *
 * Content-Type: defaults to application/json unless the body is FormData,
 * in which case the browser sets the multipart boundary itself (overriding
 * would break the multipart parser server-side). Direction P's
 * `uploadAttachment` relies on this.
 *
 * Error envelope: non-2xx responses throw with a message that includes the
 * HTTP method, path, status, and (when present) the parsed `message` or
 * `error` field from the JSON body. PUT /api/auto-code/workflows/:id
 * returns 422 with `{ error, message: "<path>: <reason>", issues: [...] }`
 * on schema-validation failures; surface `message` (humane) before falling
 * back to `error` (machine code).
 */

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetchOrThrow(path, init);
  return (await res.json()) as T;
}

export async function fetchOrThrow(path: string, init?: RequestInit): Promise<Response> {
  const token = getApiToken();
  const authHeaders = token ? { 'X-Morion-Token': token } : {};
  const isFormData =
    typeof FormData !== 'undefined' && init?.body instanceof FormData;
  const defaultHeaders: Record<string, string> = isFormData
    ? {}
    : { 'Content-Type': 'application/json' };
  const res = await fetch(getApiBaseSync() + path, {
    ...init,
    headers: {
      ...defaultHeaders,
      ...authHeaders,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let detail = '';
    let envelope: { error?: string; message?: string; issues?: unknown } | null = null;
    try {
      envelope = (await res.clone().json()) as {
        error?: string;
        message?: string;
        issues?: unknown;
      };
      if (envelope?.message) detail = `: ${envelope.message}`;
      else if (envelope?.error) detail = `: ${envelope.error}`;
    } catch {
      // non-JSON body, ignore
    }
    throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${res.status}${detail}`);
  }
  return res;
}
