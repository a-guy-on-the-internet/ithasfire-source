import { describe, expect, it, vi } from "vitest";
import * as guestCheckoutModule from "@th/core/use-cases/embeds/create-embed-guest-checkout";
import * as guestConfirmModule from "@th/core/use-cases/embeds/confirm-embed-guest-payment";
import * as guestReleaseModule from "@th/core/use-cases/embeds/release-embed-guest-order";

import { router } from "../../trpc";
import { router as trpcRouter } from "../../init";
import type { Ctx } from "../../context";
import { withConsumeMany } from "@th/test-utils/fakes/rate-limit";
import { embedsRouter } from "../embeds";
import { createTestLogger } from "@th/test-utils";
import { createFakeBookingRequestMessagesRepo } from "@th/test-utils/fakes/venue-hierarchy";
import { createFakeBookingStandards } from "@th/test-utils/fakes/booking-standards";
import {
  BOOKING_INQUIRY_PLACE_DAILY_MAX,
  BOOKING_INQUIRY_PLACE_DAILY_WINDOW_SECONDS,
  bookingInquiryPlaceDailyKey,
} from "@th/core/use-cases/embeds";

const EMBED_ID = "00000000-0000-4000-8000-0000000000c0";
const EVENT_ID = "00000000-0000-4000-8000-0000000000c1";
const TICKET_TYPE_ID = "00000000-0000-4000-8000-0000000000c2";
const CLIENT_IP = "203.0.113.7";

type ConsumeResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

/** Fake RateLimitPort.consume that denies the given keys, allows the rest. */
const fakeRateLimit = (deniedKeys: string[] = []) => {
  const consume = vi.fn(
    async (key: string): Promise<ConsumeResult> =>
      deniedKeys.includes(key)
        ? { allowed: false, remaining: 0, retryAfterSeconds: 30 }
        : {
            allowed: true,
            remaining: Number.POSITIVE_INFINITY,
            retryAfterSeconds: 0,
          },
  );
  return withConsumeMany({ consume }) as unknown as Ctx["rateLimit"] & {
    consume: typeof consume;
  };
};

const buildCtx = (overrides?: Partial<Ctx>): Ctx =>
  ({
    repos: {
      embeds: { getById: vi.fn(async () => null) },
    } as unknown as Ctx["repos"],
    payments: {} as Ctx["payments"],
    idempotency: {} as Ctx["idempotency"],
    clock: { now: () => new Date("2026-01-01T00:00:00.000Z") } as Ctx["clock"],
    logger: createTestLogger(),
    rateLimit: fakeRateLimit(),
    turnstile: null,
    publicAppUrl: "http://localhost:3000",
    clientIp: CLIENT_IP,
    actorHumanId: null,
    auth: null,
    authToken: null,
    apiKey: null,
    ...overrides,
  }) as unknown as Ctx;

const callerFor = (ctx: Ctx) =>
  trpcRouter({ embeds: router(embedsRouter) }).createCaller(ctx);

const validInput = {
  embedId: EMBED_ID,
  eventId: EVENT_ID,
  hostOrigin: "https://shop.example.com",
  guestName: "Guest Buyer",
  guestEmail: "guest@buyer.test",
  clientKey: "guest-client-key-0000000-router01",
  refundPolicyAccepted: true,
  items: [{ ticketTypeId: TICKET_TYPE_ID, qty: 1 }],
};

