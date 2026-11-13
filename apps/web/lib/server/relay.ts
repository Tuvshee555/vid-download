/**
 * "Home helper" relay for platforms that block cloud servers (YouTube).
 *
 * The cloud deployment (Vercel) sets RELAY_URL + RELAY_SECRET. For the platforms listed in
 * RELAY_PLATFORMS (default: youtube) it forwards /api/resolve and /api/convert to a MediaDock
 * instance on the owner's own PC (home internet isn't blocked), reached through a tunnel. That
 * instance authenticates the forwarded requests with the shared secret, downloads + converts at
 * home and stores the result in the same Vercel Blob store, so the link works anywhere.
 *
 * Server-only.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Platform } from '@vd/shared';

export const RELAY_HEADER = 'x-mediadock-relay';

function relaySecret(): string | null {
  const secret = process.env.RELAY_SECRET?.trim();
  return secret && secret.length >= 32 ? secret : null;
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/** True when the request carries the shared relay secret (constant-time comparison). */
export function isRelayRequest(headers: Headers): boolean {
  const secret = relaySecret();
  const provided = headers.get(RELAY_HEADER);
  if (!secret || !provided) return false;
  return timingSafeEqual(digest(secret), digest(provided));
}

/** Base URL of the home helper if this deployment should relay `platform`, else null. */
export function relayTarget(platform: Platform): string | null {
  const url = process.env.RELAY_URL?.trim();
  if (!url || !relaySecret() || !/^https:\/\//.test(url)) return null;
  const platforms = (process.env.RELAY_PLATFORMS ?? 'youtube').split(',').map((p) => p.trim().toLowerCase());
  return platforms.includes(platform) ? url.replace(/\/+$/, '') : null;
}

/** POST JSON to the home helper. Throws on network failure (helper offline / tunnel down). */
export function relayFetch(base: string, path: '/api/resolve' | '/api/convert', body: unknown, signal: AbortSignal): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, application/x-ndjson',
      [RELAY_HEADER]: relaySecret() ?? '',
      // ngrok's free tier shows a browser interstitial unless this header is present.
      'ngrok-skip-browser-warning': '1',
    },
    body: JSON.stringify(body),
    signal,
    redirect: 'manual',
    cache: 'no-store',
  });
}

/** A response from the helper app itself (not the tunnel's own "endpoint offline" page). */
export function isHelperResponse(response: Response): boolean {
  const type = response.headers.get('content-type') ?? '';
  return type.includes('application/json') || type.includes('application/x-ndjson');
}

export const HELPER_OFFLINE = {
  message: "YouTube downloads run on your home PC (YouTube blocks cloud servers), and it isn't reachable right now.",
  guidance: [
    'Turn on your PC — the MediaDock YouTube helper starts automatically when you sign in to Windows.',
    'Instagram, Facebook and TikTok links work without it.',
  ],
};
