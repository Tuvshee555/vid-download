import { describe, expect, it } from 'vitest';
import { formatArgs, mapYtDlpError, metadataFromInfo } from './ytdlp';

describe('yt-dlp error mapping (real yt-dlp messages)', () => {
  it.each([
    ['ERROR: [youtube] jNQXAC9IVRw: Sign in to confirm you’re not a bot. This helps protect our community.', 'youtube', 'PLATFORM_API_ERROR', /blocking this server/],
    ['ERROR: [Instagram] C9yQJ4-oJ2H: Instagram sent an empty media response. Check if this post is accessible in your browser without being logged-in.', 'instagram', 'PRIVATE_CONTENT', /private/],
    ['ERROR: [youtube] abc: Private video. Sign in if you\'ve been granted access to this video', 'youtube', 'PRIVATE_CONTENT', /private/],
    ['ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader', 'youtube', 'NOT_FOUND', /removed/],
    ['ERROR: [TikTok] 123: Video not available, status code 10204', 'tiktok', 'NOT_FOUND', /TikTok/],
    ['ERROR: [youtube] abc: This live event will begin in 3 hours.', 'youtube', 'UNSUPPORTED_MEDIA', /Live/],
    ['ERROR: [generic] Unsupported URL: https://www.facebook.com/somepage', 'facebook', 'UNSUPPORTED_URL_TYPE', /./],
    ['ERROR: [facebook] 1: Requested format is not available. Use --list-formats', 'facebook', 'UNSUPPORTED_MEDIA', /no downloadable video/],
    ['ERROR: [instagram] x: HTTP Error 429: Too Many Requests', 'instagram', 'RATE_LIMITED', /rate-limiting/],
    ['ERROR: [tiktok] x: Unable to download webpage: <urlopen error timed out>', 'tiktok', 'NETWORK_TIMEOUT', /reach TikTok/],
    ['ERROR: [facebook] 637842556329505: Cannot parse data; please report this issue', 'facebook', 'PLATFORM_API_ERROR', /Facebook/],
  ] as const)('%s → %s', (stderr, platform, code, message) => {
    const error = mapYtDlpError(`[debug] something\n${stderr}\n`, platform);
    expect(error.code).toBe(code);
    expect(error.message).toMatch(message);
    expect(error.message).not.toContain('ERROR:'); // raw tool output never reaches the user
  });

  it('gives YouTube bot blocks a way forward and marks them non-retryable', () => {
    const error = mapYtDlpError('ERROR: [youtube] x: Sign in to confirm you’re not a bot', 'youtube');
    expect(error.retryable).toBe(false);
    expect(error.guidance?.join(' ')).toMatch(/own computer|cookies/);
  });
});

describe('format selection', () => {
  it('prefers H.264/AAC MP4 at the requested quality, capped at 1080p', () => {
    expect(formatArgs('mp4', 720)).toEqual(['-f', 'bv*+ba/b', '-S', 'res:720,vcodec:h264,acodec:m4a', '--merge-output-format', 'mp4']);
    expect(formatArgs('mp4', null)).toContain('res:1080,vcodec:h264,acodec:m4a');
    expect(formatArgs('mp4', 2160)).toContain('res:1080,vcodec:h264,acodec:m4a');
  });

  it('grabs only the best audio for MP3', () => {
    expect(formatArgs('mp3', null)).toEqual(['-f', 'ba/b']);
  });
});

describe('metadata', () => {
  it('uses the caption when the title is generic, and trims long captions', () => {
    expect(metadataFromInfo({ title: 'Video by 433', description: `${'x'.repeat(300)}\nmore` }).title).toHaveLength(100);
    expect(metadataFromInfo({ title: 'Real title', uploader: 'U', duration: 0 })).toEqual({ title: 'Real title', author: 'U', thumbnailUrl: null, durationSeconds: null });
  });
});
