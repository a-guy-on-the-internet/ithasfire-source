# Recurring Memberships

**Date:** 2026-08-05
**Revised:** 2026-08-08 — see Revision History
**Status:** shipped (2026-10-08 docs consolidation; was: draft)
**Priority:** P2 (High Value)
**Depends on:** `Order` / `OrderItem` / `OrderSplit` (`packages/db/prisma/order.prisma`), `FeePolicy` (`finance.prisma`), `Dispute` + `PayeeLedger`, `Promo` / `PromoHold`, Stripe Connect Express accounts (`stripe-adapter.ts`), ZipTax
**Supersedes:** n/a

## Revision History

**2026-08-08.** Five changes, three of them corrections to this document rather than new scope:

1. **The ticket-volume unlock gate is removed.** Connect bills $2 only in months an account *receives a payout*; deducting it from the membership payout makes memberships self-funding at one member. Break-even against Patreon lands at 2 members on a $10 tier. A gate was protecting against a cost that pays for itself.
2. **Membership tax is destination-sourced — the member's billing address, not the owner's.** The original owner-situs assumption was wrong, and it invalidates one `TaxRate` per tier. Digital subscriptions source to the buyer; event admissions are the exception that makes ticketing origin-based. The two products now need two sourcing rules.
3. **The promo prerequisites shipped** (`d2a9cef7`): `PromoScope.HUMAN` and POS discount support, which the benefit mechanism depends on.
4. **Platform fees compute pre-discount** (verified in code), so member discounts cost platform revenue nothing. The KPI is ticket *volume*, not fee revenue, which settles that permissively.
5. **Stripe Tax was reconsidered for memberships and rejected again**, this time on measured numbers rather than inherited assumption.

---

## Problem

Small venues and solo artists have no reliable recurring revenue, and the ticketing fee delta alone does not close a structural deficit. DRKMTTR Collective publishes its own P&L: roughly $25k income against $26k expenses in July 2026 — about $1,000/month underwater. Switching their ticketing to us is worth ~$1.87/ticket, which needs ~535 tickets a month to close that gap. **100 members at $10/month closes it outright**, and is far more predictable.

The existing options are all bad for this segment. Patreon takes an effective **13–19%** (worst at the $3–$5 tiers where the volume actually is, because Stripe's $0.30 fixed fee is 6% of a $5 charge before anyone's cut). Opendate shipped Memberships in April 2026, but built it around presale access to shows that sell out — worthless at an all-ages DIY room where nothing sells out and the entire identity is that anyone can walk in. DRKMTTR is on Opendate today and has not turned it on.

---

## Goal

Recurring memberships for **orgs and humans**, at **0% platform fee** — we pass through what Stripe charges us and take nothing. Anyone with a payee account can turn them on; the only cost we recover is Stripe's $2 monthly active-account fee, deducted from the membership payout in months the account would not otherwise have been active. Member benefits are delivered as **automatically-attached promos** at ticket checkout (free entry to open mics, a standing discount), which is the differentiator: a benefit that means something at a room where scarcity is not the lever.

Memberships are not the revenue engine. They are customer acquisition for ticketing and the most durable lock-in in the product — a venue with 200 recurring members on our rails cannot switch without asking all 200 to re-enter card details.

---

## Context

| What exists | Where |
|---|---|
| `OrderItem.kind` extensible discriminator (7 kinds, `ticketTypeId` nullable for non-ticket kinds) | `packages/db/prisma/order.prisma:127-155` |
| `Order.eventId` — **non-nullable `String`**, the main blocker | `packages/db/prisma/order.prisma:8` |
| `FeePolicy` with `buyerFeePct` / `maxFeeCents` / `minFeeCents` / `platformFixedCents` / `feeMode` | `packages/types/src/repos/fee-policies.ts` |
| Per-ticket fee formula `max(min(price × pct, maxFee) + fixed, minFee)` | `packages/core/src/lib/pricing/compute-ticket-price-for-agreement.ts:140-150` |
| Dispute lifecycle + capped per-payee holds allocated across order splits | `packages/core/src/use-cases/disputes/shared.ts:370-406` |
| Dispute webhook mapping — reads `dispute.amount` **only** | `apps/api/src/routes/stripe/webhook.ts:833` |
| Stripe Connect **Express** account creation (platform pays the monthly active-account fee) | `packages/adapters/src/payment-processors/stripe/stripe-adapter.ts:308` |
| Embed checkout (inline, themeable, `onOrderComplete` hook) | `apps/web/src/app/embed/[embedId]/` |
| Promo / PromoHold models | `packages/db/prisma` |
| **`PromoScope.HUMAN`** — seller-wide scope for direct/personal sellers, with the mandatory `event.orgId == null` guard so a human's promo can never discount an org's revenue. **Shipped `d2a9cef7`** | `packages/db/prisma/enums.prisma`, `promos/scope-ownership.ts`, `orders/checkout-promos.ts` |
| **POS discount support** — promos threaded through `start` / `complete` / `record-cash` / `refund-cash`, reusing `evaluatePromoApplications` so there is one discount computation and one PromoHold/PromoRedemption ledger. **Shipped `d2a9cef7`** | `packages/core/src/use-cases/pos/` |
| Tax rate lookup port (`postalCode` → `rateBps`), no adapter-level cache | `packages/ports/src/tax-rate-lookup.ts`, `adapters/src/tax-rate-lookup/ziptax-adapter.ts` |

