import { describe, expect, it } from 'vitest';
import { AppError } from '@vd/shared';
import { loadConfig } from './config';
import { decodeFailure, encodeFailure, mapQueueState, mediaJobOptions } from './queue';

describe('queue helpers', () => {
  it('maps BullMQ states to the public statuses', () => {
    expect(mapQueueState('waiting')).toBe('queued');
    expect(mapQueueState('delayed')).toBe('queued'); // retry back-off
    expect(mapQueueState('prioritized')).toBe('queued');
    expect(mapQueueState('active')).toBe('processing');
    expect(mapQueueState('completed')).toBe('completed');
    expect(mapQueueState('failed')).toBe('failed');
    expect(mapQueueState('mystery')).toBe('queued');
  });

  it('round-trips structured failures through BullMQ failedReason', () => {
    const encoded = encodeFailure(new AppError('FILE_TOO_LARGE', 'Too big', { retryable: false }));
    expect(decodeFailure(encoded)).toEqual({ code: 'FILE_TOO_LARGE', message: 'Too big', retryable: false });
  });

  it('falls back to a generic failure for foreign or missing reasons (never leaks internals)', () => {
    for (const reason of [undefined, null, '', 'ENOENT: no such file /srv/secret/path', '{"code":"NOPE","message":"x"}']) {
      const failure = decodeFailure(reason);
      expect(failure.code).toBe('PROCESSING_FAILED');
      expect(failure.message).not.toContain('/srv/secret');
    }
  });

  it('builds job options with retries, back-off and retention beyond the file lifetime', () => {
    const config = loadConfig({ FILE_TTL_MINUTES: '30', JOB_MAX_ATTEMPTS: '3' });
    const options = mediaJobOptions(config, 'abc');
    expect(options).toMatchObject({ jobId: 'abc', attempts: 3, backoff: { type: 'exponential' } });
    expect((options.removeOnComplete as { age: number }).age).toBeGreaterThan(30 * 60);
  });
});
