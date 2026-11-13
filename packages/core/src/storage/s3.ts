import { createWriteStream } from 'node:fs';
import { createReadStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AppError } from '@vd/shared';
import { isValidStorageKey, type ObjectStorage, type SignedUrl, type StoredObjectInfo, type UploadTicket } from './types';

export interface S3StorageOptions {
  bucket: string;
  region: string;
  /** e.g. https://<account-id>.r2.cloudflarestorage.com for Cloudflare R2. */
  endpoint?: string | undefined;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

export { contentDisposition } from './content-disposition';
import { contentDisposition } from './content-disposition';

/** Cloudflare R2 / AWS S3 / MinIO compatible storage. */
export class S3Storage implements ObjectStorage {
  readonly driver = 's3' as const;
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: S3StorageOptions) {
    this.bucket = options.bucket;
    this.client = new S3Client({
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      forcePathStyle: options.forcePathStyle ?? false,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      // R2 does not support the SDK's default CRC32 request checksums on every operation.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  private validate(key: string): void {
    if (!isValidStorageKey(key)) throw new AppError('STORAGE_FAILURE', 'Invalid storage key.');
  }

  async putFile(key: string, filePath: string, options: { contentType: string }): Promise<StoredObjectInfo> {
    this.validate(key);
    try {
      const upload = new Upload({
        client: this.client,
        params: { Bucket: this.bucket, Key: key, Body: createReadStream(filePath), ContentType: options.contentType },
        queueSize: 4,
        partSize: 8 * 1024 * 1024,
        leavePartsOnError: false,
      });
      await upload.done();
      const info = await stat(filePath);
      return { key, size: info.size, lastModified: new Date() };
    } catch (error) {
      throw new AppError('STORAGE_FAILURE', undefined, { cause: error });
    }
  }

  async getToFile(key: string, filePath: string, options: { maxBytes?: number } = {}): Promise<void> {
    this.validate(key);
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!response.Body) throw new AppError('NOT_FOUND');
      if (options.maxBytes !== undefined && (response.ContentLength ?? 0) > options.maxBytes) {
        throw new AppError('FILE_TOO_LARGE');
      }
      let received = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          if (options.maxBytes !== undefined && received > options.maxBytes) {
            callback(new AppError('FILE_TOO_LARGE'));
            return;
          }
          callback(null, chunk);
        },
      });
      await pipeline(response.Body as Readable, counter, createWriteStream(filePath, { flags: 'wx', mode: 0o600 }));
    } catch (error) {
      await rm(filePath, { force: true }).catch(() => undefined);
      if (error instanceof AppError) throw error;
      if (error instanceof S3ServiceException && (error.name === 'NoSuchKey' || error.$metadata.httpStatusCode === 404)) {
        throw new AppError('NOT_FOUND');
      }
      throw new AppError('STORAGE_FAILURE', undefined, { cause: error });
    }
  }

  async head(key: string): Promise<StoredObjectInfo | null> {
    this.validate(key);
    try {
      const response = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { key, size: response.ContentLength ?? 0, lastModified: response.LastModified ?? new Date(0) };
    } catch (error) {
      if (error instanceof S3ServiceException && (error.name === 'NotFound' || error.$metadata.httpStatusCode === 404)) {
        return null;
      }
      throw new AppError('STORAGE_FAILURE', undefined, { cause: error });
    }
  }

  async delete(key: string): Promise<void> {
    this.validate(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      throw new AppError('STORAGE_FAILURE', undefined, { cause: error });
    }
  }

  async list(prefix: string): Promise<StoredObjectInfo[]> {
    const results: StoredObjectInfo[] = [];
    let token: string | undefined;
    try {
      do {
        const page = await this.client.send(
          new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ...(token ? { ContinuationToken: token } : {}) }),
        );
        for (const object of page.Contents ?? []) {
          if (object.Key) {
            results.push({ key: object.Key, size: object.Size ?? 0, lastModified: object.LastModified ?? new Date(0) });
          }
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
    } catch (error) {
      throw new AppError('STORAGE_FAILURE', undefined, { cause: error });
    }
    return results;
  }

  async createDownloadUrl(
    key: string,
    options: { filename: string; contentType: string; ttlSeconds: number },
  ): Promise<SignedUrl> {
    this.validate(key);
    try {
      const url = await getSignedUrl(
        this.client,
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ResponseContentDisposition: contentDisposition(options.filename),
          ResponseContentType: options.contentType,
        }),
        { expiresIn: options.ttlSeconds },
      );
      return { url, expiresAt: new Date(Date.now() + options.ttlSeconds * 1000) };
    } catch (error) {
      throw new AppError('STORAGE_FAILURE', undefined, { cause: error });
    }
  }

  async createUploadTicket(
    key: string,
    options: { size: number; contentType: string; ttlSeconds: number },
  ): Promise<UploadTicket> {
    this.validate(key);
    try {
      // Content-Length and Content-Type are part of the signature, so the browser can only
      // PUT exactly the declared size/type. Requires the bucket's CORS policy to allow PUT.
      const url = await getSignedUrl(
        this.client,
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ContentType: options.contentType,
          ContentLength: options.size,
        }),
        { expiresIn: options.ttlSeconds, signableHeaders: new Set(['content-type', 'content-length']) },
      );
      return {
        url,
        method: 'PUT',
        headers: { 'Content-Type': options.contentType },
        expiresAt: new Date(Date.now() + options.ttlSeconds * 1000),
      };
    } catch (error) {
      throw new AppError('STORAGE_FAILURE', undefined, { cause: error });
    }
  }
}
