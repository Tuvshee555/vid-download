import { AppError, PLATFORM_NAMES, detectUrl, type MediaFormat, type Platform, type PlatformInfo } from '@vd/shared';
import type { AdapterContext, AuthorizedSource, PlatformAdapter, ResolvedMedia, ValidatedUrl } from './types';

export abstract class BasePlatformAdapter implements PlatformAdapter {
  abstract readonly platform: Platform;

  constructor(protected readonly ctx: AdapterContext) {}

  get displayName(): string {
    return PLATFORM_NAMES[this.platform];
  }

  abstract describe(): Omit<PlatformInfo, 'platform' | 'name'>;
  abstract resolve(target: ValidatedUrl, signal?: AbortSignal): Promise<ResolvedMedia>;
  abstract getSource(target: ValidatedUrl, format: MediaFormat, signal?: AbortSignal): Promise<AuthorizedSource>;

  validate(rawUrl: string): ValidatedUrl {
    const detection = detectUrl(rawUrl);
    if (!detection.ok) throw new AppError(detection.code, detection.message);
    if (detection.platform !== this.platform) {
      throw new AppError('UNSUPPORTED_DOMAIN', `This is not a ${this.displayName} link.`);
    }
    return detection;
  }
}

/** Shorten arbitrary captions/descriptions into a usable single-line title. */
export function titleFromText(text: string | undefined | null, maxLength = 100): string | null {
  if (!text) return null;
  const firstLine = text.split(/\r?\n/).find((line) => line.trim() !== '')?.trim();
  if (!firstLine) return null;
  return firstLine.length > maxLength ? `${firstLine.slice(0, maxLength - 1).trimEnd()}…` : firstLine;
}
