import type { Redis } from 'ioredis';
import type { AdapterRegistry, AppConfig, ObjectStorage } from '@vd/core';
import type { JobQueue } from './services/job-queue';

/** Everything the HTTP layer needs. Injected so tests can swap Redis/storage/adapters. */
export interface ApiDeps {
  config: AppConfig;
  queue: JobQueue;
  storage: ObjectStorage;
  adapters: AdapterRegistry;
  /** Optional Redis connection for shared rate-limit counters (in-memory when absent). */
  rateLimitRedis?: Redis;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook on authenticated routes. */
    session?: { expiresAt: Date };
  }
}
