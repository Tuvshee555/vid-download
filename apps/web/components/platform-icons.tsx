import type { Platform } from '@vd/shared';
import { PLATFORM_NAMES, PLATFORMS } from '@vd/shared';
import { cn } from '@/lib/utils';

/**
 * Simple, original monochrome glyphs that hint at each platform. They are intentionally not
 * the official logos.
 */
export function PlatformIcon({ platform, className }: { platform: Platform; className?: string }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    className: cn('size-5', className),
  };

  switch (platform) {
    case 'youtube':
      return (
        <svg {...common}>
          <rect x="2.5" y="5.5" width="19" height="13" rx="4" />
          <path d="m10 9.5 5 2.5-5 2.5Z" fill="currentColor" />
        </svg>
      );
    case 'instagram':
      return (
        <svg {...common}>
          <rect x="3" y="3" width="18" height="18" rx="5.5" />
          <circle cx="12" cy="12" r="4" />
          <circle cx="17.2" cy="6.8" r="0.6" fill="currentColor" />
        </svg>
      );
    case 'facebook':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9.5" />
          <path d="M13.2 19v-6h2l.4-2.3h-2.4V9.4c0-.7.3-1.1 1.1-1.1h1.4V6.2a12 12 0 0 0-1.8-.1c-1.8 0-3 1.1-3 3.1v1.5H8.8V13h2.1v6" fill="currentColor" stroke="none" />
        </svg>
      );
  }
}

export function PlatformIcons({ active }: { active?: Platform | null }) {
  return (
    <ul className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm text-muted" aria-label="Supported platforms">
      {PLATFORMS.map((platform) => (
        <li
          key={platform}
          data-active={active === platform ? 'true' : 'false'}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 transition-colors',
            active === platform && 'bg-brand-50 font-medium text-brand-800 ring-1 ring-brand-200',
          )}
        >
          <PlatformIcon platform={platform} />
          {PLATFORM_NAMES[platform]}
        </li>
      ))}
    </ul>
  );
}
