/**
 * Where finished files go in standalone mode.
 *
 *  - Vercel (BLOB_READ_WRITE_TOKEN set): Vercel Blob. The path contains a random UUID, the link
 *    forces a download, and files older than FILE_TTL_MINUTES are deleted on later requests.
 *  - Local dev (no token): a temp folder served through a signed, expiring /api/file/<token> link.
 */
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signToken, verifyToken, type TokenClaims } from '@vd/core/auth';

const LOCAL_DIR = join(tmpdir(), 'mediadock-outputs');
const BLOB_PREFIX = 'media/';

export interface StoredOutput {
  url: string;
  expiresAt: Date;
}

interface LocalFileClaims extends TokenClaims {
  typ: 'download';
  id: string;
  fn: string;
  ct: string;
}

const usesBlob = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);

/** Blob paths become the download file name; keep them readable but free of path tricks. */
function blobFileName(filename: string): string {
  return filename.replace(/[/\\#?%*:|"<>]/g, ' ').replace(/\s+/g, ' ').trim() || 'media';
}

export async function storeOutput(
  localPath: string,
  filename: string,
  contentType: string,
  ttlMs: number,
  secret: string,
): Promise<StoredOutput> {
  const expiresAt = new Date(Date.now() + ttlMs);
  const id = randomUUID();

  if (usesBlob()) {
    const { put } = await import('@vercel/blob');
    const { size } = await stat(localPath);
    const blob = await put(`${BLOB_PREFIX}${id}/${blobFileName(filename)}`, createReadStream(localPath), {
      access: 'public',
      contentType,
      addRandomSuffix: false,
      multipart: size > 8 * 1024 * 1024,
      cacheControlMaxAge: 60,
    });
    return { url: blob.downloadUrl, expiresAt };
  }

  const dir = join(LOCAL_DIR, id);
  await mkdir(dir, { recursive: true });
  await copyFile(localPath, join(dir, 'file'));
  const claims: LocalFileClaims = { typ: 'download', exp: Math.floor(expiresAt.getTime() / 1000), id, fn: filename, ct: contentType };
  return { url: `/api/file/${signToken(claims, secret)}`, expiresAt };
}

/** Resolve a signed local file link (dev only). */
export async function openLocalOutput(token: string, secret: string) {
  const verified = verifyToken<LocalFileClaims>(token, secret, 'download');
  if (!verified.ok) return { error: verified.reason === 'expired' ? ('LINK_EXPIRED' as const) : ('FORBIDDEN' as const) };
  const { id, fn, ct } = verified.payload;
  if (!/^[0-9a-f-]{36}$/.test(id)) return { error: 'FORBIDDEN' as const };
  const path = join(LOCAL_DIR, id, 'file');
  const info = await stat(path).catch(() => null);
  if (!info) return { error: 'LINK_EXPIRED' as const };
  return { path, size: info.size, filename: fn, contentType: ct };
}

let lastSweep = 0;

/** Delete outputs older than the TTL. Cheap and idempotent; runs at most once a minute per instance. */
export async function sweepOutputs(ttlMs: number): Promise<void> {
  if (Date.now() - lastSweep < 60_000) return;
  lastSweep = Date.now();
  const cutoff = Date.now() - ttlMs;

  if (usesBlob()) {
    const { list, del } = await import('@vercel/blob');
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: BLOB_PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
      const expired = page.blobs.filter((blob) => new Date(blob.uploadedAt).getTime() < cutoff).map((blob) => blob.url);
      if (expired.length > 0) await del(expired);
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return;
  }

  const entries = await readdir(LOCAL_DIR).catch(() => [] as string[]);
  for (const entry of entries) {
    const info = await stat(join(LOCAL_DIR, entry)).catch(() => null);
    if (info && info.mtimeMs < cutoff) await rm(join(LOCAL_DIR, entry), { recursive: true, force: true });
  }
}
