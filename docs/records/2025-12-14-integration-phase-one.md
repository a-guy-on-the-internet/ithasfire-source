# Integration Testing – Phase 1 Roadmap

_Phase start: November 2025_

## Objectives

1. Provide reproducible, containerised environments for exercising adapters and transports against real infrastructure slices.
2. Cover the highest-risk checkout/ticket issuance surface end-to-end through repos, Stripe adapter seams, and TRPC bindings.
3. Prove out automation hooks (scripts + CI) so additional suites can layer on with minimal friction.

## Deliverables

| # | Deliverable | Description | Primary Owner |
| --- | --- | --- | --- |
| 1 | `@th/test-utils/integration` helpers | Shared Testcontainers wrappers for Postgres/Redis, Prisma migration runner, and deterministic seed loader. | Core Platform |
| 2 | Adapters integration smoke | Vitest suite in `packages/adapters/test/integration` that provisions Postgres + Redis, runs Prisma migrations, and exercises the checkout-related repos. | Adapters |
| 3 | TRPC transport integration | Tests in `packages/transport/trpc/test/integration` that boot the router with real adapters + Postgres to validate `orders.createCheckout`. | Transport |
| 4 | Fastify API smoke | `apps/api/test/integration` suite using Supertest against `createApp`, ensuring health + checkout endpoints work with real DI. | API |
| 5 | Tooling & docs | Scripts (`pnpm test:integration` subset), README updates, and CI wiring. | DX |

## High-Level Flow Coverage

- **Checkout + Ticket Issuance:**
  - Seed org, event, ticket types via Prisma seeds.
  - Execute `createCheckout` (core) through TRPC mutation.
  - Stub Stripe PaymentIntent creation (using in-memory fake for phase 1) while persisting order + audit trail in Postgres.
  - Optionally enqueue `IssueTickets` job and assert queue state via Redis.
- **Idempotency & Error Paths:**
  - Repeat checkout call with identical payload to assert replay behaviour.
  - Force validation error to ensure transport maps codes correctly.
- **Bootstrapping:**
  - Start Postgres container per suite, apply migrations via `@th/db` CLI.
  - Start Redis container where queue behaviour is exercised.
  - Share connection strings via helper context to reduce duplication.

## Sequencing & Milestones

1. **Scaffold helpers:** land Testcontainers utilities + sample seed harness.
2. **Adapters smoke:** add first integration spec hitting Prisma repos (orders, tickets).
3. **Transport route test:** bootstrap TRPC router with helpers and cover checkout mutation.
4. **API smoke:** stand up Fastify app in tests, reuse helpers to share database state.
5. **Docs & CI:** update developer docs, add pnpm scripts, and create Turbo pipeline/CI target.

## Open Questions / Follow-ups

- Stripe real vs mock: phase 1 will rely on a test double (`makeFakeStripeAdapter`). Phase 2 can swap to `stripe-mock` container.
- Seed management: evaluate using `packages/schema` fixtures vs bespoke seed module. Initial pass will hand-roll deterministic seed in `@th/test-utils`.
- Runtime budget: target <2 minutes for full phase-one integration job by reusing containers across suites when run serially.

## Acceptance Criteria

- `pnpm test:integration` (or equivalent) brings up containers automatically and exits cleanly.
- Suites run green locally and in CI on fresh checkouts without any manual prep.
- Failures include actionable diagnostics (database logs, seeded data dumps where helpful).
- Documentation explains local prerequisites (Docker) and troubleshooting steps.
