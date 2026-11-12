import type { FastifyError, FastifyInstance } from 'fastify';
import { AppError, isAppError, toApiErrorBody } from '@vd/shared';

/** Fastify's own error codes that map to a specific, user-meaningful AppError. */
function fromFastifyError(error: FastifyError): AppError | null {
  switch (error.code) {
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return new AppError('FILE_TOO_LARGE', 'The request was too large.');
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
    case 'FST_ERR_CTP_INVALID_CONTENT_LENGTH':
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return new AppError('VALIDATION_ERROR', 'The request body must be valid JSON.');
    case 'FST_ERR_ROUTE_METHOD_NOT_SUPPORTED':
      return new AppError('NOT_FOUND', 'That route does not exist.', { status: 405 });
    default:
      return null;
  }
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send(toApiErrorBody(new AppError('NOT_FOUND', 'That route does not exist.')));
    request.log.debug({ url: request.routeOptions.url }, 'route not found');
  });

  app.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    const known = isAppError(error) ? error : fromFastifyError(error);
    if (known) {
      if (known.status >= 500) request.log.error({ err: error }, 'request failed');
      else request.log.info({ code: known.code, status: known.status }, 'request rejected');
      return reply.status(known.status).send(toApiErrorBody(known));
    }
    // Anything else is a bug or an infrastructure failure: log everything, tell the client nothing.
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send(toApiErrorBody(new AppError('INTERNAL')));
  });
}
