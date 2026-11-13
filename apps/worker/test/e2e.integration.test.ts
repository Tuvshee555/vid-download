/**
 * End-to-end test of the self-hosted stack: HTTP API + Redis/BullMQ + worker + FFmpeg +
 * storage, driven over real HTTP exactly like the browser does. yt-dlp is replaced by a fake
 * (metadata + "download" of a local fixture) so the test is deterministic and offline;
 * real downloads are covered by `npm run try`.
 *
 * Needs a Redis: run with E2E_REDIS_URL=redis://127.0.0.1:6379/15 (the DB is flushed!).
 */
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, type JobResultRecord, type JobView } from '@vd/shared';
import {
  LocalStorage,
  MEDIA_QUEUE_NAME,
  createAdapters,
  createLogger,
  createMediaQueue,
  createRedisConnection,
  loadConfig,
  probeFile,
  silentLogger,
  type MediaJobData,
  type YtDlpInfo,
} from '@vd/core';
import { makeFixtures, type Fixtures } from '../../../packages/core/src/media/test-fixtures';
import { buildApp } from '../../api/src/app';
import { BullJobQueue } from '../../api/src/services/job-queue';
import { createJobHandler } from '../src/processors/handler';

const REDIS_URL = process.env.E2E_REDIS_URL;
const PASSWORD = 'e2e-password-123';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

