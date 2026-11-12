'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { defaultMessage, type JobView, type MediaFormat } from '@vd/shared';
import { ApiClientError, createJob, getJob, isApiClientError, resolveUrl } from '@/lib/api-client';
import { flowReducer, initialFlowState, type FlowError, type FlowState } from '@/hooks/flow-reducer';
import { useJobPolling } from '@/hooks/use-job-polling';

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
  chooseFormat: (format: MediaFormat) => void;
  attachUploadJob: (jobId: string, format: MediaFormat) => void;
  openUpload: () => void;
  closeUpload: () => void;
  retry: () => void;
  reset: () => void;
  /** Re-fetches a finished job to get a fresh signed download link. Resolves to an error, or null on success. */
  refreshLink: () => Promise<FlowError | null>;
}

export function useMediaFlow(): MediaFlow {
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
    (format: MediaFormat) => {
      if (state.phase !== 'options') return;
      cancelInFlight();
      const controller = new AbortController();
      requestRef.current = controller;
      const { url } = state;
      dispatch({ type: 'choose-format', format });
      createJob({ source: 'url', url, format }, controller.signal)
        .then((created) => {
          if (!controller.signal.aborted) dispatch({ type: 'job-created', jobId: created.id });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          dispatch({ type: 'job-create-failed', error: toFlowError(error) });
        });
    },
    [state, cancelInFlight],
  );

  useJobPolling({
    jobId: state.phase === 'polling' ? state.jobId : null,
    onUpdate: (job: JobView) => dispatch({ type: 'job-update', job }),
    onError: (error: ApiClientError) => dispatch({ type: 'job-poll-failed', error: toFlowError(error) }),
  });

  const refreshLink = useCallback(async (): Promise<FlowError | null> => {
    if (state.phase !== 'done') return null;
    try {
      const job = await getJob(state.job.id);
      dispatch({ type: 'job-update', job });
      return null;
    } catch (error) {
      return toFlowError(error);
    }
  }, [state]);

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
    refreshLink,
  };
}
