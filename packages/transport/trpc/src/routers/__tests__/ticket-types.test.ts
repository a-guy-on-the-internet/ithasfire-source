import { beforeEach, describe, expect, it, vi } from "vitest";

import { fail } from "@th/errors";

import * as upsertTicketTypeModule from "@th/core/use-cases/ticket-types/upsert-ticket-type";
import * as updateTicketTypeModule from "@th/core/use-cases/ticket-types/update-ticket-type";

import { ticketTypesRouter } from "../ticket-types";
import { createCaller } from "./test-helpers";

const sampleInput = {
  eventId: "33333333-3333-4333-8333-333333333333",
  name: "VIP",
  description: "Very important ticket",
  priceCents: 5000,
  capacity: 50,
  clientKey: "ticket-type-key",
};

describe("ticketTypesRouter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards dependencies and actor human id to upsertTicketType", async () => {
    const upsertSpy = vi
      .spyOn(upsertTicketTypeModule, "upsertTicketType")
      .mockResolvedValue({
        ticketTypeId: "55555555-5555-4555-8555-555555555555",
        status: "ACTIVE",
      });

    const { caller, ctx } = createCaller(ticketTypesRouter);

    const result = await caller.upsertTicketType(sampleInput);

    expect(result).toEqual({
      ticketTypeId: "55555555-5555-4555-8555-555555555555",
      status: "ACTIVE",
    });
    expect(upsertSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: expect.anything(),
      }),
      expect.objectContaining({
        actorHumanId: ctx.actorHumanId,
        eventId: sampleInput.eventId,
        name: sampleInput.name,
        capacity: sampleInput.capacity,
      }),
    );
  });

  it("maps use case errors to TRPC errors", async () => {
    vi.spyOn(upsertTicketTypeModule, "upsertTicketType").mockRejectedValue({
      code: "invalid_input",
      message: "bad",
    });

    const { caller } = createCaller(ticketTypesRouter);

    await expect(caller.upsertTicketType(sampleInput)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "bad",
    });
  });

  it("rejects when actor human id is missing", async () => {
    const upsertSpy = vi
      .spyOn(upsertTicketTypeModule, "upsertTicketType")
      .mockResolvedValue({
        ticketTypeId: "55555555-5555-4555-8555-555555555555",
        status: "ACTIVE",
      });

    const overrides = {
      actorHumanId: null,
      auth: null,
      authToken: null,
    } as const;
    const { caller } = createCaller(ticketTypesRouter, overrides);

    await expect(caller.upsertTicketType(sampleInput)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("maps Stripe gating conflicts to TRPC errors", async () => {
    vi.spyOn(upsertTicketTypeModule, "upsertTicketType").mockRejectedValue({
      code: "conflict",
      message: "paid_ticketing_requires_stripe",
    });

    const { caller } = createCaller(ticketTypesRouter);

    await expect(caller.upsertTicketType(sampleInput)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "paid_ticketing_requires_stripe",
    });
  });
});

