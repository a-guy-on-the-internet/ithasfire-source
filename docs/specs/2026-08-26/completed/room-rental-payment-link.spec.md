# Room Rental Payment Link

> Superseded by docs/specs/2026-08-27/venue-confirmation-and-booking-intents.spec.md (2026-10-08 docs consolidation)

**Date:** 2026-08-26
**Status:** SUPERSEDED 2026-08-27 by `docs/specs/2026-08-27/venue-confirmation-and-booking-intents.spec.md` — the payment mechanism survives there as §Rental payment; the spine (fee-on-agreement, rental as the subject) does not. Kept for the verified Stripe facts.
**Priority:** P2 (High Value)
**Depends on:** `Agreement` + `BookingRequest` (agreement.prisma), booking thread + system entries (`booking-requests/messages/_shared/system-entries.ts`), holds (`docs/specs/2026-08-25/completed/booking-holds.spec.yaml`, shipped 2026-08-26), `Payee` + Stripe Express Connect (`stripe-connect/sync-connect-account.ts`), Stripe webhook route (`apps/api/src/routes/stripe/webhook.ts`, already verifies `STRIPE_CONNECT_WEBHOOK_SECRET`), notification-intent pattern (`booking-holds/_shared/booking-hold-intents.ts`)
**Supersedes:** the payment-collection non-goal in `docs/specs/2026-07-27/completed/compounding-deal-terms-model.spec.md` (that spec stays parked; this one replaces its "rental payment collection" deferral with a design that never touches settlement)

---

## Problem

A venue that rents its room ("we forgo the door, you pay for the space") has no way to ask for that money inside the booking it is already negotiating on Ithas Fire. The conversation happens in the thread, the hold and the event are minted from the thread, and then the one thing that makes the deal real — the rental fee — leaves the platform for a Venmo handle or a cheque at load-in. Neither party has a record of whether it was paid, and the venue has to chase it by hand.

The platform's position (decided 2026-08, `record-deals-not-execute`) is that it **records deals and does not execute them**: no settlement of guarantees, no holding of rental money, no ledger entries for off-platform obligations. That rules out the obvious build — collecting the fee on the platform account and paying the venue out — because it puts Ithas Fire in the money path as merchant of record for a room it doesn't control.

Stripe Connect **direct charges** resolve this. A Payment Link created *on the venue's own connected account* is the venue's charge from the first dollar: their balance, their receipt, their refund, their dispute. Ithas Fire creates the link, posts it in the thread, and records the outcome from the webhook. Stripe executes; we record. That is the whole feature.

---

## Goal

From the booking thread, venue staff can request a one-off room-rental fee from the act. The act gets a Stripe-hosted checkout branded as the venue, pays by card or bank, and both sides see the same status — Requested → Paid → (Expired / Refunded) — as entries in the thread's timeline and as a status card on the agreement. Money lands in the venue's Stripe account directly. Ithas Fire takes no cut and never holds the funds. If the venue is not on Stripe, or the act pays some other way, the venue can record the payment by hand and the flow is identical from there.

---

## Context

