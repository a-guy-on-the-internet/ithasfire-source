import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { TxRepos } from "@th/ports/repos";
import type { PayeeLedgerEntryRecord } from "@th/ports/repos/payee-ledger";
import { formatOrderCode } from "@th/types/order-identifier";

import { describeError } from "../../../lib/io";

/**
 * The one refund rule (ledger-authoritative-settlement spec §4):
 *
 * > Always write the REFUND_DEBIT. Then, if money already left, try to pull
 * > it back.
 *
 * `writeRefundDebitsForOrder` is the first half — the debit — shared by
 * EVERY refund path (full, partial, org, reconcile, cancel-event,
 * review-claim). It reads the order's ledger entries, computes each payee's
 * share of the refunded amount from the SETTLEMENT_CREDIT's
 * `metadata.items` attribution, and writes one REFUND_DEBIT per payee inside
 * the caller's transaction. `writeTransferReversalCreditsForOrder` is the
 * second half, called only by paths that actually reversed Stripe transfers.
 *
 * Invariants enforced here:
 *  - Cumulative debits never exceed the credit per (order, payee) — the
 *    partial-refund sum is clamped to `credit − Σ prior debits`, and a
 *    biting clamp is reported (it means attribution drift).
 *  - The same refund replayed writes nothing twice: the idempotency key
 *    `refund-debit:${orderId}:${payeeId}:${refundKey}` is unique in the
 *    repo, and prior debits under the SAME key are excluded from the
 *    Σ-prior-debits so a replay recomputes the identical amount and the
 *    repo's replay discipline dedupes it.
 *  - A missing credit (order finalized pre-cutover, or a credit write that
 *    was never re-driven) writes NOTHING and never throws — the buyer's
 *    refund must not be blocked by ledger bookkeeping — but it is loudly
 *    visible: `logger.error` AND `reportError` (a `logger.warn` would not be
 *    captured; CLAUDE.md error-reporting convention).
 */

export interface WriteRefundDebitsInput {
  order: { id: string; currency: string };
  /** The order-item ids actually refunded by THIS refund (partial math). */
  refundedItemIds: readonly string[];
  /**
   * The caller's stable refund identity: the Stripe refund id where one
   * exists, the internal refund/claim id otherwise. Same refund replayed →
   * same keys → no double debit.
   */
  refundKey: string;
  /**
   * True when after this refund every ticket item on the order is refunded
   * (previously or now). Transferred-but-kept items must make this FALSE —
   * their revenue stays with the payee. In full mode the debit is
   * `credit − Σ prior debits` rather than Σ metadata contributions, because
   * zero-share items are omitted from the attribution metadata and a full
   * refund must return the full credit to the cent.
   */
  attemptedFullRefund: boolean;
  /** Caller name for reportError tags (e.g. "refundFullOrder"). */
  useCase: string;
  logger?: LoggerPort;
  reportError?: ReporterPort | null;
}

export interface RefundDebitResult {
  payeeId: string;
  debitCents: number;
  entryId: string;
}

export function buildRefundDebitIdempotencyKey(
  orderId: string,
  payeeId: string,
  refundKey: string,
): string {
  return `refund-debit:${orderId}:${payeeId}:${refundKey}`;
}

export function buildTransferReversalCreditIdempotencyKey(
  orderId: string,
  payeeId: string,
  refundKey: string,
): string {
  return `transfer-reversal:${orderId}:${payeeId}:${refundKey}`;
}

/** Key namespace of the dispute PRINCIPAL debit — the claim against the credit. */
export const DISPUTE_PRINCIPAL_DEBIT_KEY_PREFIX = "dispute-debit:";
/** Key namespace of the membership dispute FEE debit (never a credit claim). */
export const DISPUTE_FEE_DEBIT_KEY_PREFIX = "dispute-debit-fee:";
/** Key namespace of the fee debit's WON-after-LOST reversal. */
export const DISPUTE_FEE_REVERSAL_KEY_PREFIX = "dispute-debit-reversal-fee:";

/**
 * Per payee, the dispute PRINCIPAL already realised against an order:
 * Σ DISPUTE_DEBIT (excluding the `dispute-debit-fee:` namespace — Stripe's
 * dispute fee is money on top of the credit, not a claim against it)
 * − Σ DISPUTE_RELEASE whose related entry is one of those debits (the
 * WON-after-LOST reversal; the hold-release flavour relates to a
 * DISPUTE_HOLD and has no balance effect), floored at 0. Same discrimination
 * as the rollup-drift and conservation sweeps.
 *
 * ONE definition, used by both sides so they stay symmetric:
 *   - `retainedCreditByPayee` (the dispute-loss cap) subtracts it, so a
 *     second dispute on the same order cannot re-claim the first's debit;
 *   - the refund writers below subtract it from `remainingCents`, so a
 *     refund AFTER a partial lost dispute cannot claw credit + debit.
 */
