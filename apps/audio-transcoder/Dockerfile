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

# Typecheck. BLOCKING on purpose: `apps/**` is excluded from `pnpm typecheck`
# (tsconfig.base.json) and the CI quality gate runs only lint + vitest, so this
# is the ONLY typecheck any of these three apps gets. The emitted dist is
# discarded — the runtime CMD is `node --import tsx src/index.ts` and the
# workspace packages export raw `src/*.ts` — so this step is a pure typecheck
# and failing it costs nothing but a red build.
# It used to end in `|| true`, which made it a no-op: a TS2322 in
# apps/api/src/routes/e2e.ts rode green all the way to prod (2026-09-11).
# 8 GB heap: tsc OOMs on the default Node heap on a GitHub runner
# (exit 134, "Ineffective mark-compacts near heap limit"). That was
# happening under the old `|| true` too — the swallow hid a step that
# had never once completed. Mirrors apps/web/Dockerfile, which hit the
# same wall and sized it the same way (ubuntu-latest has 16 GB).
RUN NODE_OPTIONS="--max-old-space-size=8192" pnpm --filter audio-transcoder... build

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
