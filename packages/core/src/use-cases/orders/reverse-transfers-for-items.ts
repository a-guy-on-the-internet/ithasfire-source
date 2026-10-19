import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";
import type { TransferredPayoutItemForOrderItems } from "@th/ports/repos/payout-items";
import type { ReporterPort } from "@th/ports/reporter";

import { callOrDependencyFailed, describeError } from "../../lib/io";
import { parseCreditItems } from "./_shared/write-refund-debits";

export interface ReverseTransfersForItemsDeps {
  repos: Repos;
  payments: PaymentProcessorPort;
  logger?: LoggerPort;
  /**
   * Best-effort Sentry reporter for the anomaly arms: unresolved paid-out
   * items (no transfer found in EITHER era), ledger-resolved items with no
   * credit attribution, and junction rows whose settlement chain dead-ends.
   * In every case money left the platform and cannot be attributed/pulled
   * back — `logger.warn` alone is NOT Sentry-captured (CLAUDE.md
   * error-reporting convention), which is exactly how this went dark before.
   */
  reportError?: ReporterPort | null;
}

export interface ReverseTransfersForItemsInput {
  /** Order item IDs whose transfers need to be reversed. */
  orderItemIds: string[];
  /**
   * Per-item amount to reverse — PRE-CUTOVER (junction) resolution ONLY.
   * When provided, a legacy item's reversal uses this amount rather than the
   * full settlement-line amount (pinned pre-cutover behaviour).
   *
   * DELIBERATELY IGNORED for ledger-era resolution: callers fill this map
   * with BUYER-side cents (buyer paid − Stripe-fee share, tax included),
   * while a ledger-era transfer carried only the PAYEE-side net. Buyer-side
   * ≥ payee-side whenever any fee exists, so honouring it would request more
   * than the transfer holds — Stripe rejects and the whole refund aborts.
   * Ledger-era amounts always derive from the SETTLEMENT_CREDIT attribution
   * instead (see {@link loadCreditAttribution}).
   */
  itemAmounts?: Map<string, number>;
  /**
   * Optional provider idempotency prefix for reversal requests issued as part
   * of a larger refund operation.
   */
  idempotencyKeyPrefix?: string;
}

export interface TransferReversalResult {
  orderItemId: string;
  /**
   * Pre-cutover attribution: the Settlement whose transfer was reversed.
   * NULL for ledger-era reversals — post-cutover payouts write no Settlement
   * rows; `payoutItemId`/`payeeId` carry the attribution instead.
   */
  settlementId: string | null;
  /** Ledger-era attribution: the PayoutItem whose transfer was reversed. */
  payoutItemId?: string;
  /** Ledger-era payee attribution (read off the PayoutItem). */
  payeeId?: string;
  stripeTransferId: string;
  reversalId: string;
  reversedCents: number;
}

interface PlannedTransferReversal {
  settlementId: string | null;
  payoutItemId?: string;
  payeeId?: string;
  stripeTransferId: string;
  totalReversalCents: number;
  items: Array<{ orderItemId: string; reversalCents: number }>;
}

