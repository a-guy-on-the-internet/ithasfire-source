# Membership Benefits as First-Class Entities

**Date:** 2026-08-17 (revised 2026-08-20)
**Status:** shipped-local — implemented and reviewed; the migration has NEVER been executed anywhere and is CD-applied on push, so every claim about the SCHEMA is reasoned, not observed
**Priority:** P2 (High Value)
**Depends on:** `docs/specs/2026-08-05/completed/recurring-memberships.spec.md` (shipped-local, commit `656de00f`), `MembershipBenefit` / `MembershipTier` (`packages/db/prisma/membership.prisma`), `Promo` / `PromoHold` / `PromoRedemption` (`packages/db/prisma/ticket.prisma`), `evaluatePromoApplications` (`packages/core/src/use-cases/orders/checkout-promos.ts`), `resolveMemberBenefits`
**Supersedes:** the benefits-as-attached-promos mechanism and the `taxCategory` tier form field from the 2026-08-05 spec (both revised here; the rest of that spec stands)

> **Revised 2026-08-20.** Five of this spec's own decisions were reversed in review. The body below describes what SHIPPED — read it as current, not as the original draft. What changed, and why, is in **Resolved Questions** at the end: `taxCategory` is deleted outright rather than kept; `PRESALE_ACCESS` is dropped rather than kept dormant; benefit terms are `NOT NULL` rather than nullable; removing a benefit retires rather than deletes it, which loosens the redemption CHECK to *at most* one source; and the deductibility control described in the draft was deliberately not built.

---

## Problem

A membership benefit today is a pointer at a `Promo`, and the two shapes fight each other in five verified places: (1) the promo's mandatory unique `code` is a security liability — it had to be suppressed from `promos.preview` because leaking it turns a member entitlement into a public discount code, since the typed-code path checks no membership entitlement; (2) a promo is a bounded *campaign* (`startsAt`/`endsAt`, `maxRedemptions`, `status`) while a benefit is an ongoing *entitlement* whose validity window and cap ARE the membership — today an owner can attach a promo that expires next month and silently gut their tier; (3) `onDelete: SetNull` means revoking a promo used elsewhere quietly deletes the benefit's teeth; (4) cross-tenant defence had to be implemented twice (`ensurePromoScopeOwnedByOwner` at attach AND a GLOBAL-scope filter inside `resolveMemberBenefits`); (5) `isPublic`, `stackable`, `minOrderCents` are campaign knobs with no meaning as membership terms.

Separately, the tier form's "What does this tier deliver?" (`taxCategory`) dropdown is actively harmful: `TaxRateLookupPort.lookupByPostalCode` takes only `{postalCode, countryCode}` — the category **cannot change the rate** — yet it partitions the jurisdiction cache key `(country, postal, taxCategory, archivedAt)`, so two categories in one ZIP produce two rows and two ZipTax calls for identical rates, and `updateMembershipTier` permanently locks the field once there are live subscribers. It also advertises delivery the platform cannot do ("Physical goods (merch)") and pushes a tax-liability judgment onto the venue when, as merchant of record, that liability is ours.

Finally, owners get no help answering the only question that matters at setup: *at what point does a member's discount cost me more than their dues?*

---

## Goal

