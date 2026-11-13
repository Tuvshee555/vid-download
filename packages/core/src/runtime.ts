/**
 * Turns an AppConfig into the dependency bundles the media pipeline needs. Shared by the
 * worker and the serverless web route so both run downloads/conversions identically.
 */
import { chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from './config';
import type { PipelineDeps } from './media/pipeline';
import type { YtDlpConfig } from './media/ytdlp';

let cookiesPath: string | null = null;

/** YTDLP_COOKIES (file contents in an env var) is written once to a private temp file. */
function resolveCookiesFile(config: AppConfig): string | null {
  if (config.ytdlp.cookiesFile) return config.ytdlp.cookiesFile;
  if (!config.ytdlp.cookiesContent) return null;
  if (!cookiesPath) {
    cookiesPath = join(tmpdir(), `mediadock-cookies-${process.pid}.txt`);
    writeFileSync(cookiesPath, config.ytdlp.cookiesContent.replace(/\n/g, '\n'), { mode: 0o600 });
    chmodSync(cookiesPath, 0o600);
  }
  return cookiesPath;
}

export function ytdlpConfigFrom(config: AppConfig): YtDlpConfig {
  return {
    binPath: config.ytdlp.binPath,
    ffmpegLocation: config.ffmpeg.ffmpegPath === 'ffmpeg' ? null : config.ffmpeg.ffmpegPath,
    cookiesFile: resolveCookiesFile(config),
    jsRuntime: config.ytdlp.jsRuntime,
    cacheDir: join(tmpdir(), 'mediadock-yt-dlp-cache'),
  };
}

export function pipelineDepsFrom(config: AppConfig, signal?: AbortSignal): PipelineDeps {
  return {
    ffmpeg: { ...config.ffmpeg },
    ytdlp: ytdlpConfigFrom(config),
    limits: {
      maxInputBytes: config.limits.maxInputBytes,
      maxOutputBytes: config.limits.maxOutputBytes,
      maxDurationSeconds: config.limits.maxDurationSeconds,
      downloadTimeoutMs: config.limits.downloadTimeoutMs,
      processingTimeoutMs: config.limits.processingTimeoutMs,
    },
    ...(signal ? { signal } : {}),
  };
}
