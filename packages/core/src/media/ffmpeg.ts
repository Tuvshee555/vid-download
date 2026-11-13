/**
 * FFmpeg / FFprobe wrapper.
 *
 * Safety properties:
 *  - Binaries are spawned with an argument ARRAY (never a shell) and every input path is
 *    one we generated, so nothing user-controlled is ever interpreted as a command.
 *  - `-protocol_whitelist file,pipe` stops a crafted playlist (m3u8/concat/sdp) inside an
 *    uploaded or downloaded file from making FFmpeg open network connections (an SSRF
 *    vector that bypasses our HTTP guard).
 *  - Container formats are allowlisted after probing; anything else (images, playlists,
 *    exotic demuxers) is refused.
 *  - Every run has a hard timeout and the child is killed on expiry.
 */
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { AppError } from '@vd/shared';

export interface FfmpegPaths {
  ffmpegPath: string;
  /** null where ffprobe isn't available (e.g. serverless): files are then inspected with ffmpeg itself. */
  ffprobePath: string | null;
}

export interface ProbeResult {
  formatName: string;
  durationSeconds: number | null;
  sizeBytes: number | null;
  video: { codec: string; width: number; height: number } | null;
  audio: { codec: string; bitRateKbps: number | null } | null;
  title: string | null;
}

/** ffprobe `format_name` tokens we are willing to demux. */
const ALLOWED_FORMATS = new Set([
  'mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2', 'matroska', 'webm', 'avi', 'flv', 'mpegts', 'mpeg', 'mpegps',
  'mp3', 'wav', 'ogg', 'flac', 'aac', 'asf', 'opus',
]);

const probeSchema = z.object({
  format: z
    .object({
      format_name: z.string().default(''),
      duration: z.string().optional(),
      size: z.string().optional(),
      tags: z.record(z.string(), z.string()).optional(),
    })
    .default({ format_name: '' }),
  streams: z
    .array(
      z.object({
        codec_type: z.string().optional(),
        codec_name: z.string().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        bit_rate: z.string().optional(),
        disposition: z.object({ attached_pic: z.number().optional() }).optional(),
      }),
    )
    .default([]),
});

export interface RunOptions {
  timeoutMs: number;
  /** Called with each line of stdout. */
  onStdoutLine?: (line: string) => void;
  maxCapturedBytes?: number;
  /** Kills the child when aborted (e.g. the browser disconnected). */
  signal?: AbortSignal;
  /** How much stderr to keep for diagnostics. */
  stderrTailBytes?: number;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderrTail: string;
  timedOut: boolean;
  aborted: boolean;
}

/** Spawn a binary with an argument array (never a shell), a hard timeout and optional abort. */
export function runProcess(binary: string, args: string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const cap = options.maxCapturedBytes ?? 2 * 1024 * 1024;
    const tailBytes = options.stderrTailBytes ?? 8192;
    let stdout = '';
    let stderrTail = '';
    let buffered = '';
    let timedOut = false;
    let aborted = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    const onAbort = () => {
      aborted = true;
      child.kill('SIGKILL');
    };
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < cap) stdout += chunk;
      if (options.onStdoutLine) {
        buffered += chunk;
        let newline = buffered.indexOf('\n');
        while (newline !== -1) {
          options.onStdoutLine(buffered.slice(0, newline).trim());
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf('\n');
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-tailBytes);
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (error.code === 'ENOENT') {
        reject(new AppError('INTERNAL', `${binary} is not installed or not on PATH.`, { retryable: false, cause: error }));
      } else {
        reject(new AppError('PROCESSING_FAILED', undefined, { cause: error }));
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (buffered.trim() && options.onStdoutLine) options.onStdoutLine(buffered.trim());
      resolve({ code, stdout, stderrTail, timedOut, aborted });
    });
  });
}

const run = runProcess;

function assertAllowedFormat(formatName: string): void {
  const formats = formatName.split(',').map((name) => name.trim());
  if (!formats.some((name) => ALLOWED_FORMATS.has(name))) {
    throw new AppError('UNSUPPORTED_MEDIA', `This file type (${formatName || 'unknown'}) isn't supported.`);
  }
}

/**
 * Inspect a file with `ffmpeg -i` when ffprobe isn't available. ffmpeg prints the same
 * container/stream summary to stderr; only the fields the planners need are read.
 */
