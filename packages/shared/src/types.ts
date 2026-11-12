/**
 * Wire types for the REST API. The web app, API and worker all import these, so a
 * contract change is a compile error everywhere instead of a runtime surprise.
 */
import type { ErrorCode } from './errors';
import type { Platform } from './platforms';

export const MEDIA_FORMATS = ['mp4', 'mp3'] as const;
export type MediaFormat = (typeof MEDIA_FORMATS)[number];

export const FORMAT_MIME: Record<MediaFormat, string> = {
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
};

/** Extensions accepted by the "convert your own file" flow. Content is re-validated with ffprobe. */
export const ALLOWED_UPLOAD_EXTENSIONS = [
  'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'flv', '3gp', 'ts', 'mts', 'm2ts', 'mpg', 'mpeg', 'wmv',
  'mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac',
] as const;

// ───────────────────────── resolve ─────────────────────────

export interface MediaMetadata {
  title: string | null;
  author: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
}

export interface MediaOption {
  /** Same as `format`; one option per output format. */
  id: MediaFormat;
  format: MediaFormat;
  /** e.g. "MP4 video" / "MP3 audio". */
  label: string;
  container: string;
  /** Only present when the platform reports it truthfully. */
  resolution: string | null;
  /** Source file size when the platform reports it; MP3 size is never guessed. */
  sizeBytes: number | null;
  /** Honest caveat shown under the option, e.g. "Original quality, no re-encoding where possible." */
  note: string | null;
}

export interface UnavailableReason {
  code: ErrorCode;
  message: string;
  /** Concrete next steps for the user. */
  guidance: string[];
}

export type Availability =
  | { status: 'available'; options: MediaOption[] }
  | { status: 'unavailable'; reason: UnavailableReason };

export interface ResolveResponse {
  platform: Platform;
  platformName: string;
  canonicalUrl: string;
  mediaId: string;
  metadata: MediaMetadata | null;
  availability: Availability;
  /** The "convert your own file" flow is always offered as the permitted fallback. */
  uploadEnabled: boolean;
}

// ───────────────────────── jobs ─────────────────────────

export const JOB_STATUSES = ['queued', 'processing', 'completed', 'failed', 'expired'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_STAGES = ['queued', 'resolving', 'downloading', 'probing', 'converting', 'uploading', 'done'] as const;
export type JobStage = (typeof JOB_STAGES)[number];

export interface JobProgress {
  stage: JobStage;
  /** 0–100. */
  percent: number;
}

export interface JobResultView {
  filename: string;
  format: MediaFormat;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  /** e.g. "1920×1080" — read from the processed file, never guessed. */
  resolution: string | null;
  /** True when the video stream was copied instead of re-encoded. */
  losslessVideo: boolean | null;
  /** The stored file is deleted after this moment. */
  expiresAt: string;
  /** Short-lived signed link. A fresh one is issued on every status poll. */
  download: { url: string; expiresAt: string };
}

export interface JobErrorView {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export interface JobView {
  id: string;
  status: JobStatus;
  format: MediaFormat;
  progress: JobProgress;
  createdAt: string;
  /** 1-based attempt counter, for retry display. */
  attempt: number;
  maxAttempts: number;
  result?: JobResultView;
  error?: JobErrorView;
}

export interface CreateJobResponse {
  id: string;
  status: 'queued';
}

/** What the worker stores as a BullMQ job `returnvalue`. Not exposed to clients as-is. */
export interface JobResultRecord {
  storageKey: string;
  filename: string;
  format: MediaFormat;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  resolution: string | null;
  losslessVideo: boolean | null;
  /** ISO timestamp. */
  expiresAt: string;
}

// ───────────────────────── uploads ─────────────────────────

export interface UploadTicketResponse {
  uploadId: string;
  upload: {
    url: string;
    method: 'PUT';
    headers: Record<string, string>;
    expiresAt: string;
  };
  maxBytes: number;
}

// ───────────────────────── auth & meta ─────────────────────────

export interface LoginResponse {
  token: string;
  expiresAt: string;
}

export interface SessionResponse {
  authenticated: true;
  expiresAt: string;
}

export interface PlatformInfo {
  platform: Platform;
  name: string;
  /** Whether the server has credentials for the platform's official API (always true when none are needed). */
  configured: boolean;
  /**
   * What the integration can legitimately do:
   * - `own-media`: downloads media owned by the account connected to the server, via the official API.
   * - `metadata-only`: recognises links and shows details, but the platform offers no permitted download API.
   */
  capability: 'own-media' | 'metadata-only';
  /** What this integration can legitimately do. Rendered verbatim in the UI. */
  summary: string;
}

export interface PlatformsResponse {
  platforms: PlatformInfo[];
  limits: {
    maxUploadBytes: number;
    maxDurationSeconds: number;
    fileTtlMinutes: number;
  };
}
