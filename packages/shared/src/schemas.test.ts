import { describe, expect, it } from 'vitest';
import { buildOutputFilename, formatBytes, formatDuration, sanitizeFilename } from './filenames';
import { AppError, ERROR_CATALOGUE, ERROR_CODES, toApiErrorBody } from './errors';
import {
  createJobRequestSchema,
  jobIdSchema,
  loginRequestSchema,
  resolveRequestSchema,
  uploadTicketRequestSchema,
} from './schemas';

describe('API input validation', () => {
  it('accepts and trims a resolve request', () => {
    expect(resolveRequestSchema.parse({ url: '  https://youtu.be/dQw4w9WgXcQ ' })).toEqual({
      url: 'https://youtu.be/dQw4w9WgXcQ',
    });
  });

  it('rejects empty, missing and non-string URLs', () => {
    expect(resolveRequestSchema.safeParse({ url: '' }).success).toBe(false);
    expect(resolveRequestSchema.safeParse({ url: '   ' }).success).toBe(false);
    expect(resolveRequestSchema.safeParse({}).success).toBe(false);
    expect(resolveRequestSchema.safeParse({ url: 42 }).success).toBe(false);
    expect(resolveRequestSchema.safeParse({ url: 'x'.repeat(2049) }).success).toBe(false);
  });

  it('validates URL jobs', () => {
    expect(createJobRequestSchema.safeParse({ source: 'url', url: 'https://youtu.be/dQw4w9WgXcQ', format: 'mp4' }).success).toBe(true);
    expect(createJobRequestSchema.safeParse({ source: 'url', url: 'https://youtu.be/dQw4w9WgXcQ', format: 'avi' }).success).toBe(false);
    expect(createJobRequestSchema.safeParse({ source: 'url', format: 'mp3' }).success).toBe(false);
  });

  it('validates upload jobs', () => {
    const uploadId = crypto.randomUUID();
    expect(createJobRequestSchema.safeParse({ source: 'upload', uploadId, format: 'mp3' }).success).toBe(true);
    expect(createJobRequestSchema.safeParse({ source: 'upload', uploadId: '../../etc/passwd', format: 'mp3' }).success).toBe(false);
    expect(createJobRequestSchema.safeParse({ source: 'other', format: 'mp3' }).success).toBe(false);
  });

  it('only accepts UUID job ids', () => {
    expect(jobIdSchema.safeParse(crypto.randomUUID()).success).toBe(true);
    expect(jobIdSchema.safeParse('1').success).toBe(false);
    expect(jobIdSchema.safeParse('../secret').success).toBe(false);
  });

  it('validates upload tickets', () => {
    const base = { filename: 'holiday.mp4', size: 1024, contentType: 'video/mp4' };
    expect(uploadTicketRequestSchema.safeParse(base).success).toBe(true);
    expect(uploadTicketRequestSchema.safeParse({ ...base, filename: 'payload.exe' }).success).toBe(false);
    expect(uploadTicketRequestSchema.safeParse({ ...base, filename: 'noextension' }).success).toBe(false);
    expect(uploadTicketRequestSchema.safeParse({ ...base, size: 0 }).success).toBe(false);
    expect(uploadTicketRequestSchema.safeParse({ ...base, size: -5 }).success).toBe(false);
    expect(uploadTicketRequestSchema.safeParse({ ...base, size: 1.5 }).success).toBe(false);
    expect(uploadTicketRequestSchema.safeParse({ ...base, contentType: 'not a type' }).success).toBe(false);
    expect(uploadTicketRequestSchema.parse({ filename: 'a.mp3', size: 5 }).contentType).toBe('application/octet-stream');
  });

  it('validates login requests', () => {
    expect(loginRequestSchema.safeParse({ password: 'secret' }).success).toBe(true);
    expect(loginRequestSchema.safeParse({ password: '' }).success).toBe(false);
    expect(loginRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('error catalogue', () => {
  it('has a definition for every code', () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_CATALOGUE[code].message.length).toBeGreaterThan(10);
      expect(ERROR_CATALOGUE[code].status).toBeGreaterThanOrEqual(400);
    }
  });

  it('serialises AppError without leaking the cause', () => {
    const error = new AppError('STORAGE_FAILURE', undefined, { cause: new Error('secret internal detail'), guidance: ['Try again.'] });
    const body = toApiErrorBody(error);
    expect(body.error.code).toBe('STORAGE_FAILURE');
    expect(body.error.retryable).toBe(true);
    expect(body.error.guidance).toEqual(['Try again.']);
    expect(JSON.stringify(body)).not.toContain('secret internal detail');
  });

  it('allows overriding message, status and retryability', () => {
    const error = new AppError('PLATFORM_API_ERROR', 'Token expired', { retryable: false, status: 503 });
    expect(error.message).toBe('Token expired');
    expect(error.status).toBe(503);
    expect(error.retryable).toBe(false);
  });
});

describe('filenames & formatting', () => {
  it('removes path separators and reserved characters', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('etc passwd');
    expect(sanitizeFilename('a<b>c:d"e/f\\g|h?i*j')).toBe('a b c d e f g h i j');
    expect(sanitizeFilename('..hidden')).toBe('hidden');
    expect(sanitizeFilename('trailing dots...')).toBe('trailing dots');
  });

  it('removes control, bidi and zero-width characters', () => {
    const hostile = ['a', String.fromCodePoint(0), 'b', String.fromCodePoint(0x202e), 'c', String.fromCodePoint(0x200b), 'd'].join('');
    expect(sanitizeFilename(hostile)).toBe('a bcd');
  });

  it('falls back for empty and reserved names', () => {
    expect(sanitizeFilename('')).toBe('media');
    expect(sanitizeFilename(null)).toBe('media');
    expect(sanitizeFilename('CON')).toBe('media');
    expect(sanitizeFilename('???', 'clip')).toBe('clip');
  });

  it('keeps unicode titles and caps the length', () => {
    expect(sanitizeFilename('Монгол дуу ♥')).toBe('Монгол дуу ♥');
    expect(sanitizeFilename('x'.repeat(500)).length).toBeLessThanOrEqual(120);
  });

  it('builds output filenames', () => {
    expect(buildOutputFilename('My: Video?', 'mp4')).toBe('My Video.mp4');
    expect(buildOutputFilename(null, 'mp3')).toBe('media.mp3');
  });

  it('formats bytes and durations', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(-1)).toBe('—');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(null)).toBe('—');
  });
});
