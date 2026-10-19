# Decision: Split Prisma Schema into Multiple Files

**Status:** Proposed  
**Date:** 2026-03-04  
**Context:** `packages/db/prisma/schema.prisma` is 2,397 lines, 81 models, 59 enums. It's becoming painful to navigate, causes merge conflicts, and makes domain boundaries invisible.

> Status 2026-10-09: implemented — `packages/db/prisma/` holds `schema.prisma` (datasource and generator only) beside the per-domain `*.prisma` files, and `packages/db/package.json` generates with `--schema=prisma/`.

---

## How it works (Prisma 7)

Prisma 7 natively supports multi-file schemas. Instead of pointing `schema` at a single `.prisma` file, you point it at a **directory**. Prisma merges every `*.prisma` file in that directory (non-recursive, flat) into a single logical schema at CLI time. Cross-file references (relations, enums) work transparently — there is no `import` or `include` needed.

**One rule:** the `migrations/` directory must live at the same level as the `.prisma` file that contains the `datasource` block.

---

## Proposed directory layout

```
packages/db/prisma/
├── migrations/                  # unchanged, stays next to datasource file
├── schema.prisma                # datasource + generator only (~10 lines)
├── enums.prisma                 # all shared enums (59 enums, ~360 lines)
├── auth.prisma                  # Human, AuthUser, AuthAccount, AuthSession,
│                                  AuthVerification, AuthTwoFactor, Jwks,
│                                  ApiKey, HumanDelegate (~200 lines)
├── org.prisma                   # Organization, OrgSlugHistory, OrgMember,
│                                  OrgInvitation (~120 lines)
├── place.prisma                 # Place, PlaceSlugHistory, PlaceLayout,
│                                  SavedLocation, PlaceOwnership,
│                                  PlaceVerificationRequest,
│                                  PlaceVerificationDocument,
│                                  SeatSection, Seat (~250 lines)
├── finance.prisma               # Payee, FeePolicy, PayoutTerms,
│                                  PayoutTermsLine, OrderSplit, Settlement,
│                                  SettlementLine, OrderItemSettlementLine,
│                                  Payout, PayoutItem,
│                                  PayoutItemSettlement (~350 lines)
├── event.prisma                 # Event, EventHuman, EventUnlock,
│                                  EventMagicLink, EventSlugHistory, Category,
│                                  EventTemplate, EventSeries,
│                                  EventSeriesOccurrence, FeaturedEvent,
│                                  Image, AudioUpload (~400 lines)
├── application.prisma           # EventApplicationForm,
│                                  EventApplicationQuestion,
│                                  EventApplicationSubmission,
│                                  EventWaitlistEntry, InviteList,
│                                  InviteListEntry, ContactImport,
│                                  EventInviteList (~200 lines)
├── ticket.prisma                # Ticket, TicketType, TicketScan,
│                                  TicketTransfer, PendingTicketTransfer,
│                                  Coupon, CouponRedemption,
│                                  CouponHold (~250 lines)
├── order.prisma                 # Order, OrderItem (~150 lines)
├── resale.prisma                # ResaleListing, ResaleListingHold, Claim,
│                                  ResalePriceSnapshot (~100 lines)
├── notification.prisma          # PushDevice, Notification,
│                                  NotificationDigestSubscription,
│                                  NotificationDigestLog,
│                                  FeedbackRequest (~150 lines)
├── profile.prisma               # Profile, ProfileSlugHistory, ProfileTheme,
│                                  ProfileModule, Embed (~120 lines)
└── platform.prisma              # PlatformSetting, AuditLog, Idempotency,
                                   EventDailyStats (~100 lines)
```

**14 files** total (1 config + 1 enums + 12 domain files).

### Grouping rationale

| File | Domain boundary | Why grouped |
|---|---|---|
| `schema.prisma` | Infrastructure | Only `generator` + `datasource`. Anchor for `migrations/`. |
| `enums.prisma` | Shared | Enums are referenced across models. One file avoids circular placement questions. |
| `auth.prisma` | Identity | Everything related to who a user *is* and how they authenticate. |
| `org.prisma` | Multi-tenancy | Org creation, membership, invitations. |
| `place.prisma` | Venues | Physical locations, layouts, seating, verification. |
| `finance.prisma` | Money | Fee policies, payout terms, splits, settlements, payouts. Maps to `packages/core/src/lib/pricing` and the finance adapters. |
| `event.prisma` | Events | The core event entity and its direct children (roles, unlocks, slugs, media). |
| `application.prisma` | Gating | Application forms, waitlists, invite lists. All the "who can buy" gates. |
| `ticket.prisma` | Ticketing | Ticket lifecycle, types, scans, transfers, coupons. |
| `order.prisma` | Orders | Purchase records. Kept separate from finance (settlements) because orders are buyer-facing, settlements are payee-facing. |
| `resale.prisma` | Secondary market | Resale listings, holds, claims, price snapshots. |
| `notification.prisma` | Comms | Push devices, notification records, digest scheduling, feedback. |
| `profile.prisma` | Creator profiles | Public-facing profile pages, themes, modules, embeds. |
| `platform.prisma` | Ops | Platform settings, audit log, idempotency keys, analytics. |

