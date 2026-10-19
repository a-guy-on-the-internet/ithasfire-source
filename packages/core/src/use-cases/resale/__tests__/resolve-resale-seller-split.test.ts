import { describe, expect, it, vi } from "vitest";

import {
  mergeSellerIntoSplits,
  resolveResaleSellerSplit,
} from "../resolve-resale-seller-split";

const ORDER_ID = "22222222-2222-4222-8222-222222222222";

function ticketItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "item-1",
    kind: "ticket",
    resaleListingId: "listing-1",
    // A $60 ask under a 10% SELLER share (FR-005).
    meta: { resaleAskPriceCents: 6000 },
    resaleFaceValueCents: 4000,
    eventShareCents: 600,
    sharePayer: "SELLER",
    ...overrides,
  };
}

function makeTx(listing: { sellerHumanId: string } | null = { sellerHumanId: "seller-h" }) {
  return {
    resaleListings: { getById: vi.fn(async () => listing) },
    payees: {
      getBySubject: vi.fn(async () => ({ id: "payee-seller" })),
      upsertForSubject: vi.fn(),
    },
  };
}

const resolve = (tx: ReturnType<typeof makeTx>, items: unknown[], basisCents = 6000) =>
  resolveResaleSellerSplit(tx as never, {
    order: { id: ORDER_ID, eventId: "event-1", items } as never,
    basisCents,
  });

describe("resolveResaleSellerSplit", () => {
  it("returns the seller's exact share and the organiser side", async () => {
    await expect(resolve(makeTx(), [ticketItem()])).resolves.toMatchObject({
      sellerPayeeId: "payee-seller",
      sellerHumanId: "seller-h",
      sellerCents: 5400,
      organiserShareCents: 600,
      placeholderPayeeCreated: false,
    });
  });

  it("falls back to the legacy meta listing id", async () => {
    const tx = makeTx();
    await resolve(tx, [
      ticketItem({ resaleListingId: null, meta: { resaleListingId: "listing-legacy" } }),
    ]);
    expect(tx.resaleListings.getById).toHaveBeenCalledWith("listing-legacy");
  });

  it.each([
    { label: "no ticket item", items: [] },
    { label: "two ticket items", items: [ticketItem(), ticketItem({ id: "item-2" })] },
  ])("fails closed with $label", async ({ items }) => {
    await expect(resolve(makeTx(), items)).rejects.toMatchObject({
      code: "RESALE_PURCHASE_PRICE_UNKNOWN",
      meta: expect.objectContaining({ reason: "resale_order_ticket_item_count" }),
    });
  });

  it("fails closed when the listing is gone (no seller to pay)", async () => {
    await expect(resolve(makeTx(null), [ticketItem()])).rejects.toMatchObject({
      code: "LISTING_NOT_FOUND",
    });
  });

  it("fails closed when the item has no listing id at all", async () => {
    await expect(
      resolve(makeTx(), [ticketItem({ resaleListingId: null, meta: {} })]),
    ).rejects.toMatchObject({ code: "LISTING_NOT_FOUND" });
  });

  it("fails closed on a negative share", async () => {
    await expect(
      resolve(makeTx(), [ticketItem({ eventShareCents: -100 })]),
    ).rejects.toMatchObject({ code: "RESALE_PURCHASE_PRICE_UNKNOWN" });
  });

  it("fails closed on an item priced under the removed markup split (no share): never a guessed split", async () => {
    const tx = makeTx();
    await expect(
      resolve(tx, [ticketItem({ eventShareCents: null, sharePayer: null })]),
    ).rejects.toMatchObject({
      code: "RESALE_PURCHASE_PRICE_UNKNOWN",
      meta: expect.objectContaining({ reason: "resale_share_snapshot_missing" }),
    });
    // Refused before any seller lookup or placeholder payee.
    expect(tx.resaleListings.getById).not.toHaveBeenCalled();
    expect(tx.payees.upsertForSubject).not.toHaveBeenCalled();
  });
});

describe("mergeSellerIntoSplits", () => {
  it("appends the seller as a new row", () => {
    expect(
      mergeSellerIntoSplits([{ payeeId: "org", amountCents: 1000 }], {
        payeeId: "seller",
        amountCents: 5000,
      }),
    ).toEqual([
      { payeeId: "org", amountCents: 1000 },
      { payeeId: "seller", amountCents: 5000 },
    ]);
  });

  it("folds into an existing row for the same payee and does not mutate the input", () => {
    const input = [{ payeeId: "seller", amountCents: 500 }];
    expect(
      mergeSellerIntoSplits(input, { payeeId: "seller", amountCents: 5000 }),
    ).toEqual([{ payeeId: "seller", amountCents: 5500 }]);
    expect(input).toEqual([{ payeeId: "seller", amountCents: 500 }]);
  });

  it("adds nothing for a zero seller amount", () => {
    expect(
      mergeSellerIntoSplits([{ payeeId: "org", amountCents: 0 }], {
        payeeId: "seller",
        amountCents: 0,
      }),
    ).toEqual([{ payeeId: "org", amountCents: 0 }]);
  });
});
