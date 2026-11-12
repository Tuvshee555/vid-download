/**
 * Strict URL allowlisting and platform detection.
 *
 * This module is the first line of defence for SSRF and open-proxy abuse: only exact,
 * known hostnames are accepted, credentials / odd ports / IP literals / local names are
 * rejected, and the canonical URL we hand to the rest of the system is *rebuilt from the
 * parsed media ID* — the raw user string is never forwarded anywhere.
 *
 * It is dependency-free and browser-safe so the web UI can use the same logic for instant
 * feedback.
 */

export const PLATFORMS = ['youtube', 'instagram', 'facebook'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_NAMES: Record<Platform, string> = {
  youtube: 'YouTube',
  instagram: 'Instagram',
  facebook: 'Facebook',
};

export const MAX_URL_LENGTH = 2048;

/** Exact hostnames (after lowercasing and stripping one trailing dot) accepted per platform. */
export const PLATFORM_HOSTS: Record<Platform, readonly string[]> = {
  youtube: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be'],
  instagram: ['instagram.com', 'www.instagram.com', 'instagr.am', 'www.instagr.am'],
  facebook: ['facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com', 'mbasic.facebook.com', 'fb.watch'],
};

export type MediaKind = 'video' | 'short' | 'reel' | 'post';

export type UrlRejectionCode = 'INVALID_URL' | 'UNSUPPORTED_DOMAIN' | 'UNSUPPORTED_URL_TYPE' | 'BLOCKED_ADDRESS';

export type UrlDetection =
  | {
      ok: true;
      platform: Platform;
      /** Rebuilt from the media ID — safe to log, store and display. */
      canonicalUrl: string;
      mediaId: string;
      kind: MediaKind;
    }
  | {
      ok: false;
      code: UrlRejectionCode;
      message: string;
      /** Set when the host was recognised even though the path was not usable. */
      platform?: Platform;
    };

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const INSTAGRAM_CODE = /^[A-Za-z0-9_-]{5,40}$/;
const FACEBOOK_ID = /^\d{5,25}$/;

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const DANGEROUS_SCHEME = /^(javascript|data|file|mailto|blob|about|vbscript|ftp|gopher|ws|wss|chrome|view-source):/i;
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.intranet', '.corp', '.private'];

function reject(code: UrlRejectionCode, message: string, platform?: Platform): UrlDetection {
  return platform ? { ok: false, code, message, platform } : { ok: false, code, message };
}

/** True when the (already URL-normalised) hostname is an IP literal or a local/internal name. */
export function isPrivateOrLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === '') return true;
  if (host.startsWith('[') || host.includes(':')) return true; // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true; // IPv4 literal (WHATWG URL normalises 0x7f.1, 2130706433, ...)
  if (host === 'localhost') return true;
  if (!host.includes('.')) return true; // single-label intranet names
  return LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

export function platformForHostname(hostname: string): Platform | null {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  for (const platform of PLATFORMS) {
    if (PLATFORM_HOSTS[platform].includes(host)) return platform;
  }
  return null;
}

function nonEmptySegments(pathname: string): string[] {
  return pathname.split('/').filter((segment) => segment.length > 0);
}

function parseYouTube(url: URL, host: string): UrlDetection {
  const segments = nonEmptySegments(url.pathname);
  const first = segments[0]?.toLowerCase();
  let id: string | undefined;
  let kind: MediaKind = 'video';

  if (host === 'youtu.be' || host === 'www.youtu.be') {
    id = segments[0];
  } else if (first === 'watch') {
    id = url.searchParams.get('v') ?? undefined;
  } else if (first === 'shorts' || first === 'embed' || first === 'live' || first === 'v') {
    id = segments[1];
    kind = first === 'shorts' ? 'short' : 'video';
  } else {
    return reject(
      'UNSUPPORTED_URL_TYPE',
      'This YouTube link is not a single video. Paste the link of one specific video (a youtube.com/watch link, a youtu.be link or a Short).',
      'youtube',
    );
  }

  if (!id || !YOUTUBE_ID.test(id)) {
    return reject('INVALID_URL', "We couldn't find a valid YouTube video ID in this link.", 'youtube');
  }
  return {
    ok: true,
    platform: 'youtube',
    canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
    mediaId: id,
    kind,
  };
}

function parseInstagram(url: URL): UrlDetection {
  const segments = nonEmptySegments(url.pathname);
  const first = segments[0]?.toLowerCase();

  if (first === 'stories') {
    return reject('UNSUPPORTED_URL_TYPE', 'Instagram stories are not supported. Paste the link of a post or reel.', 'instagram');
  }
  if (first === 'share') {
    return reject(
      'UNSUPPORTED_URL_TYPE',
      'Instagram share links are not supported. Open the link in your browser and paste the full instagram.com/reel/… or instagram.com/p/… address.',
      'instagram',
    );
  }

  // /p/CODE, /reel/CODE, /reels/CODE, /tv/CODE  — or the same behind a /{username} prefix.
  let index = 0;
  const typeOf = (segment: string | undefined) => segment?.toLowerCase();
  const isTypeSegment = (segment: string | undefined) => ['p', 'reel', 'reels', 'tv'].includes(typeOf(segment) ?? '');
  if (!isTypeSegment(segments[0]) && isTypeSegment(segments[1])) index = 1;

  const type = typeOf(segments[index]);
  const code = segments[index + 1];
  if (!isTypeSegment(segments[index])) {
    return reject(
      'UNSUPPORTED_URL_TYPE',
      'This Instagram link is not a single post or reel. Paste a link that looks like instagram.com/reel/… or instagram.com/p/….',
      'instagram',
    );
  }
  if (!code || !INSTAGRAM_CODE.test(code)) {
    return reject('INVALID_URL', "We couldn't find a valid Instagram post code in this link.", 'instagram');
  }

  const isReel = type === 'reel' || type === 'reels';
  const path = type === 'tv' ? 'tv' : isReel ? 'reel' : 'p';
  return {
    ok: true,
    platform: 'instagram',
    canonicalUrl: `https://www.instagram.com/${path}/${code}/`,
    mediaId: code,
    kind: isReel ? 'reel' : 'post',
  };
}

