import { describe, expect, it, vi } from "vitest";

import {
  carriedOverCartRefusalIsPermanent,
  releaseRetiredCartHolds,
  settleCarriedOverCartPaymentIntent,
  type CarriedOverCart,
  type SettleCarriedOverCartDeps,
} from "../retire-carried-over-cart";

const CART_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type FakeOrder = {
  id: string;
  source: "PRIMARY" | "RESALE";
  buyerHumanId: string;
  items: Array<{ id: string; resaleListingId: string | null; meta: unknown }>;
};

const PRIMARY_ORDER: FakeOrder = {
  id: CART_ID,
  source: "PRIMARY",
  buyerHumanId: "buyer-1",
  items: [
    {
      id: "item-1",
      resaleListingId: null,
      meta: { holdExpiresAt: "2026-10-04T12:15:00.000Z" },
    },
  ],
};

function makeTx(
  opts: {
    cancelled?: boolean;
    order?: FakeOrder | null;
    releaseHoldResult?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const order = opts.order === undefined ? PRIMARY_ORDER : opts.order;
  const tx = {
    resaleListings: {
      releaseHold: vi.fn(async () => {
        calls.push("release_resale_hold");
        return (opts.releaseHoldResult ?? true)
          ? { released: true, listingStatus: "ACTIVE" }
          : { released: false };
      }),
    },
    orders: {
      getById: vi.fn(async () => order),
      cancelPendingOrder: vi.fn(async () => {
        calls.push("cancel_order");
        return opts.cancelled ?? true;
      }),
      cancelProcessingOrder: vi.fn(async () => {
        calls.push("cancel_processing_order");
        return opts.cancelled ?? true;
      }),
    },
    promos: {
      releaseHoldsForOrder: vi.fn(async () => {
        calls.push("release_promos");
      }),
    },
    feeWaivers: {
      release: vi.fn(async () => {
        calls.push("release_fee_waiver");
        return { releasedTickets: 0 };
      }),
    },
    credits: {
      releaseForOrder: vi.fn(async () => {
        calls.push("release_credits");
        return { releasedCents: 0, creditIds: [] };
      }),
    },
  };
  return { tx: tx as never, calls, mocks: tx };
}

/**
 * `canceled` is what `cancelPaymentIntent` returns; `status` is what a
 * follow-up `retrievePaymentIntent` reports. The interesting cases are the
 * ones where they disagree — a graceful no-op cancel (`canceled: false`) over
 * a PI that is actually `succeeded`.
 */
function makePayments(opts: {
  canceled?: boolean;
  status?: string;
  cancelThrows?: boolean;
  retrieveThrows?: boolean;
}) {
  const cancelPaymentIntent = vi.fn(async () => {
    if (opts.cancelThrows) throw new Error("stripe down");
    return { canceled: opts.canceled ?? true };
  });
  const retrievePaymentIntent = vi.fn(async () => {
    if (opts.retrieveThrows) throw new Error("stripe down");
    return {
      id: "pi_1",
      status: opts.status ?? "canceled",
      amountReceived: 0,
      currency: "usd",
      metadata: {},
    };
  });
  return { cancelPaymentIntent, retrievePaymentIntent };
}

type SettleThenReleaseDeps = SettleCarriedOverCartDeps & { now?: Date };

/**
 * The two halves composed the way every production caller composes them:
 * `settleCarriedOverCartPaymentIntent` (no transaction open), then, only if it
 * proved the PI dead, `releaseRetiredCartHolds` with a CAS on the settled PI.
 * The scenarios below used to run through `retireCarriedOverCart`, which did
 * both in one call inside the caller's transaction and was deleted on
 * 2026-10-04. They now exercise the two real helpers directly.
 */
async function settleThenRelease(
  tx: Parameters<typeof releaseRetiredCartHolds>[0],
  cart: CarriedOverCart,
  deps: SettleThenReleaseDeps,
): Promise<boolean> {
  const settle = await settleCarriedOverCartPaymentIntent(cart, deps);
  if (!settle.settled) return false;
  return releaseRetiredCartHolds(tx, cart.id, {
    now: deps.now,
    expectedPaymentIntentId: cart.stripePaymentIntentId,
    caller: deps.caller,
    logger: deps.logger,
    reportError: deps.reportError,
  });
}

describe("settle + releaseRetiredCartHolds — no PaymentIntent", () => {
  it("cancels the order and releases its promo holds", async () => {
    const { tx, mocks, calls } = makeTx();

    const retired = await settleThenRelease(
      tx,
      { id: CART_ID, stripePaymentIntentId: null },
      {},
    );

    expect(retired).toBe(true);
    expect(mocks.orders.cancelPendingOrder).toHaveBeenCalledWith(CART_ID, {
      expectedPaymentIntentId: null,
    });
    expect(calls).toEqual([
      "cancel_order",
      "release_promos",
      "release_fee_waiver",
      "release_credits",
    ]);
  });

  it("returns the superseded cart's fee-waiver reservation", async () => {
    // `feeWaivers.reserve` bumps `ticketsUsed` at checkout. A cancelled order
    // is never visited by the expiry reaper (it only reads PENDING rows), so
    // unless the cancel path releases the reservation the buyer's next order
    // pays the fee they were promised would be waived.
    const { tx, mocks } = makeTx();

    await settleThenRelease(
      tx,
      { id: CART_ID, stripePaymentIntentId: null },
      {},
    );

    expect(mocks.feeWaivers.release).toHaveBeenCalledTimes(1);
    expect(mocks.feeWaivers.release).toHaveBeenCalledWith(CART_ID);
  });

  it("restores the platform credit the superseded cart had spent", async () => {
    // `applyAvailableCredits` DEBITS the credit at checkout (`redeemConditional`
    // is a real `balanceCents -= n`, status → REDEEMED at zero) — it is not a
    // hold. So a declined-then-retried cart that is never released leaves the
    // buyer's goodwill credit at zero, pointing at an order that will never
    // succeed. The cancel path is the only place it can come back.
    const { tx, mocks } = makeTx();

    await settleThenRelease(
      tx,
      { id: CART_ID, stripePaymentIntentId: null },
      {},
    );

    expect(mocks.credits.releaseForOrder).toHaveBeenCalledTimes(1);
    // Called with the id ALONE when no clock was supplied. The adapter would
    // treat `{ now: undefined }` identically, but the checkout and finalize
    // suites assert this call's exact shape, so the helper must not hand them
    // a second argument they did not ask for.
    expect(mocks.credits.releaseForOrder).toHaveBeenCalledWith(CART_ID);
  });

  it("forwards the caller's bound `now` to the credit release when given one", async () => {
    // The reaper releases credit against its ClockPort instant so the expiry
    // predicate matches what `listActiveForHuman` reads by, not the DB's NOW().
    const { tx, mocks } = makeTx();
    const now = new Date("2024-02-01T00:20:00.000Z");

    await settleThenRelease(
      tx,
      { id: CART_ID, stripePaymentIntentId: null },
      { now },
    );

    expect(mocks.credits.releaseForOrder).toHaveBeenCalledWith(CART_ID, { now });
  });

  it("does not release promo holds, fee waivers or credit when the CAS found nothing to cancel", async () => {
    const { tx, mocks } = makeTx({ cancelled: false });

    const retired = await settleThenRelease(
      tx,
      { id: CART_ID, stripePaymentIntentId: null },
      {},
    );

    expect(retired).toBe(false);
    expect(mocks.promos.releaseHoldsForOrder).not.toHaveBeenCalled();
    expect(mocks.feeWaivers.release).not.toHaveBeenCalled();
    expect(mocks.credits.releaseForOrder).not.toHaveBeenCalled();
  });
});

describe("settle + releaseRetiredCartHolds — live PaymentIntent", () => {
  it("cancels the PI before de-holding, and only then", async () => {
    const { tx, mocks } = makeTx();
    const order: string[] = [];
    const payments = makePayments({ canceled: true });
    payments.cancelPaymentIntent.mockImplementation(async () => {
      order.push("cancel_pi");
      return { canceled: true };
    });
    mocks.orders.cancelPendingOrder.mockImplementation(async () => {
      order.push("cancel_order");
      return true;
    });

    const retired = await settleThenRelease(
      tx,
      { id: CART_ID, stripePaymentIntentId: "pi_1" },
      { payments },
    );

    expect(retired).toBe(true);
    expect(payments.cancelPaymentIntent).toHaveBeenCalledWith({
      paymentIntentId: "pi_1",
    });
    expect(order).toEqual(["cancel_pi", "cancel_order"]);
    // A clean cancel is proof enough — no need to spend a round-trip.
    expect(payments.retrievePaymentIntent).not.toHaveBeenCalled();
  });

  it("KEEPS the hold when the PI cancel throws", async () => {
    const { tx, mocks } = makeTx();

    const retired = await settleThenRelease(
      tx,
      { id: CART_ID, stripePaymentIntentId: "pi_1" },
      { payments: makePayments({ cancelThrows: true }) },
    );

    expect(retired).toBe(false);
    expect(mocks.orders.cancelPendingOrder).not.toHaveBeenCalled();
    expect(mocks.promos.releaseHoldsForOrder).not.toHaveBeenCalled();
    expect(mocks.feeWaivers.release).not.toHaveBeenCalled();
    expect(mocks.credits.releaseForOrder).not.toHaveBeenCalled();
  });

  it("KEEPS the hold when no processor is wired in at all", async () => {
    const { tx, mocks } = makeTx();

    const retired = await settleThenRelease(
      tx,
      { id: CART_ID, stripePaymentIntentId: "pi_1" },
      {},
    );

    expect(retired).toBe(false);
    expect(mocks.orders.cancelPendingOrder).not.toHaveBeenCalled();
  });

  it("reports the PI-cancel failure rather than swallowing it silently", async () => {
    const { tx } = makeTx();
    const reportError = vi.fn();

    await settleThenRelease(
      tx,
      { id: CART_ID, stripePaymentIntentId: "pi_1" },
      { payments: makePayments({ cancelThrows: true }), reportError },
    );

    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ step: "retireCarriedOverCart" }),
      }),
    );
  });

  it("tags every refusal report with the caller so Sentry can tell them apart", async () => {
    // Every settle caller reports under `area: "checkout"`; without `caller`
    // the reaper's refusals are indistinguishable from createCheckout's.
    const cases: Array<{ name: string; deps: SettleThenReleaseDeps }> = [
      { name: "no processor", deps: {} },
      { name: "cancel throws", deps: { payments: makePayments({ cancelThrows: true }) } },
      {
        name: "terminal not canceled",
        deps: { payments: makePayments({ canceled: false, status: "succeeded" }) },
      },
    ];

    for (const c of cases) {
      const reportError = vi.fn();
      const { tx } = makeTx();

      const retired = await settleThenRelease(
        tx,
        { id: CART_ID, stripePaymentIntentId: "pi_1" },
        { ...c.deps, reportError, caller: "releaseExpiredCarts" },
      );

      expect(retired, c.name).toBe(false);
      expect(reportError, c.name).toHaveBeenCalledTimes(1);
      expect(reportError, c.name).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          tags: expect.objectContaining({
            step: "retireCarriedOverCart",
            caller: "releaseExpiredCarts",
          }),
        }),
      );
    }
  });

  it("a THROWING reporter cannot change the outcome", async () => {
    const { tx } = makeTx();

    await expect(
      settleThenRelease(
        tx,
        { id: CART_ID, stripePaymentIntentId: "pi_1" },
        {
          payments: makePayments({ cancelThrows: true }),
          reportError: vi.fn(() => {
            throw new Error("sentry exploded");
          }),
        },
      ),
    ).resolves.toBe(false);
  });
});

// ── The terminal-state trap ─────────────────────────────────────────────────
//
// `cancelPaymentIntent` does NOT throw for an already-terminal PI. The port
// contract makes it a graceful no-op returning `{ canceled: false }`, and the
// Stripe adapter implements exactly that by swallowing
// `payment_intent_unexpected_state`. So `canceled: false` is ambiguous: it
// covers both "someone already cancelled it" (safe) and "THE BUYER HAS PAID"
// (catastrophic). Treating it as either one unconditionally is a bug — one
// strands a real charge, the other wedges idempotent replay.
describe("settle + releaseRetiredCartHolds — cancel returns { canceled: false }", () => {
  it("KEEPS the hold when the PI actually SUCCEEDED", async () => {
    // Reachable without any exotic race: buyer pays, closes the tab before
    // confirmPayment fires, comes back and hits Resume. Cart recovery lists
    // the order on PENDING + unexpired hold alone and never looks at the PI.
    // Retiring here cancels an order Stripe has already charged — the webhook
    // then throws ORDER_NOT_PROCESSABLE into the DLQ, mints nothing, and the
    // buyer pays a second time for the replacement.
    const { tx, mocks } = makeTx();
    const payments = makePayments({ canceled: false, status: "succeeded" });

    const retired = await settleThenRelease(
      tx,
      { id: CART_ID, stripePaymentIntentId: "pi_1" },
      { payments },
    );

    expect(retired).toBe(false);
    expect(payments.retrievePaymentIntent).toHaveBeenCalledWith({
      paymentIntentId: "pi_1",
    });
    expect(mocks.orders.cancelPendingOrder).not.toHaveBeenCalled();
    expect(mocks.promos.releaseHoldsForOrder).not.toHaveBeenCalled();
    expect(mocks.feeWaivers.release).not.toHaveBeenCalled();
    // A credit spent on a cart whose PI SUCCEEDED was genuinely consumed.
    expect(mocks.credits.releaseForOrder).not.toHaveBeenCalled();
  });

  it("KEEPS the hold when the PI is still PROCESSING (ACH / bank debit)", async () => {
    const { tx, mocks } = makeTx();

    const retired = await settleThenRelease(
      tx,
      { id: CART_ID, stripePaymentIntentId: "pi_1" },
      { payments: makePayments({ canceled: false, status: "processing" }) },
    );

    expect(retired).toBe(false);
    expect(mocks.orders.cancelPendingOrder).not.toHaveBeenCalled();
  });

  it("RETIRES normally when the PI was already canceled (idempotent replay)", async () => {
    // The other half of the disambiguation. Treating every `canceled: false`
    // as unsafe would permanently wedge this legitimate path.
    const { tx, mocks, calls } = makeTx();

    const retired = await settleThenRelease(
      tx,
      { id: CART_ID, stripePaymentIntentId: "pi_1" },
      { payments: makePayments({ canceled: false, status: "canceled" }) },
    );

    expect(retired).toBe(true);
    expect(mocks.orders.cancelPendingOrder).toHaveBeenCalledWith(CART_ID, {
      expectedPaymentIntentId: "pi_1",
    });
    expect(calls).toEqual([
      "cancel_order",
      "release_promos",
      "release_fee_waiver",
      "release_credits",
    ]);
  });

  it("reports the unsafe terminal status, including which status it was", async () => {
    const { tx } = makeTx();
    const reportError = vi.fn();

    await settleThenRelease(
      tx,
      { id: CART_ID, stripePaymentIntentId: "pi_1" },
      {
        payments: makePayments({ canceled: false, status: "succeeded" }),
        reportError,
      },
    );

    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("succeeded"),
      }),
      expect.objectContaining({
        extra: expect.objectContaining({ status: "succeeded" }),
      }),
    );
  });

  it("KEEPS the hold when the status probe itself fails", async () => {
    // Unknown status is treated exactly like unsafe status.
    const { tx, mocks } = makeTx();

    const retired = await settleThenRelease(
      tx,
      { id: CART_ID, stripePaymentIntentId: "pi_1" },
      {
        payments: makePayments({ canceled: false, retrieveThrows: true }),
      },
    );

    expect(retired).toBe(false);
    expect(mocks.orders.cancelPendingOrder).not.toHaveBeenCalled();
  });
});

// ── The split surface ───────────────────────────────────────────────────────
//
// The settle runs with no transaction open: the Stripe client's worst case
// (240s for the cancel + retrieve pair) is eight times the `repos.tx` budget.
// Every caller settles first and opens its transaction with the verdict in
// hand.
describe("settleCarriedOverCartPaymentIntent", () => {
  it("needs no transaction at all", async () => {
    const payments = makePayments({ canceled: true });

    await expect(
      settleCarriedOverCartPaymentIntent(
        { id: CART_ID, stripePaymentIntentId: "pi_1" },
        { payments },
      ),
    ).resolves.toEqual({ settled: true });
    expect(payments.cancelPaymentIntent).toHaveBeenCalledWith({
      paymentIntentId: "pi_1",
    });
  });

  it("settles trivially for a cart with no PaymentIntent", async () => {
    const payments = makePayments({ canceled: true });

    await expect(
      settleCarriedOverCartPaymentIntent(
        { id: CART_ID, stripePaymentIntentId: null },
        { payments },
      ),
    ).resolves.toEqual({ settled: true });
    expect(payments.cancelPaymentIntent).not.toHaveBeenCalled();
  });

  it("names the refusal so a looping caller can tell terminal from transient", async () => {
    const cases = [
      {
        name: "no processor",
        deps: {},
        expected: { reason: "no_processor" },
      },
      {
        name: "paid",
        deps: { payments: makePayments({ canceled: false, status: "succeeded" }) },
        expected: { reason: "pi_terminal_not_canceled", status: "succeeded" },
      },
      {
        name: "still processing",
        deps: {
          payments: makePayments({ canceled: false, status: "processing" }),
        },
        expected: { reason: "pi_terminal_not_canceled", status: "processing" },
      },
    ] as const;

    for (const c of cases) {
      const result = await settleCarriedOverCartPaymentIntent(
        { id: CART_ID, stripePaymentIntentId: "pi_1" },
        { ...c.deps },
      );
      expect(result, c.name).toEqual({ settled: false, refusal: c.expected });
    }
  });

  it("reports a Stripe throw as a settle failure carrying the error", async () => {
    const result = await settleCarriedOverCartPaymentIntent(
      { id: CART_ID, stripePaymentIntentId: "pi_1" },
      { payments: makePayments({ cancelThrows: true }) },
    );

    expect(result.settled).toBe(false);
    if (result.settled) throw new Error("unreachable");
    expect(result.refusal.reason).toBe("pi_settle_failed");
  });
});

describe("carriedOverCartRefusalIsPermanent", () => {
  it("treats a SUCCEEDED PaymentIntent as permanent", () => {
    // The buyer has paid. That order is finalize's problem (and its DLQ's);
    // re-probing it every 5 minutes forever only buries the report.
    expect(
      carriedOverCartRefusalIsPermanent({
        reason: "pi_terminal_not_canceled",
        status: "succeeded",
      }),
    ).toBe(true);
  });

  it("treats a missing processor as permanent", () => {
    // The composition root builds it once at boot.
    expect(
      carriedOverCartRefusalIsPermanent({ reason: "no_processor" }),
    ).toBe(true);
  });

  it("keeps PROCESSING retryable", () => {
    // It resolves to `succeeded` or back to `requires_payment_method`, so it
    // is worth another look — just not on the very next pass.
    expect(
      carriedOverCartRefusalIsPermanent({
        reason: "pi_terminal_not_canceled",
        status: "processing",
      }),
    ).toBe(false);
  });

  it("keeps a Stripe failure retryable", () => {
    expect(
      carriedOverCartRefusalIsPermanent({
        reason: "pi_settle_failed",
        error: new Error("stripe down"),
      }),
    ).toBe(false);
  });
});

describe("releaseRetiredCartHolds", () => {
  it("cancels and hands back promo, fee-waiver and credit holds in order", async () => {
    const { tx, calls } = makeTx();

    await expect(releaseRetiredCartHolds(tx, CART_ID)).resolves.toBe(true);
    expect(calls).toEqual([
      "cancel_order",
      "release_promos",
      "release_fee_waiver",
      "release_credits",
    ]);
  });

  it("releases nothing when the CAS found no PENDING order", async () => {
    const { tx, calls } = makeTx({ cancelled: false });

    await expect(releaseRetiredCartHolds(tx, CART_ID)).resolves.toBe(false);
    expect(calls).toEqual(["cancel_order"]);
  });
});

describe("releaseRetiredCartHolds — `from` selects the CAS", () => {
  it("from: PROCESSING cancels via cancelProcessingOrder, never cancelPendingOrder, then releases the same three holds", async () => {
    const { tx, calls, mocks } = makeTx();

    const cancelled = await releaseRetiredCartHolds(tx, CART_ID, {
      from: "PROCESSING",
    });

    expect(cancelled).toBe(true);
    expect(mocks.orders.cancelProcessingOrder).toHaveBeenCalledWith(CART_ID);
    expect(mocks.orders.cancelPendingOrder).not.toHaveBeenCalled();
    expect(calls).toEqual([
      "cancel_processing_order",
      "release_promos",
      "release_fee_waiver",
      "release_credits",
    ]);
  });

  it("default (no `from`) still CASes on PENDING", async () => {
    const { tx, mocks } = makeTx();

    await releaseRetiredCartHolds(tx, CART_ID);

    expect(mocks.orders.cancelPendingOrder).toHaveBeenCalledWith(CART_ID);
    expect(mocks.orders.cancelProcessingOrder).not.toHaveBeenCalled();
  });
});

describe("releaseRetiredCartHolds — resale listing hold (G1)", () => {
  const LISTING_ID = "listing-1";
  const HOLD_EXPIRES_AT = "2026-10-04T12:15:00.123Z";
  const RESALE_ORDER: FakeOrder = {
    id: CART_ID,
    source: "RESALE",
    buyerHumanId: "buyer-1",
    items: [
      {
        id: "item-1",
        resaleListingId: LISTING_ID,
        meta: { holdExpiresAt: HOLD_EXPIRES_AT, resaleListingId: LISTING_ID },
      },
    ],
  };

  it("a cancelled resale order gives its listing hold back, fenced on buyer + heldUntil, after the other releases", async () => {
    const { tx, calls, mocks } = makeTx({ order: RESALE_ORDER });

    await expect(
      releaseRetiredCartHolds(tx, CART_ID, { expectedPaymentIntentId: null }),
    ).resolves.toBe(true);

    expect(calls).toEqual([
      "cancel_order",
      "release_promos",
      "release_fee_waiver",
      "release_credits",
      "release_resale_hold",
    ]);
    expect(mocks.resaleListings.releaseHold).toHaveBeenCalledWith(LISTING_ID, {
      buyerHumanId: "buyer-1",
      heldUntil: new Date(HOLD_EXPIRES_AT),
    });
  });

  it("falls back to meta.resaleListingId when the column was cleared", async () => {
    const { tx, mocks } = makeTx({
      order: {
        ...RESALE_ORDER,
        items: [{ ...RESALE_ORDER.items[0]!, resaleListingId: null }],
      },
    });

    await releaseRetiredCartHolds(tx, CART_ID);

    expect(mocks.resaleListings.releaseHold).toHaveBeenCalledWith(
      LISTING_ID,
      expect.anything(),
    );
  });

  it("CAS lost: the order is not read and no listing is released", async () => {
    const { tx, mocks } = makeTx({ cancelled: false, order: RESALE_ORDER });

    await expect(releaseRetiredCartHolds(tx, CART_ID)).resolves.toBe(false);

    expect(mocks.orders.getById).not.toHaveBeenCalled();
    expect(mocks.resaleListings.releaseHold).not.toHaveBeenCalled();
  });

  it("from: PROCESSING releases the listing hold too", async () => {
    const { tx, mocks } = makeTx({ order: RESALE_ORDER });

    await releaseRetiredCartHolds(tx, CART_ID, { from: "PROCESSING" });

    expect(mocks.orders.cancelProcessingOrder).toHaveBeenCalled();
    expect(mocks.resaleListings.releaseHold).toHaveBeenCalledTimes(1);
  });

  it("a primary order releases no listing", async () => {
    const { tx, mocks } = makeTx();

    await releaseRetiredCartHolds(tx, CART_ID);

    expect(mocks.resaleListings.releaseHold).not.toHaveBeenCalled();
  });

  it("an item with no parseable holdExpiresAt is skipped, logged and reported (the sweep frees it)", async () => {
    const { tx, mocks } = makeTx({
      order: {
        ...RESALE_ORDER,
        items: [{ ...RESALE_ORDER.items[0]!, meta: { holdExpiresAt: "nope" } }],
      },
    });
    const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const reportError = vi.fn();

    await expect(
      releaseRetiredCartHolds(tx, CART_ID, {
        caller: "releaseExpiredCarts",
        logger: logger as never,
        reportError,
      }),
    ).resolves.toBe(true);

    expect(mocks.resaleListings.releaseHold).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "release_resale_listing_hold_unfenced",
      expect.objectContaining({ orderId: CART_ID, listingId: LISTING_ID }),
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "release_resale_listing_hold_unfenced",
      }),
      expect.objectContaining({
        tags: expect.objectContaining({ useCase: "releaseExpiredCarts" }),
      }),
    );
  });

  it("a throwing reporter does not change the outcome", async () => {
    const { tx } = makeTx({
      order: {
        ...RESALE_ORDER,
        items: [{ ...RESALE_ORDER.items[0]!, meta: {} }],
      },
    });

    await expect(
      releaseRetiredCartHolds(tx, CART_ID, {
        reportError: () => {
          throw new Error("sentry down");
        },
      }),
    ).resolves.toBe(true);
  });

  it("a release that closes the listing instead of putting it on sale is logged with its reason; `now` is forwarded", async () => {
    const { tx, mocks } = makeTx({ order: RESALE_ORDER });
    mocks.resaleListings.releaseHold.mockResolvedValueOnce({
      released: true,
      listingStatus: "CANCELLED",
      reason: "ticket_not_listed",
    } as never);
    const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const now = new Date("2026-10-04T13:00:00.000Z");

    await releaseRetiredCartHolds(tx, CART_ID, {
      now,
      caller: "releaseExpiredCarts",
      logger: logger as never,
    });

    expect(mocks.resaleListings.releaseHold).toHaveBeenCalledWith(
      LISTING_ID,
      { buyerHumanId: "buyer-1", heldUntil: new Date(HOLD_EXPIRES_AT) },
      { now },
    );
    expect(logger.info).toHaveBeenCalledWith(
      "release_resale_listing_hold_released",
      expect.objectContaining({
        outcomes: [
          {
            listingId: LISTING_ID,
            listingStatus: "CANCELLED",
            reason: "ticket_not_listed",
          },
        ],
      }),
    );
  });

  it("the settle-then-release composition reaches the same release", async () => {
    const { tx, mocks } = makeTx({ order: RESALE_ORDER });

    await expect(
      settleThenRelease(
        tx,
        { id: CART_ID, stripePaymentIntentId: null },
        { payments: null, caller: "finalizePaymentIntent" },
      ),
    ).resolves.toBe(true);

    expect(mocks.orders.cancelPendingOrder).toHaveBeenCalledWith(CART_ID, {
      expectedPaymentIntentId: null,
    });
    expect(mocks.resaleListings.releaseHold).toHaveBeenCalledTimes(1);
  });
});
