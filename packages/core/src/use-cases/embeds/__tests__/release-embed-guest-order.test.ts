import { describe, expect, it, vi } from "vitest";

import { AppError } from "@th/errors";
import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";

import {
  EMBED_GUEST_RELEASE_PI_BUDGET_KEY_PREFIX,
  EMBED_GUEST_RELEASE_PI_BUDGET_MAX,
  releaseEmbedGuestOrder,
  releaseEmbedGuestOrderOutputSchema,
  type ReleaseEmbedGuestOrderDeps,
} from "../release-embed-guest-order";

/**
 * `releaseEmbedGuestOrder` is the embed widget's `releaseCartHold`: a guest
 * has no session, so the PaymentIntent client secret proves the order is
 * theirs, and the PaymentIntent's `metadata.embedId` proves it was made
 * through the embed asking.
 *
 * `releaseCartHold` is NOT mocked: its own suite covers the release in depth,
 * and here the fakes let it run for real so the questions are who may ask,
 * that a paid order is never touched, and that Stripe is settled before
 * anything is written.
 */

// ── Defaults ─────────────────────────────────────────────────────────────────

const EMBED_ID = "00000000-0000-4000-8000-000000000020";
const OTHER_EMBED_ID = "00000000-0000-4000-8000-000000000021";
const ORG_ID = "00000000-0000-4000-8000-000000000022";
const BUYER = "00000000-0000-4000-8000-000000000023";
const ORDER_ID = "00000000-0000-4000-8000-000000000024";
const OTHER_ORDER_ID = "00000000-0000-4000-8000-000000000025";
const EVENT_ID = "00000000-0000-4000-8000-000000000026";
/** Matches `embed().domain` — the allowlisted embedding origin. */
const HOST_ORIGIN = "https://shop.example.com";

const PI_ID = "pi_3EmbedGuestRelease1";
// gitleaks:allow (fake test fixtures)
const REAL_SECRET = `${PI_ID}_secret_FakeFixtureRealNotReal`;
// gitleaks:allow (fake test fixture)
const WRONG_SECRET = `${PI_ID}_secret_FakeFixtureWrongNotReal`;

const NOW = new Date("2026-10-11T12:20:00.000Z");
/** When the order was made and its seats stamped HELD. */
const HELD_AT = new Date("2026-10-11T12:00:00.000Z");
/** `ORDER_HOLD_TTL_SECONDS` in `orders/_shared/cart-seat-release.ts`. */
const HOLD_TTL_SECONDS = 900;
const SEAT_A = "seat-a";
const SEAT_B = "seat-b";

const embed = (over: Record<string, unknown> = {}) => ({
  id: EMBED_ID,
  subjectType: "organization",
  subjectId: ORG_ID,
  domain: "shop.example.com",
  status: "ACTIVE",
  requireAuth: false,
  linkOut: false,
  defaultView: "list",
  viewToggle: false,
  createdBy: "someone",
  createdAt: new Date("2026-01-01"),
  ...over,
});

/** Records every logger call, children included, so a test can search them. */
function recordingLogger() {
  const calls: unknown[][] = [];
  const logger: LoggerPort = {
    child: vi.fn((...args: unknown[]) => {
      calls.push(["child", ...args]);
      return logger;
    }),
    withTime: vi.fn(async (_name, fn) => fn()),
    log: vi.fn((...args: unknown[]) => void calls.push(["log", ...args])),
    info: vi.fn((...args: unknown[]) => void calls.push(["info", ...args])),
    warn: vi.fn((...args: unknown[]) => void calls.push(["warn", ...args])),
    error: vi.fn((...args: unknown[]) => void calls.push(["error", ...args])),
  } as unknown as LoggerPort;
  return { logger, calls };
}

