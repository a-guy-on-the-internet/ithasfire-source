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
COPY scripts/bundle-service.mjs ./scripts/

# Generate Prisma Client (into node_modules/.prisma/client).
RUN pnpm -C packages/db run generate

# Typecheck. BLOCKING on purpose: `apps/**` is excluded from `pnpm typecheck`
# (tsconfig.base.json) and the CI quality gate runs only lint + vitest, so this
# is the ONLY typecheck any of these three apps gets. tsc's emitted dist is
# discarded (the image runs the esbuild bundle below), so this step is a pure
# typecheck and failing it costs nothing but a red build. It also builds the
# workspace dependencies that ship compiled output (@th/ui-email's dist/),
# which the bundle step reads.
# It used to end in `|| true`, which made it a no-op: a TS2322 in
# apps/api/src/routes/e2e.ts rode green all the way to prod (2026-09-11).
# 8 GB heap: tsc OOMs on the default Node heap on a GitHub runner
# (exit 134, "Ineffective mark-compacts near heap limit"). That was
# happening under the old `|| true` too — the swallow hid a step that
# had never once completed. Mirrors apps/web/Dockerfile, which hit the
# same wall and sized it the same way (ubuntu-latest has 16 GB).
RUN NODE_OPTIONS="--max-old-space-size=8192" pnpm --filter api... build

# Bundle the app into plain JS (scripts/bundle-service.mjs explains the
# shape). The image used to run `node --import tsx src/index.ts`, transpiling
# the app and every raw-TS workspace package at boot; on a 1 GiB instance that
# meant a 56 s cold boot and OOM kills (2026-10-15). The script fails the build
# if the entry chunk would load anything outside its allowlist (Sentry, zod,
# isbot, @trpc/server, node builtins) before Sentry.init.
RUN node scripts/bundle-service.mjs apps/api

# Sentry debug IDs: prepend a snippet to every bundle .js that registers the
# file's debug ID, append `//# debugId=` to it, and write the same id into its
# .map (offsets adjusted for the added line). Sentry matches a stack frame to
# its uploaded map by that id, not by file name or release, so frames resolve
# to src/*.ts whatever the chunk hash and in every env the image is promoted
# to. Offline, no token; the id is a hash of the file, so a rebuild of the
# same source gets the same ids. CI uploads the maps from the `sourcemaps`
# stage below (scripts/ci/upload-service-sourcemaps.sh).
RUN pnpm exec sentry-cli sourcemaps inject apps/api/dist/bundle

# Produce the runtime node_modules (the app's prod deps, flat: nodeLinker is
# hoisted). The bundle keeps every third-party package external, so they
# resolve from here.
# NOTE: `pnpm deploy --legacy` RE-RESOLVES dependency ranges from the registry
# at build time — it does NOT honour pnpm-lock.yaml. Runtime-critical deps
# (ajv) are therefore EXACT-pinned in package.json; do not relax them back to
# ranges. (tsx is a devDependency now: dev and the CI seed steps run it from
# a full install, and the image does not.)
RUN pnpm deploy --legacy --filter api --prod /opt/api

# pnpm deploy creates a fresh node_modules, so the generated Prisma Client is
# lost. Copy it from the full workspace into the deploy output.
RUN cp -r /app/node_modules/.prisma /opt/api/node_modules/.prisma

# Swap the TypeScript sources pnpm deploy copied for the bundle, then prove
# every external package the bundle imports resolves from where it will run.
# The image runs dist/index.js (bundle/ flattened into dist/), while local
# `pnpm start` runs dist/bundle/index.js from the unflattened build output.
# Then prune node_modules to what the bundle can reach and check again.
# --prune deletes what the deploy output carries that the bundle never loads
# (the root manifest's expo/react-native, auto-installed optional peers, the
# raw @th/* sources): about 420 of its ~660 MB. The first check runs BEFORE
# the prune on purpose: its nested-copy half compares node_modules/@th/*
# against the top-level packages, and the prune removes @th.
RUN rm -rf /opt/api/src /opt/api/dist \
  && cp -r /app/apps/api/dist/bundle /opt/api/dist \
  && node scripts/bundle-service.mjs apps/api --check-externals /opt/api/dist \
  && node scripts/bundle-service.mjs apps/api --prune /opt/api/dist \
  && node scripts/bundle-service.mjs apps/api --check-externals /opt/api/dist

# Source maps go to Sentry, not into the runtime image. The process runs
# without --enable-source-maps (see CMD), so nothing in it reads a .map; with
# the flag, node kept the parsed map of the app chunk resident once Sentry
# formatted a stack: ~140 MiB of heap, 160-170 MiB RSS (container A/B,
# 2026-10-18).
# /opt/sourcemaps keeps the injected JS + maps and the lockfile-pinned
# sentry-cli binary for the `sourcemaps` stage.
RUN mkdir -p /opt/sourcemaps \
  && cp -r /opt/api/dist /opt/sourcemaps/dist \
  && cp "$(node -p "require('@sentry/cli').getPath()")" /opt/sourcemaps/sentry-cli \
  && find /opt/api/dist -name '*.map' -delete

# Export-only stage: `docker buildx build --target sourcemaps --output
# type=local,dest=<dir>` writes <dir>/dist and <dir>/sentry-cli for the CI
# upload, usually from the install-stage layers the image build just made.
# After a gha cache hit it rebuilds them instead; the bundle is deterministic,
# so the debug IDs match what shipped. Nothing builds it by default: the
# image's target is `runtime`, the last stage.
FROM scratch AS sourcemaps
COPY --from=install /opt/sourcemaps/ /

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
# Heap cap: 700 MiB of old space (V8's heap_size_limit becomes 712 MiB). Set
# as an image default in NODE_OPTIONS, not in CMD: a flag in argv beats
# NODE_OPTIONS, and an env that sizes its instances differently overrides this
# through its api_env (prod does while it runs 2Gi). With no flag V8 sizes the
# heap from the container's memory: 524 MiB at 1Gi, below the 460-627 MiB of
# heapUsed the API measured from idle to loaded with Sentry live, and 1048 MiB
# at 2Gi.
# The cap is HARD, as in apps/jobs/Dockerfile: the API does not turn on
# Sentry's includeLocalVariables (instrument.ts), so no V8 inspector is
# attached to raise the limit near the heap ceiling. 712 + the ~120 MiB node
# keeps outside the heap stays under 1Gi, so a runaway heap ends in a "heap
# out of memory" crash with a stack trace instead of Cloud Run's silent OOM
# kill. (Before 2026-10-18 includeLocalVariables made the cap soft: the
# inspector's near-heap-limit callback raised it about fourfold.)
ENV NODE_OPTIONS="--max-old-space-size=700"
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
# No --enable-source-maps: stack traces in logs show dist/ positions (names
# stay readable, the bundle keeps them), and Sentry resolves them to src/
# server-side through the debug IDs injected above.
CMD ["node", "dist/index.js"]
