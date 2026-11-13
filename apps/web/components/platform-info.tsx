'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { formatBytes, type PlatformsResponse } from '@vd/shared';
import { PlatformIcon } from '@/components/platform-icons';
import { Badge } from '@/components/ui/badge';
import { getPlatforms } from '@/lib/api-client';

type Load = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; data: PlatformsResponse } | { status: 'failed' };

/** Honest, server-driven summary of what each integration can and cannot do. */
export function PlatformInfo() {
  const [load, setLoad] = useState<Load>({ status: 'idle' });

  function onToggle(event: React.SyntheticEvent<HTMLDetailsElement>) {
    if (!event.currentTarget.open || load.status === 'loading' || load.status === 'ready') return;
    setLoad({ status: 'loading' });
    getPlatforms()
      .then((data) => setLoad({ status: 'ready', data }))
      .catch(() => setLoad({ status: 'failed' }));
  }

  return (
    <details onToggle={onToggle} className="group rounded-2xl border border-line bg-surface shadow-sm">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-2xl px-5 py-4 font-medium [&::-webkit-details-marker]:hidden">
        What can MediaDock download?
        <ChevronDown className="size-5 text-muted transition-transform group-open:rotate-180" aria-hidden />
      </summary>
      <div className="space-y-4 border-t border-line px-5 py-4 text-sm">
        {load.status === 'loading' || load.status === 'idle' ? <p className="text-muted">Loading…</p> : null}
        {load.status === 'failed' ? (
          <p className="text-muted">
            We couldn&apos;t load the platform details right now. In short: MediaDock only converts media you are
            allowed to download — your own videos through the platforms&apos; official APIs, or files you upload.
          </p>
        ) : null}
        {load.status === 'ready' ? (
          <>
            <ul className="space-y-4">
              {load.data.platforms.map((platform) => (
                <li key={platform.platform} className="flex gap-3">
                  <PlatformIcon platform={platform.platform} className="mt-0.5 size-5 shrink-0 text-neutral-600" />
                  <div className="space-y-1">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      {platform.name}
                      {platform.capability === 'public-links' ? (
                        <Badge variant="success">Public videos</Badge>
                      ) : platform.capability === 'own-media' ? (
                        <>
                          <Badge variant="success">Your own media</Badge>
                          {!platform.configured ? <Badge variant="warning">Not connected</Badge> : null}
                        </>
                      ) : (
                        <Badge variant="neutral">Details only</Badge>
                      )}
                    </p>
                    <p className="leading-relaxed text-muted">{platform.summary}</p>
                  </div>
                </li>
              ))}
            </ul>
            <p className="border-t border-line pt-3 text-muted">
              Limits: uploads up to {formatBytes(load.data.limits.maxUploadBytes)}, media up to{' '}
              {Math.round(load.data.limits.maxDurationSeconds / 60)} minutes, files kept for{' '}
              {load.data.limits.fileTtlMinutes} minutes.
            </p>
          </>
        ) : null}
      </div>
    </details>
  );
}
