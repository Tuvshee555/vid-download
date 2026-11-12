import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '@vd/shared';
import { verifySessionToken } from '@vd/core';

/** Fastify preHandler factory: requires `Authorization: Bearer <session token>`. */
export function requireAuth(secret: string) {
  return async function authHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer ([A-Za-z0-9_\-.]+)$/.exec(header) : null;
    if (!match?.[1]) {
      void reply.header('WWW-Authenticate', 'Bearer');
      throw new AppError('UNAUTHENTICATED');
    }
    const result = verifySessionToken(match[1], secret);
    if (!result.ok) {
      void reply.header('WWW-Authenticate', 'Bearer error="invalid_token"');
      throw new AppError('UNAUTHENTICATED', result.reason === 'expired' ? 'Your session has expired. Please sign in again.' : undefined);
    }
    request.session = { expiresAt: new Date(result.payload.exp * 1000) };
  };
}
