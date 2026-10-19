# Ithas Fire - Engineering Standards and Architecture Spec

These standards describe how we keep Ithas Fire's backend reliable, testable, and ready to audit. Everything in this document is enforceable; treat it as the contract for building and reviewing backend work.

## Table of Contents

- [0. Objectives](#0-objectives)
- [Quick Start / Do This First](#quick-start--do-this-first)
- [1. How to Use This Document](#1-how-to-use-this-document)
- [2. Monorepo & Tooling](#2-monorepo--tooling)
- [3. Code Style & Naming](#3-code-style--naming)
- [4. Hexagonal Architecture Layers](#4-hexagonal-architecture-layers)
  - [4.1 Ports](#41-ports)
  - [4.2 Core Use Cases](#42-core-use-cases)
  - [4.3 Adapters](#43-adapters)
  - [4.4 Transports](#44-transports)
- [Anti-Patterns](#anti-patterns)
- [Established Patterns](#established-patterns)
- [5. Data & Persistence](#5-data--persistence)
  - [5.1 Pagination Contracts](#51-pagination-contracts)
- [6. Money, Pricing & Idempotency](#6-money-pricing--idempotency)
- [7. Payments Flow](#7-payments-flow)
- [8. Auth & RBAC](#8-auth--rbac)
- [9. API Surfaces](#9-api-surfaces)
- [10. Validation & Error Handling](#10-validation--error-handling)
- [11. Observability & Audit](#11-observability--audit)
- [12. Security Hardening](#12-security-hardening)
- [13. Testing & Quality Gates](#13-testing--quality-gates)
- [14. CI/CD & Release](#14-cicd--release)
- [15. Conventions & Checklists](#15-conventions--checklists)
- [16. Non-negotiables](#16-non-negotiables)
- [17. Contributing](#17-contributing)
- [Appendix A. Quick Command Reference](#appendix-a-quick-command-reference)

## 0. Objectives

- **Transparency-first ticketing** - Replace hidden policies with explicit code and math.
- **Swap-friendly architecture** - Every external dependency (payments, auth, storage, comms) hangs off a port with at least one adapter.
- **Testable units** - Business logic belongs in use cases, not transports or adapters.
- **Safe money flows** - Favor idempotent operations, auditable state, and reversible steps.

## Quick Start / Do This First

- Read this document end-to-end once before making backend changes.
- Read `docs/hot-paths.md` before touching money, idempotency, checkout, payouts, or webhooks.
- Read `docs/layers.md` before creating or reshaping a use case, port, adapter, procedure or UI surface.
- Confirm layer boundaries before coding: `core` owns business rules, `ports` define contracts, `adapters` integrate systems, `transport` maps IO.
- Run the smallest relevant validation commands before opening a PR, then paste results in the PR description.

## 1. How to Use This Document

- Skim this spec before starting backend work; keep it open during review.
- Pair it with the following deep dives:
  - `docs/layers.md` - recipe per layer (core, ports, adapters, transport, UI) with the use-case template and checklists.
  - `docs/hot-paths.md` - know which flows are latency- or money-critical.
  - `docs/db-setup.md` - required when editing Prisma schema or running integration tests.
  - `docs/roles.md` - supporting detail for auth.
- When you add or change a rule here, update the related documents in the same PR.

## 2. Monorepo & Tooling

- Managed with pnpm workspaces and Turborepo. Never use npm/yarn in this repo.
- Packages of record:
  - `apps/api` (Fastify bootstrap)
  - `apps/web` (Next.js web client)
  - `apps/jobs` (background job runner - Cloud Run)
  - `apps/scanner` / `apps/mobile` (Expo)
  - `apps/audio-transcoder` (media transcoding service)
  - `packages/core` (pure use cases + shared domain logic)
  - `packages/ports` (interfaces)
  - `packages/adapters` (implementations - Prisma repos, Stripe, Redis, Valhalla, Jose, etc.)
  - `packages/transport/trpc` (routers)
  - `packages/db` (Prisma schema + client)
  - `packages/types` (source-of-truth TypeScript interfaces mirroring Prisma models)
  - `packages/schema` (Zod validation schemas referencing `@th/types`)
  - `packages/locale` (i18n message catalogs)
  - `packages/config` (shared config packages)
  - `packages/service` (shared service utilities)
  - `packages/test-utils` (test fakes and helpers)
  - `packages/ui` / `packages/ui-email` (shared component libraries)
  - `packages/web-rn-shims` (React Native Web compatibility shims)
- TypeScript project references are mandatory (`"composite": true` in each package). Keep `tsconfig.base.json` authoritative.
- Imports resolve to `src/` during dev, `dist/` in production through exports maps. Never import from `dist/` directly.
- Generated code, migrations, and Storybook assets belong in the package that owns them. Use the provided scripts; do not introduce ad-hoc build steps.

## 3. Code Style & Naming

- TypeScript runs in strict mode. No `any`, implicit `any`, or `as unknown` escape hatches without a TODO and follow-up issue.
- Formatting is enforced by Prettier. Ship only formatted diffs.
- ESLint (`@typescript-eslint`) must pass with zero warnings. If you suppress a rule, document why inline.
- Prefer named exports; default exports are limited to Next.js pages/config.
- Alias imports through tsconfig path mapping (`@th/*`). Cross-package deep relatives are forbidden.
- Keep public types in the package that owns them (`@th/types`, `@th/ports`, `@th/schema`).
- Naming:
  - Files and folders: kebab-case (`create-checkout.ts`).
  - Types, enums, classes: PascalCase (`OrderRecord`, `OrgRole`).
  - Functions, variables: camelCase (`computeOrderAmounts`).
  - Port files: new ones end in `.port.ts` (`routing.port.ts`); implementations: `*-adapter.ts` (`redis-adapter.ts`); orchestrators: `use-cases/<slice>/<name>.ts` (`use-cases/events/publish-event.ts`). Older files in `packages/ports` and `packages/adapters` predate the suffixes and use plain names.
  - Name by domain behavior, not framework behavior. Prefer explicit names over abbreviations unless the abbreviation is standard in the codebase. Keep names stable during refactors unless behavior changes.
- Keep comments actionable; reference tickets or follow-up checklists when behavior diverges from spec.

## 4. Hexagonal Architecture Layers

### 4.1 Ports

- Location: `packages/ports/src/**`.
- Define TypeScript interfaces, DTO shapes and their Zod schemas. No implementation, side effects, or shared state.
- DTOs must be plain objects (`Date` is allowed); no Prisma models, Maps/Sets, or other class instances.
- Ports must remain framework-agnostic. They cannot import from adapters, transports, or UI code.
- Document expected error codes and idempotency expectations inline with JSDoc.
- **Canonical pagination schemas** (`offsetPaginationInputSchema`, etc.) live in `@th/ports/pagination`.

### 4.1.1 Types and Schemas Package Relationship

The codebase maintains a clear separation between TypeScript interfaces and Zod validation schemas:

| Package | Purpose | Examples |
| ------- | ------- | -------- |
| `@th/types` | **Source of truth** for TypeScript interfaces. Mirrors Prisma models as plain TS types. | `OrderRecord`, `OrderItemRecord`, `OrderStatus` |
| `@th/schema` | **Zod schemas** for validation. Reference `@th/types` to ensure type-safe enum literals. | `orderStatusSchema`, `orderItemRecordSchema`, `eventBodySchema` |

**Pattern for deriving Zod schemas from types:**

```ts
import { z } from "zod";
import type { OrderStatus } from "@th/types";

// `satisfies` ensures compile-time sync with the canonical type
export const orderStatusSchema = z.enum([
  "PENDING", "SUCCEEDED", "PART_REFUNDED", "REFUNDED", "DISPUTED", "CANCELLED"
] satisfies readonly OrderStatus[]);
```

**Using schemas in use-cases:**

- Import full record schemas from `@th/schema` and use `.pick()` / `.omit()` to create specific output shapes.
- **Zod v4 caveat:** `.pick()`, `.omit()`, `.partial()`, and `.required()` **cannot** be called on schemas that have `.refine()`, `.superRefine()`, or `.transform()` applied; they throw at runtime. If you need to derive a sub-shape from a refined schema, create a `Base` variant without the refinement and call `.pick()` / `.omit()` on that, or build the derived shape explicitly with `z.object({...})`.
- Do **not** duplicate schema definitions inline; always reference the canonical schema. See [Inline Enum Duplication](#inline-enum-duplication) anti-pattern.
- Example: `const outputItemSchema = orderItemRecordSchema.pick({ id: true, qty: true, status: true });`

### 4.2 Core Use Cases

- Location: `packages/core/src/use-cases/<slice>/<name>.ts` plus sibling `schemas.ts`.
- Always parse input via Zod schemas, and type the output with `satisfies XxxOutput` or `outputSchema.parse(...)` ([Output Mapping](#output-mapping-with-satisfies-xxxoutput)). A use case is an exported `async function name(deps, rawInput)`.
- **Import enum/record schemas from `@th/schema`** rather than defining inline duplicates.
- Depend exclusively on ports (`@th/ports`). Never import Prisma, Stripe, or environment modules.
- Enforce authorization inside the use case through `repos.authz` (see [§8](#8-auth--rbac)).
- Mutations run exactly one `repos.tx()`; log audit entries inside that transaction before commit — **unless the audit write is swallowed**, in which case it must run after the transaction commits. See _Swallowing an error inside a transaction_ below.
- Any externally triggered or money-moving flow must wrap critical sections in `IdempotencyPort` (`begin -> work -> commit/fail`).
- Throw typed domain errors only (`fail(...)`, see §10). Avoid `Error` without `code`.
- Co-locate unit tests (`__tests__`) and follow the template in [`docs/layers.md`](layers.md#core).

### 4.3 Adapters

- Location: `packages/adapters/src/**`.
- Provide concrete implementations of ports. Convert external responses (Prisma, Stripe, Redis, SES) into the DTOs defined by ports.
- Do not embed business rules; keep validation and invariants in use cases.
- Handle retries, exponential back-off, and logging at the edge. Surface typed error codes back to callers.
- Sanitize secrets before logging. Redact payloads that might contain PII.
- Keep adapter constructors pure; inject configuration (clients, credentials) from transports.

### 4.4 Transports

- Location: `packages/transport/trpc` and `apps/api`.
- Parse incoming payloads with Zod, call a single use case, map typed errors to transport responses.
- No direct database or Stripe calls. No business branching beyond authentication and error mapping.
- Ensure request-scoped context (request IDs, auth) travels to use cases via port parameters.

## Anti-Patterns

This section documents patterns that have caused bugs, maintenance burden, or architectural drift. Avoid them.

### Inline Enum Duplication

**Problem:** Re-defining Zod enums inline in each use-case leads to maintenance burden and risks drift when enum values change.

[BAD] **Bad**: Re-defining enums inline in each use-case:

```ts
// DON'T DO THIS - creates maintenance burden and risks drift
const inputSchema = z.object({
  status: z.enum(["PENDING", "SUCCEEDED", "REFUNDED"]), // duplicated!
});
```

[GOOD] **Good**: Import from `@th/schema`:

```ts
import { orderStatusSchema } from "@th/schema";

const inputSchema = z.object({
  status: orderStatusSchema,
});
```

If you need a subset of values, use `.extract()`:

```ts
const allowedStatusSchema = orderStatusSchema.extract(["PENDING", "SUCCEEDED"]);
```

**Why this matters:**

- When enum values change in `@th/types`, all inline duplicates must be found and updated manually
- Inconsistent definitions between files cause silent validation mismatches
- Centralized schemas in `@th/schema` use `satisfies readonly XxxType[]` to ensure compile-time sync with TypeScript types

### `.omit()` / `.pick()` on Refined Schemas (Zod v4)

**Problem:** Calling `.omit()`, `.pick()`, `.partial()`, or `.required()` on a schema that has `.refine()`, `.superRefine()`, or `.transform()` applied throws a runtime error in Zod v4. This is a breaking change from Zod v3.

[BAD] **Bad**: Deriving from a refined schema:

```ts
const updateSettingsSchema = z.object({
  actorHumanId: z.string().uuid(),
  eventId: z.string().uuid(),
  refundCutoffAt: z.date().nullable().optional(),
}).refine(data => data.refundCutoffAt === undefined || data.refundCutoffAt === null || data.refundCutoffAt > new Date());

// THROWS AT RUNTIME in Zod v4!
const publicSchema = updateSettingsSchema.omit({ actorHumanId: true });
```

[GOOD] **Good**: Create a `Base` variant without refinements, or build the derived shape explicitly:

```ts
// Option A: Base + refined variants
const updateSettingsBaseSchema = z.object({
  actorHumanId: z.string().uuid(),
  eventId: z.string().uuid(),
  refundCutoffAt: z.date().nullable().optional(),
});
const updateSettingsSchema = updateSettingsBaseSchema.refine(/* ... */);
const publicSchema = updateSettingsBaseSchema.omit({ actorHumanId: true });

// Option B: Explicit shape
const publicSchema = z.object({
  eventId: z.string().uuid(),
  refundCutoffAt: z.date().nullable().optional(),
});
```

**Why this matters:**

- Zod v4 enforces structural correctness - refinements/transforms are pipeline steps that cannot be decomposed back into field-level shapes
- The error only surfaces at runtime (no compile-time warning), so it can reach production if untested
- This already caused a production API crash during the entity-pages migration

## Established Patterns

This section documents recurring implementation patterns observed across the codebase. Follow them for consistency.

### Dependency Injection via `XxxDeps`

Every use case declares a `XxxDeps` type that picks only the repo slices and ports it needs. This keeps test fakes minimal and makes dependency boundaries explicit.

```ts
export type GetPlaceLayoutDeps = {
  repos: Pick<Repos, "places" | "placeLayouts" | "placeLayoutBlobs" | "authz">;
  logger?: LoggerPort;
};
```

- `repos` uses `Pick<Repos, ...>` to enforce the minimal repo surface.
- `logger` is always optional so tests can omit it.
- Additional ports (e.g. `clock`, `idempotency`, `parser`) appear as top-level keys on the deps type.
- Transports assemble deps with `satisfies Parameters<typeof useCaseFn>[0]` for type-safe wiring (see below).

### Transport Deps Assembly with `satisfies`

tRPC procedures build the deps object inline and validate it against the use case's expected signature:

```ts
const deps = {
  repos: ctx.repos,
  logger: ctx.logger,
} satisfies Parameters<typeof getPlaceLayout>[0];
```

This catches mismatches at compile time if the use case's deps type changes. Every transport procedure should use this pattern.

### Output Mapping with `satisfies XxxOutput`

Use cases return data mapped to plain objects, validated with `satisfies` to keep the return shape in sync with the output schema's inferred type:

```ts
return {
  layout: {
    id: layout.id,
    name: layout.name,
    // ...
  },
} satisfies GetPlaceLayoutOutput;
```

Some use cases prefer `outputSchema.parse(...)` for runtime validation instead of `satisfies`. Either pattern is acceptable: use `parse` when the output shape involves transformations or coercions, and `satisfies` when the mapping is straightforward. Never use both redundantly.

### `parseInput` Helper

All use cases parse raw input through the shared helper rather than calling `schema.parse()` directly:

```ts
import { parseInput } from "../../lib/io";

const input = parseInput(getPlaceLayoutInputSchema, rawInput);
```

`parseInput` normalizes Zod errors into the `{ code: "invalid_input", issues, message }` error shape, ensuring consistent error formatting across all use cases.

### Non-Fatal Error Handling

When a secondary operation (signed URL generation, a search call, notification dispatch) fails but the primary result is still useful, the use case may swallow the error and return a fallback. Every swallow reports, per CLAUDE.md's "Error Reporting Convention":

- Declare `reportError?: ReporterPort` (`packages/ports/src/reporter.ts`) in the deps.
- In the swallow branch, keep the log line and call `deps.reportError?.(err, { tags, extra })` inside its own `try`, so a throwing reporter never changes the fallback. The composition roots wire `safeReporter(Sentry.captureException)`; the local guard is defence in depth.
- A `logger.warn` alone is invisible: Sentry captures `logger.error` and thrown errors, not `warn`.
- Test that the report fires (pattern: `packages/core/src/use-cases/search/__tests__/`, e.g. `nearby-events.test.ts`).

Reference: `packages/core/src/use-cases/search/nearby-events.ts`.

```ts
if (!result.ok) {
  deps.logger?.warn("nearby_events.search_failed", { error: result.error.message, lat, lng });
  try {
    deps.reportError?.(result.error, {
      tags: { useCase: "nearbyEvents" },
      extra: { lat, lng, radiusKm },
    });
  } catch {
    // A throwing reporter must never turn the fallback into a thrown error.
  }
  return { events: [], latencyMs: 0 };
}
```

Reserve non-fatal handling for enrichment operations. Core business invariants always throw. Reviewers flag a new catch-and-fallback branch without `reportError` as `[BLOCKING]`.

### Scoped Logger Pattern

For use cases with multiple log points, create a scoped logger at the top of the function to attach consistent context:

```ts
const scopedLogger = deps.logger?.child({ useCase: "deletePlaceLayout" });
```

For simpler use cases with a single log point, `deps.logger?.info(...)` inline is sufficient.

### Logger-Wrapped Execution

Some use cases wrap their core logic in a `logger.withTime` call for automatic timing instrumentation:

```ts
const execute = async () => { /* use case logic */ };

if (logger) {
  return logger.withTime("listEventTicketTypes", execute);
}
return execute();
```

Use this pattern for performance-sensitive endpoints or when you want timing data in structured logs.

### Public vs Authed Use Case Variants

When a feature needs both admin and public access, create separate use cases rather than adding conditionals:

| Variant | Auth | Output | Example |
| ------- | ---- | ------ | ------- |
| Admin | Ownership/RBAC check | Full record with sensitive fields | `getPlaceLayout` |
| Public | None | Reduced output (no PII, internal IDs, secrets) | `getPublicPlaceLayout` |

This avoids accidentally leaking sensitive data through conditional output branching and keeps authorization logic isolated.

### Co-Located Schemas

Schemas live alongside their use case by default. When multiple use cases share the same schema shapes, extract shared schemas to a sibling `schemas.ts` file within the same slice:

```text
core/use-cases/place-layouts/
  get-place-layout.ts        <- inline schemas
  get-public-place-layout.ts <- inline schemas (subset of the above)
  schemas.ts                 <- shared shapes if needed
```

Record-level schemas (full repo DTOs, enum definitions) belong in `@th/schema`. Use-case-specific input/output shapes stay co-located.

## 5. Data & Persistence

- PostgreSQL via Prisma. Models cover humans, orgs, places, events, tickets, agreements, resale, seating.
- Schema rules:
  - Maintain unique constraints for identities, codes, and composite keys (e.g. `@@unique([orderId, payeeId])`).
  - Use `onDelete` semantics: `Cascade` for contained records, `Restrict` for ownership, `SetNull` for optional relations.
  - Store timestamps in UTC. Never rely on local time zones; use the shared date helpers.
- Transactions: one logical action per Prisma `$transaction`. Do not nest `$transaction` calls.
- Migrations flow through Prisma migrate only. Manual SQL is allowed solely for additive `CHECK` constraints with documented reasoning.
- Update `docs/db-setup.md` whenever schema or migration workflow changes.

### 5.1 Pagination Contracts

- **Always declare explicit schemas** for pagination inputs. Offset lists must accept `{ limit?: number, offset?: number }` and cursor lists must accept `{ limit?: number, cursor?: string | null }` plus any filters.
- **Apply defaults and caps during sanitization** (for example via `sanitizeOffsetPagination` / `sanitizeCursorPagination`) before querying. Keep schema validation and normalization rules in sync.
- **Keep limits aligned with current implementation and target contract**: default to 25 items and cap at 200 unless the use case intentionally enforces a smaller cap (for example, featured carousels). Return the sanitized values actually used.
- **Use canonical Zod helpers** from `@th/ports/pagination`:
  - `offsetPaginationInputSchema` and `cursorPaginationInputSchema` validate inbound params.
  - `offsetPaginatedResultSchema` / `cursorPaginatedResultSchema` describe the response contract, including metadata.
- **Return required offset metadata**:
  - `items`: ordered array containing the requested slice.
  - `pageInfo`: `{ total, count, limit, offset, hasNextPage, nextOffset }` where `count === items.length` and `nextOffset` is `null` when there is no additional page.
  - `total`: derive from the source of truth (DB count or approved estimate). If exact counts are too expensive, document the approximation and create a follow-up task.
- **Return required cursor metadata**:
  - `items` is strictly ordered by a stable, unique field (timestamp+id).
  - `pageInfo`: `{ cursorField, nextCursor, hasNextPage, limit }`. The cursor encodes the last item's ordering tuple.
  - `nextCursor` must be `null` when fewer than `limit` items are returned, and replaying the cursor must never skip or duplicate items.
- **Assign ownership correctly**: ports and adapters produce pagination metadata; use cases and transports pass it through without reshaping semantics.
- **Test pagination behavior**: every paginated use case must cover (1) first page, (2) page with `hasNextPage = true`, and (3) last or empty page. Add adapter integration coverage when totals depend on DB count behavior.

## 6. Money, Pricing & Idempotency

- Amounts are integers (cents) or BigInt for high precision. Never use floating point for currency.
- Reuse deterministic helpers in `packages/core/src/lib/pricing`. UI calculations must match server-side helpers.
- Validate `sum(order_splits) === order_total` and preserve platform fees deterministically.
- **Fee pipeline:**
  - `computeTicketPriceForAgreement` - per-ticket percentage fees only (platform % + processor %).
  - `computeOrderAmounts` - order-level additions: `processorFixedCents` added once (Stripe charges one flat fee per PaymentIntent, not per line item), then `maxPlatformFeeCents` cap applied if set. Both are distributed proportionally into per-item metadata for refund math.
- **Tax strategy:** venue-cached rate. `TaxRateLookupPort` (Ziptax adapter) resolves the rate by postal code and caches it on `SavedLocation.admissionTaxRateBps` (basis points). At event publish, the rate is stamped onto `Event.admissionTaxRateBps`. Checkout computes tax as `Math.round(subtotalCents * taxRateBps / 10_000)` - zero external API calls per transaction.
- Idempotency keys follow `<scope>:<actor>:<unique>`, derived in core:
  - Checkout: `checkout:{actorHumanId}:{clientKey}` with a caller-provided `clientKey` (`orders/create-checkout.ts`).
  - Stripe webhooks: `stripe_evt:{evt.id}` (`orders/finalize-from-payment-intent.ts`).
  - Place upserts: `place:org:{orgId}:{placeId|new}:{clientKey}` (`places/upsert-place.ts`).
  - Replays return the stored success payload; a reused key with a different payload throws `IDEMPOTENCY_KEY_CONFLICT`.
- `IdempotencyPort` contract (`begin`, `get`, `run`, `commit`, `fail`, `release`) is mandatory around any mutation triggered by external systems or handling payments/refunds.
- Ticket issuance happens only through `finalizeFromPaymentIntent` after successful payment confirmation.
- Persist order splits at finalize-time using Agreement data; they underpin payouts and audit trails.

## 7. Payments Flow

- Happy path: `createCheckout -> Stripe PaymentIntent (tickets + buyer fee + tax) -> webhook payment_intent.succeeded -> finalize use case -> ticket issuance -> order splits`.
- Tax is computed at checkout from the event's cached `admissionTaxRateBps` (simple multiply, no external API call). The `stripeTaxCalculationId` field is always `null`.
- Processor flat fee (`processorFixedCents`) is added once per order, not per ticket type. If `maxPlatformFeeCents` is configured on the fee policy, total platform fees are capped at that amount.
- Payout scheduling: grouped by payee at event end or monthly cadence -> Stripe Connect transfer adapter.
- Resale: listing + holds -> purchase -> new order `source=RESALE` -> resale agreement applied.
- When you modify payments logic, update `docs/hot-paths.md` and add/pay down integration tests.

## 8. Auth & RBAC

- Authentication via **Better Auth** (session/cookie/JWT). See `docs/auth.md` for architecture details.
- Transport layer resolves the authenticated user and populates `ctx.actorHumanId`. `ctx.authn.ensureAuthedHuman` (`AuthNPort`) maps the auth provider identity to a `Human.id`.
- Enforce organization-scoped roles: `OWNER | ADMIN | EDITOR | FINANCE | SCANNER | VIEWER`.
- Perform role checks inside use cases (never in transports) through `repos.authz` (`AuthZPort`, `packages/ports/src/authz.ts`: `requireOrgRole`/`hasOrgRole`, `canEditEvent`, `canManagePlace`, `canFinanceOrg`, `hasStaffRole`). The exception is the public event read gate (`packages/transport/trpc/src/event-read-access.ts`), which needs the transport's unlock cookie.
- When introducing new roles or permissions, update `docs/roles.md` and migrate existing authorization tests.

## 9. API Surfaces

- tRPC is the primary interface. The root router (`packages/transport/trpc/src/router.ts`) mounts 40+ namespaced domain routers including `events`, `orders`, `tickets`, `agreements`, `entityPages`, `embeds`, `routing`, `analytics`, `claims`, `comp`, `notifications`, `comms`, and more. Add new routers under the same namespace pattern.
- REST Fastify endpoints support webhooks and select public/embed routes; they are thin wrappers over use cases.
- **Embeds:** Public embed procedures on the `embeds` tRPC router enforce the per-embed domain allowlist via `assertEmbedOriginAllowed` (`packages/core/src/use-cases/embeds/_shared/assert-embed-origin-allowed.ts`), which checks the embedding page's origin (client-computed from `ancestorOrigins`/referrer inside our iframe; suppressible but not spoofable in-browser) against the registered `Embed` domain and fails closed. There is no embed JWT — the former `EMBED_JWT_SECRET` / `EmbedTokenSignerPort` bootstrap subsystem was dead code and has been removed. Enforce CSP headers and origin checks.
- **Routing:** `RoutingPort` (Valhalla adapter) provides A-to-B travel time calculations. Gated behind `VALHALLA_URL` + `ENABLE_TRAVEL_TIME` feature flags. See `apps/api/src/lib/env.ts` for configuration.

## 10. Validation & Error Handling

- Parse every inbound transport payload with Zod.
- Parse every use-case input with Zod before executing business logic.
- Validate domain invariants in use cases; do not rely on database constraints as primary validation.
- Throw typed domain errors (below). Include Zod `issues` arrays only for `invalid_input` responses.
- Map domain errors to protocol responses in transports.
- Normalize Prisma/Stripe/external errors inside adapters before they reach use cases or transports; never leak raw provider payloads.
- Expose actionable error context in logs and errors while redacting secrets and PII.

### Error codes (`@th/errors`)

`AppErrorCode` is a SCREAMING_SNAKE union in `packages/errors/src/codes.ts` (`EVENT_NOT_FOUND`, `ORDER_NOT_REFUNDABLE`, `QUOTA_EXCEEDED`, and hundreds more). Every code sits in exactly one tier:

- `USER_FACING_CODES`: a person can act on it. Each needs an `errors.<camelCaseKey>` entry in both `apps/web/src/i18n/messages/en.ts` and `es.ts` (`toKey("EVENT_NOT_FOUND")` is `eventNotFound`). `apps/web/src/i18n/__tests__/error-code-parity.test.ts` enforces it.
- `INTERNAL_CODES`: infra, dependency or invariant failures. Typed and enumerable, but no catalog entry (the parity test asserts the key is absent), so the client shows generic safe copy.

A code that is only an operational failure (`STORAGE_ERROR`, `SERVICE_UNAVAILABLE`) goes in `INTERNAL_CODES`, not in the user-facing tier.

Adding a code:

1. Add the member to the `AppErrorCode` union and to `APP_ERROR_CODES`.
2. List it in `USER_FACING_CODES` or `INTERNAL_CODES`. Compile-time guards fail on an array entry missing from the union, a union member missing from the array, and a member in neither tier.
3. Give it a status in `appCodeToTrpc` (`packages/transport/trpc/src/utils.ts`); the map is `satisfies Record<AppErrorCode, …>`, so the build forces the decision.
4. For a user-facing code, add the en and es catalog entries.

The harvest that produced the registry is in [`specs/2026-06-23/error-code-registry.md`](specs/2026-06-23/error-code-registry.md).

### Throwing

New code raises `AppError` through `fail`, not a raw `throw { code, message }` literal:

```ts
import { fail } from "@th/errors";

if (!event) throw fail("EVENT_NOT_FOUND");
if (overQuota) return fail("QUOTA_EXCEEDED", { meta: { kind, limitValue, currentUsage } });
catch (err) { throw fail("STRIPE_NOT_CONNECTED", { cause: err }); } // keeps the SDK error for Sentry's linkedErrors
```

`fail(code, opts?)` returns `never`, so both `throw fail(...)` and `return fail(...)` typecheck. `AppError` extends `Error` (real stack trace). Options: `message`, `meta` (structured data for the client, preferred over data packed into strings), `cause`, `category`.

Why not the legacy `{ code, message }` shape: `AppError.code` is the one canonical code, while the legacy shape overloads `code` as a transport category and carries the domain code in `message`, so the boundary has to guess. A thrown `AppError` resolves its tRPC status from `appCodeToTrpc`; a legacy domain code missing from `errorCodeMap` falls through to `INTERNAL_SERVER_ERROR` and pollutes the Sentry 500 stream.

The legacy `{ code, message }` shape still comes from `parseInput`, `callOrDependencyFailed` (both `packages/core/src/lib/io.ts`) and older throw sites; its codes are typed as `KnownErrorCode` in `packages/core/src/lib/errors.ts`. `toTrpcError` resolves a legacy code through `errorCodeMap` (`packages/transport/trpc/src/utils.ts`). The seven categories:

| Legacy code | tRPC status |
| --- | --- |
| `invalid_input` | `BAD_REQUEST` |
| `forbidden` | `FORBIDDEN` |
| `not_found` | `NOT_FOUND` |
| `conflict` | `CONFLICT` |
| `rate_limited`, `transient` | `TOO_MANY_REQUESTS` |
| `dependency_failed` | no entry, so `INTERNAL_SERVER_ERROR` (500) |

`errorCodeMap` also carries rows for lowercase domain codes (`place_not_verified`, `report_already_open`, and others) and for transport categories thrown directly as the code (`precondition_failed`, `unauthorized`). Any legacy code without a row falls to `INTERNAL_SERVER_ERROR`.

`category` is the escape hatch for a throw site whose status should differ from the code's default: pass another `AppErrorCode` whose `appCodeToTrpc` bucket to borrow (`throw fail("INVALID_STATUS", { category: "CONFLICT" })`). It is pure data; `@th/errors` stays transport-agnostic and the tRPC boundary resolves `category ?? code`.

### Wire contract

`toTrpcError` (`packages/transport/trpc/src/utils.ts`) is the single choke point. The `errorFormatter` sits on `initTRPC.create` in `packages/transport/trpc/src/trpc.ts` and attaches `data.appCode` and `data.meta`; tRPC ignores a formatter passed to the Fastify adapter, so `apps/api/src/plugins/trpc.ts` sets none. The legacy `{ code, message }` path is preserved byte for byte. Treat `message`, `data.code` and `data.zodError` as frozen (except the production `INTERNAL_SERVER_ERROR` scrub below), because clients and `normalizeError()` still read them. New signal rides on `data.appCode` and `meta`. In production an `INTERNAL_SERVER_ERROR` goes out with the message `Internal server error` and without `stack` or uncurated `meta`; `appCode` survives.

### Rendering

Clients never hand-map error strings. They call `normalizeError(err, t)` (or `formatAuthErrorMessage`) from `@th/errors`, which resolves in priority order: a structured `AppErrorCode` (`AppError` or `data.appCode`), `data.zodError` field errors, Better Auth shapes, network failures, then a humanized fallback. It never throws and never leaks raw internal or provider strings to copy. In `apps/web`, `formatErrorMessage(error, t)` (`src/lib/format-error-message.ts`) takes the translator as its optional second argument; pass `t` so codes resolve through the `errors.*` catalog.

## 11. Observability & Audit

- Write an `AuditLog` entry for every critical mutation with `{ entity, entityId, action, data, at }`.
- Persist audit entries inside the same transaction as the mutation.
- Attach and propagate `X-Request-Id` across transports, adapters, and outbound calls.
- Emit structured JSON logs and mask or omit PII unless explicitly allowed.
- Track operational metrics including GMV, buyer fee percentage, PaymentIntent success rate, duplicate-key suppression count, and settlement lag.
- Add or update metrics whenever you introduce or modify hot-path behavior.

## 12. Security Hardening

- Verify Stripe webhook signatures using raw request bodies.
- Store secrets only in approved secret managers or gitignored `.env` files.
- Never commit secrets, sample tokens, or real credentials.
- Sign QR and similar bearer tokens with short TTLs.
- Validate token signature and expiration at scan or consumption time.
- Apply Zod validation at ingress and enforce defensive invariant checks in use cases.
- Rate limit sensitive endpoints by both IP and authenticated human identity.
- Enforce strict CORS allowlists for first-party app domains and embed domains.
- Apply least privilege to Stripe keys, DB roles, and third-party credentials.
- Rotate credentials when scope, ownership, or exposure risk changes.

## 13. Testing & Quality Gates

- Tests protect behavior, not implementation details. Add or update tests with every behavior change, covering the happy path plus at least one failure path.
- Write unit tests for use cases using fake ports; isolate business logic from network and infrastructure.
- Write integration tests for adapters against Prisma test DB, Stripe test mode, Redis, and SES stubs.
- Keep contract tests aligned with Zod schemas and transport response shapes.
- Add idempotency retry assertions for every money-affecting flow.
- Add regression coverage before merging hot-path changes.
- Document known testing gaps in the PR description.
- Include validation command output in the PR description; missing evidence blocks review.

### Test hooks

Select elements in tests by `data-testid` (or by role), not by CSS class or text.

- Name test ids `<base>-<part>[-<id>]`: `base` is the feature or page slug (`checkout`, `saved`), `part` the semantic region (`panel`, `item`, `filter`, `total`, `button`, `input`, `modal`), `id` a stable identifier (record id, code or index). Example: `checkout-item-tt_123`.
- A reusable component accepts an optional `testIdBase?: string` that defaults to its kebab-case name, so one instance can be told apart from another on the same page (`<Tabs testIdBase="saved-tab" />`).
- Pair test ids with proper labels and roles so Testing Library accessibility queries keep working.

## 14. CI/CD & Release

- Keep CI green: typecheck, lint, unit tests, and build must pass before merge.
- Treat database migrations as gated changes that require review and backup readiness.
- Publish build artifacts only to package-owned `dist/` folders referenced by exports maps.
- Document schema changes, money-flow updates, and security-impacting changes in release notes.

## 15. Conventions & Checklists

- Use case layout:

  ```text
  core/use-cases/<slice>/<name>.ts
  core/use-cases/<slice>/schemas.ts
  core/use-cases/<slice>/__tests__/<name>.test.ts
  ```

- Call `deps.idempotency.begin` / `commit` / `fail` (or `run`) in money-affecting use cases and include replay coverage.
- Execute write flows in this order: persist domain state -> invoke external side effect -> finalize DB state -> record audit log in the same transaction, **unless that audit write is swallowed** (see below).

### Swallowing an error inside a transaction

**Never catch a failed database statement and continue inside the transaction that statement belongs to.** This is a correctness rule, not a style preference.

Postgres puts a session into the aborted state on any failed statement — a violated constraint, a deadlock, a statement timeout, a rejected value. `repos.tx` is a plain `prisma.$transaction(callback)` with no per-statement savepoints, so a `catch` that continues leaves the transaction already condemned.

The transaction budget is per call, not global: `repos.tx(fn, { timeout, maxWait })` defaults to 30 seconds open and 10 seconds to acquire a connection, and those defaults are deliberately not tunable from the environment. A caller that passes a longer `timeout` must say why in a comment at that call (spec 2026-09-05, P-3). Do the slow work before the transaction opens instead (the tax lookup is the worked example). What happens next depends only on whether another statement runs before the callback returns:

- **Nothing after it** — `COMMIT` is answered with `ROLLBACK` and **no error**. Prisma does not surface it. The use case returns success and every write in that transaction is gone.
- **Anything after it** — that statement raises `25P02` and the transaction rolls back loudly, but Sentry blames the innocent statement and the real cause is wherever the swallow logged it.

Measured 2026-09-04 against Prisma 7.1.0 + `PrismaPg`: a swallow with nothing after it returned `"ACCEPTED"`, threw nothing, and left the row untouched. This shipped as a real defect in `scanTicket`, where a failed audit row silently un-burned a ticket while the scanner showed green.

A failed `SELECT` aborts the transaction exactly as a failed `INSERT` does. "It is only a read" is not a defence.

Three acceptable shapes, in order of preference:

1. **Hoist it out.** Best-effort work does not belong in a transaction it can condemn. Record an intent inside the transaction, act on it after the commit (`scanTicket`'s `recordScanAudit`, `assignSlugOnCreate`). Hold the intent in a **container object**, not a bare `let` — TypeScript does not track assignments made inside a nested function, so a `let x: T | null = null` narrows to `never` at the guarded call and silently disables its type check.
2. **Narrow the catch.** Swallow the specific business condition — a zero-row conditional update, a clean miss — and let repo errors propagate. `booking-holds/_shared/hold-line.ts` is the reference: the adapter emits a bespoke sentinel that no Prisma error can impersonate, which is what makes "lost the race" distinguishable from "the transaction is dead".
3. **Make the statement unable to fail.** Where the only realistic failure is a conflict that is semantically a no-op, `createMany({ skipDuplicates: true })` removes the error instead of catching it.

Helpers that do post-commit work must take the full `Repos` bag, never `TxRepos`. Since `TxRepos = Omit<Repos, "tx">`, that makes passing a transaction handle a compile error rather than a regression waiting to happen.

Reviewers: a `catch` that does not rethrow, around any statement on a `tx` handle, is `[BLOCKING]`.
- Use `/v1` for REST endpoints. Version tRPC routers through package versioning when needed.
- Keep feature flags environment-driven and documented, including defaults.
- Update docs, Storybook stories, and schema diagrams when behavior changes.
- Treat missing required documentation updates as review blockers.

## 16. Non-negotiables

- Do not call Prisma or Stripe directly from routers; route all access through use cases and adapters.
- Do not place business logic in adapters or repos; keep them focused on translation and IO.
- Validate all inputs with Zod, and type every use-case output with `satisfies` or `parse` ([Output Mapping](#output-mapping-with-satisfies-xxxoutput)).
- Make every webhook path idempotent and safe to retry.
- Keep ticket issuance fully auditable with correlated logs and audit entries.
- Include before/after behavior notes and test evidence in every PR touching money, auth, or schema flows.

## 17. Contributing

- Read adjacent code and the relevant docs before editing a file. Follow the layer rules in §4: use cases go in `packages/core`, depend only on ports, and never import adapters or transport.
- Keep a change scoped to one coherent set: each commit is a vertical slice or a single refactor, split across layers where needed. Explain intent, risk, and user-visible behavior changes in the PR description, with before/after notes for money, auth, schema, or permissions changes.
- Run the checks before pushing: `pnpm build`, `pnpm lint` (warnings count as failures), `pnpm typecheck` plus `pnpm typecheck:<app>` for each app touched, and the tests for the affected package. For Prisma schema changes also run `pnpm db:validate` and `pnpm -F @th/db run generate`. Paste the exact commands and results into the PR.
- Keep comments, commit messages, and PR descriptions emoji-free.
- Docs live in `docs/`. Index a new living doc as CLAUDE.md says, in the same change, and update docs that describe changed behavior or contracts with it.
- Specs use a two-folder pattern: drafts at the subdirectory root, completed specs in `completed/`.
- Local setup is in the root `README.md`; environment variables in [`deploy.md`](deploy.md#runtime-config-and-env-vars); database workflow in [`db-setup.md`](db-setup.md).

## Appendix A. Quick Command Reference

| Scenario | Command(s) |
| --- | --- |
| Global sanity | `pnpm build`, `pnpm typecheck`, `pnpm lint` |
| Prisma/schema updates | `pnpm db:validate`, `pnpm -F @th/db run generate` |
| Core business logic tests | `pnpm -C packages/core vitest --run` |
| Adapter integration tests | `pnpm -C packages/adapters vitest --run` |
| API smoke test | `pnpm -F api run smoke` (requires local infra + env vars) |
| Storybook UI review | `pnpm --filter @th/ui run storybook` |

Re-run the smallest relevant subset when you touch a layer. Record the output in your PR before requesting review.