| What exists | Where |
|---|---|
| `Agreement` — one per booking request, DRAFT → PROPOSED → ACCEPTED → FULFILLED, `type` enum incl. `VENUE_RENTAL` (defined, unreachable: accept path hardcodes `PERFORMANCE`), `guaranteeCents` (recorded term only), `metadata Json` | `packages/db/prisma/agreement.prisma:5`, `booking-requests/_shared/accept-agreement.ts:66,124` |
| Booking thread with SYSTEM entries; kinds are plain strings on the message row (`systemKind`), the params contract is Zod in one file and EXHAUSTIVE — adding a kind without a schema fails at the write | `packages/core/src/use-cases/booking-requests/messages/_shared/system-entries.ts`, `venue.prisma:179` |
| In-thread action card pattern (query agreement → mutation → invalidate `bookingRequests.messages.list`) | `apps/web/src/components/bookings/CreateEventFromBookingAction.tsx` |
| Holds: own `BookingHold` table, ordered line, 24h challenge clock, **lazy expiry (computed on read, no cron)**, confirm = accept + draft event in two commits; **owner-locked: "Money never gates a hold"** | `booking-holds/*`, `docs/specs/2026-08-25/completed/booking-holds.spec.yaml` |
| Lapsed-hold settler (runs on read paths) and the `expire-booking-requests` job | `booking-holds/_shared/settle-lapsed-holds.ts`, `booking-requests/expire-booking-requests.ts` |
| Notification intents returned by use cases, stripped from wire output, dispatched separately with `audience: act \| staff` | `booking-holds/_shared/booking-hold-intents.ts`, `notify-booking-hold-intents.ts` |
| Venue → money account: `PlaceOwnership(ownerType, ownerId)` → `Payee(subjectType HUMAN\|ORGANIZATION, subjectId)` → `stripeAccountId`; eligible iff `status === "ACTIVE" && chargesEnabled && payoutsEnabled`. **Never mint a placeholder Payee.** | `place.prisma:192`, `finance.prisma:10`, `agreements/_shared/upsert-agreement-shared.ts:196`, `stripe-connect/sync-connect-account.ts` |
| Express connected accounts; login-link helper for the venue's Express dashboard | `stripe-adapter.ts:308`, `createConnectLoginLink` |
| Stripe webhook: ONE endpoint, tries `STRIPE_WEBHOOK_SECRET` then `STRIPE_CONNECT_WEBHOOK_SECRET` — connected-account events are already accepted and verified. The switch **never reads `event.account`** today (`account.updated` identifies the account from the object). No `checkout.session.*` case exists. Every unhandled type is acknowledged. | `apps/api/src/routes/stripe/webhook.ts:1691`, `apps/api/src/lib/env.ts:33` |
| `invoice.payment_succeeded` is membership-only and THROWS a parse failure on any other invoice (DLQ + Discord) — the reason this spec uses Checkout, not Invoicing | `webhook.ts:1121` |
| Second-adapter precedent: a dedicated port + Stripe class, composed in `dep.ts` | `packages/ports/src/membership-billing-port.ts`, `stripe/membership-billing-adapter.ts`, `apps/api/src/lib/dep.ts:910` |
| Idempotency for money-moving / externally-triggered use cases | `IdempotencyPort`; pattern in `orders/finalize-from-payment-intent.ts` |

### Stripe facts this design relies on (verified 2026-08-26)

- Payment Links and Checkout can be created **on a connected account** with the `Stripe-Account` header (direct charge). *"For direct charges, the connected account is responsible for Stripe fees, refunds, and chargebacks."* The referenced Product/Price must exist on that connected account.
- A Payment Link is a reusable URL; `restrictions[completed_sessions][limit]=1` makes it self-deactivate after one payment; `active=false` deactivates it on demand. Opening a link creates a Checkout Session; fulfilment is `checkout.session.completed`, delivered for the connected account with `event.account` set. Link `metadata` is copied onto every session it creates.
- **Pricing:** Payment Links and Checkout carry no fee beyond standard Payments processing. Stripe Invoicing adds **0.4% per paid invoice** (0.5% on Plus). Both are charged to the account that owns the charge — the venue — never to the platform. `application_fee_amount` is optional and this spec sets none.
- A Checkout Session's `expires_at` is capped at 24 hours — unusable as a "pay within the week" link. That is why the primitive is a Payment Link, not a bare Session.

### Airbnb, as inspiration — what we take and what we deliberately don't

**Take:**
- One linear, shared status: *Requested → Paid → Confirmed*, identical on both sides, with a visible deadline. Airbnb's request-to-book countdown is the model for `rentalDueAt`.
- The price and what it covers are fully visible before the pay button. Stripe's hosted page does this; the request card in the thread restates it.
- The status card is *in the conversation*, not on a separate billing page.
- Terms are shown at the moment of paying — here, the venue's own cancellation/refund note, typed once when requesting the fee, rendered on the checkout page and in the thread.

**Don't take:**
- **Escrow.** Airbnb collects at booking as merchant of record and releases to the host after check-in. That is execution, and it is exactly what `record-deals-not-execute` rules out. The venue's account is charged directly; there is no release step because there is nothing to release.
- **Pay-to-confirm.** Airbnb won't confirm until the card is charged. Here, *"Money never gates a hold"* is owner-locked (2026-08-25). Payment is a **tracked status**, never a gate on hold, confirm, or publish. An unpaid fee is visible and nagged; it does not block.
- **A platform cancellation policy.** Airbnb's policy tiers exist because Airbnb refunds. We don't hold the money, so refund terms are the venue's prose, and a refund is the venue's button.

---

## Data Model

Rental payment state lives on the **Agreement** (one per booking request; it is already the deal record and already carries `guaranteeCents` as a recorded term). Explicit columns, not `metadata` — these are Stripe-sourced facts, not derived state, and they are read by the inbox, the thread, and the calendar.

