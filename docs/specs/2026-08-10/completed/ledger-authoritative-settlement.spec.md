# Ledger-Authoritative Settlement — The Clean Cutover

**Date:** 2026-08-10 (rewritten same day: direct cutover, no legacy retained — user decision)
**Status:** **IMPLEMENTED 2026-08-10** (uncommitted; dev-loop: 4 build steps × 2 review rounds each, all APPROVED). Implementation deltas beyond this spec, all review-driven:
- **Durable payout plan** (`PayoutItem.plannedCreditEntryIds/plannedOrderItemIds/plannedNetCents/payoutLedgerKey`, migration `20260813140000`) + a **pre-batch heal sweep** replaying crashed payouts from the frozen plan with no Stripe call — closes the transfer-then-crash window §11 demanded; batch fails CLOSED if the sweep fails.
- **Per-cell cross-run claim** (§6.1) implemented, plus every money key (Stripe, our-side single-flight, ledger claim) derived from one credit-set hash so overlapping runs and replays are no-ops everywhere, not just at Stripe.
- Reserve/fee writes gated on the payable claim landing; reserve seasoning reads both eras (junction pre-cutover, durable plan post-); payable planning ordered by oldest matured money (starvation fix) with a deferred counter.
- `full-money-flow.spec.ts` rewritten onto the real batch via triple-guarded e2e routes; help-center payout articles rewritten to the new truth.
- Remaining follow-ups tracked in the final report: real e2e run on the wiping path (pre-merge gate), `item-level-settlements.spec.ts` rewrite, jobs-manifest topic removal (infra), settlement-table archival, ledger statement UI.
**Priority:** P1 architecture; **supersedes the fix section of** [settlement-cancellation-granularity](settlement-cancellation-granularity.spec.md) (the P0 bug class dies here rather than being patched)
**Affects:** `PayeeLedgerEntry` / `PayeeLedgerBalance` ([finance.prisma:90-126](../../../../packages/db/prisma/finance.prisma#L90-L126)), `runPayoutBatch` ([run-batch.ts](../../../../packages/core/src/use-cases/settlements/run-batch.ts), 2,747 lines), `createSettlementsFromOrder`, every refund path, `Settlement`/`SettlementLine`/`OrderItemSettlementLine`/`OrderSplit` (deleted as logic)
**Related:** [event-settlement-report](../../2026-08-07/completed/event-settlement-report.spec.md) — its event-end resolution becomes "write adjustment entries" instead of "rewrite pending settlement rows."

---

## 1. Decision record

The previous version of this spec ran a four-phase migration with a shadow-verify period, keeping `Settlement.amountCents` alive alongside the ledger. **That is rejected.** Legacy is removed, not preserved; the system is rebuilt forward from the correct model in one cutover.

Two design consequences follow, and both make the system *simpler*, which is the evidence this is the right call:

1. **No `earnedBalanceCents` bucket.** The previous draft invented a second balance bucket solely so the legacy batch's `debtCents = max(0, -ledgerBalanceCents)` would keep working during coexistence. With the batch rewritten, `ledgerBalanceCents` becomes what a balance should have been all along: **the net position** — earnings minus refunds minus payouts minus dispute debits. Debt is not a separate concept; it is a negative balance.
2. **The entire debt-recovery apparatus deletes.** `recoverDebt`, the debt-recovery idempotency keys, the crash-sweep that replays `recoverDebt` for transferred items, `listTransferredWithRecoveredDebt` — 32 call sites threaded through the batch. All of it exists to move money between two systems (payout totals and a debt ledger) that are about to be one system. In the unified model, "recoup debt from the next payout" is not a step; it is arithmetic: `payable = max(0, balance)`.

One thing is explicitly **not** dropped with the legacy: a one-shot verification at cutover (§8). It keeps no legacy code alive — it is a single reconciliation and a single dry-run comparison before the flip.

**Accepted cost, stated plainly:** the interim Phase-0 patch (recompute-from-lines + zero-on-refund) is dropped with the rest. The P0 leak — refund the buyer, still pay the organizer — **continues until this ships.** That is the trade for not building throwaway code twice; it makes cutover speed part of the requirement.

---

## 2. The model

One journal, one balance, one rule.

**`PayeeLedgerEntry` is the only source of truth for what a payee is owed.** Entries are append-only, idempotency-keyed (already enforced: unique key, `createMany skipDuplicates`, balance effects apply exactly once). Nothing ever edits an entry; corrections are new entries linked via `relatedEntryId`.

### Entry semantics after the cutover

| Entry type | Written by | Balance effect | `availableAt` |
|---|---|---|---|
| `SETTLEMENT_CREDIT` | order finalize (per payee, from `computeOrderSplits` output) | + | `computePayoutDate(eventEndsAt, schedule)`; resale: purchase + `resalePayoutReleaseDays` |
| `REFUND_DEBIT` | every refund path (full, partial, admin, reconcile) | − | immediate, always |
| `TRANSFER_REVERSAL_CREDIT` *(new enum member)* | successful Stripe transfer reversal on a post-payout refund | + | immediate |
| `PAYOUT` | payout batch, per transfer | − | immediate |
| `DISPUTE_HOLD` / `DISPUTE_DEBIT` / `DISPUTE_RELEASE` | dispute lifecycle (existing, kept) | hold bucket / − / + | immediate |
| `RESERVE_HOLD` / `RESERVE_RELEASE` | payout batch (existing, kept) | reserve bucket | immediate |
| `MANUAL_ADJUSTMENT` | platform admin (existing, kept) | ± | immediate |

Deleted as concepts: the `recoverDebt` positive-`PAYOUT` squaring entry and everything that feeds it.

### Maturity: the one primitive the ledger was missing

A balance says *how much*; it never said *when*. `availableAt` carries what `Settlement.scheduledPayoutDate` carries today, stamped at write time by the same `computePayoutDate`. Without it, "pay the balance" pays out tonight's sales for an event three weeks away.

```prisma
model PayeeLedgerEntry {
  /// When this entry counts toward the payable balance. Null = immediately.
  /// Credits mature; debits, holds, and payouts are always effective —
  /// asymmetry is the point (see payable query).
  availableAt DateTime?

  @@index([payeeId, currency, availableAt])
}
```

### The payable query

Per `(payeeId, currency)`, at batch time `asOf`:

```
payable(asOf) = Σ credits  WHERE availableAt <= asOf
                           AND NOT blocked                            -- see below + §5
              − Σ REFUND_DEBIT                                        -- always
              + Σ TRANSFER_REVERSAL_CREDIT                            -- always
              − Σ DISPUTE_DEBIT
              + Σ DISPUTE_RELEASE (debit-reversal flavor ONLY)        -- hold-release flavor
                                                                      -- contributes 0: its
                                                                      -- effect IS the hold
                                                                      -- decrement
              − Σ PAYOUT                                              -- always
              − pendingHoldCents                                      -- active holds

blocked := order disputeStatus in (OPEN, UNDER_REVIEW)
           AND no active DISPUTE_HOLD exists for the same
           (order, payee, currency)          -- when a hold exists, the hold IS
                                             -- the withholding mechanism; the
                                             -- status filter firing too would
                                             -- punish the same money twice
           OR order has an open Claim

transfer = max(0, payable) − reserveWithholding                       -- reserves stay transfer-time, §5
```

*(Both refinements above were review findings against the first implementation: the dispute lifecycle writes `disputeStatus` AND a `DISPUTE_HOLD` in the same pass, so an unconditional status exclusion stacked with the pendingHold subtraction double-punished open disputes; and `DISPUTE_RELEASE` has two flavors with different rollup effects — counting the hold-release flavor as `+` would gift the hold amount on every WON dispute.)*

`payable < 0` is a **debt position**: pay nothing, carry forward, and the next cycle's arithmetic recoups it automatically. No recovery step, no squaring entry, no sweep.

**The asymmetry is the entire P0 fix.** Credits wait for maturity; debits never do. A refund inside the pending window reduces `payable` the instant it is written, because there is no second place — no settlement row, no stored total — that anyone has to remember to also update. The bug class is unrepresentable, not patched.

`PayeeLedgerBalance.ledgerBalanceCents` remains as the cached un-dated rollup (all credits regardless of maturity), kept purely so the reconciliation job (§9) has something cheap to check against the entries. It is never read to compute a transfer.

---

## 3. Order finalize (replaces `createSettlementsFromOrder`)

At `finalizeFromPaymentIntent`, in the same transaction as the order writes:

1. `computeOrderSplits` runs exactly as today — the split math is untouched.
2. Per payee: one `SETTLEMENT_CREDIT`, `amountCents` = that payee's split, `orderId` set, `sourceKind: "order_split"`, `availableAt` per the terms' schedule. Idempotency key `settlement-credit:${orderId}:${payeeId}`.
3. **Item-level attribution goes in the entry's `metadata`**: `{ items: { [orderItemId]: contributionCents } }` — the same per-item breakdown that populates `OrderItemSettlementLine` today. Partial refunds (§4) and item-level reporting read it from there. No join table.

The credit *is* the split, materialized. `OrderSplit`, `SettlementLine`, and `OrderItemSettlementLine` carry no information the entry does not.

---

## 4. Refunds: one rule

> **Always write the `REFUND_DEBIT`. Then, if money already left, try to pull it back.**

For each refund (full or partial), per payee, inside the refund transaction:

1. **Debit** = the payee's share of the refunded amount — for partial refunds, Σ of the refunded items' contributions from the credit's `metadata.items`. Idempotency key `refund-debit:${orderId}:${payeeId}:${refundId}`. Assert per `(order, payee)`: cumulative debits ≤ the credit — a refund can never claw back more than was granted.
2. **If the order's items are stamped `paidOutAt`** (money already transferred), attempt the Stripe transfer reversal exactly as `reverseTransfersForItems` does today. On success, write `TRANSFER_REVERSAL_CREDIT` (+, `relatedEntryId` → the debit). Net effect zero — the money came back externally, so the balance owes nothing.
3. **If reversal fails or the money was never transferred**, do nothing further. The debit stands; the balance goes negative if it must; the next payout cycle recoups by arithmetic.

This is the design the user specified for admin refunds — *"try to pull from their stripe connect account, if it fails put a debt on them that we recoup the next payout cycle"* — generalized into the only refund rule, with the pre-payout case falling out for free (nothing transferred → no reversal to attempt → debit nets against the pending credit).

**Recoup cap ("up to a point").** How much of a single payout debt may consume is policy, not structure. Default at cutover: full recoup (`payable = max(0, balance)`), matching today's dispute-debt behaviour. A per-cycle cap (e.g., debt may consume at most N% of a payout, remainder carries) is a one-line change to the payable clamp — **decide the number, or explicitly accept full-recoup** (Open Question 1).

---

## 5. Disputes and reserves: ported, with one trap

**Reserves: unchanged mechanism.** Reserve withholding stays a *transfer-time* step — computed against the transfer amount, `RESERVE_HOLD`/`RESERVE_RELEASE` written exactly as today, released reserves riding a later payout item. Reserves never enter the payable query. (Whether they should is a separate product question; do not change behaviour during a rearchitecture.)

**Disputes: the double-punish trap.** Today `BLOCKED_SETTLEMENT_DISPUTE_STATUSES = [OPEN, UNDER_REVIEW, LOST]` blocks a settlement from transferring, **and** a LOST dispute writes a `DISPUTE_DEBIT`. In the new payable query, a LOST order whose credit is *excluded by the blocked-status filter* and whose `DISPUTE_DEBIT` *also* subtracts is punished **twice**.

The rule the implementation must enforce: **exactly one mechanism per dispute state.**

- `OPEN` / `UNDER_REVIEW`: credit excluded by the status filter (or equivalently held) — provisional, reversible.
- `LOST`: the `DISPUTE_DEBIT` is the punishment. The credit must **re-enter** the payable sum, so credit − debit nets the correct outcome for both the already-paid case (debit recoups from future revenue) and the never-paid case (credit and debit cancel; nothing pays, nothing double-charges).
- `WON`: filter no longer matches; `DISPUTE_RELEASE` squares any hold; credit pays normally.

So the blocked-status filter in §2's query is `[OPEN, UNDER_REVIEW]` only — **deliberately not** today's list. A table-driven test over {never-paid, already-paid} × {WON, LOST, ongoing} asserting the net cents in each cell is mandatory, and must be written against today's *net outcomes* first so any intentional behaviour change is visible in review rather than discovered in production.

---

## 6. The payout batch, rewritten

Per `(payee, currency)` with `payable > 0` and payee eligible (Connect account, payouts enabled, above minimum — existing gates keep):

1. Claim atomically (idempotency key `payout:${payeeId}:${currency}:${cycleDate}` — the claim/replay discipline the current batch already has, kept).
2. Transfer `payable − reserveWithholding` via `createTransfer`.
3. Write the `PAYOUT` entry (−) in the same commit discipline as today: **idempotency committed immediately after the Stripe transfer, before other DB updates** — the double-payment guard from the settlement-pipeline design carries over verbatim.
4. **Attribute consumption FIFO by `availableAt`** over matured, unconsumed credits; record the covered credit entry ids on the `PAYOUT` entry's `metadata`, and stamp the covered orders' items `paidOutAt`. Attribution does not affect *amounts* (the sum is the sum) — it exists so refunds know whether to attempt a reversal (§4.2) and so "which orders did this payout cover" stays answerable.
5. `Payout` / `PayoutItem` **stay** — they are the record of real Stripe transfers and batch runs. `PayoutItemSettlement` dies with `Settlement`.

What this deletes from the 2,747-line batch: settlement grouping and claiming, `listDueForPayout`, the entire debt-recovery block (recovery computation, `recoverDebt` writes, the crash-sweep replay, `listTransferredWithRecoveredDebt`), and the order-kind portion splitting that exists to route settlement subsets. Membership reserve logic keys off credit entries' orders instead of settlement lines' orders — same join, one hop shorter.

---

## 7. What is deleted

| Deleted | Replaced by |
|---|---|
| `Settlement`, `SettlementLine`, `OrderItemSettlementLine` (as logic) | entries; item attribution in credit `metadata`; `paidOutAt` for "was this paid" |
| `OrderSplit` (as logic) | the credit entry *is* the materialized split |
| `createSettlementsFromOrder` | credit writes in order finalize (§3) |
| `cancelForEvent`, `cancelForOrder`, `cancelForPayee`, `updateAmount`, `incrementAmount`, `resetFailed`, `bulkMark*` on settlements | nothing — the concepts don't exist. Event cancellation is just its orders' refunds, each writing debits (Instances 1–3 of the P0 all become unrepresentable) |
| `recoverDebt` + crash-sweep + `listTransferredWithRecoveredDebt` | `payable = max(0, balance)` |
| `/platform/settlements` page + `settlements.resetFailed` mutation | ledger views (§10) |

**Data is archived, not dropped.** The tables are financial history: revoke the code paths, freeze the tables (rename `_archive` or revoke app-role writes), export, and drop in a later cleanup migration once the reconciliation job has run clean for a full cycle. Deleting money history in the cutover migration is the one form of "remove the legacy" this spec refuses.

Follow-on sweeps (each greppable, each its own PR): readers of `listOrderSplits`, org settlement lists, admin settlement surfaces, e2e specs touching settlements, seed data.

---

## 8. Cutover

One deploy, gated by one-shot verification. Dev first, full cycle on dev with `instantPayouts` exercising maturity edge cases explicitly (the flag collapses the hold window — test with it off, too).

1. **Migration**: add `availableAt` + enum member; **backfill**: one `SETTLEMENT_CREDIT` per pending `SettlementLine`'s `(payee, order)` aggregate, `availableAt = scheduledPayoutDate`, idempotency key `backfill:${settlementLineId}` — re-runnable by construction. Transferred/cancelled settlements are history, not backfilled; `paidOutAt` already records the paid state the refund rule needs.
2. **Verify (hard gate)**: per `(payee, currency)`, Σ backfilled matured-view == Σ `pending` settlement amounts, **zero tolerance**; then a dry-run of the new batch against the last real batch's inputs must reproduce its transfer set to the cent. Both are one-shot scripts, not resident legacy.
3. **Flip**: new write paths + new batch in the same deploy that removes the old ones. No flag that keeps both alive — the user's call, and honestly cleaner: a flag here is a lie about there being two systems.
4. **Post-cutover**: reconciliation job (§9) runs from day one; archive tables after one clean cycle.

Rollback story, since there is no flag: the old code is one revert away, and the old tables are frozen but intact until step 4's archive. A revert inside the first cycle loses only ledger entries written since cutover — which the backfill keys make re-derivable.

---

## 9. Invariants and reconciliation

The original sin was a stored number nothing ever checked. The replacement is checked from day one:

- **Rollup**: `ledgerBalanceCents == Σ entries` per `(payee, currency)` — scheduled job, violations via `ReporterPort` (never `logger.warn`; warn is not captured).
- **Per-order conservation**: Σ `REFUND_DEBIT` ≤ Σ `SETTLEMENT_CREDIT` per `(order, payee)` — asserted at write time *and* swept by the job.
- **Completeness**: every `SUCCEEDED` ticketing order has credits summing to its split total — catches a silently skipped write, the failure mode stored totals could never surface.
- **Idempotency**: replayed webhooks/batches produce zero new entries (already structural; the job proves it stays true).

---

## 10. UI workstream (real scope, not a footnote)

Org payments and platform admin currently read settlements. Ledger views replace them — and are strictly better: a payee's page becomes a statement (credits with maturity dates, refund debits, payouts, running balance) instead of a list of opaque batch rows. Scope: org "upcoming payout" panel, payout history detail, `/platform` settlement admin → ledger admin with `MANUAL_ADJUSTMENT` as the correction tool. Ships in the same cutover (the old pages read deleted logic), so it is on the critical path — plan it, don't discover it.

---

## 11. Acceptance criteria

- [ ] A refund at any moment — before maturity, after maturity, after payout — results in exactly one net recovery: debit-nets-credit, or successful reversal (net zero), or carried debt. A table-driven test covers all three × full/partial.
- [ ] The three DIAGNOSTIC characterization tests are inverted: pre-payout refund now provably reduces the next transfer by the payee's share, to the cent.
- [ ] Two same-week events, one cancelled: the surviving event's revenue pays in full; the cancelled one's nets to zero — no shared-row coupling exists to test around, but the scenario stays as a regression pin.
- [ ] Immature credits never transfer; `availableAt` honours event schedules and `resalePayoutReleaseDays`.
- [ ] Dispute matrix (§5) passes with net outcomes equal to today's in every cell, or with differences explicitly enumerated in the PR description.
- [ ] Debt carry: negative balance reduces the next payout by exactly the debt (or the capped amount, per Open Question 1); no `recoverDebt` entry exists anywhere after cutover.
- [ ] Payout idempotency: transfer-then-crash replay produces no double transfer and no double `PAYOUT` entry.
- [ ] Backfill verification and dry-run comparison both pass at zero divergence before the flip; results pasted in the PR.
- [ ] Reconciliation job live from day one; a deliberately corrupted rollup in dev triggers the Sentry report.
- [ ] Payable never sums across currencies.
- [ ] Archived settlement tables are write-revoked; no code path references them.

---

## 12. Open questions

1. **Debt recoup cap** — full recoup (today's dispute behaviour) or a per-cycle cap? User has said "up to a point"; needs a number or an explicit "full, for now."
2. **`TRANSFER_REVERSAL_CREDIT`** as a new enum member vs. reusing `MANUAL_ADJUSTMENT` with metadata — new member recommended; reversal volume deserves its own type for reporting.
3. **Ledger UI depth at cutover** — minimum is parity (upcoming payout number + history); the full statement view can follow. Decide the cut line before the build starts, since it gates the deploy.
4. **The 2026-08-07 event-settlement spec** rewrites once this lands: `resolveEventSettlement` becomes "write per-payee adjustment entries at event end" — strictly simpler. Rewrite after this spec is accepted, not in parallel.

---

## 13. Review posture

The most consequential change the repository will ever take: replacing how money is computed, with no coexistence period. That raises the bar on the *gates* since there is no shadow period to catch drift:

- Full `reviewer` at `opus` per PR; **Codex cross-model second opinion** reconciled on the batch rewrite and the refund rule specifically
- `postgresql-code-review` on the migration, backfill, and payable query
- The §5 dispute matrix and §8 verification gates are **not schedule-negotiable** — they are the entire safety story once shadow-verify is off the table
- A full simulated payout cycle on dev — sales, partial refund, full refund, dispute LOST, dispute WON, cancellation, payout, post-payout refund with failed reversal, next-cycle recoup — before the prod deploy is scheduled
