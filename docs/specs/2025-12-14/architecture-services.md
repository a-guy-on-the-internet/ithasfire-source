# Architecture Services Overview

This document inventories the primary services, vendors, and runtime layers that Ithas Fire relies on today. Use it as the "source of truth" when specs refer to shared infrastructure (auth, storage, queueing, caching, transports, etc.). Keep it updated whenever we swap vendors or add a platform capability.

## 🔐 Authentication & Identity

| Service | Owner | Purpose | Notes |
| --- | --- | --- | --- |
| Better Auth | Platform → Auth | User authentication, session issuance | Better Auth middleware validates every API call. Session tokens are verified in the Fastify `onRequest` hook; decoded claims feed the tRPC context. |
| Better Auth Organizations | Platform → Auth | Org membership directory + invitations | Drives `OrgRole` assignments (OWNER, ADMIN, EDITOR, FINANCE, SCANNER, VIEWER). Always mirror roles into Postgres for auditing. |

## 💾 Data Plane

| Service | Owner | Purpose | Notes |
| --- | --- | --- | --- |
| Postgres (Neon/Cloud) | Platform → DB | Primary relational store for core tickets, events, orgs, payouts | Accessed via Prisma (`packages/db`). Maintain read replicas for jobs/sitemaps. |
| Redis (Upstash) | Platform → Infra | Ephemeral cache + context store + job locks | Used by ContextResolver, navigation caching, rate limiting, and job orchestration locks. TTL defaults documented per spec (e.g., context = 30d). |
| Cloudflare R2 | Platform → Infra | Object storage for exports, sitemap XML, media backups | Access via S3-compatible SDK. See sitemap specs for layout. |
| Cloudflare Workers/Cache | Platform → Infra | Edge cache + CDN for static assets, sitemap delivery, discovery chips | Align cache headers in transport specs with worker behavior. |

## 🧠 Business Logic & Transports

| Layer | Owner | Purpose | Notes |
| --- | --- | --- | --- |
| `packages/core` use cases | Core eng | Pure application logic (hexagonal architecture) | No direct Prisma/Stripe usage—always via ports. |
| `packages/ports` | Core eng | Port definitions for repos, payments, messaging | Contracts consumed by adapters. |
| `packages/adapters` | Core eng | Prisma repos, Stripe adapter, Redis idempotency, email vendors | Keep side effects here; return DTOs only. |
| `packages/transport/trpc` | Platform → Transport | tRPC routers + Fastify plugins (context, authz, telemetry) | Navigation sitemap transport lives here; depends on context + Better Auth session. |
| Fastify (apps/api) | Platform → API | Host Fastify server that mounts transports + webhooks | Uses helper scripts (`pnpm api:bg`). |

## 💸 Payments & Notifications

| Service | Owner | Purpose | Notes |
| --- | --- | --- | --- |
| Stripe | Payments | Checkout, payouts, refunds | Webhooks handled in `apps/api`; adapters reside in `packages/adapters`. Money math uses bigint cents helpers in `packages/core/src/lib/pricing`. |
| Notification Service (`packages/core` + adapters) | Platform → Messaging | Digest + real-time alerts surfaced in Admin Hub | Specs reference `NotificationDigest` repo; persists alerts so nav tiles never depend on client-local state. |
| Postmark / Resend (email) | Platform → Messaging | Transactional email + UI-email components | Connectors in adapters; templates under `packages/ui-email`. |

## 📱 Client Surfaces

| Surface | Owner | Purpose | Notes |
| --- | --- | --- | --- |
| Next.js (`apps/web`) | Apps-Web | Admin/organizer web app + consumer discovery surface | Uses `@th/transport/trpc` client + NavigationShell component. |
| Expo (`apps/mobile`, `apps/scanner`) | Mobile | Organizer tools (mobile overlay, scanner) | Tamagui design system shared via `@th/ui`. |
| Storybook (`packages/ui`) | Design System | Component showcase + visual regression | Keep NavigationShell + Admin Hub tiles covered. |

## 🛠️ Operations & Jobs

| Service | Owner | Purpose | Notes |
| --- | --- | --- | --- |
| Cloud Run (jobs runtime) + Cloud Scheduler + Pub/Sub | Platform → Infra | Run scheduled/batch tasks (sitemaps, payouts, digests) | Scheduler triggers `/tasks/run`; Pub/Sub push delivers queued jobs; runtime fans out to job handlers. |
| Turborepo + pnpm | Platform → DX | Monorepo orchestration/build caching | All packages TypeScript modules with strict project refs. |
| Vitest | Platform → DX | Test runner for packages | Use helper scripts (`pnpm vitest:bg`). |

## How to Use This Doc

- Specs should reference the relevant service name above instead of inventing new terminology.
- When introducing a new external service, add it here with owner + notes before (or alongside) spec changes.
- If swapping vendors (e.g., Redis provider), update this table and call out migration steps in the associated spec/PR.