```prisma
enum RentalPaymentStatus {
  REQUESTED   // link created and posted; awaiting payment
  PAID        // checkout.session.completed received for this link
  EXPIRED     // rentalDueAt passed unpaid; link deactivated
  CANCELLED   // venue withdrew the request before payment; link deactivated
  REFUNDED    // venue refunded (full) after PAID
  RECORDED    // venue marked as paid outside Ithas Fire — no Stripe object
}

model Agreement {
  // ── existing fields unchanged ──

  // ── Room rental fee (2026-08-26) ────────────────────────────────────────
  // A RECORDED, venue-collected fee. Collected by Stripe on the VENUE's own
  // connected account (direct charge) via a single-use Payment Link, or
  // marked RECORDED by staff when paid some other way. The platform never
  // holds these funds, takes no application fee, writes no ledger entry, and
  // never gates a hold, confirm, or publish on this status.
  rentalFeeCents            Int?
  rentalFeeCurrency         String?             @db.VarChar(3)
  rentalPaymentStatus       RentalPaymentStatus?
  /// Venue-authored note (what the fee covers, cancellation/refund terms).
  /// Rendered on the checkout page (`custom_text`) and in the thread card.
  rentalNote                String?
  rentalRequestedByHumanId  String?             // staff who requested; plain id, house style
  rentalRequestedAt         DateTime?
  rentalDueAt               DateTime?
  rentalPaidAt              DateTime?
  rentalRefundedAt          DateTime?
  /// Stripe objects, all on the VENUE's connected account.
  rentalStripeAccountId     String?             // acct_… the link was created on (tenant check on webhook)
  rentalPaymentLinkId       String?             @unique
  rentalPaymentLinkUrl      String?
  rentalCheckoutSessionId   String?             @unique
  rentalPaymentIntentId     String?             @unique

  @@index([rentalPaymentStatus, rentalDueAt]) // due-date sweep
}
```

**Shape rules (use-case-enforced, SQL CHECK optional):**
- `rentalPaymentStatus IS NULL` ⇔ every `rental*` column is NULL.
- `REQUESTED | PAID | EXPIRED | CANCELLED | REFUNDED` ⇒ `rentalPaymentLinkId` and `rentalStripeAccountId` set. `RECORDED` ⇒ both NULL.
- `PAID | REFUNDED` ⇒ `rentalCheckoutSessionId` and `rentalPaymentIntentId` set.

**Per-venue Stripe catalog.** A Payment Link needs a Price on the connected account. Store the lazily-created "Room rental" Product id per Payee: `Payee.stripeRentalProductId String?`. One Price per request (`unit_amount = rentalFeeCents`, `currency = rentalFeeCurrency`), created inline; never reused.

**`Agreement.type`.** Requesting a rental fee on an agreement whose `type` is `PERFORMANCE` sets it to `VENUE_RENTAL` — a rental fee *is* the distinguishing fact, and it finally makes the enum member reachable. `Event.agreement.type === "VENUE_RENTAL"` is then the derived "this event is a rental" for any UI that wants it. **No flag on `Event`** (standing rule).

No new ledger, order, split, or settlement rows. **Nothing in `finance.prisma` changes except the one Product-id column on `Payee`.**

---

## Use Cases

House conventions apply: stateless factories, Zod in/out, typed error codes, one `repos.tx()` per mutation, `IdempotencyPort` on anything externally triggered, `ReporterPort` on every catch-and-fallback branch.

### Port + adapter

**`RentalPaymentsPort`** (`packages/ports/src/rental-payments-port.ts`) — mirrors the membership-billing split:

```ts
interface RentalPaymentsPort {
  ensureRentalProduct(i: { stripeAccountId: string }): Promise<{ productId: string }>;
  createRentalPaymentLink(i: {
    stripeAccountId: string; productId: string;
    amountCents: number; currency: string;
    metadata: { kind: "room_rental"; agreementId: string; bookingRequestId: string; placeId: string };
    customText?: string;            // rentalNote → custom_text.submit / after-payment message
    idempotencyKey: string;
  }): Promise<{ paymentLinkId: string; url: string }>;
  deactivatePaymentLink(i: { stripeAccountId: string; paymentLinkId: string }): Promise<void>;
  refundRentalPayment(i: { stripeAccountId: string; paymentIntentId: string; idempotencyKey: string }): Promise<{ refundId: string }>;
}
```

