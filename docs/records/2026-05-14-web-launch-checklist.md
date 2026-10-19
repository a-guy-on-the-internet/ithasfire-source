# Web App — Pre-Launch Checklist

**Date:** 2026-05-14
**Status:** living document — most items audited and shipped 2026-05-14
**Priority:** P0 launch blockers + companion P1/P2 items
**Companion to:** `dispute-handling.spec.md`, `dispute-prevention-quick-wins.spec.md`, `ithasfire-lead-time-todos.md` (Desktop)

---

## Audit summary — 2026-05-14

| ID | Title | Status | Notes |
|---|---|---|---|
| 1 | Refund policy + checkbox + platform-fee | ✅ done | Combined Terms/refund ack fully wired; paid-ticket disclosure states Ithas Fire platform-processing fee is non-refundable |
| 2 | Statement descriptor with event name | ✅ done | Helper + adapter + checkout + Order column all in place |
| 3 | 3DS automatic mode | ✅ done | Set on every online PaymentIntent |
| 4 | Host attestation checkboxes | ⚠ spec ready, build missing | `host-attestation.spec.md` exists; UI/schema/backend still missing |
| 5 | ToS rewrite | ✅ done | 19-section, 372-line ToS dated May 2026 |
| 6 | Receipt email seat-label | ⚠ partial | Seat labels exist in code but not passed to mailer |
| 7 | Apple Pay domain file | ⏸ blocked | Placeholder present; needs Stripe-issued token |
| 8 | Cookie list audit | ✅ done | Policy and code agree |
| 9 | Chargeback terms acceptance | ⚠ spec ready, build/legal copy missing | `dispute-handling.spec.md` Phase 0; required before real-money paid events/checkouts/payout enablement |

**Remaining real work:**
- **Chargeback terms acceptance** (Item 9) — legal copy + web/backend gates before real-money paid events/checkouts/payout enablement
- **Host attestation build** (Item 4) — real launch blocker before first organiser publishes, spec ready, ~1 day build
- **Email seat-label** (Item 6) — ~30 min, plumbing only
- **Apple Pay file** (Item 7) — 5 min once Stripe token is in hand

---

## ✅ Item 1 — Refund policy text + acknowledgement checkbox at checkout

**Status:** ✅ shipped
**Verified:** 2026-05-14 audit

### What's in place

- `apps/web/src/app/events/checkout/[...slug]/_components/RefundDisclosure.tsx:163-181` — refund disclosure is a required `<input type="checkbox">`, gates form submission
- `apps/web/src/app/events/checkout/[...slug]/_components/Checkout.tsx:171-172,1307` — `refundPolicyAccepted` state tracked; Pay button is `disabled={!termsAccepted || !refundPolicyAccepted}`
- `packages/core/src/use-cases/orders/create-checkout.ts:79-80,153` — schema accepts `refundPolicyAccepted`, server-side rejects when not true
- `packages/db/prisma/order.prisma:48-52` — `refundPolicyAckAt`, `refundPolicyAckIp`, `refundPolicyVersion`, and `refundPolicyText` columns persisted

### Platform-fee disclosure broadening

- [x] Extend platform-fee non-refundable copy to paid checkout, not just donation/adjustable tickets
  - `RefundDisclosure` now renders paid-ticket copy that states Ithas Fire's platform-processing fee is non-refundable before payment
  - The acknowledgement is combined with Terms of Service in the same checkbox box

---

## ✅ Item 2 — Statement descriptor with event name

**Status:** ✅ shipped
**Verified:** 2026-05-14 audit

### What's in place

- `packages/core/src/lib/payments/statement-descriptor.ts` — `buildStatementDescriptorSuffix(title, eventId)` exists with sanitisation + 22-char cap
- `packages/adapters/src/payment-processors/stripe/stripe-adapter.ts:124-126` — passes `statement_descriptor_suffix` to Stripe on every online PaymentIntent
- `packages/ports/src/payment-processor-port.ts:25` — port input accepts `statementDescriptorSuffix?: string`
- `packages/core/src/use-cases/orders/create-checkout.ts:343-346,541` — computes suffix from `event.title` and persists as `billingDescriptor` on the order
- `packages/db/prisma/order.prisma:33` — `billingDescriptor` column exists

