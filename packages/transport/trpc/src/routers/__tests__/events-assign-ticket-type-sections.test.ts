import { afterEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@th/errors";
import * as eventsUseCases from "@th/core/use-cases/events";

import type { Ctx } from "../../context";
import { t } from "../../trpc";
import { eventsRouter } from "../events";
import { createCaller } from "./test-helpers";

/**
 * `events.assignTicketTypeSections`: a thin transport. The use case runs the
 * stored seat price override gate (seat-price-overrides spec, step 7e), which
 * needs the clock for the fee-policy walk and the platform reporter for a
 * corrupt stored value, so both must reach it; its two refusals keep the
 * codes the tier editor and the override write already use.
 */

const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const TICKET_TYPE_ID = "44444444-4444-4444-8444-444444444444";
const SECTION_ID = "55555555-5555-4555-8555-555555555555";
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";

const INPUT = {
  eventId: EVENT_ID,
  assignments: [{ ticketTypeId: TICKET_TYPE_ID, seatSectionId: SECTION_ID }],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("events.assignTicketTypeSections", () => {
  it("passes the session's actor, the clock and the ctx reporter to the use case", async () => {
    const spy = vi
      .spyOn(eventsUseCases, "assignTicketTypeSections")
      .mockResolvedValue({ eventId: EVENT_ID, updated: 1 });
    const reportError = vi.fn();

    const out = await createCaller(eventsRouter, {
      reportError,
    } as unknown as Partial<Ctx>).caller.assignTicketTypeSections(INPUT);

    expect(out).toEqual({ eventId: EVENT_ID, updated: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
    const [deps, input] = spy.mock.calls[0]!;
    expect(input).toEqual({ ...INPUT, actorHumanId: ACTOR_ID });
    expect(deps.reportError).toBe(reportError);
    expect(deps.clock).toBeDefined();
    expect(deps.clock.now()).toBeInstanceOf(Date);
  });

  it("signed out is UNAUTHORIZED", async () => {
    const spy = vi.spyOn(eventsUseCases, "assignTicketTypeSections");
    await expect(
      createCaller(eventsRouter, {
        actorHumanId: null,
        auth: null,
      } as Partial<Ctx>).caller.assignTicketTypeSections(INPUT),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ["PAID_TICKETING_REQUIRES_STRIPE", "PRECONDITION_FAILED"],
    ["PAID_TICKETING_REQUIRES_FEE_POLICY", "PRECONDITION_FAILED"],
  ] as const)(
    "the stored-override gate's %s → %s, with the code kept for the client",
    async (appCode, trpcCode) => {
      vi.spyOn(eventsUseCases, "assignTicketTypeSections").mockRejectedValue(
        new AppError(appCode),
      );
      await expect(
        createCaller(eventsRouter).caller.assignTicketTypeSections(INPUT),
      ).rejects.toMatchObject({ code: trpcCode, message: appCode });
    },
  );

  it("the refusal's meta reaches the client: cause and the sections behind it", async () => {
    // What the use case attaches (`storedSeatPriceRefusalMeta`). The error
    // formatter copies a TRPCError's `meta` to the wire as `error.data.meta`
    // and the code as `error.data.appCode`, the path publish's
    // `seat_price_override_invalid` meta already takes.
    const meta = {
      cause: "stored_seat_price",
      seatSectionIds: [SECTION_ID],
      invalidSeatSectionIds: [],
    };
    vi.spyOn(eventsUseCases, "assignTicketTypeSections").mockRejectedValue(
      new AppError("PAID_TICKETING_REQUIRES_STRIPE", { meta }),
    );

    const err = await createCaller(eventsRouter)
      .caller.assignTicketTypeSections(INPUT)
      .catch((e: unknown) => e);

    expect(err).toMatchObject({ code: "PRECONDITION_FAILED" });
    expect((err as { meta?: unknown }).meta).toEqual({
      ...meta,
      appCode: "PAID_TICKETING_REQUIRES_STRIPE",
    });

    // `createCaller` never runs the errorFormatter: run the router's own, to
    // pin what the web client reads.
    const { data } = (
      t._config.errorFormatter as unknown as (opts: {
        shape: unknown;
        error: unknown;
      }) => { data: Record<string, unknown> }
    )({
      shape: {
        message: "x",
        code: -32012,
        data: { code: "PRECONDITION_FAILED", httpStatus: 412 },
      },
      error: err,
    });
    expect(data.appCode).toBe("PAID_TICKETING_REQUIRES_STRIPE");
    expect(data.meta).toEqual({
      ...meta,
      appCode: "PAID_TICKETING_REQUIRES_STRIPE",
    });
  });
});
