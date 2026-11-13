'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { defaultMessage, type JobView, type MediaFormat, type MediaOption } from '@vd/shared';
import { ApiClientError, convertStream, createJob, getJob, isApiClientError, resolveUrl } from '@/lib/api-client';
import { flowReducer, initialFlowState, type FlowError, type FlowState } from '@/hooks/flow-reducer';
import { useJobPolling } from '@/hooks/use-job-polling';

/**
 * `proxy`: create a job on the self-hosted API, then poll it.
 * `standalone`: one streaming request converts and reports progress (single Vercel deployment).
 */
export type FlowMode = 'proxy' | 'standalone';

export function toFlowError(error: unknown): FlowError {
  if (isApiClientError(error)) {
    return { code: error.code, message: error.message, guidance: error.guidance, retryable: error.retryable };
  }
  return { code: 'INTERNAL', message: defaultMessage('INTERNAL'), guidance: [], retryable: true };
}

export interface MediaFlow {
  state: FlowState;
  /** Bumps when the user starts over (or hands off to an upload) so the URL field can be cleared via `key`. */
  generation: number;
  submit: (url: string) => void;
  chooseFormat: (option: MediaOption) => void;
  attachUploadJob: (jobId: string, format: MediaFormat) => void;
  openUpload: () => void;
  closeUpload: () => void;
  retry: () => void;
  reset: () => void;
  /** Whether download links are short-lived and can be re-issued (proxy mode only). */
  canRefreshLink: boolean;
  /** Re-fetches a finished job to get a fresh signed download link. Resolves to an error, or null on success. */
  refreshLink: () => Promise<FlowError | null>;
}

export function useMediaFlow(mode: FlowMode = 'proxy'): MediaFlow {
  const [state, dispatch] = useReducer(flowReducer, initialFlowState);
  const [generation, setGeneration] = useState(0);
  const requestRef = useRef<AbortController | null>(null);

  const cancelInFlight = useCallback(() => {
    requestRef.current?.abort();
    requestRef.current = null;
  }, []);

  useEffect(() => cancelInFlight, [cancelInFlight]);

  const submit = useCallback(
    (url: string) => {
      cancelInFlight();
      const controller = new AbortController();
      requestRef.current = controller;
      dispatch({ type: 'submit', url });
      resolveUrl(url, controller.signal)
        .then((response) => {
          if (!controller.signal.aborted) dispatch({ type: 'resolved', response });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          dispatch({ type: 'resolve-failed', error: toFlowError(error) });
        });
    },
    [cancelInFlight],
  );

  const chooseFormat = useCallback(
    (option: MediaOption) => {
      if (state.phase !== 'options') return;
      cancelInFlight();
      const controller = new AbortController();
      requestRef.current = controller;
      const { url } = state;
      const request = { source: 'url' as const, url, format: option.format, ...(option.quality ? { quality: option.quality } : {}) };
      dispatch({ type: 'choose-format', format: option.format });

      if (mode === 'standalone') {
        let created = false;
        convertStream(
          request,
          (job: JobView) => {
            if (controller.signal.aborted) return;
            if (!created) {
              created = true;
              dispatch({ type: 'job-created', jobId: job.id });
            }
            dispatch({ type: 'job-update', job });
          },
          controller.signal,
        ).catch((error: unknown) => {
          if (controller.signal.aborted) return;
          dispatch({ type: created ? 'job-poll-failed' : 'job-create-failed', error: toFlowError(error) });
        });
        return;
      }

      createJob(request, controller.signal)
        .then((job) => {
          if (!controller.signal.aborted) dispatch({ type: 'job-created', jobId: job.id });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          dispatch({ type: 'job-create-failed', error: toFlowError(error) });
        });
    },
    [state, cancelInFlight, mode],
  );

  useJobPolling({
    // In standalone mode updates arrive on the conversion stream; there is nothing to poll.
    jobId: mode === 'proxy' && state.phase === 'polling' ? state.jobId : null,
    onUpdate: (job: JobView) => dispatch({ type: 'job-update', job }),
    onError: (error: ApiClientError) => dispatch({ type: 'job-poll-failed', error: toFlowError(error) }),
  });

  const refreshLink = useCallback(async (): Promise<FlowError | null> => {
    if (state.phase !== 'done' || mode !== 'proxy') return null;
    try {
      const job = await getJob(state.job.id);
      dispatch({ type: 'job-update', job });
      return null;
    } catch (error) {
      return toFlowError(error);
    }
  }, [state, mode]);

  return {
    state,
    generation,
    submit,
    chooseFormat,
    attachUploadJob: useCallback((jobId: string, format: MediaFormat) => {
      // The result belongs to the uploaded file, so drop any previously typed link.
      setGeneration((value) => value + 1);
      dispatch({ type: 'upload-job-created', jobId, format });
    }, []),
    openUpload: useCallback(() => dispatch({ type: 'open-upload' }), []),
    closeUpload: useCallback(() => dispatch({ type: 'close-upload' }), []),
    retry: useCallback(() => dispatch({ type: 'retry' }), []),
    reset: useCallback(() => {
      cancelInFlight();
      setGeneration((value) => value + 1);
      dispatch({ type: 'reset' });
    }, [cancelInFlight]),
    canRefreshLink: mode === 'proxy',
    refreshLink,
  };
}
