import { UnrecoverableError, type Job } from 'bullmq';
import { AppError, isAppError, type JobResultRecord, type JobStage } from '@vd/shared';
import { encodeFailure, type MediaJobData } from '@vd/core';
import { processMediaJob, type ProcessorDeps } from './media-job';

type MediaJob = Pick<Job<MediaJobData, JobResultRecord>, 'id' | 'data' | 'attemptsMade' | 'updateProgress'> & {
  opts: { attempts?: number | undefined };
};

/** Anything that is not already an AppError is an unexpected fault: retryable, but never shown raw. */
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;
  return new AppError('INTERNAL', undefined, { cause: error, retryable: true });
}

/** Rate-limits progress writes to Redis: only on stage change, or ≥1 point and ≥400 ms apart. */
export function createProgressReporter(job: Pick<MediaJob, 'updateProgress'>, nowMs: () => number = Date.now) {
  let lastStage: JobStage | null = null;
  let lastPercent = -1;
  let lastAt = 0;
  return async (stage: JobStage, percent: number): Promise<void> => {
    const rounded = Math.max(0, Math.min(100, Math.round(percent)));
    const at = nowMs();
    const stageChanged = stage !== lastStage;
    if (!stageChanged && (rounded - lastPercent < 1 || at - lastAt < 400)) return;
    lastStage = stage;
    lastPercent = rounded;
    lastAt = at;
    await job.updateProgress({ stage, percent: rounded }).catch(() => undefined);
  };
}

/**
 * BullMQ processor. Retry policy lives here: non-retryable errors (bad file, not permitted,
 * too large…) become `UnrecoverableError` so BullMQ fails the job immediately instead of
 * burning attempts; transient ones (timeouts, platform 5xx, storage hiccups) are re-thrown
 * and retried with back-off. Either way the structured error rides in the failure reason.
 */
export function createJobHandler(deps: ProcessorDeps) {
  return async function handle(job: MediaJob): Promise<JobResultRecord> {
    const jobId = job.id;
    if (!jobId) throw new UnrecoverableError(encodeFailure(new AppError('INTERNAL', 'Job has no id.')));
    const maxAttempts = job.opts.attempts ?? 1;
    const attempt = job.attemptsMade + 1;
    const started = Date.now();
    deps.log.info({ jobId, attempt, maxAttempts, source: job.data.source.kind, format: job.data.format }, 'job started');

    try {
      const result = await processMediaJob(jobId, job.data, deps, createProgressReporter(job));
      deps.log.info({ jobId, ms: Date.now() - started, bytes: result.sizeBytes }, 'job completed');
      return result;
    } catch (error) {
      const appError = toAppError(error);
      const willRetry = appError.retryable && attempt < maxAttempts;
      deps.log.warn({ jobId, attempt, code: appError.code, willRetry, err: error }, 'job failed');
      if (!appError.retryable) throw new UnrecoverableError(encodeFailure(appError));
      throw new Error(encodeFailure(appError));
    }
  };
}
