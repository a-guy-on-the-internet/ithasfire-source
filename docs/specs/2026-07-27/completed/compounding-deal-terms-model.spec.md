# Compounding Deal-Terms Model (Fixed + Percentage) & Reachable Venue Rentals

> Superseded by docs/specs/2026-09-29/deal-terms-and-settlement.spec.yaml (2026-10-08 docs consolidation)

**Date:** 2026-07-27
**Status:** superseded (2026-10-08 docs consolidation; was: draft)
**Priority:** P2 (High Value)
**Depends on:** `PayoutTerms` / `PayoutTermsLine` (finance.prisma), `Agreement` (agreement.prisma), `PayeeLedgerEntry` (finance.prisma), `computeOrderSplits` (`packages/core/src/lib/pricing/compute-order-splits.ts`), `createSettlementFromOrder` (`packages/core/src/use-cases/settlements/create-from-order.ts`), booking-agreement line editor (`packages/core/src/use-cases/booking-agreements/upsert-booking-agreement-line.ts`)
**Supersedes:** —

---

## Problem

Every deal Ithas Fire can express is a percentage of gross ticket revenue. `PayoutTermsLine` has `percent`, `floorCents`, and `capPercent` and nothing else, so three real and common deal shapes are simply unrepresentable:

1. **Four-wall / room rental** — the venue takes a flat fee and forgoes the door entirely. Driver: an artist reported Nashville venues telling him "we forfeit our ticket fees, you just rent the space." In performing arts (theaters, dance companies, recitals) this is the *default* deal, not an edge case.
2. **Flat guarantee** — artist is owed a fixed amount whether or not tickets sell.
3. **Merch cuts** — `PayoutTermsKind.MERCH` exists in the enum, `Event.eventsMerch` exists as a relation, and no code anywhere references either.

The same missing primitive blocks all three: a line that expresses a **fixed amount** rather than a share. `AgreementType.VENUE_RENTAL` also already exists in the enum but is unreachable — the accept path hardcodes `PERFORMANCE`.

Competitively this is unclaimed ground. Prism.fm's own performing-arts guide names "a bought show from a rental, a co-promoted date from a four-wall" as a requirement and implements nothing for it. The private-event category (Tripleseat, Perfect Venue) models rentals properly but has no ticketing or artist side. A rental where the renter *also sells tickets through us* is served by neither category.

---

## Goal

Generalize the deal-terms line so a deal can carry fixed and percentage components that compound, and make `VENUE_RENTAL` a reachable agreement type. A venue booker can then express "you rent the room for $500 and keep the door" or "$400 guarantee plus 10% of tickets" using the vocabulary they already think in, and the settlement engine either computes it correctly or refuses to accept it — never silently mis-settles it.

---

## Context

| What exists | Where |
|---|---|
| `PayoutTermsLine`: `percent`, `floorCents`, `capPercent`, `priority`, `rounding`, `ticketTypeId` scope | `packages/db/prisma/finance.prisma:194` |
| Line confirm/counter lifecycle: `PENDING → CONFIRMED → COUNTERED → DECLINED`, `counterPercentBps`, `counterNote`, re-confirm forced on economics edits | same model + `PayoutLineConfirmationStatus` |
| `PayoutTermsKind = PRIMARY \| RESALE \| MERCH` — MERCH commented "Schema-only in v1; UI deferred until the POS feature lands", zero core references | `packages/db/prisma/enums.prisma:130` |
| Three payout-terms pointers on Event: `eventsPrimary`, `eventsResale`, `eventsMerch` | `packages/db/prisma/finance.prisma:180-182` |
| `AgreementType.VENUE_RENTAL` — defined, unreachable | `packages/db/prisma/enums.prisma:8` |
| Accept path hardcodes `type: "PERFORMANCE"` | `packages/core/src/use-cases/booking-requests/_shared/accept-agreement.ts:66`, `:124` |
| `Event.agreement` relation (one agreement per event, `eventId @unique`) — rental-ness is already derivable | `packages/db/prisma/event.prisma:485` |
| Split math: sorts by `priority`, applies `percent` to basis, floors/caps, then **distributes the penny remainder until allocations sum exactly to the order basis** | `packages/core/src/lib/pricing/compute-order-splits.ts:95-123` |
| Settlement creation filters order items to `kind === "ticket"` | `packages/core/src/use-cases/settlements/create-from-order.ts:93` |
| `PayeeLedgerEntry`: nullable `orderId`, generic `sourceKind`/`sourceId`, unique `idempotencyKey` | `packages/db/prisma/finance.prisma:77` |
| Connected-account negative-balance handling (built for resale refunds) | `Payee.resaleNegativeBalanceCents`, `resalePayoutBlockReason` |

