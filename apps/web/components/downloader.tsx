'use client';

import { useState } from 'react';
import { FileUp } from 'lucide-react';
import type { Platform } from '@vd/shared';
import type { FlowMode } from '@/hooks/use-media-flow';
import { FlowView } from '@/components/flow-view';
import { PlatformIcons } from '@/components/platform-icons';
import { PlatformInfo } from '@/components/platform-info';
import { UrlForm } from '@/components/url-form';
import { Button } from '@/components/ui/button';
import { useMediaFlow } from '@/hooks/use-media-flow';
import type { FlowState } from '@/hooks/flow-reducer';

const PHASES_WITH_UPLOAD_LINK = new Set<FlowState['phase']>(['idle', 'options', 'unavailable', 'error', 'done', 'failed', 'expired']);

interface InputSectionProps {
  onSubmit: (url: string) => void;
  busy: boolean;
  showUploadLink: boolean;
  onOpenUpload: () => void;
}

/** Remounted (via `key`) whenever the flow starts over, which clears the field and platform hint. */
function InputSection({ onSubmit, busy, showUploadLink, onOpenUpload }: InputSectionProps) {
  const [platform, setPlatform] = useState<Platform | null>(null);
  return (
    <div className="space-y-4">
      <UrlForm onSubmit={onSubmit} onPlatformChange={setPlatform} busy={busy} />
      <PlatformIcons active={platform} />
      {showUploadLink ? (
        <p className="text-center text-sm">
          <Button variant="link" onClick={onOpenUpload} className="text-sm">
            <FileUp className="size-4" aria-hidden />
            Have a file you own? Convert it here
          </Button>
        </p>
      ) : null}
    </div>
  );
}

export function Downloader({ mode = 'proxy' }: { mode?: FlowMode }) {
  const flow = useMediaFlow(mode);
  const { state } = flow;

  // When the notice already carries the "Convert a file you own" action, don't repeat it.
  const noticeHasUploadAction = state.phase === 'unavailable' && state.resolved.uploadEnabled;
  // Uploads need the self-hosted API + worker; the standalone (Vercel) deployment converts links only.
  const showUploadLink = mode === 'proxy' && PHASES_WITH_UPLOAD_LINK.has(state.phase) && !noticeHasUploadAction;

  return (
    <div className="space-y-8">
      <section className="space-y-3 text-center">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Download Media</h1>
        <p className="mx-auto max-w-xl text-balance text-muted">
          Paste a YouTube, Instagram, Facebook or TikTok link and save it as MP4 video or MP3 audio.
        </p>
      </section>

      <InputSection
        key={flow.generation}
        onSubmit={flow.submit}
        busy={state.phase === 'resolving'}
        showUploadLink={showUploadLink}
        onOpenUpload={flow.openUpload}
      />

      <div aria-live="polite">
        <FlowView flow={flow} />
      </div>

      <PlatformInfo />
    </div>
  );
}
