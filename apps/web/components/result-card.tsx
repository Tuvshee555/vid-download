'use client';

import { useState } from 'react';
import { CheckCircle2, Download, Loader2, RefreshCw } from 'lucide-react';
import { formatBytes, formatDuration, type JobResultView } from '@vd/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import type { FlowError } from '@/hooks/flow-reducer';

interface ResultCardProps {
  result: JobResultView;
  onRefreshLink: () => Promise<FlowError | null>;
  onReset: () => void;
}

function formatClock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function ResultCard({ result, onRefreshLink, onReset }: ResultCardProps) {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  async function refresh() {
    setRefreshing(true);
    setRefreshError(null);
    const error = await onRefreshLink();
    setRefreshing(false);
    if (error) setRefreshError(error.message);
  }

  const details: Array<[string, string]> = [
    ['Format', result.format.toUpperCase()],
    ['Size', formatBytes(result.sizeBytes)],
    ...(result.durationSeconds != null ? ([['Duration', formatDuration(result.durationSeconds)]] as Array<[string, string]>) : []),
    ...(result.resolution ? ([['Resolution', result.resolution]] as Array<[string, string]>) : []),
  ];

  return (
    <Card data-testid="result-card" className="border-brand-200">
      <CardHeader>
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 size-6 shrink-0 text-brand-600" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-medium text-brand-700">Ready to download</p>
            <CardTitle className="break-words text-lg" data-testid="result-filename">
              {result.filename}
            </CardTitle>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          {details.map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
              <dd className="font-medium">{value}</dd>
            </div>
          ))}
        </dl>
        {result.losslessVideo === true ? (
          <p className="text-sm text-brand-800">Original quality — the video was not re-encoded.</p>
        ) : null}
        <p className="text-sm text-muted">
          The file is deleted automatically around {formatClock(result.expiresAt)}. The download link itself is
          short-lived — use “Refresh link” if it stops working.
        </p>
        {refreshError ? (
          <Alert variant="destructive">
            <AlertDescription>{refreshError}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
      <CardFooter>
        <Button asChild size="lg" className="w-full sm:w-auto">
          <a href={result.download.url} download={result.filename}>
            <Download className="size-5" aria-hidden />
            Download {result.format.toUpperCase()}
          </a>
        </Button>
        <Button variant="secondary" size="lg" onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}
          Refresh link
        </Button>
        <Button variant="ghost" size="lg" onClick={onReset}>
          New download
        </Button>
      </CardFooter>
    </Card>
  );
}