export function realisedDisputeDebitCentsByPayee(
  entries: readonly PayeeLedgerEntryRecord[],
): Map<string, number> {
  const principalDebitIds = new Set(
    entries
      .filter(
        (e) =>
          e.type === "DISPUTE_DEBIT" &&
          !e.idempotencyKey.startsWith(DISPUTE_FEE_DEBIT_KEY_PREFIX),
      )
      .map((e) => e.id),
  );
  const net = new Map<string, number>();
  for (const entry of entries) {
    if (
      entry.type === "DISPUTE_DEBIT" &&
      principalDebitIds.has(entry.id)
    ) {
      net.set(entry.payeeId, (net.get(entry.payeeId) ?? 0) + entry.amountCents);
    } else if (
      entry.type === "DISPUTE_RELEASE" &&
      !entry.idempotencyKey.startsWith(DISPUTE_FEE_REVERSAL_KEY_PREFIX) &&
      entry.relatedEntryId !== null &&
      principalDebitIds.has(entry.relatedEntryId)
    ) {
      net.set(entry.payeeId, (net.get(entry.payeeId) ?? 0) - entry.amountCents);
    }
  }
  for (const [payeeId, cents] of net) {
    if (cents < 0) net.set(payeeId, 0);
  }
  return net;
}

/**
 * What each payee still HOLDS from an order according to the ledger:
 * Σ SETTLEMENT_CREDIT − Σ REFUND_DEBIT − realised dispute principal
 * (`realisedDisputeDebitCentsByPayee`) per payee, floored at 0. Pure — takes
 * the rows `listOrderEntries` returns (the same read the refund writers in
 * this file use) so the dispute-loss debit and the refund debit share one
 * definition of "what is left of the credit".
 *
 * TRANSFER_REVERSAL_CREDIT is deliberately NOT added back. It compensates a
 * REFUND_DEBIT on the balance because the money physically came back through
 * a Stripe transfer reversal — the payee kept nothing MORE of the order for
 * it. Worked case: payee paid 5000 (PAYOUT) → full refund after payout writes
 * REFUND_DEBIT 5000 → the transfer reversal succeeds and writes
 * TRANSFER_REVERSAL_CREDIT 5000. The ledger nets to 0 and the payee has
 * physically returned the 5000. Σ credit − Σ refund debit = 0: they hold
 * nothing of the order. Adding the reversal back would read 5000, and a
 * lost chargeback on that order would then debit 5000 from a payee who
 * already gave it back — a double claw. The conservation sweep
 * (`listConservationViolations`) reads it the same way.
 *
 * SYMMETRY: the refund writers below subtract the same realised dispute
 * principal from their `remainingCents`, so refund-then-lost and
 * lost-then-refund both stop at the credit.
 */
export function retainedCreditByPayee(
  entries: readonly PayeeLedgerEntryRecord[],
): Map<string, number> {
  const disputeDebits = realisedDisputeDebitCentsByPayee(entries);
  const net = new Map<string, number>();
  for (const entry of entries) {
    if (entry.type === "SETTLEMENT_CREDIT") {
      net.set(entry.payeeId, (net.get(entry.payeeId) ?? 0) + entry.amountCents);
    } else if (entry.type === "REFUND_DEBIT") {
      net.set(entry.payeeId, (net.get(entry.payeeId) ?? 0) - entry.amountCents);
    }
  }
  for (const [payeeId, cents] of net) {
    net.set(payeeId, Math.max(0, cents - (disputeDebits.get(payeeId) ?? 0)));
  }
  return net;
}

