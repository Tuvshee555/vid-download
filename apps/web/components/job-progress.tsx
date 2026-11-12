'use client';

import { Loader2 } from 'lucide-react';
import type { JobStage, JobView, MediaFormat } from '@vd/shared';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';

export function stageLabel(stage: JobStage, format: MediaFormat): string {
  switch (stage) {
    case 'queued':
      return 'Waiting in the queue';
    case 'resolving':
      return 'Checking the source';
    case 'downloading':
      return 'Fetching the authorized media';
    case 'probing':
      return 'Inspecting the file';
    case 'converting':
      return format === 'mp3' ? 'Extracting audio to MP3' : 'Preparing your MP4';
    case 'uploading':
      return 'Saving your file';
    case 'done':
      return 'Finishing up';
  }
}

interface JobProgressProps {
  job: JobView | null;
  format: MediaFormat;
}

export function JobProgress({ job, format }: JobProgressProps) {
  const stage: JobStage = job?.progress.stage ?? 'queued';
  const percent = job?.progress.percent ?? 0;
  const retrying = job && job.attempt > 1 ? `Retrying — attempt ${job.attempt} of ${job.maxAttempts}` : null;

  return (
    <Card className="space-y-4 p-5 sm:p-6" aria-busy="true">
      <div role="status" aria-live="polite" className="flex items-center gap-3">
        <Loader2 className="size-5 shrink-0 animate-spin text-brand-600 motion-reduce:animate-none" aria-hidden />
        <div className="min-w-0">
          <p className="font-semibold">{stageLabel(stage, format)}…</p>
          <p className="text-sm text-muted">
            {format.toUpperCase()} · {Math.round(percent)}%{retrying ? ` · ${retrying}` : ''}
          </p>
        </div>
      </div>
      <Progress value={percent} aria-label="Processing progress" />
      <p className="text-xs text-muted">You can leave this tab open — we check the job in the background.</p>
    </Card>
  );
}
