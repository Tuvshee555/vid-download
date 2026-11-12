# MediaDock worker (BullMQ consumer + FFmpeg) — build from the REPOSITORY ROOT:
#   docker build -f apps/worker/Dockerfile -t mediadock-worker .

FROM node:22-bookworm-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace=@vd/worker --include-workspace-root --ignore-scripts
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/worker apps/worker
RUN npm run build -w @vd/worker

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
# FFmpeg (includes ffprobe, libx264, libmp3lame, libopus, libvpx). The worker refuses to start without it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace=@vd/worker --ignore-scripts && npm cache clean --force
COPY --from=build /repo/apps/worker/dist apps/worker/dist
USER node
# Conversions use /tmp; give the service enough ephemeral disk for MAX_INPUT_MB + MAX_OUTPUT_MB per concurrent job.
CMD ["node", "apps/worker/dist/index.js"]
