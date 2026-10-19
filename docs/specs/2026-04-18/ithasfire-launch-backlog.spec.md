# Ithas Fire Launch Backlog — Master Spec Sheet

**Date:** 2026-04-18
**Status:** living document
**Purpose:** Single source of truth for what needs to be built, fixed, or decided before and after first paid event. Generated from research sessions covering fee structure, venue economics, house show legality, competitive analysis, chargeback mechanics, and resale design.

**Research references:** See `docs/research/` for supporting data.

---

## Legend

| Priority | Meaning |
|---|---|
| **P0** | Blocks first paid event — must ship before any money flows |
| **P1** | Blocks growth — needed within 30 days of first event |
| **P2** | Competitive differentiator — ship within 90 days |
| **P3** | Strategic — ship within 6 months |
| **P4** | Vision — year+ roadmap |

| Status | Meaning |
|---|---|
| **SCHEMA DONE** | Prisma model exists |
| **BUILT** | Backend + frontend functional |
| **SPEC EXISTS** | Spec written, not yet built |
| **NEEDS SPEC** | Requires a detailed spec before building |
| **NEEDS DECISION** | Blocked on a founder/product decision |
| **RESEARCH DONE** | Research complete, ready for spec |

---

## 1. Fee Structure & Pricing Engine

### 1.1 — Finalize fee structure [P0] [DECIDED]

**Decision (2026-04-18):**
- Primary tickets: **2.9% + $0.30 (Stripe passthrough, labeled "refund-protected processing") + $0.50 flat (Ithas Fire fee)**
- Donations (ADJUSTABLE tickets): **2.9% + $0.30 (Stripe passthrough) + 1% uncapped (Ithas Fire fee)**
- Resale: markup split percentage back to venue/artist per agreement, Ithas Fire takes $0 or minimal fee on resale
- Free events: $0 — no payment intent created

**What exists:** `FeePolicy` model with `buyerFeePct`, `platformFixedCents`, `processorFeePct`, `processorFixedCents`, `feeMode` (ABSORB/PASS_THROUGH).

**What needs building:**
- [ ] Update `FeePolicy` seed/default to reflect decided rates
- [ ] Add donation-specific fee logic: when `TicketType.pricingMode === ADJUSTABLE`, apply 1% instead of flat $0.50
- [ ] Pricing page on hearthfire.community
- [ ] Fee calculator tool (public-facing)

**Research:** `docs/records/2026-04-18-ticketing-pricing-models.md`

### 1.2 — FTC all-in pricing compliance [P0] [SPEC EXISTS]

**Spec:** [FTC all-in pricing spec](../2026-04-20/ftc-all-in-pricing.spec.yaml)

**What needs building:**
- [ ] Checkout UI always shows total (ticket + all fees) as the primary displayed price
- [ ] Event listing cards show all-in price, not face value
- [ ] Fee breakdown available on hover/click but never more prominent than total

**Research:** `docs/records/2026-04-18-ticketing-pricing-models.md` (FTC section)

---

## 2. Refund & Chargeback Protection

### 2.1 — Bake refund cost into platform fee [P0] [NEEDS SPEC]

- [ ] Verify refund flow returns full `paidAmountCents` to buyer
- [ ] Platform fee ($0.50) retained on refund (service rendered)
- [ ] Clear refund policy text at checkout

### 2.2 — Auto-refund on event cancellation [P0] [NEEDS SPEC]

- [ ] Event status → CANCELLED triggers refunds for ALL SUCCEEDED orders
- [ ] Include donation orders (override nonRefundable flag)
- [ ] Email notification to all ticket holders
- [ ] Audit trail for all auto-refunds

### 2.3 — Chargeback reserve [P1] [NEEDS SPEC]

- [ ] Hold 5-10% of settlement for 60 days post-event
- [ ] Release after window closes if no chargebacks
- [ ] Dashboard visibility for organizer

### 2.4 — Dispute rate monitor [P1] [NEEDS SPEC]

- [ ] Platform-wide chargeback rate tracking
- [ ] Alert at 0.5% (before Visa/MC 0.9% threshold)
- [ ] Per-organizer dispute tracking

---

## 3. House Show / Private Event Support

### 3.1 — Donation ticket type [P0] [SPEC EXISTS]

**Spec:** `docs/specs/2026-04-18/donation-ticket-type.spec.md`

### 3.2 — Private event mode [P1] [PARTIALLY BUILT]