---

## ✅ Item 3 — 3D Secure in automatic mode

**Status:** ✅ shipped
**Verified:** 2026-05-14 audit

### What's in place

- `packages/adapters/src/payment-processors/stripe/stripe-adapter.ts:122` — `payment_method_options.card.request_three_d_secure: "automatic"` set on every online PaymentIntent
- `stripe-adapter.test.ts` — test coverage asserts the field is present

---

## ⚠ Item 4 — Host attestation checkboxes on event publish

**Status:** ⚠ spec ready; implementation missing — biggest real gap on this checklist
**Effort:** ~1 day build

### Current state

- `host-attestation.spec.md` defines the schema, publish/unpublish behavior, modal UX, tests, and rollout plan
- `apps/web/src/app/admin/[slug]/events/new/page.tsx:1-20` is now a redirect; event creation goes through a tRPC mutation `useCreateDraftEvent` imperatively
- `packages/db/prisma/event.prisma` has no attestation, compliance, or legal-right-to-host fields
- No `EventAttestation` model or equivalent exists in code yet
- No checkboxes for legal right to host, noise/zoning compliance, alcohol service/sale/donation/BYOB compliance, tax responsibility, FAQ review

### Definition of done

- [x] Spec written before implementation begins (`host-attestation.spec.md`)
- [ ] Event publish flow has required checkboxes for:
  - [ ] Legal right to host at the venue
  - [ ] Compliance with local noise/zoning ordinances
  - [ ] Alcohol service/sale/donation/BYOB compliance
  - [ ] Acceptance of tax responsibility for revenue
  - [ ] Organizer FAQ has been reviewed
- [ ] Acknowledgement persisted as an `EventAttestation` row with timestamp + actor ID and `Event.currentAttestationId` stamped on successful publish
- [ ] Unpublish clears `Event.currentAttestationId` while preserving attestation history
- [ ] Backend rejects unpublished → `PUBLISHED` transitions without attestation
- [x] Gate decision resolved: publish only, never draft creation (org can iterate on a draft before legal exposure)

**Covers TODOs:** `~/Desktop/ithasfire-lead-time-todos.md` line 166, launch-backlog 3.3.

**Why launch-blocker:** Required before real organisers can publish events to take money. The moment one does, this needs to be live.

---

## ✅ Item 5 — Terms of Service

**Status:** ✅ shipped
**Verified:** 2026-05-14 audit

### What's in place

`apps/web/src/app/terms/page.tsx` — 372 lines, 19 sections, dated May 2026. Sections audited:

- ✅ Organizer obligations (section 6, lines 149-197)
- ✅ Dispute resolution (section 17, lines 324-347)
- ✅ Indemnification (section 14, lines 291-303)
- ✅ Governing law (section 17, lines 324-347)
- ✅ Refund policy detail (section 5, lines 99-147)
- ✅ Withholding-from-payouts authorization (section 6, lines 183-196 — "may withhold or reserve")

### Open question

The Phase 0/Phase 4 dispute work in `dispute-handling.spec.md` cites Section 6 as the legal basis. Focused legal-counsel pass is required before real-money chargeback terms are enforced:
- Whether "may withhold or reserve" language is strong enough for actual offset against future payouts
- Arbitration clause survives in every jurisdiction you plan to operate (consumer protection law varies)
- 2-3 hours of paid lawyer time; blocker before real-money paid events/checkouts/payout enablement, not a blocker for continuing implementation

---

## ⚠ Item 6 — Receipt email seat-label

**Status:** ⚠ partial — data exists, just not passed to email
**Effort:** ~30 minutes

### Current state

- `send-ticket-issued-email.ts:108-122` builds `ticketAssets` containing only `code` and `qrUrl` — no seat label
- `Checkout.tsx:491-505` already builds `selectedSeatLabels` lookup with section/row/seat — but only passes it to `OrderConfirmation`, never to `mailer.send()`
- Template variables (lines 128-143) include `eventTitle`, `venueName`, `tickets` but NOT seat info

### Definition of done

- [ ] Plumb seat label (`section / row / seat`) from ticket metadata into `ticketAssets` builder in `send-ticket-issued-email.ts`
- [ ] Add to template variables and render alongside ticket code
- [ ] Send a real test order with a seated event, eyeball the email

