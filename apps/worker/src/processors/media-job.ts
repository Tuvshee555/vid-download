import { stripExtension, type JobResultRecord } from '@vd/shared';
import {
  acquireFromLink,
  convertInput,
  outputKey,
  pipelineDepsFrom,
  uploadKey,
  type AcquiredInput,
  type AdapterRegistry,
  type AppConfig,
  type Logger,
  type MediaJobData,
  type ObjectStorage,
  type ProgressReporter,
} from '@vd/core';
import { createWorkspace } from '../services/workspace';

export type { ProgressReporter };

export interface ProcessorDeps {
  config: AppConfig;
  storage: ObjectStorage;
  adapters: AdapterRegistry;
  log: Logger;
  /** Overridable in tests; production downloads links with yt-dlp. */
  acquireLink?: typeof acquireFromLink;
  now?: () => number;
}

/**
 * One job: acquire the input (link via yt-dlp, or the user's upload) → shared
 * probe/convert pipeline → store. Throws `AppError`s only; the caller decides what is retryable.
 */
export async function processMediaJob(
  jobId: string,
  data: MediaJobData,
  deps: ProcessorDeps,
  report: ProgressReporter,
): Promise<JobResultRecord> {
  const { config, storage, log } = deps;
  const pipeline = pipelineDepsFrom(config);
  const acquireLink = deps.acquireLink ?? acquireFromLink;
  const now = deps.now ?? Date.now;
  const workspace = await createWorkspace();

  try {
    await report('resolving', 2);
    let input: AcquiredInput;
    if (data.source.kind === 'platform') {
      input = await acquireLink(
        data.source,
        { format: data.format, quality: data.format === 'mp4' ? (data.quality ?? null) : null },
        workspace.dir,
        pipeline,
        report,
      );
    } else {
      await report('downloading', 5);
      const path = workspace.path('input.bin');
      await storage.getToFile(uploadKey(data.source.uploadId), path, { maxBytes: config.limits.maxInputBytes });
      input = { path, titleHint: stripExtension(data.source.originalName), fallbackName: 'converted' };
    }

    const output = await convertInput(input, data.format, workspace.dir, pipeline, report);

    await report('uploading', 92);
    const key = outputKey(jobId, data.format);
    await storage.putFile(key, output.path, { contentType: output.mimeType });

    if (data.source.kind === 'upload') {
      // The converted file is stored; the original upload is no longer needed.
      await storage.delete(uploadKey(data.source.uploadId)).catch((error: unknown) => log.warn({ err: error }, 'could not delete processed upload'));
    }

    return {
      storageKey: key,
      filename: output.filename,
      format: output.format,
      mimeType: output.mimeType,
      sizeBytes: output.sizeBytes,
      durationSeconds: output.durationSeconds,
      resolution: output.resolution,
      losslessVideo: output.losslessVideo,
      expiresAt: new Date(now() + config.limits.fileTtlMs).toISOString(),
    };
  } finally {
    await workspace.dispose();
  }
}
