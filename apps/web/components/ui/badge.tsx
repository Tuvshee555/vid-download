import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium leading-none [&_svg]:size-3.5',
  {
    variants: {
      variant: {
        neutral: 'border-line bg-neutral-100 text-neutral-700',
        success: 'border-brand-200 bg-brand-50 text-brand-800',
        warning: 'border-amber-200 bg-amber-50 text-amber-900',
        outline: 'border-line-strong bg-surface text-neutral-700',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export interface BadgeProps extends React.ComponentProps<'span'>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