**No subscription or membership models exist today.** Every "recurring" hit in the codebase refers to recurring *events*, not recurring billing. This is a clean slate.

---

## Data Model

```prisma
/// A named recurring support tier offered by an org or a human.
model MembershipTier {
  id                String   @id @default(uuid())

  /// Exactly one of ownerOrgId / ownerHumanId is set.
  ownerOrgId        String?
  ownerHumanId      String?

  name              String   /// "Sustaining Member"
  description       String?
  priceCents        Int      /// integer cents, never floats
  currency          String   @default("usd")
  interval          String   /// "month" | "year"

  /// Stripe Billing objects created lazily on first publish.
  stripePriceId     String?  @unique
  stripeProductId   String?

  /// What this tier DELIVERS, which is what decides taxability — digital
  /// content, discounted admission, or tangible goods are taxed differently
  /// and a tier bundling them is a mixed-supply problem. The rate itself is
  /// NOT stored here: membership tax is destination-sourced, so it depends on
  /// each member's address, not the tier. See MembershipTaxJurisdiction.
  taxCategory       String   @default("DIGITAL") /// DIGITAL | ADMISSION | TANGIBLE | MIXED

  status            String   @default("DRAFT") /// DRAFT | ACTIVE | ARCHIVED
  sortOrder         Int      @default(0)

  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@index([ownerOrgId, status])
  @@index([ownerHumanId, status])
}

/// One member's active (or lapsed) subscription to a tier.
model Membership {
  id                   String   @id @default(uuid())
  tierId               String
  memberHumanId        String

  stripeSubscriptionId String   @unique
  stripeCustomerId     String   /// PLATFORM-owned customer — one card across all venues

  /// Which jurisdiction's rate this subscription is currently billed at.
  /// Re-resolved when the member's billing address changes (usually without a
  /// ZipTax call, if that postal code is already cached).
  taxJurisdictionId    String?
  billingPostalCode    String?
  billingCountryCode   String?  @db.VarChar(2)

  status               String   /// ACTIVE | PAST_DUE | CANCELED | UNPAID | INCOMPLETE
  currentPeriodStart   DateTime
  currentPeriodEnd     DateTime
  cancelAtPeriodEnd    Boolean  @default(false)
  canceledAt           DateTime?
  startedAt            DateTime @default(now())

  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt

  @@index([memberHumanId, status])
  @@index([tierId, status])
  @@index([status, currentPeriodEnd])
}

/// Benefit granted by a tier, auto-applied at ticket checkout.
model MembershipBenefit {
  id           String   @id @default(uuid())
  tierId       String

  kind         String   /// "promo" | "presale_access"
  promoId      String?  /// for kind="promo"
  /// Optional narrowing: only applies to events matching these.
  categoryId   String?
  placeId      String?

  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@index([tierId])
}

/// Risk state for an owner's memberships. NOT an unlock gate — memberships
/// are open to any payee (see "The $2 account fee"). This exists purely so a
/// bad actor can be stopped.
model MembershipStanding {
  id                 String   @id @default(uuid())
  ownerOrgId         String?
  ownerHumanId       String?

  /// Circuit breaker — suspends new signups and holds payouts when dispute
  /// losses cross a threshold.
  suspended          Boolean  @default(false)
  suspendedAt        DateTime?
  suspendedReason    String?

  /// Rolling reserve applied to membership payouts. Seasons DOWN as the payee
  /// builds history — it must apply to NEW payees from day one, since that is
  /// when self-dealing cash-out risk is highest and dispute history is empty.
  reserveBps         Int      @default(0)
  reserveReleaseDays Int      @default(90)

  /// Set when a platform admin intervenes either way.
  overriddenBy       String?
  overrideReason     String?

  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  @@unique([ownerOrgId])
  @@unique([ownerHumanId])
}

/// Cached sales-tax rate for ONE jurisdiction, shared by every member in it.
///
/// Membership tax is destination-sourced, so the rate is a property of the
/// PLACE, not the person — 80 Nashville members share one row rather than
/// holding 80 copies that drift apart. This also collapses ZipTax call volume
/// to one lookup per distinct postal code per refresh window, regardless of
/// member count, which is what keeps us inside the flat-rate tier.
///
/// Maps 1:1 onto a Stripe TaxRate object referenced by many subscriptions via
/// `default_tax_rates`, which keeps the immutable-`percentage` problem bounded:
/// a rate change archives one TaxRate, creates one replacement, and migrates
/// the subscriptions pointing at it.
model MembershipTaxJurisdiction {
  id              String   @id @default(uuid())
  countryCode     String   @db.VarChar(2)
  postalCode      String
  /// Taxability varies by what is being sold, so the same ZIP can hold more
  /// than one rate.
  taxCategory     String

  rateBps         Int
  rateSource      String   /// "ziptax" | "static-ca" | "manual" | "exempt:*"
  stripeTaxRateId String?  @unique

  /// Freshness, NOT member-initiated. Rates change on quarterly boundaries
  /// with no signal from the member, so a member-change-only invalidation
  /// would bill a stale rate indefinitely.
  checkedAt       DateTime
  effectiveFrom   DateTime?
  archivedAt      DateTime?

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@unique([countryCode, postalCode, taxCategory, archivedAt])
  @@index([checkedAt])
}
```

