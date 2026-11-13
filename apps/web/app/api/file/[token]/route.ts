/**
 * Local-dev download route for standalone mode without Vercel Blob. The token is an HMAC-signed,
 * expiring capability for exactly one file; on Vercel, Blob links are used instead.
 */
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { contentDisposition } from '@vd/core/storage-headers';
import { jsonError } from '@/lib/bff';
import { openLocalOutput } from '@/lib/server/output-store';
import { serverMode, standalone } from '@/lib/server/standalone';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> {
  if (serverMode() !== 'standalone') return jsonError('NOT_FOUND');
  const { token } = await context.params;
  const file = await openLocalOutput(token, standalone().config.auth.sessionSecret);
  if ('error' in file) return jsonError(file.error === 'LINK_EXPIRED' ? 'LINK_EXPIRED' : 'FORBIDDEN');

  const body = Readable.toWeb(createReadStream(file.path)) as unknown as ReadableStream<Uint8Array>;
  return new Response(body, {
    headers: {
      'content-type': file.contentType,
      'content-length': String(file.size),
      'content-disposition': contentDisposition(file.filename),
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
