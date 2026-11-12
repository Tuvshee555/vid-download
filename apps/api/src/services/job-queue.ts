import type { Redis } from 'ioredis';
import type { JobResultRecord } from '@vd/shared';
import type { MediaJobData, MediaQueue } from '@vd/core';
import { mediaJobOptions, type AppConfig } from '@vd/core';

/** The slice of a BullMQ job the API needs, decoupled so tests can run without Redis. */
export interface JobRecord {
  id: string;
  /** BullMQ state name: waiting | delayed | active | completed | failed | … */
  state: string;
  data: MediaJobData;
  progress: unknown;
  returnValue: JobResultRecord | null;
  failedReason: string | undefined;
  attemptsMade: number;
  maxAttempts: number;
  createdAtMs: number;
}

export interface JobQueue {
  add(id: string, data: MediaJobData): Promise<void>;
  get(id: string): Promise<JobRecord | null>;
  /** True when the backing store (Redis) answers. */
  ping(): Promise<boolean>;
}

export class BullJobQueue implements JobQueue {
  constructor(
    private readonly queue: MediaQueue,
    private readonly config: AppConfig,
    private readonly redis: Redis,
  ) {}

  async add(id: string, data: MediaJobData): Promise<void> {
    await this.queue.add('convert', data, mediaJobOptions(this.config, id));
  }

  async get(id: string): Promise<JobRecord | null> {
    const job = await this.queue.getJob(id);
    if (!job || job.id === undefined) return null;
    const state = await job.getState();
    return {
      id: job.id,
      state,
      data: job.data,
      progress: job.progress,
      returnValue: (job.returnvalue) ?? null,
      failedReason: job.failedReason,
      attemptsMade: job.attemptsMade,
      maxAttempts: job.opts.attempts ?? 1,
      createdAtMs: job.timestamp,
    };
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }
}
