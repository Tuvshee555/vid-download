/**
 * Error catalogue shared by every app.
 *
 * Every failure the user can hit maps to one stable `ErrorCode` with a plain-language
 * default message, so the UI never has to show a raw exception.
 */

export const ERROR_CODES = [
  'INVALID_URL',
  'UNSUPPORTED_DOMAIN',
  'UNSUPPORTED_URL_TYPE',
  'BLOCKED_ADDRESS',
  'PRIVATE_CONTENT',
  'UNSUPPORTED_MEDIA',
  'UNAUTHORIZED_SOURCE',
  'NOT_CONFIGURED',
  'METADATA_MISSING',
  'PLATFORM_API_ERROR',
  'PROCESSING_FAILED',
  'NETWORK_TIMEOUT',
  'STORAGE_FAILURE',
  'LINK_EXPIRED',
  'FILE_TOO_LARGE',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'RATE_LIMITED',
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

interface ErrorDefinition {
  status: number;
  message: string;
  retryable: boolean;
}

export const ERROR_CATALOGUE: Record<ErrorCode, ErrorDefinition> = {
  INVALID_URL: {
    status: 400,
    message: "That doesn't look like a valid web address. Paste the full link, starting with https://.",
    retryable: false,
  },
  UNSUPPORTED_DOMAIN: {
    status: 400,
    message: "This website isn't supported. MediaDock only accepts YouTube, Instagram and Facebook links.",
    retryable: false,
  },
  UNSUPPORTED_URL_TYPE: {
    status: 400,
    message:
      'This link points to something other than a single video (for example a channel, playlist, profile, story or short link). Paste the full link of one specific video or reel.',
    retryable: false,
  },
  BLOCKED_ADDRESS: {
    status: 400,
    message: 'Links to local or private network addresses are not allowed.',
    retryable: false,
  },
  PRIVATE_CONTENT: {
    status: 403,
    message: "This media is private, or it can't be accessed with the account connected to this server.",
    retryable: false,
  },
  UNSUPPORTED_MEDIA: {
    status: 415,
    message: "This kind of media can't be converted. Only video (MP4) and audio (MP3) are supported.",
    retryable: false,
  },
  UNAUTHORIZED_SOURCE: {
    status: 403,
    message: "There is no permitted way for this server to download this media.",
    retryable: false,
  },
  NOT_CONFIGURED: {
    status: 501,
    message: "This integration isn't configured on the server yet.",
    retryable: false,
  },
  METADATA_MISSING: {
    status: 502,
    message: "The platform didn't return the information needed to process this media.",
    retryable: false,
  },
  PLATFORM_API_ERROR: {
    status: 502,
    message: "The platform's API returned an error. Please try again in a few minutes.",
    retryable: true,
  },
  PROCESSING_FAILED: {
    status: 500,
    message: 'Processing failed. The file may be corrupted or in an unsupported format.',
    retryable: false,
  },
  NETWORK_TIMEOUT: {
    status: 504,
    message: 'The connection timed out. Please try again.',
    retryable: true,
  },
  STORAGE_FAILURE: {
    status: 502,
    message: "The file couldn't be saved to or read from storage. Please try again.",
    retryable: true,
  },
  LINK_EXPIRED: {
    status: 410,
    message: 'This download link has expired. Convert the media again to get a new one.',
    retryable: false,
  },
  FILE_TOO_LARGE: {
    status: 413,
    message: 'This file is larger than the allowed limit.',
    retryable: false,
  },
  UNAUTHENTICATED: {
    status: 401,
    message: 'Please sign in to continue.',
    retryable: false,
  },
  FORBIDDEN: {
    status: 403,
    message: "You don't have access to this resource.",
    retryable: false,
  },
  RATE_LIMITED: {
    status: 429,
    message: 'Too many requests. Please wait a moment and try again.',
    retryable: true,
  },
  VALIDATION_ERROR: {
    status: 400,
    message: 'The request was not valid.',
    retryable: false,
  },
  NOT_FOUND: {
    status: 404,
    message: "That job or file doesn't exist. It may have expired.",
    retryable: false,
  },
  INTERNAL: {
    status: 500,
    message: 'Something went wrong on our side. Please try again.',
    retryable: true,
  },
};

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

export function defaultMessage(code: ErrorCode): string {
  return ERROR_CATALOGUE[code].message;
}

export interface AppErrorOptions {
  /** Overrides the catalogue's retryable flag. */
  retryable?: boolean;
  /** Overrides the catalogue's HTTP status. */
  status?: number;
  /** Extra, user-safe steps that help the user move forward. */
  guidance?: string[];
  cause?: unknown;
}

/**
 * The one error type that crosses module boundaries. `message` is always safe to show
 * to the user; internal detail belongs in `cause` (which is logged, never serialised).
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly guidance: string[] | undefined;

  constructor(code: ErrorCode, message?: string, options: AppErrorOptions = {}) {
    super(message ?? defaultMessage(code), options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? ERROR_CATALOGUE[code].status;
    this.retryable = options.retryable ?? ERROR_CATALOGUE[code].retryable;
    this.guidance = options.guidance;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Wire format returned by the API for every non-2xx response. */
export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    guidance?: string[];
  };
}

export function toApiErrorBody(error: AppError): ApiErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.guidance && error.guidance.length > 0 ? { guidance: error.guidance } : {}),
    },
  };
}
