import { describe, expect, it, vi } from 'vitest';
import { AppError, type Platform } from '@vd/shared';
import { loadConfig } from '../config';
import { silentLogger } from '../logger';
import type { YtDlpInfo } from '../media/ytdlp';
import { createAdapters } from './index';
import type { InfoFetcher } from './types';

/** Shaped like real `yt-dlp -J` output (trimmed). */
const youtubeInfo: YtDlpInfo = {
  id: '69IQ8q-g1q0',
  title: 'HIGHLIGHTS | AEK Athens 2-3 Real Madrid | Champions League',
  uploader: 'Real Madrid',
  thumbnail: 'https://i.ytimg.com/vi/69IQ8q-g1q0/maxresdefault.jpg',
  duration: 79,
  formats: [
    { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 129, filesize: 1_280_000 },
    { format_id: '251', ext: 'webm', vcodec: 'none', acodec: 'opus', abr: 135, filesize: 1_300_000 },
    { format_id: '160', ext: 'mp4', vcodec: 'avc1.4d400c', acodec: 'none', width: 256, height: 144, filesize: 900_000 },
    { format_id: '134', ext: 'mp4', vcodec: 'avc1.4d4015', acodec: 'none', width: 640, height: 360, filesize: 3_000_000 },
    { format_id: '135', ext: 'mp4', vcodec: 'avc1.4d401e', acodec: 'none', width: 854, height: 480, filesize: 5_000_000 },
    { format_id: '136', ext: 'mp4', vcodec: 'avc1.4d401f', acodec: 'none', width: 1280, height: 720, filesize: 11_000_000 },
    { format_id: '137', ext: 'mp4', vcodec: 'avc1.640028', acodec: 'none', width: 1920, height: 1080, filesize: 35_000_000 },
    { format_id: '313', ext: 'webm', vcodec: 'vp9', acodec: 'none', width: 3840, height: 2160, filesize: 200_000_000 },
  ],
};

const tiktokInfo: YtDlpInfo = {
  id: '7707305867162570017',
  title: 'Another training session completed! #RMCity #RealMadrid',
  uploader: 'realmadrid',
  duration: 55,
  formats: [
    { format_id: 'h264_540p', ext: 'mp4', vcodec: 'h264', acodec: 'aac', width: 576, height: 1024, filesize: 16_000_000 },
    { format_id: 'h264_360p', ext: 'mp4', vcodec: 'h264', acodec: 'aac', width: 360, height: 640, filesize: 6_000_000 },
  ],
};

const instagramInfo: YtDlpInfo = {
  title: 'Video by 433',
  description: 'What a strike! 🚀⚽\n#football #433',
  uploader: '433',
  formats: [
    { format_id: 'dash-v', ext: 'mp4', vcodec: 'avc1', acodec: 'none', width: 720, height: 1280 },
    { format_id: 'dash-a', ext: 'm4a', vcodec: 'none', acodec: 'mp4a' },
  ],
};

