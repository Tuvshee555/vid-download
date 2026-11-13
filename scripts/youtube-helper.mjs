// MediaDock home helper — makes YouTube work on the cloud site.
//
// YouTube blocks cloud servers, so the cloud deployment forwards YouTube jobs to this PC
// (home internet isn't blocked). This script keeps the helper running:
//   1. keeps yt-dlp fresh (checksum-verified download, then self-update),
//   2. runs MediaDock in standalone mode on port 3010 (finished files go to the same Vercel Blob store),
//   3. exposes it through your permanent ngrok address (RELAY_DOMAIN),
//   4. restarts either process if it stops.
//
// Settings live outside the repo in %LOCALAPPDATA%\MediaDock\helper.env (KEY=VALUE lines):
//   RELAY_SECRET, RELAY_DOMAIN, ACCESS_PASSWORD_HASH, SESSION_SECRET, BLOB_READ_WRITE_TOKEN
// Run:  node scripts/youtube-helper.mjs        (or let Windows start it at sign-in)
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = join(process.env.LOCALAPPDATA ?? join(process.env.HOME ?? '.', '.local', 'share'), 'MediaDock');
const PORT = 3010;
const LOG = join(HOME, 'helper.log');
mkdirSync(HOME, { recursive: true });

function log(message) {
  const line = `${new Date().toISOString()}  ${message}\n`;
  process.stdout.write(line);
  try {
    if (existsSync(LOG) && statSync(LOG).size > 5 * 1024 * 1024) renameSync(LOG, `${LOG}.old`);
    appendFileSync(LOG, line);
  } catch {
    // logging must never take the helper down
  }
}

function loadEnv() {
  const file = join(HOME, 'helper.env');
  if (!existsSync(file)) throw new Error(`Missing ${file}`);
  const env = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const index = line.indexOf('=');
    env[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  for (const key of ['RELAY_SECRET', 'RELAY_DOMAIN', 'SESSION_SECRET', 'BLOB_READ_WRITE_TOKEN']) {
    if (!env[key]) throw new Error(`${key} is missing from ${file}`);
  }
  return env;
}

async function portInUse(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => server.close(() => resolve(false)));
    server.listen(port, '127.0.0.1');
  });
}

async function ensureYtDlp() {
  const exe = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const target = join(HOME, exe);
  if (existsSync(target)) {
    // yt-dlp verifies its own update signatures.
    const update = spawnSync(target, ['-U'], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
    log(`yt-dlp: ${(update.stdout || update.stderr || '').trim().split('\n').pop()}`);
    return target;
  }
  const asset = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp_linux';
  const base = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
  const [binary, sums] = await Promise.all(
    [`${base}/${asset}`, `${base}/SHA2-256SUMS`].map(async (url) => Buffer.from(await (await fetch(url)).arrayBuffer())),
  );
  const expected = sums.toString('utf8').split('\n').map((l) => l.trim().split(/\s+/)).find(([, name]) => name === asset)?.[0];
  const actual = createHash('sha256').update(binary).digest('hex');
  if (!expected || expected.toLowerCase() !== actual) throw new Error(`yt-dlp checksum mismatch (${expected} vs ${actual})`);
  writeFileSync(target, binary, { mode: 0o755 });
  log(`yt-dlp downloaded and verified (${(binary.length / 1e6).toFixed(1)} MB)`);
  return target;
}

function ensureBuild() {
  if (existsSync(join(REPO, 'apps', 'web', '.next', 'BUILD_ID'))) return;
  log('building the web app (first run)…');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['run', 'build', '-w', '@vd/web'], { cwd: REPO, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error('web build failed');
}

/** Run a child process forever, restarting it with back-off when it exits. */
function keepAlive(name, command, args, options) {
  let delay = 2_000;
  const start = () => {
    const startedAt = Date.now();
    const child = spawn(command, args, { ...options, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    log(`${name}: started (pid ${child.pid})`);
    const forward = (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) log(`${name}: ${line.trim().slice(0, 300)}`);
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', (error) => log(`${name}: failed to start — ${error.message}`));
    child.on('exit', (code) => {
      delay = Date.now() - startedAt > 60_000 ? 2_000 : Math.min(delay * 2, 60_000);
      log(`${name}: exited (${code}); restarting in ${delay / 1000}s`);
      setTimeout(start, delay);
    });
  };
  start();
}

try {
  if (await portInUse(PORT)) {
    log(`port ${PORT} is busy — the helper is probably already running. Exiting.`);
    process.exit(0);
  }
  const env = loadEnv();
  const ytdlp = await ensureYtDlp();
  ensureBuild();

  keepAlive('mediadock', process.execPath, [join(REPO, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '--port', String(PORT)], {
    cwd: join(REPO, 'apps', 'web'),
    env: {
      ...process.env,
      ...env,
      NODE_ENV: 'production',
      MEDIADOCK_MODE: 'standalone',
      YTDLP_PATH: ytdlp,
      RELAY_URL: '', // this instance IS the helper: never relay again
      API_BASE_URL: '',
    },
  });
  keepAlive('tunnel', 'ngrok', ['http', String(PORT), `--url=https://${env.RELAY_DOMAIN}`, '--log=stdout', '--log-level=warn'], { env: process.env });
  log(`helper running → https://${env.RELAY_DOMAIN} (logs: ${LOG})`);
} catch (error) {
  log(`helper failed to start: ${error.message}`);
  process.exit(1);
}
