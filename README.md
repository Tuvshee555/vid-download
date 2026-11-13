# MediaDock

A private, password-protected video downloader in the style of SaveFrom: paste a **YouTube, Instagram,
Facebook or TikTok** link, pick a quality, get an **MP4** (H.264/AAC — plays everywhere) or **MP3**.
For personal use only: one password, no accounts, no ads.

Live deployment: **https://mediadock.vercel.app** (password in your notes — it is not in this repo).

## What works where

| Platform | On Vercel (cloud) | Running at home | Notes |
|---|---|---|---|
| **Instagram** | ✅ | ✅ | Public reels and video posts. Private accounts, stories and photo posts aren't supported. |
| **Facebook** | ✅ | ✅ | Public videos, reels, `fb.watch` and share links. Facebook often serves VP9, which is re-encoded to H.264 (slower: ~1–2 min for a 1-min 1080p clip on Vercel). |
| **TikTok** | ✅ | ✅ | Videos incl. `vm.tiktok.com` / `vt.tiktok.com` / `tiktok.com/t/` share links. H.264 qualities are offered so nothing has to be re-encoded. |
| **YouTube** | ✅ via your home PC helper | ✅ | YouTube blocks every cloud/datacenter server ("Sign in to confirm you're not a bot"), so the live site hands YouTube links to a helper on your own PC. Works whenever that PC is on. See [YouTube on the live site](#youtube-on-the-live-site). |

Quality options come from what the platform actually offers (e.g. *MP4 1080p / 720p / 480p / 360p / MP3*);
sizes are the platform's own estimates, never made up. Finished files are deleted automatically after
`FILE_TTL_MINUTES` (default 60).

## How it works

```
Browser ──► Next.js app ──► yt-dlp (metadata, download) ──► FFmpeg (merge / remux / convert) ──► file link
```

- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** reads the link and downloads the best streams for the chosen quality,
  preferring H.264 + AAC so the MP4 is just remuxed (original quality, seconds instead of minutes).
- **FFmpeg** merges video + audio, re-encodes only what isn't H.264/AAC, and extracts MP3 at a bitrate sized to the
  source. Every output is re-inspected before it is offered.
- The pipeline (`packages/core/src/media`) is shared by both deployment modes:

| Mode | Where | How a conversion runs | Use it for |
|---|---|---|---|
| **Standalone** (`MEDIADOCK_MODE=standalone`) | One Next.js app — Vercel, or `npm run dev` at home | A streaming `/api/convert` request downloads + converts and sends live progress; the file goes to Vercel Blob (or a local temp folder) | The live site; easiest setup |
| **Self-hosted** (`MEDIADOCK_MODE=proxy`) | Web + Fastify API + BullMQ worker + Redis + R2/S3 (Docker / Render) | Background jobs with retries, polling, signed links; also "convert a file you own" uploads | Long videos, uploads, heavier use |

| Path | Role |
|---|---|
| `apps/web` | Next.js UI. In standalone mode it also hosts the API routes (`lib/server/*`, `app/api/convert`). |
| `apps/api`, `apps/worker` | Self-hosted mode: REST API and the BullMQ/FFmpeg worker. |
| `packages/shared` | Browser-safe contract: URL allowlist + platform detection, types, schemas, error catalogue. |
| `packages/core` | yt-dlp + FFmpeg pipeline, platform adapters, config, auth tokens, storage, queue. |

## Run it at home (YouTube works)

Needs **Node ≥ 22.12**, **FFmpeg** and **yt-dlp** on your PATH (or set `YTDLP_PATH`).

```bash
npm install
cp apps/web/.env.example apps/web/.env.local   # set ACCESS_PASSWORD
npm run build -w @vd/web && npm run start -w @vd/web    # or: npm run dev:web
```

Open <http://localhost:3000>. To reach it from your phone while away, put a tunnel in front of it
(e.g. `ngrok http 3000` or Cloudflare Tunnel) — the site stays password-protected.

Quick check of any links from the command line (same pipeline as the site):

```bash
npm run try -- "https://www.tiktok.com/@realmadrid/video/7707305867162570017" "https://youtu.be/…"
```

## Deploy to Vercel (standalone)

1. Import the repo into Vercel. **Root Directory: `apps/web`** (leave "include files outside the root directory" on).
2. Storage → create a **Blob** store and connect it to the project (adds `BLOB_READ_WRITE_TOKEN`).
3. Environment variables:
   - `MEDIADOCK_MODE=standalone`
   - `ACCESS_PASSWORD_HASH` — from `npm run hash-password` (or `ACCESS_PASSWORD` for a quick test)
   - `SESSION_SECRET` — 32+ random characters (`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`)
4. Deploy. The build downloads the official Linux yt-dlp and verifies its SHA-256 (`apps/web/scripts/fetch-yt-dlp.mjs`);
   FFmpeg comes from `ffmpeg-static`. **Redeploy every few weeks** (or when a site stops working) to pick up a newer yt-dlp.

Limits on Vercel (Hobby, all overridable via env): 300 s per conversion, input ≤ 400 MB, videos ≤ 30 min.
Blob on Hobby includes limited free storage/transfer per month; files are deleted after an hour, so storage stays tiny.

### YouTube on the live site

YouTube refuses requests from cloud servers (tested from Vercel with every yt-dlp client: all blocked). So for YouTube
the live site uses a **home helper**: the same app running on your PC, reached through a permanent ngrok address.

```
phone/laptop ─► mediadock.vercel.app ──(YouTube link + shared secret)──► your PC (home internet) ─► YouTube
                         ▲                                                   │ yt-dlp + FFmpeg
                         └──────────── live progress ◄────────────────────── ┘ finished file ─► Vercel Blob ─► download link
```

- Instagram, Facebook and TikTok never touch your PC. Only YouTube does, and only while the PC is on — otherwise the
  site says the helper is offline.
- The helper starts hidden when you sign in to Windows (`Startup\MediaDock YouTube helper.vbs`; delete it to stop).
  Manual start: `npm run youtube-helper`. Logs: `%LOCALAPPDATA%\MediaDock\helper.log`.
- It updates yt-dlp on every start, runs the app on port 3010, opens the tunnel and restarts both if they stop.
- Settings (secrets, kept outside the repo): `%LOCALAPPDATA%\MediaDock\helper.env` — `RELAY_DOMAIN`, `RELAY_SECRET`,
  `ACCESS_PASSWORD_HASH`, `SESSION_SECRET`, `BLOB_READ_WRITE_TOKEN`. The Vercel project has the matching
  `RELAY_URL`, `RELAY_SECRET` and `RELAY_PLATFORMS=youtube`. Requests without the secret are refused.

Alternative without a PC: put cookies from a **spare** Google account in `YTDLP_COOKIES` (Netscape cookies.txt contents)
and remove `RELAY_URL`. Google may flag accounts used this way, cookies expire, and YouTube may still block — the helper is
more reliable.

## Self-hosted mode (API + worker)

For long videos (no 300 s limit), uploads ("convert a file you own") and background processing: run
`apps/api` + `apps/worker` with Redis and Cloudflare R2. `render.yaml` defines both services and Redis; both
Dockerfiles install FFmpeg/yt-dlp (checksum-verified). Point the web app at it with `MEDIADOCK_MODE=proxy` and
`API_BASE_URL`. Every variable is documented in [`.env.example`](.env.example).

R2 checklist: create a bucket + R2 API token, set `STORAGE_DRIVER=s3` and the `S3_*` values, add a CORS rule allowing
`PUT`/`GET` from your web origin (browser uploads), and a lifecycle rule deleting objects after a day as a backstop.

## Security

- **Private**: one password (scrypt hash), HMAC-signed expiring session in an `httpOnly`, `SameSite=Lax`, `Secure` cookie.
- **Strict link allowlist**: only exact YouTube/Instagram/Facebook/TikTok hostnames; credentials, ports, IP literals
  (incl. decimal/hex/octal), `localhost`/`.local`/`.internal` and non-http(s) schemes are rejected. The URL handed to
  yt-dlp is **rebuilt from pattern-checked IDs/codes**, never the raw input — so it can't be pointed at anything else.
- **Hardened tooling**: yt-dlp runs with `--ignore-config`, an argument array (no shell), the URL after `--`, size and time
  limits; its output file must be inside the job's private temp folder. FFmpeg runs with `-protocol_whitelist file,pipe`.
  The yt-dlp binary is verified against its published SHA-256.
- **No open proxy**: downloads are only reachable through unguessable, expiring links (Vercel Blob path with a random
  UUID, or HMAC-signed links in self-hosted mode); temp files are always removed; finished files expire.
- **Secrets** live only in environment variables; error messages never include raw tool output.

## Testing

```bash
npm run typecheck && npm run lint && npm test && npm run build      # full gate (= npm run check)
E2E_REDIS_URL=redis://127.0.0.1:6379/15 npm run test:e2e            # self-hosted stack over real HTTP + Redis (flushes DB 15)
npm run try -- <links…>                                             # real downloads through the pipeline
```

Latest results (Windows 11, Node 22.18, FFmpeg 8.1, yt-dlp 2026.10.26):

| Suite | Tests |
|---|---|
| `@vd/shared` — URL detection for all 4 platforms (incl. short/share links), SSRF-style rejection, schemas | 114 |
| `@vd/core` — yt-dlp error mapping & quality ladder, FFmpeg planning/conversions with real FFmpeg, ffprobe-free inspection, auth, config, storage | 112 (+4 S3) |
| `@vd/api` — auth, rate limits, validation, resolve, jobs, download/upload authorization | 80 |
| `@vd/worker` — pipeline (links + uploads), retry policy, cleanup | 26 (+7 Redis e2e) |
| `@vd/web` — flow (job polling and streaming modes), UI components, BFF proxy | 99 |
| **Total** | **431 passing**, plus 7 Redis end-to-end and 4 real-S3 integration tests |

Real-world checks with football videos, through the actual UI in a real browser:
- **Local** (home connection): YouTube 1080p, Instagram 720p, Facebook 1080p, TikTok 576p MP4 and TikTok MP3 — all passed.
- **Live on Vercel**: YouTube 1080p (through the home helper, 78 s), Instagram, Facebook, TikTok MP4 + MP3 — all passed.
  With the helper stopped, YouTube shows the "helper offline" explanation while the other platforms keep working.

## Legal

For personal use. Only download videos you have the right to save; respect creators' copyright and each
platform's terms (YouTube's terms, for example, restrict downloading outside its own features). MediaDock does not
remove DRM or bypass logins or paywalls — private, members-only and DRM-protected content can't be downloaded.

## Known limitations

- YouTube on the live site needs your PC on (see above). Platforms change often; when something breaks, a newer yt-dlp usually fixes it — redeploy (and restart the helper).
- Standalone mode: 300 s per conversion on Vercel, so very long videos need the self-hosted mode or home use.
- Photos, carousels (first video only), stories, live streams and playlists aren't supported.
