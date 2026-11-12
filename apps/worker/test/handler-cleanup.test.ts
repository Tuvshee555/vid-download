import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnrecoverableError } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@vd/shared';
import { LocalStorage, decodeFailure, loadConfig, outputKey, silentLogger, uploadKey, type MediaJobData } from '@vd/core';
import { createJobHandler, createProgressReporter, toAppError } from '../src/processors/handler';
import { sweepExpiredObjects } from '../src/services/cleanup';
import { createWorkspace, sweepStaleWorkspaces } from '../src/services/workspace';

vi.mock('../src/processors/media-job', () => ({ processMediaJob: vi.fn() }));
import { processMediaJob } from '../src/processors/media-job';
const mockedProcess = vi.mocked(processMediaJob);

const data: MediaJobData = {
  source: { kind: 'upload', uploadId: '11111111-2222-4333-8444-555555555555', originalName: 'a.mp4' },
  format: 'mp3',
  createdAt: new Date().toISOString(),
};

function fakeJob(overrides: { attemptsMade?: number; attempts?: number } = {}) {
  const updates: unknown[] = [];
  return {
    updates,
    job: {
      id: 'job-handler-1',
      data,
      attemptsMade: overrides.attemptsMade ?? 0,
      opts: { attempts: overrides.attempts ?? 2 },
      updateProgress: vi.fn(async (value: unknown) => void updates.push(value)),
    },
  };
}

const handlerDeps = () => ({
  config: loadConfig({ NODE_ENV: 'test' }),
  storage: new LocalStorage({ dir: tmpdir() }),
  adapters: {} as never,
  log: silentLogger,
});

describe('job handler & retry policy', () => {
  beforeEach(() => mockedProcess.mockReset());

  it('returns the result record on success', async () => {
    const record = { storageKey: 'outputs/x/output.mp3' } as never;
    mockedProcess.mockResolvedValueOnce(record);
    const { job } = fakeJob();
    await expect(createJobHandler(handlerDeps())(job)).resolves.toBe(record);
  });

  it('fails permanently (no retry) for non-retryable errors and preserves the structured reason', async () => {
    mockedProcess.mockRejectedValueOnce(new AppError('UNSUPPORTED_MEDIA', 'No audio track.'));
    const { job } = fakeJob();
    const error = await createJobHandler(handlerDeps())(job).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(decodeFailure((error as Error).message)).toEqual({ code: 'UNSUPPORTED_MEDIA', message: 'No audio track.', retryable: false });
  });

  it('lets BullMQ retry transient errors (plain Error, structured reason intact)', async () => {
    mockedProcess.mockRejectedValueOnce(new AppError('NETWORK_TIMEOUT'));
    const { job } = fakeJob();
    const error = await createJobHandler(handlerDeps())(job).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect(decodeFailure((error as Error).message)).toMatchObject({ code: 'NETWORK_TIMEOUT', retryable: true });
  });

  it('wraps unexpected exceptions as a retryable INTERNAL error and never leaks the raw message', async () => {
    mockedProcess.mockRejectedValueOnce(new Error('ECONNRESET at /srv/app/secret/path.js:12'));
    const { job } = fakeJob();
    const error = await createJobHandler(handlerDeps())(job).catch((e: unknown) => e);
    const failure = decodeFailure((error as Error).message);
    expect(failure).toMatchObject({ code: 'INTERNAL', retryable: true });
    expect(failure.message).not.toContain('/srv/app');
    expect(toAppError('boom')).toBeInstanceOf(AppError);
  });

  it('passes the attempt count through (second attempt of two)', async () => {
    mockedProcess.mockResolvedValueOnce({} as never);
    const { job } = fakeJob({ attemptsMade: 1, attempts: 2 });
    await createJobHandler(handlerDeps())(job);
    expect(mockedProcess).toHaveBeenCalledOnce();
  });
});

