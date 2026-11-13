/**
 * "Standalone" mode: the whole app runs inside Next.js (one Vercel project) — no separate API,
 * worker, Redis or bucket. Downloads/conversions run inside a long-lived route handler and the
 * finished file goes to Vercel Blob. The self-hosted API + worker ("proxy" mode) keep working
 * unchanged; which one is used is decided by `serverMode()`.
 *
 * Server-only: never import from client components.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { createAdapters, type AdapterRegistry } from '@vd/core/adapters';
import { createSessionToken, verifyPassword, verifySessionToken } from '@vd/core/auth';
import { assertApiConfig, loadConfig, type AppConfig } from '@vd/core/config';

export type ServerMode = 'standalone' | 'proxy';

/**
 * MEDIADOCK_AUTH=off: no password, anyone with the link can use the site (the public cloud
 * deployment). Never set on the home helper — it relies on the password + relay secret instead.
 */
export function authDisabled(): boolean {
  return process.env.MEDIADOCK_AUTH?.toLowerCase() === 'off';
}

/** Explicit MEDIADOCK_MODE wins; otherwise "proxy" only when an external API is configured. */
export function serverMode(): ServerMode {
  const mode = process.env.MEDIADOCK_MODE;
  if (mode === 'standalone' || mode === 'proxy') return mode;
  return process.env.API_BASE_URL ? 'proxy' : 'standalone';
}

/**
 * Serverless-friendly defaults: a function has ~500 MB of /tmp and 300 s, so inputs, outputs and
 * time limits are sized to fit. Every value can still be overridden with the same env var.
 */
const STANDALONE_DEFAULTS: Record<string, string> = {
  MAX_INPUT_MB: '400',
  MAX_OUTPUT_MB: '450',
  MAX_DURATION_MINUTES: '30',
  DOWNLOAD_TIMEOUT_MINUTES: '3',
  PROCESSING_TIMEOUT_MINUTES: '3',
  FILE_TTL_MINUTES: '60',
};

/** Binaries shipped inside a serverless bundle may lose their exec bit; run a private executable copy. */
function executableCopy(source: string, name: string): string {
  if (process.platform === 'win32') return source;
  const dir = join(tmpdir(), 'mediadock-bin');
  const target = join(dir, name);
  if (!existsSync(target)) {
    mkdirSync(dir, { recursive: true });
    copyFileSync(source, target);
    chmodSync(target, 0o755);
  }
  return target;
}

/** yt-dlp is downloaded into apps/web/bin at build time on Vercel (scripts/fetch-yt-dlp.mjs). */
function bundledYtDlp(): string | null {
  const candidates = [join(process.cwd(), 'bin', 'yt-dlp'), join(process.cwd(), 'apps', 'web', 'bin', 'yt-dlp')];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function resolveBinaries(): { ytdlp: string; ffmpeg: string } {
  const bundled = bundledYtDlp();
  const ytdlp = process.env.YTDLP_PATH ?? (bundled ? executableCopy(bundled, 'yt-dlp') : 'yt-dlp');
  const staticFfmpeg = typeof ffmpegStatic === 'string' && existsSync(ffmpegStatic) ? ffmpegStatic : null;
  const ffmpeg = process.env.FFMPEG_PATH ?? (staticFfmpeg ? executableCopy(staticFfmpeg, 'ffmpeg') : 'ffmpeg');
  return { ytdlp, ffmpeg };
}

interface Standalone {
  config: AppConfig;
  adapters: AdapterRegistry;
}

let instance: Standalone | null = null;

export function standalone(): Standalone {
  if (!instance) {
    const { ytdlp, ffmpeg } = resolveBinaries();
    const config = loadConfig({
      ...STANDALONE_DEFAULTS,
      ...process.env,
      YTDLP_PATH: ytdlp,
      FFMPEG_PATH: ffmpeg,
      // Serverless bundles ship ffmpeg only; files are inspected with ffmpeg itself.
      FFPROBE_PATH: process.env.FFPROBE_PATH ?? 'none',
    });
    if (!authDisabled()) assertApiConfig(config);
    instance = { config, adapters: createAdapters(config) };
  }
  return instance;
}

// ───────────────────────── private access ─────────────────────────

export async function standaloneLogin(password: string): Promise<{ token: string; expiresAt: Date } | null> {
  const { config } = standalone();
  const valid = await verifyPassword(password, { password: config.auth.password, passwordHash: config.auth.passwordHash });
  if (!valid) {
    // Flattens timing and slows guessing; the password itself is long and random.
    await new Promise((resolve) => setTimeout(resolve, 400));
    return null;
  }
  return createSessionToken(config.auth.sessionSecret, config.auth.sessionTtlSeconds);
}

export function standaloneSession(token: string | undefined): { expiresAt: Date } | null {
  if (authDisabled()) return { expiresAt: new Date(Date.now() + 24 * 3600_000) };
  if (!token) return null;
  const result = verifySessionToken(token, standalone().config.auth.sessionSecret);
  return result.ok ? { expiresAt: new Date(result.payload.exp * 1000) } : null;
}
