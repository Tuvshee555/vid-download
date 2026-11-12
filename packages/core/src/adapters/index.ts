import type { Platform } from '@vd/shared';
import type { AppConfig } from '../config';
import { silentLogger, type Logger } from '../logger';
import { createHttpClient, hostSuffixMatcher, type HttpClient } from '../net/safe-fetch';
import { FACEBOOK_API_HOSTS, FacebookAdapter } from './facebook';
import { INSTAGRAM_API_HOSTS, InstagramAdapter } from './instagram';
import type { AdapterContext, AdapterRegistry, PlatformAdapter } from './types';
import { YOUTUBE_API_HOSTS, YouTubeAdapter } from './youtube';

export * from './types';
export { BasePlatformAdapter } from './base';
export { YouTubeAdapter, parseIsoDuration } from './youtube';
export { InstagramAdapter, shortcodeFromPermalink, INSTAGRAM_MEDIA_HOST_SUFFIXES } from './instagram';
export { FacebookAdapter, FACEBOOK_MEDIA_HOST_SUFFIXES } from './facebook';

const API_HOSTS = [...YOUTUBE_API_HOSTS, ...INSTAGRAM_API_HOSTS, ...FACEBOOK_API_HOSTS];
/** Media CDN hosts are probed (HEAD) for size; the allowlist covers both platforms' CDNs. */
const MEDIA_HOST_SUFFIXES = ['cdninstagram.com', 'fbcdn.net', 'fbsbx.com'];

export interface CreateAdaptersOptions {
  http?: HttpClient;
  logger?: Logger;
}

/** One adapter per platform, sharing a single allowlisted, SSRF-guarded HTTP client. */
export function createAdapters(config: AppConfig, options: CreateAdaptersOptions = {}): AdapterRegistry {
  const matchApi = hostSuffixMatcher(API_HOSTS);
  const matchMedia = hostSuffixMatcher(MEDIA_HOST_SUFFIXES);
  const http =
    options.http ?? createHttpClient((host) => matchApi(host) || matchMedia(host));

  const ctx: AdapterContext = {
    http,
    logger: options.logger ?? silentLogger,
    limits: { maxDurationSeconds: config.limits.maxDurationSeconds },
  };

  return {
    youtube: new YouTubeAdapter(ctx, config.platforms.youtubeApiKey),
    instagram: new InstagramAdapter(ctx, config.platforms.instagramAccessToken, config.platforms.instagramGraphVersion),
    facebook: new FacebookAdapter(ctx, config.platforms.facebookAccessToken, config.platforms.facebookGraphVersion),
  };
}

export function adapterFor(registry: AdapterRegistry, platform: Platform): PlatformAdapter {
  return registry[platform];
}