export async function writeRefundDebitsForOrder(
  tx: Pick<TxRepos, "payeeLedger" | "splits">,
  input: WriteRefundDebitsInput,
): Promise<RefundDebitResult[]> {
  const { order, refundKey, useCase } = input;
  const entries = await tx.payeeLedger.listOrderEntries(order.id);

  const credits = entries.filter((e) => e.type === "SETTLEMENT_CREDIT");

  // Partial-miss detection (Step C review, WARNING): the zero-credit branch
  // below catches a wholly missing write, but a multi-payee order where ONE
  // payee's credit write was lost would debit the others and stay silent —
  // the "silently skipped write" failure mode spec §9 names. The OrderSplit
  // rows (still written at checkout) are the expected payee set; report any
  // nonzero-split payee with no credit. Best-effort: a splits read failure
  // must never block the refund.
  try {
    const splits = await tx.splits.getForOrder(order.id);
    const creditPayees = new Set(credits.map((c) => c.payeeId));
    const missing = splits.filter(
      (s) => s.amountCents > 0 && !creditPayees.has(s.payeeId),
    );
    if (missing.length > 0 && credits.length > 0) {
      reportDrift(input, "missing_credit_for_payee", {
        orderId: order.id,
        refundKey,
        missingPayeeIds: missing.map((s) => s.payeeId),
        missingCents: missing.map((s) => s.amountCents),
      });
    }
  } catch (err) {
    // A swallow around a `tx` statement is normally [BLOCKING] (see
    // docs/engineering-standards.md § Swallowing an error inside a
    // transaction). This site is EXEMPT for one reason only: a failed splits
    // read has already condemned the transaction, and EVERY caller executes at
    // least one further `tx` statement after this writer returns (the audit
    // log, at minimum), so the failure surfaces as a loud 25P02 there rather
    // than a silent COMMIT→ROLLBACK. The report exists to name the real cause.
    // A caller that ENDS its transaction on this writer breaks that guarantee
    // and must not rely on this catch. Separately: a silent swallow disabled
    // the ONLY signal for a partially-lost SETTLEMENT_CREDIT write, so the
    // detector's own failure is drift-reported (logger.error + reportError).
    reportDrift(input, "missing_credit_detection_failed", {
      orderId: order.id,
      refundKey,
      error: describeError(err),
    });
  }

  if (credits.length === 0) {
    // Deliberate swallow that MUST be visible: pre-cutover orders (or a
    // credit write that failed and was never re-driven) have no ledger
    // credits, so there is nothing to debit — but silently skipping would
    // hide a real revenue-accounting gap. Never throw: the buyer's refund
    // must not be blocked by ledger bookkeeping.
    input.logger?.error("refund_debit_no_credits_for_order", {
      orderId: order.id,
      refundKey,
      useCase,
    });
    try {
      input.reportError?.(new Error("refund_debit_no_credits_for_order"), {
        tags: { useCase, step: "refundDebit", reason: "no_credits_for_order" },
        extra: { orderId: order.id, refundKey },
      });
    } catch {
      // A throwing reporter never changes behaviour.
    }
    return [];
  }

  // Group per payee. There is at most one SETTLEMENT_CREDIT per (order,
  // payee) by key construction (`settlement-credit:${orderId}:${payeeId}`);
  // summing defensively keeps the math right even if that ever changes.
  const disputeDebitByPayee = realisedDisputeDebitCentsByPayee(entries);
  const byPayee = new Map<
    string,
    {
      creditCents: number;
      items: Record<string, number>;
      priorDebitCents: number;
      disputeDebitCents: number;
    }
  >();
  for (const credit of credits) {
    const agg = byPayee.get(credit.payeeId) ?? {
      creditCents: 0,
      items: {},
      priorDebitCents: 0,
      disputeDebitCents: disputeDebitByPayee.get(credit.payeeId) ?? 0,
    };
    agg.creditCents += credit.amountCents;
    for (const [itemId, cents] of Object.entries(parseCreditItems(credit))) {
      agg.items[itemId] = (agg.items[itemId] ?? 0) + cents;
    }
    byPayee.set(credit.payeeId, agg);
  }
  for (const entry of entries) {
    if (entry.type !== "REFUND_DEBIT") continue;
    // A prior debit under THIS refund's own key is a replay of the debit we
    // are about to (re)compute — excluding it keeps the recomputed amount
    // identical so the repo's key-replay discipline dedupes it, instead of
    // the Σ-prior-debits collapsing the replay to a phantom zero.
    if (
      entry.idempotencyKey ===
      buildRefundDebitIdempotencyKey(order.id, entry.payeeId, refundKey)
    ) {
      continue;
    }
    const agg = byPayee.get(entry.payeeId);
    if (agg) agg.priorDebitCents += entry.amountCents;
  }

  const refundedItemIds = new Set(input.refundedItemIds);
  const results: RefundDebitResult[] = [];

  for (const [payeeId, agg] of byPayee) {
    // What is left of the credit after earlier refunds AND any dispute
    // principal already realised against this order (a partial LOST then a
    // full refund must stop at the credit, not claw credit + debit).
    const remainingCents =
      agg.creditCents - agg.priorDebitCents - agg.disputeDebitCents;

    if (remainingCents < 0) {
      // Σ debits > credit — spec §4.1's asserted invariant is already
      // violated by existing rows. Nothing sane to write; report the drift.
      reportDrift(input, "cumulative_debits_exceed_credit", {
        orderId: order.id,
        payeeId,
        refundKey,
        creditCents: agg.creditCents,
        priorDebitCents: agg.priorDebitCents,
        disputeDebitCents: agg.disputeDebitCents,
      });
      continue;
    }

    let debitCents: number;
    if (input.attemptedFullRefund) {
      // Full refund: the FULL credit comes back (minus what earlier partial
      // refunds already clawed) — NOT Σ metadata items, which omits
      // zero-share items and would strand their cents on the balance.
      debitCents = remainingCents;
    } else {
      const attributedCents = [...refundedItemIds].reduce(
        (sum, itemId) => sum + (agg.items[itemId] ?? 0),
        0,
      );
      debitCents = Math.min(attributedCents, remainingCents);
      if (debitCents < attributedCents) {
        // The clamp bit: this refund's attributed share exceeds what is
        // left of the credit. The clamped amount is still written (the
        // invariant holds) but the mismatch means attribution drift —
        // surface it.
        reportDrift(input, "refund_debit_clamped", {
          orderId: order.id,
          payeeId,
          refundKey,
          attributedCents,
          remainingCents,
        });
      }
    }

    // Zero-share payees get no debit — the repo rejects amounts ≤ 0 by
    // design, and a zero entry would be statement noise.
    if (debitCents <= 0) continue;

    const entry = await tx.payeeLedger.refundDebit({
      idempotencyKey: buildRefundDebitIdempotencyKey(
        order.id,
        payeeId,
        refundKey,
      ),
      payeeId,
      amountCents: debitCents,
      currency: order.currency,
      orderId: order.id,
      description: `Refund — order ${formatOrderCode(order.id)}`,
      sourceKind: "order_refund",
      sourceId: refundKey,
      metadata: {
        refundKey,
        attemptedFullRefund: input.attemptedFullRefund,
        refundedItemIds: [...input.refundedItemIds],
      },
    });

    results.push({ payeeId, debitCents, entryId: entry.id });
  }

  return results;
}

