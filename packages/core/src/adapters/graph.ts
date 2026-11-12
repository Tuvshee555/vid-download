/**
 * Shared helpers for Meta's Graph APIs (Instagram + Facebook).
 *
 * Access tokens are sent as the `access_token` query parameter, which is how both APIs
 * document it. Because of that, URLs built here must never be logged or put in an error
 * message — callers only ever surface `AppError`s whose text is fixed.
 */
import { z } from 'zod';
import { AppError, type ErrorCode } from '@vd/shared';
import type { JsonResponse } from '../net/safe-fetch';

const graphErrorSchema = z.object({
  error: z.object({
    message: z.string().optional(),
    type: z.string().optional(),
    code: z.number().optional(),
    error_subcode: z.number().optional(),
  }),
});

export interface GraphErrorInfo {
  httpStatus: number;
  code: number | undefined;
  subcode: number | undefined;
}

export function parseGraphError(response: JsonResponse): GraphErrorInfo | null {
  const parsed = graphErrorSchema.safeParse(response.body);
  if (parsed.success) {
    return { httpStatus: response.status, code: parsed.data.error.code, subcode: parsed.data.error.error_subcode };
  }
  if (response.status >= 400) return { httpStatus: response.status, code: undefined, subcode: undefined };
  return null;
}

/** Error codes meaning "this object is invisible or forbidden to the connected account". */
export function isAccessDenied(info: GraphErrorInfo): boolean {
  return (
    info.code === 10 ||
    info.code === 803 ||
    info.code === 100 ||
    (info.code !== undefined && info.code >= 200 && info.code <= 299) ||
    info.httpStatus === 403 ||
    info.httpStatus === 404
  );
}

/** Translate a Graph API failure into a user-safe AppError (never exposes Meta's raw message). */
export function graphFailure(platformName: string, info: GraphErrorInfo): AppError {
  let code: ErrorCode = 'PLATFORM_API_ERROR';
  if (info.code === 190 || info.httpStatus === 401) {
    return new AppError(
      code,
      `${platformName} rejected the server's access token (invalid or expired). Renew the token in the server configuration.`,
      { retryable: false },
    );
  }
  if (info.httpStatus === 429 || info.code === 4 || info.code === 17 || info.code === 32 || info.code === 613) {
    return new AppError(code, `${platformName}'s API rate limit was reached. Please try again in a few minutes.`, { retryable: true });
  }
  if (info.code === 10 || (info.code !== undefined && info.code >= 200 && info.code <= 299)) {
    return new AppError(
      code,
      `The ${platformName} access token is missing a permission this feature needs. Check the token's scopes.`,
      { retryable: false },
    );
  }
  if (info.httpStatus >= 500) {
    return new AppError(code, `${platformName}'s API is having problems. Please try again shortly.`, { retryable: true });
  }
  code = 'PLATFORM_API_ERROR';
  return new AppError(code, `${platformName}'s API returned an error. Please try again in a few minutes.`, { retryable: true });
}

export function buildGraphUrl(
  base: string,
  version: string,
  path: string,
  params: Record<string, string>,
  accessToken: string,
): string {
  const url = new URL(`${base}/${version}/${path.replace(/^\//, '')}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set('access_token', accessToken);
  return url.toString();
}
