import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@th/errors";
import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";
import type { SeatLabelRead } from "@th/ports/repos/seats";
import type { TicketRecord } from "@th/types";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";

/**
 * `confirmEmbedGuestPayment` is the embed widget's `orders.confirmPayment`: a
 * guest has no session, so the PaymentIntent client secret is the proof that
 * an order is theirs.
 *
 * `finalizePaymentIntent` is mocked, as in `confirm-payment.test.ts`: its own
 * suite covers the finalize flow, including the replay of an order the
 * webhook already made SUCCEEDED. Here the questions are who may ask, what the
 * finalize is handed, and that the secret goes nowhere.
 */
const finalizeMock = vi.hoisted(() => vi.fn());
vi.mock("../../orders/finalize-from-payment-intent", () => ({
  finalizePaymentIntent: finalizeMock,
}));

import {
  EMBED_GUEST_CONFIRM_PI_BUDGET_KEY_PREFIX,
  EMBED_GUEST_CONFIRM_PI_BUDGET_MAX,
  EMBED_GUEST_TICKET_MAX,
  EMBED_GUEST_TICKET_WINDOW_MS,
  confirmEmbedGuestPayment,
  confirmEmbedGuestPaymentOutputSchema,
  type ConfirmEmbedGuestPaymentDeps,
} from "../confirm-embed-guest-payment";

// ── Defaults ─────────────────────────────────────────────────────────────────

const EMBED_ID = "00000000-0000-4000-8000-000000000010";
const EVENT_ID = "00000000-0000-4000-8000-000000000011";
const ORG_ID = "00000000-0000-4000-8000-000000000012";
const BUYER = "00000000-0000-4000-8000-000000000013";
const ORDER_ID = "00000000-0000-4000-8000-000000000014";
const OTHER_ORG_ID = "00000000-0000-4000-8000-000000000015";
const OTHER_EVENT_ID = "00000000-0000-4000-8000-000000000016";
/** Matches `embed().domain` — the allowlisted embedding origin. */
const HOST_ORIGIN = "https://shop.example.com";

const GA_TYPE_ID = "00000000-0000-4000-8000-000000000017";
const SEATED_TYPE_ID = "00000000-0000-4000-8000-000000000018";
const OTHER_HUMAN = "00000000-0000-4000-8000-000000000019";
const NOW = new Date("2026-10-11T12:00:00Z");

const PI_ID = "pi_3EmbedGuestConfirm1";
// gitleaks:allow (fake test fixtures)
const REAL_SECRET = `${PI_ID}_secret_FakeFixtureRealNotReal`;
// gitleaks:allow (fake test fixture)
const WRONG_SECRET = `${PI_ID}_secret_FakeFixtureWrongNotReal`;
/**
 * The order's receipt secret (43 base64url characters, like a real one) and
 * the hash `createEmbedGuestCheckout` writes to the PaymentIntent's metadata.
 * Hashed here with node:crypto, not with the module under test.
 */
const RECEIPT_SECRET = "FakeReceiptSecretFixture_NotReal-0123456789A";
const WRONG_RECEIPT_SECRET = "FakeReceiptSecretFixture_Wrong--0123456789A";
const RECEIPT_SECRET_HASH = createHash("sha256")
  .update(RECEIPT_SECRET)
  .digest("hex");

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

type OrderRow = {
  id: string;
  buyerHumanId: string;
  eventId: string | null;
  status: string;
  stripePaymentIntentId?: string | null;
};

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
    order?: Partial<OrderRow> | null;
    event?: { id: string; orgId: string | null } | null;
    piStatus?: string;
    piMetadata?: Record<string, string>;
    piClientSecret?: string | null;
    /** Thrown by the processor's retrieve instead of answering. */
    retrieveError?: unknown;
    /**
     * What `orders.findByPaymentIntent` answers: the order this PaymentIntent
     * is linked to. Defaults to ORDER_ID; null is an id no order carries.
     */
    linkedOrder?: { id: string; status: string } | null;
    /**
     * The per-PaymentIntent budget. `"spent"` denies, `"throws"` is a limiter
     * whose backend is down, `null` is no limiter wired. Default: allows.
     */
    rateLimit?: "spent" | "throws" | null;
    /** The order's Ticket rows (`tickets.listByOrderId`). Default: none. */
    tickets?: TicketRecord[];
    /** Thrown by `tickets.listByOrderId` instead of answering. */
    ticketsError?: unknown;
    /** What `seats.findLabelsByIds` knows. Default: no seats. */
    seats?: SeatLabelRead[];
    /** Thrown by `seats.findLabelsByIds` instead of answering. */
    seatsError?: unknown;
    /** `events.listTicketTypes`. Default: the GA type. */
    ticketTypes?: Array<{ id: string; name: string }>;
    /** The clock. Default: NOW. */
    now?: Date;
  } = {},
) {
  const orderRow: OrderRow | null =
    opts.order === null
      ? null
      : {
          id: ORDER_ID,
          buyerHumanId: BUYER,
          eventId: EVENT_ID,
          status: "PENDING",
          stripePaymentIntentId: PI_ID,
          ...opts.order,
        };
  const orders = {
    findByPaymentIntent: vi.fn(async (_piId: string) =>
      opts.linkedOrder === undefined
        ? { id: ORDER_ID, status: orderRow?.status ?? "PENDING" }
        : opts.linkedOrder,
    ),
    getById: vi.fn(async (id: string) =>
      orderRow && orderRow.id === id ? orderRow : null,
    ),
    // CAS like the adapter: PENDING → PROCESSING only.
    markProcessingIfPending: vi.fn(async () => {
      if (!orderRow || orderRow.status !== "PENDING") return false;
      orderRow.status = "PROCESSING";
      return true;
    }),
  };
  const embeds = {
    getById: vi.fn(async () => (opts.embed === undefined ? embed() : opts.embed)),
  };
  const events = {
    getById: vi.fn(async () =>
      opts.event === undefined ? { id: EVENT_ID, orgId: ORG_ID } : opts.event,
    ),
    listTicketTypes: vi.fn(async (_eventId: string) =>
      opts.ticketTypes ?? [{ id: GA_TYPE_ID, name: "General Admission" }],
    ),
  };
  const tickets = {
    // Like the adapter: only this order's rows.
    listByOrderId: vi.fn(async (orderId: string) => {
      if (opts.ticketsError !== undefined) throw opts.ticketsError;
      return (opts.tickets ?? []).filter((t) => t.orderId === orderId);
    }),
  };
  const seats = {
    // Like the adapter: only the asked-for seats (the event scope is the
    // caller's argument, asserted where it matters).
    findLabelsByIds: vi.fn(
      async (arg: { seatIds: string[]; eventId: string }) => {
        if (opts.seatsError !== undefined) throw opts.seatsError;
        return (opts.seats ?? []).filter((s) => arg.seatIds.includes(s.id));
      },
    ),
    /** The locking read: a confirmation must never take it. */
    findByIdsForUpdate: vi.fn(),
  };
  const seriesOccurrences = {
    findSeriesIdByEventId: vi.fn(async () => null),
    listPublishedDatesBySeriesId: vi.fn(async () => []),
  };

  const retrievePaymentIntentWithClientSecret = vi.fn(async () => {
    if (opts.retrieveError !== undefined) throw opts.retrieveError;
    return {
      id: PI_ID,
      status: opts.piStatus ?? "succeeded",
      amountReceived: 2500,
      currency: "usd",
      metadata: opts.piMetadata ?? { orderId: ORDER_ID, source: "primary" },
      clientSecret:
        opts.piClientSecret === undefined ? REAL_SECRET : opts.piClientSecret,
    };
  });
  /** The secret-less retrieve: this use case must never need it. */
  const retrievePaymentIntent = vi.fn();

  const limiterDown = new Error("redis is down");
  const consume = vi.fn(
    async (_key: string, maxTokens: number, _windowSeconds: number) => {
      if (opts.rateLimit === "throws") throw limiterDown;
      return opts.rateLimit === "spent"
        ? { allowed: false, remaining: 0, retryAfterSeconds: 42 }
        : { allowed: true, remaining: maxTokens - 1, retryAfterSeconds: 0 };
    },
  );

  const { logger, calls: logCalls } = recordingLogger();
  const reportError = vi.fn();
  const deps: ConfirmEmbedGuestPaymentDeps = {
    rateLimit: opts.rateLimit === null ? null : { consume },
    repos: {
      orders,
      embeds,
      events,
      seriesOccurrences,
      tickets,
      seats,
    } as unknown as Repos,
    payments: {
      retrievePaymentIntentWithClientSecret,
      retrievePaymentIntent,
    } as unknown as PaymentProcessorPort,
    idempotency: createFakeIdempotencyPort(),
    clock: { now: () => opts.now ?? NOW },
    logger,
    reportError,
    publicAppUrl: "https://app.example.test",
  };
  return {
    deps,
    orders,
    embeds,
    events,
    tickets,
    seats,
    orderRow,
    retrievePaymentIntentWithClientSecret,
    retrievePaymentIntent,
    consume,
    limiterDown,
    logCalls,
    reportError,
  };
}

