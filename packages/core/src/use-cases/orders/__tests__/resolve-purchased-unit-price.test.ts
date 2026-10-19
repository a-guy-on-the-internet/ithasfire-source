import { describe, expect, it, vi } from "vitest";

import { resolvePurchasedUnitPriceCents } from "../_shared/resolve-purchased-unit-price";

const ORDER_ITEM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TICKET_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeRepos(orderItem: { unitPriceCents: number } | null) {
  const getById = vi.fn(async () => orderItem);
  return { repos: { orderItems: { getById } } as any, getById };
}

describe("resolvePurchasedUnitPriceCents", () => {
  it("returns the OrderItem's snapshotted unit price", async () => {
    const { repos, getById } = makeRepos({ unitPriceCents: 1200 } as any);

    const result = await resolvePurchasedUnitPriceCents(repos, {
      id: TICKET_ID,
      orderItemId: ORDER_ITEM_ID,
    });

    expect(result).toBe(1200);
    expect(getById).toHaveBeenCalledWith(ORDER_ITEM_ID);
  });

  it("returns 0 — not null — for a comp ticket snapshotted at 0", async () => {
    // `issue-comp-tickets` hardcodes unitPriceCents 0. Zero is a real price
    // and must survive the resolver; collapsing it to null would push callers
    // into their unknown-price branch.
    const { repos } = makeRepos({ unitPriceCents: 0 } as any);

    const result = await resolvePurchasedUnitPriceCents(repos, {
      id: TICKET_ID,
      orderItemId: ORDER_ITEM_ID,
    });

    expect(result).toBe(0);
  });

  it("returns null without a lookup when the ticket has no orderItemId", async () => {
    const { repos, getById } = makeRepos({ unitPriceCents: 1200 } as any);

    const result = await resolvePurchasedUnitPriceCents(repos, {
      id: TICKET_ID,
      orderItemId: null,
    });

    expect(result).toBeNull();
    expect(getById).not.toHaveBeenCalled();
  });

  it("returns null when the OrderItem row is gone", async () => {
    const { repos } = makeRepos(null);

    const result = await resolvePurchasedUnitPriceCents(repos, {
      id: TICKET_ID,
      orderItemId: ORDER_ITEM_ID,
    });

    expect(result).toBeNull();
  });
});
