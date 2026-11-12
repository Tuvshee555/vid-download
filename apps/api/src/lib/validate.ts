import type { z } from 'zod';
import { AppError } from '@vd/shared';

/** Validate untrusted input against a zod schema; failures become a 400 with a readable message. */
export function parseInput<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  throw new AppError('VALIDATION_ERROR', `${field}${issue?.message ?? 'Invalid request.'}`);
}