### Changes to existing models

```prisma
model Order {
  /// BREAKING: becomes nullable. A membership invoice has no event.
  eventId  String?
  /// Discriminator so membership orders are trivially separable in every
  /// report, settlement query and export.
  kind     String  @default("TICKETING")  /// TICKETING | MEMBERSHIP
  @@index([kind])
}

model OrderItem {
  /// New kind: "membership" — membershipId set, ticketTypeId null.
  membershipId String?
}

model Dispute {
  /// Stripe's dispute fee (typically $15), read from
  /// dispute.balance_transactions[].fee. Currently NEVER captured.
  feeCents        Int      @default(0)
  /// Who absorbed the fee, decided by policy at dispute time.
  feeBorneBy      String?  /// PLATFORM | PAYEE
}
```

### The `Order.eventId` decision

Making `eventId` nullable touches the most load-bearing table in the system. Every settlement path, report, export and query that assumes an event exists must be audited. The alternative — a synthetic event per org — is worse: it leaks into search, listings and stats permanently.

**Decision: make it nullable, and add `Order.kind` in the same migration** so every existing consumer can be narrowed to `kind = "TICKETING"` rather than relying on `eventId` being present. Treat the audit of read sites as a first-class step of the build, not a follow-up.

---

## Use Cases

All in `packages/core/src/use-cases/memberships/`. Stateless factories, Zod in/out, typed error codes, single `repos.tx()` per mutation, `IdempotencyPort` on everything that moves money.

