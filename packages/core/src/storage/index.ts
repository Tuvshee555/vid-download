import type { AppConfig } from '../config';
import { LocalStorage } from './local';
import { S3Storage } from './s3';
import type { ObjectStorage } from './types';

export * from './types';
export { LocalStorage, type DownloadClaims, type UploadClaims } from './local';
export { S3Storage, contentDisposition } from './s3';

/**
 * Build the configured storage driver. Only the API passes `signing` (it mints local
 * signed links); the worker never needs to.
 */
export function createStorage(config: AppConfig, signing?: { apiPublicUrl: string; secret: string }): ObjectStorage {
  if (config.storage.driver === 's3') {
    return new S3Storage({
      bucket: config.storage.bucket,
      region: config.storage.region,
      endpoint: config.storage.endpoint,
      accessKeyId: config.storage.accessKeyId,
      secretAccessKey: config.storage.secretAccessKey,
      forcePathStyle: config.storage.forcePathStyle,
    });
  }
  return new LocalStorage({
    dir: config.storage.dir,
    ...(signing ? { apiPublicUrl: signing.apiPublicUrl, signingSecret: signing.secret } : {}),
  });
}
