# UserCredit — Platform-Funded Account Credit

> Not built yet (2026-10-08 docs consolidation): Phase 2 staff grant UI + refund reversal, Phase 3 campaigns, Phase 4 finance reporting

**Date:** 2026-05-16
**Status:** in-progress
**Priority:** P3 (post-launch — unlocks signup bonuses, refund goodwill, marketing campaigns without organiser-payout impact)
**Replaces:** the "platform-wide promo code" (`scope: GLOBAL` on `Promo`) concept, which silently shifted organiser economics; `createPromo` rejects `scope: "GLOBAL"` as of 2026-05-16.
**Depends on:** Order checkout pipeline (`packages/core/src/use-cases/orders/create-checkout.ts`), refund pipeline, audit-log infrastructure.

---

## Status checklist

- [x] **Phase 1** — schema + grant + redemption (auto-apply at checkout). Unlocks signup bonuses. _(landed 2026-05-29: `credit.prisma` model + migration, `CreditsRepo`/`PrismaCreditsRepo`, `grantCredit` + `listCreditsForHuman`, atomic conditional redemption auto-applied in `createCheckout` (zero-charge + sub-minimum-cap handled), `credits.listMine`/`credits.grant` tRPC, read-only Account → Credits page. No staff grant UI yet.)_
- [ ] **Phase 2** — platform-staff grant UI + single-grant flow + refund reversal. Unlocks refund-goodwill workflow.
- [ ] **Phase 3** — campaigns / bulk grant with audience preview. Unlocks marketing-campaign use case.
- [ ] **Phase 4** — finance reporting (outstanding liability, breakage, per-campaign ROI, CSV export).

Update boxes above as phases land; flip the top-line `Status:` from `draft` → `in-progress` once Phase 1 starts, `implementation-ready` once the design is approved, `complete` only when all four phases ship. Move this file into `docs/specs/2026-05-16/completed/` once `Status: complete`.

## Premise

A `UserCredit` is a dollar amount granted to a specific human account, redeemable against any future order. **The credit comes out of platform margin, never out of organiser payout.** Buyers see a discount; organisers are paid in full; the platform absorbs the cost.

This replaces the half-built "platform-wide promo code" idea, which silently shifted organiser economics and had catastrophic leak risk. Credits avoid both problems:

- Tied to a *human*, not a code → can't be shared, can't be scraped from URLs
- Settlement math is unchanged for organisers → no trust violations
- The grant is explicit and audited → no surprise discounts appearing on events

## Use cases that justify this

| Scenario | Without credits today | With credits |
|---|---|---|
| Signup acquisition bonus | Build a one-shot platform promo (the scummy thing we rejected) | Grant `$5 welcome bonus, expires in 30 days` on first sign-in |
| Refund goodwill ("sorry for the bug, here's $10") | Issue a manual partial refund + email, no system memory | Grant credit with `reason: REFUND_GOODWILL`, auto-applies next time |
| Referral payouts ("you got a friend, $10 each") | None | Two `REFERRAL` credits, one per side |
| Platform marketing campaign | A risky GLOBAL promo code | Bulk-grant credits with `sourceType: PLATFORM_CAMPAIGN, campaignId`, segment opt-in |
| Influencer / partner spiff | Custom workflow, manual accounting | Bulk grant with audit trail; finance reports already roll up |

## Data model

```prisma
model UserCredit {
  id          String              @id @default(uuid())
  humanId     String
  amountCents Int                 // Always positive; redemption tracked separately.
  currency    String              @default("usd") @db.VarChar(3)

  /// What's the residual balance? Updated by RedemptionEntry rows below.
  balanceCents Int

  /// Why was this granted? Human-readable, surfaced in account UI.
  reason       String              // e.g. "Welcome to Ithas Fire"

  /// Source classification for analytics / anti-abuse limits.
  sourceType   UserCreditSourceType

  /// Optional: who granted it. NULL = system-issued (signup bonus, etc.).
  grantedByHumanId String?

  /// Optional: groups credits issued in the same campaign / refund event /
  /// referral pair. Useful for reporting and bulk-revoke.
  sourceRef    String?

  status       UserCreditStatus    @default(ACTIVE)
  expiresAt    DateTime?

  redemptions  UserCreditRedemption[]
  human        Human               @relation(fields: [humanId], references: [id], onDelete: Cascade)
  grantedBy    Human?              @relation("UserCreditGrantor", fields: [grantedByHumanId], references: [id], onDelete: SetNull)

  createdAt    DateTime            @default(now())
  updatedAt    DateTime            @updatedAt

  @@index([humanId, status])
  @@index([expiresAt])
  @@index([sourceType, sourceRef])
}

enum UserCreditStatus {
  ACTIVE     // Has positive balance, not expired
  REDEEMED   // Fully consumed
  EXPIRED    // Past expiresAt; balance forfeit
  REVOKED    // Platform staff clawback
}

enum UserCreditSourceType {
  SIGNUP_BONUS
  REFERRAL
  REFUND_GOODWILL
  PLATFORM_CAMPAIGN
  PARTNER_SPIFF
  MANUAL_STAFF_GRANT
}

model UserCreditRedemption {
  id              String   @id @default(uuid())
  creditId        String
  orderId         String
  amountCents     Int      // Always positive; how much of THIS credit was applied
  redeemedAt      DateTime @default(now())
  /// If the order is later refunded, this gets set and amountCents is added
  /// back to UserCredit.balanceCents (status returns to ACTIVE if needed).
  refundedAt      DateTime?

  credit          UserCredit @relation(fields: [creditId], references: [id], onDelete: Cascade)
  order           Order      @relation(fields: [orderId], references: [id], onDelete: Cascade)

  @@index([orderId])
  @@unique([creditId, orderId])  // Idempotent — same order can't redeem same credit twice
}
```

