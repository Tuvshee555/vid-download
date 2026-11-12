import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { vi } from 'vitest';
import {
  LocalStorage,
  createAdapters,
  loadConfig,
  silentLogger,
  type HttpClient,
  type JsonResponse,
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

type Route = (url: URL) => JsonResponse | Promise<JsonResponse>;

export function fakeHttp(route: Route): HttpClient {
  return {
    getJson: vi.fn(async (url: string) => route(new URL(url))),
    headContentLength: vi.fn(async () => 2_000_000),
  };
}

export const defaultHttp = fakeHttp((url) => {
  if (url.pathname === '/oembed') {
    return { status: 200, body: { title: 'Some video', author_name: 'Some channel', thumbnail_url: 'https://i.ytimg.com/vi/x/hq.jpg' } };
  }
  if (url.hostname === 'graph.instagram.com') {
    if (url.pathname.endsWith('/me')) return { status: 200, body: { username: 'myshop' } };
    return {
      status: 200,
      body: {
        data: [
          {
            id: '1',
            caption: 'Launch day',
            media_type: 'VIDEO',
            media_url: 'https://scontent.cdninstagram.com/v/a.mp4',
            permalink: 'https://www.instagram.com/reel/Cabc123XYZ/',
          },
        ],
      },
    };
  }
  return { status: 404, body: null };
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
  http: HttpClient = defaultHttp,
): Promise<TestContext> {
  const dir = await mkdtemp(join(tmpdir(), 'vd-api-test-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    ACCESS_PASSWORD: TEST_PASSWORD,
    SESSION_SECRET: TEST_SECRET,
    WEB_ORIGIN,
    API_PUBLIC_URL: 'http://api.test',
    STORAGE_LOCAL_DIR: dir,
    INSTAGRAM_ACCESS_TOKEN: 'ig-token',
    ...env,
  });
  const queue = new InMemoryJobQueue();
  const storage = new LocalStorage({ dir, apiPublicUrl: config.server.apiPublicUrl, signingSecret: config.auth.sessionSecret });
  const adapters = createAdapters(config, { http, logger: silentLogger });
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
