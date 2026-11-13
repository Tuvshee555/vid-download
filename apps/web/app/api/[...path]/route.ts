/**
 * Same-origin proxy between the browser and the MediaDock API.
 *
 * - The session token lives in an httpOnly cookie; this handler turns it into a Bearer
 *   header. Browser JavaScript never sees it.
 * - Only an explicit allowlist of method + path pairs is forwarded. File downloads
 *   (`/v1/files/*`) and upload PUTs deliberately never pass through here.
 * - Request bodies are small JSON documents only; no cookies or other browser headers are
 *   forwarded upstream.
 */
import { NextResponse, type NextRequest } from 'next/server';
import {
  apiBaseUrl,
  clearedCookieOptions,
  isTimeoutError,
  jsonError,
  readLimitedText,
  SESSION_COOKIE,
  timeoutError,
  unreachableError,
} from '@/lib/bff';
import { isAllowedRoute, type ProxyMethod } from '@/lib/proxy-allowlist';
import { isRelayRequest } from '@/lib/server/relay';
import { serverMode } from '@/lib/server/standalone';
import { handleStandalone } from '@/lib/server/standalone-api';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 30_000;

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

async function handle(request: NextRequest, context: RouteContext, method: ProxyMethod): Promise<Response> {
  const { path: segments } = await context.params;
  const path = segments.join('/');

  if (!isAllowedRoute(method, path)) return jsonError('NOT_FOUND', { message: 'That endpoint does not exist.' });

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  // In standalone mode the cloud deployment may call this instance (the home helper) with the relay secret.
  const relayAuthorized = serverMode() === 'standalone' && isRelayRequest(request.headers);
  if (!token && !relayAuthorized) return jsonError('UNAUTHENTICATED');

  const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' };
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) headers['x-forwarded-for'] = forwardedFor;

  let body: string | undefined;
  if (method === 'POST') {
    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('application/json')) {
      return jsonError('VALIDATION_ERROR', { status: 415, message: 'Requests must be sent as JSON.' });
    }
    const text = await readLimitedText(request, MAX_BODY_BYTES);
    if (text === null) return jsonError('VALIDATION_ERROR', { status: 413, message: 'That request was too large.' });
    body = text;
    headers['content-type'] = 'application/json';
  }

  // Standalone (single Vercel project): answer here instead of proxying to an external API.
  if (serverMode() === 'standalone') {
    const response = await handleStandalone(method, path, token, body, relayAuthorized);
    if (response.status === 401) {
      const cleared = new Response(response.body, response);
      cleared.headers.append('set-cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
      return cleared;
    }
    return response;
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBaseUrl()}/v1/${path}`, {
      method,
      headers,
      body,
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    return isTimeoutError(error) ? timeoutError() : unreachableError();
  }

  // Redirects from the API are never followed or exposed.
  if (upstream.status >= 300 && upstream.status < 400) return unreachableError();

  const contentType = upstream.headers.get('content-type') ?? '';
  const text = await upstream.text();
  if (text.length > MAX_RESPONSE_BYTES || (text.length > 0 && !contentType.toLowerCase().includes('json'))) {
    return unreachableError();
  }

  const response =
    upstream.status === 204 || text.length === 0
      ? new NextResponse(null, { status: upstream.status === 204 ? 204 : upstream.status })
      : new NextResponse(text, {
          status: upstream.status,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
  response.headers.set('cache-control', 'no-store');
  if (upstream.status === 401) response.cookies.set(SESSION_COOKIE, '', clearedCookieOptions());
  return response;
}

export function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  return handle(request, context, 'GET');
}

export function POST(request: NextRequest, context: RouteContext): Promise<Response> {
  return handle(request, context, 'POST');
}
