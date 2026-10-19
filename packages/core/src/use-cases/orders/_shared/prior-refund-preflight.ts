import { fail } from "@th/errors";
import type { LoggerPort } from "@th/ports/logger";
import type {
  PaymentProcessorPort,
  PaymentRefundStatus,
} from "@th/ports/payment-processor-port";
import type { ReporterPort } from "@th/ports/reporter";

import { callOrDependencyFailed } from "../../../lib/io";
import { parseRefundMetadataOrderItemIds } from "./dispute-refund-guard";

// ── Retry pre-flight: was this refund already issued? ───────────────────────
//
// Money audit 2026-09-08 #10, second layer. Both buyer/org refund paths call
// Stripe FIRST and commit AFTER. When the commit dies, the use-case record
// is `failed` and the items still read `active`; a retry under a DIFFERENT
// idempotency key (the org path's namespace, a new client request id, or
// the same key past Stripe's 24h window) would quote them again and refund
// them twice. The first layer — `buildRefundMetadata` on every refund plus
// the `charge.refunded` reconciler flipping the named items — closes the
// hole once the webhook lands. This pre-flight closes the window BEFORE it
// lands: list the PaymentIntent's refunds, and if one already names exactly
// these items, reuse it as THE refund and go straight to the commit.
//
// Placement contract: AFTER the use-case idempotency claim and the quote
// (so the requested set and amount are final), BEFORE `refundPaymentIntent`.

export type PriorRefundPreflightResult =
  /** Nothing on the PaymentIntent pays for these items — issue a refund. */
  | { kind: "none" }
  /** A prior refund paid exactly these items — commit against it instead. */
  | { kind: "reuse"; refundId: string; status: PaymentRefundStatus };

/**
 * Find a refund already issued on the order's PaymentIntent for exactly the
 * items about to be refunded.
 *
 * Decision table over every refund the processor lists:
 *   - `failed` / `canceled`: moved no money — ignored.
 *   - no metadata (dashboard refund, pre-deploy refund): not ours — ignored.
 *   - metadata present but not reassemblable (see
 *     `parseRefundMetadataOrderItemIds`): logged + reported, ignored.
 *   - names a DIFFERENT order: invariant breach (one PaymentIntent, one
 *     order) → `REFUND_METADATA_ORDER_MISMATCH`, no refund issued.
 *   - names the SAME items for the SAME amount: `reuse`. `pending` is
 *     returned as-is so the caller's `ensureSucceededRefund` treats it the
 *     way it treats a fresh pending refund (transient → retry later).
 *   - overlaps the requested set only partly, or the same set for a
 *     different amount: `REFUND_ALREADY_ISSUED_FOR_ITEMS`. Reusing would
 *     stamp items whose money did not move (or the wrong amount); issuing
 *     would pay the overlap twice. The reconciler flips the paid items on
 *     the webhook, after which a fresh request quotes only what is live.
 *
 * A listing failure is a dependency failure and MUST propagate — swallowing
 * it would re-open the double refund this exists to prevent.
 */
