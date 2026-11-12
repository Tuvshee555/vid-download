import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config';
import { silentLogger } from '../logger';
import type { HttpClient, JsonResponse } from '../net/safe-fetch';
import { createAdapters } from './index';
import { shortcodeFromPermalink } from './instagram';
import { parseIsoDuration } from './youtube';

type Route = (url: URL) => JsonResponse | Promise<JsonResponse>;

/** A fake HttpClient: nothing here touches the network. */
function fakeHttp(route: Route, contentLength: number | null = 1_500_000): HttpClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getJson: vi.fn(async (url: string) => {
      calls.push(url);
      return route(new URL(url));
    }),
    headContentLength: vi.fn(async () => contentLength),
  };
}

function adaptersWith(env: Record<string, string>, http: HttpClient) {
  return createAdapters(loadConfig(env), { http, logger: silentLogger });
}

const YT_ID = 'dQw4w9WgXcQ';
const YT_URL = `https://www.youtube.com/watch?v=${YT_ID}`;

describe('YouTubeAdapter', () => {
  it('shows metadata from oEmbed but NEVER offers a download', async () => {
    const http = fakeHttp((url) =>
      url.pathname === '/oembed'
        ? { status: 200, body: { title: 'A video', author_name: 'A channel', thumbnail_url: 'https://i.ytimg.com/vi/x/hqdefault.jpg' } }
        : { status: 404, body: null },
    );
    const adapter = adaptersWith({}, http).youtube;
    const resolved = await adapter.resolve(adapter.validate(YT_URL));

    expect(resolved.metadata).toMatchObject({ title: 'A video', author: 'A channel' });
    expect(resolved.availability.status).toBe('unavailable');
    if (resolved.availability.status !== 'available') {
      expect(resolved.availability.reason.code).toBe('UNAUTHORIZED_SOURCE');
      expect(resolved.availability.reason.guidance.join(' ')).toMatch(/Studio|Takeout/);
    }
    // the oEmbed request is built from the canonical URL, not the raw input
    expect(http.calls[0]).toContain(encodeURIComponent(YT_URL));
  });

  it('uses the Data API when a key is configured (key goes in a header, not the URL)', async () => {
    const http = fakeHttp(() => ({
      status: 200,
      body: {
        items: [
          {
            snippet: { title: 'Official title', channelTitle: 'Chan', thumbnails: { high: { url: 'https://i.ytimg.com/h.jpg' } } },
            contentDetails: { duration: 'PT1H2M3S' },
          },
        ],
      },
    }));
    const adapter = adaptersWith({ YOUTUBE_API_KEY: 'k-123' }, http).youtube;
    const { metadata } = await adapter.resolve(adapter.validate(YT_URL));
    expect(metadata).toMatchObject({ title: 'Official title', durationSeconds: 3723, thumbnailUrl: 'https://i.ytimg.com/h.jpg' });
    expect(http.calls.some((call) => call.includes('k-123'))).toBe(false);
    expect(vi.mocked(http.getJson).mock.calls[0]?.[1]?.headers).toEqual({ 'x-goog-api-key': 'k-123' });
  });

  it('reports a missing/private video', async () => {
    const http = fakeHttp(() => ({ status: 404, body: null }));
    const adapter = adaptersWith({}, http).youtube;
    const { availability } = await adapter.resolve(adapter.validate(YT_URL));
    expect(availability).toMatchObject({ status: 'unavailable', reason: { code: 'PRIVATE_CONTENT' } });
  });

  it('still answers (with null metadata) when metadata services fail', async () => {
    const http = fakeHttp(() => {
      throw new Error('network down');
    });
    const adapter = adaptersWith({}, http).youtube;
    const resolved = await adapter.resolve(adapter.validate(YT_URL));
    expect(resolved.metadata).toBeNull();
    expect(resolved.availability.status).toBe('unavailable');
  });

  it('refuses to produce a source — there is no permitted route', async () => {
    const adapter = adaptersWith({}, fakeHttp(() => ({ status: 200, body: {} }))).youtube;
    await expect(adapter.getSource(adapter.validate(YT_URL), 'mp4')).rejects.toMatchObject({ code: 'UNAUTHORIZED_SOURCE' });
    expect(adapter.describe()).toMatchObject({ capability: 'metadata-only' });
  });

  it('rejects URLs that belong to other platforms', () => {
    const { youtube } = adaptersWith({}, fakeHttp(() => ({ status: 200, body: {} })));
    expect(() => youtube.validate('https://www.instagram.com/reel/Cabc123XYZ/')).toThrowError(/not a YouTube link/);
    expect(() => youtube.validate('http://127.0.0.1/')).toThrowError();
  });

  it('parses ISO durations', () => {
    expect(parseIsoDuration('PT45S')).toBe(45);
    expect(parseIsoDuration('PT10M')).toBe(600);
    expect(parseIsoDuration('P1DT1H')).toBe(90000);
    expect(parseIsoDuration('nonsense')).toBeNull();
    expect(parseIsoDuration(undefined)).toBeNull();
  });
});

