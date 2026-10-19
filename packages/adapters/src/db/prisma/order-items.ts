import type {
  OrderItemsRepo,
  OrderItemRecord,
  OrderItemStatus,
} from "@th/ports/repos/order-items";
import type {
  ResaleSharePayer,
  ResaleShareType,
} from "@th/ports/repos/payout-terms";

import type { PrismaClientOrTx } from "./types";

export function makeOrderItemsRepo(p: PrismaClientOrTx): OrderItemsRepo {
  return {
    fillResaleClauseIfUnset: async (itemId, record) => {
      // The guard IS the once-only rule (FR-004): a racing fill blocks on
      // the row lock, re-checks `resaleClauseType IS NULL` after the winner
      // commits, and matches nothing. `originalUnitPriceCents` is written
      // with the clause because the complete-check CHECK requires it.
      const { count } = await p.orderItem.updateMany({
        where: { id: itemId, resaleClauseType: null },
        data: {
          resaleClauseType: record.resaleClauseType,
          resaleClauseBps: record.resaleClauseBps,
          resaleClauseCents: record.resaleClauseCents,
          resaleClausePayer: record.resaleClausePayer,
          resaleClauseTermsId: record.resaleClauseTermsId,
          resaleClauseTermsVersion: record.resaleClauseTermsVersion,
          originalUnitPriceCents: record.originalUnitPriceCents,
        },
      });
      return count === 1;
    },

    markItemsPaidOut: async (itemIds: string[], paidOutAt: Date) => {
      // `paidOutAt: null` guard: the stamp is written ONCE, ever. The payout
      // batch's ledger-heal sweep may legitimately replay this write for an
      // item whose other ledger effects were lost to a crash; without the
      // guard a replay restamps history to tonight, corrupting the record of
      // when the money actually moved.
      await p.orderItem.updateMany({
        where: { id: { in: itemIds }, paidOutAt: null },
        data: { paidOutAt },
      });
    },

    setResaleListingId: async (
      itemId: string,
      resaleListingId: string | null,
    ) => {
      await p.orderItem.update({
        where: { id: itemId },
        data: { resaleListingId },
      });
    },

    updateStatus: async (
      itemId: string,
      status: OrderItemStatus,
      timestamp: Date,
      refundedTaxCents?: number | null,
      refundedPlatformFeeCents?: number | null,
      options?: { expectedStatus?: OrderItemStatus },
    ) => {
      const data: {
        status: string;
        refundedAt?: Date | null;
        transferredAt?: Date | null;
        refundedTaxCents?: number | null;
        refundedPlatformFeeCents?: number | null;
      } = { status };
      if (status === "refunded") {
        data.refundedAt = timestamp;
        // `?? null` rather than leaving the key off: a refund path that
        // attributes nothing must land as NULL ("not attributed"), and a
        // re-refund must never inherit a stale share from an earlier one.
        // The platform-fee stamp follows the identical rule — and for it a
        // NULL read as 0 would OVERSTATE platform revenue, so the distinction
        // is load-bearing, not cosmetic.
        data.refundedTaxCents = refundedTaxCents ?? null;
        data.refundedPlatformFeeCents = refundedPlatformFeeCents ?? null;
      } else if (status === "transferred") {
        data.transferredAt = timestamp;
        data.refundedTaxCents = null;
        data.refundedPlatformFeeCents = null;
      } else {
        data.refundedAt = null;
        data.transferredAt = null;
        data.refundedTaxCents = null;
        data.refundedPlatformFeeCents = null;
      }
      // Two shapes, on purpose. Without `expectedStatus` this stays the exact
      // `update` it has always been — same query, same P2025 on a missing row —
      // because every refund caller has already moved money at Stripe and must
      // not be able to fail here. With it, the predicate makes the write a
      // compare-and-swap (`updateMany` is the only form that can carry one),
      // so a transfer racing a refund loses instead of overwriting it.
      const expectedStatus = options?.expectedStatus;
      if (expectedStatus === undefined) {
        await p.orderItem.update({
          where: { id: itemId },
          data,
        });
        return true;
      }

      const result = await p.orderItem.updateMany({
        where: { id: itemId, status: expectedStatus },
        data,
      });
      return result.count > 0;
    },

    bulkUpdateStatus: async (
      itemIds: string[],
      status: OrderItemStatus,
      timestamp: Date,
    ) => {
      if (itemIds.length === 0) return;
      const data: {
        status: string;
        refundedAt?: Date | null;
        transferredAt?: Date | null;
        refundedTaxCents?: number | null;
        refundedPlatformFeeCents?: number | null;
      } = { status };
      if (status === "refunded") {
        data.refundedAt = timestamp;
        // No per-item tax attribution is possible in a bulk write — one
        // amount cannot describe N different shares — so these refunds land
        // as NULL, "not attributed". Written explicitly rather than left off:
        // relying on the row already being NULL would make this method inherit
        // a stale attribution the day any path leaves one behind. The
        // platform-fee stamp is NULL for the same reason.
        data.refundedTaxCents = null;
        data.refundedPlatformFeeCents = null;
      } else if (status === "transferred") {
        data.transferredAt = timestamp;
        data.refundedTaxCents = null;
        data.refundedPlatformFeeCents = null;
      } else {
        data.refundedAt = null;
        data.transferredAt = null;
        data.refundedTaxCents = null;
        data.refundedPlatformFeeCents = null;
      }
      await p.orderItem.updateMany({
        where: { id: { in: itemIds } },
        data,
      });
    },

    // Seat history. `Ticket.seatId` has to be cleared when a ticket is voided
    // (it is @unique, and a dead row holding it fails the next buyer's mint
    // after they are charged), which would otherwise erase which seat the
    // order sold. Read-modify-write rather than a raw `jsonb_set`: `meta` is a
    // free-form bag and a blind write would drop the rest of it. Safe here —
    // the caller has already updated these same rows in this transaction, so
    // it holds the row locks.
    recordReleasedSeats: async (entries) => {
      if (entries.length === 0) return;

      const byId = new Map(entries.map((e) => [e.orderItemId, e.seatId]));
      const rows = await p.orderItem.findMany({
        where: { id: { in: [...byId.keys()] } },
        select: { id: true, meta: true },
      });

      for (const row of rows) {
        const existing =
          row.meta != null && typeof row.meta === "object"
            ? (row.meta as Record<string, unknown>)
            : {};
        await p.orderItem.update({
          where: { id: row.id },
          data: { meta: { ...existing, releasedSeatId: byId.get(row.id) } },
        });
      }
    },

    listByOrderId: async (orderId: string) => {
      const items = await p.orderItem.findMany({
        where: { orderId },
        orderBy: { id: "asc" },
      });
      return items.map(mapOrderItem);
    },

    getById: async (itemId: string) => {
      const item = await p.orderItem.findUnique({
        where: { id: itemId },
      });
      if (!item) return null;
      return mapOrderItem(item);
    },
  };
}

