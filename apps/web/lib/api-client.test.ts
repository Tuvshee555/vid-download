import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiClientError,
  createJob,
  getJob,
  login,
  resolveUrl,
  setUnauthorizedHandler,
} from '@/lib/api-client';
import { availableResolve, JOB_ID, jsonResponse, makeJob } from '@/test/fixtures';

const fetchMock = vi.fn<typeof fetch>();
const onUnauthorized = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  setUnauthorizedHandler(onUnauthorized);
});

afterEach(() => {
  fetchMock.mockReset();
  onUnauthorized.mockReset();
  vi.unstubAllGlobals();
});

async function catchError(promise: Promise<unknown>): Promise<ApiClientError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiClientError);
    return error as ApiClientError;
  }
  throw new Error('expected the promise to reject');
}

describe('api client', () => {
  it('POSTs JSON to the same-origin proxy and returns the typed body', async () => {
    const body = availableResolve();
    fetchMock.mockResolvedValue(jsonResponse(body));

    await expect(resolveUrl('https://youtu.be/dQw4w9WgXcQ')).resolves.toEqual(body);

    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe('/api/resolve');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' });
    expect(JSON.parse(String(init?.body))).toEqual({ url: 'https://youtu.be/dQw4w9WgXcQ' });
  });

  it('GETs a job by id', async () => {
    fetchMock.mockResolvedValue(jsonResponse(makeJob()));
    await getJob(JOB_ID);
    expect(fetchMock.mock.calls[0]![0]).toBe(`/api/jobs/${JOB_ID}`);
  });

  it('parses the API error body into a typed error', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { code: 'UNSUPPORTED_DOMAIN', message: 'Not supported here.', retryable: false, guidance: ['Use YouTube.'] } },
        400,
      ),
    );
    const error = await catchError(resolveUrl('https://vimeo.com/1'));
    expect(error).toMatchObject({
      code: 'UNSUPPORTED_DOMAIN',
      message: 'Not supported here.',
      status: 400,
      retryable: false,
      guidance: ['Use YouTube.'],
      network: false,
    });
  });

  it('falls back to a status-based message when the body is not an API error', async () => {
    fetchMock.mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 }));
    const error = await catchError(resolveUrl('https://youtu.be/dQw4w9WgXcQ'));
    expect(error.code).toBe('PLATFORM_API_ERROR');
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain('html');

    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'NOT_A_REAL_CODE', message: 'x' } }, 429));
    expect((await catchError(createJob({ source: 'url', url: 'https://youtu.be/dQw4w9WgXcQ', format: 'mp4' }))).code).toBe('RATE_LIMITED');
  });

  it('turns network failures into a friendly retryable error', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const error = await catchError(resolveUrl('https://youtu.be/dQw4w9WgXcQ'));
    expect(error).toMatchObject({ code: 'NETWORK_TIMEOUT', network: true, retryable: true, status: 0 });
    expect(error.message).toMatch(/couldn't reach the server/i);
  });

  it('propagates aborts untouched', async () => {
    fetchMock.mockRejectedValue(new DOMException('aborted', 'AbortError'));
    await expect(getJob(JOB_ID)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('redirects to sign-in on 401', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'UNAUTHENTICATED', message: 'Please sign in.', retryable: false } }, 401));
    const error = await catchError(getJob(JOB_ID));
    expect(error.code).toBe('UNAUTHENTICATED');
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('does not redirect when the login itself returns 401', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'UNAUTHENTICATED', message: 'Wrong password.', retryable: false } }, 401));
    const error = await catchError(login('nope'));
    expect(error.message).toBe('Wrong password.');
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('reports an unreadable success body as an internal error', async () => {
    fetchMock.mockResolvedValue(new Response('not json', { status: 200 }));
    expect((await catchError(getJob(JOB_ID))).code).toBe('INTERNAL');
  });
});
