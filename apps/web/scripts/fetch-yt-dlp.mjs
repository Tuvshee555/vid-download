// Downloads the official standalone Linux yt-dlp into apps/web/bin at build time (Vercel only),
// verified against the SHA-256 sums published with the same release. Redeploy to pick up a
// newer yt-dlp when a site changes. Set YTDLP_VERSION (e.g. 2026.10.26) to pin one.
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.VERCEL !== '1' && process.env.FETCH_YTDLP !== '1') {
  console.log('[fetch-yt-dlp] skipped (not a Vercel build). Locally, yt-dlp from PATH or YTDLP_PATH is used.');
  process.exit(0);
}

const version = process.env.YTDLP_VERSION?.trim() || 'latest';
const base =
  version === 'latest'
    ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'
    : `https://github.com/yt-dlp/yt-dlp/releases/download/${encodeURIComponent(version)}`;

async function get(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`GET ${url} → HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const [binary, sums] = await Promise.all([get(`${base}/yt-dlp_linux`), get(`${base}/SHA2-256SUMS`)]);
const expected = sums
  .toString('utf8')
  .split('\n')
  .map((line) => line.trim().split(/\s+/))
  .find(([, name]) => name === 'yt-dlp_linux')?.[0];
const actual = createHash('sha256').update(binary).digest('hex');
if (!expected || expected.toLowerCase() !== actual) {
  throw new Error(`[fetch-yt-dlp] checksum mismatch for yt-dlp_linux (expected ${expected}, got ${actual})`);
}

const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'yt-dlp');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, binary);
chmodSync(target, 0o755);
console.log(`[fetch-yt-dlp] ${version} yt-dlp_linux (${(binary.length / 1e6).toFixed(1)} MB, sha256 ${actual.slice(0, 12)}…) → ${target}`);
