import { describe, expect, it } from 'vitest';
import { detectUrl, guessPlatform, isPrivateOrLocalHostname } from './platforms';

function ok(input: string) {
  const result = detectUrl(input);
  if (!result.ok) throw new Error(`expected ok for ${input}, got ${result.code}: ${result.message}`);
  return result;
}

function rejected(input: string) {
  const result = detectUrl(input);
  if (result.ok) throw new Error(`expected rejection for ${input}, got ${result.canonicalUrl}`);
  return result;
}

describe('YouTube URL detection', () => {
  const id = 'dQw4w9WgXcQ';

  it.each([
    [`https://www.youtube.com/watch?v=${id}`],
    [`https://youtube.com/watch?v=${id}&t=42s&list=PL123`],
    [`https://m.youtube.com/watch?v=${id}`],
    [`https://music.youtube.com/watch?v=${id}`],
    [`https://youtu.be/${id}`],
    [`https://youtu.be/${id}?si=abc`],
    [`https://www.youtube.com/shorts/${id}`],
    [`https://www.youtube.com/embed/${id}`],
    [`https://www.youtube.com/live/${id}`],
    [`youtube.com/watch?v=${id}`],
    [`  https://www.youtube.com/watch?v=${id}  `],
    [`HTTPS://WWW.YOUTUBE.COM/watch?v=${id}`],
    [`http://www.youtube.com/watch?v=${id}`],
    [`https://www.youtube.com./watch?v=${id}`],
  ])('accepts %s', (input) => {
    const result = ok(input);
    expect(result.platform).toBe('youtube');
    expect(result.mediaId).toBe(id);
    expect(result.canonicalUrl).toBe(`https://www.youtube.com/watch?v=${id}`);
  });

  it('marks Shorts as short', () => {
    expect(ok(`https://www.youtube.com/shorts/${id}`).kind).toBe('short');
  });

  it('rejects non-video pages with a useful message', () => {
    for (const input of [
      'https://www.youtube.com/',
      'https://www.youtube.com/playlist?list=PL123',
      'https://www.youtube.com/@somechannel',
      'https://www.youtube.com/channel/UC123',
    ]) {
      const result = rejected(input);
      expect(result.code).toBe('UNSUPPORTED_URL_TYPE');
      expect(result.platform).toBe('youtube');
    }
  });

  it('rejects malformed video IDs', () => {
    expect(rejected('https://www.youtube.com/watch?v=short').code).toBe('INVALID_URL');
    expect(rejected('https://www.youtube.com/watch').code).toBe('INVALID_URL');
    expect(rejected('https://youtu.be/').code).toBe('INVALID_URL');
    expect(rejected(`https://www.youtube.com/watch?v=${id}%00`).code).toBe('INVALID_URL');
  });
});

describe('Instagram URL detection', () => {
  it.each([
    ['https://www.instagram.com/p/Cabc123XYZ/', 'p', 'post'],
    ['https://www.instagram.com/reel/Cabc123XYZ/', 'reel', 'reel'],
    ['https://www.instagram.com/reels/Cabc123XYZ/', 'reel', 'reel'],
    ['https://www.instagram.com/tv/Cabc123XYZ/', 'tv', 'post'],
    ['https://www.instagram.com/someuser/reel/Cabc123XYZ/?igsh=abc', 'reel', 'reel'],
    ['https://www.instagram.com/someuser/p/Cabc123XYZ', 'p', 'post'],
    ['instagram.com/reel/Cabc123XYZ', 'reel', 'reel'],
    ['https://instagr.am/p/Cabc123XYZ/', 'p', 'post'],
  ])('accepts %s', (input, path, kind) => {
    const result = ok(input);
    expect(result.platform).toBe('instagram');
    expect(result.mediaId).toBe('Cabc123XYZ');
    expect(result.kind).toBe(kind);
    expect(result.canonicalUrl).toBe(`https://www.instagram.com/${path}/Cabc123XYZ/`);
  });

  it('rejects stories, share links and profiles', () => {
    for (const input of [
      'https://www.instagram.com/stories/someuser/123456789/',
      'https://www.instagram.com/share/reel/BAbc123/',
      'https://www.instagram.com/someuser/',
      'https://www.instagram.com/',
      'https://www.instagram.com/explore/',
    ]) {
      const result = rejected(input);
      expect(result.code).toBe('UNSUPPORTED_URL_TYPE');
      expect(result.platform).toBe('instagram');
    }
  });

  it('rejects post codes that are too short', () => {
    expect(rejected('https://www.instagram.com/p/ab/').code).toBe('INVALID_URL');
  });
});

describe('Facebook URL detection', () => {
  it.each([
    ['https://www.facebook.com/watch/?v=1234567890123', 'video'],
    ['https://www.facebook.com/watch?v=1234567890123', 'video'],
    ['https://m.facebook.com/watch/?v=1234567890123', 'video'],
    ['https://web.facebook.com/watch/?v=1234567890123', 'video'],
    ['https://www.facebook.com/video.php?v=1234567890123', 'video'],
    ['https://www.facebook.com/somepage/videos/1234567890123/', 'video'],
    ['https://www.facebook.com/somepage/videos/some-title-slug/1234567890123/', 'video'],
    ['https://www.facebook.com/reel/1234567890123', 'reel'],
    ['facebook.com/watch/?v=1234567890123', 'video'],
  ])('accepts %s', (input, kind) => {
    const result = ok(input);
    expect(result.platform).toBe('facebook');
    expect(result.mediaId).toBe('1234567890123');
    expect(result.kind).toBe(kind);
    expect(result.canonicalUrl).toBe('https://www.facebook.com/watch/?v=1234567890123');
  });

  it('rejects short links, share links and non-video pages', () => {
    for (const input of [
      'https://fb.watch/abc123/',
      'https://www.facebook.com/share/v/AbC123/',
      'https://www.facebook.com/somepage/posts/123456789',
      'https://www.facebook.com/somepage',
      'https://www.facebook.com/',
    ]) {
      const result = rejected(input);
      expect(result.code).toBe('UNSUPPORTED_URL_TYPE');
      expect(result.platform).toBe('facebook');
    }
  });

  it('rejects malformed video IDs', () => {
    expect(rejected('https://www.facebook.com/watch/?v=abc').code).toBe('INVALID_URL');
    expect(rejected('https://www.facebook.com/watch/').code).toBe('INVALID_URL');
  });
});

