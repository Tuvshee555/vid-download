import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '@vd/shared';
import { discardBody, safeRequest, type AddressGuard, type HostMatcher } from './safe-fetch';

export interface DownloadOptions {
  allowedHost: HostMatcher;
  maxBytes: number;
  timeoutMs: number;
  guard?: AddressGuard;
  signal?: AbortSignal;
  onProgress?: (receivedBytes: number, totalBytes: number | null) => void;
}

export interface DownloadResult {
  bytes: number;
  contentType: string | null;
}

/** Content types that mean "this is not media" (login wall, error page, JSON error). */
const NON_MEDIA_TYPE = /^(text\/|application\/(json|xml|xhtml|javascript))/i;

/**
 * Stream an allowlisted URL to disk with a hard byte cap and deadline. The partial file is
 * deleted on any failure so a crashed job never leaves large orphans behind.
 */
export async function downloadToFile(url: string, destinationPath: string, options: DownloadOptions): Promise<DownloadResult> {
  const response = await safeRequest(url, {
    allowedHost: options.allowedHost,
    timeoutMs: options.timeoutMs,
    ...(options.guard ? { guard: options.guard } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    discardBody(response.body);
    // Signed CDN links expire; a retry re-resolves a fresh one, so treat these as transient.
    throw new AppError('PLATFORM_API_ERROR', 'The platform refused to serve the media file (the link may have expired).', {
      retryable: response.statusCode === 403 || response.statusCode === 404 || response.statusCode >= 500,
    });
  }

  const contentType = firstHeader(response.headers['content-type']);
  if (contentType && NON_MEDIA_TYPE.test(contentType)) {
    discardBody(response.body);
    throw new AppError('UNSUPPORTED_MEDIA', 'The platform returned a web page instead of a media file.');
  }

  const declaredLength = Number(firstHeader(response.headers['content-length']));
  const total = Number.isFinite(declaredLength) && declaredLength > 0 ? declaredLength : null;
  if (total !== null && total > options.maxBytes) {
    discardBody(response.body);
    throw new AppError('FILE_TOO_LARGE');
  }

  let received = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > options.maxBytes) {
        callback(new AppError('FILE_TOO_LARGE'));
        return;
      }
      options.onProgress?.(received, total);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(response.body, counter, createWriteStream(destinationPath, { flags: 'wx', mode: 0o600 }));
  } catch (error) {
    await rm(destinationPath, { force: true }).catch(() => undefined);
    if (error instanceof AppError) throw error;
    const code = (error as { code?: string; name?: string }).code;
    const name = (error as { name?: string }).name;
    if (name === 'AbortError' || name === 'TimeoutError' || code === 'UND_ERR_BODY_TIMEOUT' || code === 'ABORT_ERR') {
      throw new AppError('NETWORK_TIMEOUT', undefined, { cause: error });
    }
    if (code === 'ENOSPC' || code === 'EACCES' || code === 'EEXIST') {
      throw new AppError('STORAGE_FAILURE', undefined, { cause: error });
    }
    throw new AppError('NETWORK_TIMEOUT', 'The download was interrupted.', { cause: error });
  }

  options.onProgress?.(received, total ?? received);
  return { bytes: received, contentType: contentType ?? null };
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
