import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createReadStream } from 'node:fs';
import { copyFile, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError, detectUrl, type JobStage, type Platform } from '@vd/shared';
import {
  LocalStorage,
  UNSAFE_allowLoopbackGuard,
  downloadToFile,
  loadConfig,
  silentLogger,
  uploadKey,
  type AdapterRegistry,
  type AppConfig,
  type MediaJobData,
  type PlatformAdapter,
} from '@vd/core';
import { processMediaJob, type ProcessorDeps } from '../src/processors/media-job';
import { probeFile } from '../src/services/ffmpeg';
import { makeFixtures, type Fixtures } from './fixtures';

const UPLOAD_ID = '11111111-2222-4333-8444-555555555555';

class StubAdapter implements PlatformAdapter {
  readonly displayName: string;
  constructor(
    readonly platform: Platform,
    private readonly source: () => ReturnType<PlatformAdapter['getSource']>,
  ) {
    this.displayName = platform;
  }
  describe() {
    return { configured: true, capability: 'own-media' as const, summary: 'stub adapter for tests' };
  }
  validate(rawUrl: string) {
    const detection = detectUrl(rawUrl);
    if (!detection.ok) throw new AppError(detection.code);
    return detection;
  }
  resolve(): never {
    throw new Error('not used by the worker');
  }
  getSource() {
    return this.source();
  }
}

