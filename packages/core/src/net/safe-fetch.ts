/**
 * SSRF-hardened HTTP client.
 *
 * Every outbound request made by this application goes through here. Defences, in order:
 *   1. https only, no credentials, no custom ports, no IP-literal hosts.
 *   2. The hostname must satisfy a caller-supplied allowlist (exact hosts or suffixes).
 *   3. Redirects are followed manually and each hop is re-validated against the allowlist.
 *   4. The connection-time DNS lookup is guarded: if *any* resolved address is not public,
 *      the connection is refused. Because the check happens inside the socket's own lookup,
 *      there is no validate-then-connect gap for DNS rebinding to exploit.
 *   5. Hard timeouts and response size caps.
 */
import dns from 'node:dns';
import type { LookupFunction } from 'node:net';
import { type Readable } from 'node:stream';
import { Agent, request } from 'undici';
import { AppError } from '@vd/shared';
import { isIpLiteral, isPublicIp } from './ip';

export interface AddressGuard {
  readonly name: string;
  allowIp(address: string): boolean;
  /** TEST ONLY: also permit http, custom ports and IP-literal hosts. Never true for the production guard. */
  readonly relaxedUrlChecks?: boolean;
}

/** Production guard: only globally routable addresses. */
export const publicOnlyGuard: AddressGuard = { name: 'public-only', allowIp: isPublicIp };

/**
 * TEST USE ONLY — permits loopback so integration tests can talk to a local server.
 * It can only be reached through code, never through configuration or environment.
 */
export const UNSAFE_allowLoopbackGuard: AddressGuard = {
  name: 'unsafe-allow-loopback',
  relaxedUrlChecks: true,
  allowIp: (address) => isPublicIp(address) || address === '127.0.0.1' || address === '::1',
};

export type HostMatcher = (hostname: string) => boolean;

/** Match exact hostnames or any subdomain of the given suffixes ("fbcdn.net" matches "video.xx.fbcdn.net"). */
export function hostSuffixMatcher(suffixes: readonly string[]): HostMatcher {
  const normalised = suffixes.map((suffix) => suffix.toLowerCase().replace(/^\./, ''));
  return (hostname) => {
    const host = hostname.toLowerCase().replace(/\.$/, '');
    return normalised.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  };
}

export function exactHostMatcher(hosts: readonly string[]): HostMatcher {
  const set = new Set(hosts.map((host) => host.toLowerCase()));
  return (hostname) => set.has(hostname.toLowerCase().replace(/\.$/, ''));
}

class AddressBlockedError extends Error {
  readonly code = 'ADDRESS_BLOCKED';
  constructor(hostname: string) {
    super(`Refusing to connect to ${hostname}: it resolves to a non-public address.`);
  }
}

function createGuardedLookup(guard: AddressGuard): LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) {
        (callback as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(error, '', 0);
        return;
      }
      const list = addresses;
      if (list.length === 0 || list.some((entry) => !guard.allowIp(entry.address))) {
        (callback as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(
          new AddressBlockedError(hostname),
          '',
          0,
        );
        return;
      }
      if ((options as { all?: boolean }).all) {
        (callback as unknown as (err: null, addresses: dns.LookupAddress[]) => void)(null, list);
      } else {
        const first = list[0]!;
        callback(null, first.address, first.family);
      }
    });
  };
}

const agents = new Map<AddressGuard, Agent>();

function agentFor(guard: AddressGuard): Agent {
  let agent = agents.get(guard);
  if (!agent) {
    agent = new Agent({
      connect: { lookup: createGuardedLookup(guard), timeout: 15_000 },
      headersTimeout: 30_000,
      bodyTimeout: 60_000,
      connections: 16,
    });
    agents.set(guard, agent);
  }
  return agent;
}

/**
 * Abandon a response body without crashing the process: destroying an undici body emits an
 * 'error' (AbortError) event, which is fatal if nothing is listening.
 */
export function discardBody(body: Readable): void {
  body.on('error', () => undefined);
  body.destroy();
}

export interface SafeRequestOptions {
  /** Required. Requests to any other host (including via redirect) are refused. */
  allowedHost: HostMatcher;
  method?: 'GET' | 'HEAD' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  maxRedirects?: number;
  /** Overall deadline including redirects; response bodies are cut off by `signal` too. */
  timeoutMs?: number;
  signal?: AbortSignal;
  guard?: AddressGuard;
}

export interface SafeResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Readable;
  url: string;
}

