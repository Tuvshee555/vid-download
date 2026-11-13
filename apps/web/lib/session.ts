/**
 * Server-only session check used by server components. The cookie holds an opaque token
 * issued by the API; the API is the only authority that can say whether it is still valid.
 */
import { cookies } from 'next/headers';
import { apiBaseUrl, SESSION_COOKIE } from '@/lib/bff';
import { serverMode, standaloneSession } from '@/lib/server/standalone';

export type SessionCheck =
  | { status: 'authenticated'; expiresAt: string }
  | { status: 'unauthenticated' }
  | { status: 'unreachable' };

export async function getSession(): Promise<SessionCheck> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return { status: 'unauthenticated' };

  if (serverMode() === 'standalone') {
    const session = standaloneSession(token);
    return session ? { status: 'authenticated', expiresAt: session.expiresAt.toISOString() } : { status: 'unauthenticated' };
  }

  try {
    const response = await fetch(`${apiBaseUrl()}/v1/auth/session`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 || response.status === 403) return { status: 'unauthenticated' };
    if (!response.ok) return { status: 'unreachable' };
    const body = (await response.json()) as { authenticated?: boolean; expiresAt?: string };
    if (body.authenticated !== true) return { status: 'unauthenticated' };
    return { status: 'authenticated', expiresAt: body.expiresAt ?? '' };
  } catch {
    return { status: 'unreachable' };
  }
}