describe('progress reporter', () => {
  it('writes on stage change, and otherwise only for ≥1 point and ≥400 ms steps', async () => {
    let now = 0;
    const { job, updates } = fakeJob();
    const report = createProgressReporter(job, () => now);

    await report('downloading', 5);
    now = 100;
    await report('downloading', 6); // too soon
    now = 500;
    await report('downloading', 5.2); // < 1 point
    await report('downloading', 9); // ok
    now = 600;
    await report('converting', 50); // stage change always goes through
    await report('converting', 150); // clamped
    now = 2000;
    await report('converting', 150);

    expect(updates).toEqual([
      { stage: 'downloading', percent: 5 },
      { stage: 'downloading', percent: 9 },
      { stage: 'converting', percent: 50 },
      { stage: 'converting', percent: 100 },
    ]);
  });

  it('never lets a Redis write failure break the job', async () => {
    const report = createProgressReporter({ updateProgress: async () => Promise.reject(new Error('redis')) });
    await expect(report('probing', 47)).resolves.toBeUndefined();
  });
});

describe('storage expiry sweep', () => {
  let dir: string;
  let storage: LocalStorage;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vd-sweep-test-'));
    storage = new LocalStorage({ dir });
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  async function put(key: string, ageMs: number): Promise<void> {
    const file = storage.pathFor(key);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, 'x');
    const when = new Date(Date.now() - ageMs);
    await utimes(file, when, when);
  }
  const minutes = (n: number) => n * 60_000;
  const ID = (n: number) => `aaaaaaaa-0000-4000-8000-00000000000${n}`;

  it('deletes expired outputs and uploads, keeps fresh ones', async () => {
    await put(outputKey(ID(1), 'mp4'), minutes(90)); // expired (ttl 60)
    await put(outputKey(ID(2), 'mp3'), minutes(10)); // fresh
    await put(uploadKey(ID(3)), minutes(200)); // expired
    await put(uploadKey(ID(4)), minutes(70)); // older than output ttl but within the upload grace
    const result = await sweepExpiredObjects(storage, minutes(60), silentLogger);

    expect(result).toEqual({ deleted: 2, failed: 0 });
    expect(await storage.head(outputKey(ID(1), 'mp4'))).toBeNull();
    expect(await storage.head(outputKey(ID(2), 'mp3'))).not.toBeNull();
    expect(await storage.head(uploadKey(ID(3)))).toBeNull();
    expect(await storage.head(uploadKey(ID(4)))).not.toBeNull();
    await expect(stat(join(dir, 'outputs', ID(1)))).rejects.toMatchObject({ code: 'ENOENT' }); // empty job dir removed
  });

  it('removes abandoned partial uploads', async () => {
    const partial = `${storage.pathFor(uploadKey(ID(5)))}.part`;
    await mkdir(join(partial, '..'), { recursive: true });
    await writeFile(partial, 'half an upload');
    const old = new Date(Date.now() - minutes(300));
    await utimes(partial, old, old);
    const result = await sweepExpiredObjects(storage, minutes(60), silentLogger);
    expect(result.deleted).toBe(1);
    await expect(stat(partial)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does nothing on an empty store', async () => {
    expect(await sweepExpiredObjects(storage, minutes(60), silentLogger)).toEqual({ deleted: 0, failed: 0 });
  });
});

describe('workspaces', () => {
  it('creates a private directory and removes it on dispose', async () => {
    const workspace = await createWorkspace();
    await writeFile(workspace.path('x.bin'), 'data');
    expect((await stat(workspace.dir)).isDirectory()).toBe(true);
    await workspace.dispose();
    await expect(stat(workspace.dir)).rejects.toMatchObject({ code: 'ENOENT' });
    await workspace.dispose(); // idempotent
  });

  it('sweeps only stale job workspaces', async () => {
    const stale = await createWorkspace();
    const fresh = await createWorkspace();
    const old = new Date(Date.now() - 5 * 3600_000);
    await utimes(stale.dir, old, old);
    const unrelated = await mkdtemp(join(tmpdir(), 'not-ours-'));
    await utimes(unrelated, old, old);
    try {
      expect(await sweepStaleWorkspaces(2 * 3600_000)).toBeGreaterThanOrEqual(1);
      await expect(stat(stale.dir)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await stat(fresh.dir)).isDirectory()).toBe(true);
      expect((await stat(unrelated)).isDirectory()).toBe(true);
    } finally {
      await fresh.dispose();
      await rm(unrelated, { recursive: true, force: true });
    }
  });
});
