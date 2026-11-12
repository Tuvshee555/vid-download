import { z } from 'zod';
import { AppError, type MediaFormat, type MediaMetadata, type PlatformInfo } from '@vd/shared';
import { BasePlatformAdapter, titleFromText } from './base';
import { buildGraphUrl, graphFailure, isAccessDenied, parseGraphError } from './graph';
import { standardOptions, type AuthorizedSource, type ResolvedMedia, type ValidatedUrl } from './types';

const GRAPH_BASE = 'https://graph.facebook.com';

export const FACEBOOK_API_HOSTS = ['graph.facebook.com'] as const;
export const FACEBOOK_MEDIA_HOST_SUFFIXES = ['fbcdn.net', 'fbsbx.com'] as const;

const videoSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  length: z.number().optional(),
  picture: z.string().url().optional(),
  source: z.string().url().optional(),
  from: z.object({ name: z.string().optional() }).optional(),
});
type FacebookVideo = z.infer<typeof videoSchema>;

type Lookup =
  | { kind: 'video'; video: FacebookVideo }
  | { kind: 'inaccessible' };

/**
 * Facebook via the Graph API.
 *
 * A video's file URL (`source`) is only returned to a token that is allowed to read that
 * video — in practice a Page access token for a Page the owner manages (or a user token for
 * the owner's own videos). For anything else Facebook answers with a permission error and
 * this adapter reports the video as inaccessible. There is no unofficial fallback.
 */
export class FacebookAdapter extends BasePlatformAdapter {
  readonly platform = 'facebook' as const;

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
        ? "Downloads videos owned by the Facebook Page or account whose access token is configured on this server, through the Graph API. Videos owned by other people or Pages cannot be downloaded — Facebook does not allow it."
        : "Not connected. Add a Page (or user) access token with permission to read your own videos in the server configuration. Facebook does not offer any way to download videos owned by other people or Pages.",
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
            message: "The Facebook integration isn't set up on this server, so this link can't be processed.",
            guidance: [
              'To download videos from your own Page, set FACEBOOK_ACCESS_TOKEN (a Page access token that can read the Page’s videos) on the API and worker.',
              'Already have the video file? Use “Convert a file you own”.',
            ],
          },
        },
      };
    }

    const lookup = await this.lookup(target.mediaId, signal);
    if (lookup.kind === 'inaccessible') {
      return {
        metadata: null,
        availability: {
          status: 'unavailable',
          reason: {
            code: 'PRIVATE_CONTENT',
            message:
              "Facebook says this video doesn't exist or the account connected to this server isn't allowed to access it. Only videos owned by the connected Page or account can be downloaded.",
            guidance: [
              "Paste a link to a video on the Page you've connected.",
              'Already have the video file? Use “Convert a file you own”.',
            ],
          },
        },
      };
    }

    const { video } = lookup;
    const metadata = this.metadataFor(video);
    if (!video.source) {
      return {
        metadata,
        availability: {
          status: 'unavailable',
          reason: {
            code: 'UNAUTHORIZED_SOURCE',
            message:
              "Facebook shows this video's details to the connected account but does not provide the video file, so it can't be downloaded.",
            guidance: ['Already have the video file? Use “Convert a file you own”.'],
          },
        },
      };
    }
    if (video.length !== undefined && video.length > this.ctx.limits.maxDurationSeconds) {
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

    const size = await this.ctx.http.headContentLength(video.source, signal ? { signal } : {});
    return { metadata, availability: { status: 'available', options: standardOptions(size) } };
  }

  async getSource(target: ValidatedUrl, _format: MediaFormat, signal?: AbortSignal): Promise<AuthorizedSource> {
    if (!this.accessToken) throw new AppError('NOT_CONFIGURED', 'The Facebook integration is not configured.');
    const lookup = await this.lookup(target.mediaId, signal);
    if (lookup.kind === 'inaccessible') {
      throw new AppError('PRIVATE_CONTENT', undefined, { guidance: ['Only videos owned by the connected Page or account can be downloaded.'] });
    }
    if (!lookup.video.source) {
      throw new AppError('UNAUTHORIZED_SOURCE', "Facebook doesn't provide the video file for this video.");
    }
    return {
      url: lookup.video.source,
      allowedHostSuffixes: FACEBOOK_MEDIA_HOST_SUFFIXES,
      metadata: this.metadataFor(lookup.video),
    };
  }

  private metadataFor(video: FacebookVideo): MediaMetadata {
    return {
      title: titleFromText(video.title) ?? titleFromText(video.description),
      author: video.from?.name ?? null,
      thumbnailUrl: video.picture ?? null,
      durationSeconds: video.length ?? null,
    };
  }

  private async lookup(videoId: string, signal?: AbortSignal): Promise<Lookup> {
    // The ID is validated as digits-only by the URL parser; encode anyway so it can never alter the path.
    const url = buildGraphUrl(
      GRAPH_BASE,
      this.graphVersion,
      encodeURIComponent(videoId),
      { fields: 'id,title,description,length,picture,source,from{name}' },
      this.accessToken ?? '',
    );
    const response = await this.ctx.http.getJson(url, signal ? { signal } : {});
    const failure = parseGraphError(response);
    if (failure) {
      // Token problems and rate limits are real errors; "can't see this object" is an expected answer.
      if (failure.code === 190 || failure.httpStatus === 401 || failure.httpStatus === 429 || failure.httpStatus >= 500) {
        throw graphFailure('Facebook', failure);
      }
      if (isAccessDenied(failure)) return { kind: 'inaccessible' };
      throw graphFailure('Facebook', failure);
    }
    const parsed = videoSchema.safeParse(response.body);
    if (!parsed.success) throw new AppError('PLATFORM_API_ERROR', 'Facebook returned an unexpected response.');
    return { kind: 'video', video: parsed.data };
  }
}