/**
 * Reverses Stripe Connect transfers for a set of order items that have
 * already been paid out.
 *
 * TWO ERAS, resolved ledger first:
 *
 *  1. LEDGER-ERA (post-2026-08-10 cutover): PayoutItem.plannedOrderItemIds →
 *     PayoutItem.stripeTransferId. Resolution is per (payoutItem, item) PAIR,
 *     not per item: `attributeCreditToItems` distributes EVERY payee's credit
 *     across ALL of an order's ticket items, so on a multi-payee order
 *     (booking splits) every payee's plan contains the SAME item ids — the
 *     overlap is structural, and each payee's transfer must be reversed for
 *     THAT payee's attributed share of the refunded items.
 *  2. PRE-CUTOVER (frozen history): OrderItem → OrderItemSettlementLine →
 *     SettlementLine → Settlement.stripeTransferId, amounts itemAmounts-first
 *     — byte-identical to the pinned pre-cutover behaviour.
 *
 * An item resolving through NEITHER era is an invariant breach (it reached
 * here because `paidOutAt` is stamped): reported via `reportError`, and the
 * refund proceeds without a reversal — the REFUND_DEBIT the caller writes
 * stands as debt.
 *
 * Each unique transfer is reversed at most once per call, amounts summed.
 * Ledger-era totals are CAPPED at the PayoutItem's `netAmountCents` — only
 * the net actually moved; withheld cents (reserve, Connect fee) never left
 * the platform and must not be requested from Stripe. The capped residual
 * simply stays as ledger debt (the caller's TRANSFER_REVERSAL_CREDIT is
 * written from ACTUAL reversal results and clamped to the debit).
 *
 * The net cap alone is PER-CALL: it knows what THIS call may request but not
 * what earlier refunds already reversed on the same transfer (Stripe rejects
 * on the CUMULATIVE total). So the ledger-era arm additionally pre-flights
 * each transfer with ONE `payments.getTransfer` read. When the plan exceeds
 * the remaining capacity (`amount − amount_reversed`), RECOVERY comes first:
 * the transfer's reversals are listed and matched against this call's item
 * set via the `orderItemIds` metadata every reversal stamps — a match means
 * OUR OWN earlier attempt already reversed the money and the local work
 * failed before consuming the result (Stripe-idempotent retry), so the
 * results are reconstructed from the prior reversal and NO new request is
 * issued. Only when no prior reversal of ours exists does the shortfall
 * resolve as capacity genuinely consumed by others: partial remaining →
 * clamp the request; zero remaining → skip the Stripe call entirely
 * (reported — the debit stands as debt, which is the correct outcome). This
 * makes the common sequential case (two refunds on one withheld transfer,
 * weeks apart) succeed AND keeps crash-retry recovery intact. The reads are
 * advisory: a concurrent reversal by ANOTHER order sharing the transfer
 * (the `refund-op:` mutex only serializes per-order) can still land between
 * read and write, and that residual race deliberately stays loud —
 * `reverseTransfer`'s rejection surfaces through `callOrDependencyFailed`
 * into the caller's existing failure arm. No retries here.
 *
 * ASYMMETRY: the PRE-CUTOVER junction arm gets NO capacity pre-flight — its
 * pinned behaviour predates the cutover, pre-cutover transfers are
 * settlement aggregates where sequential partial reversals were rare, and
 * the era-parity tests pin it byte-identical.
 */
