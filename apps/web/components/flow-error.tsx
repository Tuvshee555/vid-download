'use client';

import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { FlowError } from '@/hooks/flow-reducer';
import { errorTitle } from '@/lib/error-messages';

interface FlowErrorProps {
  error: FlowError;
  primaryLabel: string;
  onPrimary: () => void;
  onStartOver?: () => void;
}

/** Shared failure panel: friendly title, the API's own message, optional guidance, clear next step. */
export function FlowErrorPanel({ error, primaryLabel, onPrimary, onStartOver }: FlowErrorProps) {
  return (
    <div className="space-y-4" data-testid="flow-error">
      <Alert variant="destructive">
        <AlertTriangle aria-hidden />
        <AlertTitle>{errorTitle(error.code)}</AlertTitle>
        <AlertDescription>
          <p>{error.message}</p>
          {error.guidance.length > 0 ? (
            <ul>
              {error.guidance.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ul>
          ) : null}
        </AlertDescription>
      </Alert>
      <div className="flex flex-wrap gap-3">
        <Button size="lg" onClick={onPrimary}>
          {primaryLabel}
        </Button>
        {onStartOver ? (
          <Button size="lg" variant="ghost" onClick={onStartOver}>
            Start over
          </Button>
        ) : null}
      </div>
    </div>
  );
}
