import { copyFile, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppError, type JobStage } from '@vd/shared';
import {
  LocalStorage,
  createAdapters,
  loadConfig,
  probeFile,
  silentLogger,
  uploadKey,
  type AppConfig,
  type MediaJobData,
} from '@vd/core';
import { makeFixtures, type Fixtures } from '../../../packages/core/src/media/test-fixtures';
import { processMediaJob, type ProcessorDeps } from '../src/processors/media-job';

const UPLOAD_ID = '11111111-2222-4333-8444-555555555555';

describe('processMediaJob', () => {
  let root: string;
  let fx: Fixtures;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'vd-job-test-root-'));
    fx = await makeFixtures(join(root, 'fixtures'));
  }, 120_000);

  afterAll(() => rm(root, { recursive: true, force: true }));

  async function setup(env: Record<string, string> = {}, acquireLink?: ProcessorDeps['acquireLink']) {
    const storageDir = await mkdtemp(join(root, 'store-'));
    const config: AppConfig = loadConfig({ NODE_ENV: 'test', STORAGE_LOCAL_DIR: storageDir, ...env });
    const storage = new LocalStorage({ dir: storageDir });
    const stages: Array<[JobStage, number]> = [];
    const deps: ProcessorDeps = {
      config,
      storage,
      adapters: createAdapters(config, { fetchInfo: async () => ({}) }),
      log: silentLogger,
      ...(acquireLink ? { acquireLink } : {}),
    };
    const report = (stage: JobStage, percent: number) => void stages.push([stage, percent]);
    const putUpload = async (file: string, id = UPLOAD_ID) => {
      await storage.putFile(uploadKey(id), file, { contentType: 'application/octet-stream' });
    };
    return { config, storage, deps, stages, report, putUpload, storageDir };
  }

  const uploadJob = (format: 'mp4' | 'mp3', originalName = 'My Holiday.mp4'): MediaJobData => ({
    source: { kind: 'upload', uploadId: UPLOAD_ID, originalName },
    format,
    createdAt: new Date().toISOString(),
  });

  const leftoverWorkspaces = async () => (await readdir(tmpdir())).filter((name) => name.startsWith('vd-job-') && !name.startsWith('vd-job-test-')).length;

  it('converts an uploaded video to MP3, stores it, deletes the upload and cleans up', async () => {
    const before = await leftoverWorkspaces();
    const ctx = await setup();
    await ctx.putUpload(fx.h264Aac);

    const result = await processMediaJob('job-a1b2c3d4', uploadJob('mp3'), ctx.deps, ctx.report);

    expect(result).toMatchObject({
      storageKey: 'outputs/job-a1b2c3d4/output.mp3',
      filename: 'My Holiday.mp3',
      format: 'mp3',
      mimeType: 'audio/mpeg',
      resolution: null,
      losslessVideo: null,
    });
    expect(result.sizeBytes).toBeGreaterThan(10_000);
    expect(result.durationSeconds).toBeGreaterThan(1.5);
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now() + 50 * 60_000);
    expect((await ctx.storage.head(result.storageKey))?.size).toBe(result.sizeBytes);
    expect(await ctx.storage.head(uploadKey(UPLOAD_ID))).toBeNull();
    expect(await leftoverWorkspaces()).toBe(before);

    const percents = ctx.stages.map(([, percent]) => percent);
    expect(ctx.stages.map(([stage]) => stage)).toEqual(expect.arrayContaining(['resolving', 'downloading', 'probing', 'converting', 'uploading']));
    expect([...percents].sort((a, b) => a - b)).toEqual(percents);
  });

  it('keeps the original H.264 stream for MP4 and reports the real resolution', async () => {
    const ctx = await setup();
    await ctx.putUpload(fx.h264Aac);
    const result = await processMediaJob('job-lossless1', uploadJob('mp4', 'clip.mp4'), ctx.deps, ctx.report);
    expect(result).toMatchObject({ filename: 'clip.mp4', resolution: '320×240', losslessVideo: true, mimeType: 'video/mp4' });
  });

  it('transcodes when it must and says so (losslessVideo false)', async () => {
    const ctx = await setup();
    await ctx.putUpload(fx.vp9Opus);
    const result = await processMediaJob('job-transcode1', uploadJob('mp4', 'web.webm'), ctx.deps, ctx.report);
    expect(result).toMatchObject({ filename: 'web.mp4', losslessVideo: false, resolution: '320×240' });
  });

  it('works without ffprobe (serverless mode) too', async () => {
    const ctx = await setup({ FFPROBE_PATH: 'none' });
    await ctx.putUpload(fx.vp9Opus);
    const result = await processMediaJob('job-noprobe01', uploadJob('mp4', 'web.webm'), ctx.deps, ctx.report);
    expect(result).toMatchObject({ losslessVideo: false, resolution: '320×240' });
  });

  it('rejects the wrong kind of media with a clear reason', async () => {
    const ctx = await setup();
    await ctx.putUpload(fx.audioOnlyM4a);
    await expect(processMediaJob('job-audio-mp4', uploadJob('mp4', 'song.m4a'), ctx.deps, ctx.report)).rejects.toMatchObject({
      code: 'UNSUPPORTED_MEDIA',
      message: expect.stringMatching(/no video track/i),
    });
    const silent = await setup();
    await silent.putUpload(fx.videoOnly);
    await expect(processMediaJob('job-silent-mp3', uploadJob('mp3', 'silent.mp4'), silent.deps, silent.report)).rejects.toMatchObject({
      code: 'UNSUPPORTED_MEDIA',
      message: expect.stringMatching(/no audio track/i),
    });
  });

  it('rejects non-media and image uploads and leaves nothing behind', async () => {
    const before = await leftoverWorkspaces();
    for (const file of [fx.notMedia, fx.png]) {
      const ctx = await setup();
      await ctx.putUpload(file);
      await expect(processMediaJob('job-notmedia1', uploadJob('mp3', 'x.mp4'), ctx.deps, ctx.report)).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' });
      expect(await ctx.storage.head('outputs/job-notmedia1/output.mp3')).toBeNull();
    }
    expect(await leftoverWorkspaces()).toBe(before);
  });

  it('enforces duration, size and time limits', async () => {
    const long = await setup({ MAX_DURATION_MINUTES: '0.01' });
    await long.putUpload(fx.h264Aac);
    await expect(processMediaJob('job-too-long1', uploadJob('mp3'), long.deps, long.report)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });

    const big = await setup({ MAX_INPUT_MB: '0.001' });
    await big.putUpload(fx.h264Aac);
    await expect(processMediaJob('job-too-big001', uploadJob('mp3'), big.deps, big.report)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });

    const slow = await setup({ PROCESSING_TIMEOUT_MINUTES: '0.0001' });
    await slow.putUpload(fx.vp9Opus);
    await expect(processMediaJob('job-timeout01', uploadJob('mp4', 'a.webm'), slow.deps, slow.report)).rejects.toMatchObject({ code: 'PROCESSING_FAILED', retryable: false });
  });

  it('reports a missing upload as NOT_FOUND', async () => {
    const ctx = await setup();
    await expect(processMediaJob('job-missing01', uploadJob('mp3'), ctx.deps, ctx.report)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  describe('link source (yt-dlp download → convert)', () => {
    const linkJob = (format: 'mp4' | 'mp3', quality: number | null = null): MediaJobData => ({
      source: { kind: 'platform', platform: 'tiktok', canonicalUrl: 'https://www.tiktok.com/@realmadrid/video/7707305867162570017', mediaId: '7707305867162570017' },
      format,
      quality,
      createdAt: new Date().toISOString(),
    });

    /** Stands in for yt-dlp: "downloads" a fixture into the job's workspace. */
    const fakeAcquire = (fixture: () => string, title: string | null) =>
      vi.fn<NonNullable<ProcessorDeps['acquireLink']>>(async (source, _request, dir) => {
        const path = join(dir, 'input.mp4');
        await copyFile(fixture(), path);
        return { path, titleHint: title, fallbackName: `${source.platform}-${source.mediaId}` };
      });

    it('downloads with the requested quality, names the file after the post and keeps H.264 untouched', async () => {
      const acquire = fakeAcquire(() => fx.h264Aac, 'Another training session completed! #RealMadrid');
      const ctx = await setup({}, acquire);
      const result = await processMediaJob('job-link00001', linkJob('mp4', 720), ctx.deps, ctx.report);
      expect(acquire).toHaveBeenCalledWith(
        expect.objectContaining({ platform: 'tiktok', canonicalUrl: 'https://www.tiktok.com/@realmadrid/video/7707305867162570017' }),
        { format: 'mp4', quality: 720 },
        expect.any(String),
        expect.any(Object),
        expect.any(Function),
      );
      expect(result).toMatchObject({ filename: 'Another training session completed! #RealMadrid.mp4', losslessVideo: true });
      expect((await ctx.storage.head(result.storageKey))?.size).toBe(result.sizeBytes);
    });

    it('never passes a quality for MP3', async () => {
      const acquire = fakeAcquire(() => fx.h264Aac, 'x');
      const ctx = await setup({}, acquire);
      await processMediaJob('job-link00002', linkJob('mp3', 720), ctx.deps, ctx.report);
      expect(acquire.mock.calls[0]?.[1]).toEqual({ format: 'mp3', quality: null });
    });

    it('falls back to a platform-based file name when there is no title', async () => {
      const ctx = await setup({}, fakeAcquire(() => fx.h264Aac, null));
      const result = await processMediaJob('job-link00003', linkJob('mp4'), ctx.deps, ctx.report);
      expect(result.filename).toBe('tiktok-7707305867162570017.mp4');
    });

    it('re-encodes non-H.264 downloads (e.g. Facebook VP9) so the MP4 plays everywhere', async () => {
      const ctx = await setup({}, fakeAcquire(() => fx.vp9Opus, 'Facebook clip'));
      const result = await processMediaJob('job-link00004', linkJob('mp4'), ctx.deps, ctx.report);
      expect(result.losslessVideo).toBe(false);
      const copy = join(ctx.storageDir, 'check.mp4');
      await copyFile(ctx.storage.pathFor(result.storageKey), copy);
      expect((await probeFile(copy, ctx.config.ffmpeg)).video?.codec).toBe('h264');
    });

    it('propagates download refusals (e.g. YouTube blocking the server) untouched', async () => {
      const blocked = new AppError('PLATFORM_API_ERROR', 'YouTube is blocking this server', { retryable: false });
      const ctx = await setup({}, vi.fn(async () => Promise.reject(blocked)));
      await expect(processMediaJob('job-link00005', linkJob('mp4'), ctx.deps, ctx.report)).rejects.toBe(blocked);
      expect(await ctx.storage.head('outputs/job-link00005/output.mp4')).toBeNull();
    });
  });

  it('produces files that really are what they claim to be', async () => {
    const ctx = await setup();
    await ctx.putUpload(fx.h264Aac);
    const result = await processMediaJob('job-verify0001', uploadJob('mp4', 'v.mp4'), ctx.deps, ctx.report);
    const copy = join(ctx.storageDir, 'verify.mp4');
    await copyFile(ctx.storage.pathFor(result.storageKey), copy);
    expect((await stat(copy)).size).toBe(result.sizeBytes);
    const probe = await probeFile(copy, ctx.config.ffmpeg);
    expect(probe.formatName).toContain('mp4');
    expect(probe.video?.codec).toBe('h264');
  });
});
