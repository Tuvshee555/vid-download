import { OUTPUT_PREFIX, UPLOAD_PREFIX, type Logger, type ObjectStorage } from '@vd/core';

export interface SweepResult {
  deleted: number;
  failed: number;
}

/**
 * Delete expired objects. Outputs live for `ttlMs`; uploads get a little longer because a
 * queued job may still need them. Safe to run from several workers at once (deletes are
 * idempotent) and safe to re-run after a crash.
 */
export async function sweepExpiredObjects(
  storage: ObjectStorage,
  ttlMs: number,
  log: Logger,
  now = Date.now(),
): Promise<SweepResult> {
  const plans: Array<{ prefix: string; maxAgeMs: number }> = [
    { prefix: OUTPUT_PREFIX, maxAgeMs: ttlMs },
    { prefix: UPLOAD_PREFIX, maxAgeMs: ttlMs + 30 * 60_000 },
  ];
  const result: SweepResult = { deleted: 0, failed: 0 };

  for (const { prefix, maxAgeMs } of plans) {
    let objects;
    try {
      objects = await storage.list(prefix);
    } catch (error) {
      log.error({ err: error, prefix }, 'cleanup: could not list storage');
      result.failed += 1;
      continue;
    }
    for (const object of objects) {
      if (now - object.lastModified.getTime() <= maxAgeMs) continue;
      // Local storage lists in-flight uploads as "<key>.part"; deleting the base key removes both.
      const key = object.key.replace(/\.part$/, '');
      try {
        await storage.delete(key);
        result.deleted += 1;
      } catch (error) {
        result.failed += 1;
        log.warn({ err: error, key }, 'cleanup: could not delete object');
      }
    }
  }
  return result;
}
