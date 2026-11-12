import type { JobView, MediaOption, ResolveResponse } from '@vd/shared';

export const MP4_OPTION: MediaOption = {
  id: 'mp4',
  format: 'mp4',
  label: 'MP4 video',
  container: 'mp4',
  resolution: null,
  sizeBytes: null,
  note: null,
};

export const MP3_OPTION: MediaOption = {
  id: 'mp3',
  format: 'mp3',
  label: 'MP3 audio',
  container: 'mp3',
  resolution: null,
  sizeBytes: null,
  note: null,
};

export function availableResolve(overrides: Partial<ResolveResponse> = {}): ResolveResponse {
  return {
    platform: 'instagram',
    platformName: 'Instagram',
    canonicalUrl: 'https://www.instagram.com/reel/Cabc123XYZ/',
    mediaId: 'Cabc123XYZ',
    metadata: { title: 'My reel', author: 'someone', thumbnailUrl: null, durationSeconds: 65 },
    availability: { status: 'available', options: [MP4_OPTION, MP3_OPTION] },
    uploadEnabled: true,
    ...overrides,
  };
}

export function unavailableResolve(overrides: Partial<ResolveResponse> = {}): ResolveResponse {
  return {
    platform: 'youtube',
    platformName: 'YouTube',
    canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    mediaId: 'dQw4w9WgXcQ',
    metadata: { title: 'Some video', author: 'A channel', thumbnailUrl: null, durationSeconds: 212 },
    availability: {
      status: 'unavailable',
      reason: {
        code: 'UNAUTHORIZED_SOURCE',
        message: 'YouTube provides no API for downloading video files.',
        guidance: ['Export your own video from YouTube Studio.', 'Then convert the exported file here.'],
      },
    },
    uploadEnabled: true,
    ...overrides,
  };
}

export const JOB_ID = '5b0f2f5e-3f4a-4f5f-9a27-0d9c1f6e9a11';

export function makeJob(overrides: Partial<JobView> = {}): JobView {
  return {
    id: JOB_ID,
    status: 'queued',
    format: 'mp4',
    progress: { stage: 'queued', percent: 0 },
    createdAt: '2026-11-12T10:00:00.000Z',
    attempt: 1,
    maxAttempts: 2,
    ...overrides,
  };
}

export function completedJob(overrides: Partial<JobView> = {}): JobView {
  return makeJob({
    status: 'completed',
    progress: { stage: 'done', percent: 100 },
    result: {
      filename: 'My reel.mp4',
      format: 'mp4',
      mimeType: 'video/mp4',
      sizeBytes: 5 * 1024 * 1024,
      durationSeconds: 65,
      resolution: '1080×1920',
      losslessVideo: true,
      expiresAt: '2026-11-12T11:00:00.000Z',
      download: { url: 'http://localhost:4000/v1/files/token123', expiresAt: '2026-11-12T10:10:00.000Z' },
    },
    ...overrides,
  });
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
