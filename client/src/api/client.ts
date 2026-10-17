/**
 * Thin API client.
 *
 * The base URL is relative (`/api`) by default so the Vite dev proxy handles
 * transport and the production bundle works behind a same-origin reverse proxy.
 * Set VITE_API_URL at build time to target an absolute URL instead.
 *
 * Every failure is normalised into `ApiError` so the UI can render a consistent
 * message and preserve the server's `code` for special-casing.
 */
import type {
  Chunk,
  Citation,
  DocumentStatus,
  HealthInfo,
  IngestionResult,
  QueriesResponse,
  QueryRecord,
  QueryStatus,
  ReadinessInfo,
  SourceDocument,
  User,
  WorkspaceStats,
} from './types';

const BASE_URL = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, '') ?? '';
const TOKEN_KEY = 'sourceiq.token';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Field-level validation messages, when the server returned them. */
  get fieldErrors(): Record<string, string> {
    const issues = (this.details as { issues?: Array<{ path: string; message: string }> } | undefined)?.issues;
    if (!issues?.length) return {};
    return Object.fromEntries(issues.map((i) => [i.path, i.message]));
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private browsing */
  }
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  auth?: boolean;
  /** Set for streaming endpoints so the caller receives the raw Response. */
  raw?: boolean;
  signal?: AbortSignal;
}

let onUnauthorized: (() => void) | null = null;

/** Registered by AuthProvider so a 401 anywhere clears the session once. */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, auth = true, raw, headers, signal, ...rest } = options;

  const finalHeaders = new Headers(headers);
  if (body !== undefined && !(body instanceof FormData)) {
    finalHeaders.set('Content-Type', 'application/json');
  }
  const token = getToken();
  if (auth && token) finalHeaders.set('Authorization', `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...rest,
      headers: finalHeaders,
      signal: signal ?? null,
      body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the SourceIQ API. Is the server running?');
  }

  if (raw) return response as unknown as T;

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: { code: 'BAD_RESPONSE', message: text.slice(0, 300) } };
    }
  }

  if (!response.ok) {
    const err = (payload as { error?: { code?: string; message?: string; details?: unknown } })?.error;
    const apiError = new ApiError(
      response.status,
      err?.code ?? 'HTTP_ERROR',
      err?.message ?? `Request failed with status ${response.status}.`,
      err?.details,
    );
    if (response.status === 401 && auth) onUnauthorized?.();
    throw apiError;
  }

  return payload as T;
}

export const api = {
  // ---- health ----
  health: () => request<HealthInfo>('/api/health', { auth: false }),
  readiness: () => request<ReadinessInfo>('/api/health/ready', { auth: false }),

  // ---- auth ----
  // Sign-in is admin-only; there is no registration endpoint by design.
  login: (body: { email: string; password: string }) =>
    request<{ token: string; user: User }>('/api/auth/login', { method: 'POST', body, auth: false }),
  me: () => request<{ user: User }>('/api/auth/me'),

  // ---- documents ----
  listDocuments: (params: { search?: string; status?: DocumentStatus } = {}) => {
    const qs = new URLSearchParams();
    if (params.search) qs.set('search', params.search);
    if (params.status) qs.set('status', params.status);
    const suffix = qs.toString() ? `?${qs}` : '';
    return request<{ documents: SourceDocument[] }>(`/api/documents${suffix}`);
  },
  getDocument: (id: string) =>
    request<{ document: SourceDocument; chunks: Chunk[] }>(`/api/documents/${id}`),
  uploadDocument: (file: File, onProgress?: (fraction: number) => void, signal?: AbortSignal) =>
    uploadWithProgress(file, onProgress, signal),
  renameDocument: (id: string, title: string) =>
    request<{ document: SourceDocument }>(`/api/documents/${id}`, { method: 'PATCH', body: { title } }),
  deleteDocument: (id: string) => request<void>(`/api/documents/${id}`, { method: 'DELETE' }),
  listChunks: (id: string, params: { limit?: number; skip?: number } = {}) => {
    const qs = new URLSearchParams({ limit: String(params.limit ?? 100), skip: String(params.skip ?? 0) });
    return request<{ document: SourceDocument; chunks: Chunk[]; pagination: { total: number } }>(
      `/api/documents/${id}/chunks?${qs}`,
    );
  },
  reindexDocument: (id: string) =>
    request<{ document: SourceDocument; updated: number }>(`/api/documents/${id}/reindex`, { method: 'POST', body: {} }),

  // ---- chunks ----
  updateChunk: (id: string, text: string) =>
    request<{ chunk: Chunk }>(`/api/chunks/${id}`, { method: 'PATCH', body: { text } }),
  deleteChunk: (id: string) =>
    request<{ deleted: boolean; documentChunkCount: number }>(`/api/chunks/${id}`, { method: 'DELETE' }),

  // ---- queries (Queries Management, admin only) ----
  // Unanswered chat questions collected by the RAG pipeline. Editing a record
  // never touches the knowledge base; it only renames the stored query.
  listQueries: (params: { status?: QueryStatus } = {}) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set('status', params.status);
    const suffix = qs.toString() ? `?${qs}` : '';
    return request<QueriesResponse>(`/api/queries${suffix}`);
  },
  updateQuery: (id: string, question: string) =>
    request<{ query: QueryRecord }>(`/api/queries/${id}`, { method: 'PATCH', body: { question } }),
  deleteQuery: (id: string) => request<void>(`/api/queries/${id}`, { method: 'DELETE' }),

  // ---- chat ----
  // Chat is stateless: answers are produced from the documents and nothing is
  // stored, so there is no conversation to address, list or replay.
  ask: (body: { question: string; documentIds?: string[]; topK?: number; minScore?: number }) =>
    request<{
      answer: string;
      citations: Citation[];
      retrievedCount: number;
      usedProvider: string;
      usedModel: string;
    }>('/api/chat', { method: 'POST', body }),

  stats: () => request<WorkspaceStats>('/api/health/me/stats'),
};

/**
 * Upload with real progress events.
 * `fetch` cannot report upload progress, so this uses XMLHttpRequest, which can.
 */
function uploadWithProgress(
  file: File,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<{ document: SourceDocument; ingestion: IngestionResult }> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE_URL}/api/documents`);
    xhr.responseType = 'json';

    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };

    xhr.onload = () => {
      const payload = xhr.response as {
        document?: unknown;
        ingestion?: IngestionResult;
        error?: { code?: string; message?: string; details?: unknown };
      } | null;

      if (xhr.status === 201 || xhr.status === 422) {
        // 422 still returns the failed document + ingestion report.
        resolve(payload as { document: never; ingestion: IngestionResult });
        return;
      }
      const err = payload?.error;
      if (xhr.status === 401) onUnauthorized?.();
      reject(
        new ApiError(
          xhr.status,
          err?.code ?? 'UPLOAD_ERROR',
          err?.message ?? `Upload failed with status ${xhr.status}.`,
          err?.details,
        ),
      );
    };

    xhr.onerror = () =>
      reject(new ApiError(0, 'NETWORK_ERROR', 'Upload failed — the server could not be reached.'));
    xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'));

    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}

