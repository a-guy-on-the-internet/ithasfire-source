import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import type { CartReapQuarantine } from "../orders/_shared/cart-reap-quarantine";
import { refundCashOrdersForCancelledEvent } from "./_shared/refund-cash-orders-for-cancelled-event";
import { voidPendingPosOrdersForCancelledEvent } from "./_shared/void-pending-pos-orders-for-cancelled-event";

export const settleDoorOrdersOnCancelledEventsInputSchema = z
  .object({
    /** Max cancelled events settled per run. */
    limit: z.number().int().min(1).max(500).default(50),
  })
  .strict();

export const settleDoorOrdersOnCancelledEventsOutputSchema = z
  .object({
    /** Cancelled events found still carrying open door orders. */
    eventCount: z.number().int().nonnegative(),
    refundedCashOrderCount: z.number().int().nonnegative(),
    failedCashRefundCount: z.number().int().nonnegative(),
    voidedPendingPosOrderCount: z.number().int().nonnegative(),
    /** Voids that may clear on their own: the job fails the run on these. */
    failedPendingPosVoidCount: z.number().int().nonnegative(),
    /**
     * Door card sales kept this run (PaymentIntent paid, or no processor):
     * reported once, then quarantined. Not a run failure.
     */
    keptPendingPosOrderCount: z.number().int().nonnegative(),
    /** Door card sales skipped because the quarantine holds them. */
    quarantinedPendingPosOrderCount: z.number().int().nonnegative(),
    /** An event whose own scan failed: its counts describe nothing. */
    scanFailedEventCount: z.number().int().nonnegative(),
  })
  .strict();

export type SettleDoorOrdersOnCancelledEventsOutput = z.infer<
  typeof settleDoorOrdersOnCancelledEventsOutputSchema
>;

export type SettleDoorOrdersOnCancelledEventsDeps = {
  repos: Pick<Repos, "tx" | "orders">;
  payments?: Pick<
    PaymentProcessorPort,
    "cancelPaymentIntent" | "retrievePaymentIntent"
  > | null;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Every per-order failure is reported here by the two phases. */
  reportError?: ReporterPort | null;
  /**
   * REQUIRED: the sweep's memory of door card sales it had to keep. Without
   * it a paid-but-unfinalised sale on a cancelled event is re-probed and
   * re-reported every run, forever. One instance per process, owned by the
   * composition root (the cart reaper's quarantine, a separate instance).
   */
  quarantine: CartReapQuarantine;
};

/**
 * THE DOOR SWEEP: finishes what an event cancellation leaves undone at the
 * door. `cancelEvent` settles door orders AFTER its commit (refund the cash
 * sales and reverse their debits, void the PENDING card sales), and nothing
 * re-runs that step: a same-key retry is refused while the claim stands and
 * every later one gets EVENT_ALREADY_CANCELLED. A crash, a timeout or a
 * failed order there would otherwise leave the organiser paying tax (fee +
 * tax on a sale before 2026-10-08) on
 * cash they handed back, with the payout batch netting it off (code review
 * 2026-10-07, [BLOCKING]).
 *
 * So this finds every CANCELLED event that still has a cash sale with an
 * unreversed CASH_SALE_DEBIT or a PENDING card sale
 * (`orders.listCancelledEventIdsWithOpenDoorOrders`) and runs the
 * cancellation's own two phases on it — the same code, so the outcome is the
 * one the cancellation would have reached. Both are idempotent: the cash
 * refund claims each order with a compare-and-set and the ledger reverses a
 * debit once; the void cancels PENDING → CANCELLED only. Running alongside a
 * cancellation that is still mid-phase is safe.
 *
 * ── It never rewrites history ───────────────────────────────────────────────
 * The sweep's cash half touches only orders carrying an unreversed debit
 * (code review 2026-10-07). Events have no cancellation timestamp, and
 * `Event.updatedAt` moves on any edit, so the debit is the cutover marker:
 * every cash sale since the door was priced that owes fee or tax writes
 * one, and none before did. An event cancelled before this change — even one with cash
 * taken after its cancellation, where nothing was handed back — is never
 * listed for its old cash orders, and they stay exactly as they were.
 *
 * The cost: a sale that owes nothing writes no debit — a comp, or a
 * fee-waived sale at 0% tax. One sold on an event whose live
 * cancellation crashed before its cash phase stays SUCCEEDED. No money is
 * owed either way, and a cancelled event cannot be opened in the scanner, so
 * its ticket admits nobody. One known loss: a fee-waived sale left this way
 * keeps its fee-waiver unit (the refund is what releases it). The live
 * cancellation (`cancelEvent`, scope `"all"`) still refunds every such sale
 * when it runs to completion.
 *
 * ── Door card sales it cannot void ──────────────────────────────────────────
 * A PENDING sale whose PaymentIntent is already paid is KEPT, reported once
 * and quarantined, so the job neither re-reports it every 30 minutes nor
 * fails every run over it (that drowned real reaper failures). The durable
 * signal is the daily verify-ledger invariant
 * `cancelled_event_open_door_card_sale`. The quarantine's ids are also kept
 * out of the event scan, so a stuck sale cannot hold a slot at its head.
 *
 * Never throws for an ORDER: each failure is reported by its phase and
 * counted. The caller (the cart reaper's job) decides how loudly to fail on
 * the counts. A throw here is operational (the scan itself) and propagates.
 */
export async function settleDoorOrdersOnCancelledEvents(
  deps: SettleDoorOrdersOnCancelledEventsDeps,
  rawInput: unknown,
): Promise<SettleDoorOrdersOnCancelledEventsOutput> {
  const input = parseInput(settleDoorOrdersOnCancelledEventsInputSchema, rawInput);

  const eventIds = await deps.repos.orders.listCancelledEventIdsWithOpenDoorOrders(
    {
      limit: input.limit,
      excludeOrderIds: deps.quarantine.active(deps.clock.now()),
    },
  );

  const out: SettleDoorOrdersOnCancelledEventsOutput = {
    eventCount: eventIds.length,
    refundedCashOrderCount: 0,
    failedCashRefundCount: 0,
    voidedPendingPosOrderCount: 0,
    failedPendingPosVoidCount: 0,
    keptPendingPosOrderCount: 0,
    quarantinedPendingPosOrderCount: 0,
    scanFailedEventCount: 0,
  };

  for (const eventId of eventIds) {
    const cash = await refundCashOrdersForCancelledEvent(
      { repos: deps.repos, logger: deps.logger, reportError: deps.reportError },
      {
        eventId,
        actorHumanId: null,
        now: deps.clock.now(),
        // Never the old cancellations: see "It never rewrites history".
        scope: "unreversed_debit",
      },
    );
    const pos = await voidPendingPosOrdersForCancelledEvent(
      {
        repos: deps.repos,
        payments: deps.payments,
        clock: deps.clock,
        logger: deps.logger,
        reportError: deps.reportError,
        quarantine: deps.quarantine,
      },
      { eventId },
    );
    out.refundedCashOrderCount += cash.refundedCount;
    out.failedCashRefundCount += cash.failedCount;
    out.voidedPendingPosOrderCount += pos.voidedCount;
    out.failedPendingPosVoidCount += pos.failedCount;
    out.keptPendingPosOrderCount += pos.keptCount;
    out.quarantinedPendingPosOrderCount += pos.quarantinedCount;
    if (cash.scanFailed || pos.scanFailed) out.scanFailedEventCount++;
  }

  if (eventIds.length > 0) {
    deps.logger?.info("door_sweep.cancelled_events_settled", { ...out });
  }

  return settleDoorOrdersOnCancelledEventsOutputSchema.parse(out);
}
