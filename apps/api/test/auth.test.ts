import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signToken } from '@vd/core';
import { LoginThrottle } from '../src/lib/login-throttle';
import { scrubUrl } from '../src/app';
import { TEST_PASSWORD, TEST_SECRET, WEB_ORIGIN, createTestContext, type TestContext } from './helpers';

describe('authentication', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.cleanup());

  const PROTECTED: Array<['GET' | 'POST', string]> = [
    ['GET', '/v1/auth/session'],
    ['GET', '/v1/platforms'],
    ['POST', '/v1/resolve'],
    ['POST', '/v1/uploads'],
    ['POST', '/v1/jobs'],
    ['GET', '/v1/jobs/3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b'],
  ];

  it.each(PROTECTED)('%s %s requires a session', async (method, url) => {
    const response = await ctx.app.inject({ method, url, ...(method === 'POST' ? { payload: {} } : {}) });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    expect(response.headers['www-authenticate']).toContain('Bearer');
  });

  it('keeps health checks public and minimal', async () => {
    const live = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ ok: true });
    const ready = await ctx.app.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.json()).toEqual({ ok: true, redis: true });
  });

  it('signs in with the right password and returns an expiring token', async () => {
    const response = await ctx.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { password: TEST_PASSWORD } });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { token: string; expiresAt: string };
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());

    const session = await ctx.app.inject({ method: 'GET', url: '/v1/auth/session', headers: { authorization: `Bearer ${body.token}` } });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ authenticated: true, expiresAt: body.expiresAt });
  });

  it('rejects a wrong password without revealing anything useful', async () => {
    const response = await ctx.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { password: 'nope' } });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED', message: 'Incorrect password.' } });
  });

  it('validates the login body', async () => {
    for (const payload of [{}, { password: '' }, { password: 42 }, 'password']) {
      const response = await ctx.app.inject({ method: 'POST', url: '/v1/auth/login', payload: payload as never });
      expect([400, 401]).toContain(response.statusCode);
      expect(response.statusCode).not.toBe(200);
    }
  });

  it('rejects tampered, expired, wrong-type and malformed tokens', async () => {
    const now = Math.floor(Date.now() / 1000);
    const good = ctx.token;
    const [body, signature] = good.split('.') as [string, string];
    const forgedBody = Buffer.from(JSON.stringify({ typ: 'session', exp: now + 99999 })).toString('base64url');

    const attempts: Record<string, string> = {
      tampered: `${forgedBody}.${signature}`,
      expired: signToken({ typ: 'session', exp: now - 10 }, TEST_SECRET),
      'download token used as session': signToken({ typ: 'download', exp: now + 600 }, TEST_SECRET),
      'signed with another secret': signToken({ typ: 'session', exp: now + 600 }, 'some-other-secret-some-other-secret'),
      garbage: 'not-a-token',
      truncated: `${body}.`,
    };
    for (const [name, token] of Object.entries(attempts)) {
      const response = await ctx.app.inject({ method: 'GET', url: '/v1/auth/session', headers: { authorization: `Bearer ${token}` } });
      expect(response.statusCode, name).toBe(401);
    }
  });

  it('rejects non-Bearer schemes and tokens in the query string', async () => {
    const basic = await ctx.app.inject({ method: 'GET', url: '/v1/auth/session', headers: { authorization: `Basic ${ctx.token}` } });
    expect(basic.statusCode).toBe(401);
    const query = await ctx.app.inject({ method: 'GET', url: `/v1/auth/session?token=${ctx.token}` });
    expect(query.statusCode).toBe(401);
  });

  it('explains an expired session', async () => {
    const expired = signToken({ typ: 'session', exp: Math.floor(Date.now() / 1000) - 5 }, TEST_SECRET);
    const response = await ctx.app.inject({ method: 'GET', url: '/v1/auth/session', headers: { authorization: `Bearer ${expired}` } });
    expect(response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED', message: expect.stringMatching(/expired/i) } });
  });
});

describe('brute-force protection', () => {
  it('rate-limits the login endpoint per client', async () => {
    const ctx = await createTestContext();
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 12; i += 1) {
        const response = await ctx.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { password: `guess-${i}` } });
        statuses.push(response.statusCode);
      }
      expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
      expect(statuses).toContain(429);
      const limited = await ctx.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { password: TEST_PASSWORD } });
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    } finally {
      await ctx.cleanup();
    }
  });

  it('applies the global per-minute limit to authenticated routes', async () => {
    const ctx = await createTestContext({ RATE_LIMIT_PER_MINUTE: '5' });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 8; i += 1) {
        codes.push((await ctx.app.inject({ method: 'GET', url: '/v1/platforms', headers: ctx.auth })).statusCode);
      }
      expect(codes.filter((c) => c === 200)).toHaveLength(5);
      expect(codes).toContain(429);
    } finally {
      await ctx.cleanup();
    }
  });

  it('LoginThrottle locks after too many failures and recovers after the window', () => {
    const throttle = new LoginThrottle(3, 1000);
    expect(throttle.retryAfterMs(0)).toBe(0);
    throttle.recordFailure(100);
    throttle.recordFailure(200);
    expect(throttle.retryAfterMs(300)).toBe(0);
    throttle.recordFailure(300);
    expect(throttle.retryAfterMs(400)).toBe(700);
    expect(throttle.retryAfterMs(1101)).toBe(0);
  });
});

describe('transport hardening', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.cleanup());

  it('sends security headers', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('allows CORS only from the configured web origin', async () => {
    const allowed = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/v1/uploads/sometoken',
      headers: { origin: WEB_ORIGIN, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);

    const denied = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/v1/uploads/sometoken',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'PUT' },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns JSON 404s and never leaks internals', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/v1/nope', headers: ctx.auth });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('scrubs capability tokens from logged URLs', () => {
    expect(scrubUrl('/v1/files/abc.def?x=1')).toBe('/v1/files/[token]?x=1');
    expect(scrubUrl('/v1/uploads/abc.def')).toBe('/v1/uploads/[token]');
    expect(scrubUrl('/v1/jobs/123')).toBe('/v1/jobs/123');
  });
});
