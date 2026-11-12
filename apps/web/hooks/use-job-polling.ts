'use client';

import { useEffect, useRef } from 'react';
import type { JobView } from '@vd/shared';
import { ApiClientError, getJob, isApiClientError } from '@/lib/api-client';

export const POLL_FAST_MS = 1500;
export const POLL_SLOW_MS = 3000;
export const SLOW_AFTER_MS = 60_000;
export const MAX_TRANSIENT_FAILURES = 4;

const TERMINAL = new Set<JobView['status']>(['completed', 'failed', 'expired']);

export function isTerminalStatus(status: JobView['status']): boolean {
  return TERMINAL.has(status);
}

interface UseJobPollingOptions {
  /** Poll while this is non-null; the loop stops on its own at a terminal status. */
  jobId: string | null;
  onUpdate: (job: JobView) => void;
  onError: (error: ApiClientError) => void;
}

/**
 * Polls `GET /api/jobs/:id` without holding an HTTP request open for the whole job.
 * Transient failures (network, 5xx) are retried a few times with the normal cadence before
 * surfacing an error; permanent failures (404, 401…) stop immediately.
 */
export function useJobPolling({ jobId, onUpdate, onError }: UseJobPollingOptions): void {
  const onUpdateRef = useRef(onUpdate);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onUpdateRef.current = onUpdate;
    onErrorRef.current = onError;
  });

  useEffect(() => {
    if (!jobId) return;

    const controller = new AbortController();
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;

    const schedule = () => {
      const delay = Date.now() - startedAt > SLOW_AFTER_MS ? POLL_SLOW_MS : POLL_FAST_MS;
      timer = setTimeout(() => void tick(), delay);
    };

    const tick = async () => {
      try {
        const job = await getJob(jobId, controller.signal);
        if (controller.signal.aborted) return;
        failures = 0;
        onUpdateRef.current(job);
        if (!isTerminalStatus(job.status)) schedule();
      } catch (error) {
        if (controller.signal.aborted) return;
        if (isApiClientError(error) && error.status === 401) return; // redirect to /login already triggered
        const transient = !isApiClientError(error) || error.network || error.retryable || error.status >= 500;
        failures += 1;
        if (transient && failures <= MAX_TRANSIENT_FAILURES) {
          schedule();
          return;
        }
        onErrorRef.current(
          isApiClientError(error)
            ? error
            : new ApiClientError('INTERNAL', 'We lost track of this job. Please try again.', { retryable: true }),
        );
      }
    };

    void tick();

    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [jobId]);
}
