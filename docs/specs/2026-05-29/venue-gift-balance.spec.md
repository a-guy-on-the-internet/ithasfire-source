# Venue Gift Balance — Buyer-Funded, Org-Scoped Stored Value

**Date:** 2026-05-29
**Status:** draft
**Priority:** P3 (post-launch — prepaid float, venue loyalty, gifting; compliance-gated)
**Sibling of:** [UserCredit — Platform-Funded Account Credit](../2026-05-16/user-credit.spec.md). Shares the redemption ledger and checkout auto-apply plumbing; differs entirely in funding source, scope, economics, and regulation.
**Depends on:** Order checkout pipeline (`packages/core/src/use-cases/orders/create-checkout.ts`), refund pipeline, Stripe Connect settlement, audit-log infrastructure, the unified credit ledger (see "Relationship to UserCredit").

---

## Status checklist

- [ ] **Phase 0** — compliance posture sign-off (stored-value licensing, expiry/escheatment rules, T&Cs). **Gate: do not ship Phases 2+ until this is signed off.**
- [ ] **Phase 1** — unified ledger mechanics: extend the credit model with `fundingSource` + `scope`; redemption restricted to the owning org/place. Reuses UserCredit redemption + refund-reversal logic. No load flow yet.
- [ ] **Phase 2** — buyer "load balance" purchase flow + deferred Connect settlement (platform holds the float as a liability; transfers to the organiser only at redemption).
- [ ] **Phase 3** — gifting (buy a balance for someone else), balance management UI, low-balance prompts.
- [ ] **Phase 4** — finance reporting (outstanding stored-value liability per org, breakage policy, escheatment export).

Flip `Status:` `draft` → `in-progress` once Phase 1 starts, `implementation-ready` once Phase 0 compliance posture is approved, `complete` only when all phases ship. Move into `docs/specs/2026-05-29/completed/` once `Status: complete`.

## Premise

A **Venue Gift Balance** is a dollar amount a buyer **pays real money to load** onto a specific organisation/place, redeemable against that org's future orders. Unlike a platform credit, **the money is the buyer's**, the balance is a **liability we owe them**, and redemption settles to the **organiser** (not platform P&L).

Same checkout UX as a platform credit (a balance that auto-applies), opposite money flow underneath:

| | Platform credit (UserCredit) | Venue gift balance (this spec) |
|---|---|---|
| Whose money | Platform's (minted) | Buyer's (paid in) |
| Books as | Expense (marketing/goodwill) | **Liability** (owed to buyer) |
| Cash flow | Out only (we eat the discount) | **In at load, out to organiser at redemption** |
| Pays the organiser | Platform tops them up | Buyer's prepaid money does, at redemption |
| Scope | GLOBAL (any event) | ORG / PLACE (that venue only) |
| Expiry | We expire freely | Mostly **can't** (CARD Act ≥ ~5yr, fee limits) |
| Regulation | ~none | Stored-value / money-transmission + escheatment |

## Relationship to UserCredit (shared ledger)

These are **siblings on one ledger**, not duplicates. Extend the existing credit model rather than fork it:

- `fundingSource: PLATFORM | BUYER_PURCHASED` — platform credit = `PLATFORM`; gift balance = `BUYER_PURCHASED`.
- `scope: GLOBAL | ORG | PLACE` + nullable `scopeOrgId` / `scopePlaceId` — platform credit = `GLOBAL`; gift balance = `ORG`/`PLACE`.

Reused as-is:
- `UserCreditRedemption` ledger (partial application, carryover, idempotent `@@unique([creditId, orderId])`).
- Refund reversal (`refundedAt` restores balance).
- Auto-apply-at-checkout, FIFO/expiry ordering, currency match.

Diverges:
- **Settlement.** Platform credit reduces buyer charge only, organiser untouched. Gift balance redemption **pays the organiser from held float** — it is NOT a platform expense.
- **Funding.** Gift balance requires a real payment (load flow); platform credit is granted.
- **Expiry/legal.** Gift balance can't be freely expired; escheatment applies.

## Settlement model (the hard part)