### Industry vocabulary to adopt

Venue bookers already think in these terms; VenuePilot publishes exactly these five. Using their names makes the UI legible on day one.

| Deal type | Shape | This spec |
|---|---|---|
| Guarantee | Flat only | ✅ in scope |
| Four-wall / rental | Flat fee **to the venue**, renter keeps the door | ✅ in scope |
| Straight percentage ("dollar one") | % of gross, no deduction | ✅ already works |
| Guarantee **plus** percentage (dollar one) | Flat + % of gross, additive | ✅ in scope |
| Versus (greater-of) | Flat **vs** %, higher wins | ⛔ deferred — see Settlement Semantics |
| Percentage **after expenses** | % of net | ⛔ deferred — needs expense ledger |
| Guarantee plus percentage **after expenses** | Flat + % of net | ⛔ deferred — needs expense ledger |

---

## Settlement Semantics

**This is the load-bearing section. The schema change is small; the money math is where this spec earns its risk rating.**

### Two different money concepts, and why they must not share a function

`computeOrderSplits` is a **distribution**: `remainder = basis - allocated` followed by `distributeRemainder` guarantees the allocations sum to exactly the order amount ([compute-order-splits.ts:105-110](../../../../packages/core/src/lib/pricing/compute-order-splits.ts#L105-L110)). It is zero-sum by construction.

A fixed obligation is **not** a distribution. A $500 room rental on a $200 order is not a share of $200 — it is $500 owed regardless. Adding a FIXED line to `computeOrderSplits` would let `distributeRemainder` claw the amount back down to fit the basis, silently under-paying the venue.

Therefore:

> **A `FIXED` line MUST NOT be passed to `computeOrderSplits`.** Fixed obligations resolve at settlement time as `PayeeLedgerEntry` rows, independent of any order. `computeOrderSplits` keeps its current invariant (splits sum to basis) and continues to see only `PERCENT` lines.

This also explains why `Order` can't carry a rental: `Order.eventId` is `NOT NULL`, `OrderSplit` requires an `orderId` with `@@unique([orderId, payeeId])`, and `SettlementLine` exists to materialize *order* amounts. A rental fee has no parent order. `PayeeLedgerEntry` is the correct primitive — nullable `orderId`, generic `sourceKind`/`sourceId`, unique `idempotencyKey`.

### Why "versus" (greater-of) is deferred

A versus deal pays the greater of a guarantee or a percentage. Which side wins **cannot be known per-order** — only once the event's total revenue is final. `computeOrderSplits` runs per-order. So versus is not an operator you can add to a line; it requires a new event-level, settlement-time resolution phase that reconciles against splits already computed and possibly already transferred.

That is a materially larger change than the schema work in this spec and it must not be smuggled in. Deferred, with the UI blocking entry (see below).

### Compounding that *is* in scope

Additive compounding works without event-level resolution because the components are independent:

- `FIXED` obligation ($400 guarantee) + `PERCENT` line (10% of gross) → one ledger entry, one order-derived split. Neither depends on the other's outcome.
- Cross-stream compounding is already expressible: a flat room fee (PRIMARY) plus a merch cut (MERCH) are different `PayoutTerms` records by design.

### Shortfall is a real state, not an error

If the event's total revenue cannot cover a fixed obligation, the obligation still stands. The platform does not front the money and does not silently reduce it. The obligation is recorded in full; the shortfall surfaces to both parties and settles as a negative balance against the payer's `Payee` using the existing resale negative-balance machinery. **Do not invent a second mechanism for this.**

---

## Data Model

```prisma
enum PayoutTermsLineAmountType {
  /// Share of the basis. Uses percent / floorCents / capPercent.
  /// Distributed by computeOrderSplits; sums to the order basis.
  PERCENT
  /// Flat obligation in integer cents, independent of revenue.
  /// NEVER passed to computeOrderSplits — settles via PayeeLedgerEntry.
  FIXED
}
```

Additions to `PayoutTermsLine`:

```prisma
model PayoutTermsLine {
  // ── existing fields unchanged ──

  /// Discriminator. Defaults to PERCENT so every existing row keeps its
  /// current meaning with no backfill and no behaviour change.
  amountType   PayoutTermsLineAmountType @default(PERCENT)

  /// Set only when amountType = FIXED. Integer cents, > 0.
  /// SQL-only CHECK enforces the shape both ways (see below).
  amountCents  Int?

  @@index([payoutTermsId, amountType])
}
```

**Shape enforcement.** Prisma cannot express this, so it goes in the migration as a SQL-only CHECK named `PayoutTermsLine_amount_type_shape_check`, following the precedent of `BookingRequest_direction_shape_check`:

- `amountType = 'FIXED'` → `amountCents IS NOT NULL AND amountCents > 0` AND `percent = 0` AND `floorCents = 0` AND `capPercent IS NULL`
- `amountType = 'PERCENT'` → `amountCents IS NULL`

Document the constraint in a schema comment, since the next reader will not find it in the Prisma file.

**`percent` on FIXED lines.** `percent` is non-nullable today. FIXED lines write `percent = 0` and the CHECK enforces it. A `0` percent line is inert in `computeOrderSplits`, which is a second layer of safety if a FIXED line ever leaks into the split path — but the query filter is the primary defence, not this.

### Explicitly not in the data model

- **No `isRental` / `dealType` on `Event`.** `Event.agreement` already exists; rental-ness is `event.agreement.type === "VENUE_RENTAL"`. A denormalized flag would be a second source of truth that drifts from the agreement.
- **No new acceptance table for rental execution.** See Non-Goals.
- **No expense model.** See Deferred.

---

## Use Cases

Follow house conventions: stateless factories, Zod input/output schemas, typed error codes, single `repos.tx()` per mutation, `IdempotencyPort` on anything money-moving, `ReporterPort` on any catch-and-fallback branch.

### Modified

**`upsertBookingAgreementLine`** — accept `amountType` and `amountCents`. Validate the shape in the use case (mirroring the CHECK) so the error is a typed `invalid_input` rather than a P0001 from Postgres. Adding or editing a FIXED line resets `confirmationStatus` to `PENDING` exactly as an economics edit does today — the existing re-confirm rule applies unchanged, and a fixed amount is unambiguously an economics change.

**`createAcceptAgreement` / `createOrganizerAcceptAgreement`** ([accept-agreement.ts:66](../../../../packages/core/src/use-cases/booking-requests/_shared/accept-agreement.ts#L66), [:124](../../../../packages/core/src/use-cases/booking-requests/_shared/accept-agreement.ts#L124)) — take the agreement type from the request rather than hardcoding `PERFORMANCE`. `VENUE_RENTAL` requires a `placeId`; assert it and fail `invalid_input` if absent.

**`createSettlementFromOrder`** — filter payout-terms lines to `amountType = 'PERCENT'` before calling `computeOrderSplits`. This is the primary defence described above. A test must assert that a FIXED line present on the terms does not alter any order split.

### New

**`resolveFixedObligationsForEvent`** — at settlement time, for each `FIXED` line on the event's payout terms, write one `PayeeLedgerEntry` with `sourceKind = "payout_terms_line"`, `sourceId = <line id>`, and `idempotencyKey = fixed-obligation:${eventId}:${lineId}:${generation}`. Idempotent by construction; a re-run must be a no-op, and that must be a test, not an assumption. Requires `IdempotencyPort` and `ReporterPort`.

**`getDealSummaryForAgreement`** — derives a human-readable deal description from the lines using the industry vocabulary ("Four-wall — $500 room fee", "Guarantee $400 + 10% dollar one"). Read-only. Both the agreement UI and the settlement sheet render from this one function so the two can never disagree about what the deal says.

---

## UI / Flow

The line editor gains an amount-type toggle. When FIXED is selected, the percent/floor/cap inputs are replaced by a single money input — not merely disabled, so there is no chance of stale percentage values being submitted alongside a fixed amount.

**Deal-type presets** over raw line construction. A booker picks "Four-wall / rental," "Guarantee," "Straight percentage," or "Guarantee + percentage," and the editor builds the lines. Raw line editing stays available for the cases presets do not cover.

**Blocking, not silent mis-settlement.** The two deferred families must be unenterable and must say why:

- Selecting a **versus** preset shows: *"Versus deals (greater of guarantee or percentage) aren't supported yet — they need end-of-event reconciliation. Enter the guarantee as a fixed fee, or the percentage on its own."*
- Any **after-expenses** preset shows: *"After-expenses deals aren't supported yet — we don't track show expenses. Use 'dollar one' (percentage of gross) instead."*

Do not offer these presets in a disabled state with no explanation; a booker who can't tell whether the product will settle their deal correctly will assume it does.

**Bar-sales terms.** If a booker wants a bar-sales split, the editor must route them to `Agreement.description` as prose with an explicit note that Ithas Fire does not see bar revenue and will not calculate or settle it. Never a line. (See Non-Goals.)

**EventMode.** `VENUE_RENTAL` requires a `Place`, so it applies to `VENUE` and the venue leg of `HYBRID`. `LIVING_ROOM` / `HostSpace` rentals are out of scope for this spec — the deal shape is real but the trust and liability model for renting a private residence is a separate question and should not be answered by omission.

---

## Deferred (each with its reason)

**After-expenses basis + event-level expense ledger.** Three of the five industry deal types are expense-dependent, and the standard indie headline deal is quoted as "80/20 *after expenses*." This is the larger follow-on spec, not an afterthought — the third axis (basis: gross vs net) is entirely absent from the model today. UI-blocked meanwhile.

**Merch goods-class rates.** Industry standard splits differ by goods class: ~80/20 soft goods, ~90/10 recorded media, 10–25% on apparel at indie clubs. So `MERCH` needs a rate per goods class mapped onto `OrderItem.kind` (`merch_freeform` today, `merch_sku` planned), *plus* removing the `kind === "ticket"` filter at [create-from-order.ts:93](../../../packages/core/src/use-cases/settlements/create-from-order.ts#L93). The `FIXED`/`PERCENT` generalization in this spec is the prerequisite; the wiring is its own spec.

**Versus (greater-of) resolution.** Requires event-level settlement-time reconciliation — see Settlement Semantics.

**E-signature.** Clickwrap acceptance only. Shape the execution record so Dropbox Sign / DocuSign can drop in behind it later; never build the signing engine. Industry pattern worth preserving when it lands: contract signed → payment link auto-sent (both Gigwell and Tripleseat do this).

**Rental payment collection / venue as merchant of record.** Collecting the rental fee through the platform requires `on_behalf_of` + `transfer_data.destination` so dispute liability lands on the venue — a deliberate departure from the no-destination-charges rule documented at [stripe-adapter.ts:88](../../../../packages/adapters/src/payment-processors/stripe/stripe-adapter.ts#L88). Separate spec. **This spec models the deal; it does not move the money.** A venue can agree a $500 four-wall and collect it by any means, including off-platform.

**Subscriptions / memberships.** No Stripe Billing surface exists, and subscription revenue has no venue situs under the origin-based per-event ZipTax model. Unrelated product line.

---

## Non-Goals

- **Do not reuse waivers for rental execution.** `WaiverAcceptance` / `PlaceWaiver` model a *unilateral liability release* signed by an attendee or volunteer. A rental agreement is a *bilateral commercial contract* between two parties with obligations on both sides. `Agreement` is already the bilateral instrument. Note that `Agreement.waiverAccepted` / `waiverAcceptedAt` / `waiverVersion` is that same conflation already present and should not be extended.
- **Do not add a denormalized deal-type flag to `Event`.**
- **Percent-of-bar-sales must never become a `PayoutTermsLine`.** Bar revenue never touches the platform, so a line implies a settlement the engine cannot compute and creates a "where's my money" support burden with our name on it. Prose on `Agreement.description` only.
- **Do not change the `computeOrderSplits` sum-to-basis invariant.** Fixed obligations live outside it.

---

## Acceptance Criteria

- [ ] `PayoutTermsLineAmountType` enum added; `amountType` defaults to `PERCENT` and every existing row keeps identical settlement output with no backfill
- [ ] SQL-only CHECK `PayoutTermsLine_amount_type_shape_check` rejects FIXED-without-`amountCents`, FIXED-with-nonzero-`percent`/`floorCents`/`capPercent`, and PERCENT-with-`amountCents`
- [ ] Use-case-layer validation returns typed `invalid_input` for each of those shapes before Postgres is reached
- [ ] `computeOrderSplits` receives only `PERCENT` lines; a regression test asserts a FIXED line on the same terms does not change any split amount by a single cent
- [ ] `computeOrderSplits`' sum-to-basis invariant is unchanged, with existing tests green and unmodified
- [ ] A `FIXED` line produces exactly one `PayeeLedgerEntry` per `(event, line, generation)`; re-running `resolveFixedObligationsForEvent` is a proven no-op
- [ ] A four-wall agreement can be created end-to-end: booking request → accept as `VENUE_RENTAL` → flat room-fee line → agreement finalized → event minted, with the venue owed the fixed fee and the renter receiving 100% of ticket revenue
- [ ] Accepting a booking request as `VENUE_RENTAL` without a `placeId` fails `invalid_input`
- [ ] Adding or editing a FIXED line resets `confirmationStatus` to `PENDING`
- [ ] Zero-revenue case: an event that sells no tickets still records the full fixed obligation, and the shortfall surfaces via the existing `Payee` negative-balance path rather than being silently reduced
- [ ] Versus and after-expenses presets are visibly blocked with the copy above; neither can be persisted by any path including direct tRPC calls
- [ ] `getDealSummaryForAgreement` renders each supported deal type in industry vocabulary, and the agreement UI and settlement sheet both consume it
- [ ] MERCH behaviour is unchanged by this spec (still unwired) and no code path implies otherwise

---

## Open Questions

1. **Does `floorCents` already mis-settle?** `floorCents` is applied per-order inside `applyLineRounding`, then `distributeRemainder` can reduce the allocation to make the splits sum to the basis. On a small order the floor may therefore not survive. If that's true, the existing "versus within a line" is only correct while the floor fits inside the order basis, and `floorCents` may be better re-expressed as a FIXED obligation. **Verify with a test before extending anything that leans on `floorCents`** — this could be a pre-existing money bug, and it is the single most important thing to check before writing code.
2. **Fixed obligation direction.** In a four-wall, money is owed *to the venue by the renter* — the reverse of every existing payout, where the platform pays out ticket revenue. Does `PayeeLedgerEntry` cleanly express a payee-owes-platform-owes-venue obligation, or is a signed-amount convention needed? This determines whether the ledger approach holds.
3. **`generation` in the idempotency key** — what increments it? Follow whatever `createEventFromAgreement` established for generation-scoped keys rather than inventing a second convention.
4. **Interview validation.** The driver is an artist's second-hand report relayed in conversation, not a recorded interview, and there is no rental entry in the interview-insights index. Worth one conversation with a rental-heavy room (a black-box theater or a PAC rather than a bar) before building — specifically to check whether the flat fee is genuinely the whole venue take or whether a bar minimum rides alongside it, since the latter would land squarely in the bar-sales non-goal.
5. **Does `PayoutTerms.kind` need a `RENTAL` member?** A four-wall's terms are structurally unlike `PRIMARY` — the renter takes the door and the venue takes a fee. Reusing `PRIMARY` with a FIXED line may be sufficient, or may overload it. Decide before the migration; adding an enum member later is cheap, but changing what `PRIMARY` means is not.

---

## Review Posture

This touches settlement and money math — the highest-stakes code in the repository. Per CLAUDE.md:

- Full `reviewer` pass, not downgraded, with the hardest adversarial re-review bumped to `opus`
- **Codex cross-model second opinion** in parallel via `[skill:codex-delegate]`, reconciled against the Claude review — different model lineages catch different classes of money bug
- `postgresql-code-review` for the migration and the SQL-only CHECK
- Open Question 1 resolved **before** implementation begins, not during
