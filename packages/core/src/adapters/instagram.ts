import { z } from 'zod';
import { AppError, type MediaFormat, type MediaMetadata, type PlatformInfo } from '@vd/shared';
import { BasePlatformAdapter, titleFromText } from './base';
import { buildGraphUrl, graphFailure, parseGraphError } from './graph';
import { standardOptions, type AuthorizedSource, type ResolvedMedia, type ValidatedUrl } from './types';

const GRAPH_BASE = 'https://graph.instagram.com';

export const INSTAGRAM_API_HOSTS = ['graph.instagram.com'] as const;
/** Where Instagram serves media files from. */
export const INSTAGRAM_MEDIA_HOST_SUFFIXES = ['cdninstagram.com', 'fbcdn.net'] as const;

const MAX_PAGES = 10;
const PAGE_SIZE = '50';

const mediaItemSchema = z.object({
  id: z.string(),
  caption: z.string().optional(),
  media_type: z.string(),
  media_url: z.string().url().optional(),
  thumbnail_url: z.string().url().optional(),
  permalink: z.string().optional(),
});
type MediaItem = z.infer<typeof mediaItemSchema>;

const mediaPageSchema = z.object({
  data: z.array(mediaItemSchema).default([]),
  paging: z.object({ next: z.string().url().optional() }).optional(),
});

const profileSchema = z.object({ username: z.string().optional() });

/** `https://www.instagram.com/reel/ABC123/` → `ABC123` */
export function shortcodeFromPermalink(permalink: string | undefined): string | null {
  if (!permalink) return null;
  const match = /instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i.exec(permalink);
  return match?.[1] ?? null;
}

/**
 * Instagram via the official Instagram API (Instagram Login).
 *
 * Instagram does not expose other people's media files through any API. What it does allow
 * is a professional account owner reading their *own* media — including each video's
 * `media_url` — with their own access token. That is exactly what this adapter does: it
 * looks the pasted post up among the connected account's media and only offers a download
 * on a match. Anything else is reported as unavailable, with the reason.
 */
export class InstagramAdapter extends BasePlatformAdapter {
  readonly platform = 'instagram' as const;
  private usernamePromise: Promise<string | null> | undefined;

  constructor(
    ctx: ConstructorParameters<typeof BasePlatformAdapter>[0],
    private readonly accessToken: string | undefined,
    private readonly graphVersion: string,
  ) {
    super(ctx);
  }

  describe(): Omit<PlatformInfo, 'platform' | 'name'> {
    return {
      configured: Boolean(this.accessToken),
      capability: 'own-media',
      summary: this.accessToken
        ? "Downloads posts and reels that belong to the Instagram professional account connected to this server, through Instagram's official API. Other people's posts cannot be downloaded — Instagram does not provide access to them."
        : "Not connected. Add an access token for your own Instagram professional (Business or Creator) account in the server configuration to download your own reels and videos. Instagram does not offer any way to download other people's media.",
    };
  }

  async resolve(target: ValidatedUrl, signal?: AbortSignal): Promise<ResolvedMedia> {
    if (!this.accessToken) {
      return {
        metadata: null,
        availability: {
          status: 'unavailable',
          reason: {
            code: 'NOT_CONFIGURED',
            message: "The Instagram integration isn't set up on this server, so this link can't be processed.",
            guidance: [
              'To download your own reels and videos, set INSTAGRAM_ACCESS_TOKEN (an Instagram API access token for your professional account) on the API and worker.',
              'Already have the video file? Use “Convert a file you own”.',
            ],
          },
        },
      };
    }

    const item = await this.findOwnMedia(target.mediaId, signal);
    if (!item) {
      return {
        metadata: null,
        availability: {
          status: 'unavailable',
          reason: {
            code: 'UNAUTHORIZED_SOURCE',
            message:
              "This post isn't part of the Instagram account connected to this server. Instagram only allows downloading media owned by the connected account.",
            guidance: [
              'Paste a link to one of your own posts or reels.',
              'Already have the video file? Use “Convert a file you own”.',
            ],
          },
        },
      };
    }

    const metadata = await this.metadataFor(item);
    if (item.media_type !== 'VIDEO') {
      return {
        metadata,
        availability: {
          status: 'unavailable',
          reason: {
            code: 'UNSUPPORTED_MEDIA',
            message:
              item.media_type === 'CAROUSEL_ALBUM'
                ? 'This is a multi-item post (carousel). Only single videos and reels can be converted.'
                : 'This post is a photo. Only videos and reels can be converted to MP4 or MP3.',
            guidance: [],
          },
        },
      };
    }
    if (!item.media_url) {
      return {
        metadata,
        availability: {
          status: 'unavailable',
          reason: {
            code: 'METADATA_MISSING',
            message:
              "Instagram didn't provide a downloadable file for this video. This happens, for example, when a reel uses licensed music.",
            guidance: ['Try downloading the original from the Instagram app, then use “Convert a file you own”.'],
          },
        },
      };
    }

    const size = await this.ctx.http.headContentLength(item.media_url, signal ? { signal } : {});
    return { metadata, availability: { status: 'available', options: standardOptions(size) } };
  }

