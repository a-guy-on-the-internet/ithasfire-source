import { randomUUID } from "node:crypto";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { EventRecord } from "@th/ports/repos/events";
import type { DisputeRecord, DisputeStatus } from "@th/ports/repos/disputes";
import type { OrderRecord } from "@th/ports/repos/orders";
import type { PayeeLedgerEntryRecord } from "@th/ports/repos/payee-ledger";
import type { PayeeSubjectType } from "@th/ports/repos/payees";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";

import { asKnownError } from "../../lib/errors";
import { parseInput } from "../../lib/io";
import { abandonClaim } from "../../lib/idempotency-claim";
import {
  DISPUTE_FEE_DEBIT_KEY_PREFIX,
  DISPUTE_FEE_REVERSAL_KEY_PREFIX,
  DISPUTE_PRINCIPAL_DEBIT_KEY_PREFIX,
  retainedCreditByPayee,
} from "../orders/_shared/write-refund-debits";
import { isBlockedSettlementDisputeStatus } from "../settlements/dispute-statuses";
import { fail } from "@th/errors";
import { formatOrderCode } from "@th/types/order-identifier";
import {
  notifyDisputeLifecycle,
  type DisputeLifecycleCommunicationsDeps,
  type DisputeLifecycleNotificationContext,
} from "./notify-dispute-lifecycle";
import {
  disputeLifecycleOutputSchema,
  stripeDisputeLifecycleInputSchema,
  type DisputeLifecycleOutput,
  type StripeDisputeLifecycleInput,
} from "./schemas";

/**
 * The ledger description's subject: the order's short code when the debit
 * has an order, otherwise the dispute's last 8 hex chars. (`formatOrderCode`
 * is a plain tail-uppercase, so it shortens a dispute id the same way.)
 */
function disputeDebitSubject(orderId: string | null, disputeId: string): string {
  return orderId
    ? `order ${formatOrderCode(orderId)}`
    : `dispute ${formatOrderCode(disputeId)}`;
}

const IDEMPOTENCY_TTL_SECONDS = 300;
const IDEMPOTENCY_KEEP_SECONDS = 86_400;
const TERMINAL_DISPUTE_STATUSES = new Set<DisputeStatus>([
  "WON",
  "LOST",
  "WARNING_CLOSED",
]);
const SETTLEMENT_TRANSFER_IN_FLIGHT_TRIAGE_REASON =
  "settlement_transfer_in_flight";
// Phase label stamped on the settlement-transfer boundary marker (audit row,
// dispute metadata, warn log). It used to read `manual_clawback_phase_4` — a
// promise that ops would claw the money back by hand, on an ops surface that
// never existed. Recovery is automatic now: a LOST close writes a
// DISPUTE_DEBIT per payee whether or not the transfer already went out, the
// payee's payable goes negative, and the payout batch nets it out of the next
// transfer (run-batch.ts: "a NEGATIVE payable is a debt position — pay
// nothing, carry forward"). The marker survives for VISIBILITY — this payee
// was already paid for the order when the dispute landed — not for action.
const POST_TRANSFER_DISPUTE_DEBIT_PHASE = "post_transfer_dispute_debit";

export type DisputeUseCaseDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  // Best-effort Sentry hook, threaded through to the lifecycle notifier's
  // catch-and-degrade branches (`logger.warn` alone is invisible to Sentry).
  // The API wires this via `TrpcDeps.reportError` → `Sentry.captureException`.
  reportError?: ReporterPort | null;
} & DisputeLifecycleCommunicationsDeps;

export type DisputeLifecycleOperation =
  | "open"
  | "refresh"
  | "funds_withdrawn"
  | "close";

export type PersistDisputeLifecycleOptions = {
  operation: DisputeLifecycleOperation;
  targetStatus: DisputeStatus;
  auditAction: string;
  markOrder: boolean;
};

type ResolvedOwner = {
  ownerSubjectType: PayeeSubjectType;
  ownerSubjectId: string;
  ownerOrgId: string | null;
  ownerHumanId: string | null;
};

type ResolvedDisputeContext = {
  order: OrderRecord | null;
  event: EventRecord | null;
  owner: ResolvedOwner | null;
  triageReason: string | null;
};

type StoredDisputeLifecycleRecord = {
  stripeDisputeId: string;
  response: DisputeLifecycleOutput;
};

type SettlementTransferBoundary = {
  condition: typeof SETTLEMENT_TRANSFER_IN_FLIGHT_TRIAGE_REASON;
  settlementIds: string[];
  phase: typeof POST_TRANSFER_DISPUTE_DEBIT_PHASE;
};

type PersistedDisputeLifecycle = {
  output: DisputeLifecycleOutput;
  notification: DisputeLifecycleNotificationContext;
};

type PayeeHoldAggregate = {
  amountCents: number;
  orderSplitIds: string[];
};

type PayeeHoldAllocation = {
  payeeId: string;
  orderSplitIds: string[];
  originalSplitAmountCents: number;
  heldAmountCents: number;
  holdCapAmountCents: number;
  totalPositiveSplitAmountCents: number;
  prorated: boolean;
};

export function mapStripeDisputeStatus(
  stripeStatus: string | null | undefined,
  isWarning: boolean,
): DisputeStatus {
  const normalized = stripeStatus?.toLowerCase() ?? "";

  if (isWarning) {
    if (normalized.includes("closed")) return "WARNING_CLOSED";
    if (normalized === "under_review" || normalized.includes("under_review")) {
      return "WARNING_UNDER_REVIEW";
    }
    return "WARNING_OPEN";
  }
  if (normalized === "won") return "WON";
  if (normalized === "lost") return "LOST";
  if (normalized === "under_review" || normalized.includes("under_review")) {
    return "UNDER_REVIEW";
  }
  if (normalized === "warning_closed") return "WARNING_CLOSED";

  return "OPEN";
}

export function mapStripeClosedDisputeStatus(
  stripeStatus: string | null | undefined,
  outcome: string | null | undefined,
  isWarning: boolean,
): DisputeStatus {
  const normalizedStatus = stripeStatus?.toLowerCase() ?? "";
  const normalizedOutcome = outcome?.toLowerCase() ?? "";

  if (
    isWarning ||
    normalizedStatus === "warning_closed" ||
    normalizedOutcome === "warning_closed"
  ) {
    return "WARNING_CLOSED";
  }
  if (normalizedStatus === "won" || normalizedOutcome === "won") return "WON";

  return "LOST";
}