const reelInfo: YtDlpInfo = {
  title: 'Video by e2eclub',
  description: 'E2E reel',
  uploader: 'e2eclub',
  duration: 2,
  formats: [
    { format_id: 'v', ext: 'mp4', vcodec: 'avc1.64001f', acodec: 'none', width: 320, height: 240, filesize: 50_000 },
    { format_id: 'a', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', filesize: 30_000 },
  ],
};

describe.skipIf(!REDIS_URL)('end-to-end: API + Redis/BullMQ + worker + FFmpeg', () => {
  let root: string;
  let fx: Fixtures;
  let base: string;
  let token: string;
  let downloadFailuresLeft = 0;
  const closers: Array<() => Promise<unknown>> = [];
  let storage: LocalStorage;

  const api = async <T>(path: string, init: RequestInit & { auth?: boolean } = {}): Promise<{ status: number; body: T }> => {
    const { auth = true, ...rest } = init;
    const response = await fetch(`${base}${path}`, {
      ...rest,
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${token}` } : {}), ...(rest.headers ?? {}) },
    });
    return { status: response.status, body: (await response.json().catch(() => null)) as T };
  };

  async function waitForJob(id: string, timeoutMs = 60_000): Promise<{ final: JobView; seen: JobView[] }> {
    const seen: JobView[] = [];
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { body } = await api<JobView>(`/v1/jobs/${id}`);
      seen.push(body);
      if (['completed', 'failed', 'expired'].includes(body.status)) return { final: body, seen };
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`job ${id} did not settle; last: ${JSON.stringify(seen.at(-1))}`);
  }

  async function upload(file: string, name: string, contentType: string): Promise<string> {
    const bytes = await readFile(file);
    const ticket = await api<{ uploadId: string; upload: { url: string; headers: Record<string, string> } }>('/v1/uploads', {
      method: 'POST',
      body: JSON.stringify({ filename: name, size: bytes.length, contentType }),
    });
    expect(ticket.status).toBe(200);
    const put = await fetch(ticket.body.upload.url, { method: 'PUT', body: bytes, headers: ticket.body.upload.headers });
    expect(put.status).toBe(200);
    return ticket.body.uploadId;
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'vd-e2e-'));
    fx = await makeFixtures(join(root, 'fixtures'));

    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const storageDir = join(root, 'storage');
    const config = loadConfig({
      NODE_ENV: 'test',
      ACCESS_PASSWORD: PASSWORD,
      SESSION_SECRET: 'e2e-session-secret-0123456789-abcdefghijkl',
      REDIS_URL,
      STORAGE_LOCAL_DIR: storageDir,
      API_PUBLIC_URL: base,
      WEB_ORIGIN: 'http://localhost:3000',
      JOB_MAX_ATTEMPTS: '2',
    });

    const flusher = createRedisConnection(REDIS_URL!, 'api');
    await flusher.flushdb();
    await flusher.quit();

    storage = new LocalStorage({ dir: storageDir, apiPublicUrl: config.server.apiPublicUrl, signingSecret: config.auth.sessionSecret });

    // Fake yt-dlp: Instagram/TikTok/Facebook resolve to the reel above; YouTube is "blocked" like it is from cloud servers.
    const adapters = createAdapters(config, {
      logger: silentLogger,
      fetchInfo: async (_url, platform) => {
        if (platform === 'youtube') {
          throw new AppError('PLATFORM_API_ERROR', 'YouTube is blocking this server ("confirm you\'re not a bot").', { retryable: false, guidance: ['Run it at home.'] });
        }
        return reelInfo;
      },
    });

    const apiRedis = createRedisConnection(REDIS_URL!, 'api');
    const queue = createMediaQueue(apiRedis);
    const app = await buildApp({ config, queue: new BullJobQueue(queue, config, apiRedis), storage, adapters });
    await app.listen({ host: '127.0.0.1', port });
    closers.push(async () => {
      await app.close();
      await queue.close();
      await apiRedis.quit();
    });

    const workerRedis = createRedisConnection(REDIS_URL!, 'worker');
    const handler = createJobHandler({
      config,
      storage: new LocalStorage({ dir: storageDir }),
      adapters,
      log: createLogger('e2e-worker', 'silent'),
      acquireLink: async (source, _request, dir) => {
        if (downloadFailuresLeft > 0) {
          downloadFailuresLeft -= 1;
          throw new AppError('NETWORK_TIMEOUT', 'Couldn\'t reach Instagram.');
        }
        const path = join(dir, 'input.mp4');
        await copyFile(fx.h264Aac, path);
        return { path, titleHint: 'E2E reel', fallbackName: `${source.platform}-${source.mediaId}` };
      },
    });
    const worker = new Worker<MediaJobData, JobResultRecord>(MEDIA_QUEUE_NAME, (job) => handler(job), { connection: workerRedis, concurrency: 2 });
    await worker.waitUntilReady();
    closers.push(async () => {
      await worker.close();
      await workerRedis.quit();
    });

    const login = await api<{ token: string }>('/v1/auth/login', { method: 'POST', auth: false, body: JSON.stringify({ password: PASSWORD }) });
    expect(login.status).toBe(200);
    token = login.body.token;
  }, 120_000);

  afterAll(async () => {
    for (const close of closers.reverse()) await close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  it('is private: nothing works without signing in', async () => {
    expect((await api('/v1/jobs', { method: 'POST', auth: false, body: '{}' })).status).toBe(401);
    expect((await api('/health/ready', { auth: false })).body).toEqual({ ok: true, redis: true });
  });

  it('link → quality options → MP4 job → working download', async () => {
    const resolved = await api<{ availability: { status: string; options: Array<{ id: string; quality: number | null }> }; metadata: { title: string } }>('/v1/resolve', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://www.instagram.com/reel/E2eReel001/?igsh=abc' }),
    });
    expect(resolved.body.availability.status).toBe('available');
    expect(resolved.body.metadata.title).toBe('E2E reel');
    expect(resolved.body.availability.options.map((o) => o.id)).toEqual(['mp4-240', 'mp3']);

    const created = await api<{ id: string }>('/v1/jobs', {
      method: 'POST',
      body: JSON.stringify({ source: 'url', url: 'https://www.instagram.com/reel/E2eReel001/', format: 'mp4', quality: 240 }),
    });
    expect(created.status).toBe(202);
    const { final, seen } = await waitForJob(created.body.id);
    expect(final.status).toBe('completed');
    expect(seen.some((job) => job.status === 'queued' || job.status === 'processing')).toBe(true);
    expect(final.result).toMatchObject({ filename: 'E2E reel.mp4', resolution: '320×240', losslessVideo: true });

    const download = await fetch(final.result!.download.url);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toContain('E2E%20reel.mp4');
    const file = join(root, 'downloaded.mp4');
    await writeFile(file, Buffer.from(await download.arrayBuffer()));
    expect((await probeFile(file, { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' })).video?.codec).toBe('h264');

    // When the file is cleaned up the job reports `expired` and the old link dies with 410.
    await storage.delete(`outputs/${created.body.id}/output.mp4`);
    expect((await api<JobView>(`/v1/jobs/${created.body.id}`)).body.status).toBe('expired');
    expect((await fetch(final.result!.download.url)).status).toBe(410);
  }, 90_000);

  it('retries a transient download failure with back-off and then succeeds', async () => {
    downloadFailuresLeft = 1;
    const created = await api<{ id: string }>('/v1/jobs', {
      method: 'POST',
      body: JSON.stringify({ source: 'url', url: 'https://www.tiktok.com/@e2eclub/video/7707305867162570017', format: 'mp3' }),
    });
    const { final, seen } = await waitForJob(created.body.id, 90_000);
    expect(final.status).toBe('completed');
    expect(final.result?.format).toBe('mp3');
    expect(Math.max(...seen.map((job) => job.attempt))).toBe(2);
    expect(downloadFailuresLeft).toBe(0);
  }, 120_000);

  it('converts an uploaded file to MP3 and consumes the upload', async () => {
    const uploadId = await upload(fx.h264Aac, 'Family Trip.mp4', 'video/mp4');
    const created = await api<{ id: string }>('/v1/jobs', {
      method: 'POST',
      body: JSON.stringify({ source: 'upload', uploadId, format: 'mp3', filename: 'Family Trip.mp4' }),
    });
    const { final } = await waitForJob(created.body.id);
    expect(final.status).toBe('completed');
    expect(final.result).toMatchObject({ filename: 'Family Trip.mp3', format: 'mp3' });
    expect(await storage.head(`uploads/${uploadId}`)).toBeNull();
  }, 60_000);

  it('fails fast (no retries) for files that are not media', async () => {
    const uploadId = await upload(fx.notMedia, 'notes.mp4', 'video/mp4');
    const created = await api<{ id: string }>('/v1/jobs', { method: 'POST', body: JSON.stringify({ source: 'upload', uploadId, format: 'mp4' }) });
    const { final } = await waitForJob(created.body.id);
    expect(final.status).toBe('failed');
    expect(final.error).toMatchObject({ code: 'UNSUPPORTED_MEDIA', retryable: false });
    expect(final.attempt).toBe(1);
  }, 60_000);

  it('explains a blocked platform instead of creating a doomed job', async () => {
    const resolved = await api<{ availability: { status: string; reason: { message: string; guidance: string[] } } }>('/v1/resolve', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=69IQ8q-g1q0' }),
    });
    expect(resolved.body.availability).toMatchObject({ status: 'unavailable', reason: { message: expect.stringMatching(/blocking this server/) } });
    const created = await api<{ error: { code: string } }>('/v1/jobs', {
      method: 'POST',
      body: JSON.stringify({ source: 'url', url: 'https://www.youtube.com/watch?v=69IQ8q-g1q0', format: 'mp4' }),
    });
    expect(created.status).toBeGreaterThanOrEqual(400);
  });

  it('rejects SSRF attempts at the API edge', async () => {
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://localhost:6399/', 'file:///etc/passwd']) {
      const response = await api<{ error: { code: string } }>('/v1/jobs', { method: 'POST', body: JSON.stringify({ source: 'url', url, format: 'mp4' }) });
      expect(response.status).toBe(400);
    }
  });
});
