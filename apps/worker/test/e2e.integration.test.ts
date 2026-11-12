/**
 * End-to-end test of the real system: HTTP API + Redis/BullMQ + worker handler + FFmpeg +
 * storage, driven over actual HTTP exactly like the browser does.
 *
 * Needs a Redis: run with E2E_REDIS_URL=redis://127.0.0.1:6379/15 (the DB is flushed!).
 * Skipped otherwise so `npm test` stays hermetic.
 */
import { createServer, type Server } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JobResultRecord, JobView } from '@vd/shared';
import {
  LocalStorage,
  MEDIA_QUEUE_NAME,
  UNSAFE_allowLoopbackGuard,
  createAdapters,
  createLogger,
  createMediaQueue,
  createRedisConnection,
  downloadToFile,
  loadConfig,
  silentLogger,
  type AdapterRegistry,
  type HttpClient,
  type MediaJobData,
  type PlatformAdapter,
} from '@vd/core';
import { buildApp } from '../../api/src/app';
import { BullJobQueue } from '../../api/src/services/job-queue';
import { createJobHandler } from '../src/processors/handler';
import { probeFile } from '../src/services/ffmpeg';
import { makeFixtures, type Fixtures } from './fixtures';

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

describe.skipIf(!REDIS_URL)('end-to-end: API + Redis/BullMQ + worker + FFmpeg', () => {
  let root: string;
  let fx: Fixtures;
  let cdn: Server;
  let cdnUrl: string;
  let cdnFailuresLeft = 0;
  let base: string;
  let token: string;
  const closers: Array<() => Promise<unknown>> = [];
  let storage: LocalStorage;

  const api = async <T>(path: string, init: RequestInit & { auth?: boolean } = {}): Promise<{ status: number; body: T; headers: Headers }> => {
    const { auth = true, ...rest } = init;
    const response = await fetch(`${base}${path}`, {
      ...rest,
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${token}` } : {}), ...(rest.headers ?? {}) },
    });
    return { status: response.status, body: (await response.json().catch(() => null)) as T, headers: response.headers };
  };

  async function waitForJob(id: string, until: (job: JobView) => boolean, timeoutMs = 60_000): Promise<{ final: JobView; seen: JobView[] }> {
    const seen: JobView[] = [];
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { body } = await api<JobView>(`/v1/jobs/${id}`);
      seen.push(body);
      if (until(body)) return { final: body, seen };
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`job ${id} did not settle; last: ${JSON.stringify(seen.at(-1))}`);
  }
  const terminal = (job: JobView) => ['completed', 'failed', 'expired'].includes(job.status);

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

    // A stand-in for Instagram's CDN, optionally failing the first N requests with 503 (retry test).
    cdn = createServer((req, res) => {
      if (cdnFailuresLeft > 0) {
        cdnFailuresLeft -= 1;
        res.writeHead(503).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'video/mp4' });
      createReadStream(fx.h264Aac).pipe(res);
    });
    await new Promise<void>((resolve) => cdn.listen(0, '127.0.0.1', resolve));
    cdnUrl = `http://127.0.0.1:${(cdn.address() as AddressInfo).port}`;
    closers.push(() => new Promise<void>((resolve) => cdn.close(() => resolve())));

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
      INSTAGRAM_ACCESS_TOKEN: 'e2e-ig-token',
      JOB_MAX_ATTEMPTS: '2',
    });

    // Clean slate.
    const flusher = createRedisConnection(REDIS_URL!, 'api');
    await flusher.flushdb();
    await flusher.quit();

    storage = new LocalStorage({ dir: storageDir, apiPublicUrl: config.server.apiPublicUrl, signingSecret: config.auth.sessionSecret });

    // Platform "network": the connected Instagram account owns exactly one reel, served by the CDN stand-in.
    const http: HttpClient = {
      getJson: async (url: string) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith('/me')) return { status: 200, body: { username: 'e2eshop' } };
        return {
          status: 200,
          body: {
            data: [
              {
                id: '1',
                caption: 'E2E reel',
                media_type: 'VIDEO',
                media_url: `${cdnUrl}/video.mp4`,
                permalink: 'https://www.instagram.com/reel/E2eReel001/',
              },
            ],
          },
        };
      },
      headContentLength: async () => 12345,
    };
    const real = createAdapters(config, { http, logger: silentLogger });
    // Test-only: let the (loopback) CDN stand-in pass the media host allowlist.
    const instagram: PlatformAdapter = Object.create(real.instagram, {
      getSource: {
        value: async (...args: Parameters<PlatformAdapter['getSource']>) => ({ ...(await real.instagram.getSource(...args)), allowedHostSuffixes: ['127.0.0.1'] }),
      },
    });
    const adapters: AdapterRegistry = { ...real, instagram };

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
      download: (url, dest, options) => downloadToFile(url, dest, { ...options, guard: UNSAFE_allowLoopbackGuard }),
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

  it('converts an uploaded video to MP3 and serves a working, expiring download', async () => {
    const uploadId = await upload(fx.h264Aac, 'Family Trip.mp4', 'video/mp4');
    const created = await api<{ id: string; status: string }>('/v1/jobs', {
      method: 'POST',
      body: JSON.stringify({ source: 'upload', uploadId, format: 'mp3', filename: 'Family Trip.mp4' }),
    });
    expect(created.status).toBe(202);
    expect(created.body.status).toBe('queued');

    const { final, seen } = await waitForJob(created.body.id, terminal);
    expect(final.status).toBe('completed');
    expect(seen.some((job) => job.status === 'queued' || job.status === 'processing')).toBe(true);
    expect(final.result).toMatchObject({ filename: 'Family Trip.mp3', format: 'mp3', mimeType: 'audio/mpeg' });

    const download = await fetch(final.result!.download.url);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toContain('Family%20Trip.mp3');
    const bytes = Buffer.from(await download.arrayBuffer());
    expect(bytes.length).toBe(final.result!.sizeBytes);

    const file = join(root, 'downloaded.mp3');
    await writeFile(file, bytes);
    const probe = await probeFile(file, { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' });
    expect(probe.audio?.codec).toBe('mp3');
    expect(probe.video).toBeNull();
    expect(probe.durationSeconds).toBeGreaterThan(1.5);

    // The upload was consumed.
    expect(await storage.head(`uploads/${uploadId}`)).toBeNull();

    // When the file is cleaned up, the job reports `expired` and the old link dies with 410.
    await storage.delete(final.result!.download.url.includes('/v1/files/') ? `outputs/${created.body.id}/output.mp3` : '');
    const afterCleanup = await api<JobView>(`/v1/jobs/${created.body.id}`);
    expect(afterCleanup.body.status).toBe('expired');
    expect((await fetch(final.result!.download.url)).status).toBe(410);
  }, 90_000);

  it('processes an authorised Instagram reel end to end, copying the H.264 stream untouched', async () => {
    const resolved = await api<{ availability: { status: string; options: Array<{ format: string; sizeBytes: number | null }> }; metadata: { title: string } }>('/v1/resolve', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://www.instagram.com/reel/E2eReel001/?igsh=abc' }),
    });
    expect(resolved.body.availability.status).toBe('available');
    expect(resolved.body.metadata.title).toBe('E2E reel');
    expect(resolved.body.availability.options[0]?.sizeBytes).toBe(12345);

    const created = await api<{ id: string }>('/v1/jobs', {
      method: 'POST',
      body: JSON.stringify({ source: 'url', url: 'https://www.instagram.com/reel/E2eReel001/', format: 'mp4' }),
    });
    expect(created.status).toBe(202);
    const { final } = await waitForJob(created.body.id, terminal);
    expect(final.status).toBe('completed');
    expect(final.result).toMatchObject({ filename: 'E2E reel.mp4', resolution: '320×240', losslessVideo: true });
    expect((await fetch(final.result!.download.url)).status).toBe(200);
  }, 90_000);

  it('retries a transient platform failure with back-off and then succeeds', async () => {
    cdnFailuresLeft = 1; // first download attempt gets a 503
    const created = await api<{ id: string }>('/v1/jobs', {
      method: 'POST',
      body: JSON.stringify({ source: 'url', url: 'https://www.instagram.com/reel/E2eReel001/', format: 'mp3' }),
    });
    const { final, seen } = await waitForJob(created.body.id, terminal, 90_000);
    expect(final.status).toBe('completed');
    expect(Math.max(...seen.map((job) => job.attempt))).toBe(2); // it really did take a second attempt
    expect(cdnFailuresLeft).toBe(0);
  }, 120_000);

  it('fails fast (no retries) with a precise reason for files that are not media', async () => {
    const uploadId = await upload(fx.notMedia, 'notes.mp4', 'video/mp4');
    const created = await api<{ id: string }>('/v1/jobs', { method: 'POST', body: JSON.stringify({ source: 'upload', uploadId, format: 'mp4' }) });
    const { final } = await waitForJob(created.body.id, terminal);
    expect(final.status).toBe('failed');
    expect(final.error).toMatchObject({ code: 'UNSUPPORTED_MEDIA', retryable: false });
    expect(final.attempt).toBe(1);
  }, 60_000);

  it('never creates a job for YouTube: no permitted download route', async () => {
    const created = await api<{ error: { code: string; guidance?: string[] } }>('/v1/jobs', {
      method: 'POST',
      body: JSON.stringify({ source: 'url', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', format: 'mp4' }),
    });
    expect(created.status).toBe(403);
    expect(created.body.error.code).toBe('UNAUTHORIZED_SOURCE');
    expect(created.body.error.guidance?.length).toBeGreaterThan(0);
  });

  it('rejects SSRF attempts at the API edge', async () => {
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://localhost:6399/', 'file:///etc/passwd']) {
      const response = await api<{ error: { code: string } }>('/v1/jobs', { method: 'POST', body: JSON.stringify({ source: 'url', url, format: 'mp4' }) });
      expect(response.status).toBe(400);
    }
  });
});
