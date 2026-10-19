# Dispute-Prevention Quick Wins

**Date:** 2026-05-14
**Status:** complete
**Priority:** P0 (pre-launch, independent of full dispute-handling spec)
**Companion to:** `dispute-handling.spec.md` (Phase 3 — baseline prevention quick wins)
**Depends on:** Stripe adapter (`packages/adapters/src/payment-processors/stripe/stripe-adapter.ts`), checkout flow (`packages/core/src/use-cases/orders/create-checkout.ts`), web checkout UI (`apps/web/src/app/events/checkout/`)

---

## Problem

The full dispute-handling pipeline (`dispute-handling.spec.md`) handles disputes once they happen. This spec is everything we can ship in **under a day total** to reduce the volume of disputes that ever reach the pipeline. Each item is independent and shippable as its own PR.

Three gaps were identified in audit on 2026-05-14, and the implementation now covers them:

1. **Online checkout had no statement descriptor.** Only the POS card-present flow set `statement_descriptor_suffix` (`stripe-adapter.ts:435-447`). Online buyers saw "ITHASFIRE LLC" on their bank statement with no event context. "I don't recognise this charge" is the single most common dispute reason on ticketing platforms.
2. **3D Secure was not requested on any transaction.** No `payment_method_options.card.request_three_d_secure` was set anywhere in the adapter. We got whatever default Stripe Radar decided, which is typically nothing. Missed opportunity for free liability shift on fraud disputes.
3. **Refund policy was disclosed but not acknowledged.** `RefundDisclosure.tsx` showed the policy text passively. The Terms and Waiver next to it were required checkboxes; the refund policy was not. Stripe's dispute-evidence guide weighs gated acknowledgement (with timestamp + IP) materially higher than passive disclosure.

What's *not* in scope here — these already work and the audit confirmed they're solid:

- Scan-in logging (`TicketScan` records, `scan-ticket.ts:553-573`) — already gold-tier evidence
- Self-serve refund (`get-refund-eligibility.ts`, `refund-full-order.ts`) — buyer can refund until event start, better than the 24h industry norm
- Order receipt emails (`send-ticket-issued-email.ts`) — mostly complete (one small seat-label polish optional, not required)

## Goals

- Every online PaymentIntent carries a statement descriptor that includes the event name.
- 3DS is requested in `automatic` mode on every card payment so Stripe can opportunistically challenge risky charges. Liability shifts to the issuer when a 3DS-authenticated charge is disputed as fraud.
- Buyers must tick an explicit refund-policy checkbox before payment, and the acknowledgement is persisted on the order with timestamp, server-observed IP, policy version, and policy text snapshot.
- All three changes are testable, behind no feature flag, and roll back via revert.

## Non-Goals

- Paying for Stripe Radar for Fraud Teams ($0.07/txn). Free Radar is already running; the paid tier is deferred until post-launch data justifies it.
- Custom Radar rules. Out of scope; revisit after 30 days of dispute data.
- Forced 3DS (`request_three_d_secure: "any"`). `automatic` lets Stripe decide and minimises checkout friction. Forcing 3DS on everything causes ~5-10% checkout abandonment.
- Reworking the receipt email beyond a small seat-label addition. The audit found receipts already include event title, date, venue, order ID, and ticket codes.

## Context

| Surface | File |
|---|---|
| Stripe adapter — online PI creation | `packages/adapters/src/payment-processors/stripe/stripe-adapter.ts:90-111` |
| Stripe adapter — POS PI creation (reference) | `packages/adapters/src/payment-processors/stripe/stripe-adapter.ts:435-447` |
| Checkout use case | `packages/core/src/use-cases/orders/create-checkout.ts:514-523` |
| Web checkout component | `apps/web/src/app/events/checkout/[...slug]/_components/Checkout.tsx` |
| Refund disclosure component | `apps/web/src/app/events/checkout/[...slug]/_components/RefundDisclosure.tsx` |
| Order entity | `packages/core/src/entities/order.ts` |
| Order Prisma model | `packages/db/prisma/order.prisma` (`Order`) |
| Ticket-issued email template | `packages/core/src/use-cases/orders/send-ticket-issued-email.ts:111-133` |

---

## Change 1 — Statement descriptor with event name

### Behaviour