// ── Amount-based external partial refund debits ─────────────────────────────
//
// ADDITIVE EXTENSION (external-partial-refund leak fix): a second debit
// writer for refunds that have NO item granularity — Stripe-dashboard /
// async partial refunds arrive as a bare buyer-side amount on the payment
// intent, so `refundedItemIds` attribution (the mode above) cannot apply.
// `writeRefundDebitsForOrder` is untouched; every internal refund path keeps
// its item-attributed behaviour byte-for-byte.

export interface WriteExternalAmountRefundDebitsInput {
  order: { id: string; currency: string };
  /**
   * The caller's stable refund identity — for external partials this is
   * `${stripeRefundId}:${cumulativeRefundedCents}` (see
   * reconcile-stripe-full-refund's partial arm for why the amount suffix:
   * the refund id can be a best-effort `refunds.list` guess, and a stale-id
   * collision under a plain-id key would key-replay away a later, larger
   * recompute). Callers without a refund id must report and skip BEFORE
   * calling — an amount-ONLY key would collapse two equal-amount partials
   * on one PI into a single debit. Key SHAPE is otherwise free: the
   * Σ-prior-debits loop below spans every prior REFUND_DEBIT row on the
   * order regardless of how its key was built, excluding only rows whose
   * key exactly matches THIS one.
   */
  refundKey: string;
  /**
   * CUMULATIVE buyer-side cents refunded on the payment intent so far
   * (Stripe's `charge.amount_refunded`) — cumulative, not per-event, so a
   * missed earlier event self-heals: each event debits up to the cumulative
   * target minus what prior debits already clawed.
   */
  cumulativeRefundedCents: number;
  /**
   * The buyer-side total for the whole order
   * (`computeExpectedPaymentAmount`) — the denominator of the proportional
   * scale.
   */
  expectedBuyerTotalCents: number;
  /** Caller name for reportError tags. */
  useCase: string;
  logger?: LoggerPort;
  reportError?: ReporterPort | null;
}

/**
 * Proportional partial-refund debits for amount-level (item-less) refunds.
 *
 * Formula (source of truth: spec §4.1 "Debit = the payee's share of the
 * refunded amount", generalized to the item-less case — §4.1's Σ-of-item-
 * contributions is undefined when the refund names no items, so the payee's
 * share is taken proportionally to their SETTLEMENT_CREDIT):
 *
 *   cumulativeTargetᵖ = ⌊cumulativeRefunded × creditᵖ / expectedBuyerTotal⌋
 *   … + largest-remainder distribution so that
 *   Σᵖ targets == ⌊cumulativeRefunded × Σᵖ creditᵖ / expectedBuyerTotal⌋
 *   debitᵖ (this event) = clamp(cumulativeTargetᵖ − Σ prior debitsᵖ, 0, creditᵖ − Σ prior debitsᵖ)
 *
 * At `cumulativeRefunded == expectedBuyerTotal` the ratio is exactly 1, so
 * the target equals the credit and the payee nets to zero — the same
 * terminal state the full-refund branch of `writeRefundDebitsForOrder`
 * produces (`credit − Σ prior debits`).
 *
 * Cumulative-target arithmetic gives the same replay/idempotency safety as
 * the item mode: prior debits under THIS refundKey are excluded from
 * Σ-prior-debits (identical recompute → repo key-dedupe), prior debits under
 * OTHER keys (earlier partials, internal item refunds — Stripe's cumulative
 * counts those refunds too) subtract from the target, and out-of-order
 * delivery clamps to zero instead of over-debiting. Note internal item
 * refunds in PASS_THROUGH mode refund the buyer slightly less than the
 * item's payee-side debit (processing fee withheld), so a later external
 * partial on such an order errs LOW, never high; the full-refund arm trues
 * everything up at the end.
 */
