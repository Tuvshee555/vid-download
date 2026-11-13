// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@vd/core/config';

const SECRET = 'relay-secret-0123456789-abcdefghijklmnopqrstuv';
const HELPER = 'https://my-pc.ngrok-free.dev';

const fakeResolve = vi.fn();
vi.mock('@/lib/server/standalone', () => ({
  serverMode: () => 'standalone',
  standalone: () => ({
    config: loadConfig({ NODE_ENV: 'test', ACCESS_PASSWORD: 'x' }),
    adapters: new Proxy({}, { get: (_t, platform) => ({ resolve: fakeResolve, describe: () => ({ configured: true, capability: 'public-links', summary: `${String(platform)} summary` }) }) }),
  }),
  standaloneSession: (token?: string) => (token === 'valid-session' ? { expiresAt: new Date(Date.now() + 60_000) } : null),
}));

import { handleStandalone } from './standalone-api';
import { isRelayRequest, relayTarget } from './relay';

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubEnv('RELAY_SECRET', SECRET);
  vi.stubEnv('RELAY_URL', HELPER);
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  fakeResolve.mockReset();
});

const resolveBody = (url: string) => JSON.stringify({ url });

describe('relay authentication', () => {
  it('accepts only the exact shared secret', () => {
    expect(isRelayRequest(new Headers({ 'x-mediadock-relay': SECRET }))).toBe(true);
    expect(isRelayRequest(new Headers({ 'x-mediadock-relay': `${SECRET}x` }))).toBe(false);
    expect(isRelayRequest(new Headers({ 'x-mediadock-relay': '' }))).toBe(false);
    expect(isRelayRequest(new Headers())).toBe(false);
  });

  it('is disabled when no (or a weak) secret is configured', () => {
    vi.stubEnv('RELAY_SECRET', 'short');
    expect(isRelayRequest(new Headers({ 'x-mediadock-relay': 'short' }))).toBe(false);
    expect(relayTarget('youtube')).toBeNull();
  });
});

describe('relayTarget', () => {
  it('relays YouTube only by default', () => {
    expect(relayTarget('youtube')).toBe(HELPER);
    expect(relayTarget('instagram')).toBeNull();
    expect(relayTarget('tiktok')).toBeNull();
  });

  it('honours RELAY_PLATFORMS and refuses non-https helpers', () => {
    vi.stubEnv('RELAY_PLATFORMS', 'youtube, tiktok');
    expect(relayTarget('tiktok')).toBe(HELPER);
    vi.stubEnv('RELAY_URL', 'http://my-pc.example');
    expect(relayTarget('youtube')).toBeNull();
    vi.stubEnv('RELAY_URL', '');
    expect(relayTarget('youtube')).toBeNull();
  });
});

describe('resolve through the home helper', () => {
  it('forwards YouTube links (canonical URL + secret) and passes the answer through', async () => {
    const answer = { platform: 'youtube', availability: { status: 'available', options: [] } };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(answer), { headers: { 'content-type': 'application/json' } }));

    const response = await handleStandalone('POST', 'resolve', 'valid-session', resolveBody('https://youtu.be/69IQ8q-g1q0?si=x'));

    expect(await response.json()).toEqual(answer);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${HELPER}/api/resolve`);
    expect(JSON.parse(String(init?.body))).toEqual({ url: 'https://www.youtube.com/watch?v=69IQ8q-g1q0' });
    expect((init?.headers as Record<string, string>)['x-mediadock-relay']).toBe(SECRET);
    expect(fakeResolve).not.toHaveBeenCalled();
  });

  it('explains when the helper is offline instead of failing', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const response = await handleStandalone('POST', 'resolve', 'valid-session', resolveBody('https://www.youtube.com/watch?v=69IQ8q-g1q0'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      platform: 'youtube',
      availability: { status: 'unavailable', reason: { code: 'PLATFORM_API_ERROR', message: expect.stringMatching(/home PC/) } },
    });
  });

  it('treats the tunnel\'s own "endpoint offline" page as offline', async () => {
    fetchMock.mockResolvedValue(new Response('<html>ERR_NGROK_3200</html>', { status: 404, headers: { 'content-type': 'text/html' } }));
    const response = await handleStandalone('POST', 'resolve', 'valid-session', resolveBody('https://www.youtube.com/watch?v=69IQ8q-g1q0'));
    expect(await response.json()).toMatchObject({ availability: { status: 'unavailable' } });
  });

  it('resolves other platforms locally (no relay)', async () => {
    fakeResolve.mockResolvedValue({ metadata: null, availability: { status: 'available', options: [] } });
    const response = await handleStandalone('POST', 'resolve', 'valid-session', resolveBody('https://www.tiktok.com/@realmadrid/video/7707305867162570017'));
    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fakeResolve).toHaveBeenCalledOnce();
  });
});

describe('helper side', () => {
  it('lets the cloud deployment resolve with the relay secret instead of a session', async () => {
    vi.stubEnv('RELAY_URL', ''); // the home helper itself has no relay target
    fakeResolve.mockResolvedValue({ metadata: null, availability: { status: 'available', options: [] } });
    const response = await handleStandalone('POST', 'resolve', undefined, resolveBody('https://www.youtube.com/watch?v=69IQ8q-g1q0'), true);
    expect(response.status).toBe(200);
    expect(fakeResolve).toHaveBeenCalledOnce();
  });

  it('still requires a real session for everything else', async () => {
    expect((await handleStandalone('POST', 'resolve', undefined, resolveBody('https://youtu.be/69IQ8q-g1q0'))).status).toBe(401);
    expect((await handleStandalone('GET', 'auth/session', undefined, undefined, true)).status).toBe(401);
  });

  it('tells the user YouTube runs on the home PC in the platform list', async () => {
    const response = await handleStandalone('GET', 'platforms', 'valid-session', undefined);
    const body = (await response.json()) as { platforms: Array<{ platform: string; summary: string }> };
    expect(body.platforms.find((p) => p.platform === 'youtube')?.summary).toMatch(/home PC/);
    expect(body.platforms.find((p) => p.platform === 'tiktok')?.summary).toBe('tiktok summary');
  });
});
