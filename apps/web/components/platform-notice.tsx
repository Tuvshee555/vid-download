'use client';

import { FileUp, Info } from 'lucide-react';
import type { UnavailableReason } from '@vd/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { errorTitle } from '@/lib/error-messages';

interface PlatformNoticeProps {
  reason: UnavailableReason;
  platformName: string;
  /** When provided, a prominent "convert a file you own" action is shown. */
  onConvertOwnFile?: () => void;
}

/**
 * Honest explanation of why a link can't be downloaded here, plus the permitted fallback.
 * This is a normal outcome (e.g. YouTube has no download API), not an application error.
 */
export function PlatformNotice({ reason, platformName, onConvertOwnFile }: PlatformNoticeProps) {
  return (
    <div className="space-y-4" data-testid="platform-notice">
      <Alert variant="warning">
        <Info aria-hidden />
        <AlertTitle>
          {platformName}: {errorTitle(reason.code)}
        </AlertTitle>
        <AlertDescription>
          <p>{reason.message}</p>
          {reason.guidance.length > 0 ? (
            <ul aria-label="What you can do">
              {reason.guidance.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ul>
          ) : null}
        </AlertDescription>
      </Alert>
      {onConvertOwnFile ? (
        <Button variant="secondary" size="lg" onClick={onConvertOwnFile} className="w-full sm:w-auto">
          <FileUp className="size-5" aria-hidden />
          Convert a file you own
        </Button>
      ) : null}
    </div>
  );
}
