import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError, getJob } from '@/lib/api-client';
import {
  MAX_TRANSIENT_FAILURES,
  POLL_FAST_MS,
  POLL_SLOW_MS,
  SLOW_AFTER_MS,
  useJobPolling,
} from '@/hooks/use-job-polling';
import { completedJob, JOB_ID, makeJob } from '@/test/fixtures';

vi.mock('@/lib/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-client')>();
  return { ...actual, getJob: vi.fn() };
});

const getJobMock = vi.mocked(getJob);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  getJobMock.mockReset();
});

/** Lets the pending promise chain settle without advancing the fake clock. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function mount(jobId: string | null = JOB_ID) {
  const onUpdate = vi.fn();
  const onError = vi.fn();
  const view = renderHook((props: { jobId: string | null }) => useJobPolling({ jobId: props.jobId, onUpdate, onError }), {
    initialProps: { jobId },
  });
  return { onUpdate, onError, ...view };
}

describe('useJobPolling', () => {
  it('does nothing without a job id', async () => {
    mount(null);
    await advance(10_000);
    expect(getJobMock).not.toHaveBeenCalled();
  });

  it('polls immediately, then on the fast cadence, and stops at a terminal status', async () => {
    getJobMock
      .mockResolvedValueOnce(makeJob({ status: 'queued' }))
      .mockResolvedValueOnce(makeJob({ status: 'processing', progress: { stage: 'converting', percent: 50 } }))
      .mockResolvedValueOnce(completedJob());
    const { onUpdate } = mount();

    await flush();
    expect(getJobMock).toHaveBeenCalledTimes(1);

    await advance(POLL_FAST_MS);
    expect(getJobMock).toHaveBeenCalledTimes(2);

    await advance(POLL_FAST_MS);
    expect(getJobMock).toHaveBeenCalledTimes(3);
    expect(onUpdate).toHaveBeenCalledTimes(3);
    expect(onUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'completed' }));

    await advance(POLL_SLOW_MS * 5);
    expect(getJobMock).toHaveBeenCalledTimes(3);
  });

  it.each(['failed', 'expired'] as const)('stops on %s', async (status) => {
    getJobMock.mockResolvedValue(makeJob({ status }));
    const { onUpdate } = mount();
    await flush();
    await advance(POLL_SLOW_MS * 3);
    expect(getJobMock).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it('backs off to the slow cadence after a minute', async () => {
    getJobMock.mockResolvedValue(makeJob({ status: 'processing' }));
    mount();
    await flush();

    await advance(SLOW_AFTER_MS + POLL_FAST_MS);
    const callsAfterOneMinute = getJobMock.mock.calls.length;

    await advance(POLL_FAST_MS + 100);
    expect(getJobMock.mock.calls.length).toBe(callsAfterOneMinute); // no fast poll any more

    await advance(POLL_SLOW_MS);
    expect(getJobMock.mock.calls.length).toBe(callsAfterOneMinute + 1);
  });

  it('retries transient errors without surfacing them', async () => {
    getJobMock
      .mockRejectedValueOnce(new ApiClientError('NETWORK_TIMEOUT', 'offline', { network: true, retryable: true }))
      .mockRejectedValueOnce(new ApiClientError('PLATFORM_API_ERROR', 'bad gateway', { status: 502, retryable: true }))
      .mockResolvedValueOnce(completedJob());
    const { onUpdate, onError } = mount();

    await flush();
    await advance(POLL_FAST_MS);
    await advance(POLL_FAST_MS);

    expect(onError).not.toHaveBeenCalled();
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'completed' }));
  });

  it('gives up after repeated transient failures', async () => {
    getJobMock.mockRejectedValue(new ApiClientError('NETWORK_TIMEOUT', 'offline', { network: true, retryable: true }));
    const { onError } = mount();

    await flush();
    for (let i = 0; i < MAX_TRANSIENT_FAILURES; i += 1) await advance(POLL_FAST_MS);

    expect(getJobMock).toHaveBeenCalledTimes(MAX_TRANSIENT_FAILURES + 1);
    expect(onError).toHaveBeenCalledOnce();
    await advance(POLL_SLOW_MS * 3);
    expect(getJobMock).toHaveBeenCalledTimes(MAX_TRANSIENT_FAILURES + 1);
  });

  it('stops immediately on a permanent error', async () => {
    getJobMock.mockRejectedValue(new ApiClientError('NOT_FOUND', 'gone', { status: 404 }));
    const { onError } = mount();
    await flush();
    await advance(POLL_SLOW_MS * 3);
    expect(getJobMock).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('does not report anything after a 401 (the client already redirects)', async () => {
    getJobMock.mockRejectedValue(new ApiClientError('UNAUTHENTICATED', 'sign in', { status: 401 }));
    const { onError } = mount();
    await flush();
    await advance(POLL_SLOW_MS * 3);
    expect(getJobMock).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it('aborts and stops polling on unmount', async () => {
    getJobMock.mockResolvedValue(makeJob({ status: 'processing' }));
    const { unmount } = mount();
    await flush();
    const signal = getJobMock.mock.calls[0]![1] as AbortSignal;
    expect(signal.aborted).toBe(false);

    unmount();
    expect(signal.aborted).toBe(true);
    await advance(POLL_SLOW_MS * 3);
    expect(getJobMock).toHaveBeenCalledTimes(1);
  });

  it('restarts for a new job id', async () => {
    getJobMock.mockResolvedValue(makeJob({ status: 'processing' }));
    const { rerender } = mount();
    await flush();
    rerender({ jobId: '8c7bd2e0-1a6e-4b73-9d4a-2f1e0f6b7c21' });
    await flush();
    expect(getJobMock.mock.calls.map((call) => call[0])).toEqual([JOB_ID, '8c7bd2e0-1a6e-4b73-9d4a-2f1e0f6b7c21']);
  });
});