describe('invalid URL detection', () => {
  it.each([
    [''],
    ['   '],
    ['not a url'],
    ['just-some-words'],
    ['https://'],
    ['ht!tp://youtube.com'],
    ['javascript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['mailto:someone@example.com'],
    ['https://youtube.com/watch?v=dQw4w9WgXcQ https://youtube.com/watch?v=dQw4w9WgXcQ'],
  ])('rejects %j as INVALID_URL', (input) => {
    expect(rejected(input).code).toBe('INVALID_URL');
  });

  it('rejects over-long input', () => {
    expect(rejected(`https://www.youtube.com/watch?v=dQw4w9WgXcQ&x=${'a'.repeat(3000)}`).code).toBe('INVALID_URL');
  });

  it('rejects non-http protocols even when they carry an allowed host', () => {
    expect(rejected('ftp://www.youtube.com/watch?v=dQw4w9WgXcQ').code).toBe('INVALID_URL');
    expect(rejected('file:///etc/passwd').code).toBe('INVALID_URL');
  });

  it('rejects credentials in the URL (host-confusion trick)', () => {
    expect(rejected('https://www.youtube.com@evil.example/watch?v=dQw4w9WgXcQ').code).toBe('INVALID_URL');
    expect(rejected('https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ').code).toBe('INVALID_URL');
  });

  it('rejects custom ports', () => {
    expect(rejected('https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ').code).toBe('INVALID_URL');
  });
});

describe('unsupported domain rejection', () => {
  it.each([
    ['https://vimeo.com/123456'],
    ['https://example.com/watch?v=dQw4w9WgXcQ'],
    ['https://www.tiktok.com/@user/video/123'],
    ['https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ'],
    ['https://evil.example/youtube.com/watch?v=dQw4w9WgXcQ'],
    ['https://notyoutube.com/watch?v=dQw4w9WgXcQ'],
    ['https://youtube.co/watch?v=dQw4w9WgXcQ'],
    ['https://www.instagram.com.evil.example/p/Cabc123XYZ/'],
    ['https://facebook.com.evil.example/watch/?v=1234567890123'],
    ['https://xn--yutube-ixa.com/watch?v=dQw4w9WgXcQ'],
    ['https://yoütube.com/watch?v=dQw4w9WgXcQ'],
    ['https://cdn.youtube.com.example.org/x'],
  ])('rejects %s', (input) => {
    expect(rejected(input).code).toBe('UNSUPPORTED_DOMAIN');
  });
});

describe('private / local URL rejection (SSRF)', () => {
  it.each([
    ['http://localhost/watch?v=dQw4w9WgXcQ'],
    ['http://localhost:3000/'],
    ['localhost:4000/v1/files/x'],
    ['http://127.0.0.1/'],
    ['http://127.0.0.1:6379/'],
    ['http://0.0.0.0/'],
    ['http://10.0.0.5/'],
    ['http://172.16.0.1/'],
    ['http://192.168.1.1/admin'],
    ['http://169.254.169.254/latest/meta-data/'],
    ['http://[::1]/'],
    ['http://[::ffff:127.0.0.1]/'],
    ['http://[fd00::1]/'],
    ['http://2130706433/'], // decimal form of 127.0.0.1
    ['http://0x7f.0.0.1/'], // hex form
    ['http://0177.0.0.1/'], // octal form
    ['http://127.1/'], // short form
    ['http://intranet/'],
    ['http://printer.local/'],
    ['http://db.internal/'],
    ['http://metadata.google.internal/'],
    ['http://foo.localhost/'],
  ])('rejects %s as BLOCKED_ADDRESS', (input) => {
    expect(rejected(input).code).toBe('BLOCKED_ADDRESS');
  });

  it('classifies hostnames', () => {
    expect(isPrivateOrLocalHostname('localhost')).toBe(true);
    expect(isPrivateOrLocalHostname('10.1.2.3')).toBe(true);
    expect(isPrivateOrLocalHostname('[::1]')).toBe(true);
    expect(isPrivateOrLocalHostname('router.lan')).toBe(true);
    expect(isPrivateOrLocalHostname('www.youtube.com')).toBe(false);
    expect(isPrivateOrLocalHostname('example.com')).toBe(false);
  });
});

describe('guessPlatform', () => {
  it('returns the platform for a valid link', () => {
    expect(guessPlatform('https://youtu.be/dQw4w9WgXcQ')).toBe('youtube');
  });
  it('still returns the platform when only the path is unusable', () => {
    expect(guessPlatform('https://www.instagram.com/someuser/')).toBe('instagram');
    expect(guessPlatform('facebook.com/somepage')).toBe('facebook');
  });
  it('returns null for unknown or empty input', () => {
    expect(guessPlatform('')).toBeNull();
    expect(guessPlatform('https://vimeo.com/1')).toBeNull();
    expect(guessPlatform('http://localhost')).toBeNull();
  });
});