**At load** (buyer pays $50 to load a balance for Org X):
1. Charge the buyer $50 via a **platform-owned** PaymentIntent (not the org's connected account).
2. Hold the $50 on the platform as a **stored-value liability** owed to the buyer, earmarked to Org X.
3. **Do NOT transfer to the organiser yet.** No goods delivered.

**At redemption** (buyer spends $40 of the balance on an Org X order):
1. The order's buyer charge is reduced by $40 (one `UserCreditRedemption` row, balance −$40).
2. Settlement to the organiser for that $40 of ticket value is funded from the **held float** via a Stripe Connect transfer (deferred settlement), net of the platform fee exactly as a normal sale.
3. Remaining $10 stays as liability until spent or escheated.

**Why platform-held, not org-held:** if we transferred the $50 to the org at load time, refunds, partial redemption, and inter-event accounting would require clawing money back from a connected account we don't control. Holding the float centrally keeps refunds and breakage tractable. (Trade-off: platform now carries regulated stored-value liability — see Phase 0.)

## Data model (delta on the unified ledger)

```prisma
// Added to the credit model (shared with UserCredit):
fundingSource  CreditFundingSource @default(PLATFORM)
scope          CreditScope         @default(GLOBAL)
scopeOrgId     String?
scopePlaceId   String?
/// For BUYER_PURCHASED: the load PaymentIntent that funded this balance.
loadPaymentRef String?

enum CreditFundingSource {
  PLATFORM        // UserCredit — platform margin
  BUYER_PURCHASED // Venue gift balance — buyer's money, our liability
}

enum CreditScope {
  GLOBAL  // redeemable on any event
  ORG     // redeemable only on scopeOrgId's events
  PLACE   // redeemable only on scopePlaceId's events
}
```

Redemption eligibility (auto-apply query) gains a scope filter: a `BUYER_PURCHASED/ORG` balance only matches orders whose event belongs to `scopeOrgId`.

A separate `GiftBalanceLoad` (or reuse of the order/payment tables) records each top-up: `humanId`, `orgId/placeId`, `amountCents`, `paymentIntentId`, `status`, `createdAt` — the audit trail for the liability and for escheatment reporting.

## Application order at checkout

Same pipeline as UserCredit, with scope filtering:

1. Compute subtotal from ticket lines.
2. Apply **promo discounts** (organiser-funded).
3. Apply **platform credits** (`GLOBAL`, platform-funded — reduce buyer charge only).
4. Apply **scoped gift balances** matching the order's org/place (buyer-funded — reduce buyer charge; organiser is paid from held float).
5. Add platform fee, processing, taxes.

The **organiser entitlement line stays computed from un-discounted ticket lines** for promos/platform-credit, but for gift-balance redemption the organiser is still paid for that ticket value — funded from the held float rather than fresh buyer cash. Keep the invariant: `sum(settlement to organiser) == ticket value − promo`, regardless of how the buyer's side was funded (cash vs gift balance).

## API surface (tRPC)

```ts
// Buyer
giftBalance.listMine: authedProcedure            // balances grouped by org/place
giftBalance.load: authedProcedure({ orgId|placeId, amountCents })
  // → returns a PaymentIntent client secret for the load
giftBalance.history: authedProcedure             // loads + redemptions + refunds

// Internal (from createCheckout) — reuses the credit auto-apply path
credits.previewRedemption: authedProcedure({ orderId })  // now scope-aware

// Org-staff (optional, later phase)
giftBalance.listForOrg: authedProcedure          // outstanding liability for their venue
```

## UI surfaces

### Buyer-facing
- **Venue/org page**: "Add gift balance" / "Load $___ for {Org}" CTA.
- **Checkout order summary**: scoped balance auto-applies as a green line `{Org} balance: −$40.00`, shown alongside (and after) any platform credit.
- **Account → Balances**: per-org balances, load history, redemptions, expiry (if any), T&Cs link.
- **Gifting (Phase 3)**: "Send a {Org} gift balance" → recipient email/account.

### Org-staff facing (later)
- **Outstanding gift-balance liability** for their venue (informational; the platform holds the cash).

## Anti-abuse / safety rails

1. **Scope enforcement** — a gift balance only redeems on its `scopeOrgId`/`scopePlaceId` events (assert in `createCheckout`).
2. **Currency match** — load and redemption currency must match.
3. **No cash-out by default** — balances redeem against orders, not withdrawn (cash-out raises money-transmission burden; revisit only with legal).
4. **Refund reversal** — refunding an order that consumed gift balance restores the balance (reuse UserCredit reversal); refunding a *load* returns the buyer's cash and zeroes that load's contribution.
5. **Idempotency on load and redeem** — both are money movement; reuse the `IdempotencyPort` patterns from checkout/refund. `@@unique([creditId, orderId])` already guards double-redeem.
6. **Audit-log** every load, redemption, refund, and any expiry/escheatment action.
7. **Float reconciliation** — held liability must always equal Σ active `BUYER_PURCHASED` balances; a reconciliation job flags drift.

## Refund interaction

- **Refund an order that spent gift balance:** restore the consumed balance (status `REDEEMED`→`ACTIVE`); buyer cash refund = what they actually paid in cash; the gift-funded portion goes back to balance, not to card.
- **Refund a load (top-up) itself:** return the buyer's cash, decrement/zero the balance for that load; only allowed if that load's funds are unspent (else it's a partial unwind — define policy in Phase 2).

## Compliance (Phase 0 — blocking gate)

This is the reason gift balance is a separate, gated spec rather than a flag on UserCredit:

- **Stored-value / money-transmission**: holding buyer prepaid funds may require licensing or a regulated banking/Connect arrangement; confirm posture with Stripe (Treasury / Connect) and counsel before Phase 2.
- **CARD Act**: gift cards generally can't expire for ~5 years and limit dormancy fees — default gift balances to **no expiry**.
- **Escheatment / unclaimed property**: unredeemed balances may legally become state property after a dormancy period; need per-state policy + reporting export (Phase 4).
- **Revenue recognition / breakage**: when (if ever) breakage can be recognized, and by whom (platform vs org).
- **T&Cs**: buyer-facing stored-value terms at load time (reuse `AcceptanceRecord` pattern, 2026-05-17).

## Open questions

- **Org-scoped vs place-scoped** as the primary unit — venues map to `Place`, but selling orgs map to `Organization`. Lead with `ORG` scope; `PLACE` optional.
- **Who keeps breakage** — platform or organiser? Affects whether this is a platform or org liability. (Leaning platform, since platform holds the float.)
- **Bonus on load** ("load $50, get $55") — that bonus $5 is platform- or org-funded credit; composes via a `PLATFORM`/`ORG` credit grant on top. Out of scope for v1.
- **Cash-out / transfer** — default no (regulatory burden). Gifting (Phase 3) is a controlled transfer at issuance only.
- **POS / scanner redemption** — same gap as UserCredit (no buyer account at POS today). Out of scope v1.

## Out of scope (v1)

- Cash withdrawal of balances.
- Cross-org / platform-wide spend of a gift balance (that's a platform credit).
- Bonus-on-load promotions.
- POS redemption.

## What this informs

- **Builds on** UserCredit's ledger — ship UserCredit first; this extends the same tables.
- **Distinct from** organiser promo codes (organiser-funded discounts) and platform credits (platform-funded). Three different money flows on a shared discount/redemption surface.
