# MediaDock API — build from the REPOSITORY ROOT:
#   docker build -f apps/api/Dockerfile -t mediadock-api .
#
# Stage 1 compiles (tsup bundles the workspace packages into one file).
# Stage 2 installs only the API's production dependencies, plus yt-dlp (link details).

FROM node:22-bookworm-slim AS build
WORKDIR /repo
# Every workspace manifest is needed so npm can validate the lockfile, even though only the API is built.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace=@vd/api --include-workspace-root --ignore-scripts
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/api apps/api
RUN npm run build -w @vd/api

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp (official standalone build) reads link details; Node in this image is its JavaScript
# runtime for YouTube. Verified against the release's published SHA-256 sums.
# Rebuild to pick up a newer yt-dlp when a site changes; pin with --build-arg YTDLP_VERSION=2026.10.26.
ARG YTDLP_VERSION=latest
RUN set -eu; \
    if [ "$YTDLP_VERSION" = "latest" ]; then base=https://github.com/yt-dlp/yt-dlp/releases/latest/download; \
    else base="https://github.com/yt-dlp/yt-dlp/releases/download/$YTDLP_VERSION"; fi; \
    curl -fsSL -o /usr/local/bin/yt-dlp "$base/yt-dlp_linux"; \
    curl -fsSL "$base/SHA2-256SUMS" | awk '$2 == "yt-dlp_linux" { print $1 "  /usr/local/bin/yt-dlp" }' | sha256sum -c -; \
    chmod 755 /usr/local/bin/yt-dlp; \
    /usr/local/bin/yt-dlp --version

WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace=@vd/api --ignore-scripts && npm cache clean --force
COPY --from=build /repo/apps/api/dist apps/api/dist
USER node
EXPOSE 4000
CMD ["node", "apps/api/dist/index.js"]