export async function writeExternalAmountRefundDebitsForOrder(
  tx: Pick<TxRepos, "payeeLedger" | "splits">,
  input: WriteExternalAmountRefundDebitsInput,
): Promise<RefundDebitResult[]> {
  const { order, refundKey, useCase } = input;

  if (input.expectedBuyerTotalCents <= 0) {
    // A refund exists but the order's buyer total computes to nothing —
    // there is no denominator to scale by. Report, never guess.
    reportDrift(input, "amount_refund_zero_expected_total", {
      orderId: order.id,
      refundKey,
      cumulativeRefundedCents: input.cumulativeRefundedCents,
    });
    return [];
  }

  const cumulativeRefundedCents = Math.min(
    Math.max(0, Math.trunc(input.cumulativeRefundedCents)),
    input.expectedBuyerTotalCents,
  );
  if (cumulativeRefundedCents === 0) {
    // Nothing refunded → nothing to debit. Silence is correct: no money
    // moved, so there is no leak to account for.
    return [];
  }

  const entries = await tx.payeeLedger.listOrderEntries(order.id);
  const credits = entries.filter((e) => e.type === "SETTLEMENT_CREDIT");

  // Partial-miss detection — same best-effort check as the item-mode writer:
  // a nonzero-split payee with no credit is a silently-lost credit write.
  try {
    const splits = await tx.splits.getForOrder(order.id);
    const creditPayees = new Set(credits.map((c) => c.payeeId));
    const missing = splits.filter(
      (s) => s.amountCents > 0 && !creditPayees.has(s.payeeId),
    );
    if (missing.length > 0 && credits.length > 0) {
      reportDrift(input, "missing_credit_for_payee", {
        orderId: order.id,
        refundKey,
        missingPayeeIds: missing.map((s) => s.payeeId),
        missingCents: missing.map((s) => s.amountCents),
      });
    }
  } catch (err) {
    // A swallow around a `tx` statement is normally [BLOCKING] (see
    // docs/engineering-standards.md § Swallowing an error inside a
    // transaction). This site is EXEMPT for one reason only: a failed splits
    // read has already condemned the transaction, and EVERY caller executes at
    // least one further `tx` statement after this writer returns (the audit
    // log, at minimum), so the failure surfaces as a loud 25P02 there rather
    // than a silent COMMIT→ROLLBACK. The report exists to name the real cause.
    // A caller that ENDS its transaction on this writer breaks that guarantee
    // and must not rely on this catch. Separately: a silent swallow disabled
    // the ONLY signal for a partially-lost SETTLEMENT_CREDIT write, so the
    // detector's own failure is drift-reported (logger.error + reportError).
    reportDrift(input, "missing_credit_detection_failed", {
      orderId: order.id,
      refundKey,
      error: describeError(err),
    });
  }

  if (credits.length === 0) {
    // Same loud swallow as the item-mode writer: pre-cutover orders have no
    // credits to debit — visible, never throwing (identical log/report
    // shape so Sentry groups both writers' misses together).
    input.logger?.error("refund_debit_no_credits_for_order", {
      orderId: order.id,
      refundKey,
      useCase,
    });
    try {
      input.reportError?.(new Error("refund_debit_no_credits_for_order"), {
        tags: { useCase, step: "refundDebit", reason: "no_credits_for_order" },
        extra: { orderId: order.id, refundKey },
      });
    } catch {
      // A throwing reporter never changes behaviour.
    }
    return [];
  }

  // Group per payee: credit total + prior debits under OTHER refund keys.
  const disputeDebitByPayee = realisedDisputeDebitCentsByPayee(entries);
  const byPayee = new Map<
    string,
    { creditCents: number; priorDebitCents: number; disputeDebitCents: number }
  >();
  for (const credit of credits) {
    const agg = byPayee.get(credit.payeeId) ?? {
      creditCents: 0,
      priorDebitCents: 0,
      disputeDebitCents: disputeDebitByPayee.get(credit.payeeId) ?? 0,
    };
    agg.creditCents += credit.amountCents;
    byPayee.set(credit.payeeId, agg);
  }
  for (const entry of entries) {
    if (entry.type !== "REFUND_DEBIT") continue;
    if (
      entry.idempotencyKey ===
      buildRefundDebitIdempotencyKey(order.id, entry.payeeId, refundKey)
    ) {
      continue;
    }
    const agg = byPayee.get(entry.payeeId);
    if (agg) agg.priorDebitCents += entry.amountCents;
  }

  // Proportional cumulative targets with largest-remainder distribution
  // (deterministic: remainder desc, then payeeId asc), so Σ targets equals
  // the payee-side scale of the cumulative refund to the cent.
  const totalCreditCents = [...byPayee.values()].reduce(
    (sum, agg) => sum + agg.creditCents,
    0,
  );
  const totalTargetCents = Math.floor(
    (cumulativeRefundedCents * totalCreditCents) /
      input.expectedBuyerTotalCents,
  );
  const targets = [...byPayee.entries()].map(([payeeId, agg]) => {
    const numerator = cumulativeRefundedCents * agg.creditCents;
    return {
      payeeId,
      agg,
      targetCents: Math.floor(numerator / input.expectedBuyerTotalCents),
      remainder: numerator % input.expectedBuyerTotalCents,
    };
  });
  let leftoverCents =
    totalTargetCents - targets.reduce((sum, t) => sum + t.targetCents, 0);
  const byRemainder = [...targets].sort(
    (a, b) =>
      b.remainder - a.remainder || (a.payeeId < b.payeeId ? -1 : 1),
  );
  for (const target of byRemainder) {
    if (leftoverCents <= 0) break;
    target.targetCents += 1;
    leftoverCents -= 1;
  }

  const results: RefundDebitResult[] = [];

  for (const { payeeId, agg, targetCents } of targets) {
    // Realised dispute principal counts against the credit exactly like a
    // prior refund debit (see `realisedDisputeDebitCentsByPayee`); the
    // TARGET is still the refund's own cumulative share.
    const remainingCents =
      agg.creditCents - agg.priorDebitCents - agg.disputeDebitCents;

    if (remainingCents < 0) {
      // Σ debits > credit — the §4.1 invariant is already violated by
      // existing rows. Nothing sane to write; report the drift.
      reportDrift(input, "cumulative_debits_exceed_credit", {
        orderId: order.id,
        payeeId,
        refundKey,
        creditCents: agg.creditCents,
        priorDebitCents: agg.priorDebitCents,
        disputeDebitCents: agg.disputeDebitCents,
      });
      continue;
    }

    // target ≤ credit by construction (cumulative ≤ expected), so
    // target − priors ≤ remaining; the extra min() is belt-and-braces.
    const debitCents = Math.min(
      Math.max(0, targetCents - agg.priorDebitCents),
      remainingCents,
    );
    if (debitCents <= 0) continue;

    const entry = await tx.payeeLedger.refundDebit({
      idempotencyKey: buildRefundDebitIdempotencyKey(
        order.id,
        payeeId,
        refundKey,
      ),
      payeeId,
      amountCents: debitCents,
      currency: order.currency,
      orderId: order.id,
      description: `Refund — order ${formatOrderCode(order.id)}`,
      sourceKind: "order_refund",
      sourceId: refundKey,
      metadata: {
        refundKey,
        attemptedFullRefund: false,
        amountBasis: {
          cumulativeRefundedCents,
          expectedBuyerTotalCents: input.expectedBuyerTotalCents,
          cumulativeTargetCents: targetCents,
        },
      },
    });

    results.push({ payeeId, debitCents, entryId: entry.id });
  }

  return results;
}

