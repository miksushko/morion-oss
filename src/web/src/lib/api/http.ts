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

/** Validation issue shape returned by the workflow PUT/POST 422 path
 *  (`{ path, message }` per failed schema refinement). */
export interface ApiIssue {
  path?: string;
  message?: string;
}

/**
 * Error thrown by `fetchOrThrow` on a non-2xx response. Extends `Error`
 * so existing `(e as Error).message` call sites keep working, but also
 * carries the structured envelope — notably `issues[]` for 422
 * schema-validation failures — so a UI can render the full checklist
 * (e.g. "add a Process Start / reject sink / complete sink") instead of
 * only the first issue wrapped in HTTP boilerplate.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly issues?: ApiIssue[];
  constructor(
    message: string,
    status: number,
    opts?: { code?: string; issues?: ApiIssue[] },
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = opts?.code;
    this.issues = opts?.issues;
  }
}

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
    let envelope:
      | { error?: string; message?: string; issues?: ApiIssue[] }
      | null = null;
    try {
      envelope = (await res.clone().json()) as {
        error?: string;
        message?: string;
        issues?: ApiIssue[];
      };
      if (envelope?.message) detail = `: ${envelope.message}`;
      else if (envelope?.error) detail = `: ${envelope.error}`;
    } catch {
      // non-JSON body, ignore
    }
    const issues = Array.isArray(envelope?.issues) ? envelope!.issues : undefined;
    throw new ApiError(
      `${init?.method ?? 'GET'} ${path} failed: ${res.status}${detail}`,
      res.status,
      { code: envelope?.error, issues },
    );
  }
  return res;
}