`StripeRentalPayments` (`packages/adapters/src/payment-processors/stripe/rental-payments-adapter.ts`): every call passes `{ stripeAccount }` — the repo's **first direct-charge code**. The adapter's own comments (`stripe-adapter.ts:473,490,516,560`) already reserve space for "future direct-charge flows"; this is that flow, and it must **not** be added to `StripeAdapter`, whose contract is "everything on the platform account." `restrictions.completed_sessions.limit = 1`; no `application_fee_amount`; `after_completion` = hosted confirmation with a one-line message.

### New

**`requestRentalFee`** — staff (EDITOR is the booking role), agreement must exist for the request and be `DRAFT | PROPOSED | ACCEPTED` (not terminal). Resolves the venue's Payee via `PlaceOwnership → Payee`; **if not eligible (`isPayeeEligible`) → `precondition_failed: venue_not_on_stripe`** and the UI offers "record a payment instead". Creates Price + Link, writes the `rental*` columns (`REQUESTED`), sets `type = VENUE_RENTAL` if `PERFORMANCE`, appends ledger entry `booking_rental.requested`, returns intents: act ← `rental.requested` (with URL), staff ← none. Idempotent on `(agreementId, generation)`. Refuses if a live `REQUESTED` link exists (`conflict: rental_already_requested`) — cancel first.

**`cancelRentalFeeRequest`** — staff; `REQUESTED → CANCELLED`, deactivates the link, entry `booking_rental.cancelled`. Reissue = a new `requestRentalFee`.

**`recordRentalPaidOffPlatform`** — staff; any non-PAID state → `RECORDED` (deactivates a live link if present), `rentalPaidAt = now`, entry `booking_rental.recorded` (params: `method: string` free text ≤ 40 chars, e.g. "cash", "Venmo"). This is the path for venues without Stripe and for acts who paid another way; it keeps the whole flow available at zero integration.

**`recordRentalCheckoutCompleted`** — externally triggered (webhook). Input is the Checkout Session + `event.account`. Guards, in order: (1) `metadata.kind === "room_rental"` else **not ours — return, do not throw** (a venue may use Stripe for other things on the same account); (2) load agreement by `metadata.agreementId`, **require `agreement.rentalStripeAccountId === event.account` and `session.payment_link === agreement.rentalPaymentLinkId`** — a mismatch is `conflict: rental_account_mismatch`, DLQ'd, alerted (tenant check; signed events can't be forged but a misrouted or replayed one must not mark the wrong deal paid); (3) `amount_total === rentalFeeCents` and currency match, else `conflict: rental_amount_mismatch`; (4) idempotent on `session.id` via `IdempotencyPort` (replay returns the stored result). Then `REQUESTED → PAID`, stamp session + payment-intent ids, `rentalPaidAt = session.created`, entry `booking_rental.paid`, intents: act ← `rental.paid` (receipt pointer), staff ← `rental.paid`. `EXPIRED` links can't complete (deactivated), but if a race lands a completion on an `EXPIRED` row, **accept it** — money moved; mark `PAID` and note the late payment in the entry params.

**`refundRentalPayment`** — staff; `PAID → REFUNDED`, full refund only, via the port with `stripeAccount`; entry `booking_rental.refunded`; act ← `rental.refunded`. Idempotent on `(agreementId, paymentIntentId)`. Partial refunds: the venue's Express dashboard, out of scope.

**`settleOverdueRentalRequests`** — `REQUESTED` with `rentalDueAt < now` → `EXPIRED`, deactivate link, entry `booking_rental.expired`, staff ← `rental.expired`, act ← `rental.expired`. **Not lazy** — deactivating the link is an external side effect, so this runs in the jobs app on the same cadence as `expire-booking-requests` (reuse that schedule; no new cron topic — the jobs manifest validator is fragile, see `commit-gates` memory). Also invoked opportunistically from the settler that runs on thread reads, so a booker never sees a stale `REQUESTED` past its due date.

**Reminders** — a `rental.reminder` intent to the act at `rentalDueAt − 48h` if still `REQUESTED`, emitted by the same job. One reminder. No dunning.

### Modified

**`system-entries.ts`** — six new kinds, all `.strict()`, all carrying `agreementId`: `booking_rental.requested { amountCents, currency, dueAt }`, `.paid { amountCents, currency, late: boolean }`, `.expired {}`, `.cancelled {}`, `.refunded { amountCents }`, `.recorded { method }`. Not venue-internal: the act sees all of them.

