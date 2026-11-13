import type { Availability, MediaMetadata, Platform, PlatformInfo, UrlDetection } from '@vd/shared';
import type { Logger } from '../logger';
import type { YtDlpInfo } from '../media/ytdlp';

export type ValidatedUrl = Extract<UrlDetection, { ok: true }>;

export interface ResolvedMedia {
  metadata: MediaMetadata | null;
  availability: Availability;
}

export type InfoFetcher = (url: string, platform: Platform, signal?: AbortSignal) => Promise<YtDlpInfo>;

export interface AdapterContext {
  fetchInfo: InfoFetcher;
  limits: { maxDurationSeconds: number };
  logger: Logger;
}

/**
 * Every platform integration implements this one interface; nothing in the API, worker or
 * UI knows how a particular platform works.
 *
 *  - `validate` never touches the network.
 *  - `resolve` reports title/thumbnail/qualities and whether the video can be downloaded;
 *    "expected" refusals (private, removed, blocked) come back as `unavailable` with a
 *    reason, transient failures are thrown.
 */
export interface PlatformAdapter {
  readonly platform: Platform;
  readonly displayName: string;
  describe(): Omit<PlatformInfo, 'platform' | 'name'>;
  validate(rawUrl: string): ValidatedUrl;
  resolve(target: ValidatedUrl, signal?: AbortSignal): Promise<ResolvedMedia>;
}

export type AdapterRegistry = Record<Platform, PlatformAdapter>;