export async function probeWithFfmpeg(path: string, ffmpegPath: string, timeoutMs = 30_000): Promise<ProbeResult> {
  // No output file → ffmpeg exits 1 after printing the input summary. That is expected.
  const result = await run(ffmpegPath, ['-hide_banner', '-nostdin', '-protocol_whitelist', 'file,pipe', '-i', path], {
    timeoutMs,
    stderrTailBytes: 64 * 1024,
  });
  if (result.timedOut) throw new AppError('PROCESSING_FAILED', 'Reading the file took too long.');
  const text = result.stderrTail;
  const input = /Input #0, ([^\s]+), from/.exec(text);
  if (!input?.[1]) throw new AppError('UNSUPPORTED_MEDIA', "This file couldn't be read as audio or video.", { cause: text.slice(-500) });
  const formatName = input[1].replace(/,$/, '');
  assertAllowedFormat(formatName);

  const durationMatch = /Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text);
  const durationSeconds = durationMatch
    ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
    : null;

  let video: ProbeResult['video'] = null;
  let audio: ProbeResult['audio'] = null;
  for (const line of text.split(/\r?\n/)) {
    const stream = /Stream #\d+:\d+.*?: (Video|Audio): ([A-Za-z0-9_]+)(.*)$/.exec(line);
    if (!stream) continue;
    const [, kind, codec = 'unknown', rest = ''] = stream;
    if (kind === 'Video' && !video && !/attached pic/.test(line)) {
      const size = /\b(\d{2,5})x(\d{2,5})\b/.exec(rest);
      video = { codec, width: Number(size?.[1] ?? 0), height: Number(size?.[2] ?? 0) };
    } else if (kind === 'Audio' && !audio) {
      const bitrate = /(\d+) kb\/s/.exec(rest);
      audio = { codec, bitRateKbps: bitrate ? Number(bitrate[1]) : null };
    }
  }

  return {
    formatName,
    durationSeconds: durationSeconds && durationSeconds > 0 ? durationSeconds : null,
    sizeBytes: null,
    video,
    audio,
    title: null,
  };
}

export async function probeFile(path: string, paths: FfmpegPaths, timeoutMs = 30_000): Promise<ProbeResult> {
  if (!paths.ffprobePath) return probeWithFfmpeg(path, paths.ffmpegPath, timeoutMs);
  const result = await run(
    paths.ffprobePath,
    ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-print_format', 'json', '-show_format', '-show_streams', '-i', path],
    { timeoutMs },
  );
  if (result.timedOut) throw new AppError('PROCESSING_FAILED', 'Reading the file took too long.');
  if (result.code !== 0) {
    throw new AppError('UNSUPPORTED_MEDIA', "This file couldn't be read as audio or video.", { cause: result.stderrTail });
  }

  let parsed;
  try {
    parsed = probeSchema.parse(JSON.parse(result.stdout));
  } catch (error) {
    throw new AppError('UNSUPPORTED_MEDIA', "This file couldn't be read as audio or video.", { cause: error });
  }

  assertAllowedFormat(parsed.format.format_name);

  // Cover art in MP3/M4A shows up as a "video" stream flagged attached_pic — it is not a video track.
  const videoStream = parsed.streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audioStream = parsed.streams.find((s) => s.codec_type === 'audio');
  const duration = Number(parsed.format.duration);
  const audioBitRate = Number(audioStream?.bit_rate);

  const tags = parsed.format.tags ?? {};
  const titleTag = Object.entries(tags).find(([key]) => key.toLowerCase() === 'title')?.[1];

  return {
    formatName: parsed.format.format_name,
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
    sizeBytes: Number.isFinite(Number(parsed.format.size)) ? Number(parsed.format.size) : null,
    video: videoStream
      ? { codec: videoStream.codec_name ?? 'unknown', width: videoStream.width ?? 0, height: videoStream.height ?? 0 }
      : null,
    audio: audioStream
      ? {
          codec: audioStream.codec_name ?? 'unknown',
          bitRateKbps: Number.isFinite(audioBitRate) && audioBitRate > 0 ? Math.round(audioBitRate / 1000) : null,
        }
      : null,
    title: titleTag?.trim() ? titleTag.trim() : null,
  };
}

// ───────────────────────── conversion planning (pure) ─────────────────────────

export interface Mp4Plan {
  video: 'copy' | 'encode';
  audio: 'copy' | 'encode' | 'none';
}

/** Audio codecs that can be stream-copied into an MP4 and play everywhere. */
const MP4_COPYABLE_AUDIO = new Set(['aac', 'mp3']);

/**
 * Re-encode only what has to be re-encoded. H.264 video is copied bit-for-bit (original
 * quality, instant); other codecs are converted to H.264 for compatibility. AAC/MP3 audio is
 * copied; anything else becomes AAC.
 */