export async function persistDisputeLifecycle(
  deps: DisputeUseCaseDeps,
  rawInput: unknown,
  options: PersistDisputeLifecycleOptions,
): Promise<DisputeLifecycleOutput> {
  const input = parseInput(stripeDisputeLifecycleInputSchema, rawInput);
  const idempotencyKey = buildIdempotencyKey(options.operation, input);

  const cached =
    await deps.idempotency.get<StoredDisputeLifecycleRecord>(idempotencyKey);
  if (cached) {
    if (cached.stripeDisputeId !== input.stripeDisputeId) {
      throw fail("STRIPE_EVENT_CONFLICT");
    }
    return disputeLifecycleOutputSchema.parse(cached.response);
  }

  // Owner token for `abandonClaim` (lib/idempotency-claim.ts explains why).
  const claimOwnerToken = randomUUID();
  const claimed = await deps.idempotency.begin(
    idempotencyKey,
    IDEMPOTENCY_TTL_SECONDS,
    claimOwnerToken,
  );
  if (!claimed) {
    const replay =
      await deps.idempotency.get<StoredDisputeLifecycleRecord>(idempotencyKey);
    if (replay) {
      if (replay.stripeDisputeId !== input.stripeDisputeId) {
        throw fail("STRIPE_EVENT_CONFLICT");
      }
      return disputeLifecycleOutputSchema.parse(replay.response);
    }
    throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
  }

  const committed = await (async (): Promise<PersistedDisputeLifecycle> => {
    try {
      const persisted = await deps.repos.tx(async (tx) => {
      const now = deps.clock.now();
      const existing = await tx.disputes.findByStripeDisputeId(
        input.stripeDisputeId,
      );
      const context = await resolveDisputeContext(tx, input, existing);
      const linkedAt = context.owner ? (existing?.linkedAt ?? now) : null;
      const status = context.owner
        ? resolveNextStatus(existing?.status ?? null, options)
        : "NEEDS_TRIAGE";
      const fundsWithdrawnAt =
        options.operation === "funds_withdrawn"
          ? (input.fundsWithdrawnAt ?? existing?.fundsWithdrawnAt ?? now)
          : (input.fundsWithdrawnAt ?? existing?.fundsWithdrawnAt ?? null);
      const closedAt =
        options.operation === "close"
          ? (input.closedAt ?? existing?.closedAt ?? now)
          : (input.closedAt ?? existing?.closedAt ?? null);

      let settlementTransferBoundary: SettlementTransferBoundary | null = null;
      if (options.markOrder && context.order && context.owner) {
        await tx.orders.markDisputeStatus({
          orderId: context.order.id,
          disputeStatus: status,
          disputedAt: status === "WARNING_CLOSED" ? undefined : linkedAt,
        });
        settlementTransferBoundary = await resolveSettlementTransferBoundary(
          tx,
          context.order.id,
          status,
        );
        if (settlementTransferBoundary) {
          deps.logger?.warn("dispute.lifecycle.settlement_transfer_in_flight", {
            stripeEventId: input.stripeEventId ?? null,
            stripeDisputeId: input.stripeDisputeId,
            orderId: context.order.id,
            settlementIds: settlementTransferBoundary.settlementIds,
            phase: settlementTransferBoundary.phase,
          });
        }
      }

      const triageReason = context.owner
        ? resolveLinkedTriageReason(existing, settlementTransferBoundary)
        : context.triageReason;

      // Stripe reports the dispute fee late — usually only at
      // `funds_withdrawn`, never at `charge.dispute.created`. A null here means
      // "not reported on this event", so falling back to the stored value is
      // what stops a later lifecycle event from wiping a fee we already know.
      const feeCents = input.feeCents ?? existing?.feeCents ?? 0;

      // Ticketing disputes are absorbed by the platform: clawing a buyer's
      // chargeback fee back off a venue would be a nasty surprise for an
      // action they had no part in. Membership disputes go to the payee, who
      // sold the recurring subscription — and who is told so at setup.
      // Left null until a fee actually exists, so "nobody has been charged
      // anything yet" stays distinguishable from "the platform ate it".
      const feeBorneBy =
        feeCents === 0
          ? (existing?.feeBorneBy ?? null)
          : context.order?.kind === "MEMBERSHIP"
            ? "PAYEE"
            : "PLATFORM";

      const dispute = await tx.disputes.upsertFromStripe({
        stripeDisputeId: input.stripeDisputeId,
        stripeChargeId:
          input.stripeChargeId ?? existing?.stripeChargeId ?? null,
        paymentIntentId:
          input.paymentIntentId ?? existing?.paymentIntentId ?? null,
        orderId: context.order?.id ?? existing?.orderId ?? null,
        ownerSubjectType:
          context.owner?.ownerSubjectType ?? existing?.ownerSubjectType ?? null,
        ownerSubjectId:
          context.owner?.ownerSubjectId ?? existing?.ownerSubjectId ?? null,
        ownerOrgId: context.owner?.ownerOrgId ?? existing?.ownerOrgId ?? null,
        ownerHumanId:
          context.owner?.ownerHumanId ?? existing?.ownerHumanId ?? null,
        amountCents: input.amountCents,
        feeCents,
        feeBorneBy,
        currency: input.currency,
        reason: input.reason,
        status,
        triageReason,
        linkedAt,
        evidenceDueBy: input.evidenceDueBy ?? existing?.evidenceDueBy ?? null,
        fundsWithdrawnAt,
        closedAt,
        outcome: input.outcome ?? existing?.outcome ?? null,
        metadata: buildStoredMetadata(
          input,
          options.operation,
          settlementTransferBoundary,
        ),
      });

      const lossOutcome = await syncPayeeLedgerHolds(
        tx,
        dispute,
        context,
        input,
        deps,
        existing?.status ?? null,
      );

      await tx.audit.log({
        entity: "dispute",
        entityId: dispute.id,
        action: options.auditAction,
        data: {
          stripeEventId: input.stripeEventId ?? null,
          stripeDisputeId: input.stripeDisputeId,
          stripeChargeId: input.stripeChargeId,
          paymentIntentId: input.paymentIntentId,
          orderId: dispute.orderId,
          status: dispute.status,
          triageReason: dispute.triageReason,
          settlementTransferBoundary,
        },
        at: now,
      });

      const output = disputeLifecycleOutputSchema.parse({
        ok: true,
        disputeId: dispute.id,
        stripeDisputeId: dispute.stripeDisputeId,
        orderId: dispute.orderId,
        status: dispute.status,
        triageReason: dispute.triageReason,
      });

      return {
        output,
        notification: {
          operation: options.operation,
          input,
          dispute,
          order: context.order,
          event: context.event,
          lossRecovery: lossOutcome
            ? {
                principalDebited: lossOutcome.amountEntries > 0,
                feeDebited: lossOutcome.feeEntry,
              }
            : null,
        },
      };
    });

      return persisted;
    } catch (error) {
      await abandonClaim(deps.idempotency, idempotencyKey, claimOwnerToken, error, {
        useCase: "persistDisputeLifecycle",
        logger: deps.logger ?? null,
        reportError: deps.reportError ?? null,
      });
      throw asKnownError("shared", error);
    }
  })();

  // Outside the abandon path: the lifecycle tx has committed, so a `commit`
  // that throws leaves the claim standing until its TTL. Releasing it would
  // let the DLQ replay re-run the persist and `notifyDisputeLifecycle` at
  // once — a duplicate org notice. This only holds while the claim's TTL
  // lasts: a replay after it expires finds no record and runs the persist
  // and notify again, deduped then only by the notify's own idempotency
  // keys. Same error shape as when it ran inside the try.
  try {
    await deps.idempotency.commit<StoredDisputeLifecycleRecord>(
      idempotencyKey,
      {
        stripeDisputeId: input.stripeDisputeId,
        response: committed.output,
      },
      IDEMPOTENCY_KEEP_SECONDS,
    );
  } catch (error) {
    throw asKnownError("shared", error);
  }

  await notifyDisputeLifecycle(deps, committed.notification);

  return committed.output;
}