| Use case | Notes |
|---|---|
| `createMembershipTier` / `updateMembershipTier` / `archiveMembershipTier` | Creates the Stripe Product + Price lazily. `priceCents` immutable after first subscriber — archive and replace instead. Changing `taxCategory` re-resolves every subscriber's jurisdiction rate. |
| `attachTierBenefit` / `removeTierBenefit` | Links a `Promo` to a tier. Promos may now be `HUMAN`-scoped (shipped in `d2a9cef7`), which is what lets a solo artist grant a benefit across all their own events. |
| `resolveMemberTaxJurisdiction` | Maps a member's billing address to a `MembershipTaxJurisdiction`, creating and caching the row (one ZipTax call) only when that postal code + category is not already known. Called on signup and on billing-address change. |
| `refreshTaxJurisdictions` | **Scheduled job, quarterly at minimum.** Re-looks-up every non-archived jurisdiction, archives changed rates, creates replacements, and migrates the subscriptions pointing at them. This is the ONLY trigger that catches a jurisdiction changing its rate — no member-initiated event can. |
| `suspendMembershipStanding` / `overrideMembershipStanding` | Platform-admin only. Writes `overriddenBy` + `overrideReason` to the audit log. |
| `startMembership` | Creates the Stripe Subscription on the **platform** account against a platform-owned Customer. Idempotent on `(memberHumanId, tierId)`. |
| `cancelMembership` | Sets `cancel_at_period_end` by default; immediate cancel is a separate explicit path. |
| `recordMembershipInvoicePaid` | Webhook-driven. Materialises an `Order` (`kind = MEMBERSHIP`, `eventId = null`) with one `OrderItem` (`kind = "membership"`) and its `OrderSplit`s, so settlement, refunds, ledger and dispute holds all work unchanged. Idempotent on `stripeInvoiceId`. |
| `recordMembershipPaymentFailed` | Marks `PAST_DUE`; Stripe Billing owns the retry schedule. |
| `resolveMemberBenefits` | Called during ticket checkout. Returns promos the buyer's active memberships entitle them to, auto-applied without a code. |
| `sendRenewalNotice` | Driven by Stripe's `invoice.upcoming` webhook. Sends tier name, amount, date and a one-click cancel link. **Load-bearing for dispute prevention, not a nicety.** |
| `recordDisputeFee` | Extends the existing dispute lifecycle to read `dispute.balance_transactions[].fee` and persist `feeCents`. |

### Money and payout architecture

- **Platform-owned Stripe Customer**, so a member supporting three Nashville venues enters their card **once**. A Customer created on the connected account would force re-entry per venue.
- **No `transfer_data.destination`.** Membership money settles through our existing pipeline as Orders, which is what gives us payout timing control and the dispute-hold machinery. This is a deliberate revision of the earlier design — destination charges move money at charge time and forfeit both.
- **We are merchant of record** by construction. Dispute liability is structurally ours; there is no liability-shift option.
- **0% platform fee.** `application_fee_percent` is 0 today; the field stays wired so a future non-zero rate is a config change.
- **Fee mode:** default `ABSORB` so the member pays a clean $10.00. At $5/mo the owner nets ~$4.55 vs Patreon's $4.06.
- **The KPI is ticket VOLUME, not fee revenue.** Memberships are acquisition; the return is measured in tickets moved, not in membership margin. This settles the discount question permissively — see below.

### Tax: destination-sourced, and it is not the same rule as tickets

The product now has two sourcing rules and they are genuinely different:

| | Sourced to | Engine |
|---|---|---|
| Ticket (admission) | The **venue** — admissions are the standing exception to destination sourcing | ZipTax, origin-based (already built) |
| Membership (digital subscription) | The **member's billing address** | ZipTax, same API, member's postal code |

Patreon does the same thing and says so plainly: tax is charged "based on the location of the member/customer and not of the creator." The original owner-situs assumption in this spec was simply wrong.

**ZipTax still handles it** — it is a postal-code → rate lookup, and destination sourcing just means passing the member's code instead of the venue's. No new vendor. The complexity lands in the jurisdiction cache and the Stripe `TaxRate` lifecycle, not in the calculation.

#### Fail closed: if we cannot price a jurisdiction, we do not sell into it

Membership signup is **refused** when the rate cannot be resolved. This is the opposite of the ticketing path, where `resolveCheckoutTax` degrades to a 0 rate rather than block a checkout, and the difference is deliberate:

We are merchant of record, so tax we fail to collect is tax **we owe**. A ticket is one charge and a one-off shortfall. A membership re-bills every period, so a silently-zeroed rate compounds a liability on our own books for the life of the subscription — and we would not discover it until a registration forced a reconciliation. Refusing the signup is far cheaper than that.

Two failures, kept distinct because they need different responses:

| | Meaning | Response |
|---|---|---|
| `TAX_JURISDICTION_UNSUPPORTED` | The provider answered and does not cover this place | Normal business rejection. Logged, **not** reported — ZipTax is US-only, so Sentry would otherwise fill with every non-US attempt and bury real outages. Retrying changes nothing. |
| `TAX_JURISDICTION_UNAVAILABLE` | The provider errored | Our outage. Reported via `ReporterPort` and worth retrying. |

