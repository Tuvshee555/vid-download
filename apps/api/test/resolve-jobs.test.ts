import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeFailure } from '@vd/core';
import { AppError, type JobResultRecord } from '@vd/shared';
import { vi } from 'vitest';
import { createTestContext, reelInfo, type TestContext } from './helpers';

describe('POST /v1/resolve — input validation', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.cleanup());

  const resolve = (payload: unknown, headers: Record<string, string> = ctx.auth) =>
    ctx.app.inject({ method: 'POST', url: '/v1/resolve', payload: payload as never, headers });

  it.each([
    [{}, 'VALIDATION_ERROR'],
    [{ url: '' }, 'VALIDATION_ERROR'],
    [{ url: 123 }, 'VALIDATION_ERROR'],
    [{ url: 'x'.repeat(3000) }, 'VALIDATION_ERROR'],
    [{ url: 'not a url at all' }, 'INVALID_URL'],
    [{ url: 'javascript:alert(1)' }, 'INVALID_URL'],
    [{ url: 'file:///etc/passwd' }, 'INVALID_URL'],
    [{ url: 'https://vimeo.com/12345' }, 'UNSUPPORTED_DOMAIN'],
    [{ url: 'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ' }, 'UNSUPPORTED_DOMAIN'],
    [{ url: 'http://localhost:4000/v1/files/x' }, 'BLOCKED_ADDRESS'],
    [{ url: 'http://127.0.0.1:6379' }, 'BLOCKED_ADDRESS'],
    [{ url: 'http://169.254.169.254/latest/meta-data/' }, 'BLOCKED_ADDRESS'],
    [{ url: 'http://192.168.1.10/admin' }, 'BLOCKED_ADDRESS'],
    [{ url: 'http://[::1]/' }, 'BLOCKED_ADDRESS'],
    [{ url: 'https://www.youtube.com/playlist?list=PL1' }, 'UNSUPPORTED_URL_TYPE'],
  ])('rejects %j with %s (HTTP 400)', async (payload, code) => {
    const response = await resolve(payload);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code } });
  });

  it('rejects oversized and non-JSON bodies', async () => {
    const big = await resolve({ url: 'https://youtu.be/dQw4w9WgXcQ', pad: 'x'.repeat(40_000) });
    expect(big.statusCode).toBe(413);
    const text = await ctx.app.inject({
      method: 'POST',
      url: '/v1/resolve',
      payload: 'url=https://youtu.be/dQw4w9WgXcQ',
      headers: { ...ctx.auth, 'content-type': 'text/plain' },
    });
    expect(text.statusCode).toBe(400);
  });

  it('resolves a YouTube link to real quality options built from yt-dlp metadata', async () => {
    const response = await resolve({ url: 'https://youtu.be/dQw4w9WgXcQ?si=tracking' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      platform: 'youtube',
      mediaId: 'dQw4w9WgXcQ',
      canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      metadata: { title: 'Some video', author: 'Some channel' },
      availability: { status: 'available' },
    });
    const ids = (response.json() as { availability: { options: Array<{ id: string }> } }).availability.options.map((o) => o.id);
    expect(ids).toEqual(['mp4-720', 'mp4-360', 'mp3']);
  });

  it('resolves Instagram, Facebook and TikTok links (incl. share/short links) via canonical URLs', async () => {
    const fetchInfo = vi.fn(async () => reelInfo);
    const local = await createTestContext({}, fetchInfo);
    try {
      for (const [url, canonical] of [
        ['https://www.instagram.com/reel/Cabc123XYZ/?igsh=tracking', 'https://www.instagram.com/reel/Cabc123XYZ/'],
        ['https://fb.watch/abcDEF123/', 'https://fb.watch/abcDEF123/'],
        ['https://www.facebook.com/share/r/AbC123xyz/', 'https://www.facebook.com/share/r/AbC123xyz/'],
        ['https://vm.tiktok.com/ZMabc123/', 'https://vm.tiktok.com/ZMabc123/'],
        ['https://www.tiktok.com/@realmadrid/video/7707305867162570017?lang=en', 'https://www.tiktok.com/@realmadrid/video/7707305867162570017'],
      ]) {
        const response = await local.app.inject({ method: 'POST', url: '/v1/resolve', headers: local.auth, payload: { url } });
        expect(response.statusCode, url).toBe(200);
        expect(response.json()).toMatchObject({ canonicalUrl: canonical, availability: { status: 'available' } });
        expect(fetchInfo).toHaveBeenLastCalledWith(canonical, expect.any(String), expect.anything());
      }
      const body = (await local.app.inject({ method: 'POST', url: '/v1/resolve', headers: local.auth, payload: { url: 'https://www.instagram.com/reel/Cabc123XYZ/' } })).json() as { metadata: { title: string } };
      expect(body.metadata.title).toBe('Launch day');
    } finally {
      await local.cleanup();
    }
  });

  it('explains private or removed videos instead of failing', async () => {
    const response = await resolve({ url: 'https://www.instagram.com/reel/NotMyReel99/' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ availability: { status: 'unavailable', reason: { code: 'PRIVATE_CONTENT', message: expect.stringMatching(/private/) } } });
  });

  it('explains a platform that blocks the server (YouTube bot check) with a way forward', async () => {
    const blocked = await createTestContext(
      {},
      vi.fn(async () => Promise.reject(new AppError('PLATFORM_API_ERROR', 'YouTube is blocking this server.', { retryable: false, guidance: ['Run MediaDock on your own computer.'] }))),
    );
    try {
      const response = await blocked.app.inject({ method: 'POST', url: '/v1/resolve', headers: blocked.auth, payload: { url: 'https://youtu.be/dQw4w9WgXcQ' } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        availability: { status: 'unavailable', reason: { code: 'PLATFORM_API_ERROR', guidance: ['Run MediaDock on your own computer.'] } },
      });
    } finally {
      await blocked.cleanup();
    }
  });

  it('surfaces transient platform failures as a retryable 502 without leaking raw tool output', async () => {
    const failing = await createTestContext(
      {},
      vi.fn(async () => Promise.reject(new AppError('PLATFORM_API_ERROR', 'Could not get this video from Instagram. Please try again later.', { retryable: true, cause: 'ERROR: [Instagram] secret raw stderr' }))),
    );
    try {
      const response = await failing.app.inject({ method: 'POST', url: '/v1/resolve', headers: failing.auth, payload: { url: 'https://www.instagram.com/reel/Cabc123XYZ/' } });
      expect(response.statusCode).toBe(502);
      expect(response.json()).toMatchObject({ error: { code: 'PLATFORM_API_ERROR', retryable: true } });
      expect(response.body).not.toContain('secret raw stderr');
    } finally {
      await failing.cleanup();
    }
  });

  it('lists all four platforms with an honest summary', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/v1/platforms', headers: ctx.auth });
    const body = response.json() as { platforms: Array<{ platform: string; configured: boolean; capability: string; summary: string }>; limits: Record<string, number> };
    expect(body.platforms.map((p) => p.platform)).toEqual(['youtube', 'instagram', 'facebook', 'tiktok']);
    expect(body.platforms.every((p) => p.capability === 'public-links' && p.configured)).toBe(true);
    expect(body.platforms.find((p) => p.platform === 'youtube')?.summary).toMatch(/blocks many cloud servers/);
    expect(body.limits.maxUploadBytes).toBeGreaterThan(0);
  });
});

