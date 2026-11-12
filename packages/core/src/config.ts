/**
 * Environment-driven configuration. Secrets only ever come from the environment —
 * nothing in this repository contains a credential.
 *
 * `loadConfig` is pure (takes an env object) so tests can build configs without touching
 * `process.env`.
 */
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const MB = 1024 * 1024;
const MINUTE_MS = 60_000;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // ── API server
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  /** Comma separated list of browser origins allowed to call the API directly (uploads). */
  WEB_ORIGIN: z.string().default('http://localhost:3000'),
  /** Public base URL of the API; embedded into signed links when using local storage. */
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  /** Set true when running behind a reverse proxy (Render, Railway, Fly) so client IPs are read from X-Forwarded-For. */
  TRUST_PROXY: z.stringbool().default(false),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(120),

  // ── Private access
  ACCESS_PASSWORD: z.string().min(1).optional(),
  /** `scrypt:…` string produced by `npm run hash-password`. Preferred over ACCESS_PASSWORD. */
  ACCESS_PASSWORD_HASH: z.string().min(1).optional(),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters').optional(),
  SESSION_TTL_HOURS: z.coerce.number().min(0.1).default(24 * 7),

  // ── Redis / queue
  REDIS_URL: z.string().default('redis://localhost:6379'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),

  // ── Storage
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default(join(tmpdir(), 'mediadock-storage')),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.stringbool().default(false),

  // ── Limits
  MAX_INPUT_MB: z.coerce.number().positive().default(1024),
  MAX_OUTPUT_MB: z.coerce.number().positive().default(2048),
  MAX_DURATION_MINUTES: z.coerce.number().positive().default(240),
  DOWNLOAD_TIMEOUT_MINUTES: z.coerce.number().positive().default(15),
  PROCESSING_TIMEOUT_MINUTES: z.coerce.number().positive().default(30),
  FILE_TTL_MINUTES: z.coerce.number().positive().default(60),
  DOWNLOAD_LINK_TTL_SECONDS: z.coerce.number().int().min(30).max(86_400).default(600),

  // ── FFmpeg
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),

  // ── Official platform credentials (all optional; each integration reports "not configured" without them)
  YOUTUBE_API_KEY: z.string().optional(),
  INSTAGRAM_ACCESS_TOKEN: z.string().optional(),
  INSTAGRAM_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v23.0'),
  FACEBOOK_ACCESS_TOKEN: z.string().optional(),
  FACEBOOK_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v23.0'),
});

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  isProduction: boolean;
  logLevel: string;
  server: {
    host: string;
    port: number;
    webOrigins: string[];
    apiPublicUrl: string;
    trustProxy: boolean;
    rateLimitPerMinute: number;
  };
  auth: {
    password: string | undefined;
    passwordHash: string | undefined;
    /** Always present: a random per-process secret is generated outside production if none is configured. */
    sessionSecret: string;
    sessionSecretIsEphemeral: boolean;
    sessionTtlSeconds: number;
  };
  redis: { url: string };
  queue: { concurrency: number; maxAttempts: number };
  storage:
    | { driver: 'local'; dir: string }
    | {
        driver: 's3';
        endpoint: string | undefined;
        region: string;
        bucket: string;
        accessKeyId: string;
        secretAccessKey: string;
        forcePathStyle: boolean;
      };
  limits: {
    maxInputBytes: number;
    maxOutputBytes: number;
    maxDurationSeconds: number;
    downloadTimeoutMs: number;
    processingTimeoutMs: number;
    fileTtlMs: number;
    linkTtlSeconds: number;
  };
  ffmpeg: { ffmpegPath: string; ffprobePath: string };
  platforms: {
    youtubeApiKey: string | undefined;
    instagramAccessToken: string | undefined;
    instagramGraphVersion: string;
    facebookAccessToken: string | undefined;
    facebookGraphVersion: string;
  };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Treat `KEY=` (empty) the same as unset, so `.env.example` can list every key. */
function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.trim() !== '') cleaned[key] = value.trim();
  }
  return cleaned;
}

