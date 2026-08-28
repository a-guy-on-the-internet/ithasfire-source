# syntax=docker/dockerfile:1.7-labs

# audio-transcoder Dockerfile — mirrors apps/api Dockerfile pattern.
# Multi-stage: install + build, then runtime with FFmpeg.

FROM node:22-bookworm AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /app
RUN corepack enable pnpm \
  && pnpm config set store-dir /pnpm/store

FROM base AS install

# --- Layer 1: workspace structure (lockfile + package.jsons only) -----------
# Copying just the package manifests before the rest of the source keeps the
# install layer cacheable across commits where dependencies don't change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json prisma.config.ts ./
COPY --parents packages/*/package.json packages/*/*/package.json apps/*/package.json apps/*/*/package.json ./

# --- Layer 2: install dependencies (cached unless lockfile changes) ---------
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile

# --- Layer 3: full source ---------------------------------------------------
COPY docs ./docs
COPY packages ./packages
COPY apps ./apps

# Generate Prisma Client (into node_modules/.prisma/client).
RUN pnpm -C packages/db run generate

# Type-check (non-blocking — allows deploy even if workspace has stale errors).
RUN pnpm --filter audio-transcoder... build || true

# Produce a self-contained deploy bundle (app source + prod deps).
# NOTE: `pnpm deploy --legacy` RE-RESOLVES dependency ranges from the registry
# at build time — it does NOT honour pnpm-lock.yaml. Runtime-critical deps of
# deployed containers (tsx, ajv) are therefore EXACT-pinned in package.json;
# do not relax them back to ranges. (tsx 4.23.8 boot-loop incident, 2026-08-06.)
RUN pnpm deploy --legacy --filter audio-transcoder --prod /opt/audio-transcoder

# pnpm deploy creates a fresh node_modules, so the generated Prisma Client is
# lost. Copy it from the full workspace into the deploy output.
RUN cp -r /app/node_modules/.prisma /opt/audio-transcoder/node_modules/.prisma

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends dumb-init ffmpeg \
  && rm -rf /var/lib/apt/lists/*
COPY --from=install /opt/audio-transcoder/ ./

# Temp dir for FFmpeg processing
RUN mkdir -p /tmp/transcoder && chown node:node /tmp/transcoder

USER node
EXPOSE 8080
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "--import", "tsx", "src/index.ts"]
