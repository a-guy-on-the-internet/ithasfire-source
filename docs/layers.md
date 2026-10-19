# Building through the layers

Recipe for adding a capability end to end: core, ports, adapters, transport (tRPC), UI. Policy and the reasons behind it live in [Engineering Standards](engineering-standards.md); money, idempotency, checkout, payouts and webhooks also need [Hot Paths](hot-paths.md). Visible UI work also loads the `ui` skill.

## Order of work

1. Record shape: a new Prisma model or column means [DB Setup](db-setup.md), then `@th/types` (plain TS type) and `@th/schema` (Zod schema).
2. Port: only if core needs a new external capability or repo method ([Ports](#ports)).
3. Core use case ([Core](#core)), tested against fakes.
4. Adapter that implements the port ([Adapters](#adapters)), with its own tests.
5. Wire the adapter into the composition roots: `apps/api/src/lib/dep.ts`, plus `apps/jobs` when a job needs it.
6. tRPC procedure ([Transport](#transport-trpc)).
7. UI ([UI](#ui)).

Each step compiles and passes its own tests before the next starts. Imports only point down the list: core imports ports, adapters import ports, transport imports core, apps import everything.

Done when: every layer you touched has a test, `pnpm typecheck` plus `pnpm typecheck:<app>` for each app touched pass, and the docs that describe changed behavior are updated in the same change.

## Core

`packages/core/src/**`. Pure orchestration over ports: no Prisma, Stripe, Redis, Fastify or transport imports, no `new Date()` (use `deps.clock.now()`), no Prisma model types in or out.

### When a change needs a use case

A new use case when the change adds a business capability with its own input/output contract, new domain rules or authorization, a transactional and auditable mutation, or idempotent behavior for externally triggered or money-moving work. Refactoring helpers, renaming fields with no behavior change, and adapter-only integration details need none.

### Layout

```text
packages/core/src/use-cases/<slice>/<name>.ts
packages/core/src/use-cases/<slice>/schemas.ts            # only when schemas are shared across the slice
packages/core/src/use-cases/<slice>/_shared/              # slice-private helpers
packages/core/src/use-cases/<slice>/index.ts              # slice barrel
packages/core/src/use-cases/<slice>/__tests__/<name>.test.ts
packages/core/src/lib/                                    # pure helpers (pricing, io, rbac, dates)
packages/core/src/index.ts                                # package barrel
```

- File names are kebab-case.
- Transport imports use cases from `@th/core` (the package barrel re-exports the slice) or by deep path (`@th/core/use-cases/<slice>/<name>`; the exports map is `./*` to `./src/*`). Add the slice to `packages/core/src/index.ts` when transport imports it from `@th/core`.
- Fakes and test deps live in `packages/test-utils/src/fakes` (`createEventDeps` in `create-event-deps.ts` is the pattern). Keep ad-hoc fixtures out of core.

### Template

A use case is a plain exported `async function name(deps, rawInput)`. Reference for a read: `use-cases/place-layouts/get-place-layout.ts`. Reference for a mutation with idempotency, transaction, audit and metrics: `use-cases/series/create-event-series.ts`.

```ts
import { z } from "zod";
import { fail } from "@th/errors";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { parseInput } from "../../lib/io";

export const getThingInputSchema = z
  .object({ thingId: z.string().uuid(), actorHumanId: z.string().uuid() })
  .strict();
export const getThingOutputSchema = z.object({ /* output shape */ });
export type GetThingInput = z.infer<typeof getThingInputSchema>;
export type GetThingOutput = z.infer<typeof getThingOutputSchema>;

export type GetThingDeps = {
  repos: Pick<Repos, "things" | "authz">; // only the slices used
  logger?: LoggerPort;                    // always optional
};

export async function getThing(
  deps: GetThingDeps,
  rawInput: unknown,
): Promise<GetThingOutput> {
  const input = parseInput(getThingInputSchema, rawInput); // 1. parse
  const thing = await deps.repos.things.getById(input.thingId);
  if (!thing) throw fail("THING_NOT_FOUND");               //    the row the check needs
  await deps.repos.authz.requireOrgRole(/* ... */);        // 2. authorize
  return { /* mapped DTO */ } satisfies GetThingOutput;    // 6. return
}
```

Order inside a use case:

1. **Parse** the raw input with `parseInput(schema, rawInput)` (`lib/io.ts`), which throws `{ code: "invalid_input", issues }`.
2. **Authorize** as soon as the row the check needs is loaded, through `deps.repos.authz` ([methods and the one transport exception](engineering-standards.md#8-auth--rbac)). Authorization lives here, never in transport.
3. **Idempotency** (externally triggered or money-moving): `deps.idempotency.get(key)` replays a stored result; `begin(key, ttl)` claims; `commit(key, result)` on success, `fail(key, message)` on error. Store a payload hash with the result so a reused key with a different payload throws `IDEMPOTENCY_KEY_CONFLICT`.
4. **Transaction** (mutations): exactly one `deps.repos.tx(async (tx) => { ... })`. Check invariants, write, and `tx.audit.log({ entity, entityId, action, data, at })` inside it. Before putting a `try`/`catch` inside a transaction, read [Swallowing an error inside a transaction](engineering-standards.md#swallowing-an-error-inside-a-transaction).
5. **External calls** go through ports. Do slow work before the transaction opens.
6. **Return** the DTO, either `satisfies XxxOutput` or `outputSchema.parse(...)` (one of them, not both).

Conventions:

- `XxxDeps` picks only the repo slices and ports the use case reads; transports assemble it with `satisfies Parameters<typeof useCase>[0]`.
- Import enum and record schemas from `@th/schema`; keep use-case input/output schemas next to the use case.
- Public and authenticated variants of a feature are separate use cases (`getPlaceLayout`, `getPublicPlaceLayout`), never one use case with conditional output.
- A use case that catches a failure and returns a fallback declares `reportError?: ReporterPort` and calls it in the swallow branch (see CLAUDE.md, "Error Reporting Convention").
- Free text is sanitized before its length check: short fields use the `plainTextRequired`/`plainTextOptional` schemas (and their `Multiline` variants) or `sanitizePlainText` from `packages/core/src/lib/sanitize-plain-text.ts`; event prose bodies use `use-cases/events/_shared/event-body-sanitizer.ts`. Output is still escaped at the sink.
- New code for a sensitive actor action (ownership transfer, money out or reversal, account identity change) must enforce server-side email verification in the use case. Existing gaps are listed in [Email verification gates](auth.md#email-verification-gates); keep that section in sync.

### Errors

Raise errors with `fail("CODE", { meta, cause })` from `@th/errors`; see [Validation & Error Handling](engineering-standards.md#10-validation--error-handling) for the code registry, tiers, the [legacy categories](engineering-standards.md#throwing) and the wire contract. Include Zod `issues` only on `invalid_input`.

### Money and idempotency keys

A money-moving use case follows [Money, Pricing & Idempotency](engineering-standards.md#6-money-pricing--idempotency): integer cents through `packages/core/src/lib/pricing`, `sum(orderSplits) === orderTotal`, and the key shapes and replay rules.

### Core tests

Co-locate in `__tests__/<name>.test.ts`, with fakes from `packages/test-utils`. Every use case covers: the happy path with the expected output shape, invalid input (`invalid_input`), an authorization failure (`forbidden`), and a not-found or conflict path. Money-affecting or externally triggered flows add an idempotency replay (same key, no duplicated effect), a rounding/invariant test, and a concurrency test where duplicate operations are possible. A use case that returns a fallback after catching an error adds a test that the report fires (pattern: `packages/core/src/use-cases/search/__tests__/`). Paginated use cases follow [Pagination Contracts](engineering-standards.md#51-pagination-contracts).

Done when: input is parsed and output is typed with `satisfies` or `parse`, authorization and (where it applies) idempotency and audit are in place, new exports reach `packages/core/src/index.ts` or the slice `index.ts`, and the tests above exist.

## Ports

`packages/ports/src/**`. A port is the contract between core and an adapter.

- Files export interfaces, DTO types and Zod schemas; no implementation, environment reads or wiring. DTOs are plain data: `Date` is allowed; Prisma models, Maps, Sets and other class instances are not.
- Add a port only when core needs polymorphism (several implementations now or foreseeably) or a cross-service boundary. A single-implementation detail stays in the adapter.
- Start with the smallest surface that unlocks the use case. Methods are verbs without provider names (`createPaymentIntent`, not `stripeCharge`), take one structured input object, and say in JSDoc whether they are idempotent, transactional or fire-and-forget, plus their error codes.
- Recoverable outcomes use discriminated unions; catastrophic ones throw a typed error.
- Idempotency keys: core derives the key ([key shapes](engineering-standards.md#6-money-pricing--idempotency)). A port whose provider supports idempotency takes it as an `idempotencyKey` field on the structured input (e.g. `payment-processor-port.ts`, `membership-billing-port.ts`, `comms/mailer.ts`, `comms/sms.ts`, `job-queue.ts`), and the adapter forwards it to the provider or dedupes on it. Replay state (stored result, payload hash, conflict) lives in `IdempotencyPort`, never in a provider port.
- File naming: new port files end in `.port.ts` (`routing.port.ts`, `wallet-pass.port.ts`). Many older ones are plain `<name>.ts`, and repo ports sit under `packages/ports/src/repos/`.
- Export from `packages/ports/src/index.ts` (the exports map also allows deep imports such as `@th/ports/logger`).
- Keep a fake in `packages/test-utils/src/fakes` that matches the documented success and failure behavior. Add a contract test (`packages/test-utils/src/contracts`) when behavior is complex or money-related.

Done when: the port is exported, every method has JSDoc for parameters, returns and errors, and the fake compiles against it.

## Adapters

`packages/adapters/src/**`, tests in `packages/adapters/src/**/__tests__` and `packages/adapters/test/**` (`db`, `integration`, `queue`, and others). Adapters bridge ports to Prisma, Stripe, Redis, SES, S3 and similar.

```text
packages/adapters/src/
  index.ts                     # barrel
  db/prisma-repos.ts           # composes the per-model repos in db/prisma/
  db/prisma/<model>.ts
  payment-processors/stripe/
  idempotency/{prisma-adapter,redis-adapter}.ts
  comms/{ses-mailer,sns-sms,mail,push}
  geo/  search/  queue/  file-storage/  ...
```

- Match the port exactly; never widen or narrow its contract.
- Convert provider responses to port DTOs immediately and strip provider-specific fields.
- Receive clients, credentials and a logger as constructor or factory parameters; the composition root controls lifecycle. No global singletons, no new Prisma or Stripe client per call.
- Translate provider errors into typed errors (`fail(...)` from `@th/errors`; example: Stripe `resource_missing` becomes a not-found code), keeping `cause` for Sentry.
- Business rules and invariants stay in core; validate inputs lightly and leave the rest to core.
- Retries and back-off live at the edge and must keep repeated attempts idempotent. Forward the port's `idempotencyKey` to the provider where it supports one (Stripe: the SDK's `idempotencyKey` request option, as `stripe-adapter.ts` does). Where the provider has no native key, dedupe inside the adapter with `runWithIdempotency` over an injected `IdempotencyPort` (`packages/adapters/src/comms/utils.ts`; `ses-mailer.ts` is the pattern); never drop the key. Database writes rely on unique constraints plus `repos.tx()`. Honor abort signals and surface timeouts as `transient`.
- Never log secrets or PII; redact. Read configuration through injected values, never `.env` files directly. Select only the columns needed. Webhook handlers reuse the verified raw body from the transport.
- New files end in `-adapter.ts` where the area follows that convention; older areas use plain names (`ses-mailer.ts`, `postgis-geo-adapter.ts`, `prisma/<model>.ts`). Re-export from `packages/adapters/src/index.ts`.

Tests cover the happy path with realistic payloads, error translation (simulate provider errors), idempotency or retry behavior, and resource cleanup. Money flows add a regression test on sums and fee distribution. Integration tests start containers through `packages/test-utils/src/testcontainers`.

Done when: every port method is implemented and tested, provider errors are translated, the adapter is exported and wired in the composition root.

## Transport (tRPC)

`packages/transport/trpc/src/**`, Fastify glue in `apps/api/src/plugins/trpc.ts`. Transport is the thinnest layer: authenticate, validate, call one use case, map errors.

```text
packages/transport/trpc/src/
  router.ts          # appRouter: mounts every routers/<slice>.ts as router(xRouter)
  trpc.ts            # t = initTRPC.create: superjson transformer and errorFormatter
  init.ts            # publicProcedure / optionalProcedure / authedProcedure, rateLimit
  context.ts         # ctx: repos, ports, logger, clock, actorHumanId, ...
  guard.ts           # auth middleware
  utils.ts           # toTrpcError, appCodeToTrpc, errorCodeMap
  routers/<slice>.ts # plain object of procedures
  routers/__tests__/<slice>.test.ts
```

Recipe for a procedure:

1. Pick the base procedure: `publicProcedure` (no actor), `optionalProcedure` (actor if signed in), `authedProcedure` (requires a session). Each already carries the default rate-limit floor; add `.use(rateLimit({ key, maxRequests, windowSeconds }))` on top for sensitive procedures.
2. Input: import the use case's input schema and `.omit({ actorHumanId: true })`. The actor comes from `ctx.actorHumanId`, never from the client. If a schema has `.refine()`/`.transform()`, omit from its `Base` variant (Zod v4; see the anti-pattern in the standards).
3. Output: pass the use case's output schema to `.output(...)`.
4. Body: assemble `deps` from `ctx` with `satisfies Parameters<typeof useCase>[0]`, call the use case with `{ ...input, actorHumanId }`, and wrap in `try { ... } catch (err) { throw toTrpcError(err); }`. The one hop to core carries no business branching.
5. Register: add the procedure to `routers/<slice>.ts`; a new router is imported and mounted in `router.ts`.
6. New context needs (a port, a header) go in `context.ts` and the Fastify plugin, never read from globals.

```ts
getThing: authedProcedure
  .input(getThingInputSchema.omit({ actorHumanId: true }))
  .output(getThingOutputSchema)
  .query(async ({ ctx, input }) => {
    const deps = { repos: ctx.repos, logger: ctx.logger } satisfies Parameters<typeof getThing>[0];
    try {
      return await getThing(deps, { ...input, actorHumanId: ctx.actorHumanId });
    } catch (err) {
      throw toTrpcError(err);
    }
  }),
```

(Existing routers check `ctx.actorHumanId` and throw `UNAUTHORIZED` before this, as `routers/place-layouts.ts` does.)

Error mapping is `toTrpcError` in `utils.ts`; the status rules and the [wire contract](engineering-standards.md#wire-contract) are in the standards. Never leak stack traces, Prisma errors or provider payloads.

Other rules:

- Serialization is superjson, so `Date` and `bigint` cross the wire as such; enums stay plain strings.
- Derive organization context from auth. Never accept an org ID from the client without the use case checking the actor's role in it.
- Validate origins and CORS in Fastify before tRPC; strip tokens from query strings before logging; never log secrets or unredacted payloads.
- Domain sub-routers mirror `packages/core` slice names.
- Tests: `routers/__tests__/<slice>.test.ts` with mocked ports for schema validation and error mapping; extend `apps/api/test/smoke.ts` when Fastify wiring or serialization changes; add a regression test on any schema change, since web and mobile consume the output types.

Done when: the procedure is registered, error mapping is tested, and `pnpm typecheck:web` (and mobile/scanner if they consume it) still passes against the new `AppRouter` type.

## UI

Surfaces: `apps/web` (Next.js App Router), `apps/mobile` and `apps/scanner` (Expo), shared kit `packages/ui` (Tamagui: `src/ui/tamagui/{components,themes,tokens}`), `packages/ui-email` (React Email templates in `src/templates`). Visual identity, tokens and component choices come from `docs/design/design-system-v2.md` and the `ui` skill; this section covers the data and structure rules.

Recipe:

1. Name the tRPC procedure that supplies the data and its input and output types. UI never calls Prisma, adapters or core directly.
2. Reuse `@th/ui` primitives and tokens (`bg="$surface"`, `px="$4"`); add a primitive to `packages/ui` and export it from `packages/ui/src/index.ts` when more than one surface benefits.
3. Fetch with the typed hooks from `apps/web/src/trpc.ts` (`createTRPCReact<AppRouter>`, `AppRouter` from `@th/trpc`) in client components, or a `server-only` helper in `apps/web/src/server/` from server components. Set `staleTime`, `retry` and `enabled` explicitly, and invalidate with `trpc.useUtils()` after a mutation.
4. Build loading, empty, error and unauthorized states with the shared feedback components, and keep keyboard and focus behavior accessible.
5. Put user-facing strings in the message catalogs (`apps/web/src/i18n/messages`, `packages/locale`), never concatenated literals. Render errors with `normalizeError(err, t)` from `@th/errors`. Dates, times and money go through the shared formatters, never inline `Intl` or `toFixed`:
   - Event and venue times render in the venue's time zone through `formatDateTime` (`packages/types/src/datetime.ts`, `timeZone` required) or the `<DateTime>` component from `@th/ui`.
   - Money from cents: `formatCents` / `formatMoneyCents` (`packages/types/src/money.ts`, currency-aware including zero-decimal currencies; re-exported by `@th/core/lib/currency-utils` and `apps/web/src/lib/format.ts`), or `fmtCurrency(useFormatters(), cents, currency)` for the viewer's locale.
   - Trap: two functions are named `formatCurrency` with opposite units. `formatCurrency` from `@/lib/format` takes cents; `Translator.formatCurrency` (`useFormatters().currency`, `packages/locale/src/create-translator.ts`) takes major units (dollars) even though its parameter is typed `cents`. Likewise `formatDateTime` from `@/lib/format` takes no time zone and renders in the viewer's (or the server's) zone; for event and venue times use the `@th/types` one or `<DateTime>`.
6. Add a story or test for each state, then check mobile, scanner and email impact. Add a Help Center article for a user-facing flow (`apps/web/content/help`, `help-center-authoring` skill).

### Web structure

- Pages and layouts are server components by default. Add `"use client"` only for interaction or browser APIs, and keep `page.tsx` a light shell that imports the client islands from the route's `_components/` folder. Logic shared across routes goes to `packages/ui` or `apps/web/src/lib` / `apps/web/src/components`.
- Modules that must stay off the client start with `import "server-only";` (the pattern in `apps/web/src/server/*.ts`).
- Page metadata uses the Metadata API (`export async function generateMetadata`). JSON-LD components sit beside their route (`events/[...slug]/_components/EventJsonLd.tsx`, `p/[slug]/_components/EntityPageJsonLd.tsx`); pure builders live in `packages/types` (`seo/`) or core. Metadata and JSON-LD are built from the same public query result the page renders, never from viewer-specific state (`EventPageBody.tsx` feeds `EventJsonLd` the public event, not the address-revealed one).
- Server and client render the same markup: element ids come from `useId()`, and random values (client keys, editor row keys) are minted in handlers, never during render.
- Styling composes `@th/ui` Tamagui primitives; `apps/web/src/app/globals.css` holds resets and root tokens. Raw CSS only wraps third-party widgets.
- Wrap data-fetching islands in `Suspense` and use `next/image` for images. Render-time failures fall to `app/global-error.tsx`.
- Keep component base styles minimal: Tamagui resolves base styles before variants, so a key repeated in `variants` can be shadowed.
- Cross-surface rule: a web feature gets an impact check on mobile, scanner and email before it ships.

### Overlays

`AppOverlayProvider` (`apps/web/src/components/layout/AppOverlayProvider.tsx`, mounted in `app/providers.tsx`) wraps the app chrome in one `OverlayHost` from `@th/ui`. Features open sign-in and other auth panels through `useAppOverlay()` (`showSignInOverlay`, `showSignUpOverlay`, `showOverlayPanel`, `hideOverlay`) so the user is not redirected away. Overlay content mounts with `OverlayMount` (`packages/ui/src/ui/tamagui/components/overlay/`); give each overlay type a stable `id` and reuse it on reopen. `OverlayHost` defaults to `mode="single"`, which the app host uses: a mount replaces whatever was showing, so one overlay is visible per host; `mode="stack"` renders every mounted overlay as siblings in mount order, so at equal `zIndex` the last mounted paints on top. Overlays render props and state handed to them; network and workflow logic stays in the invoking feature or in core.

### UI tests

- Component tests: Vitest + Testing Library in `__tests__/` beside the component. Run web tests from `apps/web` and `packages/ui` tests from `packages/ui` (the config resolves relative to cwd).
- End-to-end: Playwright specs in `apps/web/e2e`; see Run It in CLAUDE.md for running them without wiping the dev database.
- Stories live beside the component (`*.stories.tsx` in `apps/web/src` and `packages/ui/src`).
- Test hooks follow [Test hooks](engineering-standards.md#test-hooks).

Done when: every state renders and is tested, the page was driven in the running app at 320px with no new console errors, and the Help Center is updated for user-facing flows.
