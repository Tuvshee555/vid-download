/**
 * Real-network smoke test of the download pipeline (the exact code the worker and the
 * Vercel route run): resolve → download → convert, for each link, MP4 and MP3.
 *
 *   npm run try -- https://youtu.be/… https://www.instagram.com/reel/… [--keep]
 *
 * Uses YTDLP_PATH / FFMPEG_PATH / FFPROBE_PATH from the environment (FFPROBE_PATH=none mimics Vercel).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectUrl, formatBytes, type MediaFormat } from '@vd/shared';
import { acquireFromLink, adapterFor, convertInput, createAdapters, loadConfig, pipelineDepsFrom } from '@vd/core';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const urls = args.filter((arg) => !arg.startsWith('--'));
if (urls.length === 0) {
  console.error('usage: npm run try -- <url> [<url> …] [--keep]');
  process.exit(1);
}

const config = loadConfig();
const adapters = createAdapters(config);
const deps = pipelineDepsFrom(config);
let failures = 0;

for (const url of urls) {
  const detection = detectUrl(url);
  if (!detection.ok) {
    console.log(`✗ ${url}\n    ${detection.code}: ${detection.message}`);
    failures += 1;
    continue;
  }
  const started = Date.now();
  const resolved = await adapterFor(adapters, detection.platform).resolve(detection).catch((error: Error) => error);
  if (resolved instanceof Error) {
    console.log(`✗ ${detection.platform} ${url}\n    resolve failed: ${resolved.message}`);
    failures += 1;
    continue;
  }
  if (resolved.availability.status !== 'available') {
    console.log(`✗ ${detection.platform} ${url}\n    unavailable: ${resolved.availability.reason.code} — ${resolved.availability.reason.message}`);
    failures += 1;
    continue;
  }
  const labels = resolved.availability.options.map((o) => `${o.label}${o.sizeBytes ? ` ≈${formatBytes(o.sizeBytes)}` : ''}`);
  console.log(`● ${detection.platform}: "${resolved.metadata?.title ?? '?'}" (${resolved.metadata?.durationSeconds ?? '?'}s) — ${labels.join(', ')}  [${Date.now() - started} ms]`);

  for (const format of ['mp4', 'mp3'] as MediaFormat[]) {
    const dir = await mkdtemp(join(tmpdir(), 'vd-try-'));
    const t0 = Date.now();
    try {
      const quality = format === 'mp4' ? (resolved.availability.options.find((o) => o.format === 'mp4')?.quality ?? null) : null;
      const input = await acquireFromLink(detection, { format, quality }, dir, deps, () => undefined);
      const output = await convertInput(input, format, dir, deps, () => undefined);
      console.log(
        `    ✓ ${format.toUpperCase()} ${output.filename} — ${formatBytes(output.sizeBytes)}, ${output.durationSeconds?.toFixed(1)}s` +
          `${output.resolution ? `, ${output.resolution}` : ''}${output.losslessVideo === false ? ', re-encoded to H.264' : output.losslessVideo ? ', original stream' : ''}  [${Date.now() - t0} ms]` +
          (keep ? `\n      ${output.path}` : ''),
      );
    } catch (error) {
      failures += 1;
      console.log(`    ✗ ${format.toUpperCase()} failed: ${(error as Error).message}`);
    } finally {
      if (!keep) await rm(dir, { recursive: true, force: true });
    }
  }
}
process.exit(failures ? 1 : 0);
