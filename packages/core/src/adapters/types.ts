import type { Availability, MediaFormat, MediaMetadata, MediaOption, Platform, PlatformInfo, UrlDetection } from '@vd/shared';
import type { HttpClient } from '../net/safe-fetch';
import type { Logger } from '../logger';

export type ValidatedUrl = Extract<UrlDetection, { ok: true }>;

export interface ResolvedMedia {
  metadata: MediaMetadata | null;
  availability: Availability;
}

/**
 * A file the platform's *official* API has explicitly handed us permission to fetch
 * (for example the `media_url` of the connected account's own Instagram video).
 */
export interface AuthorizedSource {
  /** Direct URL of the media file. May be short-lived; the worker re-resolves on every attempt. */
  url: string;
  /** Hostname suffixes the file may be served from. Anything else is refused (SSRF guard). */
  allowedHostSuffixes: readonly string[];
  metadata: MediaMetadata | null;
}

export interface AdapterContext {
  http: HttpClient;
  limits: { maxDurationSeconds: number };
  logger: Logger;
}

/**
 * Every platform integration implements this one interface. Adding or improving a
 * platform means changing exactly one adapter — nothing in the API, worker or UI knows
 * how a particular platform works.
 *
 * Contract:
 *  - `validate` never touches the network.
 *  - `resolve` reports only what the official API confirms. If there is no permitted
 *    download route it returns `availability: unavailable` with an honest explanation.
 *  - `getSource` throws an `AppError` rather than ever falling back to an unofficial route.
 */
export interface PlatformAdapter {
  readonly platform: Platform;
  readonly displayName: string;
  describe(): Omit<PlatformInfo, 'platform' | 'name'>;
  validate(rawUrl: string): ValidatedUrl;
  resolve(target: ValidatedUrl, signal?: AbortSignal): Promise<ResolvedMedia>;
  getSource(target: ValidatedUrl, format: MediaFormat, signal?: AbortSignal): Promise<AuthorizedSource>;
}

export type AdapterRegistry = Record<Platform, PlatformAdapter>;

/** The two outputs every downloadable video supports. Resolution/MP3 size are never guessed. */
export function standardOptions(mp4SizeBytes: number | null): MediaOption[] {
  return [
    {
      id: 'mp4',
      format: 'mp4',
      label: 'MP4 video',
      container: 'MP4',
      resolution: null,
      sizeBytes: mp4SizeBytes,
      note: 'Original quality. The video is copied without re-encoding whenever the source allows it.',
    },
    {
      id: 'mp3',
      format: 'mp3',
      label: 'MP3 audio',
      container: 'MP3',
      resolution: null,
      sizeBytes: null,
      note: 'Audio extracted from the original. The exact size is known once it has been converted.',
    },
  ];
}
