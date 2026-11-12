# MediaDock

A private, self-hosted media converter. Paste a link, see what you are *permitted* to download, get an
**MP4** or **MP3**. Built for one person (you): password-protected, no accounts, no ads, no public users.

```
Browser ──► Next.js (Vercel) ──► API (Fastify) ──► Redis / BullMQ ──► Worker (FFmpeg) ──► R2 / S3
 same-origin  httpOnly session     validate, auth,    job queue         convert, validate     expiring
 proxy (BFF)  cookie → Bearer      signed links                         temp files cleaned    files
```

## Read this first: what it can and cannot do

MediaDock is **not** a "paste any link and rip it" site, and it is built so that it can't quietly turn into one.
It only uses routes the platforms themselves permit — official APIs, and files you already have.

| Source | What works | What does **not** | Why |
|---|---|---|---|
| **YouTube** | Link recognised; title / channel / thumbnail shown (official oEmbed, plus the Data API if you add a key). | **Downloading.** The UI says so and explains the permitted alternatives. | YouTube has no download API and its Terms of Service only allow downloads through YouTube's own features. |
| **Instagram** | Download + convert **your own** posts/reels from the professional account you connect (official Instagram API). | Anyone else's media; photos and carousels; stories; `/share/` links. | Instagram exposes media files only to the account owner's token. |
| **Facebook** | Download + convert **your own** videos from a Page/account you connect (Graph API). | Videos you don't own; `fb.watch` / `/share/` short links (paste the full `facebook.com/…/videos/…` URL). | Facebook returns a video's file URL (`source`) only to a token allowed to read that video. |
| **A file you own** | Upload any audio/video you already have (e.g. a YouTube Studio / Google Takeout export, a phone video) → MP4 or MP3. | Files over `MAX_INPUT_MB`; non-media files; playlists. | — |

Nothing is faked: the UI renders only the options the API actually returned, and an unavailable link shows the
reason plus concrete next steps. There are no workarounds for DRM, logins, paywalls, cookies, rate limits or
copyright — and there is no code path that downloads from a URL the platform's API did not authorise.

## Implemented

- **Frontend** (Next.js 16 App Router, TypeScript, Tailwind v4, shadcn-style components, Lucide): paste/Paste button, live platform detection, platform strip, loading + progress states, per-code error messages, result card with real download link, "convert a file you own" upload, capability panel. Responsive; verified in a real browser at 1280 px and 390 px.
- **API** (Fastify, TypeScript, REST): private auth, strict URL allowlisting, rate limits, job creation/status, signed expiring download & upload links, JSON error contract.
- **Platform adapters** (`YouTubeAdapter`, `InstagramAdapter`, `FacebookAdapter`) behind one interface: identify → validate → resolve (official metadata + availability) → `getSource` (authorised file URL or a typed refusal).
- **Worker** (BullMQ + FFmpeg): background jobs, `queued → processing → completed | failed` (+ `expired`), progress %, retries with back-off for transient errors only, immediate failure for permanent ones.
- **Processing**: H.264 video and AAC/MP3 audio are **copied, not re-encoded** (original quality, near-instant); only incompatible codecs are transcoded (H.264 CRF 18 / AAC 192k). MP3 bitrate is sized to the source; MP3 sources are copied. Output is re-probed and verified before it is stored.
- **Storage**: local disk (dev) or Cloudflare R2 / S3 (production); presigned expiring links; automatic expiry sweep; temp files always cleaned.
- **Deployment**: Dockerfiles (API, worker + FFmpeg), `render.yaml`, Vercel instructions.

## Architecture

| Path | Role |
|---|---|
| `packages/shared` | Browser-safe contract: types, zod schemas, error catalogue, **URL allowlist + platform detection** (used by both the UI and the API), filename sanitising. |
| `packages/core` | Server building blocks: config, auth tokens, SSRF-guarded HTTP + downloader, storage drivers, queue helpers, **platform adapters**. |
| `apps/api` | HTTP API. Routes in `src/routes`, auth/errors in `src/middleware`, job logic in `src/services`. |
| `apps/worker` | BullMQ consumer: `processors/` (pipeline + retry policy), `services/` (FFmpeg, workspace, cleanup). |
| `apps/web` | Next.js UI + same-origin proxy (BFF) so the session token never reaches browser JavaScript. |

Frontend, API and worker are independently deployable; the API never runs conversions and nothing long-running
runs on Vercel.

**Flow:** paste URL → `detectUrl` (allowlist) → `POST /v1/resolve` → adapter asks the platform's official API what is
permitted → UI shows options → `POST /v1/jobs` (re-validated server-side) → worker re-resolves a fresh authorised URL,
downloads (SSRF-guarded, size/time-capped), probes, converts, stores → UI polls `GET /v1/jobs/:id` → short-lived signed
download link (refreshable until the file expires).

## Quick start (local)

Requirements: **Node ≥ 22.12**, **FFmpeg** (with `ffprobe`) on `PATH`, and **Redis** (≥ 6.2).