function resolveNextStatus(
  existingStatus: DisputeStatus | null,
  options: PersistDisputeLifecycleOptions,
): DisputeStatus {
  if (
    existingStatus &&
    options.operation !== "close" &&
    TERMINAL_DISPUTE_STATUSES.has(existingStatus)
  ) {
    return existingStatus;
  }

  return options.targetStatus;
}

async function resolveSettlementTransferBoundary(
  tx: TxRepos,
  orderId: string,
  status: DisputeStatus,
): Promise<SettlementTransferBoundary | null> {
  if (!isBlockedSettlementDisputeStatus(status)) return null;

  const settlementIds = [
    ...(await tx.settlementLines.settlementIdsForOrderWithSettlementStatuses(
      orderId,
      ["transferring"],
    )),
  ];
  if (settlementIds.length === 0) return null;

  return {
    condition: SETTLEMENT_TRANSFER_IN_FLIGHT_TRIAGE_REASON,
    settlementIds,
    phase: POST_TRANSFER_DISPUTE_DEBIT_PHASE,
  };
}

async function syncPayeeLedgerHolds(
  tx: TxRepos,
  dispute: DisputeRecord,
  context: ResolvedDisputeContext,
  input: StripeDisputeLifecycleInput,
  deps: DisputeUseCaseDeps,
  previousStatus: DisputeStatus | null,
): Promise<DisputeLossDebitOutcome | null> {
  if (!context.order || !context.owner) return null;

  if (dispute.status === "WON") {
    await tx.payeeLedger.releaseHoldsForDispute(dispute.id);
    // WON-after-LOST: Stripe can re-close a dispute in the payee's favour
    // after a LOST close already converted the hold into a realised
    // DISPUTE_DEBIT. The hold is gone (consumed by the debit), so the
    // release above finds nothing — without this step the `dispute-debit:` /
    // `dispute-debit-fee:` entries silently stand and the payee is
    // recovered-from for a dispute they won. Compensate every debit with a
    // positive reversal of equal amount; the ordinary WON (no prior debit)
    // finds no debits and writes nothing.
    await reverseDisputeDebits(tx, dispute, input);
    return null;
  }

  // A LOST close converts each payee's provisional hold into a realised
  // DISPUTE_DEBIT: the payee owes back their share of the disputed amount,
  // capped at what they still hold from the order. Both product lines debit
  // the PRINCIPAL; the spec's "absorb on ticketing, debit to the payee on
  // memberships" is about Stripe's dispute FEE, which is the one thing that
  // still differs:
  //   * memberships — the payee sold the recurring subscription and was told
  //     at setup that lost disputes are theirs; the fee is debited too
  //     (feeBorneBy PAYEE).
  //   * ticketing — the platform absorbs the fee (feeBorneBy PLATFORM): a
  //     venue had no part in the buyer's chargeback. Only the principal is
  //     recovered. Until 2026-09 a ticketing LOST wrote NO debit at all — the
  //     hold persisted forever waiting for a manual clawback that had no
  //     surface, and if the transfer had already gone out nothing recovered
  //     the money.
  // Fires on the LOST status rather than only on the close operation so a
  // late lifecycle event after close self-heals via the idempotency keys;
  // replays are no-ops.
  if (dispute.status === "LOST") {
    const outcome = await debitDisputeLoss(tx, dispute, context, input, {
      debitFee: context.order.kind === "MEMBERSHIP",
    });
    // Report on the REASON, not on "was anything debited": a membership fee
    // entry — or another payee's successful debit — must not hide that SOME
    // payee's share was genuinely unrecoverable (nothing retained from the
    // order — refunded, or never credited). `dispute_amount_below_hold`
    // stays silent: Stripe simply claimed less than we held. And only on the
    // TRANSITION into LOST — a replay or a later lifecycle event
    // (funds_withdrawn, a refresh) re-runs this sync against the persisted
    // LOST status and would otherwise page for the same dispute every time
    // Stripe sends anything about it.
    if (outcome.unrecoverablePayeeIds.length > 0 && previousStatus !== "LOST") {
      reportLostWithoutDebit(deps, dispute, context, outcome);
    }
    // Separate signal: a share WAS debited but for less than Stripe's claim
    // allocated to it, because the payee no longer holds that much of the
    // order (a refund landed after the hold was written). The difference is
    // platform-absorbed. Transition-only, like the report above.
    if (outcome.cappedByRetained.length > 0 && previousStatus !== "LOST") {
      reportCappedByRetained(deps, dispute, context, outcome);
    }
    if (outcome.duplicateHoldIds.length > 0) {
      reportDuplicateHolds(deps, dispute, context, outcome);
    }
    // A LOST dispute never falls through to the hold path below: with no
    // debit to write there is nothing for a NEW hold to secure, and a hold
    // created here would be exactly the forever-standing hold this branch
    // replaced. Holds written while the dispute was open are either consumed
    // by their debit or released above; the reporter has the rest.
    return outcome;
  }

  if (!isBlockedSettlementDisputeStatus(dispute.status)) return null;
  if (input.amountCents <= 0) return null;

  const splits = await tx.splits.getForOrder(context.order.id);
  const currency = normalizeLedgerCurrency(context.order.currency ?? input.currency);
  const holdAllocations = allocateDisputeHoldAmounts(
    aggregatePositiveSplitsByPayee(splits),
    input.amountCents,
  );

  // Cap each payee's hold at what they still hold from the order (credit −
  // refunds − realised dispute principal). A fully refunded share gets NO
  // hold: the payee is holding none of that money, and a hold would
  // withhold their OTHER payouts until close for nothing — the same cap the
  // LOST debit applies, applied at the only other site that claims money.
  const retainedByPayee = retainedCreditByPayee(
    await tx.payeeLedger.listOrderEntries(context.order.id),
  );

  for (const hold of holdAllocations) {
    const retainedCents = retainedByPayee.get(hold.payeeId) ?? 0;
    const heldAmountCents = Math.min(hold.heldAmountCents, retainedCents);
    if (heldAmountCents <= 0) continue;
    await tx.payeeLedger.hold({
      idempotencyKey: `dispute-hold:${dispute.id}:${hold.payeeId}:${currency}`,
      payeeId: hold.payeeId,
      amountCents: heldAmountCents,
      currency,
      disputeId: dispute.id,
      orderId: context.order.id,
      description: `Dispute hold for order ${formatOrderCode(context.order.id)}`,
      metadata: {
        stripeDisputeId: input.stripeDisputeId,
        stripeEventId: input.stripeEventId ?? null,
        orderSplitIds: hold.orderSplitIds,
        originalSplitAmountCents: hold.originalSplitAmountCents,
        allocatedAmountCents: hold.heldAmountCents,
        retainedCents,
        heldAmountCents,
        disputedAmountCents: input.amountCents,
        holdCapAmountCents: hold.holdCapAmountCents,
        totalPositiveSplitAmountCents: hold.totalPositiveSplitAmountCents,
        prorated: hold.prorated,
      },
    });
  }
  return null;
}