**Why P2:** Tiny dispute-evidence win — proves to Stripe that the buyer received specific seat-level service.

---

## ⏸ Item 7 — Apple Pay merchant domain association file

**Status:** ⏸ blocked — needs Stripe-issued token first
**Effort:** ~5 minutes once unblocked

### Current state

- `apps/web/public/.well-known/apple-developer-merchantid-domain-association` exists but contains **placeholder instructions** (lines 4-26), not real Stripe content
- The Content-Type: text/plain header rule may or may not be in `next.config.ts` — verify before deploying real content; Apple's check fails if the file is served as `application/json` or wrapped in HTML

### Definition of done

- [ ] Register `hearthfire.community` in Stripe Dashboard → Settings → Payment methods → Apple Pay
- [ ] Stripe shows file content to host
- [ ] Replace placeholder file contents with the real token
- [ ] Verify route serves it as `text/plain` (no HTML wrap, no Next route handler in front)
- [ ] Confirm Apple Pay button renders in the Express Checkout row on live web checkout

---

## ✅ Item 8 — Cookie list audit

**Status:** ✅ done (verified, no fixes needed)
**Verified:** 2026-05-14 audit

### What's in place

- `apps/web/src/app/cookie-policy/page.tsx` documents 3 essential cookies + 2 opt-in:
  - `th-consent` (essential)
  - `better-auth.session_token` (essential)
  - `__stripe_mid` / `__stripe_sid` (essential)
  - Google Analytics (opt-in)
  - Sentry session replay (opt-in)
- `apps/web/src/hooks/useConsent.ts:41,137` sets `th-consent` via `document.cookie`
- Better Auth session cookie set by the auth library, name matches policy
- Stripe.js sets `__stripe_mid/__stripe_sid` during init, matches policy

### Verdict

Policy and code agree. No drift detected.

---

## ⚠ Item 9 — Chargeback terms acceptance

**Status:** ⚠ spec ready; legal copy + implementation missing
**Effort:** ~0.5-1 day after legal copy is approved

### Current state

- `dispute-handling.spec.md` Phase 0 defines the requirement
- Current ToS Section 6 has withholding/reserve language, but it has not been converted into a versioned chargeback/payout-hold acknowledgement flow
- No publish, checkout, or payout-enable gate currently verifies chargeback terms acceptance for the event risk owner

### Definition of done

- [ ] Legal approves chargeback/payout-hold copy covering dispute holds, payout skips, future-payout recovery, payout suspension, and any future manual reserves
- [ ] Org-owned events require org owner/admin acceptance of the current chargeback terms version
- [ ] Direct human-owned paid events require the human owner to accept the current chargeback terms version
- [ ] Paid event publish, paid checkout before PaymentIntent creation, and payout enablement are server-gated on current acceptance
- [ ] Acceptance timestamp/version/actor are persisted on the risk owner

**Why launch-blocker:** buyers can file chargebacks as soon as real-money paid checkout is live. Organisers must accept the payout-hold/recovery terms before they take that money.

---

## What to do next, in priority order

1. **Chargeback terms acceptance** (Item 9) — legal copy + gates before real-money paid events/checkouts/payout enablement
2. **Host attestation build** (Item 4) — 1 day, real launch blocker before first organiser publishes
3. **Email seat-label** (Item 6) — 30 min, finishes a P2 disputed-evidence gain
4. **POS operator acknowledgement** (`pos-attestation.spec.md`) — build with first Tap to Pay rollout, not web launch
5. **Apple Pay file** (Item 7) — 5 min, only after you register the domain in Stripe Dashboard

The big surprise: you already shipped the three dispute-prevention quick wins (#1-#3). `dispute-prevention-quick-wins.spec.md` is now implementation-complete.

---

## Out of scope (deliberately)

- Dispute-response implementation beyond Phase 0 terms acceptance (Phases 1-5 in `dispute-handling.spec.md`) — separate launch track
- Mobile/scanner work (separate spec, blocked on Apple LLC conversion)
- Infra/CI work (covered by existing infra specs)
- External account work (Apple Developer, Stripe Dashboard, etc.) — that lives in `~/Desktop/ithasfire-lead-time-todos.md`
