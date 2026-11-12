import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '@vd/shared';
import { downloadToFile } from './download';
import { isIpLiteral, isPublicIp } from './ip';
import {
  UNSAFE_allowLoopbackGuard,
  assertFetchable,
  createHttpClient,
  exactHostMatcher,
  hostSuffixMatcher,
  readBody,
  safeRequest,
} from './safe-fetch';

describe('isPublicIp', () => {
  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '142.250.80.46',
    '31.13.65.36',
    '2606:4700:4700::1111',
    '2a03:2880:f12f:83:face:b00c:0:25de',
  ])('allows %s', (ip) => expect(isPublicIp(ip)).toBe(true));

  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '10.255.255.255',
    '100.64.0.1',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '192.168.255.255',
    '198.18.0.1',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:8.8.8.8', // mapped addresses are refused outright
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '64:ff9b::7f00:1',
  ])('blocks %s', (ip) => expect(isPublicIp(ip)).toBe(false));

  it('rejects things that are not IP addresses', () => {
    expect(isPublicIp('example.com')).toBe(false);
    expect(isPublicIp('')).toBe(false);
    expect(isPublicIp('999.1.1.1')).toBe(false);
    expect(isPublicIp('8.8.8.8/32')).toBe(false);
  });

  it('detects IP literals', () => {
    expect(isIpLiteral('127.0.0.1')).toBe(true);
    expect(isIpLiteral('[::1]')).toBe(true);
    expect(isIpLiteral('example.com')).toBe(false);
  });
});

describe('host matchers', () => {
  it('matches exact hosts only', () => {
    const match = exactHostMatcher(['graph.facebook.com']);
    expect(match('graph.facebook.com')).toBe(true);
    expect(match('GRAPH.FACEBOOK.COM.')).toBe(true);
    expect(match('evil.graph.facebook.com')).toBe(false);
    expect(match('graph.facebook.com.evil.example')).toBe(false);
  });

  it('matches suffixes on label boundaries', () => {
    const match = hostSuffixMatcher(['fbcdn.net']);
    expect(match('video.xx.fbcdn.net')).toBe(true);
    expect(match('fbcdn.net')).toBe(true);
    expect(match('notfbcdn.net')).toBe(false);
    expect(match('fbcdn.net.evil.example')).toBe(false);
  });
});

describe('assertFetchable (strict mode)', () => {
  const allow = hostSuffixMatcher(['example.com']);

  it('accepts an allowlisted https URL', () => {
    expect(assertFetchable('https://cdn.example.com/a.mp4', allow).hostname).toBe('cdn.example.com');
  });

  it.each([
    ['http://cdn.example.com/a.mp4', 'plain http'],
    ['https://user:pw@cdn.example.com/a.mp4', 'credentials'],
    ['https://cdn.example.com:8443/a.mp4', 'custom port'],
    ['https://127.0.0.1/a.mp4', 'IPv4 literal'],
    ['https://[::1]/a.mp4', 'IPv6 literal'],
    ['https://evil.example.org/a.mp4', 'host not on allowlist'],
    ['https://example.com.evil.org/a.mp4', 'suffix trick'],
    ['file:///etc/passwd', 'file scheme'],
    ['ftp://cdn.example.com/a.mp4', 'ftp scheme'],
  ])('rejects %s (%s)', (url) => {
    expect(() => assertFetchable(url, allow)).toThrowError(AppError);
  });

  it('rejects garbage', () => {
    expect(() => assertFetchable('not a url', allow)).toThrowError(AppError);
  });
});

describe('connection-time DNS guard', () => {
  it('refuses to connect to an allowlisted hostname that resolves to loopback', async () => {
    // "localhost" passes the name allowlist but resolves to 127.0.0.1 / ::1 → must be blocked at connect time.
    await expect(safeRequest('https://localhost/anything', { allowedHost: exactHostMatcher(['localhost']) })).rejects.toMatchObject({
      code: 'BLOCKED_ADDRESS',
    });
  });
});

// ───────────── behaviour against a real local server (loopback allowed via the test-only guard) ─────────────

