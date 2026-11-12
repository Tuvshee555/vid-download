/**
 * Server-side helpers shared by the BFF route handlers (login, logout, proxy) and the
 * session check. Nothing in here may be imported from client components.
 */
import { AppError, toApiErrorBody, type ErrorCode } from '@vd/shared';

export const SESSION_COOKIE = 'md_session';
export const DEFAULT_SESSION_SECONDS = 60 * 60 * 24 * 7;

export function apiBaseUrl(): string {
  const raw = process.env.API_BASE_URL?.trim() || 'http://localhost:4000';
  return raw.replace(/\/+$/, '');
}

export function jsonError(code: ErrorCode, options: { status?: number; message?: string } = {}): Response {
  const error = new AppError(code, options.message, options.status ? { status: options.status } : {});
  return new Response(JSON.stringify(toApiErrorBody(error)), {
    status: error.status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export function unreachableError(): Response {
  return jsonError('PLATFORM_API_ERROR', {
    status: 502,
    message: 'The MediaDock server is unreachable right now. Please try again in a moment.',
  });
}

export function timeoutError(): Response {
  return jsonError('NETWORK_TIMEOUT', {
    status: 504,
    message: 'The MediaDock server took too long to respond. Please try again.',
  });
}

export function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/**
 * Reads a request body as text but refuses anything larger than `maxBytes`, even when the
 * client lies about (or omits) Content-Length. Returns `null` when the limit is exceeded.
 */
export async function readLimitedText(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return '';

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export function sessionCookieOptions(expires?: Date) {
  const valid = expires && !Number.isNaN(expires.getTime()) ? expires : undefined;
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    ...(valid ? { expires: valid } : { maxAge: DEFAULT_SESSION_SECONDS }),
  };
}

export function clearedCookieOptions() {
  return { ...sessionCookieOptions(), maxAge: 0, expires: new Date(0) };
}
