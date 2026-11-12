/** Authenticated routes: everything in here requires a valid session token. */
import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import {
  AppError,
  PLATFORM_NAMES,
  PLATFORMS,
  createJobRequestSchema,
  detectUrl,
  jobIdSchema,
  resolveRequestSchema,
  uploadTicketRequestSchema,
  type CreateJobResponse,
  type JobView,
  type PlatformsResponse,
  type ResolveResponse,
  type SessionResponse,
  type UploadTicketResponse,
} from '@vd/shared';
import { adapterFor, uploadKey } from '@vd/core';
import type { ApiDeps } from '../context';
import { parseInput } from '../lib/validate';
import { type JobService } from '../services/job-service';

const UPLOAD_TICKET_TTL_SECONDS = 15 * 60;
const RESOLVE_TIMEOUT_MS = 25_000;

export const privateV1Routes: FastifyPluginAsync<{ deps: ApiDeps; jobs: JobService }> = async (app, { deps, jobs }) => {
  const { config, storage, adapters } = deps;

  app.get('/auth/session', async (request): Promise<SessionResponse> => {
    return { authenticated: true, expiresAt: (request.session?.expiresAt ?? new Date()).toISOString() };
  });

  app.get('/platforms', async (): Promise<PlatformsResponse> => ({
    platforms: PLATFORMS.map((platform) => ({
      platform,
      name: PLATFORM_NAMES[platform],
      ...adapters[platform].describe(),
    })),
    limits: {
      maxUploadBytes: config.limits.maxInputBytes,
      maxDurationSeconds: config.limits.maxDurationSeconds,
      fileTtlMinutes: Math.round(config.limits.fileTtlMs / 60_000),
    },
  }));

  app.post('/resolve', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request): Promise<ResolveResponse> => {
    const { url } = parseInput(resolveRequestSchema, request.body);
    const detection = detectUrl(url);
    if (!detection.ok) throw new AppError(detection.code, detection.message);

    const adapter = adapterFor(adapters, detection.platform);
    const resolved = await adapter.resolve(detection, AbortSignal.timeout(RESOLVE_TIMEOUT_MS));
    return {
      platform: detection.platform,
      platformName: PLATFORM_NAMES[detection.platform],
      canonicalUrl: detection.canonicalUrl,
      mediaId: detection.mediaId,
      metadata: resolved.metadata,
      availability: resolved.availability,
      uploadEnabled: true,
    };
  });

  app.post('/uploads', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request): Promise<UploadTicketResponse> => {
    const body = parseInput(uploadTicketRequestSchema, request.body);
    if (body.size > config.limits.maxInputBytes) {
      throw new AppError('FILE_TOO_LARGE', `Files can be at most ${Math.round(config.limits.maxInputBytes / 1024 / 1024)} MB.`);
    }
    const uploadId = randomUUID();
    const ticket = await storage.createUploadTicket(uploadKey(uploadId), {
      size: body.size,
      contentType: body.contentType,
      ttlSeconds: UPLOAD_TICKET_TTL_SECONDS,
    });
    return {
      uploadId,
      upload: { url: ticket.url, method: ticket.method, headers: ticket.headers, expiresAt: ticket.expiresAt.toISOString() },
      maxBytes: config.limits.maxInputBytes,
    };
  });

  app.post('/jobs', { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } }, async (request, reply): Promise<CreateJobResponse> => {
    const body = parseInput(createJobRequestSchema, request.body);
    const created = await jobs.create(body, AbortSignal.timeout(RESOLVE_TIMEOUT_MS));
    void reply.status(202).header('Location', `/v1/jobs/${created.id}`);
    return created;
  });

  app.get('/jobs/:id', async (request, reply): Promise<JobView> => {
    const params = request.params as { id: string };
    const parsed = jobIdSchema.safeParse(params.id);
    if (!parsed.success) throw new AppError('NOT_FOUND');
    const view = await jobs.view(parsed.data);
    if (!view) throw new AppError('NOT_FOUND');
    void reply.header('Cache-Control', 'no-store');
    return view;
  });
};
