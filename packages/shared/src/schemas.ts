/**
 * Request validation. Every API body passes through one of these before any business
 * logic runs.
 */
import { z } from 'zod';
import { MAX_URL_LENGTH } from './platforms';
import { ALLOWED_UPLOAD_EXTENSIONS, MEDIA_FORMATS } from './types';

export const mediaFormatSchema = z.enum(MEDIA_FORMATS);

export const urlInputSchema = z.string().trim().min(1, 'Paste a link first.').max(MAX_URL_LENGTH, 'That link is too long.');

export const resolveRequestSchema = z.object({
  url: urlInputSchema,
});
export type ResolveRequest = z.infer<typeof resolveRequestSchema>;

export const uploadIdSchema = z.uuid();

export const createJobRequestSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('url'),
    url: urlInputSchema,
    format: mediaFormatSchema,
    /** Maximum video height for MP4 (e.g. 720). Omit for the best available. */
    quality: z.number().int().min(100).max(4320).optional(),
  }),
  z.object({
    source: z.literal('upload'),
    uploadId: uploadIdSchema,
    format: mediaFormatSchema,
    /** Original file name; only used to name the converted file. */
    filename: z.string().trim().max(255).optional(),
  }),
]);
export type CreateJobRequest = z.infer<typeof createJobRequestSchema>;

export const jobIdSchema = z.uuid();

export const uploadTicketRequestSchema = z.object({
  filename: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine(
      (name) => {
        const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined;
        return extension !== undefined && (ALLOWED_UPLOAD_EXTENSIONS as readonly string[]).includes(extension);
      },
      { message: `Unsupported file type. Allowed: ${ALLOWED_UPLOAD_EXTENSIONS.join(', ')}.` },
    ),
  size: z.number().int().positive(),
  contentType: z
    .string()
    .trim()
    .max(127)
    .regex(/^[\w.+-]+\/[\w.+-]+$/, 'Invalid content type.')
    .default('application/octet-stream'),
});
export type UploadTicketRequest = z.infer<typeof uploadTicketRequestSchema>;

export const loginRequestSchema = z.object({
  password: z.string().min(1, 'Enter the access password.').max(256),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;
