/**
 * Standalone implementations of the JSON endpoints the browser already uses through
 * `/api/[...path]` (same request/response contract as the external API).
 */
import { AppError, PLATFORMS, PLATFORM_NAMES, detectUrl, resolveRequestSchema, toApiErrorBody, type PlatformsResponse, type ResolveResponse } from '@vd/shared';
import { standalone, standaloneSession } from '@/lib/server/standalone';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export function errorResponse(error: unknown): Response {
  const appError = error instanceof AppError ? error : new AppError('INTERNAL', undefined, { cause: error });
  if (!(error instanceof AppError) || appError.status >= 500) console.error('[mediadock]', appError.code, error);
  return json(toApiErrorBody(appError), appError.status);
}

export async function handleStandalone(method: 'GET' | 'POST', path: string, token: string | undefined, body: string | undefined): Promise<Response> {
  try {
    const session = standaloneSession(token);
    if (!session) throw new AppError('UNAUTHENTICATED');
    const { config, adapters } = standalone();

    if (method === 'GET' && path === 'auth/session') {
      return json({ authenticated: true, expiresAt: session.expiresAt.toISOString() });
    }

    if (method === 'GET' && path === 'platforms') {
      const response: PlatformsResponse = {
        platforms: PLATFORMS.map((platform) => ({ platform, name: PLATFORM_NAMES[platform], ...adapters[platform].describe() })),
        limits: {
          maxUploadBytes: config.limits.maxInputBytes,
          maxDurationSeconds: config.limits.maxDurationSeconds,
          fileTtlMinutes: Math.round(config.limits.fileTtlMs / 60_000),
        },
      };
      return json(response);
    }

    if (method === 'POST' && path === 'resolve') {
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(body ?? '');
      } catch {
        throw new AppError('VALIDATION_ERROR', 'The request body must be valid JSON.');
      }
      const parsed = resolveRequestSchema.safeParse(parsedBody);
      if (!parsed.success) throw new AppError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid request.');
      const detection = detectUrl(parsed.data.url);
      if (!detection.ok) throw new AppError(detection.code, detection.message);
      const resolved = await adapters[detection.platform].resolve(detection, AbortSignal.timeout(60_000));
      const response: ResolveResponse = {
        platform: detection.platform,
        platformName: PLATFORM_NAMES[detection.platform],
        canonicalUrl: detection.canonicalUrl,
        mediaId: detection.mediaId,
        metadata: resolved.metadata,
        availability: resolved.availability,
        uploadEnabled: false,
      };
      return json(response);
    }

    // Upload/job-queue endpoints only exist in the self-hosted (API + worker) deployment.
    throw new AppError('NOT_FOUND', 'That endpoint is not available in this deployment.');
  } catch (error) {
    return errorResponse(error);
  }
}
