/**
 * Standalone implementations of the JSON endpoints the browser already uses through
 * `/api/[...path]` (same request/response contract as the external API).
 */
import {
  AppError,
  PLATFORMS,
  PLATFORM_NAMES,
  detectUrl,
  resolveRequestSchema,
  toApiErrorBody,
  type PlatformsResponse,
  type ResolveResponse,
  type UrlDetection,
} from '@vd/shared';
import { HELPER_OFFLINE, isHelperResponse, relayFetch, relayTarget } from '@/lib/server/relay';
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

type Detected = Extract<UrlDetection, { ok: true }>;

/** Resolve on the home helper; when it can't be reached, explain that instead of failing. */
async function resolveViaHelper(base: string, detection: Detected): Promise<Response> {
  try {
    const upstream = await relayFetch(base, '/api/resolve', { url: detection.canonicalUrl }, AbortSignal.timeout(60_000));
    if (isHelperResponse(upstream)) {
      return new Response(await upstream.text(), {
        status: upstream.status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
  } catch (error) {
    console.warn('[mediadock] home helper unreachable', (error as Error).message);
  }
  const offline: ResolveResponse = {
    platform: detection.platform,
    platformName: PLATFORM_NAMES[detection.platform],
    canonicalUrl: detection.canonicalUrl,
    mediaId: detection.mediaId,
    metadata: null,
    availability: { status: 'unavailable', reason: { code: 'PLATFORM_API_ERROR', ...HELPER_OFFLINE } },
    uploadEnabled: false,
  };
  return json(offline);
}

/**
 * @param relayAuthorized the request came from the cloud deployment with the shared relay secret
 *   (this instance is the home helper), so no browser session is required.
 */
export async function handleStandalone(
  method: 'GET' | 'POST',
  path: string,
  token: string | undefined,
  body: string | undefined,
  relayAuthorized = false,
): Promise<Response> {
  try {
    const session = standaloneSession(token);
    if (!session && !relayAuthorized) throw new AppError('UNAUTHENTICATED');
    const { config, adapters } = standalone();

    if (method === 'GET' && path === 'auth/session') {
      if (!session) throw new AppError('UNAUTHENTICATED');
      return json({ authenticated: true, expiresAt: session.expiresAt.toISOString() });
    }

    if (method === 'GET' && path === 'platforms') {
      const response: PlatformsResponse = {
        platforms: PLATFORMS.map((platform) => {
          const info = { platform, name: PLATFORM_NAMES[platform], ...adapters[platform].describe() };
          if (relayTarget(platform)) {
            info.summary = `Public ${PLATFORM_NAMES[platform]} videos up to 1080p or MP3. ${PLATFORM_NAMES[platform]} blocks cloud servers, so these downloads run on your home PC — it needs to be on.`;
          }
          return info;
        }),
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

      const helper = relayTarget(detection.platform);
      if (helper) return resolveViaHelper(helper, detection);

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