function harness(
  opts: {
    embed?: ReturnType<typeof embed> | null;
    /** Status of the order row; null = the row is gone. */
    orderStatus?: string | null;
    /** What `orders.findByPaymentIntent` answers. Defaults to the order. */
    linkedOrder?: { id: string; status: string } | null;
    /** Status the secret-proving retrieve reports. */
    piStatus?: string;
    piMetadata?: Record<string, string>;
    piClientSecret?: string | null;
    /** Thrown by the secret-proving retrieve instead of answering. */
    retrieveError?: unknown;
    /** Stripe's answer to `cancelPaymentIntent`. */
    cancelResult?: { canceled: boolean };
    /** Thrown by `cancelPaymentIntent` instead of answering. */
    cancelError?: unknown;
    /** Status the probe after a `{ canceled: false }` reports. */
    probeStatus?: string;
    /** Finalize moves the order to SUCCEEDED just before the CAS. */
    loseCas?: boolean;
    /**
     * Another canceller (a second release, the cart reaper) moves the order
     * to CANCELLED just before the CAS.
     */
    loseCasToCancel?: boolean;
    /**
     * The per-PaymentIntent budget. `"spent"` denies, `"throws"` is a limiter
     * whose backend is down, `null` is no limiter wired. Default: allows.
     */
    rateLimit?: "spent" | "throws" | null;
  } = {},
) {
  /** Every call that matters for ordering, in the order it happened. */
  const callLog: string[] = [];
  let orderStatus = opts.orderStatus === undefined ? "PENDING" : opts.orderStatus;
  const seatStatuses = new Map<string, string>([
    [SEAT_A, "HELD"],
    [SEAT_B, "HELD"],
  ]);
  let txOpen = false;

  const orderRow = () =>
    orderStatus === null
      ? null
      : {
          id: ORDER_ID,
          eventId: EVENT_ID,
          buyerHumanId: BUYER,
          status: orderStatus,
          stripePaymentIntentId: PI_ID,
          source: "PRIMARY",
          occurredAt: HELD_AT,
          items: [
            {
              id: "item-1",
              orderId: ORDER_ID,
              kind: "ticket",
              ticketTypeId: "tt-1",
              qty: 2,
              unitPriceCents: 2500,
              amountCents: 5000,
              meta: {
                seatIds: [SEAT_A, SEAT_B],
                holdExpiresAt: new Date(
                  HELD_AT.getTime() + HOLD_TTL_SECONDS * 1000,
                ).toISOString(),
              },
            },
          ],
        };

  const orders = {
    findByPaymentIntent: vi.fn(async (_piId: string) => {
      callLog.push("orders.findByPaymentIntent");
      return opts.linkedOrder === undefined
        ? orderStatus === null
          ? { id: ORDER_ID, status: "PENDING" }
          : { id: ORDER_ID, status: orderStatus }
        : opts.linkedOrder;
    }),
    getById: vi.fn(async (id: string) => {
      callLog.push(txOpen ? "tx.orders.getById" : "orders.getById");
      return id === ORDER_ID ? orderRow() : null;
    }),
    // CAS like the adapter: PENDING, and still carrying the settled PI.
    cancelPendingOrder: vi.fn(
      async (
        _id: string,
        _o?: { expectedPaymentIntentId?: string | null },
      ) => {
        callLog.push("tx.orders.cancelPendingOrder");
        if (opts.loseCas) orderStatus = "SUCCEEDED";
        if (opts.loseCasToCancel) orderStatus = "CANCELLED";
        if (orderStatus !== "PENDING") return false;
        orderStatus = "CANCELLED";
        return true;
      },
    ),
  };
  const seats = {
    releaseSeats: vi.fn(async (input: { seatIds: string[] }) => {
      callLog.push("tx.seats.releaseSeats");
      for (const id of input.seatIds) seatStatuses.set(id, "AVAILABLE");
    }),
  };
  const promos = {
    releaseHoldsForOrder: vi.fn(async () => {
      callLog.push("tx.promos.releaseHoldsForOrder");
    }),
  };
  const feeWaivers = {
    release: vi.fn(async () => {
      callLog.push("tx.feeWaivers.release");
      return { releasedTickets: 0 };
    }),
  };
  const credits = {
    releaseForOrder: vi.fn(async () => {
      callLog.push("tx.credits.releaseForOrder");
      return { releasedCents: 0, creditIds: [] };
    }),
  };
  const resaleListings = { releaseHold: vi.fn() };
  const embeds = {
    getById: vi.fn(async () => {
      callLog.push("embeds.getById");
      return opts.embed === undefined ? embed() : opts.embed;
    }),
  };
  /** Not a dependency of this use case: present so a call would be seen. */
  const events = { getById: vi.fn() };

  const tx = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    callLog.push("tx.open");
    txOpen = true;
    try {
      return await fn({
        orders,
        seats,
        promos,
        feeWaivers,
        credits,
        resaleListings,
      });
    } finally {
      txOpen = false;
    }
  });

  const retrievePaymentIntentWithClientSecret = vi.fn(async () => {
    callLog.push("payments.retrievePaymentIntentWithClientSecret");
    if (opts.retrieveError !== undefined) throw opts.retrieveError;
    return {
      id: PI_ID,
      status: opts.piStatus ?? "requires_payment_method",
      amountReceived: 0,
      currency: "usd",
      metadata: opts.piMetadata ?? {
        orderId: ORDER_ID,
        source: "primary",
        embedId: EMBED_ID,
      },
      clientSecret:
        opts.piClientSecret === undefined ? REAL_SECRET : opts.piClientSecret,
    };
  });
  const cancelPaymentIntent = vi.fn(async () => {
    callLog.push("payments.cancelPaymentIntent");
    if (opts.cancelError !== undefined) throw opts.cancelError;
    return opts.cancelResult ?? { canceled: true };
  });
  /** The secret-less retrieve: only `releaseCartHold`'s status probe uses it. */
  const retrievePaymentIntent = vi.fn(async () => {
    callLog.push("payments.retrievePaymentIntent");
    return {
      id: PI_ID,
      status: opts.probeStatus ?? "canceled",
      amountReceived: 0,
      currency: "usd",
      metadata: {},
    };
  });

  const limiterDown = new Error("redis is down");
  const consume = vi.fn(
    async (_key: string, maxTokens: number, _windowSeconds: number) => {
      callLog.push("rateLimit.consume");
      if (opts.rateLimit === "throws") throw limiterDown;
      return opts.rateLimit === "spent"
        ? { allowed: false, remaining: 0, retryAfterSeconds: 42 }
        : { allowed: true, remaining: maxTokens - 1, retryAfterSeconds: 0 };
    },
  );

  const { logger, calls: logCalls } = recordingLogger();
  const reportError = vi.fn();
  const deps: ReleaseEmbedGuestOrderDeps = {
    rateLimit: opts.rateLimit === null ? null : { consume },
    repos: {
      tx,
      orders,
      embeds,
      events,
    } as unknown as ReleaseEmbedGuestOrderDeps["repos"],
    payments: {
      retrievePaymentIntentWithClientSecret,
      cancelPaymentIntent,
      retrievePaymentIntent,
    } as unknown as PaymentProcessorPort,
    clock: { now: () => NOW },
    logger,
    reportError,
    publicAppUrl: "https://app.example.test",
  };

  return {
    deps,
    callLog,
    orders,
    seats,
    promos,
    feeWaivers,
    credits,
    embeds,
    events,
    tx,
    retrievePaymentIntentWithClientSecret,
    cancelPaymentIntent,
    retrievePaymentIntent,
    consume,
    limiterDown,
    logCalls,
    reportError,
    orderStatus: () => orderStatus,
    seatStatuses,
  };
}

