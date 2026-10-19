import { createHash } from "node:crypto";

import { fail, isAppError } from "@th/errors";
import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { DisputeStatus } from "@th/types/repos/disputes";

import { describeError } from "../../../lib/io";
import { isBlockedSettlementDisputeStatus } from "../../settlements/dispute-statuses";

/**
 * Pre-flight for every refund-creating path: an order whose charge is under
 * an OPEN / UNDER_REVIEW / LOST dispute cannot be refunded. Stripe refuses
 * the refund outright (`charge_disputed`), so refusing here — BEFORE any
 * PaymentIntent refund attempt, transfer reversal, or ledger write — turns a
 * generic dependency failure into a typed, explained refusal.
 *
 * WON / WARNING_* / null do not block: the charge is refundable again once
 * the dispute closes in our favour, and an early-warning is not a dispute.
 *
 * Placement contract: callers run this AFTER their idempotency replay lookup
 * (a replay of an already-completed refund must still return the stored
 * result) and BEFORE any status / eligibility check, so a disputed order
 * surfaces the dispute rather than a less specific refusal.
 */
export function assertOrderNotDisputeBlocked(order: {
  id: string;
  stripePaymentIntentId: string | null;
  disputeStatus?: DisputeStatus | null;
}): void {
  if (isBlockedSettlementDisputeStatus(order.disputeStatus)) {
    throw fail("ORDER_DISPUTED_REFUND_BLOCKED", {
      meta: {
        orderId: order.id,
        paymentIntentId: order.stripePaymentIntentId,
        disputeStatus: order.disputeStatus,
      },
    });
  }
}

/**
 * `callOrDependencyFailed` for the PaymentIntent refund call, with one
 * exception: the adapter's typed ORDER_DISPUTED_REFUND_BLOCKED (a dispute
 * opened between our pre-flight and Stripe's refusal) passes through intact
 * instead of being flattened to `dependency_failed`. Every other failure —
 * network, auth, `charge_already_refunded` — is wrapped exactly as before.
 */
export async function refundPaymentIntentOrDependencyFailed(
  payments: PaymentProcessorPort,
  input: Parameters<PaymentProcessorPort["refundPaymentIntent"]>[0],
  logger: LoggerPort | undefined,
  context: { action: string; orderId: string; paymentIntentId: string | null },
): ReturnType<PaymentProcessorPort["refundPaymentIntent"]> {
  try {
    return await payments.refundPaymentIntent(input);
  } catch (error) {
    if (isAppError(error) && error.code === "ORDER_DISPUTED_REFUND_BLOCKED") {
      throw error;
    }
    logger?.error("dependency_failed", {
      ...context,
      error: describeError(error),
    });
    throw { code: "dependency_failed", message: context.action } as const;
  }
}

// ── Refund metadata: the refund names the items it paid back ────────────────
//
// Money audit 2026-09-08 #10. Every refund-creating path calls Stripe FIRST
// and marks items refunded in a local transaction AFTER. If that transaction
// dies, the money has moved but the DB still reads the items `active`, and a
// later request under a DIFFERENT idempotency key (a buyer asking for
// `[A, B]` after `[A]`, or the org path's separate key namespace) quotes A
// again — Stripe only caps at the charge total, so A is refunded twice.
// Stamping the item ids on the refund lets the `charge.refunded` reconciler
// flip exactly those items, closing the window. Transfer reversals already
// carry the same identity (`reverse-transfers-for-items.ts`).

/** Stripe caps each metadata VALUE at 500 characters. */
export const STRIPE_METADATA_VALUE_MAX_CHARS = 500;

/**
 * Stripe caps a metadata OBJECT at 50 keys. Five are fixed (`useCase`,
 * `orderId`, `orderItemCount`, `orderItemChunks`, `orderItemIdsHash`); the
 * rest may carry id chunks. 13 UUIDs fit one value (13 × 36 + 12 = 480), so
 * 40 chunks hold 520 ids — the item-refund schema caps a request at 100.
 */
const MAX_ORDER_ITEM_ID_CHUNKS = 40;

const ORDER_ITEM_IDS_KEY = "orderItemIds";

function orderItemIdsChunkKey(index: number): string {
  return index === 0 ? ORDER_ITEM_IDS_KEY : `${ORDER_ITEM_IDS_KEY}${index + 1}`;
}

function hashOrderItemIds(sortedJoined: string): string {
  return createHash("sha256").update(sortedJoined).digest("hex");
}

export type RefundMetadataUseCase =
  | "refundOrderItems"
  | "refundFullOrder"
  | "reviewClaim"
  /**
   * Event cancellation. Its refund withholds the Stripe fee, so Stripe reads
   * it as PARTIAL and the reconciler's partial arm heals a cancellation whose
   * marking tx died — but only for the items the refund NAMES.
   */
  | "cancelEvent";

