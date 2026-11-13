import { AppError, PLATFORM_NAMES, detectUrl, type ErrorCode, type Platform, type PlatformInfo } from '@vd/shared';
import { metadataFromInfo, optionsFromInfo } from '../media/ytdlp';
import type { AdapterContext, PlatformAdapter, ResolvedMedia, ValidatedUrl } from './types';

/** Refusals that are a property of the video (not a server fault): shown as "unavailable", never thrown. */
const EXPECTED_REFUSALS = new Set<ErrorCode>(['PRIVATE_CONTENT', 'NOT_FOUND', 'UNSUPPORTED_MEDIA', 'UNSUPPORTED_URL_TYPE', 'FILE_TOO_LARGE']);

const SUMMARIES: Record<Platform, string> = {
  youtube:
    'Public YouTube videos and Shorts, up to 1080p or as MP3. YouTube blocks many cloud servers: if you see a "not a bot" message, run MediaDock at home or add YouTube cookies (see README).',
  instagram: 'Public Instagram reels and video posts. Private accounts and stories aren’t supported.',
  facebook: 'Public Facebook videos and reels, including fb.watch and share links. Private and group-only videos aren’t supported.',
  tiktok: 'Public TikTok videos, including vm.tiktok.com share links. Photo slideshows aren’t supported.',
};

/** One adapter per platform, all powered by yt-dlp. */
export class LinkAdapter implements PlatformAdapter {
  constructor(
    readonly platform: Platform,
    private readonly ctx: AdapterContext,
  ) {}

  get displayName(): string {
    return PLATFORM_NAMES[this.platform];
  }

  describe(): Omit<PlatformInfo, 'platform' | 'name'> {
    return { configured: true, capability: 'public-links', summary: SUMMARIES[this.platform] };
  }

  validate(rawUrl: string): ValidatedUrl {
    const detection = detectUrl(rawUrl);
    if (!detection.ok) throw new AppError(detection.code, detection.message);
    if (detection.platform !== this.platform) {
      throw new AppError('UNSUPPORTED_DOMAIN', `This is not a ${this.displayName} link.`);
    }
    return detection;
  }

  async resolve(target: ValidatedUrl, signal?: AbortSignal): Promise<ResolvedMedia> {
    let info;
    try {
      info = await this.ctx.fetchInfo(target.canonicalUrl, this.platform, signal);
    } catch (error) {
      if (error instanceof AppError && (EXPECTED_REFUSALS.has(error.code) || (error.code === 'PLATFORM_API_ERROR' && !error.retryable))) {
        return {
          metadata: null,
          availability: { status: 'unavailable', reason: { code: error.code, message: error.message, guidance: error.guidance ?? [] } },
        };
      }
      throw error;
    }

    const metadata = metadataFromInfo(info);
    if (info.is_live || info.live_status === 'is_live' || info.live_status === 'is_upcoming') {
      return {
        metadata,
        availability: { status: 'unavailable', reason: { code: 'UNSUPPORTED_MEDIA', message: 'Live streams and upcoming premieres can’t be downloaded.', guidance: [] } },
      };
    }
    if (metadata.durationSeconds !== null && metadata.durationSeconds > this.ctx.limits.maxDurationSeconds) {
      return {
        metadata,
        availability: {
          status: 'unavailable',
          reason: {
            code: 'FILE_TOO_LARGE',
            message: `This video is longer than the ${Math.round(this.ctx.limits.maxDurationSeconds / 60)}-minute limit.`,
            guidance: [],
          },
        },
      };
    }
    const options = optionsFromInfo(info);
    if (options.length === 0) {
      return {
        metadata,
        availability: { status: 'unavailable', reason: { code: 'UNSUPPORTED_MEDIA', message: 'This post has no downloadable video or audio.', guidance: [] } },
      };
    }
    return { metadata, availability: { status: 'available', options } };
  }
}