```bash
npm install
cp .env.example .env                 # then edit — see below
docker compose up -d redis           # or any Redis; BullMQ needs maxmemory-policy noeviction
npm run hash-password                # paste the output line into .env (ACCESS_PASSWORD_HASH=…)
npm run dev                          # api :4000 + worker + web :3000
```

Minimum `.env` for local dev: `ACCESS_PASSWORD` (or `ACCESS_PASSWORD_HASH`) and `REDIS_URL`. Everything else has a
working default (local-disk storage, no platform tokens → Instagram/Facebook show "not connected").
The web app reads `API_BASE_URL` (default `http://localhost:4000`; see `apps/web/.env.example`).

Open <http://localhost:3000>, sign in, and try **Convert a file you own** first — it works with no platform setup.

## Connecting platforms (optional)

These steps follow Meta's and Google's documented flows as of writing; their consoles change, so treat them as a
map, not a script. All tokens are server-side environment variables — they never reach the browser.

- **Instagram** — Meta developer app → add *Instagram API with Instagram Login* → add your Instagram **Business/Creator**
  account as a tester → generate an access token with `instagram_business_basic`. Set `INSTAGRAM_ACCESS_TOKEN`.
  Tokens last ~60 days: refresh with `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=…`
  before they expire (an expired token shows a clear "renew the token" message). Only that account's own posts match.
- **Facebook** — a **Page access token** for a Page you manage with `pages_show_list` and `pages_read_engagement`
  (derive it from a long-lived user token via `GET /me/accounts`). Set `FACEBOOK_ACCESS_TOKEN`. Apps in development
  mode work for Pages you administer; serving other people's Pages would need Meta app review (out of scope here).
- **YouTube** — optional `YOUTUBE_API_KEY` (YouTube Data API v3) for richer metadata. It never enables downloads.

## Configuration

Every variable is documented in [`.env.example`](.env.example) and validated at boot (bad values fail fast with a
readable message). Key ones:

| Variable | Notes |
|---|---|
| `ACCESS_PASSWORD_HASH` / `ACCESS_PASSWORD` | Hash (from `npm run hash-password`) in production; plain only for local dev. |
| `SESSION_SECRET` | ≥ 32 random chars. **Required in production.** Signs sessions and links. |
| `REDIS_URL` | `rediss://` for TLS. Policy must be `noeviction`. |
| `STORAGE_DRIVER` | `local` (dev / single machine) or `s3` (required when API and worker are separate services). |
| `WEB_ORIGIN`, `API_PUBLIC_URL`, `TRUST_PROXY` | CORS origin(s), the API's public URL, and `true` behind a proxy. |
| `MAX_INPUT_MB`, `MAX_DURATION_MINUTES`, `FILE_TTL_MINUTES`, … | Limits and retention. |

## Security model

- **Private access**: one password (scrypt-hashed), HMAC-signed expiring session; the web app keeps it in an
  `httpOnly`, `SameSite=Lax`, `Secure` cookie and the proxy turns it into a Bearer header. Per-IP rate limit on login
  **plus** a global failed-attempt brake (the app has exactly one user).
- **URL allowlist**: only exact YouTube/Instagram/Facebook hostnames; rejects credentials, custom ports, IP literals
  (decimal/hex/octal forms included), `localhost`/`.local`/`.internal`, non-http(s) schemes, short links. The URL used
  everywhere after validation is **rebuilt from the parsed media ID**, never the raw input.
