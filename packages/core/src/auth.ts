/**
 * Minimal private-access primitives: HMAC-signed expiring tokens and password checking.
 *
 * One token format serves three purposes — sessions, signed download links and signed
 * upload links — separated by a `typ` claim so a token minted for one purpose can never be
 * replayed for another.
 */
import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

export type TokenType = 'session' | 'download' | 'upload';

export interface TokenClaims {
  typ: TokenType;
  /** Expiry, seconds since epoch. */
  exp: number;
  [claim: string]: unknown;
}

export type TokenVerification<T extends TokenClaims> =
  | { ok: true; payload: T }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'wrong_type' | 'expired' };

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(body: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(body).digest();
}

export function signToken(claims: TokenClaims, secret: string): string {
  if (!secret || secret.length < 16) throw new Error('A signing secret of at least 16 characters is required.');
  const body = base64url(JSON.stringify(claims));
  return `${body}.${base64url(sign(body, secret))}`;
}

export function verifyToken<T extends TokenClaims>(
  token: string,
  secret: string,
  expectedType: TokenType,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): TokenVerification<T> {
  if (typeof token !== 'string' || token.length > 4096) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  const [body, signature] = parts as [string, string];

  const expected = sign(body, secret);
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, 'base64url');
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: T;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof payload !== 'object' || payload === null || typeof payload.exp !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if (payload.typ !== expectedType) return { ok: false, reason: 'wrong_type' };
  if (payload.exp <= nowSeconds) return { ok: false, reason: 'expired' };
  return { ok: true, payload };
}

// ───────────────────────── passwords ─────────────────────────

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;

/** Format: `scrypt:N:r:p:<salt b64>:<hash b64>` (colons, not $, so .env loaders never try to expand it). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const { N, r, p } = SCRYPT_PARAMS;
  const derived = await scrypt(password, salt, KEY_LENGTH, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', N, r, p, salt.toString('base64'), derived.toString('base64')].join(':');
}

async function verifyScryptHash(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return false;
  // Refuse absurd cost parameters from a corrupted/malicious env value.
  if (N > 1 << 20 || r > 32 || p > 16) return false;
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (salt.length === 0 || expected.length === 0) return false;
  const derived = await scrypt(password, salt, expected.length, { N, r, p, maxmem: 256 * 1024 * 1024 });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

function constantTimeEquals(a: string, b: string): boolean {
  // Hash both sides first so the comparison is length-independent.
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

export interface PasswordConfig {
  password?: string | undefined;
  passwordHash?: string | undefined;
}

export async function verifyPassword(candidate: string, config: PasswordConfig): Promise<boolean> {
  if (config.passwordHash) return verifyScryptHash(candidate, config.passwordHash);
  if (config.password) return constantTimeEquals(candidate, config.password);
  return false;
}

// ───────────────────────── session tokens ─────────────────────────

export interface SessionClaims extends TokenClaims {
  typ: 'session';
}

export function createSessionToken(secret: string, ttlSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)) {
  const exp = nowSeconds + ttlSeconds;
  const claims: SessionClaims = { typ: 'session', exp, jti: randomBytes(8).toString('hex') };
  return { token: signToken(claims, secret), expiresAt: new Date(exp * 1000) };
}

export function verifySessionToken(token: string, secret: string, nowSeconds?: number): TokenVerification<SessionClaims> {
  return verifyToken<SessionClaims>(token, secret, 'session', nowSeconds);
}
