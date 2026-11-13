/**
 * The conversion pipeline shared by the background worker and the serverless (Vercel)
 * route: acquire an input file (link via yt-dlp, or an upload), then probe → plan →
 * convert/remux → verify. Storage is the caller's job.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError, FORMAT_MIME, buildOutputFilename, sanitizeFilename, type JobStage, type MediaFormat, type Platform } from '@vd/shared';
import {
  buildMp3Args,
  buildMp4Args,
  planMp3,
  planMp4,
  probeFile,
  runFfmpeg,
  type EncodeOptions,
  type FfmpegPaths,
  type ProbeResult,
} from './ffmpeg';
import { downloadMedia, type YtDlpConfig } from './ytdlp';

export type ProgressReporter = (stage: JobStage, percent: number) => void | Promise<void>;

export interface PipelineLimits {
  maxInputBytes: number;
  maxOutputBytes: number;
  maxDurationSeconds: number;
  downloadTimeoutMs: number;
  processingTimeoutMs: number;
}

export interface PipelineDeps {
  ffmpeg: FfmpegPaths & EncodeOptions;
  ytdlp: YtDlpConfig;
  limits: PipelineLimits;
  signal?: AbortSignal;
}

export interface LinkSource {
  platform: Platform;
  canonicalUrl: string;
  mediaId: string;
}

export interface AcquiredInput {
  path: string;
  titleHint: string | null;
  fallbackName: string;
}

export interface ConvertedOutput {
  path: string;
  filename: string;
  format: MediaFormat;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  resolution: string | null;
  losslessVideo: boolean | null;
}

const scale = (fraction: number, from: number, to: number) => from + Math.max(0, Math.min(1, fraction)) * (to - from);

/** Download a link with yt-dlp into `dir`. Progress 5 → 55 %. */
export async function acquireFromLink(
  source: LinkSource,
  request: { format: MediaFormat; quality: number | null },
  dir: string,
  deps: PipelineDeps,
  report: ProgressReporter,
): Promise<AcquiredInput> {
  await report('downloading', 5);
  let last = 5;
  const downloaded = await downloadMedia(
    { url: source.canonicalUrl, platform: source.platform, format: request.format, quality: request.quality },
    deps.ytdlp,
    {
      dir,
      maxBytes: deps.limits.maxInputBytes,
      timeoutMs: deps.limits.downloadTimeoutMs,
      ...(deps.signal ? { signal: deps.signal } : {}),
      onProgress: (fraction) => {
        const percent = scale(fraction, 5, 55);
        if (percent - last >= 1) {
          last = percent;
          void report('downloading', percent);
        }
      },
    },
  );
  return { path: downloaded.path, titleHint: downloaded.title, fallbackName: `${source.platform}-${source.mediaId}` };
}

function assertProcessable(probe: ProbeResult, format: MediaFormat, maxDurationSeconds: number): void {
  if (!probe.video && !probe.audio) throw new AppError('UNSUPPORTED_MEDIA', 'This file has no audio or video to convert.');
  if (format === 'mp4' && !probe.video) {
    throw new AppError('UNSUPPORTED_MEDIA', "This file has no video track, so it can't be converted to MP4. Choose MP3 instead.");
  }
  if (format === 'mp3' && !probe.audio) {
    throw new AppError('UNSUPPORTED_MEDIA', "This file has no audio track, so it can't be converted to MP3.");
  }
  if (probe.durationSeconds !== null && probe.durationSeconds > maxDurationSeconds) {
    throw new AppError('FILE_TOO_LARGE', `This media is longer than the ${Math.round(maxDurationSeconds / 60)}-minute limit.`);
  }
}

/**
 * Probe → plan → convert → verify. H.264/AAC are copied untouched; only incompatible
 * streams are re-encoded. Progress 57 → 90 %.
 */
export async function convertInput(
  input: AcquiredInput,
  format: MediaFormat,
  dir: string,
  deps: PipelineDeps,
  report: ProgressReporter,
): Promise<ConvertedOutput> {
  const { limits, ffmpeg } = deps;
  await report('probing', 57);
  const probe = await probeFile(input.path, ffmpeg);
  assertProcessable(probe, format, limits.maxDurationSeconds);

  await report('converting', 60);
  const outputPath = join(dir, `output.${format}`);
  const title = sanitizeFilename(input.titleHint ?? probe.title, '') || null;

  let losslessVideo: boolean | null = null;
  let args: string[];
  if (format === 'mp4') {
    const plan = planMp4(probe);
    losslessVideo = plan.video === 'copy';
    args = buildMp4Args(input.path, outputPath, plan, ffmpeg);
  } else {
    args = buildMp3Args(input.path, outputPath, planMp3(probe), title);
  }

  let last = 60;
  await runFfmpeg(args, {
    paths: ffmpeg,
    timeoutMs: limits.processingTimeoutMs,
    durationSeconds: probe.durationSeconds,
    ...(deps.signal ? { signal: deps.signal } : {}),
    onProgress: (fraction) => {
      const percent = scale(fraction, 60, 90);
      if (percent - last >= 1) {
        last = percent;
        void report('converting', percent);
      }
    },
  });

  const info = await stat(outputPath).catch(() => null);
  if (!info || info.size === 0) throw new AppError('PROCESSING_FAILED', 'The converted file was empty.');
  if (info.size > limits.maxOutputBytes) throw new AppError('FILE_TOO_LARGE');
  const outputProbe = await probeFile(outputPath, ffmpeg);
  if (format === 'mp4' ? !outputProbe.video : !outputProbe.audio) {
    throw new AppError('PROCESSING_FAILED', 'The converted file is missing its expected stream.');
  }

  return {
    path: outputPath,
    filename: buildOutputFilename(input.titleHint ?? probe.title, format, input.fallbackName),
    format,
    mimeType: FORMAT_MIME[format],
    sizeBytes: info.size,
    durationSeconds: outputProbe.durationSeconds ?? probe.durationSeconds,
    resolution: format === 'mp4' && outputProbe.video ? `${outputProbe.video.width}×${outputProbe.video.height}` : null,
    losslessVideo,
  };
}
