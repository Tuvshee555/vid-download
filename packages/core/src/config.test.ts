import { describe, expect, it } from 'vitest';
import { ConfigError, assertApiConfig, loadConfig } from './config';

describe('loadConfig', () => {
  it('applies safe defaults', () => {
    const config = loadConfig({});
    expect(config.env).toBe('development');
    expect(config.server.port).toBe(4000);
    expect(config.storage.driver).toBe('local');
    expect(config.limits.fileTtlMs).toBe(60 * 60_000);
    expect(config.limits.maxInputBytes).toBe(1024 * 1024 * 1024);
    expect(config.ytdlp.cookiesContent).toBeNull();
  });

  it('treats empty values like unset (so .env.example can list every key)', () => {
    const config = loadConfig({ PORT: '', ACCESS_PASSWORD: '', YTDLP_COOKIES: '   ' });
    expect(config.server.port).toBe(4000);
    expect(config.auth.password).toBeUndefined();
    expect(config.ytdlp.cookiesContent).toBeNull();
  });

  it('parses numbers, booleans and origin lists', () => {
    const config = loadConfig({
      PORT: '8080',
      TRUST_PROXY: 'true',
      WEB_ORIGIN: 'https://a.example.com/, https://b.example.com',
      FILE_TTL_MINUTES: '30',
      MAX_INPUT_MB: '10',
    });
    expect(config.server.port).toBe(8080);
    expect(config.server.trustProxy).toBe(true);
    expect(config.server.webOrigins).toEqual(['https://a.example.com', 'https://b.example.com']);
    expect(config.limits.fileTtlMs).toBe(30 * 60_000);
    expect(config.limits.maxInputBytes).toBe(10 * 1024 * 1024);
  });

  it('rejects invalid values with a readable message', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrowError(ConfigError);
    expect(() => loadConfig({ PORT: 'abc' })).toThrowError(/PORT/);
    expect(() => loadConfig({ SESSION_SECRET: 'too-short' })).toThrowError(/SESSION_SECRET/);
    expect(() => loadConfig({ X264_PRESET: 'warp-speed' })).toThrowError(/X264_PRESET/);
  });

  it('treats FFPROBE_PATH=none as "inspect with ffmpeg" and defaults the yt-dlp settings', () => {
    expect(loadConfig({ FFPROBE_PATH: 'none' }).ffmpeg.ffprobePath).toBeNull();
    expect(loadConfig({}).ffmpeg.ffprobePath).toBe('ffprobe');
    expect(loadConfig({}).ytdlp).toMatchObject({ binPath: 'yt-dlp', cookiesContent: null });
    expect(loadConfig({}).ytdlp.jsRuntime).toMatch(/^node:/);
    expect(loadConfig({}).ffmpeg.x264Preset).toBe('veryfast');
  });

  it('requires bucket credentials for the s3 driver', () => {
    expect(() => loadConfig({ STORAGE_DRIVER: 's3' })).toThrowError(/S3_BUCKET/);
    const config = loadConfig({
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'b',
      S3_ACCESS_KEY_ID: 'id',
      S3_SECRET_ACCESS_KEY: 'secret',
      S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
    });
    expect(config.storage).toMatchObject({ driver: 's3', bucket: 'b', endpoint: 'https://acct.r2.cloudflarestorage.com' });
  });

  it('generates an ephemeral session secret outside production when none is set', () => {
    const a = loadConfig({});
    const b = loadConfig({});
    expect(a.auth.sessionSecretIsEphemeral).toBe(true);
    expect(a.auth.sessionSecret).not.toBe(b.auth.sessionSecret);
  });
});

describe('assertApiConfig', () => {
  it('requires an access password', () => {
    expect(() => assertApiConfig(loadConfig({}))).toThrowError(/access password/i);
    expect(() => assertApiConfig(loadConfig({ ACCESS_PASSWORD: 'x' }))).not.toThrow();
    expect(() => assertApiConfig(loadConfig({ ACCESS_PASSWORD_HASH: 'scrypt:1:1:1:a:b' }))).not.toThrow();
  });

  it('is strict in production', () => {
    const base = { NODE_ENV: 'production', ACCESS_PASSWORD: 'x' };
    expect(() => assertApiConfig(loadConfig(base))).toThrowError(/SESSION_SECRET/);
    expect(() => assertApiConfig(loadConfig({ ...base, SESSION_SECRET: 's'.repeat(40) }))).not.toThrow();
    expect(() => assertApiConfig(loadConfig({ ...base, SESSION_SECRET: 's'.repeat(40), WEB_ORIGIN: '*' }))).toThrowError(/WEB_ORIGIN/);
  });
});