// ── Transfer-reversal credits (spec §4.2) ───────────────────────────────────

/** One Stripe reversal result row, as `reverseTransfersForItems` returns. */
export interface ReversalResultLike {
  orderItemId: string;
  /**
   * Pre-cutover attribution: the Settlement whose transfer was reversed.
   * NULL for ledger-era reversals — post-cutover payouts write no Settlement
   * rows, so `payeeId` (read off the PayoutItem) carries attribution instead.
   */
  settlementId: string | null;
  /** Ledger-era attribution: the PayoutItem whose transfer was reversed. */
  payoutItemId?: string;
  /** Ledger-era payee attribution — trusted directly, no settlement lookup. */
  payeeId?: string;
  stripeTransferId: string;
  reversalId: string;
  reversedCents: number;
}

export interface PayeeReversal {
  payeeId: string;
  reversedCents: number;
  reversalIds: string[];
  stripeTransferIds: string[];
}

/**
 * Group per-item reversal results by PAYEE. Ledger-era results carry their
 * `payeeId` directly (read off the PayoutItem — post-cutover payouts have no
 * settlement to look up); pre-cutover results are mapped via the settlement
 * each transfer belonged to (`payeeIdBySettlementId` — read from
 * `settlements.getByIds` BEFORE the refund transaction). A result that maps
 * through NEITHER is skipped and reported: money came back from SOMEONE'S
 * account and we could not attribute it.
 */