### Why a separate `UserCreditRedemption` table

- One credit can partial-apply across multiple orders (carryover)
- Reversibility — refunds restore the credit
- Audit — exact attribution of which credit funded which order line, queryable for finance reporting

### Where credits show up on the Order

The existing `OrderItem` already supports negative-amount discount rows (promos use this pattern). Credits add one row per redemption:

```ts
{
  kind: "platform_credit",
  ticketTypeId: undefined,
  qty: 1,
  unitPriceCents: -amountUsedCents,
  amountCents: -amountUsedCents,
  meta: { creditId, sourceType, reason },
}
```

This keeps OrderComputation honest — the buyer charge goes down, the organiser line items stay at full price, and the difference is platform-absorbed.

## Settlement math (the whole point)

For an order with `subtotalCents = 5000`, platform fee `500`, processing `162`, taxes `400`, and a `$10 platform credit` applied:

| Line | Today | With credit |
|---|---|---|
| Buyer charge | $51.62 | **$41.62** |
| Organiser payout | $50.00 | **$50.00** (unchanged) |
| Platform fee revenue | $5.00 | $5.00 |
| Platform credit expense | $0.00 | **−$10.00** |
| Net platform margin | $5.00 | **−$5.00** |

The credit is platform P&L, not organiser P&L. Settlement repo / payout math doesn't see the credit at all.

**Critical invariant to enforce in code:** `evaluateOrderComputation` (or wherever we build the Stripe `paymentIntentAmountCents`) subtracts credit redemptions from buyer charge, but the `organizerEntitlementCents` line is computed from the un-discounted ticket lines.

## Application order at checkout

When an order is being held / charged, in order:

1. Compute subtotal from ticket lines
2. Apply **promo discounts** (existing path — these reduce organiser payout, owned by organisers)
3. Apply **platform credits** (new — these reduce buyer charge only)
4. Add platform fee, processing fee, taxes
5. Buyer charge = subtotal − promo − **credits** + fees + tax
6. Settlement to organiser = ticket lines − promo − their share of fees (unchanged)

Step ordering matters: promos first means the credit applies to the *post-promo* subtotal. Otherwise the buyer could get $10 credit on a $5 ticket and we'd owe them $5 back, which we don't do.

## API surface (tRPC)

```ts
// Public-procedure equivalents — buyer reads their own balance
credits.listMine: authedProcedure  // returns ACTIVE credits + total balance
credits.history: authedProcedure   // includes redeemed / expired for transparency

// Internal — invoked from createCheckout
credits.previewRedemption: authedProcedure({ orderId })
  // → "you have $15 in credits; we'd apply $10 to this $42 order; $5 stays"

// Platform-staff (requirePlatformStaff)
credits.grant: authedProcedure({
  humanId, amountCents, reason, sourceType, sourceRef?, expiresAt?
})
credits.grantBulk: authedProcedure({  // For campaign rollouts
  audience: { allUsersCreatedAfter?, specificHumanIds? },
  amountCents, reason, sourceType, sourceRef, expiresAt
})
credits.revoke: authedProcedure({ creditId, reason })
credits.listAll: authedProcedure  // /platform/credits dashboard
```

System-issued credits (signup bonus) bypass the staff gate — they're fired from the auth flow with a service-internal call.

## UI surfaces

### Buyer-facing

- **Checkout order summary**: when a credit is auto-applying, show a green line `Platform credit: −$10.00 (Welcome bonus)`. Don't show a "remove" button — credits aren't optional discounts. (If they really want to save the credit, they can sign out.)
- **Account → Credits page**: list of active credits with balance + expiry, history of redemptions, total lifetime value granted.
- **No code input.** Buyers don't apply credits — they're auto-applied because they're tied to the account.

### Platform-staff facing

- **`/platform/credits`** — list of all credits with filter (status, sourceType, granted by). KPIs: total outstanding balance, total redeemed YTD, expiring soon.
- **`/platform/credits/grant`** — single-grant form (humanId or email lookup, amount, reason, sourceType, expiresAt).
- **`/platform/credits/campaigns`** — bulk-grant for marketing campaigns; preview audience size before commit.
- **Audit log entry** for every grant / revoke with actor + reason.

## Auto-apply rules

When `createCheckout` builds the order, query active credits for the buyer:

