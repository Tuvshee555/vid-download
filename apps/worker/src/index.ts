import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Worker } from 'bullmq';
import type { JobResultRecord } from '@vd/shared';
import {
  ConfigError,
  MEDIA_QUEUE_NAME,
  createAdapters,
  createLogger,
  createRedisConnection,
  createStorage,
  loadConfig,
  type MediaJobData,
} from '@vd/core';
import { createJobHandler } from './processors/handler';
import { sweepExpiredObjects } from './services/cleanup';
import { sweepStaleWorkspaces } from './services/workspace';

const execFileAsync = promisify(execFile);
const SWEEP_INTERVAL_MS = 10 * 60_000;
const SHUTDOWN_GRACE_MS = 25_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger('worker', config.logLevel);

  // Fail fast and loudly if a required binary is missing, instead of failing every job later.
  const binaries: Array<[string, string[], string]> = [
    [config.ffmpeg.ffmpegPath, ['-version'], 'Install FFmpeg or set FFMPEG_PATH.'],
    ...(config.ffmpeg.ffprobePath ? [[config.ffmpeg.ffprobePath, ['-version'], 'Install FFmpeg (includes ffprobe), set FFPROBE_PATH, or FFPROBE_PATH=none.'] as [string, string[], string]] : []),
    [config.ytdlp.binPath, ['--version'], 'Install yt-dlp (https://github.com/yt-dlp/yt-dlp) or set YTDLP_PATH.'],
  ];
  for (const [binary, args, hint] of binaries) {
    try {
      const { stdout } = await execFileAsync(binary, args, { timeout: 15_000, windowsHide: true });
      log.info({ binary, version: stdout.split('\n')[0]?.trim() }, 'found binary');
    } catch (error) {
      throw new ConfigError(`Cannot run "${binary}". ${hint} (${(error as Error).message})`);
    }
  }
  if (config.isProduction && config.storage.driver === 'local') {
    log.warn('STORAGE_DRIVER=local in production only works if the API and worker share one disk. Use s3 (Cloudflare R2) for separate services.');
  }

  const connection = createRedisConnection(config.redis.url, 'worker');
  connection.on('error', (error) => log.error({ err: error }, 'redis connection error'));

  const storage = createStorage(config);
  const adapters = createAdapters(config, { logger: log });
  const handler = createJobHandler({ config, storage, adapters, log });

  const worker = new Worker<MediaJobData, JobResultRecord>(MEDIA_QUEUE_NAME, (job) => handler(job), {
    connection,
    concurrency: config.queue.concurrency,
    // Conversions are long; the lock is renewed automatically while the event loop is free.
    lockDuration: 60_000,
    maxStalledCount: 1,
  });
  worker.on('error', (error) => log.error({ err: error }, 'worker error'));
  worker.on('failed', (job, error) => log.warn({ jobId: job?.id, reason: error.message.slice(0, 200) }, 'job marked failed'));

  const sweep = async (): Promise<void> => {
    try {
      const objects = await sweepExpiredObjects(storage, config.limits.fileTtlMs, log);
      const workspaces = await sweepStaleWorkspaces();
      if (objects.deleted || objects.failed || workspaces) log.info({ ...objects, workspaces }, 'cleanup sweep');
    } catch (error) {
      log.error({ err: error }, 'cleanup sweep crashed');
    }
  };
  void sweep();
  const sweepTimer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down: finishing active jobs');
    clearInterval(sweepTimer);
    const force = setTimeout(() => {
      log.warn('grace period over: closing without waiting for active jobs');
      void worker.close(true).finally(() => process.exit(1));
    }, SHUTDOWN_GRACE_MS);
    await worker.close();
    clearTimeout(force);
    await connection.quit().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  log.info({ concurrency: config.queue.concurrency, storage: config.storage.driver }, 'worker ready');
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) console.error(`\n${error.message}\n`);
  else console.error(error);
  process.exit(1);
});
