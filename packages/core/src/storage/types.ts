export interface StoredObjectInfo {
  key: string;
  size: number;
  lastModified: Date;
}

export interface SignedUrl {
  url: string;
  expiresAt: Date;
}

export interface UploadTicket extends SignedUrl {
  method: 'PUT';
  headers: Record<string, string>;
}

/**
 * Object storage used for uploads (inputs) and converted files (outputs).
 *
 * Keys are ASCII-only and application-generated (`uploads/<uuid>`, `outputs/<uuid>/output.mp4`);
 * the human-friendly file name travels separately in the job result and is applied via
 * Content-Disposition when a link is signed.
 */
export interface ObjectStorage {
  readonly driver: 'local' | 's3';
  putFile(key: string, filePath: string, options: { contentType: string }): Promise<StoredObjectInfo>;
  getToFile(key: string, filePath: string, options?: { maxBytes?: number }): Promise<void>;
  head(key: string): Promise<StoredObjectInfo | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<StoredObjectInfo[]>;
  createDownloadUrl(key: string, options: { filename: string; contentType: string; ttlSeconds: number }): Promise<SignedUrl>;
  createUploadTicket(key: string, options: { size: number; contentType: string; ttlSeconds: number }): Promise<UploadTicket>;
}

export const UPLOAD_PREFIX = 'uploads/';
export const OUTPUT_PREFIX = 'outputs/';

export const uploadKey = (uploadId: string) => `${UPLOAD_PREFIX}${uploadId}`;
export const outputKey = (jobId: string, extension: string) => `${OUTPUT_PREFIX}${jobId}/output.${extension}`;

/** Keys must look exactly like the two shapes above — nothing else ever touches the disk/bucket. */
const KEY_PATTERN = /^(uploads\/[A-Za-z0-9-]{8,64}|outputs\/[A-Za-z0-9-]{8,64}\/[A-Za-z0-9._-]{1,64})$/;

export function isValidStorageKey(key: string): boolean {
  return KEY_PATTERN.test(key) && !key.includes('..');
}
