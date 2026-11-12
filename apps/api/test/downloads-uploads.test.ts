import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signToken, type DownloadClaims, type UploadClaims } from '@vd/core';
import { parseRange } from '../src/routes/public';
import { TEST_SECRET, createTestContext, type TestContext } from './helpers';

const CONTENT = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');

describe('download authorization (signed links)', () => {
  let ctx: TestContext;
  let key: string;
  let jobId: string;

  async function linkFor(overrides: Partial<DownloadClaims> = {}, secret = TEST_SECRET): Promise<string> {
    const claims: DownloadClaims = {
      typ: 'download',
      exp: Math.floor(Date.now() / 1000) + 300,
      k: key,
      fn: 'My Clip — ✓.mp4',
      ct: 'video/mp4',
      ...overrides,
    };
    return `/v1/files/${signToken(claims, secret)}`;
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    jobId = randomUUID();
    key = await ctx.writeOutput(jobId, CONTENT);
  });
  afterAll(() => ctx.cleanup());

  it('serves the file for a valid link — without a session (the signature is the capability)', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: await linkFor() });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.equals(CONTENT)).toBe(true);
    expect(response.headers['content-type']).toBe('video/mp4');
    expect(response.headers['content-length']).toBe(String(CONTENT.length));
    expect(response.headers['content-disposition']).toMatch(/^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('supports range requests so large downloads can resume', async () => {
    const partial = await ctx.app.inject({ method: 'GET', url: await linkFor(), headers: { range: 'bytes=10-19' } });
    expect(partial.statusCode).toBe(206);
    expect(partial.rawPayload.toString()).toBe('abcdefghij');
    expect(partial.headers['content-range']).toBe(`bytes 10-19/${CONTENT.length}`);

    const tail = await ctx.app.inject({ method: 'GET', url: await linkFor(), headers: { range: 'bytes=-5' } });
    expect(tail.rawPayload.toString()).toBe('vwxyz');

    const bad = await ctx.app.inject({ method: 'GET', url: await linkFor(), headers: { range: 'bytes=999-' } });
    expect(bad.statusCode).toBe(416);
  });

  it('refuses expired links with 410', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: await linkFor({ exp: Math.floor(Date.now() / 1000) - 1 }) });
    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ error: { code: 'LINK_EXPIRED' } });
  });

  it('refuses forged, foreign-signed, wrong-purpose and garbage tokens with 403', async () => {
    const valid = await linkFor();
    const [body, signature] = valid.replace('/v1/files/', '').split('.') as [string, string];
    const forgedClaims = Buffer.from(JSON.stringify({ typ: 'download', exp: 9_999_999_999, k: key, fn: 'x.mp4', ct: 'video/mp4' })).toString('base64url');

    const urls = [
      `/v1/files/${forgedClaims}.${signature}`,
      await linkFor({}, 'a-different-secret-a-different-secret'),
      `/v1/files/${ctx.token}`, // a session token must not open files
      `/v1/files/${signToken({ typ: 'upload', exp: Math.floor(Date.now() / 1000) + 60 }, TEST_SECRET)}`,
      '/v1/files/garbage',
      `/v1/files/${body}.`,
    ];
    for (const url of urls) {
      const response = await ctx.app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    }
  });

  it('cannot be pointed at files outside the output area', async () => {
    for (const bad of ['../../etc/passwd', 'uploads/../../secret', '/etc/passwd', 'outputs/x/../../../y']) {
      const response = await ctx.app.inject({ method: 'GET', url: await linkFor({ k: bad }) });
      expect([403, 410, 500]).toContain(response.statusCode);
      expect(response.statusCode).not.toBe(200);
    }
  });

  it('answers 410 once the file has been cleaned up', async () => {
    const id = randomUUID();
    const gone = await ctx.writeOutput(id, CONTENT);
    const url = await linkFor({ k: gone });
    await ctx.storage.delete(gone);
    const response = await ctx.app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ error: { code: 'LINK_EXPIRED' } });
  });

  it('has no unrestricted proxy: the only way in is a signed token', async () => {
    for (const url of ['/v1/files', '/v1/files/', '/v1/files?url=https://example.com/a.mp4', '/v1/download?url=https://example.com/a.mp4', '/v1/proxy?url=http://127.0.0.1']) {
      const response = await ctx.app.inject({ method: 'GET', url, headers: ctx.auth });
      expect([401, 403, 404]).toContain(response.statusCode);
    }
  });
});

