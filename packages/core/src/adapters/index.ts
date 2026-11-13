import { PLATFORMS, type Platform } from '@vd/shared';
import type { AppConfig } from '../config';
import { silentLogger, type Logger } from '../logger';
import { fetchInfo } from '../media/ytdlp';
import { ytdlpConfigFrom } from '../runtime';
import { LinkAdapter } from './base';
import type { AdapterContext, AdapterRegistry, InfoFetcher, PlatformAdapter } from './types';

export * from './types';
export { LinkAdapter } from './base';

export interface CreateAdaptersOptions {
  /** Inject a fake in tests; defaults to running yt-dlp. */
  fetchInfo?: InfoFetcher;
  logger?: Logger;
}

export function createAdapters(config: AppConfig, options: CreateAdaptersOptions = {}): AdapterRegistry {
  const ytdlp = ytdlpConfigFrom(config);
  const ctx: AdapterContext = {
    fetchInfo: options.fetchInfo ?? ((url, platform, signal) => fetchInfo(url, platform, ytdlp, signal)),
    logger: options.logger ?? silentLogger,
    limits: { maxDurationSeconds: config.limits.maxDurationSeconds },
  };
  return Object.fromEntries(PLATFORMS.map((platform) => [platform, new LinkAdapter(platform, ctx)])) as unknown as AdapterRegistry;
}

export function adapterFor(registry: AdapterRegistry, platform: Platform): PlatformAdapter {
  return registry[platform];
}