type DisputeLossDebitOptions = {
  // Stripe's dispute fee is debited only when it is the payee's to bear
  // (memberships). Ticketing passes false and the fee stays platform-borne:
  // the flag carries the product decision, the `feeBorneBy === "PAYEE"` check
  // inside is the data guard — both must agree before a fee entry is written.
  debitFee: boolean;
};

type ReleasedHoldReason =
  // The payee holds nothing of the order (refunded, or never credited).
  | "nothing_retained_from_order"
  // Stripe's close amount allocated nothing to this share.
  | "dispute_amount_below_hold"
  // A second active hold for the same (payee, currency) — unreachable by the
  // key convention, released so it can never strand; reported.
  | "duplicate_hold_superseded";

type DisputeLossDebitOutcome = {
  // True when at least one amount or fee entry was written or replayed.
  debited: boolean;
  amountEntries: number;
  feeEntry: boolean;
  releasedHolds: Array<{
    holdId: string;
    payeeId: string;
    reason: ReleasedHoldReason;
  }>;
  // Payees whose share could not be recovered at all: nothing retained from
  // the order. Drives `lost_no_debit`; `dispute_amount_below_hold` does not.
  unrecoverablePayeeIds: string[];
  // Shares debited for LESS than their allocation because the payee no
  // longer holds that much of the order; the shortfall is platform-borne.
  cappedByRetained: Array<{
    payeeId: string;
    allocatedCents: number;
    retainedCents: number;
  }>;
  duplicateHoldIds: string[];
  // Where the amount entries came from: the dispute's active holds (the
  // normal case), or a fresh splits allocation when no hold existed.
  source: "holds" | "splits" | "replay";
};