Make `MembershipBenefit` carry its own discount terms — no `Promo` reference — while **keeping exactly one discount computation and one hold/redemption ledger** (the 2026-08-05 spec's constraint stands: membership is an eligibility *source*, never a second engine). Replace the tax-category dropdown with an owner-stated plain-text description of what members get (their claim, not ours — consistent with the Never-a-donation posture). Add a break-even calculator at benefit setup, built on the real split math, including the fee asymmetry the owner actually bears.

---

## Context

| What exists | Where |
|---|---|
| `MembershipBenefit` (kind PROMO\|PRESALE_ACCESS, `promoId` SetNull, `categoryId`/`placeId` narrowing) | `packages/db/prisma/membership.prisma:109` |
| `Promo` (code unique, kind AMOUNT\|PERCENT, value, scope, caps, window, stackable, isPublic) | `packages/db/prisma/ticket.prisma:196` |
| `PromoHold` / `PromoRedemption` — the ONE discount ledger, keyed on `promoId` (mapped `couponId`), unique `(promoId, orderId)` / `(promoId, idempotencyKey)`; `amountDiscountCents` recorded | `packages/db/prisma/ticket.prisma:146,163` |
| `evaluatePromoApplications` + `memberPromos` source, `clampPromoDiscount`, typed-code-wins dedupe, best-effort grant skips | `packages/core/src/use-cases/orders/checkout-promos.ts` |
| `resolveMemberBenefits` (granting statuses = active\|trialing; GLOBAL refused; narrowing filter) | `packages/core/src/use-cases/memberships/resolve-member-benefits.ts` |
| `attachTierBenefit` / `removeTierBenefit` (ownership guard via `ensurePromoScopeOwnedByOwner`) | `packages/core/src/use-cases/memberships/attach-tier-benefit.ts` |
| Preview path (member grants included when signed in; code material suppressed for membership-sourced applications) | `packages/core/src/use-cases/promos/preview-promos.ts` |
| Checkout label "Member discount — {tier}" | `apps/web/.../CheckoutSidebar.tsx` / `OrderSummary.tsx` |
| Tier form dropdown copy (`taxCategoryLabel` etc.) | `apps/web/src/i18n/messages/en.ts:6919` |
| `taxCategory` lock with live subscribers | `packages/core/src/use-cases/memberships/update-membership-tier.ts:31` |
| Jurisdiction cache keyed `(country, postal, taxCategory, archivedAt)` | `packages/db/prisma/membership.prisma` (`MembershipTaxJurisdiction`) |
| Split basis: `amountGrossCents (post-discount) − feesPlatformCents (pre-discount)` | `packages/core/src/use-cases/orders/finalize-from-payment-intent.ts:693` |
| `zeroFeesForFreeOrder` on the 100%-discount path | `packages/core/src/use-cases/orders/checkout-helpers.ts:99` |
| Membership tier cards / embed / admin benefits dialog | `MembershipTierCard.tsx`, `/embed/memberships/[embedId]`, `BenefitsDialog.tsx` |
| Help article describing benefits as attached promos | `apps/web/content/help/organising-events/memberships.md` |

Deployment state: everything above is committed (`656de00f`) but **not yet pushed / not in prod**; `MembershipBenefit` rows exist only in local dev. This migration is cheap now and expensive after launch.

---

## Data Model

```prisma
model MembershipBenefit {
  id     String         @id @default(uuid())
  tierId String
  tier   MembershipTier @relation(fields: [tierId], references: [id], onDelete: Cascade)

  kind MembershipBenefitKind // enum reduced to DISCOUNT alone; PRESALE_ACCESS retired

  /// Discount terms — owned by the benefit, no Promo reference.
  /// AMOUNT = discountValue is cents off per order's eligible amount;
  /// PERCENT = discountValue is percent (1–100).
  /// NOT NULL: with PRESALE_ACCESS gone there is no term-less kind, so the
  /// invariant is the column definition rather than a CHECK + adapter filter.
  discountKind     MembershipDiscountKind
  discountValue    Int
  /// Optional clamp, integer cents. Same semantics as Promo.maxDiscountCents.
  maxDiscountCents Int?

  /// Existing narrowing, unchanged: only events matching these.
  categoryId String?
  placeId    String?

  /// Owner-facing label rendered at checkout ("Member discount — {tier}") and
  /// on the tier card. Defaults to a generated label; owners may override.
  label String? @db.VarChar(80)

  /// RETIRED, never deleted. `removeTierBenefit` stamps this instead of
  /// DELETEing so the PromoRedemption rows the benefit produced outlive the
  /// entitlement. Externally identical to the hard delete it replaced: a
  /// retired benefit is excluded from every read and grants nothing.
  archivedAt DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([tierId])
  @@index([tierId, archivedAt])
}

enum MembershipDiscountKind {
  AMOUNT
  PERCENT
}

model MembershipTier {
  /// REPLACES the taxCategory form field as the owner-facing "what do members
  /// get" statement. Plain text, the OWNER'S claim (never ours), rendered on
  /// the join card, the entity tab, and the embed. No deductibility language —
  /// AB 488 posture unchanged.
  benefitsDescription String? @db.VarChar(500)
  /// taxCategory is GONE — column, enum, and the MembershipTaxJurisdiction
  /// column/indexes with it. See "taxCategory" below.
}
```

**Ledger widening — one ledger, two sources.** `PromoHold` and `PromoRedemption` gain a nullable `membershipBenefitId`, plus uniques `(membershipBenefitId, orderId)` / `(membershipBenefitId, idempotencyKey)` mirroring the promo ones. `amountDiscountCents` recording is unchanged, so given-away margin stays queryable. No second ledger, no second hold lifecycle — confirm/release paths are source-agnostic.

The two tables differ in ONE respect, deliberately:

| | FK on benefit delete | source CHECK |
|---|---|---|
| `PromoHold` | `Cascade` | `num_nonnulls(...) = 1` |
| `PromoRedemption` | `SetNull` | `num_nonnulls(...) <= 1` |

A hold is ephemeral (≤20 min, per-order) so cascading is harmless, and its strict CHECK is what the adapter's non-null casts actually rely on. A redemption is the permanent record, and the case it has to survive is **human erasure specifically** — not owner deletion generally:

- Deleting an **org** is already handled by other cascades: `Event.org` is `Cascade`, so the org's events, their orders and these redemptions all die together. This FK changes nothing there, and a benefit can only discount its own owner's events, so there are no other orders in play.
- Deleting a **human** is the real case: `Event.human` is `SetNull`, so a personal event and its orders SURVIVE erasure, while `MembershipTier.ownerHuman` is `Cascade` and takes the tier's benefits with it. `Cascade` here would silently strip the discount record off a surviving order; `Restrict` would fail the erasure outright.

`SetNull` keeps the money and the attribution (the `code` column carries a `benefit:{id}` marker), at the cost of the FK. This is the only invariant in the refactor that is deliberately loosened rather than tightened.

**Backfill migration** (dev-only data): for each existing `MembershipBenefit` with `promoId` set, copy `promo.kind → discountKind`, `promo.value → discountValue`, `promo.maxDiscountCents → maxDiscountCents`, set `kind = DISCOUNT`; then drop `promoId` and its relation. Hand-written SQL in the established migration style; applied via CD on push; never run against a DB locally.

**`taxCategory` disposition: DELETED ENTIRELY** — the enum, `MembershipTier.taxCategory`, `MembershipTaxJurisdiction.taxCategory`, and both jurisdiction indexes.

The original draft kept the column for cache-key compatibility and future provenance. That was wrong twice over. It modelled something REAL — US taxability genuinely varies by digital vs admission vs tangible — that our provider cannot express: `TaxRateLookupPort.lookupByPostalCode` takes only `{postalCode, countryCode}` and returns ONE rate. So the category never moved a cent; it only split a ZIP's jurisdiction cache into a row and a provider call per category, while implying a determination nobody made. And "keep it for later" would have left permanently-unreachable rows whose category nobody could change — the same irreversible-field trap this spec exists to kill.

Consequences: the jurisdiction key becomes `(countryCode, postalCode)`; the live-unique index narrows to match, so the migration EMPTIES the cache first (it is a cache with a `checkedAt` refresh cycle, and `Membership.taxJurisdictionId` is `SetNull`, so nothing dangles); the live-subscriber lock and `MEMBERSHIP_TIER_TAX_CATEGORY_LOCKED` are deleted from all three lists + `appCodeToTrpc`. Memberships bill the postal code's GENERAL rate, recorded as `rateSource = "<provider>:general"` — nothing branches on that field, so the suffix exists purely so a row cannot be misread later as a category determination.

---

## Use Cases

All follow existing conventions (stateless factories, Zod `.strict()`, typed error codes, one `repos.tx()` per mutation, audit logs on mutations).

| Use case | Change |
|---|---|
| `attachTierBenefit` | Rewritten: input is `{tierId, discountKind, discountValue, maxDiscountCents?, categoryId?, placeId?, label?}`. Validation: PERCENT 1–100; AMOUNT ≥ 1 cent; label sanitized. Ownership guard = tier ownership only (`requireTierOwnerAccess`) — the promo-scope guard and the GLOBAL filter both become dead code and are removed. |
| `updateTierBenefit` (new) | Edit terms in place; audit-logged. |
| `removeTierBenefit` | Unchanged semantics from the caller's side — but the row is now RETIRED (`archivedAt`), not deleted, so the redemption ledger keeps its FK. Retired benefits are excluded from every read, which is what makes the two indistinguishable externally. |
| `resolveMemberBenefits` | Returns normalized **grants** `{benefitId, tierId, tierName, membershipId, discountKind, discountValue, maxDiscountCents, label, ownerScope}` where `ownerScope` is derived from the tier owner (org → events with that `orgId`; human → `orgId == null && humanId` match — the same payee-precedence rule as `PromoScope.HUMAN`, guard preserved). No promo lookup, no GLOBAL check needed. |
| `evaluatePromoApplications` | `memberPromos` param becomes `memberGrants` (the shape above). Internally both typed codes and grants compile to one normalized discount input feeding the SAME `computeEligibleAmount` / `clampPromoDiscount` / stacking pipeline. Grant semantics preserved from today: best-effort (a non-fitting grant skips, never throws), evaluated after typed codes, one application per benefit per order. Dedupe rule updated: previously "typed code wins over the same promo"; now a typed promo and a member benefit are distinct sources that may both apply **subject to the existing stacking rule** (>1 applied discount ⇒ all must be stackable; benefits are implicitly stackable=false against each other unless… see Open Questions). |
| `createPromoHolds` | Accepts both sources; writes `promoId` XOR `membershipBenefitId`. Idempotency keys: `order:{orderId}:benefit:{benefitId}` mirroring the promo shape. Confirm/release untouched. |
| `previewPromos` | Grant applications carry `{source: {kind:"membership", tierId, tierName, label}}` and **no code material** (already the shipped behaviour — now structural, since grants have no code at all). |
| `createMembershipTier` / `updateMembershipTier` | Gain `benefitsDescription` (sanitized: markup, control characters and bidi overrides stripped at the write boundary). Lose `taxCategory` entirely — input, lock, column, enum. |
| `computeBenefitBreakEven` (new, pure) | In `packages/core/src/lib/pricing/`. Inputs: `{tierPriceCents, interval, discountKind, discountValue, maxDiscountCents?, typicalTicketFaceCents, discountedTicketsPerPeriod}`. Outputs: `{discountPerTicketCents, ownerNetPerMemberCents, breakEvenTicketsPerPeriod, fullyFree: boolean}`. Math grounded in the REAL pipeline: fees compute pre-discount (`computeOrderAmounts` before promo evaluation), owner split basis = post-discount gross − pre-discount fee, EXCEPT a 100% discount routes to the free path where `zeroFeesForFreeOrder` drops all fees. Integer cents throughout; table-driven tests against worked examples. |

**Error codes:** add `MEMBERSHIP_BENEFIT_INVALID_TERMS` (all three lists + `appCodeToTrpc`); retire `MEMBERSHIP_TIER_TAX_CATEGORY_LOCKED`. Codes `PROMO_NOT_OWNED`/`PROMO_EXPIRED` no longer reachable from the attach path.

---

## UI / Flow

**Tier form (`TierFormDialog`):** the "What does this tier deliver?" dropdown is replaced by a `benefitsDescription` textarea — label ~"What do members get?", helper ~"Shown to members on your page and in the embed. Your description, in your words." No tax copy. i18n in both catalogs; the four `taxDigital…taxMixed` keys are removed from both.

**Benefits dialog (`BenefitsDialog`):** promo picker replaced by a small form: discount kind toggle (amount off / percent off), value input (money input per the established `inputMode` + sanitizer pattern — never `type="number"`), optional max-discount clamp, existing category/place narrowing, optional label. Inline validation mirrors core rules.

**Break-even calculator:** lives inside the benefits dialog, always visible while editing terms, pre-filled with the tier's price and a typical ticket price (median face price of the owner's upcoming published events where available, else a sensible default the owner can edit). Renders: *"A member who uses this at N shows a month costs you more in discounts than they pay in dues. Below N, they're profitable."* plus owner-net-per-member at the entered attendance, and — stated plainly, not buried — the fee note: *"Platform fees on a discounted ticket are still computed on full face price; a 100% discount produces a $0 order with no fees at all."*