export interface StreamHandlers {
  onCitations?: (data: { citations: Citation[]; retrievedCount: number }) => void;
  onDelta?: (text: string) => void;
  onDone?: (data: { citations: Citation[]; answerLength: number }) => void;
  onError?: (data: { message: string; code: string }) => void;
}

/**
 * Consume the SSE answer stream. Uses fetch + ReadableStream (not
 * EventSource) so the request can carry an Authorization header.
 */
export async function streamChat(
  body: { question: string; documentIds?: string[]; topK?: number },
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const token = getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${BASE_URL}/api/chat/stream`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: signal ?? null,
  });

  if (!response.ok || !response.body) {
    const text = await response.text();
    let message = `Streaming failed with status ${response.status}.`;
    let code = 'STREAM_ERROR';
    try {
      const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
      message = parsed.error?.message ?? message;
      code = parsed.error?.code ?? code;
    } catch {
      /* keep default */
    }
    if (response.status === 401) onUnauthorized?.();
    handlers.onError?.({ message, code });
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line.
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      const eventLine = frame.split('\n').find((l) => l.startsWith('event:'));
      const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!eventLine || !dataLine) continue;
      const event = eventLine.slice(6).trim();
      let data: unknown;
      try {
        data = JSON.parse(dataLine.slice(5).trim());
      } catch {
        continue;
      }
      if (event === 'citations') handlers.onCitations?.(data as { citations: Citation[]; retrievedCount: number });
      else if (event === 'delta') handlers.onDelta?.((data as { text: string }).text);
      else if (event === 'done') handlers.onDone?.(data as { citations: Citation[]; answerLength: number });
      else if (event === 'error') handlers.onError?.(data as { message: string; code: string });
    }
  }
}