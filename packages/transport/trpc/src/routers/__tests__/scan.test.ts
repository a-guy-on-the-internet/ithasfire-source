import { beforeEach, describe, expect, it, vi } from "vitest";

import * as scanningUseCases from "@th/core/use-cases/scanning";
import * as ticketsUseCases from "@th/core/use-cases/tickets/search-org-tickets";
import * as volunteeringUseCases from "@th/core/use-cases/volunteering";
import { scanRouter } from "../scan";
import { createCaller } from "./test-helpers";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";

const createScanCaller = (ctxOverrides?: Parameters<typeof createCaller>[1]) =>
  createCaller(scanRouter, ctxOverrides);

describe("scanRouter.resolvePayload", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("injects actorHumanId from ctx and forwards deps to the use case", async () => {
    const expected = { kind: "unknown", reason: "malformed" } as const;
    const spy = vi
      .spyOn(scanningUseCases, "resolveScanPayload")
      .mockResolvedValue(expected as any);

    const { caller, ctx } = createScanCaller({ actorHumanId: ACTOR_ID });
    const result = await caller.resolvePayload({
      eventId: EVENT_ID,
      raw: "anything",
    });

    expect(result).toEqual(expected);
    expect(spy).toHaveBeenCalledTimes(1);
    const [deps, input] = spy.mock.calls[0]!;
    expect(deps.repos).toBe(ctx.repos);
    expect(deps.clock).toBe(ctx.clock);
    expect(deps.volunteerScanToken).toBeDefined(); // unconfigured fallback
    expect(input).toEqual({
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      raw: "anything",
    });
  });

  it("rejects when the input fails Zod validation (raw too long)", async () => {
    vi.spyOn(scanningUseCases, "resolveScanPayload").mockResolvedValue({
      kind: "unknown",
      reason: "malformed",
    } as any);
    const { caller } = createScanCaller({ actorHumanId: ACTOR_ID });

    await expect(
      caller.resolvePayload({ eventId: EVENT_ID, raw: "x".repeat(4097) }),
    ).rejects.toThrowError(/too_big|too big|maximum/i);
  });

  it("rejects unauthenticated callers (no actorHumanId)", async () => {
    const { caller } = createScanCaller({ actorHumanId: null });

    await expect(
      caller.resolvePayload({ eventId: EVENT_ID, raw: "ABC123" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("maps use-case errors via toTrpcError (forbidden → FORBIDDEN)", async () => {
    vi.spyOn(scanningUseCases, "resolveScanPayload").mockRejectedValue({
      code: "forbidden",
      message: "no_membership",
    });
    const { caller } = createScanCaller({ actorHumanId: ACTOR_ID });

    await expect(
      caller.resolvePayload({ eventId: EVENT_ID, raw: "ABC123" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("scanRouter.searchUnified", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fans out to searchOrgTickets and searchVolunteerSignupsForCheckIn in parallel", async () => {
    const event = {
      id: EVENT_ID,
      orgId: ORG_ID,
      humanId: null,
      title: "Test",
      status: "PUBLISHED",
      visibility: "PUBLIC",
      startsAt: new Date("2026-01-01T00:00:00Z"),
      endsAt: new Date("2026-01-02T00:00:00Z"),
    };
    const reposEvents = { getById: vi.fn(async () => event) };
    const ticketsResult = {
      items: [],
      pagination: { limit: 20, offset: 0, total: 0, hasMore: false },
    };
    const volunteersResult: any[] = [];

    const ticketsSpy = vi
      .spyOn(ticketsUseCases, "searchOrgTickets")
      .mockResolvedValue(ticketsResult as any);
    const volunteersSpy = vi
      .spyOn(volunteeringUseCases, "searchVolunteerSignupsForCheckIn")
      .mockResolvedValue(volunteersResult as any);

    const { caller } = createScanCaller({
      actorHumanId: ACTOR_ID,
      repos: { events: reposEvents } as any,
    });

    const result = await caller.searchUnified({
      eventId: EVENT_ID,
      query: "rosen",
    });

    expect(result).toEqual({
      tickets: ticketsResult,
      volunteers: volunteersResult,
    });

    expect(ticketsSpy).toHaveBeenCalledTimes(1);
    expect(volunteersSpy).toHaveBeenCalledTimes(1);
    expect(ticketsSpy.mock.calls[0]![1]).toMatchObject({
      actorHumanId: ACTOR_ID,
      orgId: ORG_ID,
      query: "rosen",
    });
    expect(volunteersSpy.mock.calls[0]![1]).toMatchObject({
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      query: "rosen",
    });
  });

  it("rejects when query is empty", async () => {
    const { caller } = createScanCaller({ actorHumanId: ACTOR_ID });
    await expect(
      caller.searchUnified({ eventId: EVENT_ID, query: "" }),
    ).rejects.toThrowError(/too_small|min|too small/i);
  });

  it("returns NOT_FOUND when the event is missing or unscoped", async () => {
    const reposEvents = { getById: vi.fn(async () => null) };
    const { caller } = createScanCaller({
      actorHumanId: ACTOR_ID,
      repos: { events: reposEvents } as any,
    });

    await expect(
      caller.searchUnified({ eventId: EVENT_ID, query: "anything" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects unauthenticated callers", async () => {
    const { caller } = createScanCaller({ actorHumanId: null });
    await expect(
      caller.searchUnified({ eventId: EVENT_ID, query: "rosen" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