**Member surfaces:** tier card / entity tab / embed render `benefitsDescription` (replacing nothing — it's additive to the existing description) and per-benefit labels. Checkout line unchanged: "Member discount — {tier}" (label override when set).

**Help article:** `memberships.md` benefits section rewritten — no longer "attach one of your promos"; describe discount terms, the calculator, and that benefits last exactly as long as the membership is active (no expiry window to manage). The "Promo no longer active" failure mode disappears.

---

## Acceptance Criteria

- [ ] `MembershipBenefit` carries its own `discountKind`/`discountValue`/`maxDiscountCents`; `promoId` is gone from schema, ports, adapters, and core.
- [ ] Backfill migration converts every existing promo-backed benefit's terms in the same migration that drops the column; CD-applied; never run locally.
- [ ] Exactly ONE discount pipeline: typed codes and member grants both flow through `evaluatePromoApplications`'s clamp/stacking/eligibility path; grep shows no second discount computation.
- [ ] Exactly ONE ledger: holds/redemptions for benefits land in `PromoHold`/`PromoRedemption` via `membershipBenefitId`, with `amountDiscountCents` recorded; the `(source, orderId)` uniqueness holds per source; confirm/release paths are source-agnostic and regression-pinned for promos.
- [ ] A benefit has NO code anywhere: not in the DB, not in any API response, not derivable — the preview leak class is structurally dead.
- [ ] A benefit remains valid exactly as long as the granting membership is active|trialing; CANCELED/PAST_DUE grant nothing (existing tests keep passing); there is no attachable object that can expire out from under a tier.
- [ ] Attaching a benefit requires only tier ownership; the cross-tenant attack (a benefit discounting another owner's revenue) is prevented by the grant's derived `ownerScope`, pinned by test for org-owned and human-owned tiers (including the `orgId == null` payee-precedence guard).
- [ ] 100% benefit still routes to the free path with zero fees; partial benefit leaves platform fee at full-face computation — both pinned end-to-end through the new grant shape.
- [ ] Tier form shows `benefitsDescription` and no tax-category control; `taxCategory` is gone from the schema entirely, along with its lock and error code; two tiers in one ZIP produce ONE jurisdiction row and one provider call — now true by construction rather than by convention, since there is no category to split on.
- [ ] Removing a benefit RETIRES it (`archivedAt`) rather than deleting: the use case's contract is unchanged, but the `PromoRedemption` rows it produced survive, so an ordinary product action can no longer erase the platform's record of granted margin.
- [ ] `rateSource` records `<provider>:general`, so a jurisdiction row cannot be misread as a category determination that was never made.
- [ ] Discounts combining to $0 across sources is INTENDED and unchanged; the free path is logged when more than one applied discount reached zero, so the case is reconstructable after the fact.
- [ ] `computeBenefitBreakEven` is pure, integer-cents, table-tested, and its worked examples match the real checkout pipeline for: partial AMOUNT, partial PERCENT with clamp, and 100% free-path cases.
- [ ] Calculator renders in the benefits dialog with live recomputation and the pre-discount-fee note verbatim.
- [ ] `benefitsDescription` renders on tier card, entity tab, and embed; sanitized; no deductibility language anywhere (AB 488 posture).
- [ ] i18n: all new keys in BOTH `en.ts`/`es.ts`; removed keys removed from both; parity + argument gates green.
- [ ] Help article rewritten to match shipped behaviour; help-drift check green.
- [ ] Existing invariants re-verified: no `transfer_data`, `getPublicPage` strips member sections, granting statuses unchanged.

---

## Resolved Questions

Each of these was open in the draft and settled in review on 2026-08-20. Recorded with the reasoning, because the reasoning is the part that stops them being reopened by accident.

- **Benefit-vs-benefit stacking → at most ONE benefit per order, best for the buyer**, ties broken by arrival (oldest membership, then benefit `createdAt`, then `id` — a total order, so the choice is stable across checkouts). Losers are logged, not silently dropped. True multi-benefit stacking is deferred until an owner actually wants to compose perks; today the only in-tool benefit is a ticket discount.

- **Benefit-vs-CODE stacking → unchanged, and orders may reach $0.** A benefit is just another discount: it stacks with a typed code the owner marked `stackable`, and if the two reach zero the free path runs and waives the platform fee too. A source-specific floor was considered and REJECTED for two reasons: it would be a second discount rule in a feature whose whole constraint is one engine, and a 1¢ floor produces an order below Stripe's 50¢ minimum charge — i.e. an unchargeable order, worse than the thing it was protecting against. The consent argument for a floor was also wrong: the owner created the code, ticked `stackable`, AND created the benefit.

- **`PRESALE_ACCESS` → DROPPED, not kept.** It had no behaviour anywhere (every reference was a comment or a filter excluding it) and was named after a MECHANISM rather than a need. A reserved name constrains the design when the real requirement arrives — you either bend the feature to the name or rename the enum anyway. The `kind` enum survives for the perks that are actually coming (merch discounts, event access); the value gets named when it has semantics.

- **Typical-ticket-price prefill → no query.** The preferred prefill (median face of upcoming published events) has no cheap read: nothing returns ticket-type prices in bulk, so it would mean a new repo aggregate + use case + procedure for a value the owner retypes in one keystroke. Shipped the stated fallback — an editable $20.00 default.

- **Owner-typed deductibility language → no control built.** `benefitsDescription` and the benefit `label` are owner free text on public surfaces, and AB 488 exposure is ours. A client-side phrase blocklist was designed and then rejected: three phrases are evadable by a typo, bypassable by any non-browser caller, and blind to the hundred other ways someone writes "write it off on your taxes". Shipping no control beats shipping a convincing-looking one. The real mitigations stand — we never characterise a membership as a donation ourselves, and the text is sanitized (markup, control characters, bidi overrides) at the write boundary.