// WHEN the debit fires: on a LOST close (and on any later event that observes
// the persisted LOST status — idempotent replay). NOT at open/funds_withdrawn,
// where the ordinary hold path above applies.
//
// AMOUNT ENTRIES ARE DERIVED FROM THE HOLDS, NOT FROM THE SPLITS. The holds
// were frozen at OPEN over the amount Stripe first reported; recomputing an
// allocation at close from the splits could disagree with them (a payee
// whose prorated share rounds to zero and is dropped) and leave a hold that
// nothing ever consumes — the exact defect this path exists to kill. But the
// CLOSE amount still bounds what is owed: open 5000 / close 1 must not claw
// 5000. So, when active holds exist: min(close amount, Σ active hold
// amounts) is allocated ACROSS THE HOLDS proportional to their amounts
// (`allocateDisputeHoldAmounts` — bigint largest-remainder, payeeId
// tiebreak, deterministic), and then per hold:
//   debit = min(allocated, hold amount, retained-from-order cap) → written as
//     `dispute-debit:${disputeId}:${payeeId}:${currency}`, CONSUMING the hold.
//   debit == 0 → the hold is RELEASED explicitly (`releaseHold`, reason
//     `dispute_amount_below_hold` when the allocation rounded to nothing,
//     `nothing_retained_from_order` when the cap did) so it never stands.
// The ledger has no partial-release primitive — a debit consumes its hold
// WHOLE (the adapter drops pendingHoldCents by the full hold amount and a
// hold is consumed exactly once, which the rollup-drift check relies on). So
// when 0 < debit < hold, the hold's remainder is released BY THE DEBIT
// ITSELF; `releasedRemainderCents` on the debit's metadata records it.
// Close > open therefore consumes every hold in full and never debits more
// than a hold. Invariant: after a LOST pass, the dispute has NO active hold
// and Σ amount debits ≤ min(close amount, Σ holds).
//
// A fresh splits allocation is the FALLBACK only when the dispute has no
// active hold at all — LOST-after-WON, or a missed `charge.dispute.created`.
//
// THE CAP honours prior refunds. Per (order, payee), the most a lost dispute
// can recover is Σ SETTLEMENT_CREDIT − Σ REFUND_DEBIT, floored at 0
// (`retainedCreditByPayee`, shared with the refund writers). A fully refunded
// share has already been clawed back once; debiting it again on the
// chargeback would leave a permanent negative for a payee who kept nothing.
// The credit writer credits exactly the summed positive split per payee, so
// with no refunds this collapses to the old split-total cap — and we are
// merchant of record, so the sales tax inside Stripe's disputed amount was
// never credited and never enters. A hold whose cap is ZERO is RELEASED
// rather than left standing (its pending-hold effect would otherwise punish
// money the payee is not holding), and the caller reports the no-recovery.
//
// Fee entry (`dispute-debit-fee:` key): Stripe's dispute fee, written on any
// pass where `debitFee` is set, the dispute is LOST, the persisted feeCents
// is positive, feeBorneBy is PAYEE, and the order has exactly one payee (a
// fee has one owner; with several there is nobody to pin it on). Stripe
// typically reports the fee at funds_withdrawn, but it can materialise only
// AFTER the LOST close; because `persistDisputeLifecycle` re-runs the ledger
// sync on every event, a late fee gets its entry on that later pass while the
// amount entries replay as no-ops. The fee key carries no amount: a fee
// CORRECTION after the entry exists is deliberately NOT re-debited —
// under-debiting is the safe direction. Ticketing never writes one.
//
// THE FEE ENTRY NEVER CONSUMES A HOLD (`consumeHold: false`). The adapter's
// `debit` otherwise consumes the dispute's active hold for the same
// (payee, currency) on creation; only the AMOUNT entry may do that. Without
// the flag, a pass that wrote the fee while a hold was still active would
// release the hold's cents against the fee and leave the principal with no
// hold to consume.
//
// REPLAY: if amount entries already exist for the dispute, the amount phase
// is skipped outright (their holds were consumed on the pass that wrote
// them); only the fee phase runs, so a late fee still lands and a refund
// written after the loss cannot make a replay look like "nothing debited".
//
// SETTLEMENT TRANSFER ALREADY OUT (`settlement_transfer_in_flight` triage):
// no special case. The payee was PAID for this order, so the debit drives
// their payable negative and the payout batch recovers it from the next
// transfer. The triage marker is visibility only.
async function debitDisputeLoss(
  tx: TxRepos,
  dispute: DisputeRecord,
  context: ResolvedDisputeContext,
  input: StripeDisputeLifecycleInput,
  options: DisputeLossDebitOptions,
): Promise<DisputeLossDebitOutcome> {
  const outcome: DisputeLossDebitOutcome = {
    debited: false,
    amountEntries: 0,
    feeEntry: false,
    releasedHolds: [],
    unrecoverablePayeeIds: [],
    cappedByRetained: [],
    duplicateHoldIds: [],
    source: "holds",
  };
  if (!context.order) return outcome;
  const order = context.order;
  const currency = normalizeLedgerCurrency(order.currency ?? input.currency);
  const baseMetadata = {
    stripeDisputeId: input.stripeDisputeId,
    stripeEventId: input.stripeEventId ?? null,
    disputedAmountCents: dispute.amountCents,
    feeCents: dispute.feeCents,
    feeBorneBy: dispute.feeBorneBy,
  };

  const existingAmountEntries = (
    await tx.payeeLedger.listDebitsForDispute(dispute.id)
  ).filter((entry) =>
    entry.idempotencyKey.startsWith(DISPUTE_PRINCIPAL_DEBIT_KEY_PREFIX),
  );
  const splitsByPayee = aggregatePositiveSplitsByPayee(
    await tx.splits.getForOrder(order.id),
  );

  if (existingAmountEntries.length > 0) {
    outcome.source = "replay";
    outcome.amountEntries = existingAmountEntries.length;
  } else {
    const retainedByPayee = retainedCreditByPayee(
      await tx.payeeLedger.listOrderEntries(order.id),
    );
    const activeHolds = [
      ...(await tx.payeeLedger.listActiveHoldsByDispute(dispute.id)),
    ].sort((left, right) => left.payeeId.localeCompare(right.payeeId));

    const releaseHold = async (
      hold: PayeeLedgerEntryRecord,
      reason: ReleasedHoldReason,
      extra: Record<string, unknown>,
    ): Promise<void> => {
      const release = await tx.payeeLedger.releaseHold({
        holdEntryId: hold.id,
        description:
          reason === "nothing_retained_from_order"
            ? `Dispute hold released for order ${formatOrderCode(order.id)} (nothing retained from the order to recover)`
            : reason === "dispute_amount_below_hold"
              ? `Dispute hold released for order ${formatOrderCode(order.id)} (disputed amount allocates nothing to this share)`
              : `Dispute hold released for order ${formatOrderCode(order.id)} (duplicate active hold superseded)`,
        metadata: {
          ...baseMetadata,
          reason,
          holdAmountCents: hold.amountCents,
          ...extra,
        },
      });
      if (release) {
        outcome.releasedHolds.push({
          holdId: hold.id,
          payeeId: hold.payeeId,
          reason,
        });
      }
    };

    if (activeHolds.length > 0) {
      outcome.source = "holds";
      // Group per payee. The key convention (`dispute-hold:${dispute}:
      // ${payee}:${currency}`) makes one hold per payee the only reachable
      // shape, but the loop consumes EVERY hold in a group so a second one
      // could never be stranded: the debit consumes the oldest (the adapter
      // links `relatedEntryId` to it), the rest are released as duplicates
      // and reported by the caller.
      const groupKey = (hold: { payeeId: string; currency: string }) =>
        `${hold.payeeId}::${hold.currency}`;
      const holdGroups = new Map<string, PayeeLedgerEntryRecord[]>();
      for (const hold of activeHolds) {
        const group = holdGroups.get(groupKey(hold)) ?? [];
        group.push(hold);
        holdGroups.set(groupKey(hold), group);
      }
      // Allocation is keyed by the same composite key: the allocator only
      // uses its "payeeId" for grouping and deterministic tie-breaks.
      const holdsByGroup = new Map<string, PayeeHoldAggregate>(
        [...holdGroups].map(([key, group]) => [
          key,
          {
            amountCents: group.reduce((sum, hold) => sum + hold.amountCents, 0),
            orderSplitIds: [],
          },
        ]),
      );
      const allocatedByGroup = new Map(
        allocateDisputeHoldAmounts(holdsByGroup, dispute.amountCents).map(
          (allocation) => [allocation.payeeId, allocation.heldAmountCents],
        ),
      );
      for (const [key, group] of holdGroups) {
        const payeeId = group[0]!.payeeId;
        const currencyForPayee = group[0]!.currency;
        const totalHeldCents = holdsByGroup.get(key)?.amountCents ?? 0;
        const retainedCents = retainedByPayee.get(payeeId) ?? 0;
        const allocatedCents = allocatedByGroup.get(key) ?? 0;
        const amountCents = Math.min(totalHeldCents, allocatedCents, retainedCents);
        if (amountCents <= 0) {
          const reason: ReleasedHoldReason =
            retainedCents <= 0
              ? "nothing_retained_from_order"
              : "dispute_amount_below_hold";
          if (reason === "nothing_retained_from_order") {
            outcome.unrecoverablePayeeIds.push(payeeId);
          }
          for (const hold of group) {
            await releaseHold(hold, reason, { allocatedCents, retainedCents });
          }
          continue;
        }
        if (retainedCents < allocatedCents) {
          outcome.cappedByRetained.push({ payeeId, allocatedCents, retainedCents });
        }
        const debit = await tx.payeeLedger.debit({
          idempotencyKey: `${DISPUTE_PRINCIPAL_DEBIT_KEY_PREFIX}${dispute.id}:${payeeId}:${currencyForPayee}`,
          payeeId,
          amountCents,
          currency: currencyForPayee,
          disputeId: dispute.id,
          orderId: order.id,
          description: `Dispute debit for order ${formatOrderCode(order.id)}`,
          // The consumed hold is on the entry itself (`relatedEntryId`,
          // chosen by the adapter) — not duplicated into metadata.
          metadata: {
            ...baseMetadata,
            source: "hold",
            holdAmountCents: totalHeldCents,
            allocatedCents,
            retainedCents,
            // This payee's realised debit after both caps.
            cappedAmountCents: amountCents,
            // The hold is consumed whole by this entry; anything above the
            // debit is released by that consumption, not owed.
            releasedRemainderCents: totalHeldCents - amountCents,
          },
        });
        outcome.amountEntries += 1;
        // Any hold in the group the debit did not consume is a duplicate.
        for (const hold of group) {
          if (hold.id === debit.relatedEntryId) continue;
          outcome.duplicateHoldIds.push(hold.id);
          await releaseHold(hold, "duplicate_hold_superseded", {
            consumedHoldEntryId: debit.relatedEntryId,
          });
        }
      }
      // A payee with a positive share but NO hold (their share was already
      // refunded when the dispute opened, so the hold cap wrote none) never
      // enters the groups above — if they still hold nothing of the order,
      // their share is unrecoverable and must be reported like any other.
      for (const payeeId of splitsByPayee.keys()) {
        if (holdGroups.has(`${payeeId}::${currency}`)) continue;
        if ((retainedByPayee.get(payeeId) ?? 0) > 0) continue;
        outcome.unrecoverablePayeeIds.push(payeeId);
      }
    } else {
      outcome.source = "splits";
      const allocations = allocateDisputeHoldAmounts(
        splitsByPayee,
        dispute.amountCents,
      );
      for (const allocation of allocations) {
        const retainedCents = retainedByPayee.get(allocation.payeeId) ?? 0;
        const amountCents = Math.min(allocation.heldAmountCents, retainedCents);
        if (amountCents <= 0) {
          // Something was allocated but the payee holds none of it.
          outcome.unrecoverablePayeeIds.push(allocation.payeeId);
          continue;
        }
        if (retainedCents < allocation.heldAmountCents) {
          outcome.cappedByRetained.push({
            payeeId: allocation.payeeId,
            allocatedCents: allocation.heldAmountCents,
            retainedCents,
          });
        }
        await tx.payeeLedger.debit({
          idempotencyKey: `${DISPUTE_PRINCIPAL_DEBIT_KEY_PREFIX}${dispute.id}:${allocation.payeeId}:${currency}`,
          payeeId: allocation.payeeId,
          amountCents,
          currency,
          disputeId: dispute.id,
          orderId: order.id,
          description: `Dispute debit for order ${formatOrderCode(order.id)}`,
          metadata: {
            ...baseMetadata,
            source: "splits",
            retainedCents,
            cappedAmountCents: amountCents,
            allocatedAmountCents: allocation.heldAmountCents,
            holdCapAmountCents: allocation.holdCapAmountCents,
            originalSplitAmountCents: allocation.originalSplitAmountCents,
            totalPositiveSplitAmountCents:
              allocation.totalPositiveSplitAmountCents,
            orderSplitIds: allocation.orderSplitIds,
            prorated: allocation.prorated,
          },
        });
        outcome.amountEntries += 1;
      }
    }
  }

  const [feePayeeId] = splitsByPayee.keys();
  const shouldDebitFee =
    options.debitFee &&
    dispute.feeCents > 0 &&
    dispute.feeBorneBy === "PAYEE" &&
    splitsByPayee.size === 1 &&
    feePayeeId !== undefined;
  if (shouldDebitFee) {
    await tx.payeeLedger.debit({
      idempotencyKey: `${DISPUTE_FEE_DEBIT_KEY_PREFIX}${dispute.id}:${feePayeeId}:${currency}`,
      payeeId: feePayeeId,
      amountCents: dispute.feeCents,
      currency,
      disputeId: dispute.id,
      orderId: order.id,
      consumeHold: false,
      description: `Dispute fee debit for order ${formatOrderCode(order.id)}`,
      metadata: {
        stripeDisputeId: input.stripeDisputeId,
        stripeEventId: input.stripeEventId ?? null,
        feeCents: dispute.feeCents,
        feeBorneBy: dispute.feeBorneBy,
      },
    });
    outcome.feeEntry = true;
  }

  outcome.debited = outcome.amountEntries > 0 || outcome.feeEntry;
  return outcome;
}