export async function reverseTransfersForItems(
  deps: ReverseTransfersForItemsDeps,
  input: ReverseTransfersForItemsInput,
): Promise<TransferReversalResult[]> {
  const logger = deps.logger?.child({ fn: "reverseTransfersForItems" });

  if (input.orderItemIds.length === 0) return [];

  // Keyed by stripeTransferId; the two eras can never collide on one — a
  // transfer id belongs to either a Settlement or a PayoutItem, never both
  // (`PayoutItem.stripeTransferId` is unique, and pre-cutover transfers
  // predate every PayoutItem plan).
  const transferReversals = new Map<string, PlannedTransferReversal>();

  // ── ERA 1 (tried FIRST): ledger-era payouts via the durable plan ─────────
  const payoutItems =
    await deps.repos.payoutItems.listTransferredByPlannedOrderItemIds(
      input.orderItemIds,
    );

  const inputIdSet = new Set(input.orderItemIds);
  const ledgerCoveredItemIds = new Set<string>();
  const ledgerPairs: Array<{
    payoutItem: TransferredPayoutItemForOrderItems;
    itemIds: string[];
  }> = [];
  for (const payoutItem of payoutItems) {
    const covered = payoutItem.plannedOrderItemIds.filter((itemId) =>
      inputIdSet.has(itemId),
    );
    if (covered.length === 0) continue;
    ledgerPairs.push({ payoutItem, itemIds: covered });
    for (const itemId of covered) ledgerCoveredItemIds.add(itemId);
  }

  if (ledgerPairs.length > 0) {
    // PAYEE-side per-item amounts, from the SETTLEMENT_CREDIT attribution —
    // the same source of truth the REFUND_DEBIT is computed from, so a full
    // clawback nets the debit to zero to the cent. `input.itemAmounts` is
    // deliberately not consulted here (buyer-side; see the input doc).
    //
    // WHOLE-ITEM refunds are the only shape: every caller marks entire order
    // items refunded (refund-full-order.ts:372, refund-order-items.ts:291,
    // cancel-event.ts:253) and the debit side sums FULL per-item attributions
    // (write-refund-debits.ts partial math) — no partial-item path exists.
    // If one is ever added, this derivation must scale the attribution
    // proportionally to the partial fraction.
    const attributionByPayee = await loadCreditAttribution(
      deps,
      ledgerCoveredItemIds,
    );

    for (const { payoutItem, itemIds } of ledgerPairs) {
      const payeeAttribution = attributionByPayee.get(payoutItem.payeeId);
      let items: Array<{ orderItemId: string; reversalCents: number }> = [];
      let totalReversalCents = 0;

      for (const itemId of itemIds) {
        const attributedCents = payeeAttribution?.get(itemId) ?? 0;
        if (attributedCents <= 0) {
          // The plan says this payee's payout covered the item, but the
          // credit attribution has no cents for it — anomalous (plan ids are
          // the credit metadata's keys at mint time). Report and skip rather
          // than guess an amount.
          logger?.warn("reverse_transfers_no_amount_for_ledger_item", {
            orderItemId: itemId,
            payoutItemId: payoutItem.payoutItemId,
            payeeId: payoutItem.payeeId,
          });
          reportReversalAnomaly(
            deps,
            "reverse_transfers_no_amount_for_ledger_item",
            {
              orderItemId: itemId,
              payoutItemId: payoutItem.payoutItemId,
              payeeId: payoutItem.payeeId,
            },
          );
          continue;
        }
        items.push({ orderItemId: itemId, reversalCents: attributedCents });
        totalReversalCents += attributedCents;
      }

      if (items.length === 0) continue;

      // CAP at what actually moved: the transfer sent `netAmountCents`
      // (post-withholding), so a payee share exceeding it cannot come back
      // via THIS transfer. Requesting more would make Stripe reject and
      // abort the buyer's refund. The residual stands as ledger debt.
      //
      // Remainder policy: sequential in plan order — earlier items keep
      // their full shares until the net is exhausted. The per-payee credit
      // is unaffected by the split (results are summed per payee), so the
      // policy only shapes per-item audit granularity; it just has to be
      // deterministic.
      const netCap = Math.max(0, payoutItem.netAmountCents);
      if (totalReversalCents > netCap) {
        logger?.info("reverse_transfers_capped_at_net", {
          payoutItemId: payoutItem.payoutItemId,
          stripeTransferId: payoutItem.stripeTransferId,
          attributedCents: totalReversalCents,
          netAmountCents: payoutItem.netAmountCents,
        });
        let remaining = netCap;
        const capped: typeof items = [];
        for (const item of items) {
          const take = Math.min(item.reversalCents, remaining);
          if (take > 0) {
            capped.push({ orderItemId: item.orderItemId, reversalCents: take });
          }
          remaining -= take;
        }
        items = capped;
        totalReversalCents = netCap;
      }

      if (totalReversalCents <= 0 || items.length === 0) continue;

      const existing = transferReversals.get(payoutItem.stripeTransferId);
      if (existing) {
        // Unreachable in practice (one PayoutItem per transfer id); merge
        // defensively rather than clobber.
        existing.totalReversalCents += totalReversalCents;
        existing.items.push(...items);
      } else {
        transferReversals.set(payoutItem.stripeTransferId, {
          settlementId: null,
          payoutItemId: payoutItem.payoutItemId,
          payeeId: payoutItem.payeeId,
          stripeTransferId: payoutItem.stripeTransferId,
          totalReversalCents,
          items,
        });
      }
    }
  }

  // ── ERA 2 (fallback): pre-cutover payouts via the frozen junction ────────
  const remainingItemIds = input.orderItemIds.filter(
    (itemId) => !ledgerCoveredItemIds.has(itemId),
  );

  const itemSettlementLines =
    remainingItemIds.length > 0
      ? await deps.repos.orderItemSettlementLines.listByOrderItemIds(
          remainingItemIds,
        )
      : [];

  // ── Miss arm: items resolved by NEITHER era ──────────────────────────────
  const junctionResolved = new Set(
    itemSettlementLines.map((isl) => isl.orderItemId),
  );
  const unresolvedItemIds = remainingItemIds.filter(
    (itemId) => !junctionResolved.has(itemId),
  );
  if (unresolvedItemIds.length > 0) {
    // Callers only pass items with `paidOutAt` stamped, so "no transfer
    // found anywhere" means the platform is about to front a refund it
    // cannot pull back. The refund still proceeds (debt-carry) but the miss
    // must be VISIBLE: warn is kept for log continuity, reportError is what
    // actually reaches Sentry.
    logger?.warn("reverse_transfers_no_settlement_lines", {
      orderItemIds: unresolvedItemIds,
    });
    reportReversalAnomaly(deps, "reverse_transfers_unresolved_paid_out_items", {
      orderItemIds: unresolvedItemIds,
    });
  }

  if (itemSettlementLines.length > 0) {
    // Bulk-fetch all settlement lines and settlements in two queries
    const settlementLineIds = [
      ...new Set(itemSettlementLines.map((isl) => isl.settlementLineId)),
    ];
    const allSettlementLines =
      await deps.repos.settlementLines.getByIds(settlementLineIds);
    const settlementLineMap = new Map(
      allSettlementLines.map((sl) => [sl.id, sl]),
    );

    const settlementIds = [
      ...new Set(allSettlementLines.map((sl) => sl.settlementId)),
    ];
    const allSettlements = await deps.repos.settlements.getByIds(settlementIds);
    const settlementMap = new Map(allSettlements.map((s) => [s.id, s]));

    for (const isl of itemSettlementLines) {
      // Traverse: OrderItemSettlementLine → SettlementLine → Settlement.
      // Each dead-end below is a junction row whose chain is broken: the
      // item WAS paid out but the transfer cannot be found — same money
      // direction as the miss arm, so each is reported, not just warned.
      const settlementLine = settlementLineMap.get(isl.settlementLineId);
      if (!settlementLine) {
        logger?.warn("reverse_transfers_settlement_line_not_found", {
          settlementLineId: isl.settlementLineId,
          orderItemId: isl.orderItemId,
        });
        reportReversalAnomaly(
          deps,
          "reverse_transfers_settlement_line_not_found",
          {
            settlementLineId: isl.settlementLineId,
            orderItemId: isl.orderItemId,
          },
        );
        continue;
      }

      const settlement = settlementMap.get(settlementLine.settlementId);
      if (!settlement) {
        logger?.warn("reverse_transfers_settlement_not_found", {
          settlementId: settlementLine.settlementId,
          orderItemId: isl.orderItemId,
        });
        reportReversalAnomaly(deps, "reverse_transfers_settlement_not_found", {
          settlementId: settlementLine.settlementId,
          orderItemId: isl.orderItemId,
        });
        continue;
      }

      if (!settlement.stripeTransferId) {
        logger?.warn("reverse_transfers_no_stripe_transfer_id", {
          settlementId: settlement.id,
          orderItemId: isl.orderItemId,
        });
        reportReversalAnomaly(deps, "reverse_transfers_no_stripe_transfer_id", {
          settlementId: settlement.id,
          orderItemId: isl.orderItemId,
        });
        continue;
      }

      // Determine reversal amount for this item — itemAmounts-first, the
      // pinned pre-cutover behaviour (legacy transfers carried the full
      // buyer-side settlement-line amounts, so the override is valid here).
      const reversalCents =
        input.itemAmounts?.get(isl.orderItemId) ?? isl.amountCents;

      const existing = transferReversals.get(settlement.stripeTransferId);
      if (existing) {
        existing.totalReversalCents += reversalCents;
        existing.items.push({ orderItemId: isl.orderItemId, reversalCents });
      } else {
        transferReversals.set(settlement.stripeTransferId, {
          settlementId: settlement.id,
          stripeTransferId: settlement.stripeTransferId,
          totalReversalCents: reversalCents,
          items: [{ orderItemId: isl.orderItemId, reversalCents }],
        });
      }
    }
  }

  // ── Execute reversals (one Stripe API call per unique transfer) ──────────
  const results: TransferReversalResult[] = [];

  for (const [stripeTransferId, info] of transferReversals) {
    if (info.totalReversalCents <= 0) continue;

    // The amounts actually EXECUTED for this transfer. They start at the
    // per-call plan and may be clamped below by the remaining-capacity
    // pre-flight. INVARIANT: Σ items.reversalCents === totalReversalCents ===
    // the amount requested from Stripe — write-refund-debits sizes each
    // payee's TRANSFER_REVERSAL_CREDIT by summing the per-item
    // `reversedCents` off the results, so any drift here miscredits the
    // ledger against the money that actually came back.
    let executeItems = info.items;
    let executeTotalCents = info.totalReversalCents;

    // ── LEDGER-ERA ONLY: pre-flight Stripe's actual remaining capacity ────
    // ONE read per unique transfer per call (this loop iterates unique
    // transfer ids). The junction (legacy) arm deliberately skips the read —
    // see the function doc's ASYMMETRY note.
    if (info.payoutItemId !== undefined) {
      let remainingCents: number | null = null;
      try {
        const transfer = await deps.payments.getTransfer({
          transferId: stripeTransferId,
        });
        remainingCents = Math.max(
          0,
          transfer.amountCents - transfer.amountReversedCents,
        );
      } catch (error) {
        // Deliberate swallow: the read is an advisory pre-flight. Falling
        // back to the un-pre-flighted request preserves pre-read behaviour —
        // if the transfer really lacks capacity, `reverseTransfer` below
        // still rejects loudly — so a transient read failure must not abort
        // a refund that would have succeeded. reportError (not just warn)
        // per the swallow convention.
        logger?.warn("reverse_transfers_capacity_read_failed", {
          stripeTransferId,
          payoutItemId: info.payoutItemId,
          error: describeError(error),
        });
        reportReversalAnomaly(deps, "reverse_transfers_capacity_read_failed", {
          stripeTransferId,
          payoutItemId: info.payoutItemId,
          error: describeError(error),
        });
      }

      if (remainingCents !== null && executeTotalCents > remainingCents) {
        // The request as planned cannot be issued verbatim. Two causes with
        // OPPOSITE correct responses:
        //
        //  (a) RETRY: OUR OWN earlier attempt already reversed at Stripe but
        //      the local work failed before the results were consumed. The
        //      retry recomputes the same plan; the pre-flight now counts the
        //      prior reversal against capacity. Re-requesting a recomputed
        //      SMALLER amount under the SAME stable idempotency key
        //      (`${prefix}:${transferId}`) is a Stripe idempotency error
        //      (same key, different params), and skipping on zero remaining
        //      silently turns money the payee ALREADY returned into ledger
        //      debt (debit written, no reversal credit) — recouped a second
        //      time from future payouts.
        //  (b) OTHER refund operations genuinely consumed the capacity.
        //
        // Disambiguate by listing the transfer's reversals and matching OURS
        // via the `orderItemIds` metadata every reversal request stamps.
        // THROW-THROUGH (not swallow) on a failed list: without it recovery
        // and clamping are indistinguishable, and guessing risks double-debt
        // (skip) or idempotency_error (clamped re-request). Loud + retryable
        // is the only safe failure here.
        const priorReversals = await callOrDependencyFailed(
          () =>
            deps.payments.listTransferReversals({
              transferId: stripeTransferId,
            }),
          logger,
          {
            action: "list_transfer_reversals",
            stripeTransferId,
            payoutItemId: info.payoutItemId,
          },
        );

        const currentOpKey = input.idempotencyKeyPrefix ?? "";
        const requestedItemIds = new Set(
          info.items.map((i) => i.orderItemId),
        );
        const overlapping = priorReversals
          .map((reversal) => ({
            reversal,
            itemIds: (reversal.metadata?.orderItemIds ?? "")
              .split(",")
              .filter(Boolean),
          }))
          .filter(({ itemIds }) =>
            itemIds.some((id) => requestedItemIds.has(id)),
          );
        // Item overlap alone is NOT ownership: a different operation (e.g. a
        // staff refund of one shared item) may have reversed on this transfer
        // and crashed pre-commit, leaving its items refundable to THIS
        // operation. Reconstructing that foreign reversal would silently drop
        // this operation's own reversible cents. Classify:
        const isOwn = ({ reversal, itemIds }: (typeof overlapping)[number]) => {
          const opKey = reversal.metadata?.opKey;
          if (opKey !== undefined) {
            // Post-deploy reversal: operation identity is explicit. Only an
            // earlier attempt of THIS operation may be reconstructed — its
            // Stripe key is burned. A different operation's reversal is
            // capacity consumption; THIS operation never called Stripe on
            // this transfer, so its own `${prefix}:${transferId}` key is
            // fresh for a clamped request below.
            return opKey === currentOpKey;
          }
          // DEPLOY-BOUNDARY HEURISTIC (expires naturally — every reversal
          // issued after opKey stamping shipped carries it): with no
          // operation identity recorded, treat the reversal as ours only in
          // the pure-retry shape: this call's item set covers ALL of the
          // reversal's items (a retry re-derives at least the same items,
          // and reaching this branch already implies remaining < requested).
          // A reversal spanning items this call does NOT include can only be
          // another operation's → foreign.
          return itemIds.every((id) => requestedItemIds.has(id));
        };
        const priorOwnReversals = overlapping
          .filter(isOwn)
          .map(({ reversal }) => reversal);
        const foreignCoveredItemIds = new Set(
          overlapping
            .filter((entry) => !isOwn(entry))
            .flatMap(({ itemIds }) => itemIds),
        );

        if (priorOwnReversals.length > 0) {
          // RECOVERY: the money already came back on a previous attempt —
          // reconstruct the results from the prior reversal(s) and issue
          // NOTHING. Our reversal metadata carries no per-item amounts, so
          // the per-item split is RE-DERIVED from the same attribution-built
          // plan that produced the original request, sequentially clamped to
          // the recovered amount: a true retry re-derives the identical plan
          // in the identical order, so Σ reversedCents equals the recovered
          // reversal amount exactly — the cents that actually moved back.
          // (Defensively, if a prior reversal covered MORE than this call's
          // items — not a pure retry — only this call's plan total is
          // attributed; over-attributing would corrupt the reversal credit.)
          const recoveredCents = priorOwnReversals.reduce(
            (sum, r) => sum + r.amountCents,
            0,
          );
          const recovered = clampItemsSequentially(info.items, recoveredCents);
          logger?.warn("reverse_transfers_recovered_prior_reversal", {
            stripeTransferId,
            payoutItemId: info.payoutItemId,
            recoveredCents,
            reversalIds: priorOwnReversals.map((r) => r.reversalId),
            plannedCents: info.totalReversalCents,
          });
          reportReversalAnomaly(
            deps,
            "reverse_transfers_recovered_prior_reversal",
            {
              stripeTransferId,
              payoutItemId: info.payoutItemId,
              recoveredCents,
              reversalIds: priorOwnReversals.map((r) => r.reversalId),
              plannedCents: info.totalReversalCents,
            },
          );
          for (const item of recovered.items) {
            results.push({
              orderItemId: item.orderItemId,
              settlementId: info.settlementId,
              ...(info.payoutItemId !== undefined
                ? { payoutItemId: info.payoutItemId }
                : {}),
              ...(info.payeeId !== undefined ? { payeeId: info.payeeId } : {}),
              stripeTransferId,
              reversalId: priorOwnReversals[0]!.reversalId,
              reversedCents: item.reversalCents,
            });
          }
          continue;
        }

        if (remainingCents <= 0) {
          // Someone ELSE's refunds already reversed the whole transfer —
          // nothing can come back via Stripe. Skip the call (it would reject
          // and abort the buyer's refund); the caller's REFUND_DEBIT stands
          // as ledger debt, which is the correct outcome. Distinct signal
          // from the partial-cap arm below.
          logger?.warn("reverse_transfers_transfer_fully_reversed", {
            stripeTransferId,
            payoutItemId: info.payoutItemId,
            requestedCents: executeTotalCents,
          });
          reportReversalAnomaly(
            deps,
            "reverse_transfers_transfer_fully_reversed",
            {
              stripeTransferId,
              payoutItemId: info.payoutItemId,
              requestedCents: executeTotalCents,
            },
          );
          continue;
        }

        // Sequential refunds on one transfer (no prior reversal of OURS):
        // cap at what Stripe can still return. The shortfall stays as ledger
        // debt via the debit/credit asymmetry. Same sequential in-plan-order
        // remainder policy as the net cap above, so Σ reversedCents still
        // equals the executed total exactly. Idempotency-key safety: the key
        // is `${prefix}:${transferId}` and the prefix derives from the
        // refund OPERATION, so a different operation clamping on the same
        // transfer never collides with an earlier operation's key.
        logger?.info("reverse_transfers_capped_at_stripe_remaining", {
          stripeTransferId,
          payoutItemId: info.payoutItemId,
          requestedCents: executeTotalCents,
          remainingCents,
        });
        // Split policy under a FOREIGN overlap: the foreign reversal already
        // returned the cents of the items IT covered, so this operation's
        // fresh clamped reversal is attributed to the UNcovered items first
        // (plan order within each group). Per-payee sums — what the reversal
        // credit is written from — are unaffected; this only keeps the
        // per-item audit trail truthful.
        const orderedItems =
          foreignCoveredItemIds.size > 0
            ? [
                ...executeItems.filter(
                  (i) => !foreignCoveredItemIds.has(i.orderItemId),
                ),
                ...executeItems.filter((i) =>
                  foreignCoveredItemIds.has(i.orderItemId),
                ),
              ]
            : executeItems;
        const capped = clampItemsSequentially(orderedItems, remainingCents);
        executeItems = capped.items;
        executeTotalCents = capped.totalCents;
      }
    }

    logger?.info("reverse_transfers_executing", {
      stripeTransferId,
      settlementId: info.settlementId,
      payoutItemId: info.payoutItemId,
      totalReversalCents: executeTotalCents,
      itemCount: executeItems.length,
    });

    const { reversalId } = await callOrDependencyFailed(
      () =>
        deps.payments.reverseTransfer({
          transferId: stripeTransferId,
          amountCents: executeTotalCents,
          idempotencyKey: input.idempotencyKeyPrefix
            ? `${input.idempotencyKeyPrefix}:${stripeTransferId}`
            : undefined,
          metadata: {
            ...(info.settlementId !== null
              ? { settlementId: info.settlementId }
              : {}),
            ...(info.payoutItemId !== undefined
              ? { payoutItemId: info.payoutItemId }
              : {}),
            // Operation identity for retry recovery (LEDGER ARM ONLY — the
            // legacy junction request stays byte-identical): item ids alone
            // say WHAT was reversed, not WHICH refund operation did it, and
            // recovery must distinguish "this op's earlier attempt"
            // (reconstruct, no new call) from "another op's reversal that
            // happens to cover shared items" (mere capacity consumption).
            // Stamped even when the prefix is absent ("") so every
            // post-deploy reversal is classifiable.
            ...(info.payoutItemId !== undefined
              ? { opKey: input.idempotencyKeyPrefix ?? "" }
              : {}),
            orderItemIds: executeItems.map((i) => i.orderItemId).join(","),
            reason: "refund",
          },
        }),
      logger,
      {
        action: "reverse_transfer",
        stripeTransferId,
        settlementId: info.settlementId,
        payoutItemId: info.payoutItemId,
        amountCents: executeTotalCents,
      },
    );

    logger?.info("reverse_transfers_completed", {
      stripeTransferId,
      reversalId,
      reversedCents: executeTotalCents,
    });

    for (const item of executeItems) {
      results.push({
        orderItemId: item.orderItemId,
        settlementId: info.settlementId,
        ...(info.payoutItemId !== undefined
          ? { payoutItemId: info.payoutItemId }
          : {}),
        ...(info.payeeId !== undefined ? { payeeId: info.payeeId } : {}),
        stripeTransferId,
        reversalId,
        reversedCents: item.reversalCents,
      });
    }
  }

  return results;
}