Every online PaymentIntent created via `createPaymentIntent` includes a `statement_descriptor_suffix` derived from the event name. Final buyer-visible descriptor on the bank statement becomes `ITHASFIRE* <EVENT_SHORT>` (Stripe joins the platform's account-level descriptor with the suffix).

### Constraints from Stripe

- Suffix max length: **22 characters** including any spaces.
- Allowed characters: ASCII letters, digits, spaces, and `. _ - ,`. No `*`, `<`, `>`, `'`, `"`, backslash.
- Cannot contain only digits.
- Must contain at least one letter.

### Derivation rule

Given `event.title`:

1. Strip diacritics; transliterate to ASCII.
2. Replace any character outside `[A-Za-z0-9 .,_-]` with a space.
3. Collapse whitespace, trim.
4. Truncate to 22 chars, prefer cutting at the last word boundary.
5. If empty or all digits after sanitising, fall back to `EVENT <eventId-prefix>`.
6. Uppercase.

Implement as a pure core helper `buildStatementDescriptorSuffix(title: string, eventId: string): string` in `packages/core/src/lib/payments/statement-descriptor.ts`, with unit tests covering: unicode title, very long title, emoji title, all-digit title, empty title.

### Where to wire

- `packages/ports/src/payment-processor-port.ts` — add optional `statementDescriptorSuffix?: string` to `createPaymentIntent`.
- `packages/adapters/src/payment-processors/stripe/stripe-adapter.ts:90-111` — accept the optional parameter and pass it through to Stripe as `statement_descriptor_suffix`.
- `packages/core/src/use-cases/orders/create-checkout.ts:514-523` — compute suffix from `event.title` and pass into the call.
- Snapshot the suffix onto `Order.billingDescriptor` for later use in dispute evidence. Do not trust a client-supplied descriptor.

### Order schema

Add to `Order` in `packages/db/prisma/order.prisma`:

```prisma
billingDescriptor String?
```

No migration concerns — nullable column.

### Edge cases

- Multi-event orders (cart with tickets from multiple events): use the first event's title; events from different organisers shouldn't be in the same cart anyway.
- Free orders: no PaymentIntent, descriptor irrelevant.
- Re-running checkout after failure: descriptor is recomputed from current event title; acceptable.

### Tests

- Unit: `buildStatementDescriptorSuffix` against the cases listed above.
- Integration: `create-checkout` test verifying the suffix is passed to the payment adapter mock and persisted on the order.

---

## Change 2 — 3D Secure in automatic mode

### Behaviour

Every online PaymentIntent carries `payment_method_options.card.request_three_d_secure: "automatic"`. Stripe then decides per-charge whether to challenge; we don't write rules. When Stripe does challenge and the buyer authenticates, fraud disputes on that charge shift liability to the issuer — we cannot lose them.

This setting applies to the `card` payment method option even though the online checkout PaymentIntent may also allow wallets, Cash App, Amazon Pay, ACH, or bank transfer depending on currency and embed settings.

### Where to wire

`packages/adapters/src/payment-processors/stripe/stripe-adapter.ts:90-111`:

```ts
const intent = await this.client.paymentIntents.create({
  // ...existing fields...
  payment_method_options: {
    card: { request_three_d_secure: "automatic" },
  },
});
```

### Non-impact on the SetupIntent / off-session flow

If we have any saved-card flows (off-session captures), they should *not* set this — 3DS on an off-session charge can't be completed by an absent buyer. Audit only flagged on-session online checkout; if/when off-session capture exists, it should override to `any_with_user_present_only` or omit.

### Friction risk

`automatic` only triggers 3DS when Stripe's risk model + issuer signals indicate it's appropriate. In practice this is ~5-15% of charges. Drop-off rate during 3DS challenge is real but small (~1-3% of challenged transactions). Net effect: we lose a sliver of transactions but eliminate a category of disputes we'd otherwise certainly lose.

### Tests

- Adapter unit test: PI is created with `payment_method_options.card.request_three_d_secure === "automatic"`.
- E2E (existing Stripe-paid checkout spec): no change required if the test card doesn't trigger 3DS. If it does, ensure the test handles the 3DS confirmation step.

---

## Change 3 — Refund policy acknowledgement gate

### Behaviour

The refund-policy acknowledgement is required before checkout. On surfaces that also require platform Terms, the UI uses one combined Terms/refund checkbox box; on refund-only surfaces, `RefundDisclosure` can still render its standalone refund-policy checkbox. The "Pay" button is disabled until the required acknowledgement state is satisfied. On submission, we persist `refundPolicyAckAt` (server timestamp), `refundPolicyAckIp` (server-observed request IP), `refundPolicyVersion`, and `refundPolicyText` on the order.

### UI

`apps/web/src/app/events/checkout/[...slug]/_components/RefundDisclosure.tsx`:

- Own the required `<input type="checkbox">` and disclosure box.
- When Terms props are supplied, render one combined acknowledgement: buyer agrees to the Terms of Service and has read/agreed to the refund policy.
- Keep the Terms link as a sibling of the checkbox label, not nested inside it.
- Component exposes both refund and Terms checked state up to the parent checkout surface.

`Checkout.tsx`:

- Track `refundPolicyAccepted` alongside Terms and Waiver.
- Pass the Terms state into `RefundDisclosure` so primary, embed, and resale checkout use the combined legal acknowledgement box.
- Include the combined acknowledgement state in the disabled-state computation for the Pay button.
- Send `refundPolicyAccepted: true` in the tRPC checkout mutation.

### Server

`packages/core/src/use-cases/orders/create-checkout.ts`:

- Accept `refundPolicyAccepted: boolean` in input. Reject with a validation error if it is not exactly `true`.
- Capture request IP via the tRPC context or API request context. Persist the server-observed value on the order as `refundPolicyAckIp`; never accept this field from the client.
- Stamp `refundPolicyAckAt = new Date()` at order creation.
- Persist `refundPolicyVersion` and `refundPolicyText` from the server-rendered policy source so dispute evidence can prove what the buyer saw.

### Order schema

Add to `Order` in `packages/db/prisma/order.prisma`:

```prisma
refundPolicyAckAt DateTime?
refundPolicyAckIp String?
refundPolicyVersion String?
refundPolicyText String?
```

Nullable so existing rows are unaffected. New orders post-deploy will always carry these.

### Policy source

For v1, use a single platform-wide refund policy snapshot owned by the server:

- `refundPolicyVersion`: `platform-refund-2026-05`
- `refundPolicyText`: generated by a shared server helper used by both checkout rendering and order creation
- No org/event-specific refund-policy overrides in this quick win

If org/event overrides are needed later, add them in a separate spec with an explicit precedence model and migration for historic snapshots.

### Where to surface in dispute evidence

`dispute-handling.spec.md` Phase 2 references these fields in the evidence assembly table under `refund_policy` and `refund_policy_disclosure`. This change is the upstream half of that.

### Tests

- E2E: checkout cannot proceed without the required Terms/refund acknowledgement ticked.
- E2E: after successful checkout, `Order.refundPolicyAckAt`, `Order.refundPolicyAckIp`, `Order.refundPolicyVersion`, and `Order.refundPolicyText` are populated.
- Unit: `create-checkout` rejects when `refundPolicyAccepted !== true`.

---

## Optional polish — Receipt email seat label

Audit found receipts include event title, date, venue, order ID, and ticket codes, but seat label clarity was unclear. **Optional**, ~30 minutes:

- `packages/core/src/use-cases/orders/send-ticket-issued-email.ts:111-133` — include `tickets[].seatLabel` if the ticket has assigned seating (section/row/seat).
- Update the email template to render the seat label next to the ticket code.

If seats are already in the ticket metadata and rendered, this is a no-op. Verify before scheduling.

---

## Rollout

All three changes ship without feature flags. They are pure additions or low-risk parameter changes; rollback is `git revert`.

Suggested order:

1. **Change 1 (descriptor)** — pure backend, no UI risk. Ship first, observe one full payment cycle.
2. **Change 2 (3DS automatic)** — backend, but introduces a new buyer-facing challenge step on a minority of charges. Ship second, monitor checkout completion rate for 48h.
3. **Change 3 (refund ack)** — small UI + schema + backend. Ship last; coordinate with anyone doing UX work to avoid merge conflicts.

Total estimated effort: **~4 hours of focused work**, plus tests and review.

## Acceptance criteria

- Bank statement on a real test purchase shows `ITHASFIRE* <EVENT>` for an online ticket purchase.
- A PaymentIntent inspected in the Stripe Dashboard shows `payment_method_options.card.request_three_d_secure: "automatic"`.
- Attempting checkout without the required Terms/refund acknowledgement ticked is blocked client-side and rejected server-side.
- After successful checkout, the `Order` row has non-null `billingDescriptor`, `refundPolicyAckAt`, `refundPolicyAckIp`, `refundPolicyVersion`, and `refundPolicyText`.

## Resolved decisions from 2026-05-14

- Embedded checkout must require the same refund-policy checkbox inside the Ithas Fire iframe. A host-page acknowledgement is not enough.
- Custom Radar rules remain post-launch. The quick win is only `request_three_d_secure: "automatic"` plus descriptor and refund-policy acknowledgement.

## Out of scope

- Stripe Radar for Fraud Teams (paid tier)
- Custom Radar rules
- 3DS forced (`any`) mode
- Buyer-facing dispute portal
- Anything covered by `dispute-handling.spec.md` Phases 1, 2, 4, 5