describe('safe HTTP against a local server', () => {
  let server: Server;
  let base: string;
  let workDir: string;
  const handlers = new Map<string, (req: IncomingMessage, res: ServerResponse) => unknown>();
  const allowLocal = exactHostMatcher(['127.0.0.1']);

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'vd-net-test-'));
    server = createServer((req, res) => {
      const handler = handlers.get(req.url ?? '');
      if (!handler) {
        res.writeHead(404).end('nope');
        return;
      }
      void handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(workDir, { recursive: true, force: true });
  });

  it('fetches JSON', async () => {
    handlers.set('/json', (_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'));
    const client = createHttpClient(allowLocal, UNSAFE_allowLoopbackGuard);
    await expect(client.getJson(`${base}/json`)).resolves.toEqual({ status: 200, body: { ok: true } });
  });

  it('reports an unreadable JSON body as a platform error', async () => {
    handlers.set('/bad-json', (_req, res) => res.writeHead(200).end('<html>'));
    const client = createHttpClient(allowLocal, UNSAFE_allowLoopbackGuard);
    await expect(client.getJson(`${base}/bad-json`)).rejects.toMatchObject({ code: 'PLATFORM_API_ERROR' });
  });

  it('follows same-host redirects but re-validates every hop', async () => {
    handlers.set('/redir-ok', (_req, res) => res.writeHead(302, { location: '/json' }).end());
    handlers.set('/redir-bad', (_req, res) => res.writeHead(302, { location: 'http://localhost:1/steal' }).end());
    handlers.set('/redir-loop', (_req, res) => res.writeHead(302, { location: '/redir-loop' }).end());
    const client = createHttpClient(allowLocal, UNSAFE_allowLoopbackGuard);
    await expect(client.getJson(`${base}/redir-ok`)).resolves.toMatchObject({ status: 200 });
    await expect(client.getJson(`${base}/redir-bad`)).rejects.toMatchObject({ code: 'BLOCKED_ADDRESS' });
    await expect(client.getJson(`${base}/redir-loop`)).rejects.toMatchObject({ code: 'PLATFORM_API_ERROR' });
  });

  it('times out slow servers', async () => {
    handlers.set('/slow', () => {
      /* never respond */
    });
    await expect(
      safeRequest(`${base}/slow`, { allowedHost: allowLocal, guard: UNSAFE_allowLoopbackGuard, timeoutMs: 300 }),
    ).rejects.toMatchObject({ code: 'NETWORK_TIMEOUT' });
  });

  it('caps in-memory bodies', async () => {
    handlers.set('/big', (_req, res) => res.writeHead(200).end(Buffer.alloc(10_000)));
    const response = await safeRequest(`${base}/big`, { allowedHost: allowLocal, guard: UNSAFE_allowLoopbackGuard });
    await expect(readBody(response.body, 100)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('probes content length with HEAD and never throws', async () => {
    handlers.set('/head', (_req, res) => res.writeHead(200, { 'content-length': '1234' }).end());
    const client = createHttpClient(allowLocal, UNSAFE_allowLoopbackGuard);
    await expect(client.headContentLength(`${base}/head`)).resolves.toBe(1234);
    await expect(client.headContentLength(`${base}/missing`)).resolves.toBeNull();
    await expect(client.headContentLength('https://not-allowed.example/x')).resolves.toBeNull();
  });

  describe('downloadToFile', () => {
    const options = { allowedHost: allowLocal, guard: UNSAFE_allowLoopbackGuard, timeoutMs: 5_000 };

    it('streams a file to disk and reports progress', async () => {
      const payload = Buffer.alloc(300_000, 7);
      handlers.set('/ok.mp4', (_req, res) => res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': payload.length }).end(payload));
      const destination = join(workDir, 'ok.mp4');
      const progress: number[] = [];
      const result = await downloadToFile(`${base}/ok.mp4`, destination, {
        ...options,
        maxBytes: 1_000_000,
        onProgress: (received) => progress.push(received),
      });
      expect(result.bytes).toBe(payload.length);
      expect((await readFile(destination)).equals(payload)).toBe(true);
      expect(progress.at(-1)).toBe(payload.length);
    });

    it('refuses oversized files up front using Content-Length', async () => {
      handlers.set('/huge', (_req, res) => res.writeHead(200, { 'content-length': 5_000_000 }).end());
      await expect(downloadToFile(`${base}/huge`, join(workDir, 'huge'), { ...options, maxBytes: 1_000 })).rejects.toMatchObject({
        code: 'FILE_TOO_LARGE',
      });
    });

    it('enforces the cap while streaming when no Content-Length is sent, and deletes the partial file', async () => {
      handlers.set('/chunked', async (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        for (let i = 0; i < 50; i += 1) {
          if (!res.write(Buffer.alloc(10_000))) await new Promise((r) => res.once('drain', r));
        }
        res.end();
      });
      const destination = join(workDir, 'chunked');
      await expect(downloadToFile(`${base}/chunked`, destination, { ...options, maxBytes: 100_000 })).rejects.toMatchObject({
        code: 'FILE_TOO_LARGE',
      });
      await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('rejects HTML pages served instead of media', async () => {
      handlers.set('/login-wall', (_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<html>login</html>'));
      await expect(downloadToFile(`${base}/login-wall`, join(workDir, 'wall'), { ...options, maxBytes: 1_000_000 })).rejects.toMatchObject({
        code: 'UNSUPPORTED_MEDIA',
      });
    });

    it('maps expired CDN links (403/404) to a retryable platform error', async () => {
      handlers.set('/expired', (_req, res) => res.writeHead(403).end());
      const error = await downloadToFile(`${base}/expired`, join(workDir, 'expired'), { ...options, maxBytes: 1_000_000 }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: 'PLATFORM_API_ERROR', retryable: true });
    });

    it('does not let strict mode talk to loopback at all', async () => {
      await expect(
        downloadToFile(`${base}/ok.mp4`, join(workDir, 'strict'), { allowedHost: allowLocal, maxBytes: 1_000, timeoutMs: 1_000 }),
      ).rejects.toMatchObject({ code: 'BLOCKED_ADDRESS' });
    });
  });
});
