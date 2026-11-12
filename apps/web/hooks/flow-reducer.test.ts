import { describe, expect, it } from 'vitest';
import { flowReducer, initialFlowState, type FlowError, type FlowState } from '@/hooks/flow-reducer';
import { availableResolve, completedJob, JOB_ID, makeJob, unavailableResolve } from '@/test/fixtures';

const URL_A = 'https://www.instagram.com/reel/Cabc123XYZ/';
const error: FlowError = { code: 'PLATFORM_API_ERROR', message: 'boom', guidance: [], retryable: true };

function run(actions: Parameters<typeof flowReducer>[1][], from: FlowState = initialFlowState): FlowState {
  return actions.reduce(flowReducer, from);
}

describe('flowReducer', () => {
  it('goes idle → resolving → options when media is available', () => {
    const state = run([{ type: 'submit', url: URL_A }, { type: 'resolved', response: availableResolve() }]);
    expect(state.phase).toBe('options');
  });

  it('goes to unavailable when the API reports no permitted route', () => {
    const state = run([{ type: 'submit', url: URL_A }, { type: 'resolved', response: unavailableResolve() }]);
    expect(state.phase).toBe('unavailable');
  });

  it('records resolve failures', () => {
    const state = run([{ type: 'submit', url: URL_A }, { type: 'resolve-failed', error }]);
    expect(state).toMatchObject({ phase: 'error', url: URL_A, error });
  });

  it('ignores a late resolve result after the user started over', () => {
    const state = run([{ type: 'submit', url: URL_A }, { type: 'reset' }, { type: 'resolved', response: availableResolve() }]);
    expect(state.phase).toBe('idle');
  });

  it('runs the happy path to done', () => {
    let state = run([
      { type: 'submit', url: URL_A },
      { type: 'resolved', response: availableResolve() },
      { type: 'choose-format', format: 'mp3' },
    ]);
    expect(state).toMatchObject({ phase: 'creating-job', format: 'mp3' });

    state = run([{ type: 'job-created', jobId: JOB_ID }], state);
    expect(state).toMatchObject({ phase: 'polling', jobId: JOB_ID, format: 'mp3', job: null });

    state = run([{ type: 'job-update', job: makeJob({ status: 'processing', progress: { stage: 'converting', percent: 40 } }) }], state);
    expect(state).toMatchObject({ phase: 'polling', job: { progress: { percent: 40 } } });

    state = run([{ type: 'job-update', job: completedJob() }], state);
    expect(state.phase).toBe('done');
  });

  it('only allows choosing a format from the options phase', () => {
    expect(run([{ type: 'choose-format', format: 'mp4' }]).phase).toBe('idle');
    const unavailable = run([{ type: 'submit', url: URL_A }, { type: 'resolved', response: unavailableResolve() }]);
    expect(flowReducer(unavailable, { type: 'choose-format', format: 'mp4' })).toBe(unavailable);
  });

  it('maps failed and expired jobs, using the API error', () => {
    const polling = run([
      { type: 'submit', url: URL_A },
      { type: 'resolved', response: availableResolve() },
      { type: 'choose-format', format: 'mp4' },
      { type: 'job-created', jobId: JOB_ID },
    ]);

    const failed = flowReducer(polling, {
      type: 'job-update',
      job: makeJob({ status: 'failed', error: { code: 'PROCESSING_FAILED', message: 'Corrupt file', retryable: false } }),
    });
    expect(failed).toMatchObject({ phase: 'failed', error: { code: 'PROCESSING_FAILED', message: 'Corrupt file' } });

    const expired = flowReducer(polling, { type: 'job-update', job: makeJob({ status: 'expired' }) });
    expect(expired.phase).toBe('expired');
  });

  it('does not treat a completed job without a result as done', () => {
    const polling = run([
      { type: 'submit', url: URL_A },
      { type: 'resolved', response: availableResolve() },
      { type: 'choose-format', format: 'mp4' },
      { type: 'job-created', jobId: JOB_ID },
    ]);
    expect(flowReducer(polling, { type: 'job-update', job: makeJob({ status: 'completed' }) }).phase).toBe('polling');
  });

  it('fails the job when creating it fails, and polling errors surface as failed', () => {
    const creating = run([
      { type: 'submit', url: URL_A },
      { type: 'resolved', response: availableResolve() },
      { type: 'choose-format', format: 'mp4' },
    ]);
    expect(flowReducer(creating, { type: 'job-create-failed', error }).phase).toBe('failed');

    const polling = flowReducer(creating, { type: 'job-created', jobId: JOB_ID });
    expect(flowReducer(polling, { type: 'job-poll-failed', error })).toMatchObject({ phase: 'failed', error });
  });

  it('retry returns to the options (or unavailable) screen for URL jobs', () => {
    const failed = run([
      { type: 'submit', url: URL_A },
      { type: 'resolved', response: availableResolve() },
      { type: 'choose-format', format: 'mp4' },
      { type: 'job-create-failed', error },
    ]);
    expect(flowReducer(failed, { type: 'retry' }).phase).toBe('options');
  });

  it('upload flow: open → job created → polling; retry goes back to the upload form', () => {
    let state = run([{ type: 'open-upload' }]);
    expect(state).toMatchObject({ phase: 'upload', returnTo: null });

    state = flowReducer(state, { type: 'upload-job-created', jobId: JOB_ID, format: 'mp3' });
    expect(state).toMatchObject({ phase: 'polling', source: { kind: 'upload' } });

    state = flowReducer(state, { type: 'job-poll-failed', error });
    expect(flowReducer(state, { type: 'retry' })).toMatchObject({ phase: 'upload' });
  });

  it('closing the upload panel returns to where the user was', () => {
    const unavailable = run([{ type: 'submit', url: URL_A }, { type: 'resolved', response: unavailableResolve() }]);
    const upload = flowReducer(unavailable, { type: 'open-upload' });
    expect(upload.phase).toBe('upload');
    expect(flowReducer(upload, { type: 'close-upload' }).phase).toBe('unavailable');
    expect(run([{ type: 'open-upload' }, { type: 'close-upload' }]).phase).toBe('idle');
  });

  it('ignores job updates when there is no job in flight', () => {
    expect(flowReducer(initialFlowState, { type: 'job-update', job: completedJob() })).toBe(initialFlowState);
  });

  it('reset always returns to idle', () => {
    const done = run([
      { type: 'submit', url: URL_A },
      { type: 'resolved', response: availableResolve() },
      { type: 'choose-format', format: 'mp4' },
      { type: 'job-created', jobId: JOB_ID },
      { type: 'job-update', job: completedJob() },
    ]);
    expect(flowReducer(done, { type: 'reset' })).toEqual(initialFlowState);
  });
});