Nothing unpriceable is ever cached — a jurisdiction row exists only when we know what to charge. A `rateBps` of 0 is therefore always a real answer from a real no-sales-tax jurisdiction (Delaware, Montana, New Hampshire, Oregon), never a placeholder for "we gave up".

**Consequence, stated plainly: memberships are US-only at launch.** ZipTax does not cover non-US addresses, so every non-US signup is refused by construction. That is the honest position rather than a silent 0% — but it is a real product limit, and it is the same coverage gap that already exists on ticketing for Canada.

The refresh job takes the opposite stance for rows that already exist: a provider failure leaves the live rate **untouched** rather than archiving it. An outage is not evidence a jurisdiction stopped taxing, and existing members keep their last known-good rate.

**A `TaxRate` object is not Stripe Tax.** Worth stating explicitly, because the naming invites the confusion. Stripe Tax is `automatic_tax: { enabled: true }` — a calculation engine that decides rates and tracks nexus, billed per transaction. It is not used, and `automatic_tax` must never appear in the codebase. A `TaxRate` is a stored percentage *we* supply from ZipTax; Stripe only multiplies and renders it, at no charge. The alternative (injecting our own tax line item, as ticketing does) does not transfer, because Stripe invoices subscriptions unattended on every renewal — it would mean intercepting `invoice.created` before finalization forever, and one missed interception silently under-collects.

**Stripe Tax was reconsidered here and rejected on measured numbers**, so this does not get re-litigated:

- Stripe Tax Basic is 0.5% per transaction with **no monthly fee**, charged only *where you are registered to collect*. We are registered nowhere, so it would cost **$0 today** — the previously recorded "per-transaction + monthly fees" reasoning was inaccurate.
- Once registered, at ~535 tickets/month it is **~$67/month and rises with GMV forever**. ZipTax is **free to ~$29/month flat** at our call volume, because origin sourcing means one cached lookup per event and the jurisdiction cache means one per postal code.
- The decisive argument is shape, not today's price: **0.5% of GMV is a tax on growth**, which is the wrong cost structure for a platform whose entire position is being structurally cheaper because it monetises elsewhere.
- Where Stripe Tax genuinely competes is *filing*, not calculation — Tax Complete at $90/mo bundles registrations and filings. Revisit only if registrations reach roughly four states and only against the incumbent filing vendor, never as a calculation engine.

**Nexus is ours and it aggregates.** As merchant of record the $100k economic-nexus thresholds accrue to the platform, and membership revenue counts toward the *same* per-state threshold as ticket revenue rather than running its own clock. The existing threshold-watch rollup is the instrument; memberships just shorten the runway slightly.

**Rate staleness is a pre-existing bug this design also fixes.** `resolveCheckoutTax` uses `event.admissionTaxRateBps` whenever it is non-null, with no TTL — the rate is stamped at publish and used forever, so an event published in November for a June show sells at November's rate. Harmless today (registered nowhere, remitting nothing) and live the moment we register. One jurisdiction cache with a scheduled refresh covers both memberships and this, rather than two caches with two staleness stories.

### Member discounts and the fee base

Platform fees compute **pre-discount** — verified in code: `computeOrderAmounts` derives `feesPlatformCents` from ticket prices, and promos only subtract from gross afterwards. So a member discount drives volume at **zero cost to platform revenue**, which is a better answer than the permissive one and requires no change.

Two consequences:

- An order discounted **all the way to zero** must carry no fee at all. That path routes to `claimFreeTickets`, which was persisting the pre-discount fees against a $0 order — fixed by `zeroFeesForFreeOrder()` in `checkout-helpers.ts`. Load-bearing here, because "free entry to open mics" is this spec's flagship benefit and it would otherwise have rendered as *Ticket $0.00 / Fee $1.87*.
- Discounts must stay **measurable**. `PromoRedemption.amountDiscountCents` already records every one, so margin deliberately given away is queryable rather than invisible.

### Never a donation

Some owners will book membership income as charitable contributions. That is their bookkeeping and their disclosure obligation — a 501(c)(3) receiving a quid pro quo payment over $75 owes the donor a written benefit-value estimate, at $10 per contribution in penalties for failing to.