export async function findPriorRefundForItems(
  deps: {
    payments: PaymentProcessorPort;
    logger?: LoggerPort;
    reportError?: ReporterPort | null;
  },
  input: {
    orderId: string;
    paymentIntentId: string;
    /** The items about to be refunded (the quote's set). */
    orderItemIds: readonly string[];
    /** The amount about to be sent to the processor for that set. */
    amountCents: number;
    /** The calling use case (log/report tag only). */
    useCase: string;
  },
): Promise<PriorRefundPreflightResult> {
  const { payments, logger } = deps;
  // Optional on the port: the not-configured stubs cannot refund at all and
  // the e2e stub processor moves no money — see the port doc.
  if (!payments.listRefundsForPaymentIntent) {
    return { kind: "none" };
  }

  const refunds = await callOrDependencyFailed(
    () => payments.listRefundsForPaymentIntent!({ paymentIntentId: input.paymentIntentId }),
    logger,
    {
      action: "list_refunds_for_payment_intent",
      orderId: input.orderId,
      paymentIntentId: input.paymentIntentId,
    },
  );

  const requested = new Set(input.orderItemIds);
  const reusable: Array<{ refundId: string; status: PaymentRefundStatus }> = [];

  for (const refund of refunds) {
    if (refund.status === "failed" || refund.status === "canceled") {
      continue;
    }
    const parsed = parseRefundMetadataOrderItemIds(refund.metadata);
    if (parsed.kind === "absent") {
      continue;
    }
    if (parsed.kind === "unusable") {
      // Stripe metadata is dashboard-editable, so a list that does not add
      // up is treated as unreadable rather than guessed at. Surfaced (not a
      // swallow of a thrown error, but a branch an operator must see); the
      // reconciler reports the same refund when its webhook lands.
      logger?.error("refund_preflight_metadata_unusable", {
        useCase: input.useCase,
        orderId: input.orderId,
        refundId: refund.refundId,
        reason: parsed.reason,
      });
      reportBestEffort(deps, new Error("refund_preflight_metadata_unusable"), {
        useCase: input.useCase,
        orderId: input.orderId,
        refundId: refund.refundId,
        reason: parsed.reason,
      });
      continue;
    }
    if (parsed.orderId !== null && parsed.orderId !== input.orderId) {
      throw fail("REFUND_METADATA_ORDER_MISMATCH", {
        meta: {
          orderId: input.orderId,
          paymentIntentId: input.paymentIntentId,
          refundId: refund.refundId,
          metadataOrderId: parsed.orderId,
        },
      });
    }

    const overlappingOrderItemIds = parsed.orderItemIds
      .filter((id) => requested.has(id))
      .sort();
    if (overlappingOrderItemIds.length === 0) {
      continue;
    }
    const sameSet =
      overlappingOrderItemIds.length === requested.size &&
      parsed.orderItemIds.length === requested.size;
    if (sameSet && refund.amountCents === input.amountCents) {
      reusable.push({ refundId: refund.refundId, status: refund.status });
      continue;
    }
    throw fail("REFUND_ALREADY_ISSUED_FOR_ITEMS", {
      meta: {
        orderId: input.orderId,
        paymentIntentId: input.paymentIntentId,
        refundId: refund.refundId,
        refundStatus: refund.status,
        overlappingOrderItemIds,
        priorOrderItemIds: [...parsed.orderItemIds].sort(),
        priorAmountCents: refund.amountCents,
        requestedOrderItemIds: [...requested].sort(),
        requestedAmountCents: input.amountCents,
      },
    });
  }

  if (reusable.length === 0) {
    return { kind: "none" };
  }
  if (reusable.length > 1) {
    // The double refund this guards against ALREADY happened (a pre-deploy
    // retry). The DB can only reflect one; the first listed (Stripe lists
    // most-recent-first) becomes THE refund and the rest are surfaced for
    // an operator to unwind — silently picking one would hide the loss.
    logger?.error("refund_preflight_multiple_prior_refunds", {
      useCase: input.useCase,
      orderId: input.orderId,
      paymentIntentId: input.paymentIntentId,
      refundIds: reusable.map((r) => r.refundId),
    });
    reportBestEffort(
      deps,
      new Error("refund_preflight_multiple_prior_refunds"),
      {
        useCase: input.useCase,
        orderId: input.orderId,
        paymentIntentId: input.paymentIntentId,
        refundIds: reusable.map((r) => r.refundId),
      },
    );
  }
  const chosen = reusable[0]!;
  logger?.info("refund_preflight_reusing_prior_refund", {
    useCase: input.useCase,
    orderId: input.orderId,
    paymentIntentId: input.paymentIntentId,
    refundId: chosen.refundId,
    refundStatus: chosen.status,
    orderItemIds: [...requested].sort(),
    amountCents: input.amountCents,
  });
  return { kind: "reuse", refundId: chosen.refundId, status: chosen.status };
}

function reportBestEffort(
  deps: { reportError?: ReporterPort | null },
  err: Error,
  extra: Record<string, unknown>,
): void {
  try {
    deps.reportError?.(err, {
      tags: { useCase: String(extra.useCase ?? ""), step: "priorRefundPreflight" },
      extra,
    });
  } catch {
    // A throwing reporter never changes behaviour.
  }
}
