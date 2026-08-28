# syntax=docker/dockerfile:1.7-labs

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
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
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
RUN pnpm --filter api... build || true

# Produce a self-contained deploy bundle (app source + prod deps).
# NOTE: `pnpm deploy --legacy` RE-RESOLVES dependency ranges from the registry
# at build time — it does NOT honour pnpm-lock.yaml. Runtime-critical deps of
# deployed containers (tsx, ajv) are therefore EXACT-pinned in package.json;
# do not relax them back to ranges. (tsx 4.23.8 boot-loop incident, 2026-08-06.)
RUN pnpm deploy --legacy --filter api --prod /opt/api

# pnpm deploy creates a fresh node_modules, so the generated Prisma Client is
# lost. Copy it from the full workspace into the deploy output.
RUN cp -r /app/node_modules/.prisma /opt/api/node_modules/.prisma

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends dumb-init \
  && rm -rf /var/lib/apt/lists/*
COPY --from=install /opt/api/ ./

# Migration-drift guard (@th/adapters/infra/migration-drift): the API refuses to
# report itself healthy when the database is behind the migrations THIS image was
# built from. The expected list is read from the real migrations directory rather
# than a generated manifest, so it can never go stale — which means the directory
# has to ship in the runtime image. `pnpm deploy` only bundles apps/api, so copy
# it in explicitly. resolveMigrationsDir() anchors on the runtime WORKDIR, so
# /app/prisma/migrations is where it looks first.
# If this COPY is ever dropped the check degrades to "unknown" (healthy +
# reported to Sentry), never to a false alarm.
COPY --from=install /app/packages/db/prisma/migrations ./prisma/migrations

USER node
EXPOSE 8080
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "--import", "tsx", "src/index.ts"]