function parseFacebook(url: URL, host: string): UrlDetection {
  if (host === 'fb.watch') {
    return reject(
      'UNSUPPORTED_URL_TYPE',
      'fb.watch short links are not supported. Open the link in your browser and paste the full facebook.com/…/videos/… address.',
      'facebook',
    );
  }

  const segments = nonEmptySegments(url.pathname);
  const first = segments[0]?.toLowerCase();
  let id: string | undefined;
  let kind: MediaKind = 'video';

  if (first === 'watch') {
    id = url.searchParams.get('v') ?? undefined;
  } else if (first === 'video.php') {
    id = url.searchParams.get('v') ?? undefined;
  } else if (first === 'reel') {
    id = segments[1];
    kind = 'reel';
  } else if (first === 'share') {
    return reject(
      'UNSUPPORTED_URL_TYPE',
      'Facebook share links are not supported. Open the link in your browser and paste the full facebook.com/…/videos/… address.',
      'facebook',
    );
  } else {
    // /{page}/videos/ID  or  /{page}/videos/{slug}/ID
    const videosIndex = segments.findIndex((segment) => segment.toLowerCase() === 'videos');
    if (videosIndex === -1) {
      return reject(
        'UNSUPPORTED_URL_TYPE',
        'This Facebook link is not a single video. Paste a link that looks like facebook.com/watch/?v=… or facebook.com/{page}/videos/….',
        'facebook',
      );
    }
    id = [...segments.slice(videosIndex + 1)].reverse().find((segment) => FACEBOOK_ID.test(segment));
  }

  if (!id || !FACEBOOK_ID.test(id)) {
    return reject('INVALID_URL', "We couldn't find a valid Facebook video ID in this link.", 'facebook');
  }
  return {
    ok: true,
    platform: 'facebook',
    canonicalUrl: `https://www.facebook.com/watch/?v=${id}`,
    mediaId: id,
    kind,
  };
}

/**
 * Validate and classify a user-supplied URL. Never throws.
 *
 * Accepts `youtube.com/…` without a scheme (people paste that) but nothing that could
 * reach a non-allowlisted host.
 */
export function detectUrl(input: string): UrlDetection {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (raw === '') {
    return reject('INVALID_URL', 'Paste a YouTube, Instagram or Facebook link to get started.');
  }
  if (raw.length > MAX_URL_LENGTH) {
    return reject('INVALID_URL', 'That link is too long.');
  }
  if (/\s/.test(raw)) {
    return reject('INVALID_URL', "Links can't contain spaces. Paste exactly one link.");
  }
  if (DANGEROUS_SCHEME.test(raw) && !HAS_SCHEME.test(raw)) {
    return reject('INVALID_URL', 'Only web links (https://…) are supported.');
  }

  let url: URL;
  try {
    url = new URL(HAS_SCHEME.test(raw) ? raw : `https://${raw}`);
  } catch {
    return reject('INVALID_URL', "That doesn't look like a valid web address. Paste the full link, starting with https://.");
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return reject('INVALID_URL', 'Only web links (https://…) are supported.');
  }
  if (url.username !== '' || url.password !== '') {
    return reject('INVALID_URL', 'Links containing a username or password are not allowed.');
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!HAS_SCHEME.test(raw) && !host.includes('.') && !host.includes(':') && host !== 'localhost') {
    // "just-some-words": the user pasted something that is not a link at all.
    return reject('INVALID_URL', "That doesn't look like a valid web address. Paste the full link, starting with https://.");
  }
  if (isPrivateOrLocalHostname(host)) {
    return reject('BLOCKED_ADDRESS', 'Links to local or private network addresses are not allowed.');
  }

  const platform = platformForHostname(host);
  if (!platform) {
    return reject(
      'UNSUPPORTED_DOMAIN',
      "This website isn't supported. MediaDock only accepts YouTube, Instagram and Facebook links.",
    );
  }
  if (url.port !== '') {
    return reject('INVALID_URL', 'Links with a custom port are not allowed.', platform);
  }

  switch (platform) {
    case 'youtube':
      return parseYouTube(url, host);
    case 'instagram':
      return parseInstagram(url);
    case 'facebook':
      return parseFacebook(url, host);
  }
}

/** Best-effort platform hint for UI chips while the user is still typing. */
export function guessPlatform(input: string): Platform | null {
  const detection = detectUrl(input);
  if (detection.ok) return detection.platform;
  return detection.platform ?? null;
}
