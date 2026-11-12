import { describe, expect, it } from 'vitest';
import { createSessionToken, hashPassword, signToken, verifySessionToken, verifyPassword, verifyToken } from './auth';

const SECRET = 'a-test-secret-that-is-long-enough-1234567890';
const NOW = 1_800_000_000;

describe('signed tokens', () => {
  it('round-trips claims', () => {
    const token = signToken({ typ: 'download', exp: NOW + 60, k: 'outputs/x/output.mp4' }, SECRET);
    const result = verifyToken(token, SECRET, 'download', NOW);
    expect(result).toMatchObject({ ok: true, payload: { k: 'outputs/x/output.mp4' } });
  });

  it('rejects expired tokens', () => {
    const token = signToken({ typ: 'download', exp: NOW - 1 }, SECRET);
    expect(verifyToken(token, SECRET, 'download', NOW)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a token signed with another secret', () => {
    const token = signToken({ typ: 'session', exp: NOW + 60 }, 'another-secret-another-secret-123456');
    expect(verifyToken(token, SECRET, 'session', NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects tampered payloads (privilege/expiry edits)', () => {
    const token = signToken({ typ: 'download', exp: NOW + 60, k: 'outputs/a/output.mp4' }, SECRET);
    const [, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ typ: 'download', exp: NOW + 99999, k: 'outputs/b/output.mp4' })).toString('base64url');
    expect(verifyToken(`${forged}.${signature}`, SECRET, 'download', NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a token minted for another purpose', () => {
    const sessionToken = signToken({ typ: 'session', exp: NOW + 60 }, SECRET);
    expect(verifyToken(sessionToken, SECRET, 'download', NOW)).toEqual({ ok: false, reason: 'wrong_type' });
    const downloadToken = signToken({ typ: 'download', exp: NOW + 60 }, SECRET);
    expect(verifyToken(downloadToken, SECRET, 'session', NOW)).toEqual({ ok: false, reason: 'wrong_type' });
  });

  it.each(['', 'abc', 'a.b.c', '.', 'a.', '.b', 'x'.repeat(5000)])('rejects malformed token %#', (token) => {
    expect(verifyToken(token, SECRET, 'session', NOW).ok).toBe(false);
  });

  it('refuses to sign with a weak secret', () => {
    expect(() => signToken({ typ: 'session', exp: NOW }, 'short')).toThrow();
  });
});

describe('sessions', () => {
  it('creates a verifiable token with the right expiry', () => {
    const { token, expiresAt } = createSessionToken(SECRET, 3600, NOW);
    expect(expiresAt.getTime()).toBe((NOW + 3600) * 1000);
    expect(verifySessionToken(token, SECRET, NOW + 10).ok).toBe(true);
    expect(verifySessionToken(token, SECRET, NOW + 3601)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('passwords', () => {
  it('verifies a plain configured password in constant time', async () => {
    expect(await verifyPassword('correct horse', { password: 'correct horse' })).toBe(true);
    expect(await verifyPassword('wrong', { password: 'correct horse' })).toBe(false);
    expect(await verifyPassword('', { password: 'correct horse' })).toBe(false);
  });

  it('verifies scrypt hashes and prefers them over a plain password', async () => {
    const hash = await hashPassword('s3cret!');
    expect(hash.startsWith('scrypt:')).toBe(true);
    expect(await verifyPassword('s3cret!', { passwordHash: hash })).toBe(true);
    expect(await verifyPassword('S3cret!', { passwordHash: hash })).toBe(false);
    // hash wins even if a (different) plain password is also set
    expect(await verifyPassword('plain', { passwordHash: hash, password: 'plain' })).toBe(false);
  });

  it('produces different hashes for the same password (random salt)', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  it('fails closed on corrupt or hostile hash values', async () => {
    expect(await verifyPassword('x', { passwordHash: 'garbage' })).toBe(false);
    expect(await verifyPassword('x', { passwordHash: 'scrypt:1:1:1::' })).toBe(false);
    expect(await verifyPassword('x', { passwordHash: 'scrypt:999999999:8:1:c2FsdA==:aGFzaA==' })).toBe(false);
  });

  it('fails closed when nothing is configured', async () => {
    expect(await verifyPassword('x', {})).toBe(false);
  });
});