/**
 * PAYEE-side per-item attribution for the ledger era:
 * order item → order → SETTLEMENT_CREDIT entries → `metadata.items` (via
 * {@link parseCreditItems} — the SAME parser the debit side uses), grouped by
 * payee. Returns `Map<payeeId, Map<orderItemId, cents>>`, restricted to the
 * requested items. Summed defensively across credits, mirroring
 * `writeRefundDebitsForOrder` — by key construction there is at most one
 * SETTLEMENT_CREDIT per (order, payee).
 */
async function loadCreditAttribution(
  deps: ReverseTransfersForItemsDeps,
  itemIds: ReadonlySet<string>,
): Promise<Map<string, Map<string, number>>> {
  const orderIds = new Set<string>();
  for (const itemId of itemIds) {
    const orderItem = await deps.repos.orderItems.getById(itemId);
    if (orderItem) orderIds.add(orderItem.orderId);
  }

  const byPayee = new Map<string, Map<string, number>>();
  for (const orderId of orderIds) {
    const entries = await deps.repos.payeeLedger.listOrderEntries(orderId);
    for (const entry of entries) {
      if (entry.type !== "SETTLEMENT_CREDIT") continue;
      const items = parseCreditItems(entry);
      for (const [itemId, cents] of Object.entries(items)) {
        if (!itemIds.has(itemId)) continue;
        let payeeItems = byPayee.get(entry.payeeId);
        if (!payeeItems) {
          payeeItems = new Map<string, number>();
          byPayee.set(entry.payeeId, payeeItems);
        }
        payeeItems.set(itemId, (payeeItems.get(itemId) ?? 0) + cents);
      }
    }
  }

  return byPayee;
}

