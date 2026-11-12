import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const alertVariants = cva(
  'relative grid w-full grid-cols-[auto_1fr] items-start gap-x-3 gap-y-1 rounded-2xl border px-4 py-3.5 text-sm [&>svg]:mt-0.5 [&>svg]:size-5',
  {
    variants: {
      variant: {
        info: 'border-line bg-neutral-50 text-neutral-800 [&>svg]:text-neutral-500',
        warning: 'border-amber-200 bg-amber-50 text-amber-950 [&>svg]:text-amber-600',
        destructive: 'border-red-200 bg-red-50 text-red-950 [&>svg]:text-red-600',
        success: 'border-brand-200 bg-brand-50 text-brand-800 [&>svg]:text-brand-600',
      },
    },
    defaultVariants: { variant: 'info' },
  },
);

export interface AlertProps extends React.ComponentProps<'div'>, VariantProps<typeof alertVariants> {}

function Alert({ className, variant, role, ...props }: AlertProps) {
  return (
    <div
      data-slot="alert"
      role={role ?? (variant === 'destructive' ? 'alert' : 'status')}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="alert-title" className={cn('col-start-2 font-semibold leading-snug', className)} {...props} />;
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-description"
      className={cn('col-start-2 space-y-2 leading-relaxed opacity-90 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5', className)}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription };
