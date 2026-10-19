import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import type { OrderRecord, OrderTaxLineRecord } from "@th/ports/repos/orders";
import type { Repos, TxRepos } from "@th/ports/repos";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createFakePayeeLedgerRepo } from "@th/test-utils/fakes/payee-ledger";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import { cancelEvent, type CancelEventDeps } from "../cancel-event";

// Cancelling an event stamps each refunded ticket item's `refundedTaxCents`
// per PLATFORM tax line, each by its own base, exactly as `refundFullOrder`
// does. Minneapolis order: SALES 349 on BUYER_TOTAL + MPLS_ENTERTAINMENT 105
// on TICKET_FACE = 454.
//
//   SALES 349 by buyer-paid (2665 : 1200) → a 241, b 108
//   MPLS  105 by face       (2500 : 1000) → a  75, b  30
//   per item                               → a 316, b 138
//
// The old single buyer-paid weight gave a 313, b 141. The tax lines are read
// for ALL orders in ONE batched call while PLANNING the refunds (outside the
// tx, before any money moves); the marking tx stamps the planned split.

const EVENT_ID = "30000000-0000-4000-8000-000000000001";
const ORG_ID = "30000000-0000-4000-8000-000000000002";
const ACTOR_ID = "30000000-0000-4000-8000-000000000003";
const BUYER_ID = "30000000-0000-4000-8000-000000000004";
const ORDER_ID = "30000000-0000-4000-8000-000000000006";
const ITEM_A = "30000000-0000-4000-8000-00000000000a";
const ITEM_B = "30000000-0000-4000-8000-00000000000b";
const CLIENT_KEY = "cancel-tax-lines-key-12345";
const NOW = new Date("2026-10-05T12:00:00.000Z");

const denyStaffAuthz = {
  hasStaffRole: vi.fn(async () => ({ allowed: false })),
} satisfies CancelEventDeps["authz"];

function makeEvent(): EventRecord {
  return {
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    status: "PUBLISHED",
    title: "Tax Lines Event",
    slug: "tax-lines-event",
    startsAt: NOW,
    endsAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  } as EventRecord;
}

function makeItem(id: string, face: number, buyerTotal: number) {
  return {
    id,
    orderId: ORDER_ID,
    kind: "ticket",
    ticketTypeId: "tt-1",
    qty: 1,
    unitPriceCents: face,
    amountCents: face,
    meta: { buyerTotalCents: buyerTotal },
    paidOutAt: null,
    refundedAt: null,
    transferredAt: null,
    resaleListingId: null,
    status: "active",
  };
}

/** `bRefunded`: B was refunded earlier, so only A is refunded now. */
function makeOrder(bRefunded = false): OrderRecord {
  const b = makeItem(ITEM_B, 1000, 1200);
  if (bRefunded) {
    Object.assign(b, { status: "refunded", refundedAt: NOW });
  }
  return {
    id: ORDER_ID,
    eventId: EVENT_ID,
    buyerHumanId: BUYER_ID,
    amountGrossCents: 3500,
    feesPlatformCents: 365,
    taxAmountCents: 454,
    currency: "usd",
    feePolicySnapshot: {},
    status: bRefunded ? "PART_REFUNDED" : "SUCCEEDED",
    stripePaymentIntentId: "pi_tax_lines",
    source: "PRIMARY",
    nonRefundable: false,
    occurredAt: NOW,
    paymentMethodType: "card",
    paidOutAt: null,
    parentOrderId: null,
    items: [makeItem(ITEM_A, 2500, 2665), b],
  } as unknown as OrderRecord;
}

function taxLine(
  code: string,
  base: "BUYER_TOTAL" | "TICKET_FACE",
  amountCents: number,
): OrderTaxLineRecord {
  return {
    id: `line-${code}`,
    orderId: ORDER_ID,
    code,
    label: code,
    jurisdiction: "US-MN",
    rateBps: 0,
    base,
    collector: "PLATFORM",
    taxableAmountCents: 0,
    amountCents,
    createdAt: NOW,
  } as OrderTaxLineRecord;
}

function buildHarness(taxLines: OrderTaxLineRecord[], bRefunded = false) {
  const event = makeEvent();
  const order = makeOrder(bRefunded);

  const ordersRepo = {
    listTaxLinesByOrderIds: vi.fn(
      async (orderIds: string[]) =>
        new Map(
          orderIds.includes(ORDER_ID) && taxLines.length > 0
            ? [[ORDER_ID, taxLines]]
            : [],
        ),
    ),
    listTaxLines: vi.fn(async () => {
      throw new Error("cancelEvent must batch tax-line reads");
    }),
    listAll: vi.fn(async () => ({
      items: [
        {
          id: ORDER_ID,
          stripePaymentIntentId: "pi_tax_lines",
          amountGrossCents: 3500,
          feesPlatformCents: 365,
        },
      ],
      total: 1,
    })),
    getById: vi.fn(async (orderId: string) =>
      orderId === ORDER_ID ? order : null,
    ),
    markRefunded: vi.fn(async () => undefined),
  };
  const orderItemsRepo = {
    updateStatus: vi.fn(async () => undefined),
    setResaleListingId: vi.fn(async () => undefined),
  };
  const payeeLedger = createFakePayeeLedgerRepo();

  const txRepos = {
    events: {
      getById: vi.fn(async () => event),
      lockRows: vi.fn(async () => undefined),
      cancel: vi.fn(async () => event),
    },
    authz: {
      getOrgMembership: vi.fn(async () => ({
        orgId: ORG_ID,
        humanId: ACTOR_ID,
        role: "OWNER" as const,
      })),
    },
    // The tx client must never read tax lines: the stamp is the split the
    // money was planned from, carried out of planning.
    orders: {
      ...ordersRepo,
      listTaxLinesByOrderIds: vi.fn(async () => {
        throw new Error("tax lines must not be re-read inside the tx");
      }),
    },
    orderItems: orderItemsRepo,
    tickets: {
      listByOrderId: vi.fn(async () => []),
      setStatus: vi.fn(async () => undefined),
    },
    resaleListings: {
      cancelOpenForEvent: vi.fn(async () => ({ cancelledListingIds: [] })),
    },
    payeeLedger: payeeLedger.repo,
    images: {
      listByOwner: vi.fn(async () => []),
      softDelete: vi.fn(async () => undefined),
    },
    audioUploads: {
      listByEventIdIncludingDeleted: vi.fn(async () => []),
      softDelete: vi.fn(async () => undefined),
    },
    pendingObjectDeletions: { enqueueMany: vi.fn(async () => undefined) },
    eventChangeNotices: { create: vi.fn(async () => undefined) },
    audit: { log: vi.fn(async () => undefined) },
    resourceQuotas: { incrementUsage: vi.fn(async () => undefined) },
    agreements: { findByLinkedEventId: vi.fn(async () => null) },
  } as unknown as TxRepos;

  const repos = {
    ...txRepos,
    orders: ordersRepo,
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => fn(txRepos)),
  } as unknown as Repos;

  const refundPaymentIntent = vi.fn(async () => ({
    refundId: "re_tax_lines",
    status: "succeeded" as const,
  }));
  const reportError = vi.fn();

  const deps: CancelEventDeps = {
    repos,
    authz: denyStaffAuthz,
    payments: {
      refundPaymentIntent,
      getProcessingFeeForPaymentIntent: vi.fn(async () => ({ feeCents: 100 })),
    } as unknown as CancelEventDeps["payments"],
    idempotency: createFakeIdempotencyPort(),
    clock: { now: vi.fn(() => NOW) },
    logger: createTestLogger(),
    reportError,
  };

  return { deps, ordersRepo, orderItemsRepo, refundPaymentIntent, reportError };
}

const input = {
  actorHumanId: ACTOR_ID,
  eventId: EVENT_ID,
  clientKey: CLIENT_KEY,
};

const MISMATCH_MESSAGE = "refund tax lines do not sum to order tax";

function stampedTax(h: ReturnType<typeof buildHarness>) {
  const calls = h.orderItemsRepo.updateStatus.mock.calls as unknown as Array<
    [string, string, Date, number | undefined]
  >;
  return new Map(calls.map(([itemId, , , tax]) => [itemId, tax]));
}

const mismatchReports = (h: ReturnType<typeof buildHarness>) =>
  h.reportError.mock.calls.filter(
    ([err]) => (err as Error).message === MISMATCH_MESSAGE,
  );

describe("cancelEvent — refund tax stamps follow the order's PLATFORM tax lines", () => {
  it("stamps a=316, b=138 from one batched planning read; the full refund total is unchanged", async () => {
    const h = buildHarness([
      taxLine("SALES", "BUYER_TOTAL", 349),
      taxLine("MPLS_ENTERTAINMENT", "TICKET_FACE", 105),
    ]);

    const result = await cancelEvent(h.deps, input);

    expect(result.refundedOrderCount).toBe(1);
    // Full refund: everything paid (3865 + 454) less Stripe's 100 fee.
    expect(h.refundPaymentIntent.mock.calls[0]![0]).toMatchObject({
      paymentIntentId: "pi_tax_lines",
      amountCents: 3865 + 454 - 100,
    });
    const stamped = stampedTax(h);
    expect(stamped.get(ITEM_A)).toBe(316);
    expect(stamped.get(ITEM_B)).toBe(138);
    expect(h.ordersRepo.listTaxLinesByOrderIds).toHaveBeenCalledTimes(1);
    expect(h.ordersRepo.listTaxLinesByOrderIds).toHaveBeenCalledWith([
      ORDER_ID,
    ]);
    expect(h.ordersRepo.listTaxLines).not.toHaveBeenCalled();
    expect(mismatchReports(h)).toHaveLength(0);
    // The lines are read BEFORE any money moves, not after.
    expect(
      h.ordersRepo.listTaxLinesByOrderIds.mock.invocationCallOrder[0],
    ).toBeLessThan(h.refundPaymentIntent.mock.invocationCallOrder[0]!);
  });

  it("a failed tax-line read aborts the cancellation before any refund is sent", async () => {
    const h = buildHarness([
      taxLine("SALES", "BUYER_TOTAL", 349),
      taxLine("MPLS_ENTERTAINMENT", "TICKET_FACE", 105),
    ]);
    h.ordersRepo.listTaxLinesByOrderIds.mockRejectedValueOnce(
      new Error("db down"),
    );

    await expect(cancelEvent(h.deps, input)).rejects.toThrow();

    expect(h.refundPaymentIntent).not.toHaveBeenCalled();
    expect(h.orderItemsRepo.updateStatus).not.toHaveBeenCalled();
  });

  it("a line mismatch is reported and the old single-weight split is stamped", async () => {
    const h = buildHarness([
      taxLine("SALES", "BUYER_TOTAL", 355),
      taxLine("MPLS_ENTERTAINMENT", "TICKET_FACE", 105),
    ]);

    await cancelEvent(h.deps, input);

    const stamped = stampedTax(h);
    expect(stamped.get(ITEM_A)).toBe(313);
    expect(stamped.get(ITEM_B)).toBe(141);
    expect(h.refundPaymentIntent.mock.calls[0]![0]).toMatchObject({
      amountCents: 3865 + 454 - 100,
    });
    const reports = mismatchReports(h);
    expect(reports).toHaveLength(1);
    expect(reports[0]![1]).toMatchObject({
      tags: { useCase: "cancelEvent", reason: "tax_lines_mismatch" },
      extra: {
        orderId: ORDER_ID,
        orderTaxCents: 454,
        platformLinesTotalCents: 460,
      },
    });
  });

  it("with B already refunded, A's refund is base + per-line tax − fee (2912) and its stamp is that tax term", async () => {
    const h = buildHarness(
      [
        taxLine("SALES", "BUYER_TOTAL", 349),
        taxLine("MPLS_ENTERTAINMENT", "TICKET_FACE", 105),
      ],
      true,
    );

    await cancelEvent(h.deps, input);

    // Same cents as eligibility / item refund / refundFullOrder for A
    // (refund-tax-lines.test.ts): 2665 + 316 − 69. The buyer-paid split of
    // the tax-inclusive total would have sent 2978 − 69 = 2909.
    expect(h.refundPaymentIntent.mock.calls[0]![0]).toMatchObject({
      amountCents: 2665 + 316 - 69,
    });
    const stamped = stampedTax(h);
    expect(stamped.get(ITEM_A)).toBe(316);
    expect(stamped.has(ITEM_B)).toBe(false);
  });

  it("with B already refunded and no tax lines, A's refund stays on the buyer-paid split (2909)", async () => {
    const h = buildHarness([], true);

    await cancelEvent(h.deps, input);

    expect(h.refundPaymentIntent.mock.calls[0]![0]).toMatchObject({
      amountCents: 2978 - 69,
    });
    expect(stampedTax(h).get(ITEM_A)).toBe(313);
  });

  it("an order with no tax lines keeps the single-weight split", async () => {
    const h = buildHarness([]);

    await cancelEvent(h.deps, input);

    const stamped = stampedTax(h);
    expect(stamped.get(ITEM_A)).toBe(313);
    expect(stamped.get(ITEM_B)).toBe(141);
    expect(mismatchReports(h)).toHaveLength(0);
  });
});
