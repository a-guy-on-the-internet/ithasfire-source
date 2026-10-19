# Event Settlement — Deal Clauses, Event-End Resolution & the Settlement Sheet

> Superseded by docs/specs/2026-09-29/deal-terms-and-settlement.spec.yaml (2026-10-08 docs consolidation)

**Date:** 2026-08-07
**Status:** superseded (2026-10-08 docs consolidation; was: draft)
**Priority:** P1 (blocks the standard indie deal; also fixes a verified money bug)
**Depends on:** `PayoutTerms` / `PayoutTermsLine` ([finance.prisma:167-253](../../../../packages/db/prisma/finance.prisma#L167-L253)), `Agreement` ([agreement.prisma:5](../../../../packages/db/prisma/agreement.prisma#L5)), `computeOrderSplits` ([compute-order-splits.ts](../../../../packages/core/src/lib/pricing/compute-order-splits.ts)), `computeAgreementBasis` ([finalize-from-payment-intent.ts:651](../../../../packages/core/src/use-cases/orders/finalize-from-payment-intent.ts#L651)), `createSettlementFromOrder` ([create-from-order.ts](../../../packages/core/src/use-cases/settlements/create-from-order.ts)), `runPayoutBatch` ([run-batch.ts](../../../../packages/core/src/use-cases/settlements/run-batch.ts)), `PayeeLedgerEntry` ([finance.prisma:90](../../../../packages/db/prisma/finance.prisma#L90))
**Companion spec:** [compounding-deal-terms-model](../../2026-07-27/completed/compounding-deal-terms-model.spec.md) — supplies the `FIXED`/`PERCENT` line generalization this spec builds on. That spec's Open Question 1 is **answered here** (§2), and the answer is worse than it assumed. Its deferral of "versus" and "after-expenses" is **lifted** by §5.

---

## 1. Problem

Ithas Fire can express exactly one deal: *"payee X gets N% of the post-platform-fee order basis."* Every real venue deal is something else. The five shapes a booker actually uses decompose into three primitives we do not have: an **event-level basis**, an **ordered set of deductions**, and a **greater-of resolution**.

Worse, the one primitive that *looks* like it covers guarantees — `PayoutTermsLine.floorCents` — is silently broken. It is not a floor. See §2.

| Deal shape | Status today |
|---|---|
| Flat percentage split across a lineup | ✅ Works — the only shape that does |
| Split after expenses come off the top | No expense model exists anywhere in the schema |
| Flat guarantee | `floorCents` pretends to; §2 shows it does not |
| Guarantee **vs.** percentage, whichever is greater | Undecidable per-order; needs the event total |
| Room rental (deposit, possibly recouped from door) | Agreed at booking time, then invisible to settlement |

**These are not five code paths.** They are one ordered pipeline whose steps are configurable — the framing that a recoupable room rental is *"a step in the pipeline rather than a separate case"* generalizes to all of them. Modelling them as a taxonomy is how settlement engines acquire a combinatorial mess of special cases.

---

## 2. Verified Finding: `floorCents` Is Not A Floor

> **A live money bug in shipped code, not a hypothetical.** It is why this spec is P1, and it must be fixed before any new deal shape leans on the existing line model.

`applyLineRounding` applies `floorCents` per line, then `distributeRemainder` reduces allocations to force the sum-to-basis invariant — **with no knowledge of floors, and no preference for the line that caused the overflow.** On a negative remainder it walks the array backwards decrementing one cent at a time, round-robin, draining *every* line proportionally.

Measured against the real function (`packages/core`, vitest 1.6.1, throwaway probe since deleted — actual `computeOrderSplits` output, not arithmetic):

| Case | Input | Expected | **Actual** |
|---|---|---|---|
| **E** | basis **$1000**, artist 10% floor **$400**, venue 90% | artist $400 | **artist $250**, venue $750 |
| **B** | basis $100, artist 50% floor $80, venue 50% | artist $80, venue $20 | **artist $65, venue $35** |
| **C** | basis $100, both lines 50% floor $70 | (over-committed) | **$50 / $50** — both floors violated |
| **A** | basis $50, artist 80% floor $400, venue 20% | (over-committed) | artist $50, venue $0 |

Case **E** is the damning one: the order was **two and a half times** the floor and the floor still lost $150. The companion spec guessed the floor was "only correct while it fits inside the order basis." Too generous — **the floor is violated whenever line allocations over-commit at all**, regardless of headroom.

Case **B** shows the collateral damage: the venue had **no floor** and a straight 50%, and still received 35%. A clawback triggered by someone else's floor is taken partly out of an uninvolved party.

**Two mitigating facts, both verified:**

1. `Agreement.guaranteeCents` — whose schema comment claims it "maps to floorCents on PayoutTermsLine" ([agreement.prisma:33](../../../../packages/db/prisma/agreement.prisma#L33)) — **does not**. Every writer across `packages/core`, `packages/adapters`, `apps/api`, `apps/web` routes it only into booking-agreement header read/write and UI. It is a display field. **The schema comment must be corrected**, because the next person to "finish the wiring" would connect a guarantee to a mechanism that silently underpays it.
2. `floorCents` is nonetheless **operator-settable today** ([upsert-agreement-shared.ts:34](../../../../packages/core/src/use-cases/agreements/_shared/upsert-agreement-shared.ts#L34), [upsert-agreement-lines.ts:49](../../../../packages/core/src/use-cases/agreements/lines/upsert-agreement-lines.ts#L49)), so terms carrying a nonzero floor are mis-settling now.

**There is no dedicated unit test for `computeOrderSplits`.** The repo's most consequential money function has coverage only incidentally, via use-case tests. That gap is how this survived.

### Required disposition (ship first, independent of everything else)

- **Audit production + dev for `PayoutTermsLine` rows with `floorCents > 0`** and quantify real exposure in writing before deciding remediation.
- **Deprecate `floorCents`.** A per-order floor is not coherent once event-level guarantees exist — it is a broken approximation of what §5 builds properly. Freeze new writes, keep reading existing rows, migrate live rows to a `GUARANTEE` clause.
- **Do not "fix" `distributeRemainder` to respect floors.** That breaks the sum-to-basis invariant the entire downstream chain depends on. The invariant is correct; the floor is what does not belong.
- **Add the missing direct unit-test file** pinning sum-to-basis, the priority/`payeeId` sort order, cap behaviour, and zero/negative-basis edges.

---

## 3. Goal

Let a booker write the deal they actually negotiated, as clauses on the agreement — and have the system **actually settle it**, paying each party what the deal says, with a settlement sheet as the statement of what it did and why.

Not a report that humans then act on. The payout itself.

---

## 4. Why The System Can Do This: Nothing Has Moved Yet

> The decisive architectural fact, verified. It is what makes real settlement a modest change rather than a rearchitecture.

Settlements are **created** per order at payment time, but they are **not transferred** then. `createSettlementFromOrder` writes rows at `status='pending'`; `runPayoutBatch` only picks up settlements where `status='pending' AND scheduledPayoutDate <= now` ([run-batch.ts:162](../../../../packages/core/src/use-cases/settlements/run-batch.ts#L162), [settlements.ts:63-69](../../../../packages/adapters/src/db/prisma/settlements.ts#L63-L69)), and `scheduledPayoutDate` is derived from **event end** ([compute-payout-date.ts](../../../../packages/core/src/lib/payout-scheduling/compute-payout-date.ts)).

So the entire window from first ticket sale to payout batch is a **hold period in which the platform has full custody and nothing is committed.** At event end, every settlement for that event is still pending and still editable.

**This is the insertion point.** Deal clauses resolve once, at event end, against final event revenue — rewriting the pending settlement amounts before the existing batch pays them. No new transfer machinery, no adjustment ledger, no reversal path. The existing pipeline pays the corrected numbers.

### Two constraints this places on the design

**1. Resolution operates on `SettlementLine`, never on `Settlement`.** A `Settlement` row is keyed `@@unique([payeeId, scheduledPayoutDate])` and **accumulates across events**: when a payee already has a row for that payout date, `createSettlementFromOrder` *adds* to it ([create-from-order.ts:148-158](../../../packages/core/src/use-cases/settlements/create-from-order.ts#L148-L158)) and leaves `Settlement.eventId` pointing at whichever event got there first. Two shows for the same venue on the same payout Sunday share one row.

Therefore `Settlement.eventId` is **not** a trustworthy "belongs to this event" marker. The reliable grain is `SettlementLine` → `orderId` → `Order.eventId`. Resolution adjusts lines and then recomputes `Settlement.amountCents` as the sum of its lines.

> ⚠️ **Confirmed, and filed: [settlement-cancellation-granularity](../../2026-08-10/completed/settlement-cancellation-granularity.spec.md) (P0).** The event-cancellation path does key off `Settlement.eventId`, and the collision is reachable in an ordinary venue week. Cancelling event A destroys live event B's payout; cancelling event B leaves its money pending and it **transfers after buyers were refunded**. **Ship that fix before this spec's `resolveEventSettlement`** — event-end resolution built on cancellation helpers that nuke aggregate rows would let a cancelled sibling event silently destroy a resolved payout.

**2. The resolution job must run promptly at event end.** `ASAP` schedules payout for `eventEnd + 1 day`; a Saturday show on `WEEK_OF_EVENT` also resolves to the next morning (§ below). Resolution must be reliably complete before the batch, and the batch must **refuse to transfer** any settlement for an event whose clauses require resolution that has not happened. Fail closed.

### Verified prerequisite: the documented 2-day payout floor does not exist

`PayoutSchedule`'s comments claim *"ASAP: 2 days after event ends"* and *"All schedules respect a 2-day post-event floor for refund handling"* ([enums.prisma:174-183](../../../../packages/db/prisma/enums.prisma#L174-L183)). **`computePayoutDate` implements no such floor.** `ASAP` is `eventEnd.plus({ days: 1 })`; `WEEK_OF_EVENT` for a Saturday show is also `eventEnd.plus({ days: 1 })`.

**Blocking prerequisite.** Either implement the documented floor or correct the comments and design the resolution window around real timing. A resolution step cannot be built on a window the code does not guarantee.

---

## 5. The Pipeline

Two layers. The separation is load-bearing.

**Layer 1 — the waterfall.** Ordered deductions reducing event gross to a **net pool**. Each deduction also *credits* whoever fronted it.

**Layer 2 — payee clauses.** Each payee's entitlement against a basis (`GROSS` or `NET_POOL`), resolved `SUM` or `GREATER_OF`.

### The bottom line is untouched — this is redistribution only

**Design invariant, asserted in code:** no clause in this spec changes the buyer's price, the gross, the platform fee, or tax. Every clause redistributes the *seller's post-platform-fee net* among the lineup. `computeAgreementBasis` ([finalize-from-payment-intent.ts:651](../../../../packages/core/src/use-cases/orders/finalize-from-payment-intent.ts#L651)) is unchanged, and the platform's take is identical before and after resolution.

That is what makes real settlement safe to automate: resolution can only move money *between* the parties to the agreement, never in or out of the system. It also bounds the blast radius of a resolution bug to the lineup, and makes the conservation check (§6) a complete correctness statement rather than a partial one.

### Where each deal shape is established

| Deal shape | Established | Resolved |
|---|---|---|
| Flat percentage across lineup | Agreement clauses | Per-order (unchanged) |
| Flat guarantee | Agreement clause | Event end |
| Guarantee vs. percentage | Agreement clause | Event end |
| Room rental (flat or recoupable) | **Booking request → agreement** | Event end (recoupment step) |
| Expenses off the top | Agreement clauses + post-show actuals | Event end |

**Room rental is agreed up front, not entered after the show.** The rental fee — and any deposit — is part of the initial agreement struck in the booking request. By the time a ticket sells it is a known constant. It is *resolved* at event end only in the sense that recoupment from door revenue is a waterfall step; the amount was never in question.

That ordering matters for trust: an artist agreeing to a percentage-after-rental has agreed to a number they saw before the show, not one the venue typed in afterward. **Expenses are the exception** — actuals genuinely aren't known until after — which is precisely why they need the provenance and authorization rules in §8.

### Worked example (the standard indie deal)

Show grosses **$4,000** (post-platform-fee basis, net of refunds). Room rents for $500, recoupable from the door, $250 deposit paid at booking. Venue fronted $300 sound and $150 marketing. Headliner is $800 **vs.** 70%. Support is a flat 10%. Venue takes the remainder.

```
  Adjusted gross (post platform fee, net of refunds)        $4,000.00
    less  recoupable room rental          → credit: venue    -$500.00
    less  expense: sound                  → credit: venue    -$300.00
    less  expense: marketing              → credit: venue    -$150.00
  ────────────────────────────────────────────────────────────────────
  = Net pool                                                $3,050.00

  Headliner   guarantee $800 vs 70% of pool ($2,135) → GREATER  $2,135.00
  Support     10% of pool                                        $305.00
  Venue       remainder of pool                                  $610.00
                                                   + rental      $500.00
                                                 + expenses      $450.00
                                                            ─────────────
                                              Venue total      $1,560.00
  ────────────────────────────────────────────────────────────────────
  Total distributed                                         $4,000.00  ✓

  Settlement position — Venue
    Expected total                                          $1,560.00
    less deposit already received at booking                 -$250.00
    = To transfer via platform                              $1,310.00
```

**Invariant: the waterfall is conservative.** Distributions sum to adjusted gross, exactly. Asserted, not assumed.

### Shortfall is the one thing redistribution cannot fix

Same deal, show grosses **$500**:

```
  Net pool                                                    $500.00
  Headliner   guarantee $800 vs 70% ($350) → GREATER          $800.00
  Support     10% of pool                                      $50.00
  Venue       remainder                                       -$350.00   ⚠ SHORTFALL
```

The venue is $350 in the hole — which is what a guarantee *means*. The system pays out what exists (the pool is still fully distributed) and records the $350 as a debt between the parties, surfaced on both sides. **The platform does not front it.**

This is the one case redistribution cannot close, because it needs money from outside the pool. Today's engine instead claws the headliner down to fit and reports nothing — the same silent-absorption failure as §2, one layer up.

### What we do not know, we must not imply we know

Bar sales, cash at the door, off-platform comps, and merch outside POS are invisible to us. Every such line renders `NOT TRACKED`, never `$0.00`. A sheet showing `Bar: $0.00` is a support ticket with our name on it.

---

## 6. Data Model

### 6.1 Clauses

Extends `PayoutTermsLine` — already carrying `amountType FIXED|PERCENT` from the companion spec — with the two axes that spec deferred:

```prisma
/// Which pool this line's percentage applies to.
enum SettlementBasisKind {
  GROSS      // Post-platform-fee order basis. Today's behaviour.
  NET_POOL   // Adjusted gross minus every waterfall deduction.
}

/// How a line carrying BOTH a fixed amount and a percentage resolves.
enum ClauseResolution {
  SUM         // Additive: guarantee + percentage ("dollar one").
  GREATER_OF  // "Versus" — event-level only.
}

model PayoutTermsLine {
  // ── existing fields, plus amountType/amountCents from the companion spec ──

  basisKind   SettlementBasisKind @default(GROSS)
  resolution  ClauseResolution    @default(SUM)

  /// True when this line cannot be resolved per-order. DERIVED at write time,
  /// stored so the split query filters on an indexed column instead of
  /// recomputing:  basisKind = NET_POOL OR resolution = GREATER_OF
  ///               OR amountType = FIXED
  eventLevelOnly Boolean @default(false)

  /// Exactly one clause per terms may be the remainder holder.
  isRemainder Boolean @default(false)

  @@index([payoutTermsId, eventLevelOnly])
}
```

**`eventLevelOnly` is the safety fence.** `createSettlementFromOrder` filters to `eventLevelOnly = false` before calling `computeOrderSplits`, so a clause the per-order engine cannot express is structurally unable to reach it. Storing the derived value is deliberate: a filter that must be recomputed at every call site is a filter that will eventually be forgotten at one.

SQL-only CHECKs, alongside the companion spec's shape check:
- `resolution = 'GREATER_OF'` → `amountCents IS NOT NULL AND amountCents > 0 AND percent > 0`
- `eventLevelOnly` matches its derivation (belt-and-braces against a bad adapter write)
- Partial unique index: at most one `isRemainder = true` per `payoutTermsId`

### 6.2 The waterfall

```prisma
enum EventDeductionKind {
  EXPENSE         // A show cost, reimbursed to whoever fronted it.
  RENTAL_RECOUP   // Room rental recouped from door revenue before splits.
}

enum EventExpenseCategory {
  SOUND  BACKLINE  MARKETING  STAFF  HOSPITALITY  SETTLEMENT_FEE  OTHER
}

model EventDeduction {
  id          String               @id @default(uuid())
  eventId     String
  kind        EventDeductionKind
  category    EventExpenseCategory?
  label       String
  amountCents Int                  // > 0, CHECK-enforced

  /// Who fronted this cost and is reimbursed from the top. Null = borne by
  /// the event with no reimbursement. Null must be a deliberate UI choice,
  /// never a default — an unattributed expense silently enriches the
  /// remainder holder.
  creditPayeeId String?

  /// Waterfall position. Ties break by (createdAt, id) so the sheet is
  /// byte-stable across regenerations.
  sortOrder   Int                  @default(0)

  /// Clamps to remaining revenue: a recoupable rental cannot recoup more
  /// than the door produced. Expenses default false — a real cost is owed
  /// whether or not the show sold.
  capToAvailable Boolean           @default(false)

  /// Provenance. A rental agreed in the booking request is not the same as
  /// an expense typed in after the show, and the artist can see which is
  /// which. "agreement_clause" rows are created at agreement finalize and
  /// are not editable post-hoc.
  sourceKind  String               // "agreement_clause" | "manual"
  sourceId    String?

  event       Event @relation(fields: [eventId], references: [id], onDelete: Cascade)

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([eventId, sortOrder])
}
```

**Room rental is a configuration, not a case:**

| Rental shape | Model as | Created |
|---|---|---|
| Recouped from door | `EventDeduction(RENTAL_RECOUP, creditPayeeId: venue, capToAvailable: true)` | At agreement finalize, `sourceKind: "agreement_clause"` |
| Flat four-wall, not recouped | `FIXED` `PayoutTermsLine` to the venue (companion spec) | At agreement finalize |
| Deposit already paid | `EventSettlementReceipt` below | At agreement finalize or on payment |

A deposit recorded as a negative expense would corrupt the pool and is prohibited. **A deposit changes who already holds the money, not what the deal allocates.**

```prisma
/// Money that changed hands outside the platform — recorded so the sheet
/// reports cash-to-transfer correctly without ever altering allocation math.
model EventSettlementReceipt {
  id          String   @id @default(uuid())
  eventId     String
  payeeId     String
  amountCents Int      // > 0 — already received by this payee
  label       String   // "Room deposit, paid at booking 2026-07-02"
  note        String?

  event       Event @relation(fields: [eventId], references: [id], onDelete: Cascade)
  payee       Payee @relation(fields: [payeeId], references: [id], onDelete: Restrict)

  createdAt   DateTime @default(now())

  @@index([eventId])
}
```

### 6.3 The sheet

A settlement sheet is a **document**: a point-in-time statement both parties can rely on. Schema as previously drafted — `EventSettlementReport` (`DRAFT | FINALIZED | SUPERSEDED`, versioned, `inputSnapshot` Json, `engineVersion`, `@@unique([eventId, version])`) and `EventSettlementReportLine` (per-payee components: `guaranteeCents`, `percentShareCents`, `resolvedBy`, `deductionCreditCents`, `fixedObligationCents`, `remainderCents`, `expectedTotalCents`, `shortfallCents`, `receiptsCents`, `expectedViaPlatformCents`, `settledCents`, `varianceCents`).

One addition now that the sheet is authoritative: **`FINALIZED` is the gate the payout batch reads.** A finalized sheet is the instruction to pay; there is no separate approval artifact.

---

## 7. Resolution

**`computeSettlementSheet`** — pure, I/O-free, in `packages/core/src/lib/settlement/`, exhaustively unit-tested without a database. Correctness lives here.

Ordered stages:

1. **Adjusted gross** = Σ order bases (`computeAgreementBasis`) − refunds. Tax is already excluded upstream; assert it, do not re-derive it.
2. **Waterfall.** Deductions in `(sortOrder, createdAt, id)` order. `capToAvailable` clamps to the running balance, which floors at zero. Each deduction credits `creditPayeeId`.
3. **Net pool** = balance after the waterfall.
4. **Entitlement per clause.** `percentShare = basisKind === GROSS ? adjustedGross : netPool`, times `percent`. `SUM` → `guarantee + percentShare`. `GREATER_OF` → `max(guarantee, percentShare)`, recording which side won.
5. **Allocate.** Integer cents, **largest-remainder**, tiebreak `(priority desc, payeeId asc)` — matching `computeOrderSplits`' existing sort so the two engines never disagree about ordering. Residual cents land on the remainder holder and are reported as their own line.
6. **Remainder holder.** Exactly one `isRemainder` clause. Zero → residual reported unallocated, sheet flagged incomplete. Two → refused at write time by the partial unique index.
7. **Shortfall.** Negative `expectedTotal` clamps to zero for payout and is recorded in full as `shortfallCents`.
8. **Receipts.** `expectedViaPlatform = expectedTotal − receipts`, floored at zero. Over-receipt surfaces as an explicit overpayment line requiring human resolution.

**Conservation assertion:** `Σ expectedTotal + Σ shortfall == adjustedGross`. Because §5 establishes that clauses are redistribution-only, this is a *complete* correctness statement, not a partial one. Failure is a `ReporterPort` site per CLAUDE.md; a sheet that does not balance must never render or pay as if it does.

### `resolveEventSettlement` — applying it to pending settlements

Runs at event end, before the payout batch. Single `repos.tx()`, `IdempotencyPort` keyed on `(eventId, reportVersion)`.

1. Load every `SettlementLine` whose `orderId` resolves to this event — **never** by `Settlement.eventId` (§4).
2. **Refuse if any is not `pending`.** If a settlement already transferred, resolution is impossible and the discrepancy needs a human. Fail loudly rather than half-applying.
3. Compute the sheet; write the `EventSettlementReport` and finalize it.
4. Rewrite the affected `SettlementLine` amounts to the resolved per-payee figures, creating lines for payees with a clause but no order-derived line (a guarantee-only support act).
5. Recompute each touched `Settlement.amountCents` as the sum of its lines — **not** by adding a delta, since the row may span events.
6. Audit-log before/after per line.

**The batch must fail closed.** `runPayoutBatch` skips any settlement whose event has unresolved event-level clauses and no `FINALIZED` sheet, logging it as a skip reason alongside the existing minimum/claims/disputes reasons. An unresolved deal must never pay out at its provisional per-order numbers.

### Modified

`createSettlementFromOrder` filters clauses to `eventLevelOnly = false`. A regression test must assert that adding a `GREATER_OF`, `NET_POOL`, or `FIXED` clause changes no order split **by a single cent**.

### Preview, not a phase

The sheet is viewable in `DRAFT` from the moment the event has revenue, recomputing live — so a booker can see the deal resolving as sales come in, and any mismatch surfaces before it is money. That is the safety valve, and it costs nothing because the computation is already pure. It replaces a permanent report-only phase: previewing is a *mode of the real thing*, not a substitute for it.

---

## 8. UI / Flow

**Clauses live on the agreement**, entered in the deal-preset vocabulary the companion spec establishes — a booker picks "Guarantee vs. percentage" or "Room rental, recouped from door" and gets the clause. The rental and its deposit are captured in the **booking request / initial agreement**, where they are actually negotiated. The two presets the companion spec had to block with explanatory copy become available; **that copy is deleted, not left stale.**

**The sheet** is a new route, `/admin/[slug]/events/[id]/settlement` — the first event-level financial surface in the app (verified: none exists). It renders the waterfall top to bottom, exactly as §5, because that shape is already what venues read.

Non-negotiable rendering rules:

- **Untracked revenue renders `NOT TRACKED`, never `$0.00`.**
- **Shortfall is a banner, not a table cell.**
- **Provenance is visible** — clauses agreed at booking are visually distinct from post-show manual expenses (`sourceKind`).
- **`DRAFT` vs `FINALIZED` is unmissable**, since only one of them is going to be paid.
- Both parties to the agreement can read the sheet; only the event owner can add expenses or finalize. Artists seeing the venue's expense lines is the entire point; a one-sided sheet is a receipt.
- **Export to PDF/CSV** — a finalized sheet is a document people file with their accountant.

**Post-hoc expense authorization is the trust hinge.** A venue adding expenses after the show, against an artist's percentage-of-net, is the oldest dispute in live music — and now those expenses move real money. v1 assumption: owner-only entry, fully visible to the counterparty, with finalize notifying both parties. See Open Question 2.

---

## 9. Deferred

**Merch & POS revenue in the pool.** Requires removing the `kind === "ticket"` filter ([create-from-order.ts:93](../../../packages/core/src/use-cases/settlements/create-from-order.ts#L93)) plus the goods-class rates the companion spec scopes. Renders `NOT TRACKED` until then.

**Per-ticket-type clauses with a `NET_POOL` basis.** `ticketTypeId` already scopes lines, but a pool spanning all ticket types makes the combination genuinely ambiguous. **Refuse it in v1** with a typed error rather than guessing.

**Tiered / escalator deals** ("70% up to $5k, 85% above") and **break-even bonuses.** Both extend the clause model cleanly via ordered bands; not v1.

**Multi-date & series settlement.** One sheet per `Event` in v1. Whether a series settles per-date or in aggregate is a real question — and the series work has open duplicate-event and DST-drift follow-ups that would distort per-date revenue attribution. Do not answer it by omission.

**E-signature on the finalized sheet.** Clickwrap only; shape the record so a provider drops in later.

---

## 10. Non-Goals

- **Do not change `computeOrderSplits`' sum-to-basis invariant.** Event-level clauses live outside it by construction.
- **Do not make `distributeRemainder` respect `floorCents`.** §2 — remove the floor, keep the invariant.
- **No clause may change gross, platform fee, tax, or the buyer's price.** Redistribution only (§5) — this is asserted, not merely intended.
- **Percent-of-bar-sales never becomes a settleable clause.** Prose on `Agreement.description` only.
- **The platform does not front shortfalls.**
- **No recompute of a FINALIZED sheet, ever.** New version or nothing.
- **Do not model expenses as negative revenue**, or deposits as negative expenses.
- **Do not resolve against `Settlement.eventId`.** §4 — it is unreliable.

---

## 11. Acceptance Criteria

**The `floorCents` bug (§2 — ship first, independently)**
- [ ] Direct unit-test file for `computeOrderSplits` pinning sum-to-basis, sort order, caps, zero/negative-basis edges
- [ ] A test reproduces Case **E** ($1000 basis, 10% + $400 floor → **$250**) as a characterization of current behaviour
- [ ] Production + dev audited for `floorCents > 0`; exposure quantified in writing before remediation
- [ ] `floorCents` frozen for new writes; `Agreement.guaranteeCents`' misleading schema comment corrected

**Engine**
- [ ] `computeSettlementSheet` is pure and I/O-free, unit-tested against all five deal shapes plus the §5 worked example to the cent
- [ ] Conservation `Σ expectedTotal + Σ shortfall == adjustedGross` asserted in-engine and covered by a property/fuzz test over randomized clause sets
- [ ] **Redistribution invariant:** a property test asserts gross, platform fee, and tax are byte-identical before and after resolution for every generated clause set
- [ ] Largest-remainder allocation is deterministic — identical inputs produce a byte-identical sheet
- [ ] Zero-revenue event with an $800 guarantee → guarantee recorded in full, shortfall $800, nothing silently reduced
- [ ] Recoupable rental with `capToAvailable` never recoups more than the door produced
- [ ] A deposit receipt changes `expectedViaPlatform` only — every waterfall figure and `expectedTotal` unchanged
- [ ] Two `isRemainder` clauses rejected by the partial unique index; zero → sheet flagged incomplete, residual reported unallocated

**Resolution against real money**
- [ ] `resolveEventSettlement` selects lines via `orderId → Order.eventId`, **never** `Settlement.eventId`; a test with two events for one payee on the same `scheduledPayoutDate` proves only the target event's lines change
- [ ] `Settlement.amountCents` is recomputed as the sum of its lines, not by delta
- [ ] Resolution refuses (does not partially apply) if any affected settlement has left `pending`
- [ ] Re-running resolution for the same `(eventId, reportVersion)` is a proven no-op
- [ ] `runPayoutBatch` skips settlements for events with unresolved event-level clauses, with a distinct skip reason; a test proves an unresolved deal cannot transfer
- [ ] A payee with a guarantee but zero order-derived lines still receives a settlement line

**Isolation from the per-order path**
- [ ] `createSettlementFromOrder` filters `eventLevelOnly = true`; a regression test asserts a `GREATER_OF` / `NET_POOL` / `FIXED` clause changes no order split by one cent
- [ ] `eventLevelOnly` enforced by SQL CHECK, not only application code
- [ ] Every existing `PayoutTerms` row produces byte-identical settlement output with no backfill

**Report lifecycle**
- [ ] FINALIZED reports immutable; deduction/receipt writes against one refused with a typed error
- [ ] `getSettlementSheet` on a FINALIZED report reads the snapshot and never recomputes — proven by mutating the agreement and asserting no change
- [ ] Superseding creates version N+1 and links `supersededById`; the prior row is untouched

**Surface**
- [ ] Untracked revenue renders `NOT TRACKED`, never `$0.00` — asserted in a UI test
- [ ] Shortfall renders as a banner; a sheet with a negative payout cannot render as healthy
- [ ] Both agreement parties can read the sheet; only the owner edits or finalizes — verified for cross-org isolation (IDOR)
- [ ] Rental + deposit are capturable in the booking request / initial agreement, not only post-event
- [ ] The companion spec's "versus"/"after-expenses" blocking copy is **removed**
- [ ] Driven in the real app per CLAUDE.md §Run It: zero new console errors, 320px viewport checked

---

## 12. Open Questions

1. **When may a sheet be finalized, and what happens to a late refund or walk-up sale?** Resolution rewrites pending settlements; a refund or a late order afterward invalidates the sheet. Options: finalize only after a fixed post-event window; re-resolve automatically on any post-finalize order/refund event (new version, still pre-transfer); or block finalize until the refund window closes. Interacts directly with the missing 2-day floor (§4) and is now the **highest-risk open item**, because these numbers get paid.
2. **Who may add expenses, and must the counterparty agree?** v1 assumes owner-only with full visibility. Options: require counterparty acknowledgement before finalize; cap post-hoc expenses to categories named in the agreement; or a dispute flag that blocks the batch. Now that expenses move real money, "visible" may not be sufficient. Product decision.
3. **Does the sheet need a `Payee` for parties not paid through us?** A support act on a $100 cash guarantee may have no Connect account. Reference them (and how) or omit them, leaving a sheet that does not reflect the real deal?
4. **`instantPayouts` in dev** ([create-from-order.ts](../../../packages/core/src/use-cases/settlements/create-from-order.ts)) makes settlements immediately batch-eligible, collapsing the hold window §4 depends on. Confirm resolution is still testable locally, or gate the flag when event-level clauses are present.
5. **Series/multi-date granularity** — per-date or aggregate? See Deferred.
6. **Interview validation.** The deal shapes match VenuePilot/Opendate vocabulary, but expense-attribution custom (who fronts what, what is deductible) varies by room. Worth one conversation with a room that settles percentage-after-expenses nightly before locking `EventExpenseCategory`.

---

## 13. Review Posture

Highest-stakes code in the repository — settlement math that now moves real money, in a spec that opens by documenting a live money bug. Per CLAUDE.md:

- Full `reviewer` pass, not downgraded; hardest adversarial re-review bumped to `opus`
- **Codex cross-model second opinion** via `[skill:codex-delegate]`, reconciled against the Claude review
- `postgresql-code-review` for the migration, both SQL-only CHECKs, and the partial unique index
- `security-review` for sheet read authorization — it exposes one party's expense detail to another, across org boundaries
- **§2 must be resolved and shipped before any new clause type is built.** Building richer deals on a line model with a known-broken floor repeats exactly the failure this spec exists to fix.
- **§4's fail-closed batch guard is the single most important test in the spec.** Everything else degrades to a wrong number on a screen; that one degrades to a wrong transfer.
