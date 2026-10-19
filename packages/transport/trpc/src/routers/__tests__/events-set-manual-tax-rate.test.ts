import { afterEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@th/errors";
import * as eventsUseCases from "@th/core/use-cases/events";

import type { Ctx } from "../../context";
import { eventsRouter } from "../events";
import { createCaller } from "./test-helpers";

/**
 * `events.setManualTaxRate` (owner ruling R5, spec 2026-10-07 FR-007): a thin
 * transport. The actor comes from the session, never the body; the platform
 * reporter is wired; the use case's refusals keep their codes and meta.
 */

const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("events.setManualTaxRate", () => {
  it("passes the session's actor and the ctx reporter to the use case", async () => {
    const spy = vi.spyOn(eventsUseCases, "setManualEventTaxRate").mockResolvedValue({
      eventId: EVENT_ID,
      admissionTaxRateBps: 925,
      taxRateSource: "manual:event",
      changed: true,
    });
    const reportError = vi.fn();
    const taxRateLookup = { lookupByPostalCode: vi.fn() };

    const out = await createCaller(eventsRouter, {
      reportError,
      taxRateLookup,
    } as unknown as Partial<Ctx>).caller.setManualTaxRate({
      eventId: EVENT_ID,
      rateBps: 925,
    });

    expect(out).toEqual({
      eventId: EVENT_ID,
      admissionTaxRateBps: 925,
      taxRateSource: "manual:event",
      changed: true,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const [deps, input] = spy.mock.calls[0]!;
    expect(input).toEqual({ eventId: EVENT_ID, rateBps: 925, actorHumanId: ACTOR_ID });
    expect(deps.reportError).toBe(reportError);
    // The entry-time lookup (is the provider actually failing?) needs it.
    expect(deps.taxRateLookup).toBe(taxRateLookup);
  });

  it("an actorHumanId in the body is refused (the actor is the session's)", async () => {
    const spy = vi.spyOn(eventsUseCases, "setManualEventTaxRate");
    await expect(
      createCaller(eventsRouter).caller.setManualTaxRate({
        eventId: EVENT_ID,
        rateBps: 925,
        actorHumanId: "33333333-3333-4333-8333-333333333333",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([-1, 2501, 9.25])("rateBps %s is refused at the boundary", async (rateBps) => {
    const spy = vi.spyOn(eventsUseCases, "setManualEventTaxRate");
    await expect(
      createCaller(eventsRouter).caller.setManualTaxRate({ eventId: EVENT_ID, rateBps }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("signed out is UNAUTHORIZED", async () => {
    await expect(
      createCaller(eventsRouter, {
        actorHumanId: null,
        auth: null,
      } as Partial<Ctx>).caller.setManualTaxRate({ eventId: EVENT_ID, rateBps: 925 }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("MANUAL_TAX_RATE_NOT_ALLOWED → CONFLICT with its reason", async () => {
    vi.spyOn(eventsUseCases, "setManualEventTaxRate").mockRejectedValue(
      new AppError("MANUAL_TAX_RATE_NOT_ALLOWED", { meta: { reason: "rate_resolved" } }),
    );
    const err = await createCaller(eventsRouter)
      .caller.setManualTaxRate({ eventId: EVENT_ID, rateBps: 925 })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "CONFLICT" });
    expect((err as { meta?: unknown }).meta).toEqual({
      reason: "rate_resolved",
      appCode: "MANUAL_TAX_RATE_NOT_ALLOWED",
    });
  });

  it("runs the real use case: a Scanner is FORBIDDEN", async () => {
    const tx = {
      events: {
        getById: vi.fn(async () => ({
          id: EVENT_ID,
          orgId: "org-1",
          status: "PUBLISHED",
          admissionTaxRateBps: null,
          taxRateSource: null,
          placeId: null,
          savedLocationId: null,
          postalCode: "37203",
          countryCode: "US",
        })),
        lockRows: vi.fn(),
        updateTaxRate: vi.fn(),
      },
      authz: {
        getOrgMembership: vi.fn(async () => ({
          orgId: "org-1",
          humanId: ACTOR_ID,
          role: "SCANNER",
        })),
      },
      audit: { log: vi.fn() },
    };
    const repos = {
      ...tx,
      tx: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    } as unknown as Ctx["repos"];

    await expect(
      createCaller(eventsRouter, { repos } as Partial<Ctx>).caller.setManualTaxRate({
        eventId: EVENT_ID,
        rateBps: 925,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tx.events.updateTaxRate).not.toHaveBeenCalled();
    expect(tx.events.lockRows).not.toHaveBeenCalled();
  });
});
