/**
 * Browser-side client for the same-origin BFF (`/api/*`). Every failure — error bodies,
 * network drops, expired sessions — surfaces as an `ApiClientError` with a user-safe message.
 */
import {
  defaultMessage,
  isErrorCode,
  type CreateJobRequest,
  type CreateJobResponse,
  type ErrorCode,
  type JobView,
  type PlatformsResponse,
  type ResolveResponse,
  type UploadTicketRequest,
  type UploadTicketResponse,
} from '@vd/shared';

export class ApiClientError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly guidance: string[];
  /** True when the failure never reached the API (offline, DNS, CORS, aborted by timeout…). */
  readonly network: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: { status?: number; retryable?: boolean; guidance?: string[]; network?: boolean } = {},
  ) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.status = options.status ?? 0;
    this.retryable = options.retryable ?? false;
    this.guidance = options.guidance ?? [];
    this.network = options.network ?? false;
  }
}

export function isApiClientError(value: unknown): value is ApiClientError {
  return value instanceof ApiClientError;
}

let unauthorizedHandler: () => void = () => {
  // Hard navigation on purpose: drops all client state and lets the server re-validate the session.
  if (typeof window !== 'undefined') window.location.replace('/login');
};

/** Lets tests (and the app shell) decide what "your session ended" does. */
export function setUnauthorizedHandler(handler: () => void): void {
  unauthorizedHandler = handler;
}

function codeForStatus(status: number): ErrorCode {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 410) return 'LINK_EXPIRED';
  if (status === 413) return 'FILE_TOO_LARGE';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 502) return 'PLATFORM_API_ERROR';
  if (status === 504) return 'NETWORK_TIMEOUT';
  if (status >= 400 && status < 500) return 'VALIDATION_ERROR';
  return 'INTERNAL';
}

async function toError(response: Response): Promise<ApiClientError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const raw = (body as { error?: Record<string, unknown> } | null)?.error;
  if (raw && isErrorCode(raw.code)) {
    const guidance = Array.isArray(raw.guidance) ? raw.guidance.filter((g): g is string => typeof g === 'string') : [];
    return new ApiClientError(raw.code, typeof raw.message === 'string' && raw.message ? raw.message : defaultMessage(raw.code), {
      status: response.status,
      retryable: typeof raw.retryable === 'boolean' ? raw.retryable : false,
      guidance,
    });
  }
  const code = codeForStatus(response.status);
  return new ApiClientError(code, defaultMessage(code), { status: response.status, retryable: response.status >= 500 });
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
  /** Login must show "wrong password" instead of bouncing to /login. */
  redirectOn401?: boolean;
}

async function request<T>(path: string, { method = 'GET', body, signal, redirectOn401 = true }: RequestOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiClientError('NETWORK_TIMEOUT', "Couldn't reach the server. Check your connection and try again.", {
      retryable: true,
      network: true,
    });
  }

  if (!response.ok) {
    const error = await toError(response);
    if (response.status === 401 && redirectOn401) unauthorizedHandler();
    throw error;
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiClientError('INTERNAL', defaultMessage('INTERNAL'), { status: response.status, retryable: true });
  }
}

export function resolveUrl(url: string, signal?: AbortSignal): Promise<ResolveResponse> {
  return request<ResolveResponse>('/api/resolve', { method: 'POST', body: { url }, signal });
}

export function createJob(body: CreateJobRequest, signal?: AbortSignal): Promise<CreateJobResponse> {
  return request<CreateJobResponse>('/api/jobs', { method: 'POST', body, signal });
}

/**
 * Standalone mode: one streaming request does the whole conversion. The server sends one JobView
 * per line (NDJSON) — queued, progress…, then completed or failed — and `onUpdate` gets each one.
 */
export async function convertStream(body: CreateJobRequest, onUpdate: (job: JobView) => void, signal?: AbortSignal): Promise<void> {
  let response: Response;
  try {
    response = await fetch('/api/convert', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/x-ndjson', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiClientError('NETWORK_TIMEOUT', "Couldn't reach the server. Check your connection and try again.", { retryable: true, network: true });
  }
  if (!response.ok || !response.body) {
    const error = await toError(response);
    if (response.status === 401) unauthorizedHandler();
    throw error;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let finished = false;
  const handleLine = (line: string) => {
    if (!line.trim()) return;
    const job = JSON.parse(line) as JobView;
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'expired') finished = true;
    onUpdate(job);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        handleLine(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
      }
    }
    handleLine(buffered + decoder.decode());
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiClientError('NETWORK_TIMEOUT', 'The connection dropped while converting. Please try again.', { retryable: true, network: true });
  }
  if (!finished) {
    throw new ApiClientError('NETWORK_TIMEOUT', 'The conversion stopped before it finished (it may have taken too long). Try a lower quality or a shorter video.', { retryable: true });
  }
}

export function getJob(id: string, signal?: AbortSignal): Promise<JobView> {
  return request<JobView>(`/api/jobs/${encodeURIComponent(id)}`, { signal });
}

export function getPlatforms(signal?: AbortSignal): Promise<PlatformsResponse> {
  return request<PlatformsResponse>('/api/platforms', { signal });
}

export function createUploadTicket(body: UploadTicketRequest, signal?: AbortSignal): Promise<UploadTicketResponse> {
  return request<UploadTicketResponse>('/api/uploads', { method: 'POST', body, signal });
}

export async function login(password: string): Promise<void> {
  await request<{ ok: true }>('/api/auth/login', { method: 'POST', body: { password }, redirectOn401: false });
}

export async function logout(): Promise<void> {
  await request<{ ok: true }>('/api/auth/logout', { method: 'POST', redirectOn401: false });
}

/**
 * PUTs the raw file straight to the storage/API URL from the ticket (bypassing Next.js so
 * large files are not subject to serverless body limits). XHR is used for upload progress.
 */
export function uploadFile(
  ticket: UploadTicketResponse['upload'],
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(ticket.method, ticket.url);
    for (const [name, value] of Object.entries(ticket.headers)) xhr.setRequestHeader(name, value);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve();
        return;
      }
      if (xhr.status === 413) {
        reject(new ApiClientError('FILE_TOO_LARGE', defaultMessage('FILE_TOO_LARGE'), { status: 413 }));
      } else if (xhr.status === 403 || xhr.status === 410) {
        reject(
          new ApiClientError('LINK_EXPIRED', 'The upload link expired before the file finished uploading. Please try again.', {
            status: xhr.status,
            retryable: true,
          }),
        );
      } else {
        reject(new ApiClientError('STORAGE_FAILURE', defaultMessage('STORAGE_FAILURE'), { status: xhr.status, retryable: true }));
      }
    };
    xhr.onerror = () =>
      reject(
        new ApiClientError('NETWORK_TIMEOUT', 'The upload was interrupted. Check your connection and try again.', {
          retryable: true,
          network: true,
        }),
      );
    xhr.ontimeout = xhr.onerror;
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));

    if (signal) {
      if (signal.aborted) {
        reject(new DOMException('Upload cancelled', 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(file);
  });
}
