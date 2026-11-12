'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { FileUp, Film, Loader2, Music, UploadCloud, X } from 'lucide-react';
import { ALLOWED_UPLOAD_EXTENSIONS, formatBytes, type MediaFormat } from '@vd/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import {
  ApiClientError,
  createJob,
  createUploadTicket,
  getPlatforms,
  isApiClientError,
  uploadFile,
} from '@/lib/api-client';
import { cn } from '@/lib/utils';

interface UploadPanelProps {
  onJobCreated: (jobId: string, format: MediaFormat) => void;
  onCancel: () => void;
}

type Phase = 'idle' | 'ticket' | 'uploading' | 'creating';

const ACCEPT = ALLOWED_UPLOAD_EXTENSIONS.map((extension) => `.${extension}`).join(',');

export function UploadPanel({ onJobCreated, onCancel }: UploadPanelProps) {
  const [file, setFile] = useState<File | null>(null);
  const [format, setFormat] = useState<MediaFormat>('mp4');
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [maxBytes, setMaxBytes] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const inputId = useId();

  useEffect(() => {
    const controller = new AbortController();
    getPlatforms(controller.signal)
      .then((response) => setMaxBytes(response.limits.maxUploadBytes))
      .catch(() => undefined); // limits are re-checked by the server when the ticket is issued
    return () => {
      controller.abort();
      controllerRef.current?.abort();
    };
  }, []);

  function choose(candidate: File | null | undefined) {
    setError(null);
    if (!candidate) return;
    const extension = candidate.name.includes('.') ? candidate.name.split('.').pop()?.toLowerCase() : undefined;
    if (!extension || !(ALLOWED_UPLOAD_EXTENSIONS as readonly string[]).includes(extension)) {
      setFile(null);
      setError(`That file type isn't supported. Choose a video or audio file (${ALLOWED_UPLOAD_EXTENSIONS.slice(0, 8).join(', ')}…).`);
      return;
    }
    if (maxBytes !== null && candidate.size > maxBytes) {
      setFile(null);
      setError(`That file is ${formatBytes(candidate.size)}; the limit is ${formatBytes(maxBytes)}.`);
      return;
    }
    setFile(candidate);
  }

  async function start() {
    if (!file) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setError(null);
    setProgress(0);
    try {
      setPhase('ticket');
      const ticket = await createUploadTicket(
        { filename: file.name, size: file.size, contentType: file.type || 'application/octet-stream' },
        controller.signal,
      );
      if (file.size > ticket.maxBytes) throw new ApiClientError('FILE_TOO_LARGE', `That file is larger than the ${formatBytes(ticket.maxBytes)} limit.`);

      setPhase('uploading');
      await uploadFile(ticket.upload, file, setProgress, controller.signal);

      setPhase('creating');
      // `filename` lets the server name the converted file after the user's original (holiday.mp4 → holiday.mp3).
      const job = await createJob({ source: 'upload', uploadId: ticket.uploadId, format, filename: file.name }, controller.signal);
      onJobCreated(job.id, format);
    } catch (caught) {
      if (controller.signal.aborted) return;
      setPhase('idle');
      setError(isApiClientError(caught) ? caught.message : 'The upload failed. Please try again.');
    }
  }

  const busy = phase !== 'idle';

  return (
    <Card data-testid="upload-panel">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle className="text-lg">Convert a file you own</CardTitle>
            <CardDescription>
              Exported your own video (for example from YouTube Studio, Google Takeout or your phone)? Upload it here
              and get an MP4 or MP3. The file is deleted after conversion.
            </CardDescription>
          </div>
          <Button variant="ghost" size="icon" onClick={() => { controllerRef.current?.abort(); onCancel(); }} aria-label="Close">
            <X className="size-5" aria-hidden />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <label
          htmlFor={inputId}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (!busy) choose(event.dataTransfer.files[0]);
          }}
          className={cn(
            'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-4 py-8 text-center transition-colors',
            dragging ? 'border-brand-600 bg-brand-50' : 'border-line-strong bg-neutral-50 hover:border-brand-600',
            busy && 'pointer-events-none opacity-60',
          )}
        >
          <UploadCloud className="size-8 text-brand-600" aria-hidden />
          {file ? (
            <span className="break-all font-medium">
              {file.name} <span className="font-normal text-muted">· {formatBytes(file.size)}</span>
            </span>
          ) : (
            <span className="font-medium">Drop a file here, or click to choose</span>
          )}
          <span className="text-sm text-muted">
            {maxBytes !== null ? `Up to ${formatBytes(maxBytes)}. ` : ''}Video or audio files only.
          </span>
          <input
            id={inputId}
            type="file"
            accept={ACCEPT}
            className="sr-only"
            disabled={busy}
            onChange={(event) => choose(event.target.files?.[0])}
          />
        </label>

        <fieldset className="space-y-2" disabled={busy}>
          <legend className="text-sm font-medium">Convert to</legend>
          <div className="grid grid-cols-2 gap-3">
            {(['mp4', 'mp3'] as const).map((value) => (
              <label
                key={value}
                className={cn(
                  'flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-brand-600',
                  format === value ? 'border-brand-600 bg-brand-50' : 'border-line-strong bg-surface hover:bg-neutral-50',
                )}
              >
                <input
                  type="radio"
                  name="upload-format"
                  value={value}
                  checked={format === value}
                  onChange={() => setFormat(value)}
                  className="sr-only"
                />
                {value === 'mp4' ? <Film className="size-5 text-brand-700" aria-hidden /> : <Music className="size-5 text-brand-700" aria-hidden />}
                <span className="font-medium">{value === 'mp4' ? 'MP4 video' : 'MP3 audio'}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {phase === 'uploading' ? (
          <div className="space-y-2" role="status" aria-live="polite">
            <p className="text-sm font-medium">Uploading… {Math.round(progress * 100)}%</p>
            <Progress value={progress * 100} aria-label="Upload progress" />
          </div>
        ) : null}

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap gap-3">
          <Button size="lg" onClick={() => void start()} disabled={!file || busy} className="w-full sm:w-auto">
            {busy ? <Loader2 className="size-5 animate-spin motion-reduce:animate-none" aria-hidden /> : <FileUp className="size-5" aria-hidden />}
            {phase === 'ticket' ? 'Preparing upload…' : phase === 'uploading' ? 'Uploading…' : phase === 'creating' ? 'Starting conversion…' : `Convert to ${format.toUpperCase()}`}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