const IG_URL = 'https://www.instagram.com/reel/Cabc123XYZ/';

function igMedia(overrides: Record<string, unknown> = {}) {
  return {
    id: '1789',
    caption: 'My reel\nsecond line',
    media_type: 'VIDEO',
    media_url: 'https://scontent.cdninstagram.com/v/video.mp4',
    thumbnail_url: 'https://scontent.cdninstagram.com/v/thumb.jpg',
    permalink: 'https://www.instagram.com/reel/Cabc123XYZ/',
    ...overrides,
  };
}

describe('InstagramAdapter', () => {
  const env = { INSTAGRAM_ACCESS_TOKEN: 'ig-token-xyz' };

  it('is unavailable (NOT_CONFIGURED) without a token and makes no network calls', async () => {
    const http = fakeHttp(() => ({ status: 200, body: {} }));
    const adapter = adaptersWith({}, http).instagram;
    const { availability } = await adapter.resolve(adapter.validate(IG_URL));
    expect(availability).toMatchObject({ status: 'unavailable', reason: { code: 'NOT_CONFIGURED' } });
    expect(http.calls).toHaveLength(0);
    expect(adapter.describe().configured).toBe(false);
    await expect(adapter.getSource(adapter.validate(IG_URL), 'mp4')).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });

  it('offers MP4 + MP3 for a video that belongs to the connected account', async () => {
    const http = fakeHttp((url) => (url.pathname.endsWith('/me') ? { status: 200, body: { username: 'myshop' } } : { status: 200, body: { data: [igMedia()] } }));
    const adapter = adaptersWith(env, http).instagram;
    const { metadata, availability } = await adapter.resolve(adapter.validate(IG_URL));

    expect(metadata).toMatchObject({ title: 'My reel', author: 'myshop' });
    expect(availability.status).toBe('available');
    if (availability.status === 'available') {
      expect(availability.options.map((o) => o.format)).toEqual(['mp4', 'mp3']);
      expect(availability.options[0]?.sizeBytes).toBe(1_500_000);
      expect(availability.options[1]?.sizeBytes).toBeNull(); // MP3 size is never guessed
      expect(availability.options.every((o) => o.resolution === null)).toBe(true); // never fabricated
    }
  });

  it("says 'not yours' for a post outside the connected account and offers nothing", async () => {
    const http = fakeHttp(() => ({ status: 200, body: { data: [igMedia({ permalink: 'https://www.instagram.com/reel/SomethingElse1/' })] } }));
    const adapter = adaptersWith(env, http).instagram;
    const { availability } = await adapter.resolve(adapter.validate(IG_URL));
    expect(availability).toMatchObject({ status: 'unavailable', reason: { code: 'UNAUTHORIZED_SOURCE' } });
    await expect(adapter.getSource(adapter.validate(IG_URL), 'mp4')).rejects.toMatchObject({ code: 'UNAUTHORIZED_SOURCE' });
  });

  it('pages through the account media until it finds the post', async () => {
    let page = 0;
    const http = fakeHttp((url) => {
      if (url.pathname.endsWith('/me')) return { status: 200, body: { username: 'u' } };
      page += 1;
      return page < 3
        ? { status: 200, body: { data: [igMedia({ permalink: 'https://www.instagram.com/p/Other00001/' })], paging: { next: 'https://graph.instagram.com/v23.0/me/media?after=abc&access_token=ig-token-xyz' } } }
        : { status: 200, body: { data: [igMedia()] } };
    });
    const adapter = adaptersWith(env, http).instagram;
    const { availability } = await adapter.resolve(adapter.validate(IG_URL));
    expect(availability.status).toBe('available');
    expect(page).toBe(3);
  });

  it('refuses photos and carousels', async () => {
    for (const media_type of ['IMAGE', 'CAROUSEL_ALBUM']) {
      const http = fakeHttp((url) => (url.pathname.endsWith('/me') ? { status: 200, body: {} } : { status: 200, body: { data: [igMedia({ media_type })] } }));
      const adapter = adaptersWith(env, http).instagram;
      const { availability } = await adapter.resolve(adapter.validate(IG_URL));
      expect(availability).toMatchObject({ status: 'unavailable', reason: { code: 'UNSUPPORTED_MEDIA' } });
    }
  });

  it('explains videos Instagram will not hand over (no media_url)', async () => {
    const http = fakeHttp((url) => (url.pathname.endsWith('/me') ? { status: 200, body: {} } : { status: 200, body: { data: [igMedia({ media_url: undefined })] } }));
    const adapter = adaptersWith(env, http).instagram;
    const { availability } = await adapter.resolve(adapter.validate(IG_URL));
    expect(availability).toMatchObject({ status: 'unavailable', reason: { code: 'METADATA_MISSING' } });
  });

  it('returns the authorised media URL and CDN allowlist from getSource', async () => {
    const http = fakeHttp((url) => (url.pathname.endsWith('/me') ? { status: 200, body: {} } : { status: 200, body: { data: [igMedia()] } }));
    const adapter = adaptersWith(env, http).instagram;
    const source = await adapter.getSource(adapter.validate(IG_URL), 'mp3');
    expect(source.url).toBe('https://scontent.cdninstagram.com/v/video.mp4');
    expect(source.allowedHostSuffixes).toContain('cdninstagram.com');
  });

  it('maps token expiry and rate limits to clear, correctly-retryable errors', async () => {
    const expired = fakeHttp(() => ({ status: 400, body: { error: { message: 'Error validating access token', type: 'OAuthException', code: 190 } } }));
    const e1 = await adaptersWith(env, expired).instagram.resolve(adaptersWith(env, expired).instagram.validate(IG_URL)).catch((e: unknown) => e);
    expect(e1).toMatchObject({ code: 'PLATFORM_API_ERROR', retryable: false });
    expect((e1 as Error).message).toMatch(/expired/i);
    expect((e1 as Error).message).not.toContain('ig-token-xyz');

    const limited = fakeHttp(() => ({ status: 400, body: { error: { code: 4, message: 'Application request limit reached' } } }));
    const e2 = await adaptersWith(env, limited).instagram.resolve(adaptersWith(env, limited).instagram.validate(IG_URL)).catch((e: unknown) => e);
    expect(e2).toMatchObject({ code: 'PLATFORM_API_ERROR', retryable: true });
  });

  it('extracts shortcodes from permalinks', () => {
    expect(shortcodeFromPermalink('https://www.instagram.com/reel/Cabc123XYZ/')).toBe('Cabc123XYZ');
    expect(shortcodeFromPermalink('https://www.instagram.com/someone/p/Cabc123XYZ/')).toBe('Cabc123XYZ');
    expect(shortcodeFromPermalink('https://example.com/')).toBeNull();
    expect(shortcodeFromPermalink(undefined)).toBeNull();
  });
});

