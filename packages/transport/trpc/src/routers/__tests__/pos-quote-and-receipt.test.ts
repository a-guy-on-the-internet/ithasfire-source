import { afterEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@th/errors";
import * as posUseCases from "@th/core/use-cases/pos";

import type { Ctx } from "../../context";
import { posRouter } from "../pos";
import { createCaller } from "./test-helpers";

/**
 * `pos.quoteCart` and the door buyer email on `pos.recordCashSale` /
 * `pos.startSale` (spec 2026-10-07 door-sales FR-010/FR-011): thin
 * transport. The actor comes from the session, never the body; the tax
 * provider and reporter are wired; the cash sale gets the receipt mail config
 * from ctx; refusals keep their codes and meta.
 */

const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const GA_ID = "33333333-3333-4333-8333-333333333333";

const QUOTE = {
  eventId: EVENT_ID,
  currency: "usd",
  isComp: false,
  lines: [{ ticketTypeId: GA_ID, qty: 1, unitPriceCents: 2500, amountCents: 2500 }],
  feesWaivedCents: 0,
  card: null,
  // Cash = ticket + tax only (owner ruling 2026-10-08): no platform fee.
  cash: {
    ticketSubtotalCents: 2500,
    discountCents: 0,
    ticketTotalCents: 2500,
    platformFeeCents: 0,
    processingFeeCents: 0,
    taxLines: [],
    taxAmountCents: 0,
    totalCents: 2500,
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pos.quoteCart", () => {
  it("passes the session's actor, the tax provider and the reporter", async () => {
    const spy = vi.spyOn(posUseCases, "quotePosCart").mockResolvedValue(QUOTE);
    const reportError = vi.fn();
    const taxRateLookup = { lookupByPostalCode: vi.fn() };

    const out = await createCaller(posRouter as never, {
      reportError,
      taxRateLookup,
    } as unknown as Partial<Ctx>).caller.quoteCart({
      eventId: EVENT_ID,
      items: [{ ticketTypeId: GA_ID, qty: 1 }],
    });

    expect(out).toEqual(QUOTE);
    expect(spy).toHaveBeenCalledTimes(1);
    const [deps, input] = spy.mock.calls[0]!;
    expect(input).toEqual({
      eventId: EVENT_ID,
      items: [{ ticketTypeId: GA_ID, qty: 1 }],
      actorHumanId: ACTOR_ID,
    });
    expect(deps.taxRateLookup).toBe(taxRateLookup);
    expect(deps.reportError).toBe(reportError);
  });

  it("an actorHumanId in the body is refused", async () => {
    const spy = vi.spyOn(posUseCases, "quotePosCart");
    await expect(
      createCaller(posRouter as never).caller.quoteCart({
        eventId: EVENT_ID,
        items: [{ ticketTypeId: GA_ID, qty: 1 }],
        actorHumanId: "44444444-4444-4444-8444-444444444444",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("signed out is UNAUTHORIZED", async () => {
    await expect(
      createCaller(posRouter as never, {
        actorHumanId: null,
        auth: null,
      } as Partial<Ctx>).caller.quoteCart({
        eventId: EVENT_ID,
        items: [{ ticketTypeId: GA_ID, qty: 1 }],
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("TAX_RATE_UNAVAILABLE keeps its meta (the Sell screen's manual-rate hint)", async () => {
    vi.spyOn(posUseCases, "quotePosCart").mockRejectedValue(
      new AppError("TAX_RATE_UNAVAILABLE", {
        meta: { canEnterManualTaxRate: true },
      }),
    );
    const err = await createCaller(posRouter as never)
      .caller.quoteCart({
        eventId: EVENT_ID,
        items: [{ ticketTypeId: GA_ID, qty: 1 }],
      })
      .catch((e: unknown) => e);
    expect((err as { meta?: Record<string, unknown> }).meta).toMatchObject({
      canEnterManualTaxRate: true,
      appCode: "TAX_RATE_UNAVAILABLE",
    });
  });
});

describe("door buyer email through the transport", () => {
  const CASH_OUT = {
    orderId: "55555555-5555-4555-8555-555555555555",
    ticketCount: 1,
    ticketCodes: ["T-1"],
    seatLabels: [],
    amountCents: 2500,
    amountCollectedCents: 3000,
    changeCents: 500,
    discountCents: 0,
    feesPlatformCents: 0,
    taxAmountCents: 0,
    expectedDueCents: 2500,
    isComp: false,
    autoAdmitted: true,
  };

  it("recordCashSale forwards the email and gets the receipt mail config from ctx", async () => {
    const spy = vi
      .spyOn(posUseCases, "recordCashSale")
      .mockResolvedValue(CASH_OUT);
    const mailer = { send: vi.fn() };

    await createCaller(posRouter as never, {
      mailer,
      publicAppUrl: "https://ithasfire.test/",
    } as unknown as Partial<Ctx>).caller.recordCashSale({
      eventId: EVENT_ID,
      clientKey: "client-key-1",
      items: [{ ticketTypeId: GA_ID, qty: 1 }],
      amountCollectedCents: 3000,
      buyerEmail: " Walk@Example.com ",
    });

    const [deps, input] = spy.mock.calls[0]!;
    // Normalised at the boundary.
    expect(input.buyerEmail).toBe("walk@example.com");
    expect(deps.receiptMail).toEqual({
      mailer,
      publicAppUrl: "https://ithasfire.test",
      supportUrl: "https://ithasfire.test/support",
      // The shared test ctx carries no tile server.
      tileServerUrl: null,
    });
  });

  it("no mailer in ctx → no receipt config (the use case reports the missing receipt)", async () => {
    const spy = vi
      .spyOn(posUseCases, "recordCashSale")
      .mockResolvedValue(CASH_OUT);
    await createCaller(posRouter as never, {
      mailer: null,
      publicAppUrl: "https://ithasfire.test",
    } as unknown as Partial<Ctx>).caller.recordCashSale({
      eventId: EVENT_ID,
      clientKey: "client-key-1",
      items: [{ ticketTypeId: GA_ID, qty: 1 }],
      amountCollectedCents: 3000,
    });
    expect(spy.mock.calls[0]![0].receiptMail).toBeNull();
  });

  it("the till's blank email field passes the boundary as no email, on both sales", async () => {
    const cash = vi
      .spyOn(posUseCases, "recordCashSale")
      .mockResolvedValue(CASH_OUT);
    const card = vi
      .spyOn(posUseCases, "startPosSale")
      .mockResolvedValue({} as never);
    const caller = createCaller(posRouter as never).caller;
    await caller.recordCashSale({
      eventId: EVENT_ID,
      clientKey: "client-key-1",
      items: [{ ticketTypeId: GA_ID, qty: 1 }],
      amountCollectedCents: 3000,
      buyerEmail: "",
    });
    await caller.startSale({
      eventId: EVENT_ID,
      clientKey: "client-key-1",
      items: [{ ticketTypeId: GA_ID, qty: 1 }],
      buyerEmail: "   ",
    });
    expect(cash.mock.calls[0]![1].buyerEmail).toBeUndefined();
    expect(card.mock.calls[0]![1].buyerEmail).toBeUndefined();
  });

  it("a malformed email is refused at the boundary on both sales", async () => {
    const cash = vi.spyOn(posUseCases, "recordCashSale");
    const card = vi.spyOn(posUseCases, "startPosSale");
    const caller = createCaller(posRouter as never).caller;
    await expect(
      caller.recordCashSale({
        eventId: EVENT_ID,
        clientKey: "client-key-1",
        items: [{ ticketTypeId: GA_ID, qty: 1 }],
        amountCollectedCents: 3000,
        buyerEmail: "nope",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.startSale({
        eventId: EVENT_ID,
        clientKey: "client-key-1",
        items: [{ ticketTypeId: GA_ID, qty: 1 }],
        buyerEmail: "nope",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(cash).not.toHaveBeenCalled();
    expect(card).not.toHaveBeenCalled();
  });
});