describe('jobs', () => {
  let ctx: TestContext;
  // Each request comes from its own address so the per-IP job-creation limit doesn't interfere with these tests.
  let ipCounter = 0;
  const nextIp = () => `10.1.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(() => ctx.cleanup());

  const createJob = (payload: unknown) =>
    ctx.app.inject({ method: 'POST', url: '/v1/jobs', headers: ctx.auth, payload: payload as never, remoteAddress: nextIp() });
  const getJob = (id: string, headers: Record<string, string> = ctx.auth) =>
    ctx.app.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers, remoteAddress: nextIp() });

  it('validates job requests', async () => {
    for (const payload of [{}, { source: 'url' }, { source: 'url', url: 'https://youtu.be/dQw4w9WgXcQ', format: 'avi' }, { source: 'upload', uploadId: '../x', format: 'mp3' }]) {
      const response = await createJob(payload);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
    expect(ctx.queue.jobs.size).toBe(0);
  });

  it('queues a YouTube MP4 job with the chosen quality', async () => {
    const response = await createJob({ source: 'url', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', format: 'mp4', quality: 720 });
    expect(response.statusCode).toBe(202);
    const job = ctx.queue.jobs.get((response.json() as { id: string }).id)!;
    expect(job.data).toMatchObject({ format: 'mp4', quality: 720, source: { platform: 'youtube', canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } });
    ctx.queue.jobs.clear();
  });

  it('refuses a job for a private video and creates nothing', async () => {
    const response = await createJob({ source: 'url', url: 'https://www.instagram.com/reel/NotMyReel99/', format: 'mp4' });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'PRIVATE_CONTENT' } });
    expect(ctx.queue.jobs.size).toBe(0);
  });

  it('rejects an out-of-range quality', async () => {
    const response = await createJob({ source: 'url', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', format: 'mp4', quality: 99999 });
    expect(response.statusCode).toBe(400);
  });

  it('rejects private/unsupported URLs before any work is queued', async () => {
    for (const [url, code] of [
      ['http://169.254.169.254/', 'BLOCKED_ADDRESS'],
      ['https://example.com/video.mp4', 'UNSUPPORTED_DOMAIN'],
    ] as const) {
      const response = await createJob({ source: 'url', url, format: 'mp4' });
      expect(response.json()).toMatchObject({ error: { code } });
    }
    expect(ctx.queue.jobs.size).toBe(0);
  });

  it('queues an authorised Instagram job using the canonical URL, not the raw input', async () => {
    const response = await createJob({ source: 'url', url: 'https://www.instagram.com/reel/Cabc123XYZ/?igsh=utm_stuff', format: 'mp3' });
    expect(response.statusCode).toBe(202);
    const { id, status } = response.json() as { id: string; status: string };
    expect(status).toBe('queued');
    expect(response.headers.location).toBe(`/v1/jobs/${id}`);
    const stored = ctx.queue.jobs.get(id)!;
    expect(stored.data).toMatchObject({
      format: 'mp3',
      source: { kind: 'platform', platform: 'instagram', mediaId: 'Cabc123XYZ', canonicalUrl: 'https://www.instagram.com/reel/Cabc123XYZ/' },
    });
    expect(JSON.stringify(stored.data)).not.toContain('utm_stuff');
  });

  it('queues an upload job only when the upload exists', async () => {
    const uploadId = randomUUID();
    const missing = await createJob({ source: 'upload', uploadId, format: 'mp3' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    const ticket = await ctx.app.inject({
      method: 'POST',
      url: '/v1/uploads',
      headers: ctx.auth,
      payload: { filename: 'My Holiday?.mp4', size: 11, contentType: 'video/mp4' },
    });
    const { uploadId: realId, upload } = ticket.json() as { uploadId: string; upload: { url: string } };
    const put = await ctx.app.inject({
      method: 'PUT',
      url: new URL(upload.url).pathname,
      payload: Buffer.from('hello world'),
      headers: { 'content-type': 'video/mp4' },
    });
    expect(put.statusCode).toBe(200);

    const ok = await createJob({ source: 'upload', uploadId: realId, format: 'mp3', filename: '../../My Holiday?.mp4' });
    expect(ok.statusCode).toBe(202);
    const job = ctx.queue.jobs.get((ok.json() as { id: string }).id)!;
    expect(job.data.source).toEqual({ kind: 'upload', uploadId: realId, originalName: 'My Holiday .mp4' });
  });

  it('reports a failed queue as a retryable 503 instead of crashing', async () => {
    ctx.queue.failAdd = true;
    try {
      const response = await createJob({ source: 'url', url: 'https://www.instagram.com/reel/Cabc123XYZ/', format: 'mp4' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: 'INTERNAL', retryable: true } });
      expect(response.body).not.toContain('redis');
    } finally {
      ctx.queue.failAdd = false;
    }
  });

  describe('GET /v1/jobs/:id', () => {
    const makeJob = async () => {
      const response = await createJob({ source: 'url', url: 'https://www.instagram.com/reel/Cabc123XYZ/', format: 'mp4' });
      return (response.json() as { id: string }).id;
    };

    it('404s for unknown ids and rejects non-UUID ids', async () => {
      expect((await getJob(randomUUID())).statusCode).toBe(404);
      expect((await getJob('1')).statusCode).toBe(404);
      expect((await getJob('..%2F..%2Fetc%2Fpasswd')).statusCode).toBe(404);
    });

    it('reports queued → processing with progress', async () => {
      const id = await makeJob();
      expect((await getJob(id)).json()).toMatchObject({ id, status: 'queued', format: 'mp4', progress: { stage: 'queued', percent: 0 }, attempt: 1, maxAttempts: 2 });

      ctx.queue.patch(id, { state: 'active', progress: { stage: 'converting', percent: 62.4 } });
      expect((await getJob(id)).json()).toMatchObject({ status: 'processing', progress: { stage: 'converting', percent: 62 } });

      ctx.queue.patch(id, { progress: { stage: 'bogus', percent: 9999 } });
      expect((await getJob(id)).json()).toMatchObject({ progress: { stage: 'resolving', percent: 0 } });
    });

    it('treats a retry back-off as queued and counts the attempt', async () => {
      const id = await makeJob();
      ctx.queue.patch(id, { state: 'delayed', attemptsMade: 1 });
      expect((await getJob(id)).json()).toMatchObject({ status: 'queued', attempt: 2 });
    });

    it('reports failures with the structured error and nothing internal', async () => {
      const id = await makeJob();
      ctx.queue.patch(id, { state: 'failed', attemptsMade: 2, failedReason: encodeFailure(new AppError('PROCESSING_FAILED', 'Bad file', { retryable: false })) });
      const body = (await getJob(id)).json();
      expect(body).toMatchObject({ status: 'failed', error: { code: 'PROCESSING_FAILED', message: 'Bad file', retryable: false } });

      ctx.queue.patch(id, { failedReason: 'ENOENT: /srv/secret/path' });
      const generic = await getJob(id);
      expect(generic.json()).toMatchObject({ error: { code: 'PROCESSING_FAILED' } });
      expect(generic.body).not.toContain('/srv/secret');
    });

    it('returns a download link for a completed job, then expires it when the record or file is gone', async () => {
      const id = await makeJob();
      const key = await ctx.writeOutput(id, Buffer.from('FAKE-MP4-CONTENT'));
      const record: JobResultRecord = {
        storageKey: key,
        filename: 'Launch day.mp4',
        format: 'mp4',
        mimeType: 'video/mp4',
        sizeBytes: 16,
        durationSeconds: 12.5,
        resolution: '1280×720',
        losslessVideo: true,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      };
      ctx.queue.patch(id, { state: 'completed', returnValue: record, attemptsMade: 1 });

      const body = (await getJob(id)).json() as { status: string; result: { filename: string; resolution: string; losslessVideo: boolean; download: { url: string; expiresAt: string } } };
      expect(body.status).toBe('completed');
      expect(body.result).toMatchObject({ filename: 'Launch day.mp4', resolution: '1280×720', losslessVideo: true });
      expect(body.result.download.url).toMatch(/^http:\/\/api\.test\/v1\/files\//);
      expect(JSON.stringify(body)).not.toContain('storageKey');

      // record past its expiry → expired
      ctx.queue.patch(id, { returnValue: { ...record, expiresAt: new Date(Date.now() - 1000).toISOString() } });
      expect((await getJob(id)).json()).toMatchObject({ status: 'expired', error: { code: 'LINK_EXPIRED' } });

      // record still valid but file swept → expired
      ctx.queue.patch(id, { returnValue: record });
      await ctx.storage.delete(key);
      expect((await getJob(id)).json()).toMatchObject({ status: 'expired' });
    });

    it('does not expose jobs without a session', async () => {
      const id = await makeJob();
      expect((await getJob(id, {})).statusCode).toBe(401);
    });

    it('reports a queue outage as 503', async () => {
      const id = await makeJob();
      ctx.queue.failGet = true;
      try {
        const response = await getJob(id);
        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({ error: { retryable: true } });
      } finally {
        ctx.queue.failGet = false;
      }
    });
  });
});