const input = (over: Record<string, unknown> = {}) => ({
  embedId: EMBED_ID,
  hostOrigin: HOST_ORIGIN,
  clientSecret: REAL_SECRET,
  receiptSecret: RECEIPT_SECRET,
  ...over,
});

/**
 * The WHOLE thrown value, as data: every own property plus the ones an Error
 * keeps off `JSON.stringify` (`name`, `message`, `cause`) and the ones a
 * client or a log could see (`code`, `meta`, zod `issues`), walked into
 * `cause` and arrays. Only `stack` is left out (it repeats the message and
 * differs by call site).
 */
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

beforeEach(() => {
  finalizeMock.mockReset();
  finalizeMock.mockImplementation(
    async (
      _deps: unknown,
      arg: { stripeEvent: { data: { object: { metadata: { orderId: string } } } } },
    ) => ({ ok: true, orderId: arg.stripeEvent.data.object.metadata.orderId }),
  );
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("confirmEmbedGuestPayment — the three answers", () => {
  it("confirmed: a succeeded PaymentIntent finalizes the order its metadata names, as the order's buyer", async () => {
    const h = harness();

    const out = await confirmEmbedGuestPayment(h.deps, input());

    // The harness's finalize is a mock that mints nothing: no tickets.
    expect(out).toEqual({ outcome: "confirmed", orderId: ORDER_ID, tickets: [] });
    // The PaymentIntent id is the part of the secret before `_secret_`.
    expect(h.retrievePaymentIntentWithClientSecret).toHaveBeenCalledTimes(1);
    expect(h.retrievePaymentIntentWithClientSecret).toHaveBeenCalledWith({
      paymentIntentId: PI_ID,
    });
    // One Stripe retrieve per call: `confirmPayment`'s own is not repeated.
    expect(h.retrievePaymentIntent).not.toHaveBeenCalled();

    expect(finalizeMock).toHaveBeenCalledTimes(1);
    const finalizeInput = finalizeMock.mock.calls[0]![1];
    expect(finalizeInput.stripeEvent.data.object).toEqual({
      id: PI_ID,
      status: "succeeded",
      amount_received: 2500,
      currency: "usd",
      metadata: { orderId: ORDER_ID, source: "primary" },
    });
    // The same synthetic event id `orders.confirmPayment` uses, so a guest
    // confirm and a signed-in confirm of one PaymentIntent share finalize's
    // idempotency record.
    expect(finalizeInput.stripeEvent.id).toBe(`client_confirm_${PI_ID}`);
  });

  it("confirmed again: an order the webhook already made SUCCEEDED, and a second call, give the same answer", async () => {
    const h = harness({ order: { status: "SUCCEEDED" } });

    const first = await confirmEmbedGuestPayment(h.deps, input());
    const second = await confirmEmbedGuestPayment(h.deps, input());

    expect(first).toEqual({ outcome: "confirmed", orderId: ORDER_ID, tickets: [] });
    expect(second).toEqual(first);
    // Both go through finalize under ONE idempotency key; finalize's replay
    // of a SUCCEEDED order is what keeps the second call from minting twice.
    expect(finalizeMock.mock.calls.map((c) => c[1].stripeEvent.id)).toEqual([
      `client_confirm_${PI_ID}`,
      `client_confirm_${PI_ID}`,
    ]);
    expect(h.orders.markProcessingIfPending).not.toHaveBeenCalled();
  });

  it("processing: a bank payment still settling moves the order to PROCESSING and finalizes nothing", async () => {
    const h = harness({ piStatus: "processing" });

    const out = await confirmEmbedGuestPayment(h.deps, input());

    expect(out).toEqual({ outcome: "processing", orderId: ORDER_ID });
    expect(h.orders.markProcessingIfPending).toHaveBeenCalledWith(ORDER_ID);
    expect(h.orderRow!.status).toBe("PROCESSING");
    expect(finalizeMock).not.toHaveBeenCalled();

    // Asked again while the bank is still working: the same answer.
    await expect(confirmEmbedGuestPayment(h.deps, input())).resolves.toEqual({
      outcome: "processing",
      orderId: ORDER_ID,
    });
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it.each([
    ["requires_payment_method"],
    ["requires_confirmation"],
    ["requires_action"],
    ["requires_capture"],
    ["canceled"],
  ])(
    "not_paid: a %s PaymentIntent is answered with its Stripe status, not thrown",
    async (piStatus) => {
      const h = harness({ piStatus });

      const out = await confirmEmbedGuestPayment(h.deps, input());

      expect(out).toEqual({
        outcome: "not_paid",
        orderId: ORDER_ID,
        paymentIntentStatus: piStatus,
      });
      expect(finalizeMock).not.toHaveBeenCalled();
      expect(h.orders.markProcessingIfPending).not.toHaveBeenCalled();
      expect(h.orderRow!.status).toBe("PENDING");
    },
  );

  it.each([["succeeded"], ["processing"], ["canceled"]])(
    "the answer for a %s PaymentIntent fits the output schema and carries nothing but the state (and, confirmed, the tickets)",
    async (piStatus) => {
      const h = harness({ piStatus });
      const out = await confirmEmbedGuestPayment(h.deps, input());

      expect(confirmEmbedGuestPaymentOutputSchema.parse(out)).toEqual(out);
      expect(Object.keys(out).sort()).toEqual(
        {
          succeeded: ["orderId", "outcome", "tickets"],
          processing: ["orderId", "outcome"],
          canceled: ["orderId", "outcome", "paymentIntentStatus"],
        }[piStatus],
      );
    },
  );
});

describe("confirmEmbedGuestPayment — the client secret is the proof", () => {
  it("a wrong secret for a real, linked PaymentIntent is refused: the link is looked up, but no order row is loaded and nothing is written before proof", async () => {
    const h = harness();

    await expect(
      confirmEmbedGuestPayment(h.deps, input({ clientSecret: WRONG_SECRET })),
    ).rejects.toMatchObject({ code: "PAYMENT_INTENT_ORDER_MISMATCH" });

    // The one read that is allowed before proof: is this id ours at all?
    expect(h.orders.findByPaymentIntent).toHaveBeenCalledWith(PI_ID);
    expect(h.retrievePaymentIntentWithClientSecret).toHaveBeenCalledTimes(1);
    expect(h.orders.getById).not.toHaveBeenCalled();
    expect(h.orders.markProcessingIfPending).not.toHaveBeenCalled();
    expect(h.events.getById).not.toHaveBeenCalled();
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it("an id no order is linked to is refused with NO Stripe call (a made-up id must not buy a retrieve)", async () => {
    const h = harness({ linkedOrder: null });

    await expect(
      confirmEmbedGuestPayment(h.deps, input()),
    ).rejects.toMatchObject({ code: "PAYMENT_INTENT_ORDER_MISMATCH" });

    expect(h.orders.findByPaymentIntent).toHaveBeenCalledWith(PI_ID);
    expect(h.retrievePaymentIntentWithClientSecret).not.toHaveBeenCalled();
    expect(h.retrievePaymentIntent).not.toHaveBeenCalled();
    expect(h.orders.getById).not.toHaveBeenCalled();
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it("a PaymentIntent whose metadata names another order than the one it is linked to is refused, although the secret is right", async () => {
    const h = harness({
      linkedOrder: { id: OTHER_EVENT_ID, status: "CANCELLED" },
    });

    await expect(
      confirmEmbedGuestPayment(h.deps, input()),
    ).rejects.toMatchObject({ code: "PAYMENT_INTENT_ORDER_MISMATCH" });

    expect(h.orders.getById).not.toHaveBeenCalled();
    expect(h.orders.markProcessingIfPending).not.toHaveBeenCalled();
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it("a PaymentIntent the processor returns no secret for is refused", async () => {
    const h = harness({ piClientSecret: null });

    await expect(
      confirmEmbedGuestPayment(h.deps, input()),
    ).rejects.toMatchObject({ code: "PAYMENT_INTENT_ORDER_MISMATCH" });
    expect(h.orders.getById).not.toHaveBeenCalled();
  });

  it("an unlinked id, a wrong secret, an id Stripe does not know and a PaymentIntent that is not this order's give ONE refusal: the same thrown value", async () => {
    const unlinked = harness({ linkedOrder: null });
    const otherOrderLinked = harness({
      linkedOrder: { id: OTHER_EVENT_ID, status: "PENDING" },
    });
    const wrongSecret = harness();
    // What the Stripe adapter throws for `resource_missing`.
    const unknown = harness({
      retrieveError: new AppError("NOT_FOUND", {
        message: "payment intent not found at processor",
        meta: { paymentIntentId: PI_ID },
      }),
    });
    const noOrderId = harness({ piMetadata: {} });
    const junkOrderId = harness({ piMetadata: { orderId: "not-a-uuid" } });

    const refusals = await Promise.all([
      confirmEmbedGuestPayment(
        wrongSecret.deps,
        input({ clientSecret: WRONG_SECRET }),
      ).catch(errorShape),
      confirmEmbedGuestPayment(unknown.deps, input()).catch(errorShape),
      confirmEmbedGuestPayment(noOrderId.deps, input()).catch(errorShape),
      confirmEmbedGuestPayment(junkOrderId.deps, input()).catch(errorShape),
      confirmEmbedGuestPayment(unlinked.deps, input()).catch(errorShape),
      confirmEmbedGuestPayment(otherOrderLinked.deps, input()).catch(
        errorShape,
      ),
    ]);

    expect(refusals[0]).toMatchObject({
      code: "PAYMENT_INTENT_ORDER_MISMATCH",
      message: "PAYMENT_INTENT_ORDER_MISMATCH",
    });
    expect(refusals[0]).not.toHaveProperty("meta");
    expect(refusals[0]).not.toHaveProperty("cause");
    for (const refusal of refusals.slice(1)) {
      expect(refusal).toEqual(refusals[0]);
    }

    for (const h of [
      wrongSecret,
      unknown,
      noOrderId,
      junkOrderId,
      unlinked,
      otherOrderLinked,
    ]) {
      expect(h.orders.markProcessingIfPending).not.toHaveBeenCalled();
      expect(h.orders.getById).not.toHaveBeenCalled();
      expect(finalizeMock).not.toHaveBeenCalled();
    }
    // Before the secret is proven nothing is reported: a probe is not an
    // incident. (After proof, a PAID PaymentIntent refused on its metadata is
    // reported; see the report suite below. The thrown value is the same.)
    for (const h of [wrongSecret, unknown, unlinked]) {
      expect(h.reportError).not.toHaveBeenCalled();
    }
  });

  it("a string with two _secret_ separators sharing an underscore fits the pattern, is looked up by the part before the FIRST one, and is refused because the whole string is not that PaymentIntent's secret", async () => {
    const h = harness();
    // gitleaks:allow (fake test fixture)
    const overlapping = "pi_a_secret_secret_x";

    await expect(
      confirmEmbedGuestPayment(h.deps, input({ clientSecret: overlapping })),
    ).rejects.toMatchObject({ code: "PAYMENT_INTENT_ORDER_MISMATCH" });

    expect(h.orders.findByPaymentIntent).toHaveBeenCalledWith("pi_a");
    expect(h.retrievePaymentIntentWithClientSecret).toHaveBeenCalledWith({
      paymentIntentId: "pi_a",
    });
    expect(h.orders.getById).not.toHaveBeenCalled();
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it("a processor failure that is not 'no such PaymentIntent' is rethrown untouched (a Stripe outage must reach Sentry)", async () => {
    const outage = Object.assign(new Error("rate limited"), {
      type: "StripeRateLimitError",
    });
    const h = harness({ retrieveError: outage });

    await expect(confirmEmbedGuestPayment(h.deps, input())).rejects.toBe(
      outage,
    );
  });

  it("refuses with INTERNAL, and never falls back to the secret-less retrieve, when the processor cannot show a client secret", async () => {
    const h = harness();
    h.deps.payments = {
      retrievePaymentIntent: h.retrievePaymentIntent,
    } as unknown as PaymentProcessorPort;

    await expect(
      confirmEmbedGuestPayment(h.deps, input()),
    ).rejects.toMatchObject({ code: "INTERNAL" });
    expect(h.retrievePaymentIntent).not.toHaveBeenCalled();
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it("an order id is not an input: it proves nothing, so the schema refuses it", async () => {
    const h = harness();

    await expect(
      confirmEmbedGuestPayment(h.deps, input({ orderId: ORDER_ID })),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(h.embeds.getById).not.toHaveBeenCalled();
  });

  it.each([
    ["a bare PaymentIntent id", PI_ID],
    ["a SetupIntent secret", "seti_3Abc_secret_FakeFixtureNotReal"],
    ["two _secret_ separators", "pi_3Abc_secret_Fake_secret_FixtureNotReal"],
    ["an empty tail", "pi_3Abc_secret_"],
    ["an empty id", "pi_secret_FakeFixtureNotReal"],
    ["an id that is only the prefix", "pi__secret_FakeFixtureNotReal"],
    ["a path character", "pi_3Abc/../x_secret_FakeFixtureNotReal"],
    ["whitespace", "pi_3Abc_secret_Fake FixtureNotReal"],
    ["more than 200 characters", `pi_3Abc_secret_${"a".repeat(200)}`],
    ["a non-string", 12345],
  ])(
    "refuses %s as bad input, with no Stripe call",
    async (_label, clientSecret) => {
      const h = harness();

      await expect(
        confirmEmbedGuestPayment(h.deps, input({ clientSecret })),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(h.retrievePaymentIntentWithClientSecret).not.toHaveBeenCalled();
    },
  );
});

describe("confirmEmbedGuestPayment — one budget per PaymentIntent, before the Stripe call", () => {
  it("charges the linked id's own bucket, 20 per 60 s, after the link lookup and before the retrieve", async () => {
    const h = harness();

    await confirmEmbedGuestPayment(h.deps, input());

    expect(EMBED_GUEST_CONFIRM_PI_BUDGET_KEY_PREFIX).toBe(
      "embed:guestConfirm:pi:",
    );
    expect(EMBED_GUEST_CONFIRM_PI_BUDGET_MAX).toBe(20);
    expect(h.consume).toHaveBeenCalledTimes(1);
    expect(h.consume).toHaveBeenCalledWith(
      `embed:guestConfirm:pi:${PI_ID}`,
      20,
      60,
    );
    const [linked, charged, retrieved] = [
      h.orders.findByPaymentIntent,
      h.consume,
      h.retrievePaymentIntentWithClientSecret,
    ].map((fn) => fn.mock.invocationCallOrder[0]!);
    expect(linked).toBeLessThan(charged!);
    expect(charged).toBeLessThan(retrieved!);
  });

  it("an id no order is linked to spends none of it (a guess must not mint a counter)", async () => {
    const h = harness({ linkedOrder: null });

    await expect(
      confirmEmbedGuestPayment(h.deps, input()),
    ).rejects.toMatchObject({ code: "PAYMENT_INTENT_ORDER_MISMATCH" });
    expect(h.consume).not.toHaveBeenCalled();
  });

  it("a wrong secret for a linked id DOES spend it: that is the loop it bounds", async () => {
    const h = harness();

    await expect(
      confirmEmbedGuestPayment(h.deps, input({ clientSecret: WRONG_SECRET })),
    ).rejects.toMatchObject({ code: "PAYMENT_INTENT_ORDER_MISMATCH" });
    expect(h.consume).toHaveBeenCalledTimes(1);
  });

  it("over the limit: RATE_LIMITED with a retry hint, NO Stripe call, no order read, nothing finalized, nothing reported", async () => {
    const h = harness({ rateLimit: "spent" });

    const thrown = await confirmEmbedGuestPayment(h.deps, input()).catch(
      (e: unknown) => e,
    );

    expect(errorShape(thrown)).toMatchObject({
      code: "RATE_LIMITED",
      meta: { scope: "embed_guest_proof", retryAfterSeconds: 42 },
    });
    // Not the finalize lock: the widget reads that one as "locked", and a
    // spent budget as "rate-limited, ask later".
    expect((thrown as { code: string }).code).not.toBe(
      "IDEMPOTENCY_LOCK_IN_PROGRESS",
    );
    expect(h.retrievePaymentIntentWithClientSecret).not.toHaveBeenCalled();
    expect(h.retrievePaymentIntent).not.toHaveBeenCalled();
    expect(h.orders.getById).not.toHaveBeenCalled();
    expect(finalizeMock).not.toHaveBeenCalled();
    // A spent budget is not an incident, paid order or not: nothing is known
    // about the payment yet, and the widget asks again.
    expect(h.reportError).not.toHaveBeenCalled();
    expect(JSON.stringify([errorShape(thrown), h.logCalls])).not.toContain(
      "_secret_",
    );
  });

  it("a limiter that throws fails OPEN: a PAID buyer's confirm still finalizes (never a 500), and the limiter failure is logged at error and reported", async () => {
    const h = harness({ rateLimit: "throws", piStatus: "succeeded" });

    await expect(confirmEmbedGuestPayment(h.deps, input())).resolves.toEqual({
      outcome: "confirmed",
      orderId: ORDER_ID,
      tickets: [],
    });

    expect(finalizeMock).toHaveBeenCalledTimes(1);
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError).toHaveBeenCalledWith(h.limiterDown, {
      tags: { useCase: "confirmEmbedGuestPayment", stage: "guestProofBudget" },
      extra: { embedId: EMBED_ID, paymentIntentId: PI_ID },
    });
    expect(
      h.logCalls.some(
        (c) =>
          c[0] === "error" &&
          c[1] === "confirmEmbedGuestPayment.proof_budget_consume_failed",
      ),
    ).toBe(true);
  });

  it("a limiter that throws AND a reporter that throws still confirm", async () => {
    const h = harness({ rateLimit: "throws" });
    h.reportError.mockImplementation(() => {
      throw new Error("sentry is down");
    });

    await expect(
      confirmEmbedGuestPayment(h.deps, input()),
    ).resolves.toMatchObject({ outcome: "confirmed" });
  });

  it("works with no limiter wired", async () => {
    const h = harness({ rateLimit: null });

    await expect(
      confirmEmbedGuestPayment(h.deps, input()),
    ).resolves.toMatchObject({ outcome: "confirmed" });
    expect(h.consume).not.toHaveBeenCalled();
  });
});

describe("confirmEmbedGuestPayment — the embed", () => {
  it("refuses an origin the embed does not allow, before any Stripe call", async () => {
    const h = harness();

    await expect(
      confirmEmbedGuestPayment(
        h.deps,
        input({ hostOrigin: "https://evil.example.net" }),
      ),
    ).rejects.toMatchObject({ code: "EMBED_ORIGIN_NOT_ALLOWED" });
    expect(h.retrievePaymentIntentWithClientSecret).not.toHaveBeenCalled();
  });

  it("refuses a null origin (fail closed)", async () => {
    const h = harness();

    await expect(
      confirmEmbedGuestPayment(h.deps, input({ hostOrigin: null })),
    ).rejects.toMatchObject({ code: "EMBED_ORIGIN_NOT_ALLOWED" });
    expect(h.retrievePaymentIntentWithClientSecret).not.toHaveBeenCalled();
  });

  it.each([
    ["revoked", embed({ status: "REVOKED" })],
    ["missing", null],
  ])("refuses a %s embed with EMBED_NOT_FOUND, before any Stripe call", async (_l, e) => {
    const h = harness({ embed: e });

    await expect(
      confirmEmbedGuestPayment(h.deps, input()),
    ).rejects.toMatchObject({ code: "EMBED_NOT_FOUND" });
    expect(h.retrievePaymentIntentWithClientSecret).not.toHaveBeenCalled();
  });

  it("still confirms on an embed switched to link-out after the buyer paid", async () => {
    const h = harness({ embed: embed({ linkOut: true }) });

    await expect(confirmEmbedGuestPayment(h.deps, input())).resolves.toEqual({
      outcome: "confirmed",
      orderId: ORDER_ID,
      tickets: [],
    });
  });

  it("refuses an order whose event belongs to another organization's embed, although the secret is right", async () => {
    const h = harness({
      order: { eventId: OTHER_EVENT_ID },
      event: { id: OTHER_EVENT_ID, orgId: OTHER_ORG_ID },
    });

    await expect(
      confirmEmbedGuestPayment(h.deps, input()),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    expect(h.events.getById).toHaveBeenCalledWith(OTHER_EVENT_ID);
    expect(finalizeMock).not.toHaveBeenCalled();
    expect(h.orders.markProcessingIfPending).not.toHaveBeenCalled();
  });

  it("an event embed confirms its pinned event's order and refuses another event's", async () => {
    const pinned = harness({
      embed: embed({ subjectType: "event", subjectId: EVENT_ID }),
    });
    await expect(
      confirmEmbedGuestPayment(pinned.deps, input()),
    ).resolves.toMatchObject({ outcome: "confirmed" });

    const other = harness({
      embed: embed({ subjectType: "event", subjectId: EVENT_ID }),
      order: { eventId: OTHER_EVENT_ID },
      event: { id: OTHER_EVENT_ID, orgId: ORG_ID },
    });
    await expect(
      confirmEmbedGuestPayment(other.deps, input()),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("refuses an order with no event (a membership order is never an embed order)", async () => {
    const h = harness({ order: { eventId: null } });

    await expect(
      confirmEmbedGuestPayment(h.deps, input()),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it("refuses with ORDER_NOT_FOUND when the PaymentIntent names an order that is gone", async () => {
    const h = harness({ order: null });

    await expect(
      confirmEmbedGuestPayment(h.deps, input()),
    ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND" });
  });
});

describe("confirmEmbedGuestPayment — what keeps throwing", () => {
  it("PAYMENT_INTENT_MISMATCH: the order is tied to a different PaymentIntent", async () => {
    const h = harness({ order: { stripePaymentIntentId: "pi_3SomeOtherIntent" } });

    await expect(
      confirmEmbedGuestPayment(h.deps, input()),
    ).rejects.toMatchObject({ code: "PAYMENT_INTENT_MISMATCH" });
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it("ORDER_NOT_PROCESSABLE: an order cancelled under a paid PaymentIntent is thrown, not answered", async () => {
    const h = harness({ order: { status: "CANCELLED" } });
    finalizeMock.mockRejectedValueOnce(new AppError("ORDER_NOT_PROCESSABLE"));

    await expect(
      confirmEmbedGuestPayment(h.deps, input()),
    ).rejects.toMatchObject({ code: "ORDER_NOT_PROCESSABLE" });
  });

  it("ORDER_NOT_PROCESSABLE: a processing PaymentIntent whose order was cancelled meanwhile", async () => {
    const h = harness({ piStatus: "processing", order: { status: "CANCELLED" } });
    // `order.status` is read as PENDING first, then the CAS loses.
    h.orders.getById
      .mockResolvedValueOnce({ ...h.orderRow!, status: "PENDING" })
      .mockResolvedValueOnce({ ...h.orderRow!, status: "PENDING" });
    h.orders.markProcessingIfPending.mockResolvedValueOnce(false);

    await expect(
      confirmEmbedGuestPayment(h.deps, input()),
    ).rejects.toMatchObject({ code: "ORDER_NOT_PROCESSABLE" });
  });
});

describe("confirmEmbedGuestPayment — a paid order this path refuses is reported, then rethrown", () => {
  it("reports a succeeded PaymentIntent refused with ORDER_NOT_PROCESSABLE as a fresh Error (the 409 AppError itself would be dropped)", async () => {
    const h = harness({ order: { status: "CANCELLED" } });
    const refusal = new AppError("ORDER_NOT_PROCESSABLE");
    finalizeMock.mockRejectedValueOnce(refusal);

    await expect(confirmEmbedGuestPayment(h.deps, input())).rejects.toBe(
      refusal,
    );

    expect(h.reportError).toHaveBeenCalledTimes(1);
    const [reported, context] = h.reportError.mock.calls[0]!;
    expect(reported).toBeInstanceOf(Error);
    expect(reported).not.toBeInstanceOf(AppError);
    expect((reported as Error).message).toBe(
      "embed_guest_confirm_paid_order_refused:ORDER_NOT_PROCESSABLE",
    );
    expect((reported as Error).cause).toBe(refusal);
    expect(context).toEqual({
      tags: {
        useCase: "confirmEmbedGuestPayment",
        reason: "ORDER_NOT_PROCESSABLE",
      },
      extra: {
        embedId: EMBED_ID,
        orderId: ORDER_ID,
        paymentIntentId: PI_ID,
        paymentIntentStatus: "succeeded",
      },
    });
    // The log line stays beside the report.
    expect(
      h.logCalls.some(
        (c) =>
          c[0] === "error" &&
          c[1] === "confirmEmbedGuestPayment.paid_order_refused",
      ),
    ).toBe(true);
  });

  it("reports a processing PaymentIntent whose order is CANCELLED on the first read, and answers ORDER_NOT_PROCESSABLE instead of 'processing'", async () => {
    const h = harness({ piStatus: "processing", order: { status: "CANCELLED" } });

    await expect(
      confirmEmbedGuestPayment(h.deps, input()),
    ).rejects.toMatchObject({ code: "ORDER_NOT_PROCESSABLE" });

    expect(h.orders.markProcessingIfPending).not.toHaveBeenCalled();
    expect(h.orderRow!.status).toBe("CANCELLED");
    expect(finalizeMock).not.toHaveBeenCalled();
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError.mock.calls[0]![1]).toMatchObject({
      tags: { reason: "ORDER_NOT_PROCESSABLE" },
      extra: { paymentIntentStatus: "processing" },
    });
  });

  it.each([["REFUNDED"], ["DISPUTED"]])(
    "a processing PaymentIntent on a %s order is refused the same way",
    async (status) => {
      const h = harness({ piStatus: "processing", order: { status } });

      await expect(
        confirmEmbedGuestPayment(h.deps, input()),
      ).rejects.toMatchObject({ code: "ORDER_NOT_PROCESSABLE" });
      expect(h.orders.markProcessingIfPending).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["no order id in the metadata", { piMetadata: {} }],
    [
      "metadata naming another order than the linked one",
      { linkedOrder: { id: OTHER_EVENT_ID, status: "PENDING" } },
    ],
  ])(
    "a PAID PaymentIntent refused after the secret matched (%s) is reported, and the caller still sees the bare refusal",
    async (_label, over) => {
      const paid = harness({ ...over, piStatus: "succeeded" });
      const thrown = await confirmEmbedGuestPayment(paid.deps, input()).catch(
        (e: unknown) => e,
      );

      expect(errorShape(thrown)).toEqual(
        errorShape(new AppError("PAYMENT_INTENT_ORDER_MISMATCH")),
      );
      expect(paid.reportError).toHaveBeenCalledTimes(1);
      const [reported, context] = paid.reportError.mock.calls[0]!;
      expect((reported as Error).message).toBe(
        "embed_guest_confirm_paid_order_refused:PAYMENT_INTENT_ORDER_MISMATCH",
      );
      expect((reported as Error).cause).toBe(thrown);
      expect(context).toMatchObject({
        tags: { reason: "PAYMENT_INTENT_ORDER_MISMATCH" },
        extra: {
          embedId: EMBED_ID,
          paymentIntentId: PI_ID,
          paymentIntentStatus: "succeeded",
        },
      });
      expect(finalizeMock).not.toHaveBeenCalled();

      // The same refusal under a PaymentIntent that was never paid: no report.
      const unpaid = harness({ ...over, piStatus: "requires_payment_method" });
      await expect(
        confirmEmbedGuestPayment(unpaid.deps, input()),
      ).rejects.toMatchObject({ code: "PAYMENT_INTENT_ORDER_MISMATCH" });
      expect(unpaid.reportError).not.toHaveBeenCalled();
    },
  );

  it("reports a failure that is not an AppError too (a database error under a paid PaymentIntent)", async () => {
    const h = harness();
    const boom = new Error("connection reset");
    finalizeMock.mockRejectedValueOnce(boom);

    await expect(confirmEmbedGuestPayment(h.deps, input())).rejects.toBe(boom);
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect((h.reportError.mock.calls[0]![0] as Error).message).toBe(
      "embed_guest_confirm_paid_order_refused:unknown",
    );
  });

  it("does not report not_paid: nothing was charged and nothing is thrown", async () => {
    const h = harness({ piStatus: "requires_payment_method" });

    await expect(
      confirmEmbedGuestPayment(h.deps, input()),
    ).resolves.toMatchObject({ outcome: "not_paid" });
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it("does not report a refusal under a PaymentIntent that was never paid (PAYMENT_INTENT_MISMATCH on a canceled one)", async () => {
    const h = harness({
      piStatus: "canceled",
      order: { stripePaymentIntentId: "pi_3SomeOtherIntent" },
    });

    await expect(
      confirmEmbedGuestPayment(h.deps, input()),
    ).rejects.toMatchObject({ code: "PAYMENT_INTENT_MISMATCH" });
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it("IDEMPOTENCY_LOCK_IN_PROGRESS from a concurrent confirm propagates and is not reported", async () => {
    const h = harness();
    const inProgress = new AppError("IDEMPOTENCY_LOCK_IN_PROGRESS");
    finalizeMock.mockRejectedValueOnce(inProgress);

    await expect(confirmEmbedGuestPayment(h.deps, input())).rejects.toBe(
      inProgress,
    );
    expect(h.reportError).not.toHaveBeenCalled();
    expect(h.logCalls.some((c) => c[0] === "error")).toBe(false);
  });

  it("a throwing reporter changes nothing: the original error is still the one rethrown", async () => {
    const h = harness({ order: { status: "CANCELLED" } });
    const refusal = new AppError("ORDER_NOT_PROCESSABLE");
    finalizeMock.mockRejectedValueOnce(refusal);
    h.reportError.mockImplementation(() => {
      throw new Error("sentry is down");
    });

    await expect(confirmEmbedGuestPayment(h.deps, input())).rejects.toBe(
      refusal,
    );
    expect(h.reportError).toHaveBeenCalledTimes(1);
  });

  it("works with no reporter wired", async () => {
    const h = harness({ order: { status: "CANCELLED" } });
    h.deps.reportError = undefined;
    const refusal = new AppError("ORDER_NOT_PROCESSABLE");
    finalizeMock.mockRejectedValueOnce(refusal);

    await expect(confirmEmbedGuestPayment(h.deps, input())).rejects.toBe(
      refusal,
    );
  });
});

describe("confirmEmbedGuestPayment — a succeeded payment whose embed or event changed afterwards", () => {
  it("the embed was revoked after the buyer paid: EMBED_NOT_FOUND, before any Stripe call (the webhook still finalizes)", async () => {
    const h = harness({
      embed: embed({ status: "REVOKED" }),
      piStatus: "succeeded",
    });

    await expect(
      confirmEmbedGuestPayment(h.deps, input()),
    ).rejects.toMatchObject({ code: "EMBED_NOT_FOUND" });
    expect(h.orders.findByPaymentIntent).not.toHaveBeenCalled();
    expect(h.retrievePaymentIntentWithClientSecret).not.toHaveBeenCalled();
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it("the event moved to another organization after the buyer paid: EVENT_NOT_FOUND, and nothing is finalized through this embed", async () => {
    const h = harness({
      piStatus: "succeeded",
      event: { id: EVENT_ID, orgId: OTHER_ORG_ID },
    });

    await expect(
      confirmEmbedGuestPayment(h.deps, input()),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    expect(finalizeMock).not.toHaveBeenCalled();
    expect(h.orders.markProcessingIfPending).not.toHaveBeenCalled();
  });
});

describe("confirmEmbedGuestPayment — the secret goes nowhere", () => {
  it("a real-shaped secret that fails the pattern (a trailing space) is not carried in the thrown value", async () => {
    const h = harness();
    const thrown = await confirmEmbedGuestPayment(
      h.deps,
      input({ clientSecret: `${REAL_SECRET} ` }),
    ).catch((e: unknown) => e);

    expect(thrown).toMatchObject({ code: "invalid_input" });
    const whole = JSON.stringify([errorShape(thrown), String(thrown)]);
    expect(whole).toContain("clientSecret"); // the issue names the field…
    expect(whole).not.toContain(REAL_SECRET); // …never its value
    expect(whole).not.toContain("FakeFixture");
    expect(h.embeds.getById).not.toHaveBeenCalled();
  });

  it("the INTERNAL refusal (a processor that cannot show a secret) does not carry the secret", async () => {
    const h = harness();
    h.deps.payments = {
      retrievePaymentIntent: h.retrievePaymentIntent,
    } as unknown as PaymentProcessorPort;
    const thrown = await confirmEmbedGuestPayment(h.deps, input()).catch(
      (e: unknown) => e,
    );

    expect(thrown).toMatchObject({ code: "INTERNAL" });
    const whole = JSON.stringify([
      errorShape(thrown),
      String(thrown),
      h.logCalls,
      h.reportError.mock.calls,
    ]);
    expect(whole).not.toContain("_secret_");
  });

  it("a rethrown Stripe outage does not carry the secret, and neither does anything logged on the way", async () => {
    const outage = Object.assign(new Error("rate limited"), {
      type: "StripeRateLimitError",
    });
    const h = harness({ retrieveError: outage });
    const thrown = await confirmEmbedGuestPayment(h.deps, input()).catch(
      (e: unknown) => e,
    );

    expect(thrown).toBe(outage);
    const whole = JSON.stringify([
      errorShape(thrown),
      String(thrown),
      h.logCalls,
      h.reportError.mock.calls.map((c) => [errorShape(c[0]), c[1]]),
    ]);
    expect(whole).not.toContain("_secret_");
  });

  it("neither the presented nor the real secret reaches a logger call, the reporter, finalize, a thrown error or the answer", async () => {
    const seen: unknown[] = [];
    const run = async (
      h: ReturnType<typeof harness>,
      over: Record<string, unknown> = {},
    ) => {
      try {
        seen.push(await confirmEmbedGuestPayment(h.deps, input(over)));
      } catch (err) {
        seen.push(errorShape(err), String(err));
      }
      seen.push(
        h.logCalls,
        h.reportError.mock.calls.map((c) => [errorShape(c[0]), c[1]]),
      );
      return h;
    };

    const confirmed = await run(harness());
    await run(harness({ piStatus: "processing" }));
    await run(harness({ piStatus: "canceled" }));
    await run(harness(), { clientSecret: WRONG_SECRET });
    await run(
      harness({
        retrieveError: new AppError("NOT_FOUND", {
          meta: { paymentIntentId: PI_ID },
        }),
      }),
    );
    await run(harness({ piMetadata: {} }));
    await run(harness(), { hostOrigin: "https://evil.example.net" });
    await run(harness({ embed: null }));
    await run(harness({ event: { id: EVENT_ID, orgId: OTHER_ORG_ID } }));
    await run(harness({ order: { stripePaymentIntentId: "pi_3SomeOtherIntent" } }));
    await run(harness({ linkedOrder: null }));
    await run(harness({ linkedOrder: { id: OTHER_EVENT_ID, status: "PENDING" } }));
    // A paid order refused: this one goes through the reporter.
    const reported = harness({ piStatus: "processing", order: { status: "CANCELLED" } });
    await run(reported);
    expect(reported.reportError).toHaveBeenCalledTimes(1);
    seen.push(finalizeMock.mock.calls.map((c) => c[1]));

    // The scenarios did log: an empty record would prove nothing.
    expect(confirmed.logCalls.length).toBeGreaterThan(0);
    expect(finalizeMock).toHaveBeenCalled();

    // The receipt secret too: matched, wrong, and on a failed ticket read
    // (which logs and reports).
    await run(paid({ tickets: [ticketRow(1)] }));
    await run(paid({ tickets: [ticketRow(1)] }), {
      receiptSecret: WRONG_RECEIPT_SECRET,
    });
    const readFails = paid();
    readFails.tickets.listByOrderId.mockRejectedValue(new Error("db down"));
    await run(readFails);
    expect(readFails.reportError).toHaveBeenCalledTimes(1);

    const everything = JSON.stringify(seen);
    expect(everything).toContain(PI_ID); // the id is fine to log
    expect(everything).not.toContain(REAL_SECRET);
    expect(everything).not.toContain(WRONG_SECRET);
    expect(everything).not.toContain("_secret_");
    expect(everything).not.toContain(RECEIPT_SECRET);
    expect(everything).not.toContain(WRONG_RECEIPT_SECRET);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The payer's ticket codes (owner, 2026-10-12): the confirmation shows each
// ticket's scannable code, because the email can be slow or mistyped. A code
// IS admission, so the questions here are who gets one, which ones, and that
// a code reaches nothing but the answer.
// ─────────────────────────────────────────────────────────────────────────────

const ISSUED_AT = new Date(NOW.getTime() - 60_000);

/** A whole `TicketRecord` (the port's type), as mint writes one. */
const ticketRow = (n: number, over: Partial<TicketRecord> = {}): TicketRecord => ({
  id: `00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`,
  eventId: EVENT_ID,
  ticketTypeId: GA_TYPE_ID,
  ownerHumanId: BUYER,
  orderId: ORDER_ID,
  orderItemId: `00000000-0000-4000-8000-0000000002${String(n).padStart(2, "0")}`,
  seatId: null,
  code: `tk_fixturecode${String(n).padStart(10, "0")}`,
  status: "VALID",
  issuedAt: ISSUED_AT,
  scannedAt: null,
  ...over,
});

const SEAT_A2 = "00000000-0000-4000-8000-000000000302";
const SEAT_A10 = "00000000-0000-4000-8000-000000000310";

/**
 * What `createCheckout` writes on a PaymentIntent made through this embed:
 * codes come back only for one whose `metadata.embedId` is this embed, and
 * only to a call presenting the secret `metadata.receiptSecretHash` hashes.
 */
const BOUND_METADATA = {
  orderId: ORDER_ID,
  source: "primary",
  embedId: EMBED_ID,
  receiptSecretHash: RECEIPT_SECRET_HASH,
};

/**
 * An order the payment has finalized (the mock finalize writes nothing),
 * made through this embed.
 */
const paid = (over: Parameters<typeof harness>[0] = {}) =>
  harness({ order: { status: "SUCCEEDED" }, piMetadata: BOUND_METADATA, ...over });

describe("confirmEmbedGuestPayment — the payer's ticket codes", () => {
  it("confirmed, GA: each of the order's tickets comes back with its code and type name", async () => {
    const h = paid({ tickets: [ticketRow(1), ticketRow(2)] });

    const out = await confirmEmbedGuestPayment(h.deps, input());

    expect(out).toEqual({
      outcome: "confirmed",
      orderId: ORDER_ID,
      tickets: [
        { code: ticketRow(1).code, ticketTypeName: "General Admission", seatLabel: null },
        { code: ticketRow(2).code, ticketTypeName: "General Admission", seatLabel: null },
      ],
    });
    // The real output schema accepts exactly this (strict objects).
    expect(confirmEmbedGuestPaymentOutputSchema.parse(out)).toEqual(out);
    expect(h.tickets.listByOrderId).toHaveBeenCalledWith(ORDER_ID);
    // No seats: no seat read at all.
    expect(h.seats.findLabelsByIds).not.toHaveBeenCalled();
  });

  it("the codes are read AFTER the finalize, from the order as it then stands", async () => {
    // PENDING until finalize runs; the tickets exist only once it has.
    const minted: TicketRecord[] = [];
    const h = harness({ tickets: minted, piMetadata: BOUND_METADATA });
    finalizeMock.mockImplementation(async () => {
      expect(h.tickets.listByOrderId).not.toHaveBeenCalled();
      h.orderRow!.status = "SUCCEEDED";
      minted.push(ticketRow(1));
      return { ok: true, orderId: ORDER_ID };
    });

    const out = await confirmEmbedGuestPayment(h.deps, input());

    expect(out).toMatchObject({
      outcome: "confirmed",
      tickets: [{ code: ticketRow(1).code }],
    });
  });

  it("seated: `Section · Seat`, in seat order (A2 before A10), read without a lock and scoped to the order's event", async () => {
    const h = paid({
      ticketTypes: [
        { id: GA_TYPE_ID, name: "General Admission" },
        { id: SEATED_TYPE_ID, name: "Balcony" },
      ],
      tickets: [
        ticketRow(1, { ticketTypeId: SEATED_TYPE_ID, seatId: SEAT_A10 }),
        ticketRow(2, { ticketTypeId: SEATED_TYPE_ID, seatId: SEAT_A2 }),
        ticketRow(3),
      ],
      seats: [
        { id: SEAT_A10, label: "A10", sectionName: "Balcony Left" },
        { id: SEAT_A2, label: "A2", sectionName: "Balcony Left" },
      ],
    });

    const out = await confirmEmbedGuestPayment(h.deps, input());

    expect(out).toMatchObject({ outcome: "confirmed" });
    expect((out as { tickets: unknown }).tickets).toEqual([
      { code: ticketRow(2).code, ticketTypeName: "Balcony", seatLabel: "Balcony Left · A2" },
      { code: ticketRow(1).code, ticketTypeName: "Balcony", seatLabel: "Balcony Left · A10" },
      // GA after the seated ones.
      { code: ticketRow(3).code, ticketTypeName: "General Admission", seatLabel: null },
    ]);
    expect(confirmEmbedGuestPaymentOutputSchema.parse(out)).toEqual(out);
    expect(h.seats.findLabelsByIds).toHaveBeenCalledTimes(1);
    expect(h.seats.findLabelsByIds).toHaveBeenCalledWith({
      seatIds: [SEAT_A10, SEAT_A2],
      eventId: EVENT_ID,
    });
    expect(h.seats.findByIdsForUpdate).not.toHaveBeenCalled();
    expect(h.events.listTicketTypes).toHaveBeenCalledWith(EVENT_ID);
  });

  it("a seat or a ticket type that cannot be read gives null for that field, and the code still comes back", async () => {
    const h = paid({
      ticketTypes: [],
      tickets: [ticketRow(1, { seatId: SEAT_A2 }), ticketRow(2, { ticketTypeId: null })],
      seats: [],
    });

    const out = await confirmEmbedGuestPayment(h.deps, input());

    expect((out as { tickets: unknown }).tickets).toEqual([
      { code: ticketRow(1).code, ticketTypeName: null, seatLabel: null },
      { code: ticketRow(2).code, ticketTypeName: null, seatLabel: null },
    ]);
  });

  it.each([["processing"], ["requires_payment_method"], ["canceled"]])(
    "a %s PaymentIntent answers without tickets, and no ticket is read",
    async (piStatus) => {
      const h = harness({ piStatus, tickets: [ticketRow(1)], piMetadata: BOUND_METADATA });

      const out = await confirmEmbedGuestPayment(h.deps, input());

      expect(out).not.toHaveProperty("tickets");
      expect(JSON.stringify(out)).not.toContain(ticketRow(1).code);
      expect(h.tickets.listByOrderId).not.toHaveBeenCalled();
    },
  );

  it("no proof, no codes: a wrong secret, an unlinked id and a metadata mismatch read no ticket, and their refusal is the one it always was", async () => {
    const withTickets = {
      order: { status: "SUCCEEDED" },
      tickets: [ticketRow(1)],
      piMetadata: BOUND_METADATA,
    };
    const wrongSecret = harness(withTickets);
    const unlinked = harness({ ...withTickets, linkedOrder: null });
    const mismatch = harness({
      ...withTickets,
      linkedOrder: { id: OTHER_EVENT_ID, status: "SUCCEEDED" },
    });
    const noMetadata = harness({ ...withTickets, piMetadata: {} });

    const refusals = await Promise.all([
      confirmEmbedGuestPayment(
        wrongSecret.deps,
        input({ clientSecret: WRONG_SECRET }),
      ).catch(errorShape),
      confirmEmbedGuestPayment(unlinked.deps, input()).catch(errorShape),
      confirmEmbedGuestPayment(mismatch.deps, input()).catch(errorShape),
      confirmEmbedGuestPayment(noMetadata.deps, input()).catch(errorShape),
    ]);

    // Byte for byte the refusal a caller got before tickets existed here:
    // the bare code, nothing else on the thrown value.
    for (const refusal of refusals) {
      expect(refusal).toEqual({
        name: "AppError",
        message: "PAYMENT_INTENT_ORDER_MISMATCH",
        code: "PAYMENT_INTENT_ORDER_MISMATCH",
      });
    }
    for (const h of [wrongSecret, unlinked, mismatch, noMetadata]) {
      expect(h.tickets.listByOrderId).not.toHaveBeenCalled();
      expect(h.seats.findLabelsByIds).not.toHaveBeenCalled();
      expect(h.events.listTicketTypes).not.toHaveBeenCalled();
    }
  });

  it("an embed that may not sell the order's event gets no codes, although the secret is right", async () => {
    const h = paid({
      tickets: [ticketRow(1)],
      event: { id: EVENT_ID, orgId: OTHER_ORG_ID },
    });

    await expect(
      confirmEmbedGuestPayment(h.deps, input()),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    expect(h.tickets.listByOrderId).not.toHaveBeenCalled();
  });

  it.each([["REFUNDED"], ["CANCELLED"], ["PENDING"], ["PROCESSING"], ["FAILED"]])(
    "a repeat confirm of an order that is now %s answers confirmed (finalize's record outlives it) with NO tickets",
    async (status) => {
      // The rows still say VALID: the order's status alone withholds them.
      const h = harness({
        order: { status },
        tickets: [ticketRow(1), ticketRow(2)],
        piMetadata: BOUND_METADATA,
      });

      const out = await confirmEmbedGuestPayment(h.deps, input());

      expect(out).toEqual({ outcome: "confirmed", orderId: ORDER_ID, tickets: [] });
      expect(h.tickets.listByOrderId).not.toHaveBeenCalled();
    },
  );

  it.each([["PART_REFUNDED"], ["DISPUTED"]])(
    "a %s order is still an active holder's: its VALID tickets come back, its refunded ones do not",
    async (status) => {
      const h = harness({
        order: { status },
        tickets: [ticketRow(1), ticketRow(2, { status: "REFUNDED" })],
        piMetadata: BOUND_METADATA,
      });

      const out = await confirmEmbedGuestPayment(h.deps, input());

      expect((out as { tickets: unknown[] }).tickets).toEqual([
        { code: ticketRow(1).code, ticketTypeName: "General Admission", seatLabel: null },
      ]);
    },
  );

  it("a ticket the buyer transferred or resold is left out while its sibling comes back", async () => {
    const h = paid({
      tickets: [ticketRow(1, { ownerHumanId: OTHER_HUMAN }), ticketRow(2)],
    });

    const out = await confirmEmbedGuestPayment(h.deps, input());

    expect((out as { tickets: unknown[] }).tickets).toEqual([
      { code: ticketRow(2).code, ticketTypeName: "General Admission", seatLabel: null },
    ]);
    expect(JSON.stringify(out)).not.toContain(ticketRow(1).code);
  });

  it.each([["SCANNED"], ["LISTED"], ["REFUNDED"], ["INVALID"]] as const)(
    "a %s ticket is left out: only a VALID one is shown",
    async (status) => {
      const h = paid({ tickets: [ticketRow(1, { status }), ticketRow(2)] });

      const out = await confirmEmbedGuestPayment(h.deps, input());

      expect((out as { tickets: Array<{ code: string }> }).tickets.map((t) => t.code)).toEqual([
        ticketRow(2).code,
      ]);
    },
  );

  it("a row of another order or another event is never shown, whatever the repo hands back", async () => {
    const h = paid();
    h.tickets.listByOrderId.mockResolvedValue([
      ticketRow(1, { orderId: OTHER_EVENT_ID }),
      ticketRow(2, { eventId: OTHER_EVENT_ID }),
      ticketRow(3, { orderId: null }),
      ticketRow(4),
    ]);

    const out = await confirmEmbedGuestPayment(h.deps, input());

    expect((out as { tickets: Array<{ code: string }> }).tickets.map((t) => t.code)).toEqual([
      ticketRow(4).code,
    ]);
  });

  it("the window: codes come back up to EMBED_GUEST_TICKET_WINDOW_MS after issue, and not a millisecond later", async () => {
    expect(EMBED_GUEST_TICKET_WINDOW_MS).toBe(2 * 60 * 60 * 1000);
    const at = (ms: number) =>
      paid({
        tickets: [ticketRow(1)],
        now: new Date(ISSUED_AT.getTime() + ms),
      });

    const inside = await confirmEmbedGuestPayment(
      at(EMBED_GUEST_TICKET_WINDOW_MS).deps,
      input(),
    );
    const outside = await confirmEmbedGuestPayment(
      at(EMBED_GUEST_TICKET_WINDOW_MS + 1).deps,
      input(),
    );

    expect((inside as { tickets: unknown[] }).tickets).toHaveLength(1);
    expect(outside).toEqual({ outcome: "confirmed", orderId: ORDER_ID, tickets: [] });
  });

  it("the window runs from the newest ticket still shown: a transferred ticket's later issue time does not reopen it", async () => {
    const old = new Date(NOW.getTime() - EMBED_GUEST_TICKET_WINDOW_MS - 60_000);
    const h = paid({
      tickets: [
        ticketRow(1, { issuedAt: old }),
        ticketRow(2, { issuedAt: ISSUED_AT, ownerHumanId: OTHER_HUMAN }),
      ],
    });

    const out = await confirmEmbedGuestPayment(h.deps, input());

    expect(out).toEqual({ outcome: "confirmed", orderId: ORDER_ID, tickets: [] });
  });

  it("an unreadable issue time fails closed", async () => {
    const h = paid({
      tickets: [ticketRow(1, { issuedAt: new Date("not a date") })],
    });

    const out = await confirmEmbedGuestPayment(h.deps, input());

    expect(out).toEqual({ outcome: "confirmed", orderId: ORDER_ID, tickets: [] });
  });

  it("at most EMBED_GUEST_TICKET_MAX codes, the first by issue time then id, and the answer still fits the schema", async () => {
    expect(EMBED_GUEST_TICKET_MAX).toBe(50);
    const rows = Array.from({ length: 60 }, (_, i) =>
      ticketRow(i, {
        // The last five were issued first; ids break the remaining ties.
        issuedAt: new Date(ISSUED_AT.getTime() - (i >= 55 ? 1000 : 0)),
      }),
    );
    const h = paid({ tickets: [...rows].reverse() });

    const out = await confirmEmbedGuestPayment(h.deps, input());

    const codes = (out as { tickets: Array<{ code: string }> }).tickets.map((t) => t.code);
    expect(codes).toHaveLength(50);
    expect(codes).toEqual(
      [...rows.slice(55), ...rows.slice(0, 45)].map((t) => t.code),
    );
    expect(confirmEmbedGuestPaymentOutputSchema.parse(out)).toEqual(out);
  });
});

describe("confirmEmbedGuestPayment — a failed ticket read never fails the confirm (ReporterPort convention)", () => {
  const dbDown = new Error("connection terminated");

  it("regression: the ticket read throws → confirmed with no tickets, reported once, and the log line stays", async () => {
    const h = paid({ ticketsError: dbDown });

    const out = await confirmEmbedGuestPayment(h.deps, input());

    expect(out).toEqual({ outcome: "confirmed", orderId: ORDER_ID, tickets: [] });
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError).toHaveBeenCalledWith(dbDown, {
      tags: {
        useCase: "confirmEmbedGuestPayment",
        stage: "readEmbedGuestTickets",
      },
      extra: { orderId: ORDER_ID },
    });
    expect(h.logCalls).toContainEqual([
      "error",
      "confirmEmbedGuestPayment.ticketsReadFailed",
      { orderId: ORDER_ID, err: dbDown },
    ]);
  });

  it("the seat read throws after the tickets were read → the same: confirmed, no tickets (never half an answer), reported once", async () => {
    const h = paid({
      tickets: [ticketRow(1, { seatId: SEAT_A2 }), ticketRow(2)],
      seatsError: dbDown,
    });

    const out = await confirmEmbedGuestPayment(h.deps, input());

    expect(out).toEqual({ outcome: "confirmed", orderId: ORDER_ID, tickets: [] });
    expect(h.reportError).toHaveBeenCalledTimes(1);
    // The rows were in hand when it failed: no code may ride the report or a log.
    const sideChannels = JSON.stringify([
      h.logCalls.map((c) => c.map((part) => errorShape(part))),
      h.reportError.mock.calls.map((c) => [errorShape(c[0]), c[1]]),
    ]);
    expect(sideChannels).not.toContain("tk_");
  });

  it("a throwing reporter changes nothing", async () => {
    const h = paid({ ticketsError: dbDown });
    h.reportError.mockImplementation(() => {
      throw new Error("sentry is down too");
    });

    await expect(confirmEmbedGuestPayment(h.deps, input())).resolves.toEqual({
      outcome: "confirmed",
      orderId: ORDER_ID,
      tickets: [],
    });
    expect(h.reportError).toHaveBeenCalledTimes(1);
  });

  it("a throwing logger changes nothing either, and the failure is still reported", async () => {
    const h = paid({ ticketsError: dbDown });
    (h.deps.logger!.error as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("log sink is down");
    });

    await expect(confirmEmbedGuestPayment(h.deps, input())).resolves.toEqual({
      outcome: "confirmed",
      orderId: ORDER_ID,
      tickets: [],
    });
    expect(h.reportError).toHaveBeenCalledTimes(1);
  });

  it("no reporter wired: still confirmed", async () => {
    const h = paid({ ticketsError: dbDown });
    h.deps.reportError = undefined;

    await expect(
      confirmEmbedGuestPayment(h.deps, input()),
    ).resolves.toMatchObject({ outcome: "confirmed", tickets: [] });
  });

  it("a read that works reports nothing", async () => {
    const h = paid({ tickets: [ticketRow(1)] });

    await confirmEmbedGuestPayment(h.deps, input());

    expect(h.reportError).not.toHaveBeenCalled();
  });
});

describe("confirmEmbedGuestPayment — a ticket code reaches the answer and nothing else", () => {
  it("no logger call, report or finalize argument carries a code; the log line carries the count", async () => {
    const h = paid({
      tickets: [ticketRow(1, { seatId: SEAT_A2 }), ticketRow(2)],
      seats: [{ id: SEAT_A2, label: "A2", sectionName: "Floor" }],
    });

    const out = await confirmEmbedGuestPayment(h.deps, input());

    // The answer does carry them (otherwise this test proves nothing).
    expect(JSON.stringify(out)).toContain(ticketRow(1).code);
    const sideChannels = JSON.stringify([
      h.logCalls,
      h.reportError.mock.calls,
      finalizeMock.mock.calls.map((c) => c[1]),
    ]);
    expect(sideChannels).not.toContain("tk_");
    expect(h.logCalls).toContainEqual([
      "info",
      "confirmEmbedGuestPayment.answered",
      {
        embedId: EMBED_ID,
        orderId: ORDER_ID,
        paymentIntentId: PI_ID,
        outcome: "confirmed",
        ticketCount: 2,
        receiptSecretMatched: true,
      },
    ]);
  });
});

// Security review round 1 (M1, I1): the confirm stays open to any embed that
// may sell the event, but the codes are bound to the embed the PaymentIntent
// was made through, and are read only for the order the proof named.
describe("confirmEmbedGuestPayment — codes only for a purchase made through THIS embed", () => {
  it("a PaymentIntent with no metadata.embedId (a main-site checkout, or an order from before the key) confirms, with NO tickets and no ticket read", async () => {
    const h = paid({
      tickets: [ticketRow(1)],
      piMetadata: { orderId: ORDER_ID, source: "primary" },
    });

    const out = await confirmEmbedGuestPayment(h.deps, input());

    expect(out).toEqual({ outcome: "confirmed", orderId: ORDER_ID, tickets: [] });
    expect(finalizeMock).toHaveBeenCalledTimes(1);
    expect(h.tickets.listByOrderId).not.toHaveBeenCalled();
    expect(h.seats.findLabelsByIds).not.toHaveBeenCalled();
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it.each([
    ["another embed's id", "00000000-0000-4000-8000-0000000000ee"],
    ["this embed's id with a trailing space", `${EMBED_ID} `],
    ["an empty string", ""],
  ])("metadata.embedId = %s → confirmed with no tickets, no ticket read", async (_label, embedId) => {
    const h = paid({
      tickets: [ticketRow(1)],
      piMetadata: { ...BOUND_METADATA, embedId },
    });

    const out = await confirmEmbedGuestPayment(h.deps, input());

    expect(out).toEqual({ outcome: "confirmed", orderId: ORDER_ID, tickets: [] });
    expect(h.tickets.listByOrderId).not.toHaveBeenCalled();
  });

  it("metadata.embedId is exactly this embed → the codes come back", async () => {
    const h = paid({ tickets: [ticketRow(1)] });

    const out = await confirmEmbedGuestPayment(h.deps, input());

    expect(out).toMatchObject({
      outcome: "confirmed",
      tickets: [{ code: ticketRow(1).code }],
    });
  });

  it("the tickets are read by the PROVEN order id; a finalize answering another order gets none, and it is reported once", async () => {
    const OTHER_ORDER = "00000000-0000-4000-8000-0000000000ef";
    const h = paid({ tickets: [ticketRow(1)] });
    finalizeMock.mockResolvedValue({ ok: true, orderId: OTHER_ORDER });

    const out = await confirmEmbedGuestPayment(h.deps, input());

    expect(out).toEqual({ outcome: "confirmed", orderId: OTHER_ORDER, tickets: [] });
    expect(h.tickets.listByOrderId).not.toHaveBeenCalled();
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "embed_guest_confirm_confirmed_order_mismatch",
      }),
      {
        tags: {
          useCase: "confirmEmbedGuestPayment",
          stage: "confirmedOrderMismatch",
        },
        extra: {
          embedId: EMBED_ID,
          provenOrderId: ORDER_ID,
          confirmedOrderId: OTHER_ORDER,
          paymentIntentId: PI_ID,
        },
      },
    );
  });

  it("the mismatch report is guarded: a throwing reporter and a throwing logger change nothing", async () => {
    const OTHER_ORDER = "00000000-0000-4000-8000-0000000000ef";
    const h = paid({ tickets: [ticketRow(1)] });
    finalizeMock.mockResolvedValue({ ok: true, orderId: OTHER_ORDER });
    h.reportError.mockImplementation(() => {
      throw new Error("sentry is down");
    });
    (h.deps.logger!.error as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("log sink is down");
    });

    await expect(confirmEmbedGuestPayment(h.deps, input())).resolves.toEqual({
      outcome: "confirmed",
      orderId: OTHER_ORDER,
      tickets: [],
    });
    expect(h.reportError).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The receipt secret (owner ruling 2026-10-12): a redirect payment method
// returns the buyer on a URL carrying the client secret, which reaches
// request logs and browser history. Codes go only to the tab that started
// the payment, which holds the receipt secret; everyone else is confirmed
// with no codes and no ticket read.
// ─────────────────────────────────────────────────────────────────────────────
describe("confirmEmbedGuestPayment — codes need the receipt secret too", () => {
  it("the matching receipt secret → the codes come back", async () => {
    const h = paid({ tickets: [ticketRow(1)] });

    const out = await confirmEmbedGuestPayment(h.deps, input());

    expect(out).toMatchObject({
      outcome: "confirmed",
      orderId: ORDER_ID,
      tickets: [{ code: ticketRow(1).code }],
    });
    expect(h.tickets.listByOrderId).toHaveBeenCalledWith(ORDER_ID);
  });

  it.each([
    ["no receipt secret (a new tab, or a client secret read off a URL)", { receiptSecret: undefined }],
    ["a wrong receipt secret", { receiptSecret: WRONG_RECEIPT_SECRET }],
    ["the stored HASH presented as the secret", { receiptSecret: RECEIPT_SECRET_HASH }],
  ])("%s → confirmed, tickets [], no ticket read, the same answer otherwise", async (_label, over) => {
    const h = paid({ tickets: [ticketRow(1)] });

    const out = await confirmEmbedGuestPayment(h.deps, input(over));

    expect(out).toEqual({ outcome: "confirmed", orderId: ORDER_ID, tickets: [] });
    expect(confirmEmbedGuestPaymentOutputSchema.parse(out)).toEqual(out);
    // The confirm itself is unchanged: finalize ran, as the order's buyer.
    expect(finalizeMock).toHaveBeenCalledTimes(1);
    expect(h.tickets.listByOrderId).not.toHaveBeenCalled();
    expect(h.seats.findLabelsByIds).not.toHaveBeenCalled();
    expect(h.reportError).not.toHaveBeenCalled();
    expect(h.logCalls).toContainEqual([
      "info",
      "confirmEmbedGuestPayment.answered",
      expect.objectContaining({ ticketCount: 0, receiptSecretMatched: false }),
    ]);
  });

  it.each([
    ["no stored hash (an order made before receipt secrets)", undefined],
    ["an empty stored hash", ""],
    ["a stored value that is not a hex SHA-256", "not-a-hash"],
    ["the stored hash in upper case", RECEIPT_SECRET_HASH.toUpperCase()],
  ])("PaymentIntent with %s → confirmed, tickets [], no ticket read, even with a receipt secret", async (_label, stored) => {
    const { receiptSecretHash: _dropped, ...withoutHash } = BOUND_METADATA;
    const h = paid({
      tickets: [ticketRow(1)],
      piMetadata:
        stored === undefined
          ? withoutHash
          : { ...withoutHash, receiptSecretHash: stored },
    });

    const out = await confirmEmbedGuestPayment(h.deps, input());

    expect(out).toEqual({ outcome: "confirmed", orderId: ORDER_ID, tickets: [] });
    expect(h.tickets.listByOrderId).not.toHaveBeenCalled();
  });

  it("the receipt secret does not stand in for the client secret: a wrong client secret is refused as always", async () => {
    const h = paid({ tickets: [ticketRow(1)] });

    await expect(
      confirmEmbedGuestPayment(h.deps, input({ clientSecret: WRONG_SECRET })),
    ).rejects.toMatchObject({ code: "PAYMENT_INTENT_ORDER_MISMATCH" });
    expect(finalizeMock).not.toHaveBeenCalled();
    expect(h.tickets.listByOrderId).not.toHaveBeenCalled();
  });

  it("processing and not_paid answers are unchanged with or without the receipt secret", async () => {
    for (const over of [{}, { receiptSecret: undefined }]) {
      const processing = paid({ piStatus: "processing" });
      await expect(
        confirmEmbedGuestPayment(processing.deps, input(over)),
      ).resolves.toEqual({ outcome: "processing", orderId: ORDER_ID });
      const notPaid = paid({ piStatus: "requires_payment_method" });
      await expect(
        confirmEmbedGuestPayment(notPaid.deps, input(over)),
      ).resolves.toEqual({
        outcome: "not_paid",
        orderId: ORDER_ID,
        paymentIntentStatus: "requires_payment_method",
      });
      expect(notPaid.tickets.listByOrderId).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["too short", "abc"],
    ["too long", "a".repeat(129)],
    ["outside base64url", "FakeReceiptSecretFixture NotReal 0123456789"],
  ])("a receipt secret that is %s is bad input, refused before any read", async (_label, receiptSecret) => {
    const h = paid({ tickets: [ticketRow(1)] });

    await expect(
      confirmEmbedGuestPayment(h.deps, input({ receiptSecret })),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(h.deps.repos.embeds.getById).not.toHaveBeenCalled();
    expect(finalizeMock).not.toHaveBeenCalled();
  });
});
