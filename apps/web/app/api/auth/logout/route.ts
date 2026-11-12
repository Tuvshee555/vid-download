import { NextResponse } from 'next/server';
import { clearedCookieOptions, SESSION_COOKIE } from '@/lib/bff';

export const dynamic = 'force-dynamic';

export function POST(): Response {
  const response = NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
  response.cookies.set(SESSION_COOKIE, '', clearedCookieOptions());
  return response;
}
