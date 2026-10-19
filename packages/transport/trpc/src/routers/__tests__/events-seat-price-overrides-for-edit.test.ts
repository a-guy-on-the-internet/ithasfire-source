import { afterEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@th/errors";
import * as eventsUseCases from "@th/core/use-cases/events";

import type { Ctx } from "../../context";
import { eventsRouter } from "../events";
import { createCaller } from "./test-helpers";

/**
 * `events.listEventSeatPriceOverridesForEdit`: the override editor's read. A
 * thin transport: the actor comes from the session, never the body; the
 * platform reporter is wired; the use case's refusals keep the write's codes.
 */

const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";

const EMPTY = { eventId: EVENT_ID, editable: true, sections: [] };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("events.listEventSeatPriceOverridesForEdit", () => {
  it("passes the session's actor, the clock and the ctx reporter to the use case", async () => {
    const spy = vi
      .spyOn(eventsUseCases, "listEventSeatPriceOverridesForEdit")
      .mockResolvedValue(EMPTY);
    const reportError = vi.fn();

    const out = await createCaller(eventsRouter, {
      reportError,
    } as unknown as Partial<Ctx>).caller.listEventSeatPriceOverridesForEdit({
      eventId: EVENT_ID,
    });

    expect(out).toEqual(EMPTY);
    expect(spy).toHaveBeenCalledTimes(1);
    const [deps, input] = spy.mock.calls[0]!;
    expect(input).toEqual({ eventId: EVENT_ID, actorHumanId: ACTOR_ID });
    expect(deps.reportError).toBe(reportError);
    expect(deps.clock).toBeDefined();
  });

  it("an actorHumanId in the body is refused (the actor is the session's)", async () => {
    const spy = vi.spyOn(eventsUseCases, "listEventSeatPriceOverridesForEdit");
    await expect(
      createCaller(eventsRouter).caller.listEventSeatPriceOverridesForEdit({
        eventId: EVENT_ID,
        actorHumanId: "33333333-3333-4333-8333-333333333333",
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("signed out is UNAUTHORIZED", async () => {
    const spy = vi.spyOn(eventsUseCases, "listEventSeatPriceOverridesForEdit");
    await expect(
      createCaller(eventsRouter, {
        actorHumanId: null,
        auth: null,
      } as Partial<Ctx>).caller.listEventSeatPriceOverridesForEdit({
        eventId: EVENT_ID,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ["INSUFFICIENT_ROLE", "FORBIDDEN"],
    ["NOT_RESOURCE_OWNER", "FORBIDDEN"],
    ["EVENT_NOT_FOUND", "NOT_FOUND"],
  ] as const)("%s → %s, as the write maps it", async (appCode, trpcCode) => {
    vi.spyOn(
      eventsUseCases,
      "listEventSeatPriceOverridesForEdit",
    ).mockRejectedValue(new AppError(appCode));
    await expect(
      createCaller(eventsRouter).caller.listEventSeatPriceOverridesForEdit({
        eventId: EVENT_ID,
      }),
    ).rejects.toMatchObject({ code: trpcCode });
  });

  it("runs the real use case: a VIEWER of the organizing org is FORBIDDEN and no seat is read", async () => {
    const repos = {
      events: {
        getById: vi.fn(async () => ({
          id: EVENT_ID,
          orgId: "org-1",
          humanId: null,
          status: "DRAFT",
        })),
        listTicketTypes: vi.fn(),
      },
      seats: {
        listSectionsByEvent: vi.fn(),
        listPriceOverridesByEvent: vi.fn(),
      },
      placeLayouts: { getById: vi.fn() },
      authz: {
        getOrgMembership: vi.fn(async () => ({
          orgId: "org-1",
          humanId: ACTOR_ID,
          role: "VIEWER",
        })),
        getHumanDelegation: vi.fn(),
      },
    } as unknown as Ctx["repos"];

    await expect(
      createCaller(eventsRouter, {
        repos,
      } as Partial<Ctx>).caller.listEventSeatPriceOverridesForEdit({
        eventId: EVENT_ID,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      (repos as unknown as { seats: { listPriceOverridesByEvent: unknown } })
        .seats.listPriceOverridesByEvent,
    ).not.toHaveBeenCalled();
  });
});