/**
 * Build the metadata stamped on a Stripe refund.
 *
 * Shape (every value a string):
 *   useCase, orderId, orderItemCount, orderItemIds — the SORTED ids joined
 *   with ",". When the joined list would exceed Stripe's 500-char value cap
 *   (14+ UUIDs) it is split across `orderItemIds`, `orderItemIds2`,
 *   `orderItemIds3`, … (each ≤ 500 chars), with `orderItemChunks` (count)
 *   and `orderItemIdsHash` (SHA-256 hex of the full sorted joined list) so
 *   the reader can prove it reassembled the whole list. A list that would
 *   need more than {@link MAX_ORDER_ITEM_ID_CHUNKS} chunks falls back to the
 *   hash alone (logged) — the reconciler then cannot flip items, only the
 *   ledger debit lands, which is today's behaviour.
 *
 * Never affects the refund amount or idempotency key.
 */
export function buildRefundMetadata(input: {
  useCase: RefundMetadataUseCase;
  orderId: string;
  orderItemIds: readonly string[];
  logger?: LoggerPort;
}): Record<string, string> {
  const sorted = [...new Set(input.orderItemIds)].sort();
  const base: Record<string, string> = {
    useCase: input.useCase,
    orderId: input.orderId,
    orderItemCount: String(sorted.length),
  };
  const joined = sorted.join(",");
  if (joined.length <= STRIPE_METADATA_VALUE_MAX_CHARS) {
    return { ...base, [ORDER_ITEM_IDS_KEY]: joined };
  }

  const chunks: string[] = [];
  let current = "";
  for (const id of sorted) {
    const candidate = current === "" ? id : `${current},${id}`;
    if (candidate.length > STRIPE_METADATA_VALUE_MAX_CHARS) {
      chunks.push(current);
      current = id;
    } else {
      current = candidate;
    }
  }
  if (current !== "") {
    chunks.push(current);
  }

  const orderItemIdsHash = hashOrderItemIds(joined);
  if (chunks.length > MAX_ORDER_ITEM_ID_CHUNKS) {
    input.logger?.error("refund_metadata_item_list_too_long_hash_only", {
      useCase: input.useCase,
      orderId: input.orderId,
      orderItemCount: sorted.length,
      chunks: chunks.length,
    });
    return { ...base, orderItemIdsHash };
  }

  const out: Record<string, string> = {
    ...base,
    orderItemChunks: String(chunks.length),
    orderItemIdsHash,
  };
  chunks.forEach((chunk, index) => {
    out[orderItemIdsChunkKey(index)] = chunk;
  });
  input.logger?.info("refund_metadata_item_list_chunked", {
    useCase: input.useCase,
    orderId: input.orderId,
    orderItemCount: sorted.length,
    chunks: chunks.length,
  });
  return out;
}

export type ParsedRefundMetadata =
  /** No item identity on the refund (dashboard refund, pre-deploy refund). */
  | { kind: "absent" }
  /** Identity present but not trustworthy — the reader must not act on it. */
  | {
      kind: "unusable";
      reason:
        | "hash_only"
        | "chunk_count_mismatch"
        | "hash_mismatch"
        | "count_mismatch"
        | "empty";
    }
  | {
      kind: "named";
      useCase: string | null;
      orderId: string | null;
      orderItemIds: string[];
    };

/**
 * Inverse of {@link buildRefundMetadata}: reassemble the chunked id list and
 * verify it against the stamped hash. Untrusted input — Stripe metadata is
 * editable in the dashboard — so anything that does not add up is
 * `unusable`, never a best guess.
 */
export function parseRefundMetadataOrderItemIds(
  metadata: Record<string, string> | null | undefined,
): ParsedRefundMetadata {
  if (!metadata) {
    return { kind: "absent" };
  }
  const first = metadata[ORDER_ITEM_IDS_KEY];
  const stampedHash = metadata.orderItemIdsHash;
  if (first === undefined) {
    return stampedHash === undefined
      ? { kind: "absent" }
      : { kind: "unusable", reason: "hash_only" };
  }

  const chunks: string[] = [];
  for (let index = 0; ; index++) {
    const chunk = metadata[orderItemIdsChunkKey(index)];
    if (chunk === undefined) {
      break;
    }
    chunks.push(chunk);
  }
  const stampedChunks = metadata.orderItemChunks;
  if (
    stampedChunks !== undefined &&
    Number.parseInt(stampedChunks, 10) !== chunks.length
  ) {
    return { kind: "unusable", reason: "chunk_count_mismatch" };
  }

  const joined = chunks.join(",");
  if (stampedHash !== undefined && hashOrderItemIds(joined) !== stampedHash) {
    return { kind: "unusable", reason: "hash_mismatch" };
  }

  const orderItemIds = joined.split(",").filter((id) => id.length > 0);
  if (orderItemIds.length === 0) {
    return { kind: "unusable", reason: "empty" };
  }
  // Free integrity check on both paths: the writer stamps the count.
  const stampedCount = metadata.orderItemCount;
  if (
    stampedCount !== undefined &&
    Number.parseInt(stampedCount, 10) !== orderItemIds.length
  ) {
    return { kind: "unusable", reason: "count_mismatch" };
  }

  return {
    kind: "named",
    useCase: metadata.useCase ?? null,
    orderId: metadata.orderId ?? null,
    orderItemIds,
  };
}
