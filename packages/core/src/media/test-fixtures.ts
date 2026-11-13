import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Generate tiny real media files with FFmpeg's synthetic sources (no binary fixtures in the repo). */
function ffmpeg(args: string[]): void {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffmpeg fixture failed: ${result.stderr || result.error?.message}`);
}

const VIDEO = (size: string) => ['-f', 'lavfi', '-i', `testsrc=size=${size}:rate=15`];
const AUDIO = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100'];

export interface Fixtures {
  dir: string;
  h264Aac: string;
  h264Opus: string;
  vp9Opus: string;
  oddSizeVp9: string;
  videoOnly: string;
  audioOnlyM4a: string;
  audioMp3: string;
  audioFlac: string;
  notMedia: string;
  png: string;
  playlist(serverUrl: string): Promise<string>;
}

export async function makeFixtures(dir: string): Promise<Fixtures> {
  await mkdir(dir, { recursive: true });
  const f = (name: string) => join(dir, name);

  ffmpeg([...VIDEO('320x240'), ...AUDIO, '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', f('h264-aac.mp4')]);
  ffmpeg([...VIDEO('320x240'), ...AUDIO, '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', f('h264-opus.mkv')]);
  ffmpeg([...VIDEO('320x240'), ...AUDIO, '-t', '2', '-c:v', 'libvpx-vp9', '-b:v', '200k', '-c:a', 'libopus', f('vp9-opus.webm')]);
  ffmpeg([...VIDEO('322x242'), ...AUDIO, '-t', '1', '-c:v', 'libvpx-vp9', '-b:v', '200k', '-c:a', 'libopus', '-vf', 'crop=321:241', f('odd-vp9.webm')]);
  ffmpeg([...VIDEO('320x240'), '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('video-only.mp4')]);
  ffmpeg([...AUDIO, '-t', '2', '-c:a', 'aac', '-b:a', '96k', f('audio-only.m4a')]);
  ffmpeg([...AUDIO, '-t', '2', '-c:a', 'libmp3lame', '-b:a', '128k', f('audio.mp3')]);
  ffmpeg([...AUDIO, '-t', '2', '-c:a', 'flac', f('audio.flac')]);
  ffmpeg([...VIDEO('64x64'), '-frames:v', '1', f('image.png')]);
  await writeFile(f('notmedia.bin'), 'this is plain text, definitely not a media file\n'.repeat(50));

  return {
    dir,
    h264Aac: f('h264-aac.mp4'),
    h264Opus: f('h264-opus.mkv'),
    vp9Opus: f('vp9-opus.webm'),
    oddSizeVp9: f('odd-vp9.webm'),
    videoOnly: f('video-only.mp4'),
    audioOnlyM4a: f('audio-only.m4a'),
    audioMp3: f('audio.mp3'),
    audioFlac: f('audio.flac'),
    notMedia: f('notmedia.bin'),
    png: f('image.png'),
    async playlist(serverUrl: string) {
      // An HLS playlist that tries to make FFmpeg fetch from a URL. It must never be followed.
      const path = f('evil.m3u8');
      await writeFile(path, `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\n${serverUrl}/segment.ts\n#EXT-X-ENDLIST\n`);
      return path;
    },
  };
}