// A LOST dispute with a resolved owner that produced no debit is money the
// platform lost and will never recover through the ledger — either the payee
// retained nothing from the order (fully refunded; hold released) or nothing
// was ever credited (pre-cutover order, credit write never re-driven). The
// lifecycle deliberately does not throw (Stripe's webhook must still be
// acknowledged), so this is a swallow-and-degrade branch: it MUST reach
// Sentry via `reportError` — `logger.warn` is not captured (CLAUDE.md,
// error-reporting convention). Guarded so a throwing reporter never changes
// the lifecycle's behaviour.
function reportLostWithoutDebit(
  deps: DisputeUseCaseDeps,
  dispute: DisputeRecord,
  context: ResolvedDisputeContext,
  outcome: DisputeLossDebitOutcome,
): void {
  const extra = {
    disputeId: dispute.id,
    stripeDisputeId: dispute.stripeDisputeId,
    orderId: context.order?.id ?? null,
    orderKind: context.order?.kind ?? null,
    disputedAmountCents: dispute.amountCents,
    source: outcome.source,
    feeDebited: outcome.feeEntry,
    unrecoverablePayeeIds: outcome.unrecoverablePayeeIds,
    releasedHolds: outcome.releasedHolds,
  };
  deps.logger?.error("dispute.lifecycle.lost_no_debit", extra);
  try {
    deps.reportError?.(new Error("dispute_lost_no_debit"), {
      tags: { useCase: "closeDispute", reason: "lost_no_debit" },
      extra,
    });
  } catch {
    // The reporter is best-effort; never let it alter the lifecycle result.
  }
}

// A share was debited, but for less than the disputed amount allocated to
// it: the payee no longer holds that much of the order (a refund landed
// after the hold was written), so the shortfall is platform-absorbed. One
// report per capped payee, transition-only. Distinct from `lost_no_debit`
// (nothing at all recovered for a payee).
function reportCappedByRetained(
  deps: DisputeUseCaseDeps,
  dispute: DisputeRecord,
  context: ResolvedDisputeContext,
  outcome: DisputeLossDebitOutcome,
): void {
  for (const capped of outcome.cappedByRetained) {
    const extra = {
      disputeId: dispute.id,
      orderId: context.order?.id ?? null,
      payeeId: capped.payeeId,
      allocatedCents: capped.allocatedCents,
      retainedCents: capped.retainedCents,
    };
    deps.logger?.error("dispute.lifecycle.debit_capped_by_retained", extra);
    try {
      deps.reportError?.(new Error("dispute_debit_capped_by_retained"), {
        tags: { useCase: "closeDispute", reason: "dispute_debit_capped_by_retained" },
        extra,
      });
    } catch {
      // Best-effort reporter.
    }
  }
}

