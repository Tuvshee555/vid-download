import * as React from 'react';
import { cn } from '@/lib/utils';

export interface ProgressProps extends Omit<React.ComponentProps<'div'>, 'children'> {
  /** 0–100. */
  value: number;
}

function Progress({ className, value, ...props }: ProgressProps) {
  const clamped = Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));
  return (
    <div
      data-slot="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      className={cn('h-2.5 w-full overflow-hidden rounded-full bg-neutral-200', className)}
      {...props}
    >
      <div
        className="h-full rounded-full bg-brand-600 transition-[width] duration-300 ease-out"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

export { Progress };
