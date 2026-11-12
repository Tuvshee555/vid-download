'use client';

import { ChevronRight, Film, Music } from 'lucide-react';
import { formatBytes, type MediaFormat, type MediaOption } from '@vd/shared';
import { cn } from '@/lib/utils';

interface FormatOptionsProps {
  options: MediaOption[];
  onSelect: (format: MediaFormat) => void;
  disabled?: boolean;
}

/** Renders exactly the options the API returned — nothing is added, inferred or defaulted. */
export function FormatOptions({ options, onSelect, disabled = false }: FormatOptionsProps) {
  if (options.length === 0) {
    return <p className="text-sm text-muted">No downloadable formats were reported for this media.</p>;
  }

  return (
    <ul className="grid gap-3 sm:grid-cols-2" aria-label="Available formats">
      {options.map((option) => {
        const details = [
          option.container.toUpperCase(),
          option.resolution,
          option.sizeBytes != null ? formatBytes(option.sizeBytes) : null,
        ].filter((part): part is string => Boolean(part));
        const Icon = option.format === 'mp4' ? Film : Music;

        return (
          <li key={option.id}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onSelect(option.format)}
              className={cn(
                'group flex w-full items-center gap-4 rounded-2xl border border-line-strong bg-surface p-4 text-left shadow-sm transition-colors',
                'hover:border-brand-600 hover:bg-brand-50 disabled:pointer-events-none disabled:opacity-50',
              )}
            >
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700 group-hover:bg-brand-100">
                <Icon className="size-5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{option.label}</span>
                <span className="block text-sm text-muted">{details.join(' · ')}</span>
                {option.note ? <span className="mt-1 block text-xs text-muted">{option.note}</span> : null}
              </span>
              <ChevronRight className="size-5 shrink-0 text-neutral-400 group-hover:text-brand-700" aria-hidden />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