- **SSRF**: every outbound request goes through one client — https only, host allowlist (re-checked on each redirect),
  and a connection-time DNS guard that refuses private, loopback, link-local, metadata (`169.254.169.254`), CGNAT,
  IPv4-mapped IPv6 and other non-public addresses (so DNS rebinding can't bypass it). FFmpeg runs with
  `-protocol_whitelist file,pipe`, so a crafted playlist inside a file can't make it open network connections.
- **No open proxy**: downloads are only possible through an HMAC-signed, expiring, purpose-bound link to a key inside the
  app's own `outputs/` area (or an R2 presigned URL). The web proxy has a strict method+path allowlist and never forwards `files/*`.
- **Files**: size/duration/time limits at every stage; format allowlist after `ffprobe`; private temp dirs, always
  removed; expiry sweep + R2 lifecycle backstop; `Content-Disposition: attachment`, `nosniff`, `no-store`.
- **Secrets**: environment only; logs redact credentials and scrub signed tokens from URLs; error responses never include
  internals or platform messages.

## Deployment

Recommended: **web → Vercel**, **API + worker → Render (or Railway)**, **Redis → managed**, **files → Cloudflare R2**.

### 1. Cloudflare R2
1. Create a bucket (e.g. `mediadock`). Create an **R2 API token** with *Object Read & Write* for that bucket.
2. Env: `S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, `S3_REGION=auto`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `STORAGE_DRIVER=s3`.
3. **CORS** (needed for browser uploads), bucket → Settings → CORS policy:
   ```json
   [{ "AllowedOrigins": ["https://YOUR-WEB-DOMAIN"], "AllowedMethods": ["PUT", "GET", "HEAD"], "AllowedHeaders": ["*"], "MaxAgeSeconds": 3600 }]
   ```
4. **Lifecycle** safety net: add a rule deleting objects older than 1 day (the worker already deletes after `FILE_TTL_MINUTES`).
   Presigned URLs must use the S3 endpoint above (custom domains don't support them).

### 2. Redis
Any managed Redis with **`maxmemory-policy noeviction`**: Render Key Value (in `render.yaml`), Railway Redis, Upstash (use the `rediss://` TCP URL; watch its command quota — BullMQ polls), etc.

### 3. API + worker on Render
`render.yaml` defines both services and a Key Value instance. Create a Blueprint from this repo, then fill the prompted secrets
(`ACCESS_PASSWORD_HASH`, `WEB_ORIGIN`, `API_PUBLIC_URL`, the R2 values, optional platform tokens). `SESSION_SECRET` is generated.
Both images build from the repo root (`apps/api/Dockerfile`, `apps/worker/Dockerfile`; the worker image installs FFmpeg).
Give the worker enough ephemeral disk for `MAX_INPUT_MB + MAX_OUTPUT_MB` per concurrent job. **Railway**: create the same two services
from those Dockerfiles (root directory = repo root) plus a Redis plugin and set the same variables.
Both services need `REDIS_URL`, the `S3_*` values and any platform tokens; only the API needs `ACCESS_PASSWORD_HASH`, `SESSION_SECRET`, `WEB_ORIGIN` and `API_PUBLIC_URL`.

### 4. Web on Vercel
Import the repo → **Root Directory `apps/web`** (leave "Include source files outside of the Root Directory" on — the app imports `packages/shared`).
Set one variable: `API_BASE_URL=https://<your-api-host>`. Then set the API's `WEB_ORIGIN` to the Vercel URL / custom domain.

### Operations
- Health: `GET /health` (liveness), `GET /health/ready` (Redis). Logs are JSON (pino) with secrets redacted.
- Scale conversions by raising `WORKER_CONCURRENCY` or running more worker instances (BullMQ coordinates them).
- Rotate access: change `ACCESS_PASSWORD_HASH` and `SESSION_SECRET` (the latter signs everyone out).

## Testing

```bash
npm run typecheck && npm run lint && npm test && npm run build     # the full gate (= npm run check)

# Opt-in integration suites (need external services; they skip themselves otherwise):
E2E_REDIS_URL=redis://127.0.0.1:6379/15 npm run test:e2e           # API + Redis/BullMQ + worker + FFmpeg over real HTTP (flushes DB 15!)
S3_TEST_ENDPOINT=http://127.0.0.1:9000 S3_TEST_ACCESS_KEY=… S3_TEST_SECRET_KEY=… npm test -w @vd/core   # S3Storage against a real S3 server
```

Worker tests need `ffmpeg`/`ffprobe` on `PATH` (with libx264, libvpx-vp9, libopus, libmp3lame); fixtures are generated on the fly.

**Last run (Windows 11, Node 22.18, FFmpeg 8.1, Redis 8.10):**

| Suite | Tests |
|---|---|
| `@vd/shared` — URL detection (YouTube/Instagram/Facebook), invalid/unsupported/private URL rejection, schemas, errors | 106 |
| `@vd/core` — SSRF guard, tokens/passwords, config, storage, adapters (faked platform APIs), queue helpers | 140 (+4 S3) |
| `@vd/api` — auth, rate limits, validation, resolve, job creation/status, download & upload authorization | 78 |
| `@vd/worker` — planners, real FFmpeg conversions, malicious inputs, pipeline, retry policy, cleanup (+7 e2e) | 49 |
| `@vd/web` — flow reducer, polling, URL form, options/notice/result UI, BFF proxy allowlist | 96 |
| **Total** | **469 passing** (+ 7 e2e on Redis, + 4 on a real S3 server) |

Also run by hand: a 20-check **real-browser** pass (Chromium: sign-in, cookie flags, YouTube limitation, upload → MP3 → download → `ffprobe`
verification, tamper/expiry checks, mobile overflow, sign-out) against the *built* apps, and the production Docker install flow
simulated in an empty directory.

**Not verified** (be aware): real Instagram/Facebook tokens (adapters are tested against faked responses shaped like the documented
Graph API — confirm on first use); Cloudflare R2 itself (the S3 driver passed against a different S3-compatible server — R2-specific
CORS/presign behaviour is unconfirmed); `docker build` and `render.yaml` (not run on the dev machine); an actual Vercel deploy;
FFmpeg 5.1 as shipped in the Debian image (tests ran on 8.1).

## Known limitations

- Instagram/Facebook only for media **you own**; YouTube downloads unsupported (by design — see top).
- Instagram access tokens need refreshing every ~60 days (manual today).
- One shared password (no per-user accounts, by design). Login throttling is per process (run one API instance, or keep the limits in mind).
- Carousels, photos, stories, playlists, live streams are not handled.
- Output is MP4 (H.264/AAC) and MP3 only.
- Local storage between *separate* machines doesn't work; use R2/S3 for split deployments.

## License

Private project — no license granted.