export function planMp4(probe: ProbeResult): Mp4Plan {
  return {
    video: probe.video?.codec === 'h264' ? 'copy' : 'encode',
    audio: !probe.audio ? 'none' : MP4_COPYABLE_AUDIO.has(probe.audio.codec) ? 'copy' : 'encode',
  };
}

export interface Mp3Plan {
  mode: 'copy' | 'encode';
  bitrateKbps: number | null;
}

const MP3_BITRATES = [128, 160, 192, 224, 256, 320];
const LOSSLESS_AUDIO = /^(flac|alac|wavpack|pcm_.*|ape|tta)$/;

/**
 * MP3 needs roughly 25 % more bitrate than AAC/Vorbis for similar quality, so pick the
 * smallest standard rate that covers that — never padding a 96 kbps source up to 320, never
 * starving a good one. Lossless sources get 320 kbps. MP3 sources are copied untouched.
 */
export function planMp3(probe: ProbeResult): Mp3Plan {
  const codec = probe.audio?.codec ?? '';
  if (codec === 'mp3') return { mode: 'copy', bitrateKbps: null };
  if (LOSSLESS_AUDIO.test(codec)) return { mode: 'encode', bitrateKbps: 320 };
  const source = probe.audio?.bitRateKbps;
  if (!source) return { mode: 'encode', bitrateKbps: 192 };
  const target = MP3_BITRATES.find((rate) => rate >= source * 1.25) ?? 320;
  return { mode: 'encode', bitrateKbps: target };
}

const BASE_ARGS = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-nostats', '-progress', 'pipe:1', '-y'];

export interface EncodeOptions {
  /** x264 speed/size trade-off. "veryfast" keeps serverless conversions well inside time limits. */
  x264Preset?: string;
  /** 18 ≈ visually lossless, 20 is a good default, higher = smaller. */
  crf?: number;
}

export function buildMp4Args(input: string, output: string, plan: Mp4Plan, encode: EncodeOptions = {}): string[] {
  const args = [...BASE_ARGS, '-i', input, '-map', '0:v:0'];
  if (plan.audio !== 'none') args.push('-map', '0:a:0');
  if (plan.video === 'copy') {
    args.push('-c:v', 'copy');
  } else {
    // Even dimensions are required by yuv420p H.264.
    args.push(
      '-c:v', 'libx264',
      '-preset', encode.x264Preset ?? 'veryfast',
      '-crf', String(encode.crf ?? 20),
      '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    );
  }
  if (plan.audio === 'copy') args.push('-c:a', 'copy');
  if (plan.audio === 'encode') args.push('-c:a', 'aac', '-b:a', '192k');
  args.push('-sn', '-dn', '-movflags', '+faststart', '-f', 'mp4', output);
  return args;
}

export function buildMp3Args(input: string, output: string, plan: Mp3Plan, title: string | null): string[] {
  const args = [...BASE_ARGS, '-i', input, '-map', '0:a:0', '-vn', '-sn', '-dn'];
  if (plan.mode === 'copy') {
    args.push('-c:a', 'copy');
  } else {
    args.push('-c:a', 'libmp3lame', '-b:a', `${plan.bitrateKbps ?? 192}k`);
  }
  args.push('-map_metadata', '-1');
  if (title) args.push('-metadata', `title=${title.slice(0, 120)}`);
  args.push('-id3v2_version', '3', '-f', 'mp3', output);
  return args;
}

// ───────────────────────── execution ─────────────────────────

export interface ConvertOptions {
  paths: FfmpegPaths;
  timeoutMs: number;
  /** Fraction 0–1 of the media processed so far (only when the duration is known). */
  onProgress?: (fraction: number) => void;
  durationSeconds: number | null;
  signal?: AbortSignal;
}

export async function runFfmpeg(args: string[], options: ConvertOptions): Promise<void> {
  const total = options.durationSeconds;
  const result = await run(options.paths.ffmpegPath, args, {
    timeoutMs: options.timeoutMs,
    onStdoutLine: (line) => {
      if (!options.onProgress || !total) return;
      const match = /^out_time_(?:us|ms)=(\d+)$/.exec(line);
      if (match?.[1]) options.onProgress(Math.min(1, Number(match[1]) / 1_000_000 / total));
    },
    maxCapturedBytes: 64 * 1024,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (result.aborted) throw new AppError('PROCESSING_FAILED', 'Processing was cancelled.', { retryable: false });
  if (result.timedOut) {
    throw new AppError('PROCESSING_FAILED', 'Processing took too long and was stopped.', { retryable: false });
  }
  if (result.code !== 0) {
    throw new AppError('PROCESSING_FAILED', undefined, { cause: result.stderrTail });
  }
}