// Two active holds for one (dispute, payee, currency) cannot be produced by
// the `dispute-hold:` key convention; seeing one means a writer bypassed it.
// The extra hold was released (never stranded) — this makes the anomaly
// visible so the cause gets found.
function reportDuplicateHolds(
  deps: DisputeUseCaseDeps,
  dispute: DisputeRecord,
  context: ResolvedDisputeContext,
  outcome: DisputeLossDebitOutcome,
): void {
  const extra = {
    disputeId: dispute.id,
    stripeDisputeId: dispute.stripeDisputeId,
    orderId: context.order?.id ?? null,
    duplicateHoldIds: outcome.duplicateHoldIds,
  };
  deps.logger?.error("dispute.lifecycle.duplicate_active_holds", extra);
  try {
    deps.reportError?.(new Error("dispute_duplicate_active_holds"), {
      tags: { useCase: "closeDispute", reason: "duplicate_active_holds" },
      extra,
    });
  } catch {
    // Best-effort reporter.
  }
}

// Compensates realised DISPUTE_DEBITs after a WON-after-LOST status flip.
//
// Each debit gets a positive reversal of EQUAL amount under a stable key —
// `dispute-debit-reversal:${disputeId}:${payeeId}:${currency}` for the amount
// entry, `dispute-debit-reversal-fee:…` for the fee twin (told apart by the
// debit's own key prefix) — so replays of the WON close are no-ops, exactly
// like every other entry in this file. The reversal entry is typed
// DISPUTE_RELEASE with a ledger-balance increment (see
// `ReverseDisputeDebitInput` for why that type is the honest one and how the
// balance math differs from a hold-release).
//
// Product-line agnostic: it reverses whatever `debitDisputeLoss` wrote — one
// amount entry per payee on ticketing, amount + fee on memberships — by
// listing the dispute's debits rather than recomputing anything.
//
// Deliberate asymmetry with `debitDisputeLoss`: a later LOST re-flip after
// this reversal does NOT re-debit — the debit keys are stable and replay as
// no-ops. A LOST→WON→LOST ping-pong therefore ends with the payee NOT
// debited, which is the under-debit (safe) direction and a case Stripe does
// not produce in practice.
async function reverseDisputeDebits(
  tx: TxRepos,
  dispute: DisputeRecord,
  input: StripeDisputeLifecycleInput,
): Promise<void> {
  const debits = await tx.payeeLedger.listDebitsForDispute(dispute.id);

  for (const debit of debits) {
    const isFeeDebit = debit.idempotencyKey.startsWith(
      DISPUTE_FEE_DEBIT_KEY_PREFIX,
    );
    await tx.payeeLedger.reverseDisputeDebit({
      idempotencyKey: isFeeDebit
        ? `${DISPUTE_FEE_REVERSAL_KEY_PREFIX}${dispute.id}:${debit.payeeId}:${debit.currency}`
        : `dispute-debit-reversal:${dispute.id}:${debit.payeeId}:${debit.currency}`,
      payeeId: debit.payeeId,
      amountCents: debit.amountCents,
      currency: debit.currency,
      disputeId: dispute.id,
      debitEntryId: debit.id,
      orderId: debit.orderId,
      description: isFeeDebit
        ? `Dispute fee debit reversed for ${disputeDebitSubject(debit.orderId, dispute.id)} (dispute won)`
        : `Dispute debit reversed for ${disputeDebitSubject(debit.orderId, dispute.id)} (dispute won)`,
      metadata: {
        stripeDisputeId: input.stripeDisputeId,
        stripeEventId: input.stripeEventId ?? null,
        reversedEntryId: debit.id,
        reversedIdempotencyKey: debit.idempotencyKey,
        reversedAmountCents: debit.amountCents,
      },
    });
  }
}

// Positive splits summed per payee — the basis for BOTH the provisional hold
// and the realised debit. Zero/negative splits are skipped: the credit writer
// skips them too, so they were never credited and can never be owed back.
function aggregatePositiveSplitsByPayee(
  splits: readonly { payeeId: string; orderSplitId: string; amountCents: number }[],
): Map<string, PayeeHoldAggregate> {
  const byPayee = new Map<string, PayeeHoldAggregate>();
  for (const split of splits) {
    if (split.amountCents <= 0) continue;
    const aggregate = byPayee.get(split.payeeId) ?? {
      amountCents: 0,
      orderSplitIds: [],
    };
    aggregate.amountCents += split.amountCents;
    aggregate.orderSplitIds.push(split.orderSplitId);
    byPayee.set(split.payeeId, aggregate);
  }
  return byPayee;
}

// Allocates the disputed amount across an order's payees. Used by the hold
// path (open/under-review) and, as the no-hold FALLBACK only, by
// `debitDisputeLoss` — when holds exist the debits are derived from the holds
// themselves rather than re-allocated (see that function for why).
//
// Order-level cap = min(disputed amount, sum of positive splits). At or above
// the cap every payee owes their full split; below it, shares are prorated
// with bigint integer division and the leftover cents handed out by largest
// remainder (ties broken by payeeId) so the allocations always sum exactly to
// the cap and no payee ever exceeds their own split total.
function allocateDisputeHoldAmounts(
  holdsByPayee: Map<string, PayeeHoldAggregate>,
  disputeAmountCents: number,
): PayeeHoldAllocation[] {
  const payeeHolds = [...holdsByPayee.entries()]
    .map(([payeeId, hold]) => ({
      payeeId,
      orderSplitIds: hold.orderSplitIds,
      originalSplitAmountCents: hold.amountCents,
    }))
    .sort((left, right) => left.payeeId.localeCompare(right.payeeId));

  const totalPositiveSplitAmountCents = payeeHolds.reduce(
    (sum, hold) => sum + hold.originalSplitAmountCents,
    0,
  );
  const holdCapAmountCents = Math.min(
    disputeAmountCents,
    totalPositiveSplitAmountCents,
  );

  if (holdCapAmountCents <= 0) return [];

  const withMetadata = (
    hold: (typeof payeeHolds)[number],
    heldAmountCents: number,
    prorated: boolean,
  ): PayeeHoldAllocation => ({
    ...hold,
    heldAmountCents,
    holdCapAmountCents,
    totalPositiveSplitAmountCents,
    prorated,
  });

  if (holdCapAmountCents >= totalPositiveSplitAmountCents) {
    return payeeHolds.map((hold) =>
      withMetadata(hold, hold.originalSplitAmountCents, false),
    );
  }

  const totalPositiveSplitAmount = BigInt(totalPositiveSplitAmountCents);
  const holdCapAmount = BigInt(holdCapAmountCents);
  const proratedHolds = payeeHolds.map((hold) => {
    const numerator =
      BigInt(hold.originalSplitAmountCents) * holdCapAmount;
    const heldAmountCents = Number(numerator / totalPositiveSplitAmount);

    return {
      allocation: withMetadata(hold, heldAmountCents, true),
      remainder: numerator % totalPositiveSplitAmount,
    };
  });
  const allocatedAmountCents = proratedHolds.reduce(
    (sum, hold) => sum + hold.allocation.heldAmountCents,
    0,
  );
  const remainingCents = holdCapAmountCents - allocatedAmountCents;
  const payeesReceivingRemainder = new Set(
    [...proratedHolds]
      .sort((left, right) => {
        if (left.remainder > right.remainder) return -1;
        if (left.remainder < right.remainder) return 1;
        return left.allocation.payeeId.localeCompare(
          right.allocation.payeeId,
        );
      })
      .slice(0, remainingCents)
      .map((hold) => hold.allocation.payeeId),
  );

  return proratedHolds
    .map((hold) => ({
      ...hold.allocation,
      heldAmountCents:
        hold.allocation.heldAmountCents +
        (payeesReceivingRemainder.has(hold.allocation.payeeId) ? 1 : 0),
    }))
    .filter((hold) => hold.heldAmountCents > 0);
}