/** Throws AppError for anything that must never be fetched. Exported for unit tests. */
export function assertFetchable(rawUrl: string, allowedHost: HostMatcher, relaxed = false): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError('INVALID_URL');
  }
  if (url.protocol !== 'https:' && !(relaxed && url.protocol === 'http:')) {
    throw new AppError('BLOCKED_ADDRESS', 'Only https connections are allowed.');
  }
  if (url.username || url.password) throw new AppError('BLOCKED_ADDRESS', 'URLs with credentials are not allowed.');
  if (url.port !== '' && !relaxed) throw new AppError('BLOCKED_ADDRESS', 'Custom ports are not allowed.');
  if (isIpLiteral(url.hostname) && !relaxed) throw new AppError('BLOCKED_ADDRESS', 'IP addresses are not allowed as hosts.');
  if (!allowedHost(url.hostname)) {
    throw new AppError('BLOCKED_ADDRESS', 'This host is not on the allowlist.');
  }
  return url;
}

function mapNetworkError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const err = error as { name?: string; code?: string; cause?: { code?: string; name?: string } };
  const code = err.code ?? err.cause?.code;
  if (code === 'ADDRESS_BLOCKED' || err.cause?.code === 'ADDRESS_BLOCKED') {
    return new AppError('BLOCKED_ADDRESS', 'That address resolves to a private network and was blocked.', { cause: error });
  }
  if (
    err.name === 'AbortError' ||
    err.name === 'TimeoutError' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'ETIMEDOUT'
  ) {
    return new AppError('NETWORK_TIMEOUT', undefined, { cause: error });
  }
  return new AppError('PLATFORM_API_ERROR', 'Could not reach the remote service.', { cause: error });
}

export async function safeRequest(rawUrl: string, options: SafeRequestOptions): Promise<SafeResponse> {
  const guard = options.guard ?? publicOnlyGuard;
  const maxRedirects = options.maxRedirects ?? 3;
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 30_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const url = assertFetchable(current, options.allowedHost, guard.relaxedUrlChecks === true);
    let response;
    try {
      response = await request(url, {
        method: options.method ?? 'GET',
        headers: { 'user-agent': 'MediaDock/1.0 (+private)', accept: '*/*', ...options.headers },
        ...(options.body === undefined ? {} : { body: options.body }),
        dispatcher: agentFor(guard),
        signal,
        // undici's `request` never follows redirects on its own; the loop below re-validates each hop.
      });
    } catch (error) {
      throw mapNetworkError(error);
    }

    const location = response.headers.location;
    if (response.statusCode >= 300 && response.statusCode < 400 && typeof location === 'string') {
      discardBody(response.body);
      if (hop === maxRedirects) throw new AppError('PLATFORM_API_ERROR', 'Too many redirects.');
      current = new URL(location, url).toString();
      continue;
    }
    return {
      statusCode: response.statusCode,
      headers: response.headers,
      body: response.body as unknown as Readable,
      url: url.toString(),
    };
  }
  throw new AppError('PLATFORM_API_ERROR', 'Too many redirects.');
}

/** Read a response body into memory with a hard cap. */
export async function readBody(body: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buffer.length;
      if (total > maxBytes) {
        discardBody(body);
        throw new AppError('FILE_TOO_LARGE', 'The remote response was larger than expected.');
      }
      chunks.push(buffer);
    }
  } catch (error) {
    throw mapNetworkError(error);
  }
  return Buffer.concat(chunks);
}

export interface JsonResponse {
  status: number;
  body: unknown;
}

export interface HttpClient {
  getJson(url: string, options?: { signal?: AbortSignal; timeoutMs?: number; headers?: Record<string, string> }): Promise<JsonResponse>;
  /** Best-effort Content-Length probe; resolves null when unknown. Never throws. */
  headContentLength(url: string, options?: { signal?: AbortSignal }): Promise<number | null>;
}

const MAX_JSON_BYTES = 2 * 1024 * 1024;

/** Default HttpClient for platform API calls: allowlisted hosts only, JSON only, size-capped. */
export function createHttpClient(allowedHost: HostMatcher, guard: AddressGuard = publicOnlyGuard): HttpClient {
  return {
    async getJson(url, options = {}) {
      const response = await safeRequest(url, {
        allowedHost,
        guard,
        timeoutMs: options.timeoutMs ?? 20_000,
        ...(options.signal ? { signal: options.signal } : {}),
        headers: { accept: 'application/json', ...options.headers },
      });
      const raw = await readBody(response.body, MAX_JSON_BYTES);
      let body: unknown = null;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          throw new AppError('PLATFORM_API_ERROR', 'The platform returned an unreadable response.');
        }
      }
      return { status: response.statusCode, body };
    },

    async headContentLength(url, options = {}) {
      try {
        const response = await safeRequest(url, {
          allowedHost,
          guard,
          method: 'HEAD',
          timeoutMs: 10_000,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        discardBody(response.body);
        if (response.statusCode >= 400) return null;
        const length = Number(response.headers['content-length']);
        return Number.isFinite(length) && length > 0 ? length : null;
      } catch {
        return null;
      }
    },
  };
}