const input = (over: Record<string, unknown> = {}) => ({
  embedId: EMBED_ID,
  hostOrigin: HOST_ORIGIN,
  clientSecret: REAL_SECRET,
  ...over,
});

/** The whole thrown value as data (see the confirm suite's `errorShape`). */
const errorShape = (err: unknown, depth = 0): unknown => {
  if (err === null || typeof err !== "object") return err;
  if (depth > 5) return "[too deep]";
  if (Array.isArray(err)) return err.map((item) => errorShape(item, depth + 1));
  const out: Record<string, unknown> = {};
  const keys = new Set([
    ...Object.getOwnPropertyNames(err),
    "name",
    "message",
    "code",
    "meta",
    "issues",
    "cause",
  ]);
  keys.delete("stack");
  for (const key of keys) {
    const value = (err as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = errorShape(value, depth + 1);
  }
  return out;
};

/** Nothing was cancelled at Stripe and nothing was written. */
const expectUntouched = (h: ReturnType<typeof harness>) => {
  expect(h.cancelPaymentIntent).not.toHaveBeenCalled();
  expect(h.tx).not.toHaveBeenCalled();
  expect(h.orders.cancelPendingOrder).not.toHaveBeenCalled();
  expect(h.seats.releaseSeats).not.toHaveBeenCalled();
  expect([...h.seatStatuses.values()]).toEqual(["HELD", "HELD"]);
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("releaseEmbedGuestOrder — released", () => {
  it("cancels the PaymentIntent at Stripe BEFORE the transaction opens, then cancels the order and frees its holds in one transaction, as the order's buyer", async () => {
    const h = harness();

    const out = await releaseEmbedGuestOrder(h.deps, input());

    expect(out).toEqual({ outcome: "released", orderId: ORDER_ID });
    expect(h.orderStatus()).toBe("CANCELLED");
    expect([...h.seatStatuses.values()]).toEqual(["AVAILABLE", "AVAILABLE"]);

    // Relative order only (what `releaseCartHold` does inside is its own
    // suite's business): the cheap refusals, then the per-PaymentIntent
    // budget, then proof, then Stripe's cancel with NO transaction open,
    // then the transaction, then the swap, then the seats.
    const at = (call: string) => {
      const index = h.callLog.indexOf(call);
      expect(index, `${call} was never called`).toBeGreaterThanOrEqual(0);
      return index;
    };
    const order = [
      "embeds.getById",
      "orders.findByPaymentIntent",
      "rateLimit.consume",
      "payments.retrievePaymentIntentWithClientSecret",
      "payments.cancelPaymentIntent",
      "tx.open",
      "tx.orders.cancelPendingOrder",
      "tx.seats.releaseSeats",
    ].map(at);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(h.cancelPaymentIntent).toHaveBeenCalledWith({
      paymentIntentId: PI_ID,
    });
    expect(h.tx).toHaveBeenCalledTimes(1);
    // The CAS is fenced on the PaymentIntent that was settled.
    expect(h.orders.cancelPendingOrder).toHaveBeenCalledWith(ORDER_ID, {
      expectedPaymentIntentId: PI_ID,
    });
    expect(h.seats.releaseSeats).toHaveBeenCalledWith(
      expect.objectContaining({ seatIds: [SEAT_A, SEAT_B], releasedAt: NOW }),
    );
    expect(h.retrievePaymentIntentWithClientSecret).toHaveBeenCalledWith({
      paymentIntentId: PI_ID,
    });
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it("a PaymentIntent Stripe already cancelled is proven dead by the status probe, and the order is still released", async () => {
    const h = harness({
      piStatus: "canceled",
      cancelResult: { canceled: false },
      probeStatus: "canceled",
    });

    await expect(releaseEmbedGuestOrder(h.deps, input())).resolves.toEqual({
      outcome: "released",
      orderId: ORDER_ID,
    });
    expect(h.retrievePaymentIntent).toHaveBeenCalledTimes(1);
    expect(h.orderStatus()).toBe("CANCELLED");
  });

  it("released, then asked again: the second call is 'gone' and cancels nothing twice", async () => {
    const h = harness();

    const first = await releaseEmbedGuestOrder(h.deps, input());
    const second = await releaseEmbedGuestOrder(h.deps, input());

    expect(first.outcome).toBe("released");
    expect(second).toEqual({ outcome: "gone", orderId: ORDER_ID });
    expect(h.cancelPaymentIntent).toHaveBeenCalledTimes(1);
    expect(h.tx).toHaveBeenCalledTimes(1);
  });

  it("is not stopped by an embed switched to link-out after the order was made", async () => {
    const h = harness({ embed: embed({ linkOut: true }) });

    await expect(
      releaseEmbedGuestOrder(h.deps, input()),
    ).resolves.toMatchObject({ outcome: "released" });
  });

  it("does not read the event: the embed binding already says the order is this embed's", async () => {
    const h = harness();

    await releaseEmbedGuestOrder(h.deps, input());

    expect(h.events.getById).not.toHaveBeenCalled();
  });

  it.each([["released", {}], ["gone", { orderStatus: "CANCELLED" }], ["kept", { piStatus: "succeeded" }]] as const)(
    "the '%s' answer fits the output schema and carries nothing but the outcome and the order id",
    async (outcome, opts) => {
      const h = harness(opts);
      const out = await releaseEmbedGuestOrder(h.deps, input());

      expect(out.outcome).toBe(outcome);
      expect(releaseEmbedGuestOrderOutputSchema.parse(out)).toEqual(out);
      expect(Object.keys(out).sort()).toEqual(["orderId", "outcome"]);
    },
  );
});

describe("releaseEmbedGuestOrder — kept: a paid order is never touched", () => {
  it.each([["succeeded"], ["processing"]])(
    "a %s PaymentIntent is answered 'kept' with no cancel attempt, no transaction and no order read",
    async (piStatus) => {
      const h = harness({ piStatus });

      await expect(releaseEmbedGuestOrder(h.deps, input())).resolves.toEqual({
        outcome: "kept",
        orderId: ORDER_ID,
      });

      expectUntouched(h);
      expect(h.orders.getById).not.toHaveBeenCalled();
      expect(h.retrievePaymentIntent).not.toHaveBeenCalled();
      expect(h.orderStatus()).toBe("PENDING");
      // The buyer paid in another tab: normal, logged at info, not reported.
      expect(h.reportError).not.toHaveBeenCalled();
      expect(h.logCalls.some((c) => c[0] === "error")).toBe(false);
      expect(h.logCalls).toContainEqual([
        "info",
        "releaseEmbedGuestOrder.answered",
        {
          embedId: EMBED_ID,
          orderId: ORDER_ID,
          paymentIntentId: PI_ID,
          outcome: "kept",
          reason: `payment_intent_${piStatus}`,
        },
      ]);
    },
  );

  it.each([["SUCCEEDED"], ["PROCESSING"], ["REFUNDED"], ["DISPUTED"]])(
    "a %s order is 'kept' with no cancel attempt and no write",
    async (orderStatus) => {
      const h = harness({ orderStatus });

      await expect(releaseEmbedGuestOrder(h.deps, input())).resolves.toEqual({
        outcome: "kept",
        orderId: ORDER_ID,
      });
      expectUntouched(h);
      expect(h.orderStatus()).toBe(orderStatus);
      expect(h.reportError).not.toHaveBeenCalled();
    },
  );

  it("the buyer paid between the proof and the cancel: Stripe will not cancel, the probe says succeeded, the order is kept and that is reported", async () => {
    const h = harness({
      cancelResult: { canceled: false },
      probeStatus: "succeeded",
    });

    await expect(releaseEmbedGuestOrder(h.deps, input())).resolves.toEqual({
      outcome: "kept",
      orderId: ORDER_ID,
    });

    expect(h.cancelPaymentIntent).toHaveBeenCalledTimes(1);
    expect(h.tx).not.toHaveBeenCalled();
    expect(h.orderStatus()).toBe("PENDING");
    expect([...h.seatStatuses.values()]).toEqual(["HELD", "HELD"]);
    expect(h.reportError).toHaveBeenCalledTimes(1);
    const [reported, context] = h.reportError.mock.calls[0]!;
    expect((reported as Error).message).toBe(
      "carried_over_cart_pi_terminal_not_canceled:succeeded",
    );
    expect(context).toMatchObject({
      tags: { caller: "releaseCartHold" },
      extra: { orderId: ORDER_ID, paymentIntentId: PI_ID },
    });
  });

  it("Stripe's cancel throws: the order is kept, nothing is written, and the failure is reported (not thrown)", async () => {
    const outage = new Error("stripe is down");
    const h = harness({ cancelError: outage });

    await expect(releaseEmbedGuestOrder(h.deps, input())).resolves.toEqual({
      outcome: "kept",
      orderId: ORDER_ID,
    });

    expect(h.tx).not.toHaveBeenCalled();
    expect(h.orderStatus()).toBe("PENDING");
    expect([...h.seatStatuses.values()]).toEqual(["HELD", "HELD"]);
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError.mock.calls[0]![0]).toBe(outage);
  });

  it("a throwing reporter changes nothing: the answer is still 'kept'", async () => {
    const h = harness({ cancelError: new Error("stripe is down") });
    h.reportError.mockImplementation(() => {
      throw new Error("sentry is down");
    });

    await expect(releaseEmbedGuestOrder(h.deps, input())).resolves.toEqual({
      outcome: "kept",
      orderId: ORDER_ID,
    });
  });

  it("works with no reporter wired", async () => {
    const h = harness({ cancelError: new Error("stripe is down") });
    h.deps.reportError = undefined;

    await expect(
      releaseEmbedGuestOrder(h.deps, input()),
    ).resolves.toMatchObject({ outcome: "kept" });
  });

  it("the compare-and-swap loses (finalize got there first): 'kept', and the seats stay held", async () => {
    const h = harness({ loseCas: true });

    await expect(releaseEmbedGuestOrder(h.deps, input())).resolves.toEqual({
      outcome: "kept",
      orderId: ORDER_ID,
    });

    expect(h.orders.cancelPendingOrder).toHaveBeenCalledTimes(1);
    expect(h.orderStatus()).toBe("SUCCEEDED");
    expect(h.seats.releaseSeats).not.toHaveBeenCalled();
    expect(h.promos.releaseHoldsForOrder).not.toHaveBeenCalled();
    expect(h.feeWaivers.release).not.toHaveBeenCalled();
    expect(h.credits.releaseForOrder).not.toHaveBeenCalled();
    expect([...h.seatStatuses.values()]).toEqual(["HELD", "HELD"]);
  });
});

describe("releaseEmbedGuestOrder — gone", () => {
  it("the compare-and-swap loses to ANOTHER CANCEL (a second release, the cart reaper): the order is CANCELLED, so the answer is 'gone', not 'kept'", async () => {
    const h = harness({ loseCasToCancel: true });

    await expect(releaseEmbedGuestOrder(h.deps, input())).resolves.toEqual({
      outcome: "gone",
      orderId: ORDER_ID,
    });

    expect(h.orders.cancelPendingOrder).toHaveBeenCalledTimes(1);
    expect(h.orderStatus()).toBe("CANCELLED");
    // The loser frees nothing itself: the winner did, in its own transaction.
    expect(h.seats.releaseSeats).not.toHaveBeenCalled();
    expect(h.promos.releaseHoldsForOrder).not.toHaveBeenCalled();
    expect(h.reportError).not.toHaveBeenCalled();
    expect(h.logCalls).toContainEqual([
      "info",
      "releaseEmbedGuestOrder.answered",
      expect.objectContaining({
        outcome: "gone",
        reason: "release_lost_to_another_cancel",
      }),
    ]);
  });

  it("two releases at once: both pass the PENDING read and settle the PaymentIntent, one swaps, and they answer 'released' and 'gone' (never 'kept'), freeing the seats once", async () => {
    const h = harness();

    const outcomes = await Promise.all([
      releaseEmbedGuestOrder(h.deps, input()),
      releaseEmbedGuestOrder(h.deps, input()),
    ]);

    // The race is real in this run: both got as far as the swap.
    expect(h.cancelPaymentIntent).toHaveBeenCalledTimes(2);
    expect(h.orders.cancelPendingOrder).toHaveBeenCalledTimes(2);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual([
      "gone",
      "released",
    ]);
    expect(h.seats.releaseSeats).toHaveBeenCalledTimes(1);
    expect(h.orderStatus()).toBe("CANCELLED");
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it("an order already CANCELLED (reaped, released earlier, retired) is 'gone' with no cancel attempt and no write", async () => {
    const h = harness({ orderStatus: "CANCELLED" });

    await expect(releaseEmbedGuestOrder(h.deps, input())).resolves.toEqual({
      outcome: "gone",
      orderId: ORDER_ID,
    });
    expectUntouched(h);
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it("an order row that no longer exists is 'gone'", async () => {
    const h = harness({ orderStatus: null });

    await expect(releaseEmbedGuestOrder(h.deps, input())).resolves.toEqual({
      outcome: "gone",
      orderId: ORDER_ID,
    });
    expectUntouched(h);
  });
});

describe("releaseEmbedGuestOrder — the client secret and the embed binding are the proof", () => {
  it("an id no order is linked to is refused with NO Stripe call (a made-up id must not buy a retrieve)", async () => {
    const h = harness({ linkedOrder: null });

    await expect(
      releaseEmbedGuestOrder(h.deps, input()),
    ).rejects.toMatchObject({ code: "PAYMENT_INTENT_ORDER_MISMATCH" });

    expect(h.orders.findByPaymentIntent).toHaveBeenCalledWith(PI_ID);
    expect(h.retrievePaymentIntentWithClientSecret).not.toHaveBeenCalled();
    expect(h.retrievePaymentIntent).not.toHaveBeenCalled();
    expect(h.orders.getById).not.toHaveBeenCalled();
    expectUntouched(h);
  });

  it("a wrong secret for a real, linked PaymentIntent is refused: no order row is loaded and nothing is cancelled", async () => {
    const h = harness();

    await expect(
      releaseEmbedGuestOrder(h.deps, input({ clientSecret: WRONG_SECRET })),
    ).rejects.toMatchObject({ code: "PAYMENT_INTENT_ORDER_MISMATCH" });

    expect(h.retrievePaymentIntentWithClientSecret).toHaveBeenCalledTimes(1);
    expect(h.orders.getById).not.toHaveBeenCalled();
    expectUntouched(h);
  });

  it("an order made through ANOTHER embed is refused although the secret is right, and it is not cancelled", async () => {
    const h = harness({
      piMetadata: { orderId: ORDER_ID, embedId: OTHER_EMBED_ID },
    });

    await expect(
      releaseEmbedGuestOrder(h.deps, input()),
    ).rejects.toMatchObject({ code: "PAYMENT_INTENT_ORDER_MISMATCH" });

    expect(h.orders.getById).not.toHaveBeenCalled();
    expectUntouched(h);
    expect(h.orderStatus()).toBe("PENDING");
    expect(h.logCalls).toContainEqual([
      "warn",
      "releaseEmbedGuestOrder.refused",
      {
        embedId: EMBED_ID,
        paymentIntentId: PI_ID,
        reason: "metadata_embed_id_other_embed",
      },
    ]);
  });

  it.each([
    ["no embedId key (a main-checkout or resale order, or one made before the key existed)", { orderId: ORDER_ID, source: "primary" }],
    ["an empty embedId", { orderId: ORDER_ID, embedId: "" }],
  ])(
    "an order with %s is refused although the secret is right: a signed-in buyer's order cannot be cancelled from an embed",
    async (_label, piMetadata) => {
      const h = harness({ piMetadata });

      await expect(
        releaseEmbedGuestOrder(h.deps, input()),
      ).rejects.toMatchObject({ code: "PAYMENT_INTENT_ORDER_MISMATCH" });

      expect(h.orders.getById).not.toHaveBeenCalled();
      expectUntouched(h);
      expect(h.logCalls).toContainEqual([
        "warn",
        "releaseEmbedGuestOrder.refused",
        {
          embedId: EMBED_ID,
          paymentIntentId: PI_ID,
          reason: "metadata_embed_id_missing",
        },
      ]);
    },
  );

  it("an unbound PAID order is refused too (never 'kept'): nothing about an order outside this embed is told", async () => {
    const h = harness({
      piStatus: "succeeded",
      piMetadata: { orderId: ORDER_ID, source: "primary" },
    });

    await expect(
      releaseEmbedGuestOrder(h.deps, input()),
    ).rejects.toMatchObject({ code: "PAYMENT_INTENT_ORDER_MISMATCH" });
    expectUntouched(h);
  });

  it("every way of not proving ownership gives ONE refusal: the same thrown value, no meta, no cause", async () => {
    const scenarios: Array<[ReturnType<typeof harness>, Record<string, unknown>]> = [
      [harness(), { clientSecret: WRONG_SECRET }],
      [harness({ linkedOrder: null }), {}],
      // What the Stripe adapter throws for `resource_missing`.
      [
        harness({
          retrieveError: new AppError("NOT_FOUND", {
            message: "payment intent not found at processor",
            meta: { paymentIntentId: PI_ID },
          }),
        }),
        {},
      ],
      [harness({ piClientSecret: null }), {}],
      [harness({ piMetadata: { embedId: EMBED_ID } }), {}],
      [harness({ piMetadata: { orderId: "not-a-uuid", embedId: EMBED_ID } }), {}],
      [
        harness({ linkedOrder: { id: OTHER_ORDER_ID, status: "PENDING" } }),
        {},
      ],
      [harness({ piMetadata: { orderId: ORDER_ID } }), {}],
      [
        harness({ piMetadata: { orderId: ORDER_ID, embedId: OTHER_EMBED_ID } }),
        {},
      ],
    ];

    const refusals = await Promise.all(
      scenarios.map(([h, over]) =>
        releaseEmbedGuestOrder(h.deps, input(over)).catch(errorShape),
      ),
    );

    expect(refusals[0]).toEqual(
      errorShape(new AppError("PAYMENT_INTENT_ORDER_MISMATCH")),
    );
    expect(refusals[0]).toMatchObject({
      code: "PAYMENT_INTENT_ORDER_MISMATCH",
      message: "PAYMENT_INTENT_ORDER_MISMATCH",
    });
    expect(refusals[0]).not.toHaveProperty("meta");
    expect(refusals[0]).not.toHaveProperty("cause");
    for (const refusal of refusals.slice(1)) {
      expect(refusal).toEqual(refusals[0]);
    }

    for (const [h] of scenarios) {
      expectUntouched(h);
      expect(h.orders.getById).not.toHaveBeenCalled();
      // A probe is not an incident.
      expect(h.reportError).not.toHaveBeenCalled();
    }
    // The ways differ only in the warn log's `reason`.
    expect(
      scenarios.map(
        ([h]) =>
          (
            h.logCalls.find(
              (c) => c[1] === "releaseEmbedGuestOrder.refused",
            )?.[2] as { reason: string }
          ).reason,
      ),
    ).toEqual([
      "secret_mismatch_or_unknown_payment_intent",
      "payment_intent_not_linked",
      "secret_mismatch_or_unknown_payment_intent",
      "secret_mismatch_or_unknown_payment_intent",
      "metadata_order_id_missing",
      "metadata_order_id_missing",
      "metadata_order_id_not_linked_order",
      "metadata_embed_id_missing",
      "metadata_embed_id_other_embed",
    ]);
  });

  it("a processor failure that is not 'no such PaymentIntent' is rethrown untouched (a Stripe outage must reach Sentry)", async () => {
    const outage = Object.assign(new Error("rate limited"), {
      type: "StripeRateLimitError",
    });
    const h = harness({ retrieveError: outage });

    await expect(releaseEmbedGuestOrder(h.deps, input())).rejects.toBe(outage);
    expectUntouched(h);
  });

  it("refuses with INTERNAL, and never falls back to the secret-less retrieve, when the processor cannot show a client secret", async () => {
    const h = harness();
    h.deps.payments = {
      retrievePaymentIntent: h.retrievePaymentIntent,
      cancelPaymentIntent: h.cancelPaymentIntent,
    } as unknown as PaymentProcessorPort;

    await expect(
      releaseEmbedGuestOrder(h.deps, input()),
    ).rejects.toMatchObject({ code: "INTERNAL" });
    expect(h.retrievePaymentIntent).not.toHaveBeenCalled();
    expectUntouched(h);
  });

  it("an order id is not an input: it proves nothing, so the schema refuses it", async () => {
    const h = harness();

    await expect(
      releaseEmbedGuestOrder(h.deps, input({ orderId: ORDER_ID })),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(h.embeds.getById).not.toHaveBeenCalled();
  });

  it.each([
    ["a bare PaymentIntent id", PI_ID],
    ["a SetupIntent secret", "seti_3Abc_secret_FakeFixtureNotReal"],
    ["two _secret_ separators", "pi_3Abc_secret_Fake_secret_FixtureNotReal"],
    ["an empty tail", "pi_3Abc_secret_"],
    ["whitespace", "pi_3Abc_secret_Fake FixtureNotReal"],
    ["more than 200 characters", `pi_3Abc_secret_${"a".repeat(200)}`],
    ["a non-string", 12345],
  ])(
    "refuses %s as bad input, with no read and no Stripe call",
    async (_label, clientSecret) => {
      const h = harness();

      await expect(
        releaseEmbedGuestOrder(h.deps, input({ clientSecret })),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(h.callLog).toEqual([]);
    },
  );
});

describe("releaseEmbedGuestOrder — one budget per PaymentIntent, before the Stripe call", () => {
  it("charges the linked id's own bucket, 6 per 60 s, after the link lookup and before the retrieve", async () => {
    const h = harness();

    await releaseEmbedGuestOrder(h.deps, input());

    expect(EMBED_GUEST_RELEASE_PI_BUDGET_KEY_PREFIX).toBe(
      "embed:guestRelease:pi:",
    );
    expect(EMBED_GUEST_RELEASE_PI_BUDGET_MAX).toBe(6);
    expect(h.consume).toHaveBeenCalledTimes(1);
    expect(h.consume).toHaveBeenCalledWith(
      `embed:guestRelease:pi:${PI_ID}`,
      6,
      60,
    );
    expect(h.callLog.slice(0, 4)).toEqual([
      "embeds.getById",
      "orders.findByPaymentIntent",
      "rateLimit.consume",
      "payments.retrievePaymentIntentWithClientSecret",
    ]);
  });

  it("an id no order is linked to spends none of it (a guess must not mint a counter)", async () => {
    const h = harness({ linkedOrder: null });

    await expect(
      releaseEmbedGuestOrder(h.deps, input()),
    ).rejects.toMatchObject({ code: "PAYMENT_INTENT_ORDER_MISMATCH" });
    expect(h.consume).not.toHaveBeenCalled();
  });

  it("a wrong secret for a linked id DOES spend it: that is the loop it bounds", async () => {
    const h = harness();

    await expect(
      releaseEmbedGuestOrder(h.deps, input({ clientSecret: WRONG_SECRET })),
    ).rejects.toMatchObject({ code: "PAYMENT_INTENT_ORDER_MISMATCH" });
    expect(h.consume).toHaveBeenCalledTimes(1);
  });

  it("over the limit: RATE_LIMITED with a retry hint, NO Stripe call, no order read, nothing cancelled, nothing reported", async () => {
    const h = harness({ rateLimit: "spent" });

    const thrown = await releaseEmbedGuestOrder(h.deps, input()).catch(
      (e: unknown) => e,
    );

    expect(errorShape(thrown)).toMatchObject({
      code: "RATE_LIMITED",
      meta: { scope: "embed_guest_proof", retryAfterSeconds: 42 },
    });
    // Not the finalize lock: the widget reads that one differently.
    expect((thrown as { code: string }).code).not.toBe(
      "IDEMPOTENCY_LOCK_IN_PROGRESS",
    );
    expect(h.retrievePaymentIntentWithClientSecret).not.toHaveBeenCalled();
    expect(h.retrievePaymentIntent).not.toHaveBeenCalled();
    expect(h.orders.getById).not.toHaveBeenCalled();
    expectUntouched(h);
    expect(h.reportError).not.toHaveBeenCalled();
    expect(JSON.stringify([errorShape(thrown), h.logCalls])).not.toContain(
      "_secret_",
    );
  });

  it("a limiter that throws fails OPEN: the release goes through, and the failure is logged at error and reported", async () => {
    const h = harness({ rateLimit: "throws" });

    await expect(releaseEmbedGuestOrder(h.deps, input())).resolves.toEqual({
      outcome: "released",
      orderId: ORDER_ID,
    });

    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError).toHaveBeenCalledWith(h.limiterDown, {
      tags: { useCase: "releaseEmbedGuestOrder", stage: "guestProofBudget" },
      extra: { embedId: EMBED_ID, paymentIntentId: PI_ID },
    });
    expect(
      h.logCalls.some(
        (c) =>
          c[0] === "error" &&
          c[1] === "releaseEmbedGuestOrder.proof_budget_consume_failed",
      ),
    ).toBe(true);
  });

  it("a limiter that throws AND a reporter that throws still release", async () => {
    const h = harness({ rateLimit: "throws" });
    h.reportError.mockImplementation(() => {
      throw new Error("sentry is down");
    });

    await expect(
      releaseEmbedGuestOrder(h.deps, input()),
    ).resolves.toMatchObject({ outcome: "released" });
  });

  it("works with no limiter wired", async () => {
    const h = harness({ rateLimit: null });

    await expect(
      releaseEmbedGuestOrder(h.deps, input()),
    ).resolves.toMatchObject({ outcome: "released" });
    expect(h.consume).not.toHaveBeenCalled();
  });
});

describe("releaseEmbedGuestOrder — the embed", () => {
  it("refuses an origin the embed does not allow, before the order lookup and any Stripe call", async () => {
    const h = harness();

    await expect(
      releaseEmbedGuestOrder(
        h.deps,
        input({ hostOrigin: "https://evil.example.net" }),
      ),
    ).rejects.toMatchObject({ code: "EMBED_ORIGIN_NOT_ALLOWED" });
    expect(h.callLog).toEqual(["embeds.getById"]);
  });

  it("refuses a null origin (fail closed)", async () => {
    const h = harness();

    await expect(
      releaseEmbedGuestOrder(h.deps, input({ hostOrigin: null })),
    ).rejects.toMatchObject({ code: "EMBED_ORIGIN_NOT_ALLOWED" });
    expect(h.callLog).toEqual(["embeds.getById"]);
  });

  it.each([
    ["revoked", embed({ status: "REVOKED" })],
    ["missing", null],
  ])(
    "refuses a %s embed with EMBED_NOT_FOUND, before the order lookup and any Stripe call",
    async (_l, e) => {
      const h = harness({ embed: e });

      await expect(
        releaseEmbedGuestOrder(h.deps, input()),
      ).rejects.toMatchObject({ code: "EMBED_NOT_FOUND" });
      expect(h.callLog).toEqual(["embeds.getById"]);
    },
  );
});

describe("releaseEmbedGuestOrder — the secret goes nowhere", () => {
  it("a Stripe error from the cancel is passed on as the adapter delivered it; the use case adds no secret of its own around it", async () => {
    // Stripping `payment_intent` / `setup_intent` (which carry the client
    // secret) from a Stripe error is the ADAPTER's job, done once for every
    // caller (stripe-adapter.ts `withoutClientSecretCarriers`, tested in the
    // adapter's suite). So the fake delivers what the adapter now delivers…
    const asDelivered = Object.assign(new Error("Your card was declined."), {
      type: "StripeCardError",
      code: "card_declined",
      raw: { code: "card_declined", message: "Your card was declined." },
    });
    const delivered = harness({ cancelError: asDelivered });
    await expect(
      releaseEmbedGuestOrder(delivered.deps, input()),
    ).resolves.toMatchObject({ outcome: "kept" });
    expect(delivered.reportError.mock.calls[0]![0]).toBe(asDelivered);
    expect(
      JSON.stringify([
        delivered.logCalls,
        delivered.reportError.mock.calls.map((c) => [errorShape(c[0]), c[1]]),
      ]),
    ).not.toContain("_secret_");

    // …and this pins that the use case itself is not a second source. An
    // error that DID carry the secret (an adapter regression) is handed on
    // untouched, as the same object, and everything logged and reported
    // AROUND that object is still free of the secret.
    const carrier = Object.assign(new Error("Your card was declined."), {
      type: "StripeCardError",
      raw: { payment_intent: { id: PI_ID, client_secret: REAL_SECRET } },
    });
    const h = harness({ cancelError: carrier });
    await expect(
      releaseEmbedGuestOrder(h.deps, input()),
    ).resolves.toEqual({ outcome: "kept", orderId: ORDER_ID });

    expect(h.reportError.mock.calls[0]![0]).toBe(carrier);
    const aroundTheError = JSON.stringify(
      [h.logCalls, h.reportError.mock.calls],
      (_key, value) => (value === carrier ? "[the adapter's error]" : value),
    );
    expect(aroundTheError).toContain("[the adapter's error]");
    expect(aroundTheError).not.toContain("_secret_");
  });

  it("a real-shaped secret that fails the pattern (a trailing space) is not carried in the thrown value", async () => {
    const h = harness();
    const thrown = await releaseEmbedGuestOrder(
      h.deps,
      input({ clientSecret: `${REAL_SECRET} ` }),
    ).catch((e: unknown) => e);

    expect(thrown).toMatchObject({ code: "invalid_input" });
    const whole = JSON.stringify([errorShape(thrown), String(thrown), h.logCalls]);
    expect(whole).toContain("clientSecret"); // the issue names the field…
    expect(whole).not.toContain(REAL_SECRET); // …never its value
    expect(whole).not.toContain("FakeFixture");
    expect(h.callLog).toEqual([]);
  });

  it("neither the presented nor the real secret reaches a logger call, the reporter, a thrown error or the answer", async () => {
    const seen: unknown[] = [];
    const run = async (
      h: ReturnType<typeof harness>,
      over: Record<string, unknown> = {},
    ) => {
      try {
        seen.push(await releaseEmbedGuestOrder(h.deps, input(over)));
      } catch (err) {
        seen.push(errorShape(err), String(err));
      }
      seen.push(
        h.logCalls,
        h.reportError.mock.calls.map((c) => [errorShape(c[0]), c[1]]),
        // What Stripe and the repos were handed after the proof.
        h.cancelPaymentIntent.mock.calls,
        h.retrievePaymentIntent.mock.calls,
        h.orders.cancelPendingOrder.mock.calls,
      );
      return h;
    };

    const released = await run(harness());
    await run(harness({ piStatus: "succeeded" }));
    await run(harness({ piStatus: "processing" }));
    await run(harness({ orderStatus: "CANCELLED" }));
    await run(harness({ orderStatus: "SUCCEEDED" }));
    await run(harness({ loseCas: true }));
    await run(harness(), { clientSecret: WRONG_SECRET });
    await run(harness({ linkedOrder: null }));
    await run(
      harness({
        retrieveError: new AppError("NOT_FOUND", {
          meta: { paymentIntentId: PI_ID },
        }),
      }),
    );
    await run(harness({ piMetadata: {} }));
    await run(harness({ piMetadata: { orderId: ORDER_ID } }));
    await run(
      harness({ piMetadata: { orderId: ORDER_ID, embedId: OTHER_EMBED_ID } }),
    );
    await run(harness(), { hostOrigin: "https://evil.example.net" });
    await run(harness({ embed: null }));
    // Kept under a Stripe refusal and a Stripe failure: both are reported.
    const refused = await run(
      harness({ cancelResult: { canceled: false }, probeStatus: "succeeded" }),
    );
    const failed = await run(harness({ cancelError: new Error("stripe is down") }));
    expect(refused.reportError).toHaveBeenCalledTimes(1);
    expect(failed.reportError).toHaveBeenCalledTimes(1);

    // The scenarios did log: an empty record would prove nothing.
    expect(released.logCalls.length).toBeGreaterThan(0);

    const everything = JSON.stringify(seen);
    expect(everything).toContain(PI_ID); // the id is fine to log
    expect(everything).not.toContain(REAL_SECRET);
    expect(everything).not.toContain(WRONG_SECRET);
    expect(everything).not.toContain("_secret_");
    expect(everything).not.toContain("FakeFixture");
  });
});
