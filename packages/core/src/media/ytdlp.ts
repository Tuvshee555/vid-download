/**
 * yt-dlp integration: metadata, quality ladder and downloads for YouTube, Instagram,
 * Facebook and TikTok links.
 *
 * Safety: yt-dlp only ever receives the canonical URL rebuilt by `detectUrl` (allowlisted
 * host + pattern-checked IDs), is spawned with an argument array (no shell), runs with
 * `--ignore-config` (no config file can inject options), and the URL is passed after `--`
 * so it can never be parsed as an option.
 */
import { stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { AppError, PLATFORM_NAMES, type MediaFormat, type MediaMetadata, type MediaOption, type Platform } from '@vd/shared';
import { runProcess } from './ffmpeg';

export interface YtDlpConfig {
  binPath: string;
  /** ffmpeg binary or its directory; yt-dlp uses it to merge video + audio. */
  ffmpegLocation?: string | null;
  /** Netscape cookies file (optional; YouTube may require it from cloud servers). */
  cookiesFile?: string | null;
  /** e.g. `node:/usr/bin/node` — YouTube needs a JavaScript runtime for its player challenges. */
  jsRuntime?: string | null;
  cacheDir?: string | null;
  infoTimeoutMs?: number;
}

export interface YtDlpFormat {
  format_id?: string;
  ext?: string;
  vcodec?: string | null;
  acodec?: string | null;
  width?: number | null;
  height?: number | null;
  filesize?: number | null;
  filesize_approx?: number | null;
  tbr?: number | null;
  abr?: number | null;
}

export interface YtDlpInfo {
  id?: string;
  _type?: string;
  title?: string | null;
  description?: string | null;
  uploader?: string | null;
  channel?: string | null;
  creator?: string | null;
  thumbnail?: string | null;
  duration?: number | null;
  is_live?: boolean | null;
  live_status?: string | null;
  formats?: YtDlpFormat[];
  entries?: YtDlpInfo[];
}

/** Highest quality offered: anything above needs a full re-encode (VP9/AV1 only) and huge files. */
export const MAX_OFFERED_HEIGHT = 1080;
const MAX_MP4_OPTIONS = 4;

function baseArgs(config: YtDlpConfig): string[] {
  const args = [
    '--ignore-config',
    '--no-playlist',
    '--no-warnings',
    '--no-colors',
    '--socket-timeout', '30',
    '--retries', '3',
    '--fragment-retries', '3',
  ];
  args.push(...(config.cacheDir ? ['--cache-dir', config.cacheDir] : ['--no-cache-dir']));
  if (config.ffmpegLocation) args.push('--ffmpeg-location', config.ffmpegLocation);
  if (config.cookiesFile) args.push('--cookies', config.cookiesFile);
  if (config.jsRuntime) args.push('--js-runtimes', config.jsRuntime);
  return args;
}

/** Translate yt-dlp's stderr into a user-facing AppError. Raw output is kept only as the (logged) cause. */
export function mapYtDlpError(stderr: string, platform: Platform): AppError {
  const name = PLATFORM_NAMES[platform];
  const errorLine = stderr.split(/\r?\n/).reverse().find((line) => line.startsWith('ERROR:')) ?? stderr.slice(-400);
  const has = (pattern: RegExp) => pattern.test(errorLine);

  if (has(/confirm you.?re not a bot|Sign in to confirm/i)) {
    return new AppError(
      'PLATFORM_API_ERROR',
      'YouTube is blocking this server ("confirm you\'re not a bot"). YouTube blocks most cloud servers.',
      {
        retryable: false,
        cause: errorLine,
        guidance: [
          'Run MediaDock on your own computer (home internet isn’t blocked), or',
          'add YouTube cookies to the server (YTDLP_COOKIES) — see the README.',
        ],
      },
    );
  }
  if (has(/max-?filesize|larger than max/i)) return new AppError('FILE_TOO_LARGE', undefined, { cause: errorLine });
  if (has(/live event|is live|live stream|premiere/i)) {
    return new AppError('UNSUPPORTED_MEDIA', 'Live streams and upcoming premieres can’t be downloaded.', { cause: errorLine });
  }
  if (has(/Unsupported URL/i)) return new AppError('UNSUPPORTED_URL_TYPE', undefined, { cause: errorLine });
  if (has(/no video (formats )?found|There.?s no video|Requested format is not available|No media found/i)) {
    return new AppError('UNSUPPORTED_MEDIA', `This ${name} post has no downloadable video (it may be a photo).`, { cause: errorLine });
  }
  if (has(/private|login|log in|sign in|cookies|empty media response|age.?restricted|confirm your age|members.?only|not available in your country|geo.?restrict/i)) {
    return new AppError(
      'PRIVATE_CONTENT',
      `This ${name} video is private, age-restricted, region-locked or needs a login, so it can’t be downloaded.`,
      { cause: errorLine },
    );
  }
  if (has(/unavailable|not available|removed|deleted|does not exist|not found|HTTP Error 404|no longer available/i)) {
    return new AppError('NOT_FOUND', `This ${name} video doesn't exist or was removed.`, { cause: errorLine, status: 404 });
  }
  if (has(/HTTP Error 429|Too Many Requests|rate.?limit/i)) {
    return new AppError('RATE_LIMITED', `${name} is rate-limiting this server. Try again in a few minutes.`, { cause: errorLine });
  }
  if (has(/timed out|timeout|Connection reset|Temporary failure|Unable to download webpage|getaddrinfo/i)) {
    return new AppError('NETWORK_TIMEOUT', `Couldn't reach ${name}. Please try again.`, { cause: errorLine });
  }
  return new AppError('PLATFORM_API_ERROR', `Couldn't get this video from ${name}. Please try again later.`, {
    cause: errorLine,
    retryable: true,
  });
}

/** Fetch metadata (no download). Multi-item posts resolve to their first video. */
export async function fetchInfo(url: string, platform: Platform, config: YtDlpConfig, signal?: AbortSignal): Promise<YtDlpInfo> {
  const result = await runProcess(config.binPath, [...baseArgs(config), '-J', '--', url], {
    timeoutMs: config.infoTimeoutMs ?? 45_000,
    maxCapturedBytes: 48 * 1024 * 1024,
    stderrTailBytes: 16 * 1024,
    ...(signal ? { signal } : {}),
  });
  if (result.aborted) throw new AppError('PROCESSING_FAILED', 'Cancelled.', { retryable: false });
  if (result.timedOut) throw new AppError('NETWORK_TIMEOUT', `${PLATFORM_NAMES[platform]} took too long to respond.`);
  if (result.code !== 0) throw mapYtDlpError(result.stderrTail, platform);

  let info: YtDlpInfo;
  try {
    info = JSON.parse(result.stdout) as YtDlpInfo;
  } catch (error) {
    throw new AppError('PLATFORM_API_ERROR', `${PLATFORM_NAMES[platform]} returned something unreadable.`, { cause: error });
  }
  if (info._type === 'playlist' || info._type === 'multi_video') {
    const first = (info.entries ?? []).find((entry) => (entry.formats ?? []).length > 0);
    if (!first) throw new AppError('UNSUPPORTED_MEDIA', 'This post has no downloadable video.');
    return { ...first, title: first.title ?? info.title ?? null, uploader: first.uploader ?? info.uploader ?? null };
  }
  return info;
}

const GENERIC_TITLE = /^(Video by |Instagram (post|video) by |TikTok video #)/i;

function firstLine(text: string | null | undefined, max = 100): string | null {
  const line = text?.split(/\r?\n/).map((part) => part.trim()).find(Boolean);
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export function metadataFromInfo(info: YtDlpInfo): MediaMetadata {
  // Instagram titles are "Video by <user>"; the caption makes a far better title / file name.
  const title = info.title && GENERIC_TITLE.test(info.title) ? (firstLine(info.description) ?? info.title) : (info.title ?? firstLine(info.description));
  return {
    title: title ?? null,
    author: info.uploader ?? info.channel ?? info.creator ?? null,
    thumbnailUrl: info.thumbnail ?? null,
    durationSeconds: typeof info.duration === 'number' && info.duration > 0 ? info.duration : null,
  };
}

const hasVideo = (f: YtDlpFormat) => Boolean(f.vcodec) && f.vcodec !== 'none';
const hasAudio = (f: YtDlpFormat) => Boolean(f.acodec) && f.acodec !== 'none';
const sizeOf = (f: YtDlpFormat | undefined) => f?.filesize ?? f?.filesize_approx ?? null;
/** "1080p" means the short side, so portrait 1080×1920 is 1080p too. */
const tierOf = (f: YtDlpFormat) => (f.width && f.height ? Math.min(f.width, f.height) : (f.height ?? 0));

/**
 * The quality ladder shown to the user, built only from formats the platform actually
 * offers. Sizes are the platform's own (approximate) numbers or null — never invented.
 */
export function optionsFromInfo(info: YtDlpInfo): MediaOption[] {
  const formats = info.formats ?? [];
  const videos = formats.filter(hasVideo);
  const bestAudio = formats.filter((f) => hasAudio(f) && !hasVideo(f)).sort((a, b) => (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0))[0];

  // When the platform tells us codecs and offers H.264, only offer H.264 tiers: those are copied
  // as-is (fast, original quality, play everywhere). HEVC/VP9/AV1-only tiers would need a slow
  // re-encode into a much larger file. Platforms that report no codecs keep their full ladder.
  const h264 = videos.filter((f) => /^(avc|h264)/i.test(f.vcodec ?? ''));
  const ladder = h264.some((f) => tierOf(f) >= 144) ? h264 : videos;

  const byTier = new Map<number, YtDlpFormat>();
  for (const format of ladder) {
    const tier = tierOf(format);
    if (tier < 144 || tier > MAX_OFFERED_HEIGHT) continue;
    const current = byTier.get(tier);
    if (!current || (sizeOf(format) ?? 0) > (sizeOf(current) ?? 0)) byTier.set(tier, format);
  }
  const tiers = [...byTier.keys()].sort((a, b) => b - a).slice(0, MAX_MP4_OPTIONS);

  const options: MediaOption[] = [];
  if (tiers.length === 0 && videos.length > 0) {
    options.push({
      id: 'mp4-best',
      format: 'mp4',
      quality: null,
      label: 'MP4 video',
      container: 'MP4',
      resolution: null,
      sizeBytes: null,
      note: 'Best quality the platform offers.',
    });
  }
  for (const tier of tiers) {
    const format = byTier.get(tier)!;
    const videoSize = sizeOf(format);
    const audioSize = hasAudio(format) ? 0 : sizeOf(bestAudio);
    options.push({
      id: `mp4-${tier}`,
      format: 'mp4',
      quality: tier,
      label: `MP4 ${tier}p`,
      container: 'MP4',
      resolution: format.width && format.height ? `${format.width}×${format.height}` : null,
      sizeBytes: videoSize !== null && audioSize !== null ? videoSize + audioSize : null,
      note: tier === tiers[0] ? 'Best quality' : null,
    });
  }
  if (formats.some(hasAudio) || videos.length > 0) {
    options.push({
      id: 'mp3',
      format: 'mp3',
      quality: null,
      label: 'MP3 audio',
      container: 'MP3',
      resolution: null,
      sizeBytes: null,
      note: 'Audio only',
    });
  }
  return options;
}

export interface DownloadRequest {
  url: string;
  platform: Platform;
  format: MediaFormat;
  /** Max short-side resolution for MP4; null = best (capped at 1080p). */
  quality: number | null;
}

export interface DownloadOptions {
  dir: string;
  maxBytes: number;
  timeoutMs: number;
  /** 0–1 across all streams (video + audio). */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface DownloadedMedia {
  path: string;
  title: string | null;
  author: string | null;
}

/** Selector args. H.264 + AAC are preferred so MP4s play everywhere without re-encoding. */
export function formatArgs(format: MediaFormat, quality: number | null): string[] {
  if (format === 'mp3') return ['-f', 'ba/b'];
  const height = Math.min(quality ?? MAX_OFFERED_HEIGHT, MAX_OFFERED_HEIGHT);
  return ['-f', 'bv*+ba/b', '-S', `res:${height},vcodec:h264,acodec:m4a`, '--merge-output-format', 'mp4'];
}

export async function downloadMedia(request: DownloadRequest, config: YtDlpConfig, options: DownloadOptions): Promise<DownloadedMedia> {
  const sep = options.dir.includes('\\') ? '\\' : '/';
  const args = [
    ...baseArgs(config),
    '--newline',
    '--progress',
    '--no-mtime',
    '--max-filesize', String(options.maxBytes),
    '-o', `${options.dir}${sep}input.%(ext)s`,
    '--progress-template', 'download:[MD-PROGRESS] %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s',
    '--print', 'after_move:[MD-FILE] %(filepath)s',
    '--print', 'after_move:[MD-META] %(.{title,uploader,channel,description})j',
    ...formatArgs(request.format, request.quality),
    '--',
    request.url,
  ];

  let path: string | null = null;
  let meta: YtDlpInfo = {};
  let stream = 0;
  let lastDownloaded = 0;
  const expectedStreams = request.format === 'mp4' ? 2 : 1;

  const result = await runProcess(config.binPath, args, {
    timeoutMs: options.timeoutMs,
    stderrTailBytes: 16 * 1024,
    maxCapturedBytes: 256 * 1024,
    ...(options.signal ? { signal: options.signal } : {}),
    onStdoutLine: (line) => {
      if (line.startsWith('[MD-PROGRESS]')) {
        const [, done, total, estimate] = line.split(/\s+/);
        const downloaded = Number(done);
        const size = Number(total) || Number(estimate);
        if (!Number.isFinite(downloaded)) return;
        if (downloaded < lastDownloaded) stream = Math.min(stream + 1, expectedStreams - 1); // next stream started
        lastDownloaded = downloaded;
        if (size > 0) options.onProgress?.(Math.min(1, (stream + Math.min(1, downloaded / size)) / expectedStreams));
      } else if (line.startsWith('[MD-FILE] ')) {
        path = line.slice('[MD-FILE] '.length).trim();
      } else if (line.startsWith('[MD-META] ')) {
        try {
          meta = JSON.parse(line.slice('[MD-META] '.length)) as YtDlpInfo;
        } catch {
          // metadata is cosmetic
        }
      }
    },
  });

  if (result.aborted) throw new AppError('PROCESSING_FAILED', 'Cancelled.', { retryable: false });
  if (result.timedOut) throw new AppError('NETWORK_TIMEOUT', 'The download took too long and was stopped.');
  if (result.code !== 0) throw mapYtDlpError(result.stderrTail, request.platform);

  // Only ever trust a file inside this job's own folder, whatever yt-dlp printed.
  const reported: string | null = path;
  const finalPath =
    reported && resolve(/*turbopackIgnore: true*/ dirname(reported)) === resolve(/*turbopackIgnore: true*/ options.dir)
      ? resolve(/*turbopackIgnore: true*/ reported)
      : null;
  // Runtime-only path: tell the bundler not to trace the filesystem for it.
  const info = finalPath ? await stat(/*turbopackIgnore: true*/ finalPath).catch(() => null) : null;
  if (!finalPath || !info) {
    // yt-dlp skips files over --max-filesize with exit code 0 and no file.
    if (/max-?filesize|larger than/i.test(result.stderrTail + result.stdout)) throw new AppError('FILE_TOO_LARGE');
    throw new AppError('PLATFORM_API_ERROR', `The video couldn't be downloaded from ${PLATFORM_NAMES[request.platform]}.`, {
      cause: result.stderrTail.slice(-500),
    });
  }
  if (info.size > options.maxBytes) throw new AppError('FILE_TOO_LARGE');
  options.onProgress?.(1);

  const metadata = metadataFromInfo(meta);
  return { path: finalPath, title: metadata.title, author: metadata.author };
}
