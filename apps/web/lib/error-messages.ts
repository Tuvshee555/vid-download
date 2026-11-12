import type { ErrorCode } from '@vd/shared';

const TITLES: Partial<Record<ErrorCode, string>> = {
  INVALID_URL: "That link doesn't look right",
  UNSUPPORTED_DOMAIN: 'This website is not supported',
  UNSUPPORTED_URL_TYPE: 'Paste a link to a single video',
  BLOCKED_ADDRESS: 'This address is not allowed',
  PRIVATE_CONTENT: 'This media is not accessible',
  UNSUPPORTED_MEDIA: "This media can't be converted",
  UNAUTHORIZED_SOURCE: 'No permitted download route',
  NOT_CONFIGURED: 'Integration not configured',
  METADATA_MISSING: 'Missing media information',
  PLATFORM_API_ERROR: 'The platform or server had a problem',
  PROCESSING_FAILED: 'Processing failed',
  NETWORK_TIMEOUT: 'Connection problem',
  STORAGE_FAILURE: 'Storage problem',
  LINK_EXPIRED: 'This link has expired',
  FILE_TOO_LARGE: 'File too large',
  UNAUTHENTICATED: 'Please sign in again',
  FORBIDDEN: 'Access denied',
  RATE_LIMITED: 'Slow down for a moment',
  VALIDATION_ERROR: 'Something is not quite right',
  NOT_FOUND: 'Not found',
  INTERNAL: 'Something went wrong',
};

export function errorTitle(code: ErrorCode): string {
  return TITLES[code] ?? 'Something went wrong';
}
