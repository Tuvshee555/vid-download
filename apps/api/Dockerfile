# MediaDock API — build from the REPOSITORY ROOT:
#   docker build -f apps/api/Dockerfile -t mediadock-api .
#
# Stage 1 compiles (tsup bundles the workspace packages into one file).
# Stage 2 installs only the API's production dependencies and copies the bundle.

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