const FB_URL = 'https://www.facebook.com/watch/?v=1234567890123';

function fbVideo(overrides: Record<string, unknown> = {}) {
  return {
    id: '1234567890123',
    title: 'Page video',
    length: 95.5,
    picture: 'https://scontent.xx.fbcdn.net/thumb.jpg',
    source: 'https://video.xx.fbcdn.net/v/file.mp4',
    from: { name: 'My Page' },
    ...overrides,
  };
}

describe('FacebookAdapter', () => {
  const env = { FACEBOOK_ACCESS_TOKEN: 'fb-token-xyz' };

  it('is unavailable (NOT_CONFIGURED) without a token', async () => {
    const http = fakeHttp(() => ({ status: 200, body: {} }));
    const adapter = adaptersWith({}, http).facebook;
    const { availability } = await adapter.resolve(adapter.validate(FB_URL));
    expect(availability).toMatchObject({ status: 'unavailable', reason: { code: 'NOT_CONFIGURED' } });
    expect(http.calls).toHaveLength(0);
  });

  it('offers MP4 + MP3 when Facebook returns the video file for the connected account', async () => {
    const http = fakeHttp(() => ({ status: 200, body: fbVideo() }));
    const adapter = adaptersWith(env, http).facebook;
    const { metadata, availability } = await adapter.resolve(adapter.validate(FB_URL));
    expect(metadata).toMatchObject({ title: 'Page video', author: 'My Page', durationSeconds: 95.5 });
    expect(availability.status).toBe('available');
    const called = new URL(http.calls[0]!);
    expect(called.hostname).toBe('graph.facebook.com');
    expect(called.pathname).toBe('/v23.0/1234567890123');
  });

  it('treats permission errors as "inaccessible", not as a server fault', async () => {
    for (const code of [100, 10, 200, 803]) {
      const http = fakeHttp(() => ({ status: 400, body: { error: { message: 'Unsupported get request', type: 'GraphMethodException', code } } }));
      const adapter = adaptersWith(env, http).facebook;
      const { availability } = await adapter.resolve(adapter.validate(FB_URL));
      expect(availability).toMatchObject({ status: 'unavailable', reason: { code: 'PRIVATE_CONTENT' } });
    }
  });

  it('does not offer a download when Facebook withholds the file', async () => {
    const http = fakeHttp(() => ({ status: 200, body: fbVideo({ source: undefined }) }));
    const adapter = adaptersWith(env, http).facebook;
    const { availability } = await adapter.resolve(adapter.validate(FB_URL));
    expect(availability).toMatchObject({ status: 'unavailable', reason: { code: 'UNAUTHORIZED_SOURCE' } });
    await expect(adapter.getSource(adapter.validate(FB_URL), 'mp4')).rejects.toMatchObject({ code: 'UNAUTHORIZED_SOURCE' });
  });

  it('refuses videos over the duration limit', async () => {
    const http = fakeHttp(() => ({ status: 200, body: fbVideo({ length: 99_999 }) }));
    const adapter = adaptersWith({ ...env, MAX_DURATION_MINUTES: '10' }, http).facebook;
    const { availability } = await adapter.resolve(adapter.validate(FB_URL));
    expect(availability).toMatchObject({ status: 'unavailable', reason: { code: 'FILE_TOO_LARGE' } });
  });

  it('surfaces token expiry as a real error (never silently as "private")', async () => {
    const http = fakeHttp(() => ({ status: 400, body: { error: { code: 190, message: 'expired' } } }));
    const adapter = adaptersWith(env, http).facebook;
    await expect(adapter.resolve(adapter.validate(FB_URL))).rejects.toMatchObject({ code: 'PLATFORM_API_ERROR', retryable: false });
  });

  it('returns the authorised file URL + CDN allowlist from getSource', async () => {
    const http = fakeHttp(() => ({ status: 200, body: fbVideo() }));
    const adapter = adaptersWith(env, http).facebook;
    const source = await adapter.getSource(adapter.validate(FB_URL), 'mp4');
    expect(source.url).toBe('https://video.xx.fbcdn.net/v/file.mp4');
    expect(source.allowedHostSuffixes).toContain('fbcdn.net');
  });

  it('rejects an unexpected API payload', async () => {
    const http = fakeHttp(() => ({ status: 200, body: { nope: true } }));
    const adapter = adaptersWith(env, http).facebook;
    await expect(adapter.resolve(adapter.validate(FB_URL))).rejects.toMatchObject({ code: 'PLATFORM_API_ERROR' });
  });
});

describe('adapter registry', () => {
  it('registers one adapter per platform with a consistent interface', () => {
    const registry = adaptersWith({}, fakeHttp(() => ({ status: 200, body: {} })));
    expect(Object.keys(registry).sort()).toEqual(['facebook', 'instagram', 'youtube']);
    for (const [platform, adapter] of Object.entries(registry)) {
      expect(adapter.platform).toBe(platform);
      expect(adapter.displayName.length).toBeGreaterThan(2);
      expect(adapter.describe().summary.length).toBeGreaterThan(20);
    }
  });
});