  async getSource(target: ValidatedUrl, _format: MediaFormat, signal?: AbortSignal): Promise<AuthorizedSource> {
    if (!this.accessToken) throw new AppError('NOT_CONFIGURED', 'The Instagram integration is not configured.');
    const item = await this.findOwnMedia(target.mediaId, signal);
    if (!item) {
      throw new AppError(
        'UNAUTHORIZED_SOURCE',
        "This post isn't part of the Instagram account connected to this server, so it can't be downloaded.",
      );
    }
    if (item.media_type !== 'VIDEO') throw new AppError('UNSUPPORTED_MEDIA', 'Only videos and reels can be converted.');
    if (!item.media_url) throw new AppError('METADATA_MISSING', "Instagram didn't provide a downloadable file for this video.");
    return {
      url: item.media_url,
      allowedHostSuffixes: INSTAGRAM_MEDIA_HOST_SUFFIXES,
      metadata: await this.metadataFor(item),
    };
  }

  private async metadataFor(item: MediaItem): Promise<MediaMetadata> {
    return {
      title: titleFromText(item.caption),
      author: await this.username(),
      thumbnailUrl: item.thumbnail_url ?? null,
      durationSeconds: null,
    };
  }

  private username(): Promise<string | null> {
    this.usernamePromise ??= this.fetchUsername().catch(() => null);
    return this.usernamePromise;
  }

  private async fetchUsername(): Promise<string | null> {
    const url = this.url('me', { fields: 'username' });
    const response = await this.ctx.http.getJson(url);
    if (response.status !== 200) return null;
    const parsed = profileSchema.safeParse(response.body);
    return parsed.success ? (parsed.data.username ?? null) : null;
  }

  private url(path: string, params: Record<string, string>): string {
    return buildGraphUrl(GRAPH_BASE, this.graphVersion, path, params, this.accessToken ?? '');
  }

  /** Walk the connected account's media (newest first) until the shortcode matches. */
  private async findOwnMedia(shortcode: string, signal?: AbortSignal): Promise<MediaItem | null> {
    let next: string | null = this.url('me/media', {
      fields: 'id,caption,media_type,media_url,thumbnail_url,permalink',
      limit: PAGE_SIZE,
    });
    for (let page = 0; page < MAX_PAGES && next; page += 1) {
      const response = await this.ctx.http.getJson(next, signal ? { signal } : {});
      const failure = parseGraphError(response);
      if (failure) throw graphFailure('Instagram', failure);
      const parsed = mediaPageSchema.safeParse(response.body);
      if (!parsed.success) throw new AppError('PLATFORM_API_ERROR', 'Instagram returned an unexpected response.');

      const match = parsed.data.data.find((item) => shortcodeFromPermalink(item.permalink) === shortcode);
      if (match) return match;
      // `paging.next` is only ever followed if it stays on graph.instagram.com (enforced by the HTTP client's allowlist).
      next = parsed.data.paging?.next ?? null;
    }
    return null;
  }
}
