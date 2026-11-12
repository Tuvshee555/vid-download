import { randomUUID } from 'node:crypto';
import {
  AppError,
  FORMAT_MIME,
  JOB_STAGES,
  type CreateJobRequest,
  type CreateJobResponse,
  type JobProgress,
  type JobStage,
  type JobView,
} from '@vd/shared';
import {
  adapterFor,
  decodeFailure,
  mapQueueState,
  uploadKey,
  type AdapterRegistry,
  type AppConfig,
  type MediaJobData,
  type ObjectStorage,
} from '@vd/core';
import type { JobQueue, JobRecord } from './job-queue';
import { detectUrl, sanitizeFilename } from '@vd/shared';

export interface JobServiceDeps {
  config: AppConfig;
  queue: JobQueue;
  storage: ObjectStorage;
  adapters: AdapterRegistry;
}

export class JobService {
  constructor(private readonly deps: JobServiceDeps) {}

  /** Validate the request authoritatively (never trust what /resolve said earlier), then enqueue. */
  async create(request: CreateJobRequest, signal?: AbortSignal): Promise<CreateJobResponse> {
    const { config, queue, storage, adapters } = this.deps;
    const id = randomUUID();
    let data: MediaJobData;

    if (request.source === 'url') {
      const detection = detectUrl(request.url);
      if (!detection.ok) throw new AppError(detection.code, detection.message);
      const adapter = adapterFor(adapters, detection.platform);
      const resolved = await adapter.resolve(detection, signal);

      if (resolved.availability.status === 'unavailable') {
        const { code, message, guidance } = resolved.availability.reason;
        throw new AppError(code, message, { guidance });
      }
      if (!resolved.availability.options.some((option) => option.format === request.format)) {
        throw new AppError('UNSUPPORTED_MEDIA', `${request.format.toUpperCase()} is not available for this media.`);
      }
      data = {
        source: { kind: 'platform', platform: detection.platform, canonicalUrl: detection.canonicalUrl, mediaId: detection.mediaId },
        format: request.format,
        createdAt: new Date().toISOString(),
      };
    } else {
      const info = await storage.head(uploadKey(request.uploadId));
      if (!info) {
        throw new AppError('NOT_FOUND', "That upload wasn't found. It may have expired — please upload the file again.");
      }
      if (info.size > config.limits.maxInputBytes) throw new AppError('FILE_TOO_LARGE');
      data = {
        source: { kind: 'upload', uploadId: request.uploadId, originalName: sanitizeFilename(request.filename, 'upload') },
        format: request.format,
        createdAt: new Date().toISOString(),
      };
    }

    try {
      await queue.add(id, data);
    } catch (error) {
      throw new AppError('INTERNAL', 'The job queue is unavailable right now. Please try again in a moment.', { cause: error, retryable: true, status: 503 });
    }
    return { id, status: 'queued' };
  }

  async view(id: string): Promise<JobView | null> {
    const { config, queue, storage } = this.deps;
    let job: JobRecord | null;
    try {
      job = await queue.get(id);
    } catch (error) {
      throw new AppError('INTERNAL', 'The job queue is unavailable right now. Please try again in a moment.', { cause: error, retryable: true, status: 503 });
    }
    if (!job) return null;

    const baseStatus = mapQueueState(job.state);
    const base = {
      id: job.id,
      format: job.data.format,
      createdAt: new Date(job.createdAtMs).toISOString(),
      maxAttempts: job.maxAttempts,
      attempt: Math.min(job.maxAttempts, Math.max(1, job.attemptsMade + (baseStatus === 'completed' || baseStatus === 'failed' ? 0 : 1))),
    };

    if (baseStatus === 'failed') {
      return { ...base, status: 'failed', progress: { stage: 'done', percent: 0 }, error: decodeFailure(job.failedReason) };
    }

    if (baseStatus === 'completed') {
      const record = job.returnValue;
      const expiresAtMs = record ? Date.parse(record.expiresAt) : 0;
      const expired = !record || !(expiresAtMs > Date.now()) || (await storage.head(record.storageKey)) === null;
      if (!record || expired) {
        return {
          ...base,
          status: 'expired',
          progress: { stage: 'done', percent: 100 },
          error: { code: 'LINK_EXPIRED', message: 'This file has expired and was deleted. Convert the media again to get a new one.', retryable: false },
        };
      }
      const link = await storage.createDownloadUrl(record.storageKey, {
        filename: record.filename,
        contentType: FORMAT_MIME[record.format],
        ttlSeconds: config.limits.linkTtlSeconds,
      });
      return {
        ...base,
        status: 'completed',
        progress: { stage: 'done', percent: 100 },
        result: {
          filename: record.filename,
          format: record.format,
          mimeType: record.mimeType,
          sizeBytes: record.sizeBytes,
          durationSeconds: record.durationSeconds,
          resolution: record.resolution,
          losslessVideo: record.losslessVideo,
          expiresAt: record.expiresAt,
          download: { url: link.url, expiresAt: new Date(Math.min(link.expiresAt.getTime(), expiresAtMs)).toISOString() },
        },
      };
    }

    return { ...base, status: baseStatus, progress: normaliseProgress(job.progress, baseStatus === 'queued') };
  }
}

function normaliseProgress(raw: unknown, queued: boolean): JobProgress {
  if (raw && typeof raw === 'object') {
    const { stage, percent } = raw as { stage?: unknown; percent?: unknown };
    if (typeof percent === 'number' && Number.isFinite(percent) && (JOB_STAGES as readonly unknown[]).includes(stage)) {
      return { stage: stage as JobStage, percent: Math.max(0, Math.min(100, Math.round(percent))) };
    }
  }
  return { stage: queued ? 'queued' : 'resolving', percent: 0 };
}
