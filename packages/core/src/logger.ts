import { pino, type Logger } from 'pino';

export type { Logger };

/** Logger that never prints credentials, even if a caller accidentally logs a config/request object. */
export function createLogger(name: string, level = 'info'): Logger {
  return pino({
    name,
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.authorization',
        '*.password',
        '*.token',
        '*.access_token',
        '*.accessToken',
        '*.secretAccessKey',
        '*.sessionSecret',
        '*.apiKey',
      ],
      censor: '[redacted]',
    },
  });
}

/** A logger that discards everything — handy default for library code and tests. */
export const silentLogger: Logger = pino({ level: 'silent' });