/** Facebook often reports no dimensions at all. */
const facebookNoHeights: YtDlpInfo = {
  title: 'William Saliba names his toughest opponent ever',
  uploader: 'GOAL',
  duration: 43.9,
  formats: [
    { format_id: 'hd', ext: 'mp4', vcodec: null, acodec: null },
    { format_id: '1234v', ext: 'mp4', vcodec: 'unknown', acodec: 'none' },
    { format_id: '1234a', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.5' },
  ],
};

function adapters(fetch: InfoFetcher, env: Record<string, string> = {}) {
  return createAdapters(loadConfig(env), { fetchInfo: fetch, logger: silentLogger });
}

const fixed = (info: YtDlpInfo): InfoFetcher => vi.fn(async () => info);

describe('LinkAdapter (yt-dlp)', () => {
  it('registers one adapter per platform with the same interface', () => {
    const registry = adapters(fixed(youtubeInfo));
    expect(Object.keys(registry).sort()).toEqual(['facebook', 'instagram', 'tiktok', 'youtube']);
    for (const [platform, adapter] of Object.entries(registry)) {
      expect(adapter.platform).toBe(platform);
      expect(adapter.describe()).toMatchObject({ capability: 'public-links', configured: true });
    }
  });

  it('builds a real quality ladder (≤1080p, H.264-friendly) plus MP3 for YouTube', async () => {
    const fetch = fixed(youtubeInfo);
    const { youtube } = adapters(fetch);
    const target = youtube.validate('https://youtu.be/69IQ8q-g1q0?si=tracking');
    const resolved = await youtube.resolve(target);

    expect(fetch).toHaveBeenCalledWith('https://www.youtube.com/watch?v=69IQ8q-g1q0', 'youtube', undefined);
    expect(resolved.metadata).toMatchObject({ title: youtubeInfo.title, author: 'Real Madrid', durationSeconds: 79 });
    if (resolved.availability.status !== 'available') throw new Error('expected available');
    const options = resolved.availability.options;
    expect(options.map((o) => o.id)).toEqual(['mp4-1080', 'mp4-720', 'mp4-480', 'mp4-360', 'mp3']);
    expect(options[0]).toMatchObject({ quality: 1080, resolution: '1920×1080', label: 'MP4 1080p', sizeBytes: 35_000_000 + 1_300_000 });
    expect(options.some((o) => (o.quality ?? 0) > 1080)).toBe(false); // 4K VP9 is never offered
    expect(options.at(-1)).toMatchObject({ format: 'mp3', quality: null, sizeBytes: null });
  });

  it('uses the short side for portrait video tiers (TikTok 576×1024 is "576p")', async () => {
    const { tiktok } = adapters(fixed(tiktokInfo));
    const resolved = await tiktok.resolve(tiktok.validate('https://www.tiktok.com/@realmadrid/video/7707305867162570017'));
    if (resolved.availability.status !== 'available') throw new Error('expected available');
    expect(resolved.availability.options.map((o) => o.label)).toEqual(['MP4 576p', 'MP4 360p', 'MP3 audio']);
    // progressive formats already contain audio: the size isn't double counted
    expect(resolved.availability.options[0]?.sizeBytes).toBe(16_000_000);
  });

  it('replaces Instagram\'s generic "Video by …" title with the caption', async () => {
    const { instagram } = adapters(fixed(instagramInfo));
    const resolved = await instagram.resolve(instagram.validate('https://www.instagram.com/433/reel/DYaXdWDCFm_/'));
    expect(resolved.metadata?.title).toBe('What a strike! 🚀⚽');
    if (resolved.availability.status !== 'available') throw new Error('expected available');
    expect(resolved.availability.options[0]).toMatchObject({ id: 'mp4-720', resolution: '720×1280', sizeBytes: null });
  });

  it('prefers H.264 tiers over HEVC-only ones (TikTok 1080p is HEVC: re-encoding it is slow and 6x bigger)', async () => {
    const info: YtDlpInfo = {
      ...tiktokInfo,
      formats: [
        { format_id: 'bytevc1_1080p', ext: 'mp4', vcodec: 'h265', acodec: 'aac', width: 1080, height: 1920, filesize: 11_000_000 },
        { format_id: 'bytevc1_720p', ext: 'mp4', vcodec: 'h265', acodec: 'aac', width: 720, height: 1280, filesize: 6_000_000 },
        ...(tiktokInfo.formats ?? []),
      ],
    };
    const { tiktok } = adapters(fixed(info));
    const resolved = await tiktok.resolve(tiktok.validate('https://www.tiktok.com/@realmadrid/video/7707305867162570017'));
    if (resolved.availability.status !== 'available') throw new Error('expected available');
    expect(resolved.availability.options.map((o) => o.id)).toEqual(['mp4-576', 'mp4-360', 'mp3']);
  });

  it('offers a single "best" MP4 when the platform reports no resolutions (Facebook)', async () => {
    const { facebook } = adapters(fixed(facebookNoHeights));
    const resolved = await facebook.resolve(facebook.validate('https://www.facebook.com/GOAL/videos/877734574158026/'));
    if (resolved.availability.status !== 'available') throw new Error('expected available');
    expect(resolved.availability.options.map((o) => o.id)).toEqual(['mp4-best', 'mp3']);
    expect(resolved.availability.options[0]).toMatchObject({ quality: null, resolution: null, sizeBytes: null });
  });

  it('turns expected refusals into an explained "unavailable" (not an error)', async () => {
    const cases: Array<[AppError, string]> = [
      [new AppError('PRIVATE_CONTENT', 'This Instagram video is private…'), 'PRIVATE_CONTENT'],
      [new AppError('NOT_FOUND', 'This video was removed.', { status: 404 }), 'NOT_FOUND'],
      [new AppError('PLATFORM_API_ERROR', 'YouTube is blocking this server', { retryable: false, guidance: ['Run it at home'] }), 'PLATFORM_API_ERROR'],
    ];
    for (const [error, code] of cases) {
      const { youtube } = adapters(vi.fn(async () => Promise.reject(error)));
      const resolved = await youtube.resolve(youtube.validate('https://www.youtube.com/watch?v=69IQ8q-g1q0'));
      expect(resolved.availability).toMatchObject({ status: 'unavailable', reason: { code, message: error.message } });
    }
  });

  it('throws transient failures so the API can report them as retryable', async () => {
    const { tiktok } = adapters(vi.fn(async () => Promise.reject(new AppError('NETWORK_TIMEOUT'))));
    await expect(tiktok.resolve(tiktok.validate('https://vm.tiktok.com/ZMabc123/'))).rejects.toMatchObject({ code: 'NETWORK_TIMEOUT' });
  });

  it('refuses live streams and over-long videos', async () => {
    const live = adapters(fixed({ ...youtubeInfo, is_live: true })).youtube;
    expect((await live.resolve(live.validate('https://youtu.be/69IQ8q-g1q0'))).availability).toMatchObject({ status: 'unavailable', reason: { code: 'UNSUPPORTED_MEDIA' } });

    const long = adapters(fixed({ ...youtubeInfo, duration: 3 * 3600 }), { MAX_DURATION_MINUTES: '60' }).youtube;
    expect((await long.resolve(long.validate('https://youtu.be/69IQ8q-g1q0'))).availability).toMatchObject({ status: 'unavailable', reason: { code: 'FILE_TOO_LARGE' } });
  });

  it('reports posts with nothing downloadable (e.g. photos)', async () => {
    const { instagram } = adapters(fixed({ title: 'Photo', formats: [] }));
    const resolved = await instagram.resolve(instagram.validate('https://www.instagram.com/p/Cabc123XYZ/'));
    expect(resolved.availability).toMatchObject({ status: 'unavailable', reason: { code: 'UNSUPPORTED_MEDIA' } });
  });

  it('never hands yt-dlp anything but the canonical URL, and rejects foreign links', () => {
    const registry = adapters(fixed(youtubeInfo));
    expect(() => registry.youtube.validate('https://www.tiktok.com/@a/video/7707305867162570017')).toThrowError(/not a YouTube link/);
    expect(() => registry.tiktok.validate('http://169.254.169.254/')).toThrowError();
    const platforms: Platform[] = ['youtube', 'instagram', 'facebook', 'tiktok'];
    expect(platforms.every((p) => registry[p].displayName.length > 0)).toBe(true);
  });
});