**We must never facilitate it as one.** A "tax-deductible" toggle, a donation receipt, or any marketing of deductibility makes us a charitable fundraising platform under California **AB 488**: AG registration, mandatory disclosures, per-charity written consent, good-standing checks against IRS + FTB + AG, and **segregation of funds** — which fights the MoR + Payee ledger outright. Patreon does not facilitate donations either, so declining to costs us no ground. Note also that deductibility and our differentiator are in direct tension: ticket discounts have trivially computable fair market value, so every benefit that beats Patreon shrinks the deductible portion. The most we should build is a field where an owner states their own tier benefits and their value — their claim, not ours.

### The $2 account fee — deducted, not gated

Stripe bills the **platform** $2 per Express connected account, but only for months in which that account **receives a payout**. Dormant accounts cost nothing. So the fee is triggered by the payout, not by the membership — and the fix is to take it out of the payout rather than to gate who may have one.

**The rule, stated the way it should be said to a venue:** *"If you sold tickets this month, memberships cost you nothing. If you didn't, we deduct the $2 Stripe charges us to pay you."* An account already settling ticket revenue was active regardless, so its membership payout carries genuinely zero marginal cost and nothing is deducted. The $2 only appears when memberships are the sole reason the account went active.

Deduct it from the payout; never charge it separately. We are merchant of record and the money already flows through our pipeline as Orders, so withholding costs nothing — whereas *collecting* $2 burns ~$0.36 in processing to recover $2, an 18% loss on the recovery.

Break-even against Patreon, monthly payouts, $2 deducted only in ticket-free months:

| $10/mo tier | Patreon nets | We net |
|---|---|---|
| 1 member | $8.41 | $7.41 |
| **2 members** | $8.41 | **$8.41** |
| 3 members | $8.41 | $8.74 |
| 10 members | $8.41 | $9.14 |

Two members on a $10 tier, four on a $5 tier — and from the first member for anyone selling tickets. That is arithmetic a venue can check, not a gate anyone is blocked by, which is why the eligibility gate is gone.

**Payouts stay monthly.** Quarterly payout batching would cut the fee to ~$8/year and was considered and rejected: a venue $1,000/month underwater will not accept "your membership income arrives in April." Guard the pathological case with `payoutMinimumCents` instead — a threshold, not a schedule — so we never take $2 out of a $3 payout. That only delays accounts whose monthly total is smaller than the cost of moving it, and payout minimums are industry-normal (Patreon has them), so it is sayable as parity rather than as a penalty.

### Dispute policy

- Capture `feeCents` on every dispute **regardless of the rest of this spec** — it is currently invisible, meaning dispute cost cannot be measured on ticketing either, where one $15 fee erases 30 tickets of platform revenue.
- **Absorb on ticketing, debit to the payee on memberships.** Stated at membership setup, not buried in terms — the venue is being debited for a third party's action and must have actively seen it.
- **Prevention does the heavy lifting**, and is not optional:
  1. Statement descriptor = the **venue's** name (22-char Stripe cap means the tier will not fit; tier lives in the receipt and email).
  2. Pre-renewal email off `invoice.upcoming`.
  3. Self-serve cancel via the Stripe customer portal — the single best argument for paying Billing's surcharge.
- **Rolling reserve** rather than a blanket payout delay: hold a small percentage of membership revenue for 90 days, released if no dispute lands. A reserve is deferred payout, not revenue — consistent with taking 0%. It must apply to **new and unproven payees from day one** and season down with history, not switch on after a dispute — a brand-new payee has no dispute history, and that is precisely when the risk peaks.
- **Circuit breaker:** `MembershipStanding.suspended` when an account's dispute losses cross a threshold.
- **The abuse vector is not account farming.** N shell accounts with one member each cannot run away: the $2 fires only on payout and is withheld from that same payout, so it self-balances at any N, and sub-threshold balances never pay out and are never charged. Express carries Stripe's own KYC on top. The real exposure is **self-dealing cash-out** — subscribing stolen cards to your own tier and collecting before chargebacks land — which is what the reserve above is actually for.

Sizing, so this stays in proportion: 200 members × 12 months at a post-mitigation ~0.2% dispute rate is ~5 disputes/year ≈ **$125/year**, of which a reserve recovers most. The uncollectable tail is on the order of **$40/year per venue**. Bound it; do not over-engineer it.

---

## UI / Flow

**Owner (org or human):**
1. `/admin/{slug}/memberships` — open to any payee, no locked state. Setup states the $2 rule plainly ("free in any month you sell tickets; $2 deducted from your payout otherwise") and the chargeback debit policy.
2. Create tiers: name, price, interval, description, `taxCategory`, benefits (pick existing promos).
3. Publish → Stripe Product/Price created; a shareable join link plus an embed widget.