// ── Resale feature-gate clamp ────────────────────────────────────────────────
// The `resale` gate is default-OFF (env `ENABLE_RESALE` ?? false, DB override
// wins). While off, the client editor hides the resale controls — these tests
// pin the server-side belt-and-braces so a direct tRPC call can't configure
// resale either. Mirrors the resale-router gate tests' setup (no
// enableResale + no platformSettings repo → gate resolves OFF).
describe("ticketTypesRouter resale gate clamp", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const upsertOutput = {
    ticketTypeId: "55555555-5555-4555-8555-555555555555",
    status: "ACTIVE",
  } as const;

  const updateOutput = {
    ticketTypeId: "55555555-5555-4555-8555-555555555555",
    name: "VIP",
    priceCents: 5000,
    capacity: 50,
    status: "ACTIVE",
  } as const;

  const updateInput = {
    ticketTypeId: "55555555-5555-4555-8555-555555555555",
    name: "VIP (renamed)",
  };

  it("forces resaleAllowed=false / resaleCapCents=null on create when the gate is off (env default)", async () => {
    const spy = vi
      .spyOn(upsertTicketTypeModule, "upsertTicketType")
      .mockResolvedValue(upsertOutput);

    const { caller } = createCaller(ticketTypesRouter);

    await caller.upsertTicketType({
      ...sampleInput,
      resaleAllowed: true,
      resaleCapCents: 9900,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        resaleAllowed: false,
        resaleCapCents: null,
      }),
    );
  });

  it("passes resale fields through on create when the gate is on via env", async () => {
    const spy = vi
      .spyOn(upsertTicketTypeModule, "upsertTicketType")
      .mockResolvedValue(upsertOutput);

    const { caller } = createCaller(ticketTypesRouter, { enableResale: true });

    await caller.upsertTicketType({
      ...sampleInput,
      resaleAllowed: true,
      resaleCapCents: 9900,
    });

    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        resaleAllowed: true,
        resaleCapCents: 9900,
      }),
    );
  });

  it("honours a DB override turning resale on when env leaves it off (create passes through)", async () => {
    const spy = vi
      .spyOn(upsertTicketTypeModule, "upsertTicketType")
      .mockResolvedValue(upsertOutput);

    const { caller } = createCaller(ticketTypesRouter, {
      repos: {
        platformSettings: {
          getAll: vi
            .fn()
            .mockResolvedValue([{ key: "feature:resale", value: "true" }]),
        },
      } as any,
    });

    await caller.upsertTicketType({
      ...sampleInput,
      resaleAllowed: true,
      resaleCapCents: 9900,
    });

    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        resaleAllowed: true,
        resaleCapCents: 9900,
      }),
    );
  });

  it("drops incoming resaleAllowed=true on update when the gate is off (stored value preserved)", async () => {
    const spy = vi
      .spyOn(updateTicketTypeModule, "updateTicketType")
      .mockResolvedValue(updateOutput);

    const { caller } = createCaller(ticketTypesRouter);

    await caller.updateTicketType({
      ...updateInput,
      resaleAllowed: true,
      resaleCapCents: 5000,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const forwarded = spy.mock.calls[0]![1] as Record<string, unknown>;
    // The fields must be ABSENT (not false/null): the use case treats absent
    // as "no change" and the Prisma adapter skips undefined columns, so the
    // stored values — whether true or false — are preserved.
    expect(forwarded).not.toHaveProperty("resaleAllowed");
    expect(forwarded).not.toHaveProperty("resaleCapCents");
    expect(forwarded).toMatchObject({
      ticketTypeId: updateInput.ticketTypeId,
      name: updateInput.name,
    });
  });

  it("drops an incoming resaleAllowed=false on update too when the gate is off (never force-flips stored=true)", async () => {
    const spy = vi
      .spyOn(updateTicketTypeModule, "updateTicketType")
      .mockResolvedValue(updateOutput);

    const { caller } = createCaller(ticketTypesRouter);

    await caller.updateTicketType({
      ...updateInput,
      resaleAllowed: false,
      resaleCapCents: null,
    });

    const forwarded = spy.mock.calls[0]![1] as Record<string, unknown>;
    expect(forwarded).not.toHaveProperty("resaleAllowed");
    expect(forwarded).not.toHaveProperty("resaleCapCents");
  });

  it("passes resale fields through on update when the gate is on via env", async () => {
    const spy = vi
      .spyOn(updateTicketTypeModule, "updateTicketType")
      .mockResolvedValue(updateOutput);

    const { caller } = createCaller(ticketTypesRouter, { enableResale: true });

    await caller.updateTicketType({
      ...updateInput,
      resaleAllowed: true,
      resaleCapCents: 5000,
    });

    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        resaleAllowed: true,
        resaleCapCents: 5000,
      }),
    );
  });
});

// ── Sales lock ───────────────────────────────────────────────────────────────
// Both write paths refuse a locked edit with TICKET_TYPE_LOCKED_BY_SALES; the
// transport must surface it as a CONFLICT that still carries the app code the
// web copy (`errors.ticketTypeLockedBySales`) keys off.
describe("ticketTypesRouter sales lock", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const refuse = async (): Promise<never> =>
    fail("TICKET_TYPE_LOCKED_BY_SALES", { meta: { fields: ["priceCents"] } });

  it("maps a refused create to CONFLICT", async () => {
    vi.spyOn(upsertTicketTypeModule, "upsertTicketType").mockImplementation(
      refuse,
    );
    const { caller } = createCaller(ticketTypesRouter);

    await expect(caller.upsertTicketType(sampleInput)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "TICKET_TYPE_LOCKED_BY_SALES",
    });
  });

  it("maps a refused update to CONFLICT", async () => {
    vi.spyOn(updateTicketTypeModule, "updateTicketType").mockImplementation(
      refuse,
    );
    const { caller } = createCaller(ticketTypesRouter);

    await expect(
      caller.updateTicketType({
        ticketTypeId: "55555555-5555-4555-8555-555555555555",
        priceCents: 4500,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "TICKET_TYPE_LOCKED_BY_SALES",
    });
  });
});
