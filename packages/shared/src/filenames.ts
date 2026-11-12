import type { MediaFormat } from './types';

const MAX_BASENAME_LENGTH = 120;

/**
 * Zero-width characters and bidirectional controls: they let a name look different from what
 * it is (for example a name that visually reverses its own extension). Built from numeric code points so the source file itself
 * never contains invisible characters.
 */
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x200b, 0x200f], // zero-width space/joiners, LRM, RLM
  [0x202a, 0x202e], // bidi embedding / override
  [0x2066, 0x2069], // bidi isolates
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
];
const INVISIBLE_CHARS = new RegExp(
  `[${INVISIBLE_RANGES.map(([from, to]) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`).join('')}]`,
  'g',
);

/**
 * Turn arbitrary text (a video title, an uploaded file name) into a safe download file
 * name: no path separators, no control characters, no Windows-reserved characters or
 * device names, no leading dots. Unicode letters are preserved.
 */
export function sanitizeFilename(input: string | null | undefined, fallback = 'media'): string {
  let name = (input ?? '')
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(INVISIBLE_CHARS, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');

  if (name.length > MAX_BASENAME_LENGTH) {
    name = name.slice(0, MAX_BASENAME_LENGTH).trim();
  }
  if (name === '' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) {
    return fallback;
  }
  return name;
}

/** `<safe title>.mp4` / `<safe title>.mp3`. */
export function buildOutputFilename(title: string | null | undefined, format: MediaFormat, fallback = 'media'): string {
  return `${sanitizeFilename(title, fallback)}.${format}`;
}

/** Drop the extension of an uploaded file name before sanitising it for reuse as a title. */
export function stripExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/** Human readable byte size, e.g. "12.4 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** 3725 → "1:02:05", 65 → "1:05". */
export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds == null || !Number.isFinite(totalSeconds) || totalSeconds < 0) return '—';
  const seconds = Math.round(totalSeconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
