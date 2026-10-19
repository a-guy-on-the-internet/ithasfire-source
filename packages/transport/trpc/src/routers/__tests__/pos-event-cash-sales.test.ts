import { afterEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@th/errors";
import * as posUseCases from "@th/core/use-cases/pos";

import type { Ctx } from "../../context";
import { posRouter } from "../pos";
import { createCaller } from "./test-helpers";

/**
 * `pos.eventCashSales`: the Sell screen's list of an event's cash sales
 * (owner ruling 2026-10-08). Thin transport: the actor comes from the
 * session, never the body; the output schema strips anything the use case
 * did not declare; refusals keep their codes.
 */

const ORG_ID = "11111111-1111-4111-8111-1111111111aa";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const ORDER_ID = "55555555-5555-4555-8555-555555555555";
const SOLD_AT = new Date("2026-10-07T21:00:00.000Z");
const UNTIL = new Date("2026-10-14T23:00:00.000Z");

const OUT = {
  items: [
    {
      orderId: ORDER_ID,
      soldAt: SOLD_AT,
      ticketCount: 2,
      amountPaidCents: 5872,
      promoCode: null,
      isComp: false,
      isFreeWithCode: false,
      status: "SUCCEEDED" as const,
      refundedAt: null,
    },
  ],
  nextCursor: null,
  refundableUntil: UNTIL,
  canRefund: true,
  refundWindowApplies: true,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pos.eventCashSales", () => {
  it("passes the session's actor and the page request to the use case", async () => {
    const spy = vi
      .spyOn(posUseCases, "listEventCashSales")
      .mockResolvedValue(OUT);
    const { caller, ctx } = createCaller(posRouter as never);

    const out = await caller.eventCashSales({
      orgId: ORG_ID,
      eventId: EVENT_ID,
      cursor: "c",
      limit: 10,
    });

    expect(out).toEqual(OUT);
    const [deps, input] = spy.mock.calls[0]!;
    expect(input).toEqual({
      orgId: ORG_ID,
      eventId: EVENT_ID,
      cursor: "c",
      limit: 10,
      actorHumanId: ACTOR_ID,
    });
    expect(deps.repos).toBe(ctx.repos);
    expect(deps.authz).toBe(ctx.authz);
  });

  it("an actorHumanId in the body is refused", async () => {
    const spy = vi.spyOn(posUseCases, "listEventCashSales");
    await expect(
      createCaller(posRouter as never).caller.eventCashSales({
        orgId: ORG_ID,
        eventId: EVENT_ID,
        actorHumanId: "44444444-4444-4444-8444-444444444444",
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("signed out is UNAUTHORIZED", async () => {
    await expect(
      createCaller(posRouter as never, {
        actorHumanId: null,
        auth: null,
      } as Partial<Ctx>).caller.eventCashSales({
        orgId: ORG_ID,
        eventId: EVENT_ID,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("strips a field the output schema does not declare", async () => {
    vi.spyOn(posUseCases, "listEventCashSales").mockResolvedValue({
      ...OUT,
      items: [{ ...OUT.items[0]!, buyerEmail: "buyer@example.com" }],
    } as never);

    const out = await createCaller(posRouter as never).caller.eventCashSales({
      orgId: ORG_ID,
      eventId: EVENT_ID,
    });

    expect(out.items[0]).not.toHaveProperty("buyerEmail");
  });

  it.each([
    ["INSUFFICIENT_ROLE", "FORBIDDEN"],
    ["EVENT_NOT_FOUND", "NOT_FOUND"],
  ] as const)("%s maps to %s", async (appCode, trpcCode) => {
    vi.spyOn(posUseCases, "listEventCashSales").mockRejectedValue(
      new AppError(appCode),
    );

    await expect(
      createCaller(posRouter as never).caller.eventCashSales({
        orgId: ORG_ID,
        eventId: EVENT_ID,
      }),
    ).rejects.toMatchObject({ code: trpcCode });
  });
});
