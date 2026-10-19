import { describe, expect, it, vi } from "vitest";

import type { ClaimStatus } from "@th/ports/repos/claims";

import { ensureTicketNotUnderClaim } from "../ensure-ticket-not-under-claim";

const ORDER_ITEM_ID = "00000000-0000-4000-8000-0000000000c1";
const ORDER_ID = "00000000-0000-4000-8000-0000000000d1";

function makeTx(opts: {
  claimStatus: ClaimStatus | null;
  orderStatus?: string | null;
}) {
  const calls: string[] = [];
  const tx = {
    claims: {
      lockOrderItem: vi.fn(async () => {
        calls.push("lock");
      }),
      getByOrderItemId: vi.fn(async () => {
        calls.push("read");
        return opts.claimStatus
          ? { orderItemId: ORDER_ITEM_ID, orderId: ORDER_ID, status: opts.claimStatus }
          : null;
      }),
    },
    orders: {
      getById: vi.fn(async () =>
        opts.orderStatus ? { id: ORDER_ID, status: opts.orderStatus } : null,
      ),
    },
  };
  // The helper only touches these three methods.
  return { tx: tx as never, raw: tx, calls };
}

describe("ensureTicketNotUnderClaim", () => {
  it("passes without a lock when the ticket has no order item", async () => {
    const { tx, raw } = makeTx({ claimStatus: "open" });
    await expect(
      ensureTicketNotUnderClaim(tx, { orderItemId: null }),
    ).resolves.toBeUndefined();
    expect(raw.claims.lockOrderItem).not.toHaveBeenCalled();
  });

  it("takes the lock before reading the claim", async () => {
    const { tx, calls } = makeTx({ claimStatus: null });
    await ensureTicketNotUnderClaim(tx, { orderItemId: ORDER_ITEM_ID });
    expect(calls).toEqual(["lock", "read"]);
  });

  it.each(["open", "under_review"] as const)(
    "refuses while the claim is %s",
    async (claimStatus) => {
      const { tx } = makeTx({ claimStatus, orderStatus: "REFUNDED" });
      await expect(
        ensureTicketNotUnderClaim(tx, { orderItemId: ORDER_ITEM_ID }),
      ).rejects.toMatchObject({ code: "TICKET_UNDER_CLAIM" });
    },
  );

  it.each(["SUCCEEDED", "PART_REFUNDED", "DISPUTED", null] as const)(
    "refuses an approved claim while its order is %s (null = missing)",
    async (orderStatus) => {
      const { tx, raw } = makeTx({ claimStatus: "approved", orderStatus });
      await expect(
        ensureTicketNotUnderClaim(tx, { orderItemId: ORDER_ITEM_ID }),
      ).rejects.toMatchObject({ code: "TICKET_UNDER_CLAIM" });
      expect(raw.orders.getById).toHaveBeenCalledWith(ORDER_ID);
    },
  );

  it("frees the ticket once an approved claim's order is REFUNDED", async () => {
    const { tx, raw } = makeTx({ claimStatus: "approved", orderStatus: "REFUNDED" });
    await expect(
      ensureTicketNotUnderClaim(tx, { orderItemId: ORDER_ITEM_ID }),
    ).resolves.toBeUndefined();
    expect(raw.orders.getById).toHaveBeenCalledWith(ORDER_ID);
  });

  it.each(["denied", "expired"] as const)(
    "frees the ticket once the claim is %s",
    async (claimStatus) => {
      const { tx, raw } = makeTx({ claimStatus, orderStatus: "SUCCEEDED" });
      await expect(
        ensureTicketNotUnderClaim(tx, { orderItemId: ORDER_ITEM_ID }),
      ).resolves.toBeUndefined();
      expect(raw.orders.getById).not.toHaveBeenCalled();
    },
  );

  it("passes when the order item has no claim", async () => {
    const { tx } = makeTx({ claimStatus: null });
    await expect(
      ensureTicketNotUnderClaim(tx, { orderItemId: ORDER_ITEM_ID }),
    ).resolves.toBeUndefined();
  });
});