describe('processMediaJob', () => {
  let root: string;
  let fx: Fixtures;
  let server: Server;
  let serverUrl: string;
  let servedFile: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'vd-job-test-root-'));
    fx = await makeFixtures(join(root, 'fixtures'));
    servedFile = fx.h264Aac;
    server = createServer((req, res) => {
      if (req.url === '/video.mp4') {
        res.writeHead(200, { 'content-type': 'video/mp4' });
        createReadStream(servedFile).pipe(res);
      } else if (req.url === '/page.html') {
        res.writeHead(200, { 'content-type': 'text/html' }).end('<html>login</html>');
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  async function setup(env: Record<string, string> = {}, sourceAdapter?: () => ReturnType<PlatformAdapter['getSource']>) {
    const storageDir = await mkdtemp(join(root, 'store-'));
    const config: AppConfig = loadConfig({ NODE_ENV: 'test', STORAGE_LOCAL_DIR: storageDir, ...env });
    const storage = new LocalStorage({ dir: storageDir });
    const fallback = () => Promise.reject(new AppError('UNAUTHORIZED_SOURCE'));
    const adapters: AdapterRegistry = {
      youtube: new StubAdapter('youtube', () => Promise.reject(new AppError('UNAUTHORIZED_SOURCE', 'No permitted route.'))),
      instagram: new StubAdapter('instagram', sourceAdapter ?? fallback),
      facebook: new StubAdapter('facebook', fallback),
    };
    const stages: Array<[JobStage, number]> = [];
    const deps: ProcessorDeps = {
      config,
      storage,
      adapters,
      log: silentLogger,
      download: (url, dest, options) => downloadToFile(url, dest, { ...options, guard: UNSAFE_allowLoopbackGuard }),
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

    const stored = await ctx.storage.head(result.storageKey);
    expect(stored?.size).toBe(result.sizeBytes);
    expect(await ctx.storage.head(uploadKey(UPLOAD_ID))).toBeNull(); // upload removed after success
    expect(await leftoverWorkspaces()).toBe(before); // temp files removed

    const stageNames = ctx.stages.map(([stage]) => stage);
    expect(stageNames).toEqual(expect.arrayContaining(['resolving', 'downloading', 'probing', 'converting', 'uploading']));
    const percents = ctx.stages.map(([, percent]) => percent);
    expect([...percents].sort((a, b) => a - b)).toEqual(percents); // monotonic
    expect(Math.max(...percents)).toBeLessThanOrEqual(100);
  });

  it('keeps the original H.264 stream for MP4 (lossless) and reports the real resolution', async () => {
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

  it('refuses media longer than the configured limit', async () => {
    const ctx = await setup({ MAX_DURATION_MINUTES: '0.01' }); // 0.6 s
    await ctx.putUpload(fx.h264Aac);
    await expect(processMediaJob('job-too-long1', uploadJob('mp3'), ctx.deps, ctx.report)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('refuses inputs larger than the size limit before processing', async () => {
    const ctx = await setup({ MAX_INPUT_MB: '0.001' }); // ~1 KB
    await ctx.putUpload(fx.h264Aac);
    await expect(processMediaJob('job-too-big001', uploadJob('mp3'), ctx.deps, ctx.report)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('reports a missing upload as NOT_FOUND', async () => {
    const ctx = await setup();
    await expect(processMediaJob('job-missing01', uploadJob('mp3'), ctx.deps, ctx.report)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('stops FFmpeg that runs past the processing timeout', async () => {
    const ctx = await setup({ PROCESSING_TIMEOUT_MINUTES: '0.0001' });
    await ctx.putUpload(fx.vp9Opus);
    await expect(processMediaJob('job-timeout01', uploadJob('mp4', 'a.webm'), ctx.deps, ctx.report)).rejects.toMatchObject({ code: 'PROCESSING_FAILED', retryable: false });
  });

  describe('platform source (authorised URL → download → convert)', () => {
    const platformJob = (format: 'mp4' | 'mp3'): MediaJobData => ({
      source: { kind: 'platform', platform: 'instagram', canonicalUrl: 'https://www.instagram.com/reel/Cabc123XYZ/', mediaId: 'Cabc123XYZ' },
      format,
      createdAt: new Date().toISOString(),
    });

    it('downloads the authorised file, names the output after the post and converts it', async () => {
      servedFile = fx.h264Aac;
      const ctx = await setup({}, async () => ({
        url: `${serverUrl}/video.mp4`,
        allowedHostSuffixes: ['127.0.0.1'],
        metadata: { title: 'Launch day: the "big" one?', author: 'myshop', thumbnailUrl: null, durationSeconds: null },
      }));
      const result = await processMediaJob('job-platform01', platformJob('mp3'), ctx.deps, ctx.report);
      expect(result.filename).toBe('Launch day the big one.mp3'); // sanitised
      expect(ctx.stages.some(([stage]) => stage === 'downloading')).toBe(true);
      expect((await ctx.storage.head(result.storageKey))?.size).toBe(result.sizeBytes);
    });

    it('falls back to a platform-based file name when there is no title', async () => {
      const ctx = await setup({}, async () => ({ url: `${serverUrl}/video.mp4`, allowedHostSuffixes: ['127.0.0.1'], metadata: null }));
      const result = await processMediaJob('job-platform02', platformJob('mp4'), ctx.deps, ctx.report);
      expect(result.filename).toBe('instagram-Cabc123XYZ.mp4');
    });

    it('never downloads from a host the adapter did not authorise', async () => {
      const ctx = await setup({}, async () => ({ url: `${serverUrl}/video.mp4`, allowedHostSuffixes: ['cdninstagram.com'], metadata: null }));
      await expect(processMediaJob('job-platform03', platformJob('mp4'), ctx.deps, ctx.report)).rejects.toMatchObject({ code: 'BLOCKED_ADDRESS' });
    });

    it('rejects a web page served in place of media', async () => {
      const ctx = await setup({}, async () => ({ url: `${serverUrl}/page.html`, allowedHostSuffixes: ['127.0.0.1'], metadata: null }));
      await expect(processMediaJob('job-platform04', platformJob('mp4'), ctx.deps, ctx.report)).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' });
    });

    it('treats an expired CDN link as retryable', async () => {
      const ctx = await setup({}, async () => ({ url: `${serverUrl}/gone.mp4`, allowedHostSuffixes: ['127.0.0.1'], metadata: null }));
      await expect(processMediaJob('job-platform05', platformJob('mp4'), ctx.deps, ctx.report)).rejects.toMatchObject({ code: 'PLATFORM_API_ERROR', retryable: true });
    });

    it('fails fast, with the adapter\'s own message, when there is no permitted source (e.g. YouTube)', async () => {
      const ctx = await setup();
      const job: MediaJobData = {
        source: { kind: 'platform', platform: 'youtube', canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', mediaId: 'dQw4w9WgXcQ' },
        format: 'mp4',
        createdAt: new Date().toISOString(),
      };
      await expect(processMediaJob('job-platform06', job, ctx.deps, ctx.report)).rejects.toMatchObject({
        code: 'UNAUTHORIZED_SOURCE',
        retryable: false,
        message: 'No permitted route.',
      });
      expect(ctx.stages.some(([stage]) => stage === 'downloading')).toBe(false); // nothing was fetched
    });
  });

  it('produces files that really are what they claim to be', async () => {
    const ctx = await setup();
    await ctx.putUpload(fx.h264Aac);
    const result = await processMediaJob('job-verify0001', uploadJob('mp4', 'v.mp4'), ctx.deps, ctx.report);
    const out = ctx.storage.pathFor(result.storageKey);
    expect((await stat(out)).size).toBe(result.sizeBytes);
    const copy = join(ctx.storageDir, 'verify.mp4');
    await copyFile(out, copy);
    const probe = await probeFile(copy, ctx.config.ffmpeg);
    expect(probe.formatName).toContain('mp4');
    expect(probe.video?.codec).toBe('h264');
  });
});
