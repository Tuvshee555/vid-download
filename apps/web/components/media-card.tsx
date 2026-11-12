'use client';

import { useState } from 'react';
import { Clock, User } from 'lucide-react';
import { formatDuration, type ResolveResponse } from '@vd/shared';
import { PlatformIcon } from '@/components/platform-icons';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';

export function MediaCard({ resolved }: { resolved: ResolveResponse }) {
  const { metadata } = resolved;
  const [imageFailed, setImageFailed] = useState(false);
  const thumbnail = metadata?.thumbnailUrl && !imageFailed ? metadata.thumbnailUrl : null;

  return (
    <Card className="flex flex-col gap-4 overflow-hidden p-4 sm:flex-row sm:items-center sm:p-5">
      {thumbnail ? (
        <div className="aspect-video w-full shrink-0 overflow-hidden rounded-xl bg-neutral-100 sm:w-48">
          {/* Remote thumbnails come from the platform's own CDN; next/image would need a per-host allowlist. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={thumbnail}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setImageFailed(true)}
            className="size-full object-cover"
          />
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 items-start gap-3.5">
        {!thumbnail ? (
          <span
            aria-hidden
            className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-neutral-100 text-neutral-600"
          >
            <PlatformIcon platform={resolved.platform} className="size-5" />
          </span>
        ) : null}
        <div className="min-w-0 flex-1 space-y-2.5">
          <h2 className="line-clamp-2 text-lg font-semibold leading-snug" data-testid="media-title">
            {metadata?.title ?? 'Details not available for this link'}
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">
              <PlatformIcon platform={resolved.platform} className="size-3.5" />
              {resolved.platformName}
            </Badge>
            {metadata?.author ? (
              <Badge variant="neutral" className="max-w-full">
                <User aria-hidden />
                <span className="truncate">{metadata.author}</span>
              </Badge>
            ) : null}
            {metadata?.durationSeconds != null ? (
              <Badge variant="neutral">
                <Clock aria-hidden />
                {formatDuration(metadata.durationSeconds)}
              </Badge>
            ) : null}
          </div>
          {!metadata ? <p className="break-all text-sm text-muted">{resolved.canonicalUrl}</p> : null}
        </div>
      </div>
    </Card>
  );
}