**`webhook.ts`** — add `case "checkout.session.completed"` that reads `event.account` and delegates to `recordRentalCheckoutCompleted`; it must sit **before** any generic handling and must **return quietly on non-rental sessions**. Optionally `charge.refunded` for the connected account → if the charge's PI matches `rentalPaymentIntentId` and status is `PAID`, move to `REFUNDED` (covers refunds issued from the Express dashboard). Both are the first handlers in this file to read `event.account`; document that at the case.

**`update-booking-agreement-header`** — accept `type` so the `VENUE_RENTAL` stamp goes through the existing header-update path rather than a raw write.

**Notification intents** — a `booking-rental-intents.ts` sibling of the hold intents: kinds `rental.requested | rental.reminder | rental.paid | rental.expired | rental.refunded`, audiences `act | staff`, five renderer variants, five `ui-email` templates (remember the dist rebuild footgun: new templates need `@th/ui-email` built or `template_not_found`).

---

## UI / Flow

**Thread action — "Request room rental fee"** (`RequestRentalFeeAction.tsx`, next to `CreateEventFromBookingAction`). Staff only; visible once an agreement exists. Fields: amount, due date (default: 7 days, capped at the event date if one exists), note (what it covers, refund terms). If the venue's Payee isn't eligible, the same card shows *"This venue isn't set up to take payments on Ithas Fire yet"* with two buttons: **Set up payments** (existing Connect onboarding) and **Record a payment instead**. Never a dead end.

**Status card in the thread** (the Airbnb piece). One card, updated in place, same for both sides:

```
Room rental · $500.00                      Due Sat 4 Oct
Requested → Paid → Confirmed               ● Requested
"Covers the room 6–11pm, sound tech included. Non-refundable
 within 14 days of the date."
[ Pay $500.00 ]   (act)         [ Cancel request ] [ Record as paid ]   (staff)
```
After `PAID`: receipt link (Stripe's hosted receipt), paid-at, and for staff a **Refund** button (confirm dialog; full refund). After `EXPIRED`: *"Payment link expired"* + **Request again** (staff). After `RECORDED`: *"Paid outside Ithas Fire (cash)"*.

**Timeline** — the six `booking_rental.*` entries render as sentences in the existing ledger, en + es.

**Inbox** — the Agreement/Event stage rows show a small `Rental · unpaid` / `paid` chip. No new tab, no filter in v1.

**Admin calendar** — an event minted from a `VENUE_RENTAL` agreement with an unpaid rental gets the same chip on its cell. Chip only; it does not change the event's status or blocking (money never gates).

**Sent-requests view (act side)** — the status card, minus staff buttons.

**Help center** — new `### Rental fees` subsection under "Talk it through: the conversation" in `booking-requests.md`, and a paragraph in the act-side article. Must say plainly: paid to the venue directly, Ithas Fire takes nothing and holds nothing, refunds are the venue's decision.

**EventMode.** Rentals need a `Place` with a connected account: `VENUE`, and the venue leg of `HYBRID`. `LIVING_ROOM` / `HostSpace` rentals are out of scope — renting a private residence is a different trust question and should not be answered by omission.

---

## Non-Goals

- **Holding money, taking a cut, settling anything.** No `application_fee_amount`, no ledger entry, no `Order`, no `OrderSplit`, no payout. If a venue later asks Ithas Fire to *manage* rental payouts, that is a new decision, not an extension of this one.
- **Stripe Invoicing.** 0.4% to the venue for an invoice number and NET terms. Not needed by a grassroots room; a PAC with an AP department can get it as an opt-in later — same port, one more method. Not `invoice_creation` on the link either (unconfirmed whether it triggers the fee).
- **Gating.** Unpaid never blocks hold, confirm, publish, or the event. Owner-locked.
- **Deposits, partial payments, instalments.** One link, one amount.
- **Platform-defined cancellation/refund policy.** The venue's note is the policy; the refund button is the enforcement.
- **Tax calculation.** The venue is merchant of record; sales tax on a rental is theirs. `automatic_tax` on the link requires Stripe Tax on *their* account — not wired here. **Never route this through ZipTax.**
- **W-9 / 1099 handling.** Direct charges mean the venue's Stripe account carries the venue's own reporting. Ithas Fire never touches a tax form for rentals — which closes the W-9 question from the Drkmttr notes at zero cost.
- **Acts paying to pitch.** The link is requested by the venue on an existing agreement. Nothing is charged to submit a booking request.
- **Reusing `Agreement.waiver*` or any waiver table** for rental terms. The note is prose on the agreement.

---

## Acceptance Criteria

- [ ] Staff on an eligible venue can request a rental fee from the thread; a single-use Payment Link is created **on the venue's connected account** (`stripeAccount` header, verified in the adapter test against the request body), with `metadata.kind = "room_rental"`, no `application_fee_amount`, and `restrictions.completed_sessions.limit = 1`
- [ ] The act sees the status card with amount, due date, note, and a Pay button; the venue's name, not Ithas Fire's, is on the checkout page
- [ ] `checkout.session.completed` for the connected account moves the agreement to `PAID`, exactly once; a replay of the same event is a no-op (idempotency test); a session whose `event.account` or `payment_link` does not match the agreement is rejected as `rental_account_mismatch` and DLQ'd, never applied
- [ ] A non-rental `checkout.session.completed` on the same connected account is acknowledged and ignored — no throw, no DLQ, no alert
- [ ] The webhook handler is the first in the file to read `event.account`, and does so only in the new cases
- [ ] `rentalDueAt` passing moves `REQUESTED → EXPIRED` and deactivates the link (adapter call asserted); the act can no longer pay through it; staff can request again
- [ ] A late completion on an `EXPIRED` row is accepted and marked `PAID` with `late: true`
- [ ] A venue whose Payee is not eligible sees the two-button fallback, and **Record a payment** writes `RECORDED` with a method; the flow from there is identical
- [ ] Refund from the staff card issues a full refund **on the connected account** and moves to `REFUNDED`; a refund issued from the venue's own Stripe dashboard is reflected via `charge.refunded`
- [ ] Requesting a fee on a `PERFORMANCE` agreement stamps `type = VENUE_RENTAL`; `Event.agreement.type` is the only "is this a rental" signal — no column on `Event`
- [ ] Hold, confirm, publish, and event status are provably unaffected by `rentalPaymentStatus` (a test publishes and completes an event with an `EXPIRED` rental)
- [ ] All six `booking_rental.*` entries have `.strict()` schemas, render in en and es, and are visible to the act
- [ ] Five notification intents dispatch with the right audience; the reminder fires once at due − 48h and never after `PAID | CANCELLED | RECORDED`
- [ ] No row is written to `Order`, `OrderSplit`, `PayeeLedgerEntry`, or any settlement table by any path in this feature (grep-guard test in the style of `no-money-splits-guard.test.ts`)
- [ ] Help article updated; the sentence "paid to the venue directly — Ithas Fire takes nothing and holds nothing" appears in both venue and act articles
- [ ] Driven in the real app: request → pay in Stripe test mode on a connected test account → card updates without reload; 320px checked on the thread card

---

## Open Questions

1. **Default due date.** 7 days, or "N days before the event date", or venue-configurable per place? Recommendation: 7 days, capped at the event date, no setting in v1.
2. **What happens to the event when the rental expires unpaid?** Nothing automatic (locked). But should the *staff* card on an event with an `EXPIRED` rental offer "Cancel event" as a one-click next step? Recommendation: yes, as a link to the existing cancel flow — not a new use case.
3. **Currency.** `rentalFeeCurrency` follows the venue's `Payee.defaultCurrency`; the platform is USD-only in practice. Confirm we refuse a non-USD Payee rather than guessing.
4. **Receipts.** Stripe emails a Checkout receipt only if the connected account has receipts enabled. Do we set that during Express onboarding, or accept that some acts get no email and rely on the in-thread receipt link? Recommendation: rely on the thread; document it.
5. **`charge.refunded` on connected accounts** — confirm the current Connect webhook subscription includes it (the endpoint is registered in Stripe's dashboard/Terraform, not in code). If not, dashboard refunds won't reflect until someone looks; acceptable for v1 if flagged in the help text.
6. **Interview validation.** Rental demand is still N=1 (an artist's report) plus the category gap from competitive research. The first venue to use this is the design partner; ship the `RECORDED` path first if a Stripe-less venue asks before a Stripe-enabled one does.

---

## Review Posture

Money-adjacent but **not settlement code** — no split, ledger, or payout path is touched, and the grep-guard test enforces that. Still:

- Full `reviewer` pass; the webhook tenant check (`event.account` ↔ `rentalStripeAccountId`) and the idempotency of `recordRentalCheckoutCompleted` are the two places a bug becomes someone's money.
- Codex second opinion on the adapter (first direct-charge code in the repo) and the webhook case.
- `security-review` lens on the webhook: signed-event trust, replay, cross-account routing.
- Run it: Stripe test mode with a connected Express test account, not mocks, before calling it done.
