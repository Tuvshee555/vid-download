import { z } from 'zod';
import { AppError, type MediaFormat, type MediaMetadata, type PlatformInfo } from '@vd/shared';
import { BasePlatformAdapter } from './base';
import type { AuthorizedSource, ResolvedMedia, ValidatedUrl } from './types';

const OEMBED_URL = 'https://www.youtube.com/oembed';
const DATA_API_URL = 'https://www.googleapis.com/youtube/v3/videos';

/** The hosts this adapter talks to. Used to build the allowlisted HTTP client. */
export const YOUTUBE_API_HOSTS = ['www.youtube.com', 'www.googleapis.com'] as const;

const oEmbedSchema = z.object({
  title: z.string().optional(),
  author_name: z.string().optional(),
  thumbnail_url: z.string().url().optional(),
});

const dataApiSchema = z.object({
  items: z
    .array(
      z.object({
        snippet: z
          .object({
            title: z.string().optional(),
            channelTitle: z.string().optional(),
            thumbnails: z.record(z.string(), z.object({ url: z.string().url() })).optional(),
          })
          .optional(),
        contentDetails: z.object({ duration: z.string().optional() }).optional(),
      }),
    )
    .default([]),
});

/** ISO-8601 duration ("PT1H2M3S") → seconds. */
export function parseIsoDuration(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value);
  if (!match) return null;
  const [, d, h, m, s] = match;
  const total = Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0);
  return total > 0 ? total : null;
}

/**
 * YouTube: link recognition and metadata only.
 *
 * YouTube offers no API for downloading video files, and its Terms of Service (and API
 * Services Terms) only permit downloading through features YouTube itself provides. This
 * adapter therefore NEVER produces a download — it reports that plainly and points to the
 * permitted routes (Studio / Takeout for your own videos, then "convert a file you own").
 * If YouTube ever offers a permitted download API, implementing `getSource` here is the only
 * change required.
 */
export class YouTubeAdapter extends BasePlatformAdapter {
  readonly platform = 'youtube' as const;

  constructor(
    ctx: ConstructorParameters<typeof BasePlatformAdapter>[0],
    private readonly apiKey: string | undefined,
  ) {
    super(ctx);
  }

  describe(): Omit<PlatformInfo, 'platform' | 'name'> {
    return {
      configured: true,
      capability: 'metadata-only',
      summary:
        "Links are recognised and video details are shown. YouTube provides no API for downloading videos, and its Terms of Service only allow downloads through YouTube's own features, so MediaDock cannot fetch videos from YouTube links. For your own videos, export the original from YouTube Studio or Google Takeout and convert it with “Convert a file you own”.",
    };
  }

  async resolve(target: ValidatedUrl, signal?: AbortSignal): Promise<ResolvedMedia> {
    const metadata = await this.lookupMetadata(target, signal);
    if (metadata === 'not-found') {
      return {
        metadata: null,
        availability: {
          status: 'unavailable',
          reason: {
            code: 'PRIVATE_CONTENT',
            message: 'YouTube reports that this video does not exist or is private.',
            guidance: ['Check that the link is correct and that the video is public or unlisted.'],
          },
        },
      };
    }
    return {
      metadata,
      availability: {
        status: 'unavailable',
        reason: {
          code: 'UNAUTHORIZED_SOURCE',
          message:
            "YouTube doesn't provide a way for this server to download videos, and its Terms of Service only allow downloads through YouTube's own features.",
          guidance: [
            'If this is your own video: open YouTube Studio → Content, use the ⋮ menu → Download (or export your data with Google Takeout), then choose “Convert a file you own” below to get an MP4 or MP3.',
            "To watch videos offline, use the Download feature in the official YouTube app.",
          ],
        },
      },
    };
  }

  getSource(_target: ValidatedUrl, _format: MediaFormat): Promise<AuthorizedSource> {
    return Promise.reject(
      new AppError(
        'UNAUTHORIZED_SOURCE',
        "YouTube doesn't offer a permitted way to download videos from a link. Use “Convert a file you own” with an export of your own video.",
      ),
    );
  }

  /** Best-effort metadata. Returns 'not-found' only when YouTube definitively says the video is gone/private. */
  private async lookupMetadata(target: ValidatedUrl, signal?: AbortSignal): Promise<MediaMetadata | null | 'not-found'> {
    if (this.apiKey) {
      try {
        const url = `${DATA_API_URL}?part=snippet,contentDetails&id=${encodeURIComponent(target.mediaId)}`;
        const response = await this.ctx.http.getJson(url, {
          ...(signal ? { signal } : {}),
          headers: { 'x-goog-api-key': this.apiKey },
        });
        if (response.status === 200) {
          const parsed = dataApiSchema.safeParse(response.body);
          if (parsed.success) {
            const item = parsed.data.items[0];
            if (!item) return 'not-found';
            const thumbs = item.snippet?.thumbnails ?? {};
            return {
              title: item.snippet?.title ?? null,
              author: item.snippet?.channelTitle ?? null,
              thumbnailUrl: (thumbs.high ?? thumbs.medium ?? thumbs.default)?.url ?? null,
              durationSeconds: parseIsoDuration(item.contentDetails?.duration),
            };
          }
        } else {
          this.ctx.logger.warn({ status: response.status }, 'YouTube Data API call failed; falling back to oEmbed');
        }
      } catch (error) {
        this.ctx.logger.warn({ err: error }, 'YouTube Data API unreachable; falling back to oEmbed');
      }
    }

    try {
      const url = `${OEMBED_URL}?url=${encodeURIComponent(target.canonicalUrl)}&format=json`;
      const response = await this.ctx.http.getJson(url, signal ? { signal } : {});
      if (response.status === 404) return 'not-found';
      if (response.status === 200) {
        const parsed = oEmbedSchema.safeParse(response.body);
        if (parsed.success) {
          return {
            title: parsed.data.title ?? null,
            author: parsed.data.author_name ?? null,
            thumbnailUrl: parsed.data.thumbnail_url ?? null,
            durationSeconds: null,
          };
        }
      }
    } catch (error) {
      this.ctx.logger.warn({ err: error }, 'YouTube oEmbed lookup failed');
    }
    return null;
  }
}
