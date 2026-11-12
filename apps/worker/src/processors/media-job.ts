import { stat } from 'node:fs/promises';
import {
  AppError,
  FORMAT_MIME,
  buildOutputFilename,
  sanitizeFilename,
  stripExtension,
  type JobResultRecord,
  type JobStage,
} from '@vd/shared';
import {
  adapterFor,
  downloadToFile,
  hostSuffixMatcher,
  outputKey,
  uploadKey,
  type AdapterRegistry,
  type AppConfig,
  type Logger,
  type MediaJobData,
  type ObjectStorage,
} from '@vd/core';
import { buildMp3Args, buildMp4Args, planMp3, planMp4, probeFile, runFfmpeg, type FfmpegPaths, type ProbeResult } from '../services/ffmpeg';
import { createWorkspace } from '../services/workspace';

export interface ProcessorDeps {
  config: AppConfig;
  storage: ObjectStorage;
  adapters: AdapterRegistry;
  log: Logger;
  /** Overridable in tests (loopback guard). Production always uses the SSRF-guarded downloader. */
  download?: typeof downloadToFile;
  now?: () => number;
}

export type ProgressReporter = (stage: JobStage, percent: number) => void | Promise<void>;

const scale = (fraction: number, from: number, to: number) => from + Math.max(0, Math.min(1, fraction)) * (to - from);

/**
 * The whole pipeline for one job:
 *   authorised source → (download | read upload) → probe/validate → convert → store.
 *
 * Throws `AppError`s only; the caller decides what is retryable.
 */
export async function processMediaJob(
  jobId: string,
  data: MediaJobData,
  deps: ProcessorDeps,
  report: ProgressReporter,
): Promise<JobResultRecord> {
  const { config, storage, adapters, log } = deps;
  const { limits } = config;
  const paths: FfmpegPaths = config.ffmpeg;
  const download = deps.download ?? downloadToFile;
  const now = deps.now ?? Date.now;
  const workspace = await createWorkspace();

  try {
    const inputPath = workspace.path('input.bin');
    let titleHint: string | null;
    let fallbackName: string;

    await report('resolving', 2);
    if (data.source.kind === 'platform') {
      const { platform, canonicalUrl, mediaId } = data.source;
      const adapter = adapterFor(adapters, platform);
      // Re-resolve now: CDN links expire, and permission must hold at processing time, not just at request time.
      const authorized = await adapter.getSource(adapter.validate(canonicalUrl), data.format);
      titleHint = authorized.metadata?.title ?? null;
      fallbackName = `${platform}-${mediaId}`;

      await report('downloading', 5);
      let lastReported = 0;
      await download(authorized.url, inputPath, {
        allowedHost: hostSuffixMatcher(authorized.allowedHostSuffixes),
        maxBytes: limits.maxInputBytes,
        timeoutMs: limits.downloadTimeoutMs,
        onProgress: (received, total) => {
          if (!total) return;
          const percent = scale(received / total, 5, 45);
          if (percent - lastReported >= 1) {
            lastReported = percent;
            void report('downloading', percent);
          }
        },
      });
    } else {
      titleHint = stripExtension(data.source.originalName);
      fallbackName = 'converted';
      await report('downloading', 5);
      await storage.getToFile(uploadKey(data.source.uploadId), inputPath, { maxBytes: limits.maxInputBytes });
    }

    await report('probing', 47);
    const probe = await probeFile(inputPath, paths);
    assertProcessable(probe, data.format, limits.maxDurationSeconds);

    await report('converting', 50);
    const extension = data.format;
    const outputPath = workspace.path(`output.${extension}`);
    const title = sanitizeFilename(titleHint ?? probe.title, '') || null;

    let losslessVideo: boolean | null = null;
    let args: string[];
    if (data.format === 'mp4') {
      const plan = planMp4(probe);
      losslessVideo = plan.video === 'copy';
      args = buildMp4Args(inputPath, outputPath, plan);
      log.info({ jobId, plan }, 'converting to mp4');
    } else {
      const plan = planMp3(probe);
      args = buildMp3Args(inputPath, outputPath, plan, title);
      log.info({ jobId, plan }, 'converting to mp3');
    }

    let lastPercent = 0;
    await runFfmpeg(args, {
      paths,
      timeoutMs: limits.processingTimeoutMs,
      durationSeconds: probe.durationSeconds,
      onProgress: (fraction) => {
        const percent = scale(fraction, 50, 90);
        if (percent - lastPercent >= 1) {
          lastPercent = percent;
          void report('converting', percent);
        }
      },
    });

    const outputInfo = await stat(outputPath).catch(() => null);
    if (!outputInfo || outputInfo.size === 0) throw new AppError('PROCESSING_FAILED', 'The converted file was empty.');
    if (outputInfo.size > limits.maxOutputBytes) throw new AppError('FILE_TOO_LARGE');
    const outputProbe = await probeFile(outputPath, paths);
    if (data.format === 'mp4' ? !outputProbe.video : !outputProbe.audio) {
      throw new AppError('PROCESSING_FAILED', 'The converted file is missing its expected stream.');
    }

    await report('uploading', 92);
    const key = outputKey(jobId, extension);
    await storage.putFile(key, outputPath, { contentType: FORMAT_MIME[data.format] });

    if (data.source.kind === 'upload') {
      // The converted file is stored; the original upload is no longer needed.
      await storage.delete(uploadKey(data.source.uploadId)).catch((error: unknown) => log.warn({ err: error }, 'could not delete processed upload'));
    }

    return {
      storageKey: key,
      filename: buildOutputFilename(titleHint ?? probe.title, data.format, fallbackName),
      format: data.format,
      mimeType: FORMAT_MIME[data.format],
      sizeBytes: outputInfo.size,
      durationSeconds: outputProbe.durationSeconds ?? probe.durationSeconds,
      resolution: data.format === 'mp4' && outputProbe.video ? `${outputProbe.video.width}×${outputProbe.video.height}` : null,
      losslessVideo,
      expiresAt: new Date(now() + limits.fileTtlMs).toISOString(),
    };
  } finally {
    await workspace.dispose();
  }
}

function assertProcessable(probe: ProbeResult, format: 'mp4' | 'mp3', maxDurationSeconds: number): void {
  if (!probe.video && !probe.audio) {
    throw new AppError('UNSUPPORTED_MEDIA', 'This file has no audio or video to convert.');
  }
  if (format === 'mp4' && !probe.video) {
    throw new AppError('UNSUPPORTED_MEDIA', 'This file has no video track, so it can\'t be converted to MP4. Choose MP3 instead.');
  }
  if (format === 'mp3' && !probe.audio) {
    throw new AppError('UNSUPPORTED_MEDIA', 'This file has no audio track, so it can\'t be converted to MP3.');
  }
  if (probe.durationSeconds !== null && probe.durationSeconds > maxDurationSeconds) {
    throw new AppError('FILE_TOO_LARGE', `This media is longer than the ${Math.round(maxDurationSeconds / 60)}-minute limit.`);
  }
}