**Member:**
1. Join page or embed → pick tier → Stripe Billing checkout → confirmation.
2. Renewal email before each charge with tier, amount, date, cancel link.
3. Self-serve management via the Stripe customer portal.
4. At ticket checkout, entitled promos apply **automatically, with no code**, and the line is labelled so the member sees the benefit working.

**Platform admin:** view dispute-fee exposure per account, set/clear a rolling reserve, suspend/unsuspend.

---

## Acceptance Criteria

- [ ] A membership invoice paid in Stripe produces exactly one `Order` with `kind = MEMBERSHIP`, `eventId = null`, one `OrderItem` with `kind = "membership"`, and correct `OrderSplit`s.
- [ ] Replaying the same `invoice.payment_succeeded` webhook creates no duplicate order (idempotent on `stripeInvoiceId`).
- [ ] A member with two memberships at two different orgs has exactly **one** Stripe Customer and one saved card.
- [ ] Platform fee on every membership order is **0**; the member's total equals the tier price exactly under `ABSORB`.
- [ ] Tax is applied from the **member's** jurisdiction (their billing postal code + the tier's `taxCategory`), never the owner's or a venue's, and appears on the invoice.
- [ ] Two members in the same postal code and category share **one** `MembershipTaxJurisdiction` row and **one** Stripe `TaxRate` — the second signup makes no ZipTax call.
- [ ] Changing a member's billing address re-resolves their jurisdiction, and makes no ZipTax call when the new postal code is already cached.
- [ ] `refreshTaxJurisdictions` detects a changed rate, archives the old `TaxRate`, creates a replacement, and migrates every subscription referencing it — verified by a test that changes a rate with **no** member-initiated event.
- [ ] A signup from a jurisdiction the rate provider does not cover is **refused** (`TAX_JURISDICTION_UNSUPPORTED`), writes no jurisdiction row, and is not reported to Sentry.
- [ ] A signup during a rate-provider outage is **refused** (`TAX_JURISDICTION_UNAVAILABLE`), writes no jurisdiction row, and IS reported.
- [ ] A genuine 0% jurisdiction is cached and billed as 0 — never conflated with an unresolvable one.
- [ ] A provider failure during refresh leaves the existing live rate untouched; it is never archived or zeroed on an outage.
- [ ] Any payee can create and publish a tier — there is no ticket-volume gate. A suspended `MembershipStanding` blocks new signups and writes an audit entry.
- [ ] A membership payout in a month with **no** ticket sales has $2 deducted; a payout in a month **with** ticket sales has nothing deducted.
- [ ] A membership balance below `payoutMinimumCents` does not pay out, and therefore is never charged the $2.
- [ ] An active member checking out for a ticket has the entitled promo applied automatically with no code entered, and sees a labelled discount line.
- [ ] A canceled or `PAST_DUE` membership grants **no** benefits at checkout.
- [ ] A benefit that covers the ticket entirely (free entry to an open mic) produces a $0 order carrying **no** platform fee, no buyer fee and no processor fee — not a $0 ticket with a fee line.
- [ ] A **partial** member discount leaves the platform fee unchanged, since fees compute pre-discount.
- [ ] `Dispute.feeCents` is populated from `dispute.balance_transactions[].fee`, updating across lifecycle events (the fee is typically absent at `charge.dispute.created` and materialises at `funds_withdrawn`).
- [ ] A dispute on a membership order writes a `DISPUTE_DEBIT` to the payee for amount **and** fee; a dispute on a ticket order debits the amount only and records the fee as platform-borne.
- [ ] The statement descriptor on a membership charge renders the owner's name, within Stripe's 22-character limit.
- [ ] A renewal notice fires ahead of each charge and contains tier name, amount, date and a working cancel link.
- [ ] Every existing report, export and settlement query returns identical results after `Order.eventId` becomes nullable (audited read site by read site, not assumed).
- [ ] `/about` and `/features` describe memberships **only once shipped**, and every claim on those pages is true of the running product (see Documentation below).
- [ ] A help article exists at `apps/web/content/help/organising-events/memberships.md` covering: turning memberships on (including the ticket gate and what to do if you're below it), creating tiers, attaching benefits, what the member sees and pays, what *you* receive, the chargeback debit policy, and how a member cancels.
- [ ] The chargeback debit policy appears at membership **setup** in the admin UI, not only in the help article or terms.
- [ ] `docs/stripe-fee-reference.md` fee reference records the Stripe numbers this spec depends on, each with a source URL and a checked-on date.

---

## Documentation

Shipping this is not done when the code works. Three surfaces have to move with it, and **none of them may describe memberships before the feature is live** — a marketing page that promises something the product doesn't do is worse than a page that omits it, especially when venue conversations start at the website.

| Surface | What changes | Where |
|---|---|---|
| Help article | New: turning memberships on (ticket gate + what to do below it), creating tiers, attaching benefits, what the member pays and sees, what the owner receives, the chargeback debit policy, how a member cancels | `apps/web/content/help/organising-events/memberships.md` — follow `[skill:help-center-authoring]`; ground it in shipped code, not in this spec |
| Related help articles | Cross-link from the embed-widgets and manage-ticket-types articles once member promos apply at checkout | `apps/web/content/help/organising-events/` |
| `/about` + `/features` | Add memberships **only on ship**. Every existing claim on these pages must be re-verified at the same time — see below | `apps/web/src/app/` |

**Standing requirement, wider than this spec:** `/features` is known to list capabilities that are backend-only or unwired (credits, Spotify, templates, magic-link, analytics — see the features-page gap note). Before any venue outreach, every claim on `/about` and `/features` needs checking against the running product and either proving true, qualifying, or removing. Treat that audit as a prerequisite for outreach, not a follow-up to it.

---

## Open Questions

### Answered since the first draft

- ~~Does Stripe bill the Connect account fee per *active* account or per existing account?~~ **Per active account, where "active" means a month in which the account receives a payout.** Dormant accounts cost nothing. This is what removed the unlock gate. Still worth confirming against our own Stripe invoices, which beat any documentation page.
- ~~Situs for membership tax.~~ **Destination — the member's billing address.** Not the owner, not a venue. See the tax section.
- ~~Should we use Stripe Tax for memberships?~~ **No.** Reconsidered on measured numbers and rejected; revisit only for *filing*, at roughly four registered states.
- ~~Does a discount reduce the base the platform fee computes on?~~ **No — fees compute pre-discount**, verified in code. Member discounts cost platform revenue nothing.
- **Current Stripe pricing** — partially verified 2026-08-08: Connect Express $2/mo per active account + payout 0.25% + $0.25; Billing 0.7%; Stripe Tax Basic 0.5% where registered, no monthly fee. **Still unverified: the dispute fee** used throughout this spec. The fee-reference doc TODO stands.

### Still open

- **Tennessee taxability of membership dues — no longer blocking the data model.** With sourcing settled, the model is a jurisdiction-keyed rate cache plus a `taxCategory` on the tier: the TN answer fills in a *value*, it does not change the *shape*. So this blocks charging correctly at scale, not building. It is still the right question for DRKMTTR, who have already had to reason about it: is a tier conferring free or discounted entry a digital product, prepaid admission, or a mixed supply?
- **`TaxRate.percentage` is immutable.** Archived rates keep working on subscriptions already referencing them, so a membership can silently charge last year's rate forever. `refreshTaxJurisdictions` is the answer, and it must be **schedule-driven** — keying it on member address changes cannot work, because a jurisdiction changing its own rate produces no member-side event at all.
- **Blast radius of nullable `Order.eventId`** — needs a real read-site audit before this is scheduled, not an estimate. Unblocked by nothing else; can start any time.
- **Does Stripe Chargeback Protection cover subscription-cancellation reason codes**, or only fraud? If the former, it may price the tail risk away entirely.
- **Rolling reserve for new payees.** The reserve and circuit breaker were originally written as dispute-history-triggered, but a brand-new payee has no history and that is exactly when self-dealing cash-out risk peaks. Needs a seasoning curve, not a trigger.
- **Build gate:** per `strategic-posture-narrow`, this should be pulled by a real venue asking for recurring revenue, not built on spec. DRKMTTR is the candidate; the conversation is 2026-08-10. Note the GTM framing has changed — pitch **"add", not "migrate"**: payment methods cannot be ported off Patreon, forced re-subscribe converts ~50–70%, so switching trades ~$900/mo for ~$550–630 to recover ~$143. The migration loss is 2–3× the fee saving. Leave Patreon decaying, land new members here, and keep the ticketing-linked benefits exclusive so patrons have a reason to actively cross.
