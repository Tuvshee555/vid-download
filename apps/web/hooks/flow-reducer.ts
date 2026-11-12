/**
 * Pure state machine for the download flow. Kept free of React so every transition can be
 * unit-tested.
 *
 *   idle → resolving → options | unavailable | error
 *   options → creating-job → polling → done | failed | expired
 *   idle/unavailable → upload → polling → …
 */
import type { ErrorCode, JobView, MediaFormat, ResolveResponse } from '@vd/shared';

export interface FlowError {
  code: ErrorCode;
  message: string;
  guidance: string[];
  retryable: boolean;
}

/** Where the current job came from, so "Try again" can go back to the right place. */
export type JobSource = { kind: 'url'; url: string; resolved: ResolveResponse } | { kind: 'upload' };

export type FlowState =
  | { phase: 'idle' }
  | { phase: 'resolving'; url: string }
  | { phase: 'options'; url: string; resolved: ResolveResponse }
  | { phase: 'unavailable'; url: string; resolved: ResolveResponse }
  | { phase: 'error'; url: string; error: FlowError }
  | { phase: 'upload'; returnTo: ResolveResponse | null }
  | { phase: 'creating-job'; url: string; resolved: ResolveResponse; format: MediaFormat }
  | { phase: 'polling'; jobId: string; format: MediaFormat; job: JobView | null; source: JobSource }
  | { phase: 'done'; job: JobView; source: JobSource }
  | { phase: 'failed'; job: JobView | null; error: FlowError; source: JobSource }
  | { phase: 'expired'; job: JobView; source: JobSource };

export type FlowAction =
  | { type: 'submit'; url: string }
  | { type: 'resolved'; response: ResolveResponse }
  | { type: 'resolve-failed'; error: FlowError }
  | { type: 'choose-format'; format: MediaFormat }
  | { type: 'job-created'; jobId: string }
  | { type: 'job-create-failed'; error: FlowError }
  | { type: 'upload-job-created'; jobId: string; format: MediaFormat }
  | { type: 'job-update'; job: JobView }
  | { type: 'job-poll-failed'; error: FlowError }
  | { type: 'open-upload' }
  | { type: 'close-upload' }
  | { type: 'retry' }
  | { type: 'reset' };

export const initialFlowState: FlowState = { phase: 'idle' };

function sourceOf(state: FlowState): JobSource | null {
  if (state.phase === 'polling' || state.phase === 'done' || state.phase === 'failed' || state.phase === 'expired') {
    return state.source;
  }
  if (state.phase === 'creating-job') return { kind: 'url', url: state.url, resolved: state.resolved };
  return null;
}

function applyJob(state: FlowState, job: JobView): FlowState {
  const source = sourceOf(state);
  if (!source) return state; // a late poll result after the user started over — ignore
  switch (job.status) {
    case 'queued':
    case 'processing':
      return { phase: 'polling', jobId: job.id, format: job.format, job, source };
    case 'completed':
      return job.result ? { phase: 'done', job, source } : state;
    case 'expired':
      return { phase: 'expired', job, source };
    case 'failed':
      return {
        phase: 'failed',
        job,
        source,
        error: {
          code: job.error?.code ?? 'PROCESSING_FAILED',
          message: job.error?.message ?? 'Processing failed. Please try again.',
          guidance: [],
          retryable: job.error?.retryable ?? false,
        },
      };
  }
}

export function flowReducer(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case 'submit':
      return { phase: 'resolving', url: action.url };

    case 'resolved': {
      if (state.phase !== 'resolving') return state;
      return action.response.availability.status === 'available'
        ? { phase: 'options', url: state.url, resolved: action.response }
        : { phase: 'unavailable', url: state.url, resolved: action.response };
    }

    case 'resolve-failed':
      return state.phase === 'resolving' ? { phase: 'error', url: state.url, error: action.error } : state;

    case 'choose-format':
      return state.phase === 'options'
        ? { phase: 'creating-job', url: state.url, resolved: state.resolved, format: action.format }
        : state;

    case 'job-created':
      return state.phase === 'creating-job'
        ? {
            phase: 'polling',
            jobId: action.jobId,
            format: state.format,
            job: null,
            source: { kind: 'url', url: state.url, resolved: state.resolved },
          }
        : state;

    case 'job-create-failed':
      return state.phase === 'creating-job'
        ? {
            phase: 'failed',
            job: null,
            error: action.error,
            source: { kind: 'url', url: state.url, resolved: state.resolved },
          }
        : state;

    case 'upload-job-created':
      return state.phase === 'upload'
        ? { phase: 'polling', jobId: action.jobId, format: action.format, job: null, source: { kind: 'upload' } }
        : state;

    case 'job-update':
      return applyJob(state, action.job);

    case 'job-poll-failed': {
      const source = sourceOf(state);
      if (state.phase !== 'polling' || !source) return state;
      return { phase: 'failed', job: state.job, error: action.error, source };
    }

    case 'open-upload': {
      const returnTo = state.phase === 'unavailable' || state.phase === 'options' ? state.resolved : null;
      return { phase: 'upload', returnTo };
    }

    case 'close-upload': {
      if (state.phase !== 'upload') return state;
      if (!state.returnTo) return { phase: 'idle' };
      const url = state.returnTo.canonicalUrl;
      return state.returnTo.availability.status === 'available'
        ? { phase: 'options', url, resolved: state.returnTo }
        : { phase: 'unavailable', url, resolved: state.returnTo };
    }

    case 'retry': {
      if (state.phase !== 'failed' && state.phase !== 'expired') return state;
      if (state.source.kind === 'upload') return { phase: 'upload', returnTo: null };
      const { url, resolved } = state.source;
      return resolved.availability.status === 'available'
        ? { phase: 'options', url, resolved }
        : { phase: 'unavailable', url, resolved };
    }

    case 'reset':
      return initialFlowState;
  }
}
