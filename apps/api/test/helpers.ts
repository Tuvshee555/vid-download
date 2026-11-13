import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { vi } from 'vitest';
import { AppError } from '@vd/shared';
import {
  LocalStorage,
  createAdapters,
  loadConfig,
  silentLogger,
  type InfoFetcher,
  type YtDlpInfo,
  type MediaJobData,
} from '@vd/core';
import { buildApp } from '../src/app';
import type { JobQueue, JobRecord } from '../src/services/job-queue';

export const TEST_PASSWORD = 'correct horse battery staple';
export const TEST_SECRET = 'api-test-secret-0123456789-abcdefghijklmnop';
export const WEB_ORIGIN = 'https://app.example.test';

export class InMemoryJobQueue implements JobQueue {
  readonly jobs = new Map<string, JobRecord>();
  failAdd = false;
  failGet = false;

  async add(id: string, data: MediaJobData): Promise<void> {
    if (this.failAdd) throw new Error('redis down');
    this.jobs.set(id, {
      id,
      state: 'waiting',
      data,
      progress: 0,
      returnValue: null,
      failedReason: undefined,
      attemptsMade: 0,
      maxAttempts: 2,
      createdAtMs: Date.now(),
    });
  }

  async get(id: string): Promise<JobRecord | null> {
    if (this.failGet) throw new Error('redis down');
    return this.jobs.get(id) ?? null;
  }

  async ping(): Promise<boolean> {
    return !this.failGet;
  }

  patch(id: string, patch: Partial<JobRecord>): void {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`no job ${id}`);
    this.jobs.set(id, { ...job, ...patch });
  }
}

/** Realistic `yt-dlp -J` output, trimmed. */
export const reelInfo: YtDlpInfo = {
  title: 'Video by myshop',
  description: 'Launch day',
  uploader: 'myshop',
  duration: 21,
  formats: [
    { format_id: 'v720', ext: 'mp4', vcodec: 'avc1.64001f', acodec: 'none', width: 720, height: 1280, filesize: 5_000_000 },
    { format_id: 'v360', ext: 'mp4', vcodec: 'avc1.4d401e', acodec: 'none', width: 360, height: 640, filesize: 1_500_000 },
    { format_id: 'a', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', filesize: 300_000 },
  ],
};

/** Fake yt-dlp: a known reel, a private one, and YouTube's metadata. */
export const defaultFetchInfo: InfoFetcher = vi.fn(async (url: string) => {
  if (url.includes('NotMyReel99')) throw new AppError('PRIVATE_CONTENT', 'This Instagram video is private, age-restricted, region-locked or needs a login, so it can’t be downloaded.');
  if (url.includes('youtube.com')) return { ...reelInfo, title: 'Some video', uploader: 'Some channel', description: null };
  return reelInfo;
});

export interface TestContext {
  app: FastifyInstance;
  queue: InMemoryJobQueue;
  storage: LocalStorage;
  dir: string;
  token: string;
  auth: { authorization: string };
  cleanup(): Promise<void>;
  writeOutput(jobId: string, content: Buffer, ext?: 'mp4' | 'mp3'): Promise<string>;
}

export async function createTestContext(
  env: Record<string, string> = {},
  fetchInfo: InfoFetcher = defaultFetchInfo,
): Promise<TestContext> {
  const dir = await mkdtemp(join(tmpdir(), 'vd-api-test-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    ACCESS_PASSWORD: TEST_PASSWORD,
    SESSION_SECRET: TEST_SECRET,
    WEB_ORIGIN,
    API_PUBLIC_URL: 'http://api.test',
    STORAGE_LOCAL_DIR: dir,
    ...env,
  });
  const queue = new InMemoryJobQueue();
  const storage = new LocalStorage({ dir, apiPublicUrl: config.server.apiPublicUrl, signingSecret: config.auth.sessionSecret });
  const adapters = createAdapters(config, { fetchInfo, logger: silentLogger });
  const app = await buildApp({ config, queue, storage, adapters });
  await app.ready();

  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { password: TEST_PASSWORD } });
  const token = (login.json() as { token: string }).token;

  return {
    app,
    queue,
    storage,
    dir,
    token,
    auth: { authorization: `Bearer ${token}` },
    async cleanup() {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    },
    async writeOutput(jobId, content, ext = 'mp4') {
      const source = join(dir, `src-${jobId}.bin`);
      await writeFile(source, content);
      const key = `outputs/${jobId}/output.${ext}`;
      await storage.putFile(key, source, { contentType: ext === 'mp4' ? 'video/mp4' : 'audio/mpeg' });
      return key;
    },
  };
}
