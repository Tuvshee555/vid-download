import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMp3Args, buildMp4Args, planMp3, planMp4, probeFile, probeWithFfmpeg, runFfmpeg, type ProbeResult } from './ffmpeg';
import { makeFixtures, type Fixtures } from './test-fixtures';

const paths = { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' };

const probeOf = (overrides: Partial<ProbeResult>): ProbeResult => ({
  formatName: 'mov,mp4',
  durationSeconds: 10,
  sizeBytes: 1000,
  video: { codec: 'h264', width: 1920, height: 1080 },
  audio: { codec: 'aac', bitRateKbps: 128 },
  title: null,
  ...overrides,
});

describe('conversion planning (no unnecessary re-encoding)', () => {
  it('MP4: copies H.264 and AAC/MP3 untouched', () => {
    expect(planMp4(probeOf({}))).toEqual({ video: 'copy', audio: 'copy' });
    expect(planMp4(probeOf({ audio: { codec: 'mp3', bitRateKbps: 128 } }))).toEqual({ video: 'copy', audio: 'copy' });
  });

  it('MP4: re-encodes only the parts that need it', () => {
    expect(planMp4(probeOf({ audio: { codec: 'opus', bitRateKbps: 128 } }))).toEqual({ video: 'copy', audio: 'encode' });
    expect(planMp4(probeOf({ video: { codec: 'vp9', width: 1, height: 1 } }))).toEqual({ video: 'encode', audio: 'copy' });
    expect(planMp4(probeOf({ video: { codec: 'hevc', width: 1, height: 1 }, audio: { codec: 'ac3', bitRateKbps: null } }))).toEqual({ video: 'encode', audio: 'encode' });
  });

  it('MP4: handles a silent video', () => {
    expect(planMp4(probeOf({ audio: null }))).toEqual({ video: 'copy', audio: 'none' });
  });

  it('MP3: copies MP3 sources and sizes the bitrate for everything else', () => {
    expect(planMp3(probeOf({ audio: { codec: 'mp3', bitRateKbps: 192 } }))).toEqual({ mode: 'copy', bitrateKbps: null });
    expect(planMp3(probeOf({ audio: { codec: 'aac', bitRateKbps: 64 } }))).toEqual({ mode: 'encode', bitrateKbps: 128 });
    expect(planMp3(probeOf({ audio: { codec: 'aac', bitRateKbps: 128 } }))).toEqual({ mode: 'encode', bitrateKbps: 160 });
    expect(planMp3(probeOf({ audio: { codec: 'aac', bitRateKbps: 256 } }))).toEqual({ mode: 'encode', bitrateKbps: 320 });
    expect(planMp3(probeOf({ audio: { codec: 'aac', bitRateKbps: 510 } }))).toEqual({ mode: 'encode', bitrateKbps: 320 });
    expect(planMp3(probeOf({ audio: { codec: 'flac', bitRateKbps: 900 } }))).toEqual({ mode: 'encode', bitrateKbps: 320 });
    expect(planMp3(probeOf({ audio: { codec: 'pcm_s16le', bitRateKbps: 1411 } }))).toEqual({ mode: 'encode', bitrateKbps: 320 });
    expect(planMp3(probeOf({ audio: { codec: 'opus', bitRateKbps: null } }))).toEqual({ mode: 'encode', bitrateKbps: 192 });
  });
});

describe('FFmpeg argument safety', () => {
  it('always restricts protocols to local files and never uses a shell string', () => {
    const mp4 = buildMp4Args('/tmp/in.bin', '/tmp/out.mp4', { video: 'copy', audio: 'copy' });
    const mp3 = buildMp3Args('/tmp/in.bin', '/tmp/out.mp3', { mode: 'encode', bitrateKbps: 192 }, 'x; rm -rf / `whoami` $(id)');
    for (const args of [mp4, mp3]) {
      expect(Array.isArray(args)).toBe(true);
      const index = args.indexOf('-protocol_whitelist');
      expect(index).toBeGreaterThan(-1);
      expect(args[index + 1]).toBe('file,pipe');
      expect(args.indexOf('-protocol_whitelist')).toBeLessThan(args.indexOf('-i'));
    }
    // a hostile title is passed as ONE literal argument
    expect(mp3).toContain('title=x; rm -rf / `whoami` $(id)');
  });

  it('copies streams instead of encoding when the plan says so', () => {
    const copy = buildMp4Args('i', 'o', { video: 'copy', audio: 'copy' });
    expect(copy).toEqual(expect.arrayContaining(['-c:v', 'copy', '-c:a', 'copy']));
    expect(copy).not.toContain('libx264');
    const encode = buildMp4Args('i', 'o', { video: 'encode', audio: 'encode' });
    expect(encode).toEqual(expect.arrayContaining(['libx264', '-preset', 'veryfast', '-crf', '20', 'aac']));
    expect(buildMp4Args('i', 'o', { video: 'encode', audio: 'none' }, { x264Preset: 'medium', crf: 18 })).toEqual(expect.arrayContaining(['medium', '18']));
    expect(buildMp3Args('i', 'o', { mode: 'copy', bitrateKbps: null }, null)).not.toContain('libmp3lame');
  });
});

describe('with real FFmpeg', () => {
  let dir: string;
  let fx: Fixtures;
  let outDir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vd-ffmpeg-test-'));
    fx = await makeFixtures(join(dir, 'fixtures'));
    outDir = join(dir, 'out');
    await import('node:fs/promises').then((fs) => fs.mkdir(outDir, { recursive: true }));
  }, 120_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('probeFile', () => {
    it('reads streams, codecs and duration', async () => {
      const probe = await probeFile(fx.h264Aac, paths);
      expect(probe.video).toMatchObject({ codec: 'h264', width: 320, height: 240 });
      expect(probe.audio?.codec).toBe('aac');
      expect(probe.durationSeconds).toBeGreaterThan(1.5);
      expect(probe.durationSeconds).toBeLessThan(2.6);
    });

    it('distinguishes audio-only and video-only files', async () => {
      expect(await probeFile(fx.audioOnlyM4a, paths)).toMatchObject({ video: null, audio: { codec: 'aac' } });
      expect(await probeFile(fx.videoOnly, paths)).toMatchObject({ audio: null, video: { codec: 'h264' } });
    });

    it('rejects text files, images and unreadable data as UNSUPPORTED_MEDIA', async () => {
      await expect(probeFile(fx.notMedia, paths)).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' });
      await expect(probeFile(fx.png, paths)).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' });
    });

    it('refuses playlists and NEVER lets FFmpeg touch the network (protocol whitelist)', async () => {
      let hits = 0;
      const server: Server = createServer((_req, res) => {
        hits += 1;
        res.writeHead(200).end('x');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const playlist = await fx.playlist(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
        await expect(probeFile(playlist, paths)).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(hits).toBe(0);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe('probeWithFfmpeg (serverless fallback, no ffprobe)', () => {
    it.each(['h264Aac', 'vp9Opus', 'h264Opus', 'audioOnlyM4a', 'videoOnly', 'audioMp3', 'audioFlac'] as const)('matches ffprobe for %s', async (name) => {
      const viaProbe = await probeFile(fx[name], paths);
      const viaFfmpeg = await probeWithFfmpeg(fx[name], 'ffmpeg');
      expect(viaFfmpeg.video?.codec ?? null).toBe(viaProbe.video?.codec ?? null);
      expect(viaFfmpeg.video?.width ?? null).toBe(viaProbe.video?.width ?? null);
      expect(viaFfmpeg.video?.height ?? null).toBe(viaProbe.video?.height ?? null);
      expect(viaFfmpeg.audio?.codec ?? null).toBe(viaProbe.audio?.codec ?? null);
      expect(Math.abs((viaFfmpeg.durationSeconds ?? 0) - (viaProbe.durationSeconds ?? 0))).toBeLessThan(0.1);
      expect(planMp4(viaFfmpeg)).toEqual(planMp4(viaProbe));
    });

    it('is used automatically when ffprobePath is null', async () => {
      const probe = await probeFile(fx.h264Aac, { ffmpegPath: 'ffmpeg', ffprobePath: null });
      expect(probe.video).toMatchObject({ codec: 'h264', width: 320, height: 240 });
    });

    it('rejects text files and images exactly like ffprobe does', async () => {
      await expect(probeWithFfmpeg(fx.notMedia, 'ffmpeg')).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' });
      await expect(probeWithFfmpeg(fx.png, 'ffmpeg')).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' });
    });
  });

  describe('conversions', () => {
    const outputProbe = (name: string) => probeFile(join(outDir, name), paths);

    it('MP4 from H.264/AAC is a lossless remux (video stream copied)', async () => {
      const probe = await probeFile(fx.h264Aac, paths);
      const output = join(outDir, 'remux.mp4');
      await runFfmpeg(buildMp4Args(fx.h264Aac, output, planMp4(probe)), { paths, timeoutMs: 60_000, durationSeconds: probe.durationSeconds });
      const result = await outputProbe('remux.mp4');
      expect(result.video).toMatchObject({ codec: 'h264', width: 320, height: 240 });
      expect(result.audio?.codec).toBe('aac');
      expect(result.durationSeconds).toBeCloseTo(probe.durationSeconds ?? 0, 0);
    });

    it('MP4 from VP9/Opus is transcoded to H.264/AAC', async () => {
      const probe = await probeFile(fx.vp9Opus, paths);
      expect(planMp4(probe)).toEqual({ video: 'encode', audio: 'encode' });
      const output = join(outDir, 'vp9.mp4');
      await runFfmpeg(buildMp4Args(fx.vp9Opus, output, planMp4(probe)), { paths, timeoutMs: 120_000, durationSeconds: probe.durationSeconds });
      const result = await outputProbe('vp9.mp4');
      expect(result.video?.codec).toBe('h264');
      expect(result.audio?.codec).toBe('aac');
    });

    it('MP4 transcode copes with odd dimensions (even-size scaling)', async () => {
      const probe = await probeFile(fx.oddSizeVp9, paths);
      expect(probe.video).toMatchObject({ width: 321, height: 241 });
      const output = join(outDir, 'odd.mp4');
      await runFfmpeg(buildMp4Args(fx.oddSizeVp9, output, planMp4(probe)), { paths, timeoutMs: 120_000, durationSeconds: probe.durationSeconds });
      const result = await outputProbe('odd.mp4');
      expect(result.video?.width).toBe(320);
      expect(result.video?.height).toBe(240);
    });

    it('MP4 keeps H.264 video but converts Opus audio to AAC', async () => {
      const probe = await probeFile(fx.h264Opus, paths);
      expect(planMp4(probe)).toEqual({ video: 'copy', audio: 'encode' });
      const output = join(outDir, 'mkv.mp4');
      await runFfmpeg(buildMp4Args(fx.h264Opus, output, planMp4(probe)), { paths, timeoutMs: 60_000, durationSeconds: probe.durationSeconds });
      const result = await outputProbe('mkv.mp4');
      expect(result.video?.codec).toBe('h264');
      expect(result.audio?.codec).toBe('aac');
    });

    it('MP3 from a video extracts the audio track', async () => {
      const probe = await probeFile(fx.h264Aac, paths);
      const output = join(outDir, 'extract.mp3');
      await runFfmpeg(buildMp3Args(fx.h264Aac, output, planMp3(probe), 'My title'), { paths, timeoutMs: 60_000, durationSeconds: probe.durationSeconds });
      const result = await outputProbe('extract.mp3');
      expect(result.video).toBeNull();
      expect(result.audio?.codec).toBe('mp3');
      expect(result.title).toBe('My title');
      expect(result.durationSeconds).toBeGreaterThan(1.5);
    });

    it('MP3 from an MP3 is copied, not re-encoded', async () => {
      const probe = await probeFile(fx.audioMp3, paths);
      expect(planMp3(probe).mode).toBe('copy');
      const output = join(outDir, 'copy.mp3');
      await runFfmpeg(buildMp3Args(fx.audioMp3, output, planMp3(probe), null), { paths, timeoutMs: 60_000, durationSeconds: probe.durationSeconds });
      const result = await outputProbe('copy.mp3');
      expect(result.audio?.codec).toBe('mp3');
      expect(result.audio?.bitRateKbps).toBeGreaterThan(110);
    });

    it('MP3 from FLAC is encoded at 320 kbps', async () => {
      const probe = await probeFile(fx.audioFlac, paths);
      const output = join(outDir, 'flac.mp3');
      await runFfmpeg(buildMp3Args(fx.audioFlac, output, planMp3(probe), null), { paths, timeoutMs: 60_000, durationSeconds: probe.durationSeconds });
      expect((await outputProbe('flac.mp3')).audio?.bitRateKbps).toBeGreaterThan(300);
    });

    it('reports progress as a 0–1 fraction', async () => {
      const probe = await probeFile(fx.vp9Opus, paths);
      const seen: number[] = [];
      await runFfmpeg(buildMp4Args(fx.vp9Opus, join(outDir, 'progress.mp4'), planMp4(probe)), {
        paths,
        timeoutMs: 120_000,
        durationSeconds: probe.durationSeconds,
        onProgress: (fraction) => seen.push(fraction),
      });
      expect(seen.length).toBeGreaterThan(0);
      expect(Math.max(...seen)).toBeLessThanOrEqual(1);
      expect(Math.max(...seen)).toBeGreaterThan(0.5);
    });

    it('turns an FFmpeg failure into PROCESSING_FAILED without leaking stderr', async () => {
      const error = await runFfmpeg(buildMp4Args(fx.notMedia, join(outDir, 'bad.mp4'), { video: 'copy', audio: 'none' }), { paths, timeoutMs: 30_000, durationSeconds: null }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'PROCESSING_FAILED' });
      expect((error as Error).message).not.toMatch(/Invalid data|moov|\.bin/i);
    });

    it('kills FFmpeg when the timeout expires', async () => {
      const error = await runFfmpeg(buildMp4Args(fx.vp9Opus, join(outDir, 'timeout.mp4'), { video: 'encode', audio: 'encode' }), {
        paths,
        timeoutMs: 1,
        durationSeconds: 2,
      }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'PROCESSING_FAILED', retryable: false });
      expect((error as Error).message).toMatch(/too long/i);
    });

    it('reports a missing binary as a configuration problem', async () => {
      const error = await runFfmpeg(['-version'], { paths: { ffmpegPath: 'definitely-not-ffmpeg', ffprobePath: 'x' }, timeoutMs: 5_000, durationSeconds: null }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'INTERNAL', retryable: false });
    });
  });
});