const mapOrderItem = (item: {
  id: string;
  orderId: string;
  kind: string;
  ticketTypeId: string | null;
  qty: number;
  unitPriceCents: number;
  amountCents: number;
  meta: unknown;
  paidOutAt: Date | null;
  refundedAt: Date | null;
  refundedTaxCents: number | null;
  transferredAt: Date | null;
  resaleListingId: string | null;
  resaleFaceValueCents: number | null;
  resaleProcessingPassThroughCents: number;
  resaleProcessingFeeConfigRef: string | null;
  resaleSaleCutoffAt: Date | null;
  resalePayoutReleaseAt: Date | null;
  resalePayoutStatus: string | null;
  resalePayoutHeldAt: Date | null;
  resalePayoutHoldReason: string | null;
  resalePayoutNoticeSentAt: Date | null;
  resalePayoutReminderSentAt: Date | null;
  resalePayoutFinalNoticeSentAt: Date | null;
  resaleClauseType: ResaleShareType | null;
  resaleClauseBps: number | null;
  resaleClauseCents: number | null;
  resaleClausePayer: ResaleSharePayer | null;
  resaleClauseTermsId: string | null;
  resaleClauseTermsVersion: number | null;
  originalUnitPriceCents: number | null;
  eventShareCents: number | null;
  sharePayer: ResaleSharePayer | null;
  status: string;
}): OrderItemRecord => ({
  id: item.id,
  orderId: item.orderId,
  kind: item.kind as OrderItemRecord["kind"],
  ticketTypeId: item.ticketTypeId,
  qty: item.qty,
  unitPriceCents: item.unitPriceCents,
  amountCents: item.amountCents,
  meta: item.meta,
  paidOutAt: item.paidOutAt,
  refundedAt: item.refundedAt,
  refundedTaxCents: item.refundedTaxCents,
  transferredAt: item.transferredAt,
  resaleListingId: item.resaleListingId,
  resaleFaceValueCents: item.resaleFaceValueCents,
  resaleProcessingPassThroughCents: item.resaleProcessingPassThroughCents,
  resaleProcessingFeeConfigRef: item.resaleProcessingFeeConfigRef,
  resaleSaleCutoffAt: item.resaleSaleCutoffAt,
  resalePayoutReleaseAt: item.resalePayoutReleaseAt,
  resalePayoutStatus:
    (item.resalePayoutStatus as OrderItemRecord["resalePayoutStatus"]) ?? null,
  resalePayoutHeldAt: item.resalePayoutHeldAt,
  resalePayoutHoldReason: item.resalePayoutHoldReason,
  resalePayoutNoticeSentAt: item.resalePayoutNoticeSentAt,
  resalePayoutReminderSentAt: item.resalePayoutReminderSentAt,
  resalePayoutFinalNoticeSentAt: item.resalePayoutFinalNoticeSentAt,
  // ── Resale share record (organiser-resale-share FR-003) ──
  resaleClauseType: item.resaleClauseType,
  resaleClauseBps: item.resaleClauseBps,
  resaleClauseCents: item.resaleClauseCents,
  resaleClausePayer: item.resaleClausePayer,
  resaleClauseTermsId: item.resaleClauseTermsId,
  resaleClauseTermsVersion: item.resaleClauseTermsVersion,
  originalUnitPriceCents: item.originalUnitPriceCents,
  eventShareCents: item.eventShareCents,
  sharePayer: item.sharePayer,
  status: item.status as OrderItemRecord["status"],
});
