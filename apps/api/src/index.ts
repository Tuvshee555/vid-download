import {
  ConfigError,
  assertApiConfig,
  createAdapters,
  createLogger,
  createMediaQueue,
  createRedisConnection,
  createStorage,
  loadConfig,
} from '@vd/core';
import { buildApp } from './app';
import { BullJobQueue } from './services/job-queue';

async function main(): Promise<void> {
  const config = loadConfig();
  assertApiConfig(config);

  const log = createLogger('api-boot', config.logLevel);
  if (config.auth.sessionSecretIsEphemeral) {
    log.warn('SESSION_SECRET is not set: using a random per-process secret, so sessions end on every restart.');
  }
  if (config.isProduction && config.storage.driver === 'local') {
    log.warn('STORAGE_DRIVER=local in production only works if the API and worker share one disk. Use s3 (Cloudflare R2) for separate services.');
  }

  const redis = createRedisConnection(config.redis.url, 'api');
  const rateLimitRedis = redis.duplicate();
  redis.on('error', (error) => log.error({ err: error }, 'redis connection error'));
  rateLimitRedis.on('error', () => undefined);

  const queue = createMediaQueue(redis);
  const storage = createStorage(config, { apiPublicUrl: config.server.apiPublicUrl, secret: config.auth.sessionSecret });
  const adapters = createAdapters(config, { logger: createLogger('adapters', config.logLevel) });

  const app = await buildApp({ config, queue: new BullJobQueue(queue, config, redis), storage, adapters, rateLimitRedis });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await queue.close();
    rateLimitRedis.disconnect();
    await redis.quit().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.server.host, port: config.server.port });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`\n${error.message}\n`);
  } else {
    console.error(error);
  }
  process.exit(1);
});