describe("embeds.createGuestCheckout — per-IP rate limit", () => {
  it("rejects with TOO_MANY_REQUESTS when the per-IP budget is exhausted", async () => {
    const rateLimit = fakeRateLimit([`embed:guestCheckout:${CLIENT_IP}`]);
    const caller = callerFor(buildCtx({ rateLimit }));

    await expect(
      caller.embeds.createGuestCheckout(validInput),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    // The limiter runs BEFORE the use case — the checkout limiter key was
    // consumed with the orders.createCheckout-mirroring 10/60s budget.
    expect(rateLimit.consume).toHaveBeenCalledWith(
      `embed:guestCheckout:${CLIENT_IP}`,
      10,
      60,
    );
  });

  it("proceeds to the use case when the budget allows (embed lookup runs)", async () => {
    const rateLimit = fakeRateLimit();
    const getById = vi.fn(async () => null);
    const ctx = buildCtx({
      rateLimit,
      repos: { embeds: { getById } } as unknown as Ctx["repos"],
    });
    const caller = callerFor(ctx);

    // Embed not found → NOT_FOUND, proving the limiter allowed the request
    // through to the use case.
    await expect(
      caller.embeds.createGuestCheckout(validInput),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(rateLimit.consume).toHaveBeenCalledWith(
      `embed:guestCheckout:${CLIENT_IP}`,
      10,
      60,
    );
    expect(getById).toHaveBeenCalledWith(EMBED_ID);
  });

  it("falls back to a shared no-ip bucket when the client IP is unknown", async () => {
    const rateLimit = fakeRateLimit(["embed:guestCheckout:no-ip"]);
    const caller = callerFor(buildCtx({ rateLimit, clientIp: null }));

    await expect(
      caller.embeds.createGuestCheckout(validInput),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });
});

describe("embeds.createGuestCheckout — tax deps wiring", () => {
  it("regression: hands the use case the composition root's taxRateLookup and reportError (an unstamped event must not charge embed buyers $0 tax)", async () => {
    const spy = vi
      .spyOn(guestCheckoutModule, "createEmbedGuestCheckout")
      .mockResolvedValue({} as never);
    const taxRateLookup = { lookupByPostalCode: vi.fn() };
    const reportError = vi.fn();
    const caller = callerFor(
      buildCtx({
        taxRateLookup,
        reportError,
      } as unknown as Partial<Ctx>),
    );

    await caller.embeds.createGuestCheckout(validInput);

    expect(spy).toHaveBeenCalledTimes(1);
    const deps = spy.mock.calls[0]![0];
    expect(deps.taxRateLookup).toBe(taxRateLookup);
    expect(deps.reportError).toBe(reportError);
    spy.mockRestore();
  });

  it("passes null / undefined (not a throw) when the API has no tax provider configured", async () => {
    const spy = vi
      .spyOn(guestCheckoutModule, "createEmbedGuestCheckout")
      .mockResolvedValue({} as never);
    const caller = callerFor(buildCtx());
    await caller.embeds.createGuestCheckout(validInput);
    const deps = spy.mock.calls[0]![0];
    expect(deps.taxRateLookup).toBeNull();
    expect(deps.reportError).toBeUndefined();
    spy.mockRestore();
  });
});

// gitleaks:allow (fake test fixture)
const ROUTER_RECEIPT_SECRET = "FakeRouterReceiptSecret_NotReal-0123456789A";

describe("embeds.createGuestCheckout — the persisted order's lines reach the client", () => {
  it("returns the use case's lineItems untouched (the confirmation prints them)", async () => {
    const lineItems = [
      {
        ticketTypeId: TICKET_TYPE_ID,
        name: "General Admission",
        qty: 2,
        unitPriceCents: 1000,
        lineCents: 2000,
      },
    ];
    const spy = vi
      .spyOn(guestCheckoutModule, "createEmbedGuestCheckout")
      .mockResolvedValue({
        orderId: "00000000-0000-4000-8000-0000000000c9",
        clientSecret: "pi_secret", // gitleaks:allow (fake test fixture)
        receiptSecret: ROUTER_RECEIPT_SECRET,
        amountGrossCents: 2000,
        feesPlatformCents: 100,
        buyerFeesCents: 100,
        processorFeeCents: 94,
        feeMode: "PASS_THROUGH",
        taxAmountCents: 0,
        holdExpiresAt: null,
        lineItems,
        tickets: [],
      });
    const caller = callerFor(buildCtx());
    const result = await caller.embeds.createGuestCheckout(validInput);
    expect(result.lineItems).toEqual(lineItems);
    // The receipt secret reaches the widget: it is what earns the codes
    // from confirmGuestPayment.
    expect(result.receiptSecret).toBe(ROUTER_RECEIPT_SECRET);
    spy.mockRestore();
  });

  it("returns a free claim's ticket codes untouched (the confirmation shows them)", async () => {
    const tickets = [
      { code: "tk_routerfree1", ticketTypeName: "General Admission", seatLabel: null },
    ];
    const spy = vi
      .spyOn(guestCheckoutModule, "createEmbedGuestCheckout")
      .mockResolvedValue({
        orderId: "00000000-0000-4000-8000-0000000000c9",
        clientSecret: null,
        receiptSecret: null,
        amountGrossCents: 0,
        feesPlatformCents: 0,
        buyerFeesCents: 0,
        processorFeeCents: 0,
        feeMode: "PASS_THROUGH",
        taxAmountCents: 0,
        holdExpiresAt: null,
        lineItems: [],
        tickets,
      });
    const caller = callerFor(buildCtx());
    const result = await caller.embeds.createGuestCheckout(validInput);
    expect(result.tickets).toEqual(tickets);
    spy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// embeds.confirmGuestPayment: the widget asks the server before it shows
// "Order confirmed" (owner ruling 2026-10-11)
// ─────────────────────────────────────────────────────────────────────────────

const CONFIRM_ORDER_ID = "00000000-0000-4000-8000-0000000000ca";
// gitleaks:allow (fake test fixture)
const CONFIRM_CLIENT_SECRET = "pi_3RouterConfirm_secret_FakeFixtureNotReal";
const confirmInput = {
  embedId: EMBED_ID,
  hostOrigin: "https://shop.example.com",
  clientSecret: CONFIRM_CLIENT_SECRET,
};

describe("embeds.confirmGuestPayment — per-IP rate limit", () => {
  it("rejects with TOO_MANY_REQUESTS when the per-IP budget is exhausted, before the use case runs", async () => {
    const spy = vi.spyOn(guestConfirmModule, "confirmEmbedGuestPayment");
    const rateLimit = fakeRateLimit([`embed:guestConfirm:${CLIENT_IP}`]);
    const caller = callerFor(buildCtx({ rateLimit }));

    await expect(
      caller.embeds.confirmGuestPayment(confirmInput),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    // 20/60s: twice the checkout budget, because one order can be asked
    // about several times (a bank payment still processing, a retry).
    expect(rateLimit.consume).toHaveBeenCalledWith(
      `embed:guestConfirm:${CLIENT_IP}`,
      20,
      60,
    );
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("has its own bucket: an exhausted checkout budget does not block confirming a payment already made", async () => {
    const rateLimit = fakeRateLimit([`embed:guestCheckout:${CLIENT_IP}`]);
    const getById = vi.fn(async () => null);
    const caller = callerFor(
      buildCtx({
        rateLimit,
        repos: { embeds: { getById } } as unknown as Ctx["repos"],
      }),
    );

    // Embed not found → NOT_FOUND, proving the request reached the use case.
    await expect(
      caller.embeds.confirmGuestPayment(confirmInput),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(getById).toHaveBeenCalledWith(EMBED_ID);
  });

  it("falls back to a shared no-ip bucket when the client IP is unknown", async () => {
    const rateLimit = fakeRateLimit(["embed:guestConfirm:no-ip"]);
    const caller = callerFor(buildCtx({ rateLimit, clientIp: null }));

    await expect(
      caller.embeds.confirmGuestPayment(confirmInput),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });
});

describe("embeds.confirmGuestPayment — input, deps and answers", () => {
  it("refuses an order id, a malformed secret and a missing secret as BAD_REQUEST without calling the use case", async () => {
    const spy = vi.spyOn(guestConfirmModule, "confirmEmbedGuestPayment");
    const caller = callerFor(buildCtx());

    await expect(
      caller.embeds.confirmGuestPayment({
        ...confirmInput,
        orderId: CONFIRM_ORDER_ID,
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.embeds.confirmGuestPayment({
        ...confirmInput,
        clientSecret: "pi_3RouterConfirm",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.embeds.confirmGuestPayment({
        embedId: EMBED_ID,
        hostOrigin: "https://shop.example.com",
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("wires the deps orders.confirmPayment wires, and hands the input through untouched", async () => {
    const spy = vi
      .spyOn(guestConfirmModule, "confirmEmbedGuestPayment")
      .mockResolvedValue({ outcome: "confirmed", orderId: CONFIRM_ORDER_ID, tickets: [] });
    const notify = vi.fn();
    const reportError = vi.fn();
    const ctx = buildCtx({
      notify,
      reportError,
      devInstantPayouts: true,
    } as unknown as Partial<Ctx>);
    const caller = callerFor(ctx);

    await caller.embeds.confirmGuestPayment(confirmInput);

    const [deps, input] = spy.mock.calls[0]!;
    expect(deps.repos).toBe(ctx.repos);
    expect(deps.payments).toBe(ctx.payments);
    expect(deps.idempotency).toBe(ctx.idempotency);
    expect(deps.clock).toBe(ctx.clock);
    expect(deps.notify).toBe(notify);
    expect(deps.reportError).toBe(reportError);
    expect(deps.devInstantPayouts).toBe(true);
    expect(deps.publicAppUrl).toBe("http://localhost:3000");
    // The per-PaymentIntent budget is charged inside the use case.
    expect(deps.rateLimit).toBe(ctx.rateLimit);
    expect(input).toEqual(confirmInput);
    spy.mockRestore();
  });

  it("hands the receipt secret through untouched when the widget sends one", async () => {
    const spy = vi
      .spyOn(guestConfirmModule, "confirmEmbedGuestPayment")
      .mockResolvedValue({ outcome: "confirmed", orderId: CONFIRM_ORDER_ID, tickets: [] });
    const caller = callerFor(buildCtx());

    await caller.embeds.confirmGuestPayment({
      ...confirmInput,
      receiptSecret: ROUTER_RECEIPT_SECRET,
    });

    expect(spy.mock.calls[0]![1]).toEqual({
      ...confirmInput,
      receiptSecret: ROUTER_RECEIPT_SECRET,
    });
    spy.mockRestore();
  });

  it.each([
    ["too short", "abc"],
    ["not base64url", "FakeRouterReceiptSecret NotReal 0123456789A"],
    ["not a string", 12345],
  ])("refuses a receipt secret that is %s as BAD_REQUEST without calling the use case", async (_label, receiptSecret) => {
    const spy = vi.spyOn(guestConfirmModule, "confirmEmbedGuestPayment");
    const caller = callerFor(buildCtx());

    await expect(
      caller.embeds.confirmGuestPayment({
        ...confirmInput,
        receiptSecret,
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("is not gated on the buy-tickets switch: a payment already made stays confirmable", async () => {
    const spy = vi
      .spyOn(guestConfirmModule, "confirmEmbedGuestPayment")
      .mockResolvedValue({ outcome: "confirmed", orderId: CONFIRM_ORDER_ID, tickets: [] });
    const caller = callerFor(
      buildCtx({ enableBuyTickets: false } as unknown as Partial<Ctx>),
    );

    await expect(
      caller.embeds.confirmGuestPayment(confirmInput),
    ).resolves.toEqual({ outcome: "confirmed", orderId: CONFIRM_ORDER_ID, tickets: [] });
    // The checkout beside it IS gated, so the flag reached this context.
    await expect(
      caller.embeds.createGuestCheckout(validInput),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    spy.mockRestore();
  });

  it.each([
    [{ outcome: "confirmed", orderId: CONFIRM_ORDER_ID, tickets: [] }],
    [{ outcome: "processing", orderId: CONFIRM_ORDER_ID }],
    [
      {
        outcome: "not_paid",
        orderId: CONFIRM_ORDER_ID,
        paymentIntentStatus: "requires_payment_method",
      },
    ],
  ] as const)("returns the use case's answer %j", async (answer) => {
    const spy = vi
      .spyOn(guestConfirmModule, "confirmEmbedGuestPayment")
      .mockResolvedValue(answer);
    const caller = callerFor(buildCtx());

    await expect(
      caller.embeds.confirmGuestPayment(confirmInput),
    ).resolves.toEqual(answer);
    spy.mockRestore();
  });

  it("confirmed carries the payer's tickets through the output schema: GA and seated", async () => {
    const answer = {
      outcome: "confirmed" as const,
      orderId: CONFIRM_ORDER_ID,
      tickets: [
        { code: "tk_routerseat1", ticketTypeName: "Balcony", seatLabel: "Balcony Left · A2" },
        { code: "tk_routerga1", ticketTypeName: null, seatLabel: null },
      ],
    };
    const spy = vi
      .spyOn(guestConfirmModule, "confirmEmbedGuestPayment")
      .mockResolvedValue(answer);
    const caller = callerFor(buildCtx());

    await expect(
      caller.embeds.confirmGuestPayment(confirmInput),
    ).resolves.toEqual(answer);
    spy.mockRestore();
  });

  it.each([
    ["a confirmed answer without tickets", { outcome: "confirmed", orderId: CONFIRM_ORDER_ID }],
    [
      "a processing answer with tickets",
      { outcome: "processing", orderId: CONFIRM_ORDER_ID, tickets: [] },
    ],
    [
      "a not_paid answer with tickets",
      {
        outcome: "not_paid",
        orderId: CONFIRM_ORDER_ID,
        paymentIntentStatus: "canceled",
        tickets: [],
      },
    ],
    [
      "a ticket with an extra field (an owner id riding along)",
      {
        outcome: "confirmed",
        orderId: CONFIRM_ORDER_ID,
        tickets: [
          { code: "tk_x", ticketTypeName: null, seatLabel: null, ownerHumanId: "someone" },
        ],
      },
    ],
    [
      "more than 50 tickets",
      {
        outcome: "confirmed",
        orderId: CONFIRM_ORDER_ID,
        tickets: Array.from({ length: 51 }, (_, i) => ({
          code: `tk_${i}`,
          ticketTypeName: null,
          seatLabel: null,
        })),
      },
    ],
  ])("the output schema refuses %s", async (_label, answer) => {
    const spy = vi
      .spyOn(guestConfirmModule, "confirmEmbedGuestPayment")
      .mockResolvedValue(answer as never);
    const caller = callerFor(buildCtx());

    await expect(
      caller.embeds.confirmGuestPayment(confirmInput),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    spy.mockRestore();
  });

  it("the output schema refuses anything beyond the answer (no buyer data can ride along)", async () => {
    const spy = vi
      .spyOn(guestConfirmModule, "confirmEmbedGuestPayment")
      .mockResolvedValue({
        outcome: "confirmed",
        orderId: CONFIRM_ORDER_ID,
        guestEmail: "guest@buyer.test",
      } as never);
    const caller = callerFor(buildCtx());

    await expect(
      caller.embeds.confirmGuestPayment(confirmInput),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    spy.mockRestore();
  });

  it.each([
    ["PAYMENT_INTENT_ORDER_MISMATCH", "CONFLICT"],
    ["ORDER_NOT_PROCESSABLE", "CONFLICT"],
    ["PAYMENT_INTENT_MISMATCH", "CONFLICT"],
    ["EMBED_ORIGIN_NOT_ALLOWED", "FORBIDDEN"],
    // A finalize already running for the order (the webhook's). The widget
    // tells it from a spent rate limit by the app code, not this tRPC code.
    ["IDEMPOTENCY_LOCK_IN_PROGRESS", "TOO_MANY_REQUESTS"],
  ] as const)("maps a thrown %s to %s", async (appCode, trpcCode) => {
    const { AppError } = await import("@th/errors");
    const spy = vi
      .spyOn(guestConfirmModule, "confirmEmbedGuestPayment")
      .mockRejectedValue(new AppError(appCode));
    const caller = callerFor(buildCtx());

    await expect(
      caller.embeds.confirmGuestPayment(confirmInput),
    ).rejects.toMatchObject({ code: trpcCode });
    spy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// embeds.releaseGuestOrder: a guest gives back an order they abandoned
// (owner ruling 2026-10-11, "A guest can release it")
// ─────────────────────────────────────────────────────────────────────────────

const RELEASE_ORDER_ID = "00000000-0000-4000-8000-0000000000cb";
// gitleaks:allow (fake test fixture)
const RELEASE_CLIENT_SECRET = "pi_3RouterRelease_secret_FakeFixtureNotReal";
const releaseInput = {
  embedId: EMBED_ID,
  hostOrigin: "https://shop.example.com",
  clientSecret: RELEASE_CLIENT_SECRET,
};

describe("embeds.releaseGuestOrder — public, per-IP rate limit under its own key", () => {
  it("is callable with no session: an anonymous caller reaches the use case", async () => {
    const spy = vi
      .spyOn(guestReleaseModule, "releaseEmbedGuestOrder")
      .mockResolvedValue({ outcome: "released", orderId: RELEASE_ORDER_ID });
    // `buildCtx` is anonymous: no actor, no auth, no token.
    const ctx = buildCtx();
    expect(ctx.actorHumanId).toBeNull();
    expect(ctx.auth).toBeNull();

    await expect(
      callerFor(ctx).embeds.releaseGuestOrder(releaseInput),
    ).resolves.toEqual({ outcome: "released", orderId: RELEASE_ORDER_ID });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("rejects with TOO_MANY_REQUESTS when the per-IP budget is exhausted, before the use case runs", async () => {
    const spy = vi.spyOn(guestReleaseModule, "releaseEmbedGuestOrder");
    const rateLimit = fakeRateLimit([`embed:guestRelease:${CLIENT_IP}`]);
    const caller = callerFor(buildCtx({ rateLimit }));

    await expect(
      caller.embeds.releaseGuestOrder(releaseInput),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    expect(rateLimit.consume).toHaveBeenCalledWith(
      `embed:guestRelease:${CLIENT_IP}`,
      20,
      60,
    );
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("has its own bucket: spent checkout and confirm budgets do not stop a release, and it consumes neither", async () => {
    const rateLimit = fakeRateLimit([
      `embed:guestCheckout:${CLIENT_IP}`,
      `embed:guestConfirm:${CLIENT_IP}`,
    ]);
    const getById = vi.fn(async () => null);
    const caller = callerFor(
      buildCtx({
        rateLimit,
        repos: { embeds: { getById } } as unknown as Ctx["repos"],
      }),
    );

    // Embed not found → NOT_FOUND, proving the request reached the use case.
    await expect(
      caller.embeds.releaseGuestOrder(releaseInput),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(getById).toHaveBeenCalledWith(EMBED_ID);
    // Of the embed budgets, only its own is spent.
    expect(
      rateLimit.consume.mock.calls
        .map((c) => c[0])
        .filter((key) => key.startsWith("embed:")),
    ).toEqual([`embed:guestRelease:${CLIENT_IP}`]);
  });

  it("a malformed secret still spends budget: the limiter runs before the input is parsed", async () => {
    const rateLimit = fakeRateLimit();
    const caller = callerFor(buildCtx({ rateLimit }));

    await expect(
      caller.embeds.releaseGuestOrder({
        ...releaseInput,
        clientSecret: "not-a-secret",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(rateLimit.consume).toHaveBeenCalledWith(
      `embed:guestRelease:${CLIENT_IP}`,
      20,
      60,
    );
  });

  it("falls back to a shared no-ip bucket when the client IP is unknown", async () => {
    const rateLimit = fakeRateLimit(["embed:guestRelease:no-ip"]);
    const caller = callerFor(buildCtx({ rateLimit, clientIp: null }));

    await expect(
      caller.embeds.releaseGuestOrder(releaseInput),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });
});

describe("embeds.releaseGuestOrder — input, deps and answers", () => {
  it("refuses an order id, a malformed secret and a missing secret as BAD_REQUEST without calling the use case", async () => {
    const spy = vi.spyOn(guestReleaseModule, "releaseEmbedGuestOrder");
    const caller = callerFor(buildCtx());

    await expect(
      caller.embeds.releaseGuestOrder({
        ...releaseInput,
        orderId: RELEASE_ORDER_ID,
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.embeds.releaseGuestOrder({
        ...releaseInput,
        clientSecret: "pi_3RouterRelease",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.embeds.releaseGuestOrder({
        embedId: EMBED_ID,
        hostOrigin: "https://shop.example.com",
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("wires what releaseCartHold needs plus the reporter and the app origin, and hands the input through untouched", async () => {
    const spy = vi
      .spyOn(guestReleaseModule, "releaseEmbedGuestOrder")
      .mockResolvedValue({ outcome: "released", orderId: RELEASE_ORDER_ID });
    const reportError = vi.fn();
    const ctx = buildCtx({ reportError } as unknown as Partial<Ctx>);
    const caller = callerFor(ctx);

    await caller.embeds.releaseGuestOrder(releaseInput);

    const [deps, input] = spy.mock.calls[0]!;
    expect(deps.repos).toBe(ctx.repos);
    expect(deps.payments).toBe(ctx.payments);
    expect(deps.clock).toBe(ctx.clock);
    expect(deps.reportError).toBe(reportError);
    expect(deps.publicAppUrl).toBe("http://localhost:3000");
    // Narrow: a release finalizes nothing and notifies nobody.
    expect(Object.keys(deps).sort()).toEqual([
      "clock",
      "logger",
      "payments",
      "publicAppUrl",
      "rateLimit",
      "reportError",
      "repos",
    ]);
    // The per-PaymentIntent budget is charged inside the use case.
    expect(deps.rateLimit).toBe(ctx.rateLimit);
    expect(input).toEqual(releaseInput);
    spy.mockRestore();
  });

  it("is not gated on the buy-tickets switch: a hold can be given back after buying is switched off", async () => {
    const spy = vi
      .spyOn(guestReleaseModule, "releaseEmbedGuestOrder")
      .mockResolvedValue({ outcome: "released", orderId: RELEASE_ORDER_ID });
    const caller = callerFor(
      buildCtx({ enableBuyTickets: false } as unknown as Partial<Ctx>),
    );

    await expect(
      caller.embeds.releaseGuestOrder(releaseInput),
    ).resolves.toEqual({ outcome: "released", orderId: RELEASE_ORDER_ID });
    // The checkout beside it IS gated, so the flag reached this context.
    await expect(
      caller.embeds.createGuestCheckout(validInput),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    spy.mockRestore();
  });

  it.each([
    [{ outcome: "released", orderId: RELEASE_ORDER_ID }],
    [{ outcome: "gone", orderId: RELEASE_ORDER_ID }],
    [{ outcome: "kept", orderId: RELEASE_ORDER_ID }],
  ] as const)("returns the use case's answer %j", async (answer) => {
    const spy = vi
      .spyOn(guestReleaseModule, "releaseEmbedGuestOrder")
      .mockResolvedValue(answer);
    const caller = callerFor(buildCtx());

    await expect(
      caller.embeds.releaseGuestOrder(releaseInput),
    ).resolves.toEqual(answer);
    spy.mockRestore();
  });

  it("the output schema refuses anything beyond the answer (no buyer data, no secret can ride along)", async () => {
    const spy = vi
      .spyOn(guestReleaseModule, "releaseEmbedGuestOrder")
      .mockResolvedValue({
        outcome: "released",
        orderId: RELEASE_ORDER_ID,
        clientSecret: RELEASE_CLIENT_SECRET,
      } as never);
    const caller = callerFor(buildCtx());

    await expect(
      caller.embeds.releaseGuestOrder(releaseInput),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    spy.mockRestore();
  });

  it("the one refusal reaches the client as CONFLICT carrying only the app code", async () => {
    const { AppError } = await import("@th/errors");
    const spy = vi
      .spyOn(guestReleaseModule, "releaseEmbedGuestOrder")
      // Exactly what the use case throws: a bare AppError, no meta.
      .mockRejectedValue(new AppError("PAYMENT_INTENT_ORDER_MISMATCH"));
    const caller = callerFor(buildCtx());

    const thrown = await caller.embeds
      .releaseGuestOrder(releaseInput)
      .catch((e: unknown) => e);

    expect(thrown).toMatchObject({
      code: "CONFLICT",
      message: "PAYMENT_INTENT_ORDER_MISMATCH",
    });
    expect(JSON.stringify(thrown)).not.toContain("_secret_");
    spy.mockRestore();
  });

  it.each([
    ["releaseGuestOrder", guestReleaseModule, "releaseEmbedGuestOrder", releaseInput],
    ["confirmGuestPayment", guestConfirmModule, "confirmEmbedGuestPayment", confirmInput],
  ] as const)(
    "%s: a spent per-PaymentIntent budget reaches the client as TOO_MANY_REQUESTS (the widget's 'ask later'), not as the finalize lock",
    async (procedure, mod, fn, procedureInput) => {
      const { AppError } = await import("@th/errors");
      const spy = vi
        .spyOn(mod as never, fn as never)
        // Exactly what `chargeGuestProofBudget` throws.
        .mockRejectedValue(
          new AppError("RATE_LIMITED", {
            message: "Too many requests about this order. Try again in 42s.",
            meta: { scope: "embed_guest_proof", retryAfterSeconds: 42 },
          }) as never,
        );
      const caller = callerFor(buildCtx());

      const thrown = await (caller.embeds[procedure] as (i: unknown) => Promise<unknown>)(
        procedureInput,
      ).catch((e: unknown) => e);

      expect(thrown).toMatchObject({ code: "TOO_MANY_REQUESTS" });
      expect(JSON.stringify(thrown)).not.toContain(
        "IDEMPOTENCY_LOCK_IN_PROGRESS",
      );
      spy.mockRestore();
    },
  );

  it.each([
    ["EMBED_NOT_FOUND", "NOT_FOUND"],
    ["EMBED_ORIGIN_NOT_ALLOWED", "FORBIDDEN"],
    ["INTERNAL", "INTERNAL_SERVER_ERROR"],
  ] as const)("maps a thrown %s to %s", async (appCode, trpcCode) => {
    const { AppError } = await import("@th/errors");
    const spy = vi
      .spyOn(guestReleaseModule, "releaseEmbedGuestOrder")
      .mockRejectedValue(new AppError(appCode));
    const caller = callerFor(buildCtx());

    await expect(
      caller.embeds.releaseGuestOrder(releaseInput),
    ).rejects.toMatchObject({ code: trpcCode });
    spy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Booking widget procedures (booking-request-embed-button FR-004, NFR-001/002)
// ─────────────────────────────────────────────────────────────────────────────

const PLACE_ID = "00000000-0000-4000-8000-0000000000c3";
const OWNER_HUMAN_ID = "77777777-7777-4777-8777-777777777777";
const INQUIRY_ID = "00000000-0000-4000-8000-0000000000c4";
const EMBED_DOMAIN = "shop.example.com";

const placeEmbed = {
  id: EMBED_ID,
  subjectType: "place",
  subjectId: PLACE_ID,
  domain: EMBED_DOMAIN,
  status: "ACTIVE",
  requireAuth: false,
  linkOut: false,
  // Place (booking) embeds never carry view config — the column defaults are
  // what the row reads, and upsert REJECTS any attempt to set them (FR-002).
  defaultView: "list",
  viewToggle: false,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

const verifiedPlace = {
  id: PLACE_ID,
  name: "Test Venue",
  city: "Nashville",
  region: "TN",
  verificationStatus: "VERIFIED",
  acceptsBookingRequests: true,
  humanIdsWithAccess: [OWNER_HUMAN_ID],
  orgIdsWithAccess: [],
};

/**
 * Repos for the inquiry create path INCLUDING the post-commit venue
 * notification (notify-booking-request-received reads humans + entityPages
 * for the direct human owner's admin slug).
 */
function buildInquiryRepos() {
  const mocks = {
    // The `_id` params keep `mockImplementation((id) => ...)` type-compatible
    // for tests that vary the returned embed/place per id.
    embeds: { getById: vi.fn(async (_id: string) => placeEmbed) },
    places: { getById: vi.fn(async (_id: string) => verifiedPlace) },
    bookingRequests: {
      findOpenByContactEmailAndPlace: vi.fn(async () => null),
      create: vi.fn(async (input: Record<string, unknown>) => ({
        id: INQUIRY_ID,
        placeId: PLACE_ID,
        performerOwnerType: null,
        performerOwnerId: null,
        status: "PENDING",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        ...input,
      })),
      // The create tx also opens the booking LEDGER
      // (`booking_request.opened`, source EMBED), which bumps this stamp.
      touchLastMessageAt: vi.fn(async () => {}),
      // The bill (lineup-booking-requests v2, FR-005): the inquiry's actName
      // is written as its first act row in the same tx.
      addActs: vi.fn(async () => []),
    },
    // Ledger writer used by `appendBookingSystemEntry` inside the create tx.
    bookingRequestMessages: createFakeBookingRequestMessagesRepo(),
    humans: {
      getByIdWithIdentity: vi.fn(async (id: string) => ({
        human: { id, name: "Venue Owner" },
        identity: { username: "venueowner" },
      })),
    },
    organizations: {
      getById: vi.fn(async () => null),
      listMembers: vi.fn(async () => ({ items: [], total: 0 })),
    },
    entityPages: { getByOwner: vi.fn(async () => null) },
    audit: { log: vi.fn(async () => {}) },
    // No calendars and no rules rows = "the venue has no availability rules
    // configured" (validate-booking-dates.ts's own docblock), which is the
    // default state for every place fixture in this file — none of them set up
    // availability rules, so an empty result never blocks the inquiry.
    // Availability is calendar-scoped since the picker's re-target (FR-007).
    calendars: {
      listByPlace: vi.fn(async () => []),
      listAvailabilityForPlace: vi.fn(async () => []),
      // FR-008 routing: no calendars here, so the inquiry routes `calendarId:
      // null` (unrouted) — which is what every expectation below assumes.
      findDefaultForPlace: vi.fn(async () => null),
      // Availability-onboarding FR-005 gate: CONFIGURED (rows exist, no
      // window policy) so this suite keeps testing wiring, not the gate.
      countAvailabilityForPlace: vi.fn(async () => 1),
    },
    // No published events at the place = no existing bookings to collide
    // with — same "nothing configured, don't block" default as above.
    events: {
      listPublishedOccurrencesByPlace: vi.fn(async () => []),
    },
    // Venue booking standards (spec 2026-09-25): nothing configured, so the
    // inquiry gate reads the platform list and blocks nothing.
    bookingStandards: createFakeBookingStandards(),
  };
  return {
    ...mocks,
    tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mocks)),
    mocks,
  } as unknown as Ctx["repos"] & { mocks: typeof mocks };
}

const validInquiry = {
  embedId: EMBED_ID,
  hostOrigin: `https://${EMBED_DOMAIN}`,
  contactName: "Jo Doe",
  contactEmail: "JO@Example.com",
  actName: "The Ramblers",
  message: "We'd love to play a Friday night slot.",
  preferredDates: ["2026-08-14"],
};

describe("embeds.getBookingWidget", () => {
  it("returns embed + place summary + accepting flag for an allowlisted origin", async () => {
    const repos = buildInquiryRepos();
    const caller = callerFor(buildCtx({ repos }));

    const result = await caller.embeds.getBookingWidget({
      embedId: EMBED_ID,
      hostOrigin: `https://${EMBED_DOMAIN}`,
    });

    expect(result).toEqual({
      embed: { id: EMBED_ID, subjectType: "place", domain: EMBED_DOMAIN },
      place: {
        id: PLACE_ID,
        name: "Test Venue",
        city: "Nashville",
        region: "TN",
      },
      accepting: true,
    });
  });

  it("rejects a non-allowlisted origin with FORBIDDEN (fail closed, NFR-001)", async () => {
    const repos = buildInquiryRepos();
    const caller = callerFor(buildCtx({ repos }));

    await expect(
      caller.embeds.getBookingWidget({
        embedId: EMBED_ID,
        hostOrigin: "https://evil.example.net",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Fail-closed BEFORE any place data is read.
    expect(repos.mocks.places.getById).not.toHaveBeenCalled();
  });
});

describe("embeds.createBookingInquiry", () => {
  it("creates the inquiry (source EMBED, server-injected requestIp) and fires the venue notification, preferring ctx.notifyWithEmail", async () => {
    const repos = buildInquiryRepos();
    const notify = vi.fn(async () => ({ ok: true }));
    const notifyWithEmail = vi.fn(async () => ({ ok: true }));
    const caller = callerFor(
      buildCtx({
        repos,
        notify: notify as unknown as Ctx["notify"],
        notifyWithEmail: notifyWithEmail as unknown as Ctx["notifyWithEmail"],
      }),
    );

    const result = await caller.embeds.createBookingInquiry(validInquiry);

    expect(result).toEqual({ bookingRequestId: INQUIRY_ID });
    expect(repos.mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        placeId: PLACE_ID,
        source: "EMBED",
        embedId: EMBED_ID,
        contactName: "Jo Doe",
        // Lowercased at the boundary (anonymous dedupe matches lower()).
        contactEmail: "jo@example.com",
        actName: "The Ramblers",
      }),
    );
    // Venue notification (FR-008): mailer-bound notifyWithEmail preferred.
    expect(notifyWithEmail).toHaveBeenCalledTimes(1);
    expect(notifyWithEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: OWNER_HUMAN_ID,
        variant: "booking.request-received",
        idempotencyKey: `booking-request-received:${INQUIRY_ID}:${OWNER_HUMAN_ID}`,
      }),
    );
    expect(notify).not.toHaveBeenCalled();
  });

  it("rejects a client-smuggled requestIp (server-injected field, .strict())", async () => {
    const repos = buildInquiryRepos();
    const caller = callerFor(buildCtx({ repos }));

    await expect(
      caller.embeds.createBookingInquiry({
        ...validInquiry,
        requestIp: "6.6.6.6",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(repos.mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("threads ctx.turnstile and verifies with the server-observed client IP", async () => {
    const repos = buildInquiryRepos();
    const verify = vi.fn(async () => true);
    const caller = callerFor(
      buildCtx({
        repos,
        turnstile: { enabled: true, verify } as unknown as Ctx["turnstile"],
      }),
    );

    await caller.embeds.createBookingInquiry({
      ...validInquiry,
      turnstileToken: "tok-123",
    });

    // The verify call receives ctx.clientIp — proving requestIp is injected
    // server-side, not read from the wire input.
    expect(verify).toHaveBeenCalledWith("tok-123", CLIENT_IP);
  });

  it("rejects when Turnstile verification fails (no row written)", async () => {
    const repos = buildInquiryRepos();
    const caller = callerFor(
      buildCtx({
        repos,
        turnstile: {
          enabled: true,
          verify: vi.fn(async () => false),
        } as unknown as Ctx["turnstile"],
      }),
    );

    await expect(
      caller.embeds.createBookingInquiry({
        ...validInquiry,
        turnstileToken: "tok-bad",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(repos.mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("enforces the 5/60s per-IP budget — 6th call in the window is TOO_MANY_REQUESTS", async () => {
    // Real fixed-window semantics per key (the default floor limiter uses
    // its own key, so the counting stays per-budget).
    const counts = new Map<string, number>();
    const consume = vi.fn(
      async (key: string, maxRequests: number): Promise<ConsumeResult> => {
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return n <= maxRequests
          ? { allowed: true, remaining: maxRequests - n, retryAfterSeconds: 0 }
          : { allowed: false, remaining: 0, retryAfterSeconds: 30 };
      },
    );
    const repos = buildInquiryRepos();
    const caller = callerFor(
      buildCtx({
        repos,
        rateLimit: withConsumeMany({ consume }) as unknown as Ctx["rateLimit"],
      }),
    );

    for (let i = 0; i < 5; i += 1) {
      // Fresh contact email per call to dodge the open-inquiry dedupe.
      await caller.embeds.createBookingInquiry({
        ...validInquiry,
        contactEmail: `jo${i}@example.com`,
      });
    }

    await expect(
      caller.embeds.createBookingInquiry({
        ...validInquiry,
        contactEmail: "jo6@example.com",
      }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(consume).toHaveBeenCalledWith(
      `embed:bookingInquiry:${CLIENT_IP}`,
      5,
      60,
    );
  });

  it("enforces the per-place daily flood cap — the 31st inquiry for a place is TOO_MANY_REQUESTS even across rotating IPs", async () => {
    // Real fixed-window counting per key. Rotating the client IP per call
    // simulates the exact attack the cap exists for (per-IP 5/60s dodged by
    // IP rotation, dedupe dodged by attacker-controlled emails) — only the
    // place-keyed daily bucket accumulates.
    const counts = new Map<string, number>();
    const consume = vi.fn(
      async (key: string, maxRequests: number): Promise<ConsumeResult> => {
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return n <= maxRequests
          ? { allowed: true, remaining: maxRequests - n, retryAfterSeconds: 0 }
          : { allowed: false, remaining: 0, retryAfterSeconds: 3600 };
      },
    );
    const rateLimit = withConsumeMany({ consume }) as unknown as Ctx["rateLimit"];
    const repos = buildInquiryRepos();
    const callerForIp = (ip: string) =>
      callerFor(buildCtx({ repos, rateLimit, clientIp: ip }));

    for (let i = 0; i < BOOKING_INQUIRY_PLACE_DAILY_MAX; i += 1) {
      await callerForIp(`198.51.100.${i}`).embeds.createBookingInquiry({
        ...validInquiry,
        contactEmail: `attacker${i}@example.com`,
      });
    }

    await expect(
      callerForIp("198.51.100.254").embeds.createBookingInquiry({
        ...validInquiry,
        contactEmail: "attacker-final@example.com",
      }),
    ).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      meta: expect.objectContaining({
        appCode: "RATE_LIMITED",
        scope: "booking_inquiry_place_daily",
      }),
    });

    // Exact key + budget: place-keyed (not embed/IP), 30 per 24h.
    expect(consume).toHaveBeenCalledWith(
      bookingInquiryPlaceDailyKey(PLACE_ID),
      BOOKING_INQUIRY_PLACE_DAILY_MAX,
      BOOKING_INQUIRY_PLACE_DAILY_WINDOW_SECONDS,
    );
    // Exactly 30 rows were written — the 31st never reached the repo.
    expect(repos.mocks.bookingRequests.create).toHaveBeenCalledTimes(
      BOOKING_INQUIRY_PLACE_DAILY_MAX,
    );
  });

  it("gives different places independent daily buckets — exhausting place A does not block place B", async () => {
    const EMBED_ID_B = "00000000-0000-4000-8000-0000000000c8";
    const PLACE_ID_B = "00000000-0000-4000-8000-0000000000c9";
    const embedB = { ...placeEmbed, id: EMBED_ID_B, subjectId: PLACE_ID_B };
    const placeB = { ...verifiedPlace, id: PLACE_ID_B, name: "Other Venue" };

    const counts = new Map<string, number>();
    const consume = vi.fn(
      async (key: string, maxRequests: number): Promise<ConsumeResult> => {
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        return n <= maxRequests
          ? { allowed: true, remaining: maxRequests - n, retryAfterSeconds: 0 }
          : { allowed: false, remaining: 0, retryAfterSeconds: 3600 };
      },
    );
    // Pre-exhaust place A's daily bucket (as if 30 inquiries already landed).
    counts.set(
      bookingInquiryPlaceDailyKey(PLACE_ID),
      BOOKING_INQUIRY_PLACE_DAILY_MAX,
    );

    const repos = buildInquiryRepos();
    repos.mocks.embeds.getById.mockImplementation(async (id: string) =>
      id === EMBED_ID_B ? embedB : placeEmbed,
    );
    repos.mocks.places.getById.mockImplementation(async (id: string) =>
      id === PLACE_ID_B ? placeB : verifiedPlace,
    );
    const caller = callerFor(
      buildCtx({ repos, rateLimit: withConsumeMany({ consume }) as unknown as Ctx["rateLimit"] }),
    );

    // Place A: bucket full → rejected.
    await expect(
      caller.embeds.createBookingInquiry(validInquiry),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    // Place B (different embed → different place): independent bucket → OK.
    await expect(
      caller.embeds.createBookingInquiry({
        ...validInquiry,
        embedId: EMBED_ID_B,
      }),
    ).resolves.toEqual({ bookingRequestId: INQUIRY_ID });
    expect(consume).toHaveBeenCalledWith(
      bookingInquiryPlaceDailyKey(PLACE_ID_B),
      BOOKING_INQUIRY_PLACE_DAILY_MAX,
      BOOKING_INQUIRY_PLACE_DAILY_WINDOW_SECONDS,
    );
  });

  it("a throwing notifier does NOT fail the submission and reports via ctx.reportError (NFR-004)", async () => {
    const repos = buildInquiryRepos();
    const notifyWithEmail = vi.fn(async () => {
      throw new Error("notify pipeline down");
    });
    const reportError = vi.fn();
    const caller = callerFor(
      buildCtx({
        repos,
        notifyWithEmail: notifyWithEmail as unknown as Ctx["notifyWithEmail"],
        reportError,
      }),
    );

    const result = await caller.embeds.createBookingInquiry(validInquiry);

    expect(result).toEqual({ bookingRequestId: INQUIRY_ID });
    expect(notifyWithEmail).toHaveBeenCalledTimes(1);
    // The per-recipient swallow inside notifyBookingRequestReceived reports.
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "notifyBookingRequestReceived" },
      extra: {
        bookingRequestId: INQUIRY_ID,
        placeId: PLACE_ID,
        humanId: OWNER_HUMAN_ID,
      },
    });
  });
});

describe("embeds.upsert — place subject (FR-001)", () => {
  it("accepts subjectType 'place' through the router input and upserts with place-ownership RBAC", async () => {
    const mocks = {
      places: { getById: vi.fn(async () => verifiedPlace) },
      authz: { getOrgMemberships: vi.fn(async () => []) },
      embeds: {
        upsert: vi.fn(async (input: Record<string, unknown>) => ({
          ...placeEmbed,
          ...input,
          // The adapter defaults these when the caller omits them.
          requireAuth: (input.requireAuth as boolean | undefined) ?? false,
          linkOut: (input.linkOut as boolean | undefined) ?? false,
          defaultView: (input.defaultView as string | undefined) ?? "list",
          viewToggle: (input.viewToggle as boolean | undefined) ?? false,
        })),
      },
      audit: { log: vi.fn(async () => {}) },
    };
    const repos = {
      ...mocks,
      tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mocks)),
    } as unknown as Ctx["repos"];
    // Direct human owner of the place.
    const caller = callerFor(
      buildCtx({
        repos,
        actorHumanId: OWNER_HUMAN_ID,
        auth: { userId: OWNER_HUMAN_ID, sessionId: null, token: "t" } as Ctx["auth"],
        authToken: "t",
      }),
    );

    const result = await caller.embeds.upsert({
      subjectType: "place",
      subjectId: PLACE_ID,
      domain: EMBED_DOMAIN,
    });

    expect(result.embed).toMatchObject({
      subjectType: "place",
      subjectId: PLACE_ID,
      domain: EMBED_DOMAIN,
      status: "ACTIVE",
    });
    expect(mocks.embeds.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: "place",
        subjectId: PLACE_ID,
        domain: EMBED_DOMAIN,
        createdBy: OWNER_HUMAN_ID,
      }),
    );
  });
});

// Pay-what-you-want through the embed: the public input schema is DERIVED
// from the use case's (`.omit` of the server-injected fields), so the field the
// UI sends must survive the router and reach the use case untouched.
describe("embeds.createGuestCheckout — pay-what-you-want amount", () => {
  it("passes items[].donationAmountCents through to the use case", async () => {
    const mod = await import(
      "@th/core/use-cases/embeds/create-embed-guest-checkout"
    );
    const spy = vi
      .spyOn(mod, "createEmbedGuestCheckout")
      .mockResolvedValue({
        orderId: "00000000-0000-4000-8000-0000000000d1",
        clientSecret: "pi_secret",
        amountGrossCents: 1500,
        feesPlatformCents: 50,
        buyerFeesCents: 50,
        processorFeeCents: 78,
        feeMode: "PASS_THROUGH",
        taxAmountCents: 0,
        holdExpiresAt: null,
      });
    try {
      const caller = callerFor(buildCtx());
      await caller.embeds.createGuestCheckout({
        ...validInput,
        items: [{ ticketTypeId: TICKET_TYPE_ID, qty: 1, donationAmountCents: 1500 }],
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(
        (spy.mock.calls[0]![1] as { items: unknown[] }).items,
      ).toEqual([
        { ticketTypeId: TICKET_TYPE_ID, qty: 1, donationAmountCents: 1500 },
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects an amount above the $10,000 cap as BAD_REQUEST", async () => {
    const caller = callerFor(buildCtx());
    await expect(
      caller.embeds.createGuestCheckout({
        ...validInput,
        items: [
          { ticketTypeId: TICKET_TYPE_ID, qty: 1, donationAmountCents: 1_000_001 },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
