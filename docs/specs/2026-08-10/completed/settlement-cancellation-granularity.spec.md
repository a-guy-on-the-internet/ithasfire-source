# Settlement Amounts Are Never Reduced When Their Orders Change

> Superseded by docs/specs/2026-08-10/completed/ledger-authoritative-settlement.spec.md (2026-10-08 docs consolidation)

*(Originally scoped to cancellation granularity; Instance 3 widened it to the general defect.)*

**Date:** 2026-08-10
**Status:** superseded (2026-10-08 docs consolidation; was: draft — **confirmed defect in shipped code**)
**Priority:** P0 (money loss in one direction, payee underpayment in the other)
**Found via:** [event-settlement-report](../../2026-08-07/completed/event-settlement-report.spec.md) §4, which needed to know whether `Settlement.eventId` is trustworthy. It is not.
**Affects:** [cancel-event.ts:161](../../../../packages/core/src/use-cases/events/cancel-event.ts#L161), [settlements.ts:351-380](../../../../packages/adapters/src/db/prisma/settlements.ts#L351-L380), [refund-full-order.ts:366](../../../../packages/core/src/use-cases/orders/refund-full-order.ts#L366), [reconcile-stripe-full-refund.ts:200](../../../../packages/core/src/use-cases/orders/reconcile-stripe-full-refund.ts#L200), [review-claim.ts:315](../../../../packages/core/src/use-cases/resale/review-claim.ts#L315)

---

## Root cause

**A `Settlement`'s `amountCents` is written once at order-payment time and never reconciled against what its lines are still worth.** Every downstream change to an order — refund, partial refund, event cancellation — either reduces nothing or destroys the whole aggregate row. Nothing reduces it *by the right amount*, and no invariant anywhere asserts `Settlement.amountCents == Σ its SettlementLine.amountCents`.

Three instances below, in increasing order of blast radius. The compounding factor for Instances 1 and 2:

A `Settlement` row is **not** per-event and **not** per-order. It is keyed `@@unique([payeeId, scheduledPayoutDate])` ([finance.prisma:306](../../../../packages/db/prisma/finance.prisma#L306)) and **accumulates**: when a payee already has a row for that payout date, `createSettlementFromOrder` adds the new amount to the existing row and appends lines, leaving `Settlement.eventId` pointing at whichever event arrived first ([create-from-order.ts:139-158](../../../packages/core/src/use-cases/settlements/create-from-order.ts#L139-L158)).

Both cancellation helpers treat that aggregate row as if it belonged to a single event or order, and **cancel the whole row**. Neither reduces it.

The correct grain is `SettlementLine` — which already carries `orderId`, `orderSplitId`, and `amountCents` precisely so that "which order amounts contributed to this settlement" is queryable. The schema comment on `SettlementLine` says exactly this ([finance.prisma:312-313](../../../../packages/db/prisma/finance.prisma#L312-L313)). The helpers do not use it.

---

## Reachability: an ordinary week at one venue

`scheduledPayoutDate = computePayoutDate(eventEndsAt, schedule)`, and every schedule collapses to a **Sunday**. Any two events in the same week on the same schedule therefore produce an identical payout date, and a venue is a single `Payee` — so both events land in one `Settlement` row.

Measured against the real function (`computePayoutDate`, probe since deleted):

| Events | Schedule | Payout date | Collide? |
|---|---|---|---|
| Fri 2026-08-14 + Sat 2026-08-15 | `TWO_WEEKS_AFTER` (**the default**) | both `2026-08-30T05:00Z` | **yes** |
| Fri 2026-08-14 + Sat 2026-08-15 | `WEEK_OF_EVENT` | `2026-08-16T05:00Z` and `2026-08-23T05:00Z` | no — see note |
| Sat wk1 `TWO_WEEKS_AFTER` + Tue wk2 `ONE_WEEK_AFTER` | mixed | both `2026-08-30T05:00Z` | **yes** |

This is not an edge case. **A venue with a Friday and a Saturday show on default terms hits it every week**, and the third row shows the collision also crosses weeks when schedules differ.

> **Note (2026-09-06):** the `WEEK_OF_EVENT` row no longer collides. That schedule now rolls Saturday and Sunday events to the following Sunday, so the pair above resolves a week apart. The finding is unaffected — it rests on the **default** `TWO_WEEKS_AFTER` row, which is unchanged, and the third row still crosses weeks. A separate change also floors every credit's maturity at the Stripe settlement window, so two sales for one event can now mature on different dates; that makes the aggregate `Settlement` row's grain problem *more* reachable, not less.

---

## Instance 1 — `cancelForEvent` (P0, both directions)

```ts
// settlements.ts:351
cancelForEvent: async (eventId: string) => {
  const result = await p.settlement.updateMany({
    where: { eventId, status: "pending" },   // ← unreliable column
    data: { status: "cancelled" },
  });
  return { count: result.count };
}
```

Sole caller: `cancelEvent` ([cancel-event.ts:161](../../../../packages/core/src/use-cases/events/cancel-event.ts#L161)). No other settlement cancellation runs in that path — `processRefunds` uses its own `refundLoadedOrder` helper and never calls `cancelForOrder`.

Setup for both directions: venue **V**, Event **A** (Fri) and Event **B** (Sat), same week, default schedule. A's order lands first → row `S{eventId: A, amount: a}`. B's order joins → `S{eventId: A, amount: a + b}`.

**Direction 1 — cancel A → over-cancellation.** `where: { eventId: A }` matches `S`, so the entire row is cancelled, **including B's `b`**. Event B is alive and sold, and its payee is never paid. `cancelled` is not `failed`, so `settlements.resetFailed` — the existing bulk-recovery tool — does not reach it. Requires manual DB intervention.

**Direction 2 — cancel B → under-cancellation, and this one loses real money.** `where: { eventId: B }` matches **nothing**, because `S.eventId` is `A`. Meanwhile B's orders *are* refunded to buyers. `S` stays `pending` at `a + b` and the payout batch transfers the full amount on the scheduled Sunday.

> The platform refunds `b` to buyers **and** transfers `b` to the venue. The difference is a straight loss, and nothing in `runPayoutBatch` catches it — it guards disputes, open claims, and payout minimums, but never re-checks order or event status.

---

## Instance 2 — `cancelForOrder` (P1, over-cancellation only)

```ts
// settlements.ts:359 — finds the right lines, then cancels the whole row
const lines = await p.settlementLine.findMany({
  where: { orderId }, select: { settlementId: true }, distinct: ["settlementId"],
});
await p.settlement.updateMany({
  where: { id: { in: settlementIds }, status: "pending" },
  data: { status: "cancelled" },          // ← whole row, not this order's share
});
```

This one *selects* correctly by line and then throws the precision away. Refunding one order cancels the payee's entire pending settlement for that payout date — every other order and every other event in the row.

**Blast radius is narrower than it first appears, and worth stating precisely:** all three callers are gated to resale. `refund-full-order` and `reconcile-stripe-full-refund` both call it only inside `if (order.source === "RESALE")`; ordinary refunds use transfer reversals instead and never touch settlements. The third caller is resale claim review. So this is real but confined to resale flows — it is P1, not P0.

---

## Instance 3 — refunds never reduce the settlement at all (P0, broadest of the three)

> **Verified by executed tests, not by reading.** Both halves of the chain are pinned by tests added to the team's own harnesses:
> `packages/core/src/use-cases/orders/__tests__/refund-full-order.test.ts` → *"DIAGNOSTIC: pre-payout refund and the pending settlement"*
> `packages/core/src/use-cases/settlements/__tests__/run-batch.test.ts` → *"DIAGNOSTIC: refunded orders are not re-checked at transfer time"*
> Full `orders` + `settlements` suites: **581 passed**.

Settlements are created at payment time but only transfer at `scheduledPayoutDate`. On the default `TWO_WEEKS_AFTER` that leaves a **~16-day window** in which the order can be refunded while its settlement is still `pending`.

**Half 1 — the refund reduces nothing.** Running the real `refundFullOrder` against the fixture defaults (`source: "PRIMARY"`, every item `paidOutAt: null` — `paidOutAt` is stamped only at transfer, in `run-batch`/`execute-transfer`) marks the order and its items refunded and calls **not one** settlement-mutating method. The test spies `cancelForOrder`, `cancelForEvent`, `cancelForPayee`, `updateAmount`, `incrementAmount`, and `bulkMarkFailed` — all uncalled, so the assertion is not an artifact of a thin mock. The contrast case in the same block shows the **resale** branch *does* call `cancelForOrder` on an otherwise identical order: only `source` differs.

There is also no method that *could* do it correctly — the settlements repo exposes `cancelForOrder`, `cancelForEvent`, `cancelForPayee`, `updateAmount`, `incrementAmount`, but nothing that reduces a settlement by one order's contribution. Partial refunds (`refund-order-items`) touch settlements not at all.

**Half 2 — the batch does not compensate.** `runPayoutBatch` re-checks open claims, order `disputeStatus`, and order `kind`, and never order refund status. The transfer amount is the plain sum of `Settlement.amountCents` ([run-batch.ts:415](../../../../packages/core/src/use-cases/settlements/run-batch.ts#L415)); the claim step's raw SQL joins `SettlementLine → Order` but filters on `disputeStatus` alone ([settlements.ts:112-137](../../../../packages/adapters/src/db/prisma/settlements.ts#L112-L137)). The test drives a due settlement through the real batch and asserts the full amount transfers.

The team's own harness is corroborating evidence: `makeDeps` has overrides for disputed settlements, open claims, order kinds, membership portions, and dispute debt — and **no concept of a refunded order**, because the code under test has none.

> **Net effect: we refund the buyer and pay the organizer for the same ticket.** Unlike Instances 1 and 2 this needs no event cancellation and no resale — it fires on an ordinary refund of an ordinary ticket, any time in a window that is normally two weeks wide.

**Why this may have gone unnoticed:** the resale path *is* handled, disputes *are* handled, and post-payout refunds *are* handled (via `paidOutAt` → transfer reversal). The gap is precisely the pre-payout non-resale refund — the common case, and the only one with no guard.

**Scope before acting:** quantify how many refunds actually land pre-payout in production. If organisers are net-positive across a payout period the loss may be absorbed invisibly in aggregate, which would explain the silence — and would also mean the true exposure is larger than any single complaint suggests.

---

## Fix

> **SUPERSEDED (same day):** the reduce-don't-cancel patch below assumed the settlement tables stay authoritative. The accepted direction is [ledger-authoritative-settlement](ledger-authoritative-settlement.spec.md) — a direct cutover that deletes `Settlement.amountCents` as a source of truth entirely, making all three instances unrepresentable. The section is kept as the record of what a minimal patch would have been; **the exposure it would have stopped continues until the cutover ships.** The Instances, Reachability, Remediation, and DIAGNOSTIC-test sections above remain fully current.

**Reduce, do not cancel.** Both helpers become line-scoped:

1. Select the `SettlementLine` rows in scope — by `orderId` for the order case, by `orderId → Order.eventId` for the event case (**never** `Settlement.eventId`).
2. Refuse the whole operation if any affected `Settlement` has left `pending`. A transferred settlement cannot be walked back here; it needs a reversal path and a human. Fail loudly rather than half-applying.
3. Delete (or zero and tombstone) those lines.
4. Recompute each touched `Settlement.amountCents` as **the sum of its remaining lines** — never by subtracting a delta.
5. Cancel the row only when no lines remain.
6. Audit-log before/after per row.

`cancelForEvent`'s signature should stop implying a column lookup — rename to something like `cancelLinesForEvent`, returning affected settlement ids and per-row deltas rather than a bare count, so callers can log what actually moved.

**Then decide `Settlement.eventId`'s fate.** It is currently write-first-wins and misleading. Either drop it and derive the relationship through lines, or keep it strictly as a non-authoritative provenance hint with a schema comment saying so and no query allowed to filter on it. Leaving it as-is guarantees a third instance of this bug. It is also used for payout-date calculation context, so removal needs its own sweep — check every reader before touching it.

---

## Existing-data remediation

This has presumably been running in production. Before shipping the fix:

- **Instance 3 (over-transfer, broadest):** find `transferred` settlements whose lines reference orders refunded **before** that settlement's `scheduledPayoutDate`. Each is a buyer refund and an organizer payout for the same ticket. Expect this set to be the largest of the three — it needs no event cancellation and no resale.
- **Direction 2 (over-transfer):** find `transferred` settlements whose lines reference orders belonging to a `CANCELLED` event. Each is money that left the platform against a refunded order. Quantify before deciding recovery.
- **Direction 1 (stranded payees):** find `cancelled` settlements whose remaining lines reference orders on events that are **not** cancelled. Each is a payee owed money that was silently withheld. These need re-issuing.
- Both queries are cheap and should run in dev first to validate their shape — but note dev seed data may not reproduce the collision, so **absence in dev proves nothing**.

---

## Tests (none of which exist today)

- Two events for one payee on the same `scheduledPayoutDate`; cancel one → **only that event's lines are removed**, the other event's amount survives, and `Settlement.amountCents` equals the sum of remaining lines.
- Same setup, cancel the event whose id is **not** on `Settlement.eventId` → its amount is still removed. This is the Direction 2 regression pin and it fails against current code.
- Cancel an event whose settlement has already `transferred` → operation refuses, nothing partially applied.
- Refund one resale order in a multi-order settlement → only that order's share is removed.
- Cancelling every event in a row → row reaches `cancelled` with zero remaining lines.
- **Refund a non-resale order pre-payout → the settlement drops by exactly that order's contribution, and the batch transfers the reduced amount.** The two DIAGNOSTIC blocks already in the tree characterise today's behaviour and must be inverted into this assertion as part of the fix, not deleted.
- Partial refund of a non-resale order → the settlement drops by the refunded items' contribution only.
- A property test asserting the standing invariant: **`Settlement.amountCents == Σ its SettlementLine.amountCents`**, after any cancellation sequence. That invariant is assumed everywhere and enforced nowhere.

---

## Relationship to the settlement-report spec

[event-settlement-report](../../2026-08-07/completed/event-settlement-report.spec.md) already commits to line-grain resolution for exactly this reason (its §4), and its `resolveEventSettlement` recomputes `Settlement.amountCents` from lines rather than by delta — the same correction this defect needs.

**Ship this first.** That spec's event-end resolution rewrites pending settlements; building it on top of cancellation helpers that nuke aggregate rows would let a cancelled sibling event silently destroy a resolved payout. The two share the "reduce, don't cancel; sum, don't delta" discipline, and the invariant test above is a prerequisite for trusting either.

---

## Review posture

Money path, confirmed defect, with a remediation pass over historical rows. Full `reviewer` at `opus`, Codex cross-model second opinion, and `postgresql-code-review` for the remediation queries and any index they need.