export function groupReversalsByPayee(
  results: readonly ReversalResultLike[],
  payeeIdBySettlementId: ReadonlyMap<string, string>,
  ctx: {
    useCase: string;
    orderId: string;
    logger?: LoggerPort;
    reportError?: ReporterPort | null;
  },
): PayeeReversal[] {
  const byPayee = new Map<string, PayeeReversal>();
  for (const result of results) {
    const payeeId =
      result.payeeId ??
      (result.settlementId !== null
        ? payeeIdBySettlementId.get(result.settlementId)
        : undefined);
    if (!payeeId) {
      ctx.logger?.error("transfer_reversal_unmapped_settlement", {
        orderId: ctx.orderId,
        settlementId: result.settlementId,
        payoutItemId: result.payoutItemId,
        reversalId: result.reversalId,
      });
      try {
        ctx.reportError?.(new Error("transfer_reversal_unmapped_settlement"), {
          tags: {
            useCase: ctx.useCase,
            step: "transferReversalCredit",
            reason: "unmapped_settlement",
          },
          extra: {
            orderId: ctx.orderId,
            settlementId: result.settlementId,
            payoutItemId: result.payoutItemId,
          },
        });
      } catch {
        // best-effort reporter
      }
      continue;
    }
    const agg = byPayee.get(payeeId) ?? {
      payeeId,
      reversedCents: 0,
      reversalIds: [],
      stripeTransferIds: [],
    };
    agg.reversedCents += result.reversedCents;
    if (!agg.reversalIds.includes(result.reversalId)) {
      agg.reversalIds.push(result.reversalId);
    }
    if (!agg.stripeTransferIds.includes(result.stripeTransferId)) {
      agg.stripeTransferIds.push(result.stripeTransferId);
    }
    byPayee.set(payeeId, agg);
  }
  return [...byPayee.values()];
}

export interface WriteTransferReversalCreditsInput {
  order: { id: string; currency: string };
  refundKey: string;
  /** Per-payee successful Stripe reversals (see {@link groupReversalsByPayee}). */
  reversals: readonly PayeeReversal[];
  /** The debits just written by {@link writeRefundDebitsForOrder}. */
  debits: readonly RefundDebitResult[];
  useCase: string;
  logger?: LoggerPort;
  reportError?: ReporterPort | null;
}

export interface TransferReversalCreditResult {
  payeeId: string;
  creditCents: number;
  entryId: string;
}

/**
 * Spec §4.2: on a SUCCESSFUL Stripe transfer reversal, write a
 * TRANSFER_REVERSAL_CREDIT (+) linked to that payee's REFUND_DEBIT so the
 * balance nets zero — the money came back externally. On reversal failure
 * the caller never reaches here: the debit stands and the next payout cycle
 * recoups by arithmetic.
 *
 * ## Cross-key fallback pairing (reversal-credit starvation fix)
 *
 * The credit is NOT limited to the debits the caller just wrote
 * (`input.debits`). Concrete starved ordering this heals (cancel-event ×
 * reconcile race): cancel-event holds the refund mutex only around its
 * Stripe reversal+refund, releases, and runs its ledger tx LAST — the
 * `charge.refunded` webhook its own refund fired can land in that gap, and
 * the reconcile full arm then writes the order's full REFUND_DEBIT first
 * (under ITS key). Cancel's tx later recomputes `credit − Σ priors = 0`,
 * writes no debit of its own, and under debit-linked pairing the 9,500¢ the
 * payee PHYSICALLY returned via the Stripe reversal would never be credited
 * — they'd repay twice. So: per payee, headroom is computed from ALL
 * REFUND_DEBIT rows on the (order, payee) cell minus ALL existing
 * TRANSFER_REVERSAL_CREDIT rows (excluding this refundKey's own row so a
 * replay recomputes identically and the repo key-dedupe absorbs it), and
 * the credit is `min(reversedCents, headroom)`, floored at zero.
 *
 * ## The invariant this preserves — across ALL orderings
 *
 *   Σ TRANSFER_REVERSAL_CREDIT ≤ Σ REFUND_DEBIT   per (order, payee, currency)
 *
 * which is exactly the second HAVING clause of the verify-ledger
 * conservation scan (`listConservationViolations`,
 * packages/adapters/src/db/prisma/payee-ledger.ts — driven by
 * `verify-ledger-invariants.ts`). The headroom clamp enforces it by
 * construction: whoever wrote the debit (this caller, the reconcile
 * webhook, an earlier partial), the credit can never exceed what debits
 * exist minus what credits were already minted. The buyer-side-vs-payee-side
 * clamp rationale (Step C review) is subsumed: `reversedCents` is buyer-side
 * and strictly larger than the payee-side debit in PASS_THROUGH mode, and
 * the headroom cap keeps the residual reported, never minted.
 *
 * `reversal_without_debit` drift now fires ONLY in the genuine case: zero
 * REFUND_DEBIT rows exist ANYWHERE for the payee (no credits for the order,
 * or the payee's debit computed to zero on every path) — a credit then
 * would gift the payee the reversed cents.
 */
