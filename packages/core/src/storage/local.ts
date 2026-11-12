import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '@vd/shared';
import { signToken, type TokenClaims } from '../auth';
import { isValidStorageKey, type ObjectStorage, type SignedUrl, type StoredObjectInfo, type UploadTicket } from './types';

export interface LocalStorageOptions {
  dir: string;
  /** Needed only by the API process, which mints signed links. */
  apiPublicUrl?: string;
  signingSecret?: string;
}

export interface DownloadClaims extends TokenClaims {
  typ: 'download';
  /** storage key */
  k: string;
  /** download file name */
  fn: string;
  /** content type */
  ct: string;
}

export interface UploadClaims extends TokenClaims {
  typ: 'upload';
  k: string;
  /** declared size */
  sz: number;
  ct: string;
}

/**
 * Filesystem-backed storage for development, tests and single-machine deployments.
 * API and worker must share the same directory. Production on separate services should
 * use the S3/R2 driver instead.
 */
export class LocalStorage implements ObjectStorage {
  readonly driver = 'local' as const;
  private readonly root: string;

  constructor(private readonly options: LocalStorageOptions) {
    this.root = resolve(options.dir);
  }

  /** Absolute path for a key; throws if the key could escape the root. */
  pathFor(key: string): string {
    if (!isValidStorageKey(key)) throw new AppError('STORAGE_FAILURE', 'Invalid storage key.');
    const full = resolve(this.root, ...key.split('/'));
    if (!full.startsWith(this.root + sep)) throw new AppError('STORAGE_FAILURE', 'Invalid storage key.');
    return full;
  }

  async putFile(key: string, filePath: string, _options?: { contentType: string }): Promise<StoredObjectInfo> {
    const target = this.pathFor(key);
    try {
      await mkdir(dirname(target), { recursive: true });
      const partial = `${target}.part`;
      await copyFile(filePath, partial);
      await rename(partial, target);
      const info = await stat(target);
      return { key, size: info.size, lastModified: info.mtime };
    } catch (error) {
      throw new AppError('STORAGE_FAILURE', undefined, { cause: error });
    }
  }

  async getToFile(key: string, filePath: string, options: { maxBytes?: number } = {}): Promise<void> {
    const source = this.pathFor(key);
    try {
      const info = await stat(source);
      if (options.maxBytes !== undefined && info.size > options.maxBytes) throw new AppError('FILE_TOO_LARGE');
      await copyFile(source, filePath);
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('NOT_FOUND');
      throw new AppError('STORAGE_FAILURE', undefined, { cause: error });
    }
  }

  async head(key: string): Promise<StoredObjectInfo | null> {
    try {
      const info = await stat(this.pathFor(key));
      return info.isFile() ? { key, size: info.size, lastModified: info.mtime } : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new AppError('STORAGE_FAILURE', undefined, { cause: error });
    }
  }

  async delete(key: string): Promise<void> {
    const target = this.pathFor(key);
    await rm(target, { force: true });
    await rm(`${target}.part`, { force: true });
    // outputs/<jobId>/output.mp4 — drop the now-empty job directory too.
    if (key.startsWith('outputs/')) await rmdir(dirname(target)).catch(() => undefined);
  }

  async list(prefix: string): Promise<StoredObjectInfo[]> {
    const results: StoredObjectInfo[] = [];
    const base = resolve(this.root, ...prefix.split('/').filter(Boolean));
    if (!base.startsWith(this.root)) return results;

    const walk = async (directory: string, keyPrefix: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const key = `${keyPrefix}${entry.name}`;
        if (entry.isDirectory()) {
          await walk(join(directory, entry.name), `${key}/`);
        } else if (entry.isFile()) {
          const info = await stat(join(directory, entry.name)).catch(() => null);
          if (info) results.push({ key, size: info.size, lastModified: info.mtime });
        }
      }
    };
    await walk(base, prefix.endsWith('/') ? prefix : `${prefix}/`);
    return results;
  }

  async createDownloadUrl(
    key: string,
    options: { filename: string; contentType: string; ttlSeconds: number },
  ): Promise<SignedUrl> {
    const { apiPublicUrl, signingSecret } = this.requireSigning();
    this.pathFor(key);
    const exp = Math.floor(Date.now() / 1000) + options.ttlSeconds;
    const claims: DownloadClaims = { typ: 'download', exp, k: key, fn: options.filename, ct: options.contentType };
    return { url: `${apiPublicUrl}/v1/files/${signToken(claims, signingSecret)}`, expiresAt: new Date(exp * 1000) };
  }

  async createUploadTicket(
    key: string,
    options: { size: number; contentType: string; ttlSeconds: number },
  ): Promise<UploadTicket> {
    const { apiPublicUrl, signingSecret } = this.requireSigning();
    this.pathFor(key);
    const exp = Math.floor(Date.now() / 1000) + options.ttlSeconds;
    const claims: UploadClaims = { typ: 'upload', exp, k: key, sz: options.size, ct: options.contentType };
    return {
      url: `${apiPublicUrl}/v1/uploads/${signToken(claims, signingSecret)}`,
      method: 'PUT',
      headers: { 'Content-Type': options.contentType },
      expiresAt: new Date(exp * 1000),
    };
  }

  // ── Local-only helpers used by the API's signed-link routes ──

  openReadStream(key: string, range?: { start: number; end: number }): Readable {
    return createReadStream(this.pathFor(key), range ? { start: range.start, end: range.end } : undefined);
  }

  /** Stream a request body to a key with an exact-size cap. Writes to `.part` then renames. */
  async writeFromStream(key: string, source: Readable, limits: { maxBytes: number; expectedBytes?: number }): Promise<StoredObjectInfo> {
    const target = this.pathFor(key);
    const partial = `${target}.part`;
    await mkdir(dirname(target), { recursive: true });

    let received = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > limits.maxBytes) {
          callback(new AppError('FILE_TOO_LARGE'));
          return;
        }
        callback(null, chunk);
      },
    });

    try {
      await pipeline(source, counter, createWriteStream(partial, { flags: 'w', mode: 0o600 }));
      if (limits.expectedBytes !== undefined && received !== limits.expectedBytes) {
        throw new AppError('VALIDATION_ERROR', 'The uploaded file size did not match what was declared.');
      }
      await rename(partial, target);
    } catch (error) {
      await rm(partial, { force: true }).catch(() => undefined);
      if (error instanceof AppError) throw error;
      throw new AppError('STORAGE_FAILURE', undefined, { cause: error });
    }
    const info = await stat(target);
    return { key, size: info.size, lastModified: info.mtime };
  }

  private requireSigning(): { apiPublicUrl: string; signingSecret: string } {
    const { apiPublicUrl, signingSecret } = this.options;
    if (!apiPublicUrl || !signingSecret) {
      throw new AppError('INTERNAL', 'Local storage was created without signing configuration.');
    }
    return { apiPublicUrl, signingSecret };
  }
}
