import * as React from 'react';
import { cn } from '@/lib/utils';

function Input({ className, type = 'text', ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'flex h-12 w-full min-w-0 rounded-xl border border-line-strong bg-surface px-4 text-base text-ink shadow-sm transition-colors placeholder:text-neutral-400 focus-visible:border-brand-600 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-brand-600/25 disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:opacity-60 aria-invalid:border-red-500',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