### Alternative: enums inline vs. separate

Enums *could* live alongside the models that use them. The problem is many enums are shared (e.g., `OrderStatus` is used in both `Order` and `Ticket` via relations). A single `enums.prisma` is simpler to maintain and avoids "which file owns this enum?" debates. If a future enum is truly local to one domain (used by a single model), it can live in that domain file instead.

---

## Config changes required

### 1. `prisma.config.ts` (repo root)

```diff
 export default defineConfig({
-  schema: "./packages/db/prisma/schema.prisma",
+  schema: "./packages/db/prisma/",
   datasource: {
     url: process.env.DATABASE_URL ?? "postgresql://...",
   },
   migrations: {
     path: "./packages/db/prisma/migrations",
   },
 });
```

### 2. `packages/db/package.json`

```diff
 "prisma": {
-  "schema": "./prisma/schema.prisma"
+  "schema": "./prisma/"
 },
 "scripts": {
-  "generate": "node ... generate --schema=prisma/schema.prisma",
+  "generate": "node ... generate --schema=prisma/",
 }
```

### 3. Root `package.json` scripts

Remove all `--schema=packages/db/prisma/schema.prisma` flags. Once `prisma.config.ts` points at the directory, the CLI finds it automatically — the `--schema` flags become unnecessary (Prisma 7 resolves config first).

```diff
-"prisma:push": "pnpm exec prisma db push --schema=packages/db/prisma/schema.prisma",
+"prisma:push": "pnpm exec prisma db push",
-"db:migrate:dev": "pnpm exec prisma migrate dev --schema=packages/db/prisma/schema.prisma",
+"db:migrate:dev": "pnpm exec prisma migrate dev",
 ...etc
```

### 4. CI workflows (`.github/workflows/ci.yml`, `smoke.yml`)

No changes needed — they already use `pnpm exec prisma validate` / `pnpm exec prisma generate` without `--schema` flags, which resolve via `prisma.config.ts`.

### 5. Test containers (`packages/test-utils/src/testcontainers/postgres.ts`)

The `prismaSchemaPath` default needs to point at the directory:

```diff
-prismaSchemaPath = "prisma/schema.prisma",
+prismaSchemaPath = "prisma/",
```

### 6. Documentation updates

- `.github/copilot-instructions.md` — update the "After changing schema" section
- `packages/db/README.md` — update paths
- `README.md` — update the command reference table
- Any spec docs referencing the single file path

---

## Migration plan (zero-downtime, no data migration)

This is a **pure file reorganization** — the merged schema is byte-for-byte identical to the original. No Prisma migration is generated.

### Step 1: Create the files

```bash
cd packages/db/prisma

# Create domain files (initially empty)
touch enums.prisma auth.prisma org.prisma place.prisma \
      finance.prisma event.prisma application.prisma \
      ticket.prisma order.prisma resale.prisma \
      notification.prisma profile.prisma platform.prisma
```

### Step 2: Move content

Cut-paste from `schema.prisma` into domain files. Leave only `generator` + `datasource` in `schema.prisma`.

### Step 3: Update config

Apply the config changes listed above.

### Step 4: Validate

```bash
pnpm exec prisma validate      # schema is valid
pnpm exec prisma generate       # client generates identically
pnpm exec prisma migrate diff \
  --from-schema-datasource ./packages/db/prisma/ \
  --to-schema-datasource ./packages/db/prisma/ \
  --exit-code                   # exit 0 = no drift
```

### Step 5: Run tests

```bash
pnpm build
pnpm -F @th/core exec vitest --run
pnpm -F @th/adapters exec vitest --run
```

### Step 6: Single commit

One commit, one PR. No other code changes needed — the generated Prisma Client is identical.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| `prisma migrate diff` detects drift | Run the diff command in step 4. If it fails, content was lost during the split. Fix before merging. |
| Editor tooling breaks | The Prisma VS Code extension supports multi-file schemas since Prisma 5.15+. We're on 7.1. |
| Merge conflicts during transition | Merge the split PR first, then rebase in-flight branches. The rebase is mechanical — move model changes to the correct file. |
| Someone adds a model to the wrong file | PR review convention: model goes in the domain file that matches its adapter package. Add a comment at the top of each `.prisma` file listing its domain. |
| Enum placement confusion | Keep all enums in `enums.prisma` to start. Revisit if the file gets unwieldy (unlikely — enums are small). |

---

## What we gain

1. **Navigability** — 14 files of ~100-400 lines each instead of one 2,400-line monolith.
2. **Fewer merge conflicts** — Two developers touching `Event` and `Order` models no longer conflict.
3. **Domain visibility** — File names mirror the hexagonal architecture (`finance.prisma` maps to `packages/core/src/lib/pricing`, `packages/adapters/src/db/prisma/fee-policies.ts`, etc.).
4. **Onboarding** — New developers can read `ticket.prisma` in isolation to understand the ticketing domain without scrolling past 80 other models.

## What doesn't change

- Generated Prisma Client — byte-identical output.
- All `--schema` CLI commands — `prisma.config.ts` resolves the directory.
- Migration history — untouched, migrations stay in `packages/db/prisma/migrations/`.
- Runtime behavior — zero impact.