export function loadConfig(rawEnv: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(cleanEnv(rawEnv));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  • ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n');
    throw new ConfigError(`Invalid environment configuration:\n${problems}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';

  const sessionSecret = e.SESSION_SECRET ?? randomBytes(32).toString('hex');

  let storage: AppConfig['storage'];
  if (e.STORAGE_DRIVER === 's3') {
    if (!e.S3_BUCKET || !e.S3_ACCESS_KEY_ID || !e.S3_SECRET_ACCESS_KEY) {
      throw new ConfigError('STORAGE_DRIVER=s3 requires S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.');
    }
    storage = {
      driver: 's3',
      endpoint: e.S3_ENDPOINT,
      region: e.S3_REGION,
      bucket: e.S3_BUCKET,
      accessKeyId: e.S3_ACCESS_KEY_ID,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY,
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
    };
  } else {
    storage = { driver: 'local', dir: e.STORAGE_LOCAL_DIR };
  }

  return {
    env: e.NODE_ENV,
    isProduction,
    logLevel: e.LOG_LEVEL,
    server: {
      host: e.HOST,
      port: e.PORT,
      webOrigins: e.WEB_ORIGIN.split(',').map((origin) => origin.trim().replace(/\/$/, '')).filter(Boolean),
      apiPublicUrl: e.API_PUBLIC_URL.replace(/\/$/, ''),
      trustProxy: e.TRUST_PROXY,
      rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
    },
    auth: {
      password: e.ACCESS_PASSWORD,
      passwordHash: e.ACCESS_PASSWORD_HASH,
      sessionSecret,
      sessionSecretIsEphemeral: e.SESSION_SECRET === undefined,
      sessionTtlSeconds: Math.round(e.SESSION_TTL_HOURS * 3600),
    },
    redis: { url: e.REDIS_URL },
    queue: { concurrency: e.WORKER_CONCURRENCY, maxAttempts: e.JOB_MAX_ATTEMPTS },
    storage,
    limits: {
      maxInputBytes: Math.round(e.MAX_INPUT_MB * MB),
      maxOutputBytes: Math.round(e.MAX_OUTPUT_MB * MB),
      maxDurationSeconds: Math.round(e.MAX_DURATION_MINUTES * 60),
      downloadTimeoutMs: Math.round(e.DOWNLOAD_TIMEOUT_MINUTES * MINUTE_MS),
      processingTimeoutMs: Math.round(e.PROCESSING_TIMEOUT_MINUTES * MINUTE_MS),
      fileTtlMs: Math.round(e.FILE_TTL_MINUTES * MINUTE_MS),
      linkTtlSeconds: e.DOWNLOAD_LINK_TTL_SECONDS,
    },
    ffmpeg: { ffmpegPath: e.FFMPEG_PATH, ffprobePath: e.FFPROBE_PATH },
    platforms: {
      youtubeApiKey: e.YOUTUBE_API_KEY,
      instagramAccessToken: e.INSTAGRAM_ACCESS_TOKEN,
      instagramGraphVersion: e.INSTAGRAM_GRAPH_VERSION,
      facebookAccessToken: e.FACEBOOK_ACCESS_TOKEN,
      facebookGraphVersion: e.FACEBOOK_GRAPH_VERSION,
    },
  };
}

/** Extra checks the API process runs at boot — fail fast with a readable message. */
export function assertApiConfig(config: AppConfig): void {
  if (!config.auth.password && !config.auth.passwordHash) {
    throw new ConfigError(
      'No access password configured. Set ACCESS_PASSWORD_HASH (recommended — generate with `npm run hash-password`) or ACCESS_PASSWORD.',
    );
  }
  if (config.isProduction) {
    if (config.auth.sessionSecretIsEphemeral) {
      throw new ConfigError('SESSION_SECRET (>= 32 chars) is required in production.');
    }
    if (config.server.webOrigins.length === 0 || config.server.webOrigins.some((origin) => origin === '*')) {
      throw new ConfigError('WEB_ORIGIN must list explicit origins in production (no wildcard).');
    }
  }
}
