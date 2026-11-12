/**
 * Routes that do not use the Bearer session: login, health, and the two capability-URL
 * routes (signed downloads / signed local uploads) that browsers hit directly.
 */
import type { FastifyPluginAsync } from 'fastify';
import {
  AppError,
  loginRequestSchema,
  type LoginResponse,
} from '@vd/shared';
import {
  LocalStorage,
  contentDisposition,
  createSessionToken,
  isValidStorageKey,
  verifyPassword,
  verifyToken,
  type DownloadClaims,
  type UploadClaims,
} from '@vd/core';
import type { ApiDeps } from '../context';
import { type LoginThrottle } from '../lib/login-throttle';
import { parseInput } from '../lib/validate';

interface PublicOptions {
  deps: ApiDeps;
  throttle: LoginThrottle;
}

export const healthRoutes: FastifyPluginAsync<{ deps: ApiDeps }> = async (app, { deps }) => {
  // Liveness: the process is up. Used by the hosting platform's health check.
  app.get('/health', { config: { rateLimit: false } }, async () => ({ ok: true }));

  // Readiness: can we reach Redis? Deliberately reveals nothing else.
  app.get('/health/ready', { config: { rateLimit: false } }, async (_request, reply) => {
    const redis = await deps.queue.ping();
    return reply.status(redis ? 200 : 503).send({ ok: redis, redis });
  });
};

export const publicV1Routes: FastifyPluginAsync<PublicOptions> = async (app, { deps, throttle }) => {
  const { config } = deps;

  app.post(
    '/auth/login',
    { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } },
    async (request, reply): Promise<LoginResponse> => {
      const wait = throttle.retryAfterMs();
      if (wait > 0) {
        void reply.header('Retry-After', String(Math.ceil(wait / 1000)));
        throw new AppError('RATE_LIMITED', 'Too many failed sign-in attempts. Please wait a few minutes and try again.');
      }
      const { password } = parseInput(loginRequestSchema, request.body);
      const valid = await verifyPassword(password, { password: config.auth.password, passwordHash: config.auth.passwordHash });
      if (!valid) {
        throttle.recordFailure();
        request.log.warn('failed sign-in attempt');
        throw new AppError('UNAUTHENTICATED', 'Incorrect password.');
      }
      const { token, expiresAt } = createSessionToken(config.auth.sessionSecret, config.auth.sessionTtlSeconds);
      return { token, expiresAt: expiresAt.toISOString() };
    },
  );

  // Local-storage driver only. With S3/R2 the browser talks to the bucket via presigned URLs instead.
  if (deps.storage instanceof LocalStorage) {
    const storage = deps.storage;

    app.get('/files/:token', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
      const { token } = request.params as { token: string };
      const verified = verifyToken<DownloadClaims>(token, config.auth.sessionSecret, 'download');
      if (!verified.ok) {
        throw verified.reason === 'expired' ? new AppError('LINK_EXPIRED') : new AppError('FORBIDDEN', 'This download link is not valid.');
      }
      const { k: key, fn: filename, ct: contentType } = verified.payload;
      // Defence in depth: even a correctly signed token may only ever reach files in the app's own key space.
      if (!isValidStorageKey(key) || !key.startsWith('outputs/')) throw new AppError('FORBIDDEN', 'This download link is not valid.');
      const info = await storage.head(key);
      if (!info) throw new AppError('LINK_EXPIRED', 'This file has expired and was deleted. Convert the media again to get a new one.');

      let range: { start: number; end: number } | undefined;
      const rangeHeader = request.headers.range;
      if (rangeHeader) {
        const parsed = parseRange(rangeHeader, info.size);
        if (parsed === 'unsatisfiable') {
          return reply.status(416).header('Content-Range', `bytes */${info.size}`).send();
        }
        range = parsed ?? undefined;
      }

      void reply
        .header('Content-Type', contentType)
        .header('Content-Disposition', contentDisposition(filename))
        .header('Accept-Ranges', 'bytes')
        .header('Cache-Control', 'private, no-store')
        .header('X-Content-Type-Options', 'nosniff');

      if (range) {
        void reply
          .status(206)
          .header('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`)
          .header('Content-Length', String(range.end - range.start + 1));
        return reply.send(storage.openReadStream(key, range));
      }
      void reply.header('Content-Length', String(info.size));
      return reply.send(storage.openReadStream(key));
    });

    // Raw streaming PUT; scoped so the rest of the API keeps strict JSON-only parsing.
    await app.register(async (scope) => {
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser('*', (_request, _payload, done) => done(null));

      scope.put('/uploads/:token', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
        const { token } = request.params as { token: string };
        const verified = verifyToken<UploadClaims>(token, config.auth.sessionSecret, 'upload');
        if (!verified.ok) {
          throw verified.reason === 'expired'
            ? new AppError('LINK_EXPIRED', 'This upload link has expired. Please start the upload again.')
            : new AppError('FORBIDDEN', 'This upload link is not valid.');
        }
        const { k: key, sz: declared } = verified.payload;
        if (!isValidStorageKey(key) || !key.startsWith('uploads/')) throw new AppError('FORBIDDEN', 'This upload link is not valid.');
        if (declared > config.limits.maxInputBytes) throw new AppError('FILE_TOO_LARGE');

        const contentLength = Number(request.headers['content-length']);
        if (!Number.isInteger(contentLength) || contentLength !== declared) {
          throw new AppError('VALIDATION_ERROR', 'The upload size did not match what was declared.');
        }

        await storage.writeFromStream(key, request.raw, { maxBytes: declared, expectedBytes: declared });
        return reply.status(200).send({ ok: true });
      });
    });
  }
};

/** Single-range parser. Returns null for "no usable range → serve whole file". */
export function parseRange(header: string, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startText = '', endText = ''] = match;
  if (startText === '' && endText === '') return null;

  let start: number;
  let end: number;
  if (startText === '') {
    const suffix = Number(endText);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText === '' ? size - 1 : Math.min(Number(endText), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}
