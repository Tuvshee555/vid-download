'use client';

import { Loader2 } from 'lucide-react';
import { defaultMessage, type ResolveResponse } from '@vd/shared';
import { FlowErrorPanel } from '@/components/flow-error';
import { FormatOptions } from '@/components/format-options';
import { JobProgress } from '@/components/job-progress';
import { MediaCard } from '@/components/media-card';
import { PlatformNotice } from '@/components/platform-notice';
import { ResultCard } from '@/components/result-card';
import { UploadPanel } from '@/components/upload-panel';
import { Card } from '@/components/ui/card';
import type { FlowState } from '@/hooks/flow-reducer';
import type { MediaFlow } from '@/hooks/use-media-flow';

function resolvedOf(state: FlowState): ResolveResponse | null {
  switch (state.phase) {
    case 'options':
    case 'unavailable':
    case 'creating-job':
      return state.resolved;
    case 'polling':
    case 'done':
    case 'failed':
    case 'expired':
      return state.source.kind === 'url' ? state.source.resolved : null;
    default:
      return null;
  }
}

/** Renders the part of the page that depends on where the user is in the flow. */
export function FlowView({ flow }: { flow: MediaFlow }) {
  const { state } = flow;
  const resolved = resolvedOf(state);
  const card = resolved ? <MediaCard resolved={resolved} /> : null;

  switch (state.phase) {
    case 'idle':
      return null;

    case 'resolving':
      return (
        <Card className="flex items-center gap-3 p-5" role="status" aria-live="polite">
          <Loader2 className="size-5 animate-spin text-brand-600 motion-reduce:animate-none" aria-hidden />
          <span className="font-medium">Checking this link…</span>
        </Card>
      );

    case 'options':
      return (
        <div className="space-y-5">
          {card}
          <section className="space-y-3" aria-labelledby="formats-heading">
            <h2 id="formats-heading" className="text-sm font-semibold uppercase tracking-wide text-muted">
              Choose a format
            </h2>
            {state.resolved.availability.status === 'available' ? (
              <FormatOptions options={state.resolved.availability.options} onSelect={flow.chooseFormat} />
            ) : null}
          </section>
        </div>
      );

    case 'unavailable':
      return (
        <div className="space-y-5">
          {card}
          {state.resolved.availability.status === 'unavailable' ? (
            <PlatformNotice
              reason={state.resolved.availability.reason}
              platformName={state.resolved.platformName}
              onConvertOwnFile={state.resolved.uploadEnabled ? flow.openUpload : undefined}
            />
          ) : null}
        </div>
      );

    case 'error':
      return (
        <FlowErrorPanel
          error={state.error}
          primaryLabel={state.error.retryable ? 'Try again' : 'Check another link'}
          onPrimary={() => (state.error.retryable ? flow.submit(state.url) : flow.reset())}
          onStartOver={state.error.retryable ? flow.reset : undefined}
        />
      );

    case 'upload':
      return <UploadPanel onJobCreated={flow.attachUploadJob} onCancel={flow.closeUpload} />;

    case 'creating-job':
      return (
        <div className="space-y-5">
          {card}
          <JobProgress job={null} format={state.format} />
        </div>
      );

    case 'polling':
      return (
        <div className="space-y-5">
          {card}
          <JobProgress job={state.job} format={state.format} />
        </div>
      );

    case 'done':
      return (
        <div className="space-y-5">
          {card}
          {state.job.result ? (
            <ResultCard result={state.job.result} onRefreshLink={flow.refreshLink} onReset={flow.reset} />
          ) : null}
        </div>
      );

    case 'failed':
      return (
        <div className="space-y-5">
          {card}
          <FlowErrorPanel
            error={state.error}
            primaryLabel="Try again"
            onPrimary={flow.retry}
            onStartOver={flow.reset}
          />
        </div>
      );

    case 'expired':
      return (
        <div className="space-y-5">
          {card}
          <FlowErrorPanel
            error={{ code: 'LINK_EXPIRED', message: defaultMessage('LINK_EXPIRED'), guidance: [], retryable: false }}
            primaryLabel="Convert again"
            onPrimary={flow.retry}
            onStartOver={flow.reset}
          />
        </div>
      );
  }
}