```sql
SELECT * FROM "UserCredit"
WHERE "humanId" = :buyerHumanId
  AND "status" = 'ACTIVE'
  AND ("expiresAt" IS NULL OR "expiresAt" > NOW())
  AND "balanceCents" > 0
  AND "currency" = :orderCurrency
ORDER BY
  "expiresAt" ASC NULLS LAST,   -- Use soonest-expiring first
  "createdAt" ASC               -- FIFO tie-breaker
```

Apply credits in that order until the order subtotal (post-promo) is fully covered or credits exhausted. Each application creates one `UserCreditRedemption` row and decrements the credit's `balanceCents`.

## Anti-abuse / safety rails

1. **Currency match required.** A USD credit can't apply to an EUR event.
2. **Lifetime cap per human per `sourceType`.** Configurable: e.g. lifetime $25 from `SIGNUP_BONUS`, unbounded from `REFUND_GOODWILL`. Enforced in `grant`.
3. **No-stack with refunds.** If an order is refunded, the redemption is reversed: credit balance is restored, refund amount excludes the credit portion (we don't pay cash for the platform's discount).
4. **Velocity check.** Same `sourceType + sourceRef` can't grant the same human twice (e.g. one signup bonus per account, enforced at grant via `@@unique`-style guard in code).
5. **Email/device fingerprint** signup bonus → also guard against multi-account farming. Out of scope for v1 but the schema doesn't preclude it.
6. **Audit-log every grant.** `grantedByHumanId` plus the existing platform audit-log table.
7. **No anonymous redemption.** Credits require an authenticated buyer — same auth gate as today's "Hold tickets" step.
8. **Org-isolation guarantee.** A test in `createCheckout` should assert that organiser entitlement is invariant whether a credit was applied or not.

## Refund interaction (the gnarliest edge case)

When `refundOrder` runs:

1. List `UserCreditRedemption` rows for the order
2. For each: mark `refundedAt = now()`, add `amountCents` back to `UserCredit.balanceCents`, flip status from `REDEEMED` → `ACTIVE` if needed (and the credit hasn't expired in the meantime)
3. The buyer refund amount = `paymentIntentAmountCents` (i.e. what they actually paid). Credits aren't refunded as cash.
4. The organiser payout reversal is unchanged — they always saw the full price; refund unwinds in full.

If a credit was granted by `REFUND_GOODWILL` originally and the underlying order then gets refunded, the goodwill credit *stays* with the user — separate fact, separate accounting.

## Reporting needs

Finance team will want:

- **Outstanding credit liability** = sum of `balanceCents` where `status = ACTIVE` — booked as a liability on the platform balance sheet
- **Credit expense YTD by sourceType** — for budgeting next year's signup-bonus pool
- **Breakage** (credits expired without redemption) — partially offsets liability
- **Per-campaign ROI** — for `PLATFORM_CAMPAIGN` credits, group by `sourceRef` and look at downstream conversion

## Build phases

See the checklist at the top. Rough effort estimates:

1. **Phase 1 — schema + grant + redemption** (~1 day)
   - Migration, prisma model, repo, `grantCredit`, `listCreditsForHuman`
   - Integrate into `createCheckout`: auto-apply, write redemption rows
   - Account UI: balance display, no admin grant UI yet (manual via prisma studio)
2. **Phase 2 — staff grant UI** (~1 day)
   - `/platform/credits` list page
   - Single-grant form with audit
   - Refund reversal logic
3. **Phase 3 — campaigns + bulk grant** (~1 day)
   - `/platform/credits/campaigns` with audience preview
   - `grantBulk` use case
   - Anti-abuse lifetime caps per source
4. **Phase 4 — reporting** (~0.5 day)
   - Finance dashboard tiles (outstanding liability, YTD expense, breakage)
   - CSV export

Phase 1 alone unlocks the signup-bonus use case (most-wanted thing). Phase 2 unlocks refund-goodwill. Phase 3 unlocks the marketing-campaign use case. Each builds on the last; ship Phase 1 first and let it bake.

## Open questions

- **Transfer between accounts?** No, hard no. Credits are non-transferable to avoid being scraped/sold.
- **Cash out?** No. Credits are platform-funded; no liability to pay them out as cash.
- **Apply at POS / scanner?** Probably yes, but the POS flow doesn't have a "buyer account" today — would need to wire the buyer human ID through the POS sale. Out of scope for v1.
- **Embed checkout?** Yes — anywhere `createCheckout` runs, credits auto-apply.
- **Signup-bonus amount?** TBD by you. Reasonable starting point: $5, expires 30 days. Use Phase 1 to seed-grant and measure conversion lift before scaling.

## What this replaces / informs

- **Replaces** the GLOBAL-scope promo concept. With credits, there's no need for a platform-wide promo code, and creating one is already blocked in `createPromo` (`packages/core/src/use-cases/promos/create-promo.ts`).
- **Doesn't touch** the existing per-org promo code system — those continue to work as today (organiser-funded, code-based).
- **Pairs nicely with `isPublic` promos** added 2026-05-16: marketing campaigns from organisers (URL-shareable codes, organiser-funded) coexist with platform credits (account-tied, platform-funded). Two different things, different use cases.
