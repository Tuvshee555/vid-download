/**
 * Abuse protection for the open (no-password) site. In-memory and per serverless instance, so
 * it is best-effort — enough to stop one visitor from hammering the site or the home PC.
 */
const windows = new Map<string, number[]>();

/** Allow `max` hits per `windowMs` for `key`; returns false when over the limit. */
export function allow(key: string, max: number, windowMs = 60_000, now = Date.now()): boolean {
  const recent = (windows.get(key) ?? []).filter((time) => time > now - windowMs);
  if (recent.length >= max) {
    windows.set(key, recent);
    return false;
  }
  recent.push(now);
  windows.set(key, recent);
  if (windows.size > 5000) for (const [k, v] of windows) if (!v.some((time) => time > now - windowMs)) windows.delete(k);
  return true;
}

export function clientIp(headers: Headers): string {
  return headers.get('x-forwarded-for')?.split(',')[0]?.trim() || headers.get('x-real-ip') || 'unknown';
}

let active = 0;
const maxConcurrent = () => Math.max(1, Number(process.env.MAX_CONCURRENT_CONVERSIONS) || 3);

/** Reserve a conversion slot; call the returned function when done. null = this instance is busy. */
export function acquireConversionSlot(): (() => void) | null {
  if (active >= maxConcurrent()) return null;
  active += 1;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      active -= 1;
    }
  };
}
