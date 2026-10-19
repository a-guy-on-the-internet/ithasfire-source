import { describe, expect, it, vi } from "vitest";

import type { TxRepos } from "@th/ports/repos";

import {
  itemPointerIsBoughtThrough,
  setListedNowPointer,
} from "../order-item-listing-pointer";

const ITEM_ID = "item-1";
const ORDER_ID = "order-1";
const LISTING_ID = "listing-1";

function makeTx(opts: {
  /** `Order.source` behind the item; `null` = the order cannot be read. */
  orderSource?: string | null;
  itemMissing?: boolean;
}) {
  const setResaleListingId = vi.fn(async () => undefined);
  const getItemById = vi.fn(async () =>
    opts.itemMissing ? null : { id: ITEM_ID, orderId: ORDER_ID },
  );
  const getOrderById = vi.fn(async () =>
    opts.orderSource == null ? null : { id: ORDER_ID, source: opts.orderSource },
  );
  const tx = {
    orderItems: { setResaleListingId, getById: getItemById },
    orders: { getById: getOrderById },
  } as unknown as Pick<TxRepos, "orderItems" | "orders">;
  return { tx, setResaleListingId, getItemById, getOrderById };
}

describe("itemPointerIsBoughtThrough", () => {
  it("is true only for an item of a RESALE order", () => {
    expect(itemPointerIsBoughtThrough("RESALE")).toBe(true);
    for (const source of ["PRIMARY", "COMP", "POS", "UNKNOWN", null, undefined]) {
      expect(itemPointerIsBoughtThrough(source)).toBe(false);
    }
  });
});

// Owner ruling 2026-10-11: a ticket bought on resale can be listed again.
// A RESALE item's `resaleListingId` is the listing it was bought through, and
// the refund unwind reads it; no "listed now" write may land on it.
describe("setListedNowPointer", () => {
  it.each([LISTING_ID, null])(
    "never writes %s onto an item of a RESALE order (source read here)",
    async (listingId) => {
      const { tx, setResaleListingId, getItemById, getOrderById } = makeTx({
        orderSource: "RESALE",
      });

      const written = await setListedNowPointer(tx, {
        orderItemId: ITEM_ID,
        listingId,
      });

      expect(written).toBe(false);
      expect(setResaleListingId).not.toHaveBeenCalled();
      expect(getItemById).toHaveBeenCalledWith(ITEM_ID);
      expect(getOrderById).toHaveBeenCalledWith(ORDER_ID);
    },
  );

  it.each([LISTING_ID, null])(
    "never writes %s onto an item of a RESALE order (source passed in)",
    async (listingId) => {
      const { tx, setResaleListingId, getItemById, getOrderById } = makeTx({});

      const written = await setListedNowPointer(tx, {
        orderItemId: ITEM_ID,
        listingId,
        orderSource: "RESALE",
      });

      expect(written).toBe(false);
      expect(setResaleListingId).not.toHaveBeenCalled();
      // The caller already held the order: no reads.
      expect(getItemById).not.toHaveBeenCalled();
      expect(getOrderById).not.toHaveBeenCalled();
    },
  );

  it.each(["PRIMARY", "COMP"])(
    "writes and clears the pointer of a %s item",
    async (orderSource) => {
      const { tx, setResaleListingId } = makeTx({ orderSource });

      expect(
        await setListedNowPointer(tx, {
          orderItemId: ITEM_ID,
          listingId: LISTING_ID,
        }),
      ).toBe(true);
      expect(
        await setListedNowPointer(tx, {
          orderItemId: ITEM_ID,
          listingId: null,
          orderSource,
        }),
      ).toBe(true);

      expect(setResaleListingId.mock.calls).toEqual([
        [ITEM_ID, LISTING_ID],
        [ITEM_ID, null],
      ]);
    },
  );

  // A stale "listed now" pointer on a PRIMARY item blocks its refunds, so an
  // item whose order cannot be read is written the way it always was.
  it("writes when the item or its order cannot be read", async () => {
    const noOrder = makeTx({ orderSource: null });
    expect(
      await setListedNowPointer(noOrder.tx, {
        orderItemId: ITEM_ID,
        listingId: null,
      }),
    ).toBe(true);
    expect(noOrder.setResaleListingId).toHaveBeenCalledWith(ITEM_ID, null);

    const noItem = makeTx({ itemMissing: true });
    expect(
      await setListedNowPointer(noItem.tx, {
        orderItemId: ITEM_ID,
        listingId: null,
      }),
    ).toBe(true);
    expect(noItem.getOrderById).not.toHaveBeenCalled();
    expect(noItem.setResaleListingId).toHaveBeenCalledWith(ITEM_ID, null);
  });
});