function normalizeLedgerCurrency(currency: string): string {
  return currency.trim().toLowerCase();
}

function resolveLinkedTriageReason(
  existing: DisputeRecord | null,
  settlementTransferBoundary: SettlementTransferBoundary | null,
): string | null {
  if (settlementTransferBoundary) {
    return SETTLEMENT_TRANSFER_IN_FLIGHT_TRIAGE_REASON;
  }

  return existing?.triageReason === SETTLEMENT_TRANSFER_IN_FLIGHT_TRIAGE_REASON
    ? existing.triageReason
    : null;
}

function buildIdempotencyKey(
  operation: DisputeLifecycleOperation,
  input: StripeDisputeLifecycleInput,
): string {
  return `stripe-dispute:${input.stripeEventId ?? `${operation}:${input.stripeDisputeId}`}`;
}

async function resolveDisputeContext(
  tx: TxRepos,
  input: StripeDisputeLifecycleInput,
  existing: DisputeRecord | null,
): Promise<ResolvedDisputeContext> {
  const order = await resolveOrder(tx, input, existing);
  if (!order) {
    return {
      order: null,
      event: null,
      owner: null,
      triageReason: "order_not_found",
    };
  }

  if (input.metadataEventId && input.metadataEventId !== order.eventId) {
    return {
      order,
      event: null,
      owner: null,
      triageReason: "metadata_event_mismatch",
    };
  }

  // Disputes are one of the few order flows that legitimately span BOTH kinds:
  // a membership invoice can be charged back exactly like a ticket, and the
  // fee-bearer split below depends on telling them apart. So this must not
  // demand a ticketing order — a membership dispute simply has no event, and
  // its owner is resolved from the order's payee rather than from an event.
  const event = order.eventId
    ? await tx.events.getById(order.eventId)
    : null;
  if (!event) {
    if (order.kind === "MEMBERSHIP") {
      const owner = await deriveMembershipOwner(tx, order.id);
      if (owner) {
        return { order, event: null, owner, triageReason: null };
      }
      // Replaces the old blanket `membership_no_event` reason (nothing else
      // consumed it): having no event is NORMAL for a membership order, so
      // triage now only fires when the order's splits cannot identify a
      // single payee to hold/debit — no splits, several payees, or a split
      // pointing at a payee row that no longer exists.
      return {
        order,
        event: null,
        owner: null,
        triageReason: "membership_owner_unresolved",
      };
    }
    return {
      order,
      event: null,
      owner: null,
      triageReason: "event_not_found",
    };
  }

  const owner = deriveOwner(event);
  if (!owner) {
    return {
      order,
      event,
      owner: null,
      triageReason: "event_owner_not_found",
    };
  }

  return { order, event, owner, triageReason: null };
}

async function resolveOrder(
  tx: TxRepos,
  input: StripeDisputeLifecycleInput,
  existing: DisputeRecord | null,
): Promise<OrderRecord | null> {
  if (existing?.orderId) {
    const order = await tx.orders.getById(existing.orderId);
    if (order) return order;
  }

  if (input.paymentIntentId) {
    const orderRef = await tx.orders.findByPaymentIntent(input.paymentIntentId);
    if (orderRef) {
      const order = await tx.orders.getById(orderRef.id);
      if (order) return order;
    }
  }

  if (input.metadataOrderId) {
    return tx.orders.getById(input.metadataOrderId);
  }

  return null;
}

// A membership order has no event, so its owner is whoever the money was
// split to. Memberships are single-payee by construction; zero or several
// distinct payees means the splits cannot identify one debit target, which is
// exactly what NEEDS_TRIAGE exists for — return null and let the caller
// triage rather than guess with someone's balance.
async function deriveMembershipOwner(
  tx: TxRepos,
  orderId: string,
): Promise<ResolvedOwner | null> {
  const splits = await tx.splits.getForOrder(orderId);
  const payeeIds = [
    ...new Set(
      splits
        .filter((split) => split.amountCents > 0)
        .map((split) => split.payeeId),
    ),
  ];
  const [payeeId] = payeeIds;
  if (payeeIds.length !== 1 || !payeeId) return null;

  const payee = await tx.payees.getById(payeeId);
  if (!payee) return null;

  if (payee.subjectType === "ORGANIZATION") {
    return {
      ownerSubjectType: "ORGANIZATION",
      ownerSubjectId: payee.subjectId,
      ownerOrgId: payee.subjectId,
      ownerHumanId: null,
    };
  }

  return {
    ownerSubjectType: "HUMAN",
    ownerSubjectId: payee.subjectId,
    ownerOrgId: null,
    ownerHumanId: payee.subjectId,
  };
}

function deriveOwner(event: EventRecord): ResolvedOwner | null {
  if (event.orgId) {
    return {
      ownerSubjectType: "ORGANIZATION",
      ownerSubjectId: event.orgId,
      ownerOrgId: event.orgId,
      ownerHumanId: null,
    };
  }

  if (event.humanId) {
    return {
      ownerSubjectType: "HUMAN",
      ownerSubjectId: event.humanId,
      ownerOrgId: null,
      ownerHumanId: event.humanId,
    };
  }

  return null;
}

function buildStoredMetadata(
  input: StripeDisputeLifecycleInput,
  operation: DisputeLifecycleOperation,
  settlementTransferBoundary: SettlementTransferBoundary | null,
): Record<string, unknown> {
  return {
    ...(input.metadata ?? {}),
    lastStripeEventId: input.stripeEventId ?? null,
    lastLifecycleOperation: operation,
    stripeStatus: input.stripeStatus ?? null,
    isWarning: input.isWarning,
    settlementTransferBoundary: settlementTransferBoundary
      ? {
          ...settlementTransferBoundary,
          requiresManualReview: true,
        }
      : null,
  };
}
