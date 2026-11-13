/**
 * Standalone mode: download + convert in one request and stream progress back.
 *
 * The response is NDJSON — one `JobView` per line (queued → processing … → completed | failed)
 * — so the page shows live progress and finally a download link, without any job queue or
 * shared state between serverless invocations.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NextRequest } from 'next/server';
import { AppError, createJobRequestSchema, detectUrl, type JobProgress, type JobStage, type JobView } from '@vd/shared';
import { acquireFromLink, convertInput } from '@vd/core/media';
import { pipelineDepsFrom } from '@vd/core/runtime';
import { jsonError, readLimitedText, SESSION_COOKIE } from '@/lib/bff';
import { storeOutput, sweepOutputs } from '@/lib/server/output-store';
import { serverMode, standalone, standaloneSession } from '@/lib/server/standalone';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Hobby allows up to 300 s with Fluid compute; long enough for typical videos and reels.
export const maxDuration = 300;

export async function POST(request: NextRequest): Promise<Response> {
  if (serverMode() !== 'standalone') return jsonError('NOT_FOUND', { message: 'That endpoint does not exist.' });
  if (!standaloneSession(request.cookies.get(SESSION_COOKIE)?.value)) return jsonError('UNAUTHENTICATED');

  const text = await readLimitedText(request, 16 * 1024);
  if (text === null) return jsonError('VALIDATION_ERROR', { status: 413, message: 'That request was too large.' });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return jsonError('VALIDATION_ERROR', { message: 'The request body must be valid JSON.' });
  }
  const parsed = createJobRequestSchema.safeParse(body);
  if (!parsed.success || parsed.data.source !== 'url') {
    return jsonError('VALIDATION_ERROR', { message: parsed.success ? 'Only links can be converted here.' : (parsed.error.issues[0]?.message ?? 'Invalid request.') });
  }
  const { url, format } = parsed.data;
  const quality = format === 'mp4' ? (parsed.data.quality ?? null) : null;
  const detection = detectUrl(url);
  if (!detection.ok) return jsonError(detection.code, { message: detection.message });

  const { config } = standalone();
  const id = randomUUID();
  const base = { id, format, createdAt: new Date().toISOString(), attempt: 1, maxAttempts: 1 };
  const encoder = new TextEncoder();
  const abort = new AbortController();
  request.signal.addEventListener('abort', () => abort.abort(), { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (view: JobView) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(view)}\n`));
        } catch {
          open = false;
        }
      };

      let progress: JobProgress = { stage: 'queued', percent: 0 };
      send({ ...base, status: 'queued', progress });
      const report = (stage: JobStage, percent: number) => {
        const rounded = Math.max(0, Math.min(99, Math.round(percent)));
        if (stage === progress.stage && rounded <= progress.percent) return;
        progress = { stage, percent: rounded };
        send({ ...base, status: 'processing', progress });
      };
      // Keep proxies from closing a quiet connection during long steps.
      const heartbeat = setInterval(() => send({ ...base, status: 'processing', progress }), 10_000);

      const dir = await mkdtemp(join(tmpdir(), 'vd-job-'));
      try {
        void sweepOutputs(config.limits.fileTtlMs).catch((error: unknown) => console.warn('[mediadock] sweep failed', error));
        const deps = pipelineDepsFrom(config, abort.signal);
        const input = await acquireFromLink(detection, { format, quality }, dir, deps, report);
        const output = await convertInput(input, format, dir, deps, report);
        report('uploading', 92);
        const stored = await storeOutput(output.path, output.filename, output.mimeType, config.limits.fileTtlMs, config.auth.sessionSecret);
        send({
          ...base,
          status: 'completed',
          progress: { stage: 'done', percent: 100 },
          result: {
            filename: output.filename,
            format: output.format,
            mimeType: output.mimeType,
            sizeBytes: output.sizeBytes,
            durationSeconds: output.durationSeconds,
            resolution: output.resolution,
            losslessVideo: output.losslessVideo,
            expiresAt: stored.expiresAt.toISOString(),
            download: { url: stored.url, expiresAt: stored.expiresAt.toISOString() },
          },
        });
      } catch (error) {
        const appError = error instanceof AppError ? error : new AppError('INTERNAL', undefined, { cause: error });
        if (!(error instanceof AppError) || appError.status >= 500) console.error('[mediadock] convert failed', appError.code, error);
        send({
          ...base,
          status: 'failed',
          progress: { stage: 'done', percent: 0 },
          error: { code: appError.code, message: appError.message, retryable: appError.retryable },
        });
      } finally {
        clearInterval(heartbeat);
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        if (open) {
          open = false;
          try {
            controller.close();
          } catch {
            // already closed by the client
          }
        }
      }
    },
    cancel() {
      abort.abort(); // the browser went away: stop yt-dlp / ffmpeg
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}