- [ ] "House Show" creation preset (PRIVATE, HIDDEN, ONE_HOUR_BEFORE reveal, ADJUSTABLE pricing)
- [ ] Private events excluded from public discovery/search
- [ ] Address revealed to ALL RSVPs regardless of payment

### 3.3 — Host attestation [P1] [NEEDS SPEC]

- [ ] Checkboxes: legal right, noise compliance, no alcohol sale, taxable income, FAQ reviewed
- [ ] Stored with timestamp

### 3.4 — Soft capacity cap [P1] [NEEDS SPEC]

- [ ] Default 40, tooltip about fire code at 50

### 3.5 — House show legal FAQ [P1] [RESEARCH DONE]

**Research:** `docs/records/2026-04-18-house-show-legal.md`

### 3.6 — Clickwrap waiver [P0] [SCHEMA DONE]

- [ ] Platform-provided default house show waiver template
- [ ] Checkbox at RSVP/checkout

---

## 4. Resale Mechanism

### 4.1 — Resale with markup split [P2] [SCHEMA DONE, NEEDS SPEC UPDATE]

- [ ] Markup above face value splits per resale payout terms
- [ ] Live UI breakdown at listing time
- [ ] Organizer-configurable split percentage (default 50/50)

### 4.2 — Resale refund handling [P2] [NEEDS SPEC]

---

## 5. Organizer Onboarding & Trust

### 5.1 — Organizer KYC via Stripe Connect [P0] [PARTIALLY BUILT]

- [ ] Require identity verification before paid events
- [ ] Block publishing if payoutsEnabled === false

### 5.2 — Organizer trust tiers [P1] [SCHEMA DONE]

- [ ] Trust tier computation job
- [ ] Payout schedule varies by tier

---

## 6. Volunteer System

### 6.1 — Platform liability disclaimer [P1] [NEEDS SPEC]

- [ ] "Organized by [Organizer Name], not Ithas Fire" on volunteer signup
- [ ] Never create platform-branded roles

**Research:** `docs/records/2026-04-18-house-show-legal.md` (Sofar section)

---

## 7. Venue Intelligence & Reviews

### 7.1 — Place review form v3 [P0] [SPEC EXISTS, SCHEMA DONE]
### 7.2 — Venue autocomplete fix [P0] [BROKEN]
### 7.3 — Review visibility thresholds [P1] [NEEDS SPEC]
### 7.4 — Review moderation [P1] [NEEDS SPEC]

---

## 8. Fan Attribution

### 8.1 — Per-artist referral links [P1] [SCHEMA DONE, SPEC EXISTS]

---

## 9. Platform Operations

### 9.1 — 1099-K via Stripe Connect [P1] [RESEARCH DONE]
### 9.2 — Marketplace facilitator tax [P2] [NEEDS SPEC]
### 9.3 — Terms of service [P0] [SPEC EXISTS]
### 9.4 — Search indexing fix [P0] [BROKEN]

---

## 10. Infrastructure

### 10.1 — Sentry performance [P1]
### 10.2 — Terraform fixes [P0] [IN PROGRESS]
### 10.3 — Mobile form fixes [P1] [IN PROGRESS]

---

## 11. Outreach

### 11.1 — YEP post [P0] [PENDING APPROVAL]
### 11.2 — Scott Barker interview [P1] [PENDING]
### 11.3 — BYOFL outreach [P3] [AFTER 50 REVIEWS]

---

## 12. Content & Brand

### 12.1 — Pricing page [P0]
### 12.2 — House show FAQ [P1]
### 12.3 — "Why Ithas Fire" page [P1]

---

## 13. Vision (P4)

- MCP server, Stripe Terminal POS, Zapier/webhooks, tour routing, festival backend, artist EPK, bundled insurance, white-label API, international expansion

---

## 14. Added 2026-10-08 (docs consolidation)

### 14.1 — Convert a community listing into an owned event [NEEDS SPEC]
Owner 2026-10-08: "We need that." An ownerless community listing has no path to become an event the organizer owns and sells; no COMMUNITY→OWNED conversion exists in code. This replaces the dropped scraper-based event-claim spec.

### 14.2 — Inventory reconciliation job [SPEC EXISTS]
`docs/specs/2025-12-14/inventory-reconciliation.spec.yaml`, kept by the owner on 2026-10-08. Not built.

---

*Living backlog. Update as specs ship. Review weekly.*
