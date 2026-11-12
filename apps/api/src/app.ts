import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { AppError } from '@vd/shared';
import type { AppConfig } from '@vd/core';
import type { ApiDeps } from './context';
import { LoginThrottle } from './lib/login-throttle';
import { requireAuth } from './middleware/auth';
import { registerErrorHandling } from './middleware/errors';
import { privateV1Routes } from './routes/private';
import { healthRoutes, publicV1Routes } from './routes/public';
import { JobService } from './services/job-service';

/** Signed capability tokens travel in the URL path — never write them to logs. */
export function scrubUrl(url: string | undefined): string | undefined {
  return url?.replace(/^(\/v1\/(?:files|uploads)\/)[^/?#]+/, '$1[token]');
}

function loggerOptions(config: AppConfig): FastifyServerOptions['logger'] {
  const base = {
    level: config.env === 'test' ? 'silent' : config.logLevel,
    redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], censor: '[redacted]' },
    serializers: {
      req(request: { method: string; url?: string; hostname?: string; ip?: string }) {
        return { method: request.method, url: scrubUrl(request.url), hostname: request.hostname, remoteAddress: request.ip };
      },
    },
  };
  if (config.env === 'development') {
    return { ...base, transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } };
  }
  return base;
}

export async function buildApp(deps: ApiDeps): Promise<FastifyInstance> {
  const { config } = deps;

  const app = Fastify({
    logger: loggerOptions(config),
    // Platform health checks hit /health every few seconds; don't flood the logs with them.
    disableRequestLogging: (request) => request.url.startsWith('/health'),
    trustProxy: config.server.trustProxy,
    // JSON bodies here are tiny. Uploads bypass this via a raw stream on a scoped route.
    bodyLimit: 32 * 1024,
    routerOptions: { maxParamLength: 1024 },
  });

  await app.register(helmet, {
    // Pure JSON API plus attachment downloads: nothing here renders HTML.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  await app.register(cors, {
    origin: config.server.webOrigins,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Retry-After'],
    maxAge: 600,
  });

  await app.register(rateLimit, {
    global: true,
    max: config.server.rateLimitPerMinute,
    timeWindow: '1 minute',
    // If Redis hiccups, keep serving rather than failing every request.
    skipOnError: true,
    ...(deps.rateLimitRedis ? { redis: deps.rateLimitRedis, nameSpace: 'mediadock:rl:' } : {}),
    errorResponseBuilder: () => new AppError('RATE_LIMITED'),
  });

  registerErrorHandling(app);

  const throttle = new LoginThrottle();
  const jobs = new JobService(deps);

  await app.register(healthRoutes, { deps });

  await app.register(
    async (publicScope) => {
      await publicScope.register(publicV1Routes, { deps, throttle });
    },
    { prefix: '/v1' },
  );

  await app.register(
    async (privateScope) => {
      privateScope.addHook('onRequest', requireAuth(config.auth.sessionSecret));
      await privateScope.register(privateV1Routes, { deps, jobs });
    },
    { prefix: '/v1' },
  );

  return app;
}
