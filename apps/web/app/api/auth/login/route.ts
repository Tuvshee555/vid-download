import { NextResponse, type NextRequest } from 'next/server';
import { loginRequestSchema } from '@vd/shared';
import {
  apiBaseUrl,
  isTimeoutError,
  jsonError,
  readLimitedText,
  SESSION_COOKIE,
  sessionCookieOptions,
  timeoutError,
  unreachableError,
} from '@/lib/bff';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 4 * 1024;

export async function POST(request: NextRequest): Promise<Response> {
  const text = await readLimitedText(request, MAX_BODY_BYTES);
  if (text === null) return jsonError('VALIDATION_ERROR', { status: 413, message: 'That request was too large.' });

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return jsonError('VALIDATION_ERROR', { message: 'Enter the access password.' });
  }
  const validation = loginRequestSchema.safeParse(parsed);
  if (!validation.success) {
    return jsonError('VALIDATION_ERROR', { message: validation.error.issues[0]?.message ?? 'Enter the access password.' });
  }

  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) headers['x-forwarded-for'] = forwardedFor;

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBaseUrl()}/v1/auth/login`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ password: validation.data.password }),
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return isTimeoutError(error) ? timeoutError() : unreachableError();
  }

  const upstreamText = await upstream.text();
  let body: unknown;
  try {
    body = JSON.parse(upstreamText);
  } catch {
    return unreachableError();
  }

  if (!upstream.ok) {
    return new Response(JSON.stringify(body), {
      status: upstream.status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  const { token, expiresAt } = (body ?? {}) as { token?: unknown; expiresAt?: unknown };
  if (typeof token !== 'string' || token.length === 0) return unreachableError();

  const response = NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
  response.cookies.set(
    SESSION_COOKIE,
    token,
    sessionCookieOptions(typeof expiresAt === 'string' ? new Date(expiresAt) : undefined),
  );
  return response;
}
