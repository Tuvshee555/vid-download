// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '@/app/api/[...path]/route';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { POST as logoutPOST } from '@/app/api/auth/logout/route';
import { isAllowedRoute } from '@/lib/proxy-allowlist';
import { SESSION_COOKIE } from '@/lib/bff';

const JOB = '5b0f2f5e-3f4a-4f5f-9a27-0d9c1f6e9a11';
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('API_BASE_URL', 'http://api.test:4000/');
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function req(method: 'GET' | 'POST', path: string, init: { cookie?: string | null; body?: string; contentType?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...init.headers };
  if (init.cookie !== null) headers.cookie = `${SESSION_COOKIE}=${init.cookie ?? 'tok_abc'}`;
  if (init.body !== undefined) headers['content-type'] = init.contentType ?? 'application/json';
  return new NextRequest(`http://localhost:3000/api/${path}`, { method, headers, body: init.body });
}

const ctx = (path: string) => ({ params: Promise.resolve({ path: path.split('/') }) });

async function body(response: Response) {
  return JSON.parse(await response.text()) as { error?: { code: string; message: string } };
}

describe('proxy allowlist', () => {
  it.each([
    ['GET', 'auth/session'],
    ['GET', 'platforms'],
    ['POST', 'resolve'],
    ['POST', 'uploads'],
    ['POST', 'jobs'],
    ['GET', `jobs/${JOB}`],
  ])('allows %s %s', (method, path) => {
    expect(isAllowedRoute(method, path)).toBe(true);
  });

  it.each([
    ['GET', 'files/abc'],
    ['PUT', 'uploads/abc'],
    ['GET', 'auth/login'],
    ['POST', 'auth/login'],
    ['GET', 'jobs'],
    ['POST', `jobs/${JOB}`],
    ['GET', 'jobs/not-a-uuid'],
    ['GET', `jobs/${JOB}/extra`],
    ['GET', `jobs/${JOB}/../files/x`],
    ['GET', 'health'],
    ['GET', ''],
    ['DELETE', `jobs/${JOB}`],
  ])('blocks %s %s', (method, path) => {
    expect(isAllowedRoute(method, path)).toBe(false);
  });
});

describe('proxy route', () => {
  it('returns 401 without a session cookie and never calls the API', async () => {
    const response = await GET(req('GET', 'platforms', { cookie: null }), ctx('platforms'));
    expect(response.status).toBe(401);
    expect((await body(response)).error?.code).toBe('UNAUTHENTICATED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 404 for paths outside the allowlist, even with a cookie', async () => {
    for (const path of ['files/abc', 'auth/login', 'jobs', 'admin/anything']) {
      const response = await GET(req('GET', path), ctx(path));
      expect(response.status).toBe(404);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 404 for a method that the path does not allow', async () => {
    const response = await POST(req('POST', 'platforms', { body: '{}' }), ctx('platforms'));
    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards an allowed GET with the Bearer token only', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ platforms: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const response = await GET(
      req('GET', 'platforms', { headers: { 'x-forwarded-for': '203.0.113.9', 'x-custom': 'nope', authorization: 'Bearer attacker' } }),
      ctx('platforms'),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ platforms: [] });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://api.test:4000/v1/platforms');
    const sent = init!.headers as Record<string, string>;
    expect(sent.authorization).toBe('Bearer tok_abc');
    expect(sent['x-forwarded-for']).toBe('203.0.113.9');
    expect(sent).not.toHaveProperty('cookie');
    expect(sent).not.toHaveProperty('x-custom');
    expect(init!.redirect).toBe('manual');
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });

  it('forwards an allowed POST body as JSON', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: JOB, status: 'queued' }), { status: 202, headers: { 'content-type': 'application/json' } }));
    const payload = JSON.stringify({ source: 'url', url: 'https://youtu.be/dQw4w9WgXcQ', format: 'mp4' });

    const response = await POST(req('POST', 'jobs', { body: payload }), ctx('jobs'));

    expect(response.status).toBe(202);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init!.method).toBe('POST');
    expect(init!.body).toBe(payload);
    expect((init!.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('rejects non-JSON and oversized request bodies', async () => {
    const wrongType = await POST(req('POST', 'resolve', { body: 'url=x', contentType: 'text/plain' }), ctx('resolve'));
    expect(wrongType.status).toBe(415);

    const huge = await POST(req('POST', 'resolve', { body: JSON.stringify({ url: 'x'.repeat(20_000) }) }), ctx('resolve'));
    expect(huge.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes API error bodies through and clears the cookie on 401', async () => {
    const apiError = { error: { code: 'UNAUTHENTICATED', message: 'Session expired.', retryable: false } };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(apiError), { status: 401, headers: { 'content-type': 'application/json' } }));

    const response = await GET(req('GET', `jobs/${JOB}`), ctx(`jobs/${JOB}`));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(apiError);
    expect(response.headers.get('set-cookie')).toMatch(new RegExp(`${SESSION_COOKIE}=;`));
  });

  it('maps an unreachable API to a 502 error body', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const response = await GET(req('GET', 'platforms'), ctx('platforms'));
    expect(response.status).toBe(502);
    expect((await body(response)).error?.code).toBe('PLATFORM_API_ERROR');
  });

  it('maps an upstream timeout to a 504 error body', async () => {
    fetchMock.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    const response = await GET(req('GET', 'platforms'), ctx('platforms'));
    expect(response.status).toBe(504);
    expect((await body(response)).error?.code).toBe('NETWORK_TIMEOUT');
  });

  it('never exposes upstream redirects or non-JSON responses', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://evil.example' } }));
    const redirected = await GET(req('GET', 'platforms'), ctx('platforms'));
    expect(redirected.status).toBe(502);
    expect(redirected.headers.get('location')).toBeNull();

    fetchMock.mockResolvedValueOnce(new Response('<html>hi</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const html = await GET(req('GET', 'platforms'), ctx('platforms'));
    expect(html.status).toBe(502);
  });
});

describe('login & logout routes', () => {
  function loginReq(payload: unknown) {
    return new NextRequest('http://localhost:3000/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7' },
      body: JSON.stringify(payload),
    });
  }

  it('sets an httpOnly session cookie from the API token and never returns the token', async () => {
    const expiresAt = '2026-11-19T10:00:00.000Z';
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ token: 'tok_secret', expiresAt }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const response = await loginPOST(loginReq({ password: 'hunter2' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${SESSION_COOKIE}=tok_secret`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toContain('Expires=');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://api.test:4000/v1/auth/login');
    expect((init!.headers as Record<string, string>)['x-forwarded-for']).toBe('198.51.100.7');
  });

  it('passes a failed login (and 429s) through without setting a cookie', async () => {
    const apiError = { error: { code: 'RATE_LIMITED', message: 'Too many attempts.', retryable: true } };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(apiError), { status: 429, headers: { 'content-type': 'application/json' } }));

    const response = await loginPOST(loginReq({ password: 'x' }));
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual(apiError);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('validates the body before calling the API', async () => {
    const response = await loginPOST(loginReq({ password: '' }));
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logout clears the cookie', async () => {
    const response = logoutPOST();
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(new RegExp(`${SESSION_COOKIE}=;`));
    expect(cookie).toMatch(/Max-Age=0/i);
  });
});
