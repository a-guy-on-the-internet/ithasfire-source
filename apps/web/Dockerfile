# syntax=docker/dockerfile:1.7-labs

FROM node:22-bookworm AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
WORKDIR /app
RUN corepack enable pnpm \
  && pnpm config set store-dir /pnpm/store

FROM base AS install
ARG SKIP_BUILD=0

# --- Layer 1: workspace structure (lockfile + package.jsons only) -----------
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY --parents packages/*/package.json packages/*/*/package.json apps/*/package.json apps/*/*/package.json ./

# --- Layer 2: install dependencies (cached unless lockfile/workspace changes)
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile

# --- Layer 3: full source --------------------------------------------------
COPY docs ./docs
COPY packages ./packages
COPY apps ./apps

# Prisma Client types are generated at build time.
RUN pnpm -C packages/db run generate

# --- Layer 4: build-time variables -----------------------------------------
# Declared here (NOT before install) so that changing a build arg — especially
# NEXT_PUBLIC_BUILD_SHA which changes every commit — only busts the build
# layer, not the expensive install layer above.
# ARG-only (no ENV) because Next.js inlines NEXT_PUBLIC_* into JS bundles at
# build time; they don't need to exist at runtime.
ARG SENTRY_AUTH_TOKEN=""
ARG SENTRY_ORG=""
ARG SENTRY_PROJECT=""
ARG NEXT_PUBLIC_TILESERVER_URL=""
ARG NEXT_PUBLIC_SITE_URL=""
ARG NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=""
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY=""
ARG NEXT_PUBLIC_GEOAPIFY_API_KEY=""
ARG NEXT_PUBLIC_API_BASE_URL=""
ARG NEXT_PUBLIC_SENTRY_DSN=""
ARG NEXT_PUBLIC_SENTRY_ENVIRONMENT=""
# Cookieless analytics. Empty => no analytics script is emitted at all.
ARG NEXT_PUBLIC_PLAUSIBLE_DOMAIN=""
ARG NEXT_PUBLIC_PLAUSIBLE_SRC=""
ARG NEXT_PUBLIC_CF_BEACON_TOKEN=""
ARG NEXT_PUBLIC_BUILD_SHA=""
ARG NEXT_PUBLIC_APP_VERSION=""

# --- Layer 5: build web app (Next) -----------------------------------------
RUN if [ "$SKIP_BUILD" = "1" ]; then echo "SKIP_BUILD=1: skipping web build"; else pnpm --filter web... build; fi

# --- Layer 6: assemble runtime bundle from standalone output ----------------
# In a monorepo, Next.js standalone output preserves the workspace-relative
# path: standalone/apps/web/{server.js,.next/,...}. We copy public/ and
# .next/static beside .next/ so the server can serve them.
RUN cp -a apps/web/public apps/web/.next/standalone/apps/web/public \
 && mkdir -p apps/web/.next/standalone/apps/web/.next \
 && cp -a apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
# 0.0.0.0 so the standalone server binds on all interfaces inside the container
ENV HOSTNAME=0.0.0.0
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends dumb-init \
  && rm -rf /var/lib/apt/lists/*
COPY --from=install /app/apps/web/.next/standalone ./

USER node
EXPOSE 8080
ENV PORT=8080
ENTRYPOINT ["dumb-init", "--"]
# server.js lives at apps/web/server.js inside the standalone bundle
CMD ["node", "apps/web/server.js"]
