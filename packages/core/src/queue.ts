import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import {
  type AppError,
  ERROR_CATALOGUE,
  isErrorCode,
  type ErrorCode,
  type JobResultRecord,
  type JobStatus,
  type MediaFormat,
  type Platform,
} from '@vd/shared';
import type { AppConfig } from './config';

export const MEDIA_QUEUE_NAME = 'media-jobs';

export type MediaJobSource =
  | { kind: 'platform'; platform: Platform; canonicalUrl: string; mediaId: string }
  | { kind: 'upload'; uploadId: string; originalName: string };

export interface MediaJobData {
  source: MediaJobSource;
  format: MediaFormat;
  createdAt: string;
}

export type MediaQueue = Queue<MediaJobData, JobResultRecord>;

/**
 * `role` matters: BullMQ workers use blocking commands and require `maxRetriesPerRequest: null`,
 * while the API wants requests to fail fast when Redis is down instead of hanging.
 */
export function createRedisConnection(url: string, role: 'api' | 'worker'): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: role === 'worker' ? null : 2,
    connectTimeout: 10_000,
    enableReadyCheck: true,
  });
}

export function createMediaQueue(connection: Redis): MediaQueue {
  return new Queue<MediaJobData, JobResultRecord>(MEDIA_QUEUE_NAME, { connection });
}

export function mediaJobOptions(config: AppConfig, jobId: string): JobsOptions {
  const keepSeconds = Math.ceil(config.limits.fileTtlMs / 1000) + 3600;
  return {
    jobId,
    attempts: config.queue.maxAttempts,
    backoff: { type: 'exponential', delay: 5_000 },
    // Keep finished jobs a little longer than their files so the UI can say "expired" rather than "not found".
    removeOnComplete: { age: keepSeconds, count: 1000 },
    removeOnFail: { age: 24 * 3600, count: 1000 },
  };
}

/** BullMQ state → the four public statuses. `expired` is derived from the result timestamp by the API. */
export function mapQueueState(state: string): Exclude<JobStatus, 'expired'> {
  switch (state) {
    case 'active':
      return 'processing';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      // waiting, delayed (incl. retry back-off), prioritized, waiting-children, unknown
      return 'queued';
  }
}

// ───────────────────────── failure transport ─────────────────────────
// BullMQ only persists a string for a failed job, so the structured error rides inside it.

export interface JobFailure {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export function encodeFailure(error: AppError): string {
  const failure: JobFailure = { code: error.code, message: error.message, retryable: error.retryable };
  return JSON.stringify(failure);
}

export function decodeFailure(reason: string | undefined | null): JobFailure {
  if (reason) {
    try {
      const parsed = JSON.parse(reason) as Partial<JobFailure>;
      if (isErrorCode(parsed.code) && typeof parsed.message === 'string') {
        return { code: parsed.code, message: parsed.message, retryable: parsed.retryable ?? ERROR_CATALOGUE[parsed.code].retryable };
      }
    } catch {
      // not our JSON — fall through to the generic message
    }
  }
  return { code: 'PROCESSING_FAILED', message: ERROR_CATALOGUE.PROCESSING_FAILED.message, retryable: false };
}