describe('uploads', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext({ MAX_INPUT_MB: '1' });
  });
  afterAll(() => ctx.cleanup());

  const ticket = (payload: unknown) =>
    ctx.app.inject({ method: 'POST', url: '/v1/uploads', headers: ctx.auth, payload: payload as never });

  it('issues a ticket and accepts exactly the declared bytes', async () => {
    const response = await ticket({ filename: 'clip.mp4', size: 5, contentType: 'video/mp4' });
    expect(response.statusCode).toBe(200);
    const { uploadId, upload, maxBytes } = response.json() as { uploadId: string; upload: { url: string; method: string; headers: Record<string, string>; expiresAt: string }; maxBytes: number };
    expect(upload.method).toBe('PUT');
    expect(upload.headers['Content-Type']).toBe('video/mp4');
    expect(maxBytes).toBe(1024 * 1024);
    expect(Date.parse(upload.expiresAt)).toBeGreaterThan(Date.now());

    const put = await ctx.app.inject({ method: 'PUT', url: new URL(upload.url).pathname, payload: Buffer.from('12345'), headers: { 'content-type': 'video/mp4' } });
    expect(put.statusCode).toBe(200);
    expect((await ctx.storage.head(`uploads/${uploadId}`))?.size).toBe(5);
  });

  it('rejects a body whose size differs from the ticket', async () => {
    const response = await ticket({ filename: 'clip.mp4', size: 5, contentType: 'video/mp4' });
    const { upload, uploadId } = response.json() as { upload: { url: string }; uploadId: string };
    const put = await ctx.app.inject({ method: 'PUT', url: new URL(upload.url).pathname, payload: Buffer.from('123456789'), headers: { 'content-type': 'video/mp4' } });
    expect(put.statusCode).toBe(400);
    expect(await ctx.storage.head(`uploads/${uploadId}`)).toBeNull();
  });

  it('refuses tickets for oversized files, wrong extensions and bad bodies', async () => {
    expect((await ticket({ filename: 'huge.mp4', size: 5 * 1024 * 1024, contentType: 'video/mp4' })).json()).toMatchObject({ error: { code: 'FILE_TOO_LARGE' } });
    expect((await ticket({ filename: 'virus.exe', size: 10, contentType: 'application/octet-stream' })).statusCode).toBe(400);
    expect((await ticket({ filename: 'a.mp4', size: 0 })).statusCode).toBe(400);
    expect((await ticket({ filename: 'a.mp4' })).statusCode).toBe(400);
  });

  it('refuses expired, forged and wrong-purpose upload links', async () => {
    const claims = (over: Partial<UploadClaims>): UploadClaims => ({
      typ: 'upload',
      exp: Math.floor(Date.now() / 1000) + 300,
      k: `uploads/${randomUUID()}`,
      sz: 3,
      ct: 'video/mp4',
      ...over,
    });
    const put = (token: string) =>
      ctx.app.inject({ method: 'PUT', url: `/v1/uploads/${token}`, payload: Buffer.from('abc'), headers: { 'content-type': 'video/mp4' } });

    expect((await put(signToken(claims({ exp: Math.floor(Date.now() / 1000) - 1 }), TEST_SECRET))).statusCode).toBe(410);
    expect((await put(signToken(claims({}), 'another-secret-another-secret-12345'))).statusCode).toBe(403);
    expect((await put(signToken({ ...claims({}), typ: 'download' } as never, TEST_SECRET))).statusCode).toBe(403);
    expect((await put('garbage')).statusCode).toBe(403);
    expect((await put(signToken(claims({}), TEST_SECRET))).statusCode).toBe(200);
  });

  it('cannot be tricked into writing outside the upload area', async () => {
    const token = signToken({ typ: 'upload', exp: Math.floor(Date.now() / 1000) + 300, k: '../../escape', sz: 3, ct: 'video/mp4' }, TEST_SECRET);
    const response = await ctx.app.inject({ method: 'PUT', url: `/v1/uploads/${token}`, payload: Buffer.from('abc'), headers: { 'content-type': 'video/mp4' } });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('does not accept uploads to the JSON routes', async () => {
    const response = await ctx.app.inject({ method: 'POST', url: '/v1/jobs', headers: { ...ctx.auth, 'content-type': 'video/mp4' }, payload: Buffer.alloc(100) });
    expect(response.statusCode).toBe(400);
  });
});

describe('parseRange', () => {
  it.each([
    ['bytes=0-9', 100, { start: 0, end: 9 }],
    ['bytes=90-', 100, { start: 90, end: 99 }],
    ['bytes=-10', 100, { start: 90, end: 99 }],
    ['bytes=50-500', 100, { start: 50, end: 99 }],
    ['bytes=100-', 100, 'unsatisfiable'],
    ['bytes=-0', 100, 'unsatisfiable'],
    ['bytes=9-1', 100, 'unsatisfiable'],
    ['bytes=0-1,5-6', 100, null],
    ['items=0-1', 100, null],
    ['garbage', 100, null],
  ] as const)('%s on %i bytes', (header, size, expected) => {
    expect(parseRange(header, size)).toEqual(expected);
  });
});