export async function writeTransferReversalCreditsForOrder(
  tx: Pick<TxRepos, "payeeLedger">,
  input: WriteTransferReversalCreditsInput,
): Promise<TransferReversalCreditResult[]> {
  const { order, refundKey, useCase } = input;
  const debitByPayee = new Map(input.debits.map((d) => [d.payeeId, d]));
  const results: TransferReversalCreditResult[] = [];

  // One read serves every payee. Debits written earlier in the CALLER'S
  // transaction (via tx.payeeLedger.refundDebit) are visible here — a
  // transaction reads its own writes — so in-call and pre-existing rows are
  // treated uniformly.
  const entries = await tx.payeeLedger.listOrderEntries(order.id);

  for (const reversal of input.reversals) {
    if (reversal.reversedCents <= 0) continue;

    let debitSumCents = 0;
    let priorCreditSumCents = 0;
    let newestDebitEntryId: string | undefined;
    const ownCreditKey = buildTransferReversalCreditIdempotencyKey(
      order.id,
      reversal.payeeId,
      refundKey,
    );
    for (const entry of entries) {
      if (entry.payeeId !== reversal.payeeId) continue;
      if (entry.type === "REFUND_DEBIT") {
        debitSumCents += entry.amountCents;
        // Entries are listed in insertion order; keep the last one seen as
        // the fallback pairing target.
        newestDebitEntryId = entry.id;
      } else if (entry.type === "TRANSFER_REVERSAL_CREDIT") {
        // Exclude THIS reversal's own prior credit so a replay recomputes
        // the identical amount and the repo's key-dedupe absorbs it.
        if (entry.idempotencyKey === ownCreditKey) continue;
        priorCreditSumCents += entry.amountCents;
      }
    }

    if (debitSumCents <= 0) {
      // Genuinely no debit anywhere for this payee — a credit would gift
      // them the reversed cents. Report; never mint.
      reportDrift(
        input,
        "reversal_without_debit",
        {
          orderId: order.id,
          payeeId: reversal.payeeId,
          refundKey,
          reversedCents: reversal.reversedCents,
          reversalIds: reversal.reversalIds,
        },
        "transferReversalCredit",
      );
      continue;
    }

    const headroomCents = Math.max(0, debitSumCents - priorCreditSumCents);
    const creditCents = Math.min(reversal.reversedCents, headroomCents);
    if (creditCents < reversal.reversedCents) {
      reportDrift(
        input,
        "reversal_exceeds_debit",
        {
          orderId: order.id,
          payeeId: reversal.payeeId,
          refundKey,
          reversedCents: reversal.reversedCents,
          debitSumCents,
          priorCreditSumCents,
          clampedToCents: creditCents,
          reversalIds: reversal.reversalIds,
        },
        "transferReversalCredit",
      );
    }
    if (creditCents <= 0) continue;

    // Pair to the caller's own debit when it wrote one; otherwise to the
    // newest REFUND_DEBIT row on the cell (the racing writer's — see the
    // doc block). `newestDebitEntryId` is defined here: debitSumCents > 0
    // implies at least one REFUND_DEBIT row was seen.
    const relatedEntryId =
      debitByPayee.get(reversal.payeeId)?.entryId ?? newestDebitEntryId!;

    const entry = await tx.payeeLedger.transferReversalCredit({
      idempotencyKey: ownCreditKey,
      payeeId: reversal.payeeId,
      amountCents: creditCents,
      currency: order.currency,
      orderId: order.id,
      relatedEntryId,
      description: `Transfer reversal — order ${formatOrderCode(order.id)}`,
      sourceKind: "transfer_reversal",
      sourceId: reversal.reversalIds[0] ?? relatedEntryId,
      metadata: {
        refundKey,
        reversalIds: reversal.reversalIds,
        stripeTransferIds: reversal.stripeTransferIds,
      },
    });

    results.push({
      payeeId: reversal.payeeId,
      creditCents,
      entryId: entry.id,
    });
  }

  return results;
}

// ── Internals ───────────────────────────────────────────────────────────────

/**
 * The SETTLEMENT_CREDIT's item-level attribution
 * (`metadata.items: { [orderItemId]: contributionCents }`) — the ONE source
 * of truth for "which payee-side cents does this order item represent".
 * Exported so `reverseTransfersForItems` derives ledger-era per-item reversal
 * amounts from the SAME attribution the debit side uses, rather than
 * inventing a second split.
 */
export function parseCreditItems(
  credit: PayeeLedgerEntryRecord,
): Record<string, number> {
  const metadata = credit.metadata;
  if (!metadata || typeof metadata !== "object") return {};
  const items = (metadata as { items?: unknown }).items;
  if (!items || typeof items !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(items as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

function reportDrift(
  input: {
    useCase: string;
    logger?: LoggerPort;
    reportError?: ReporterPort | null;
  },
  reason: string,
  extra: Record<string, unknown>,
  // Sentry grouping: reversal-phase drift is tagged with its own step so it
  // doesn't collapse into debit-step events (Step C review NIT).
  step: "refundDebit" | "transferReversalCredit" = "refundDebit",
): void {
  input.logger?.error(`refund_ledger_${reason}`, extra);
  try {
    input.reportError?.(new Error(`refund_ledger_${reason}`), {
      tags: { useCase: input.useCase, step, reason },
      extra,
    });
  } catch {
    // A throwing reporter never changes behaviour.
  }
}