/**
 * Sequential in-plan-order clamp: earlier items keep their full shares until
 * `capCents` is exhausted. Returns the ACTUAL sum of the clamped items (=
 * `min(capCents, Σ items)`), which is what must be requested from — or was
 * recovered at — Stripe so that Σ per-item `reversedCents` always equals the
 * executed/recovered reversal amount.
 */
function clampItemsSequentially(
  items: Array<{ orderItemId: string; reversalCents: number }>,
  capCents: number,
): {
  items: Array<{ orderItemId: string; reversalCents: number }>;
  totalCents: number;
} {
  let remaining = capCents;
  const clamped: Array<{ orderItemId: string; reversalCents: number }> = [];
  for (const item of items) {
    const take = Math.min(item.reversalCents, remaining);
    if (take > 0) {
      clamped.push({ orderItemId: item.orderItemId, reversalCents: take });
    }
    remaining -= take;
  }
  return {
    items: clamped,
    totalCents: clamped.reduce((sum, i) => sum + i.reversalCents, 0),
  };
}

function reportReversalAnomaly(
  deps: ReverseTransfersForItemsDeps,
  message: string,
  extra: Record<string, unknown>,
): void {
  try {
    deps.reportError?.(new Error(message), {
      tags: { useCase: "reverseTransfersForItems" },
      extra,
    });
  } catch {
    // A throwing reporter never changes behaviour.
  }
}
