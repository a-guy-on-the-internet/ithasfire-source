import { afterEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@th/errors";
import * as eventsUseCases from "@th/core/use-cases/events";

import type { Ctx } from "../../context";
import { toTrpcError } from "../../utils";
import { eventsRouter } from "../events";
import { createCaller as createCallerFromHelpers } from "./test-helpers";

/**
 * Owner ruling 2026-10-06: a buyer-facing quote never shows 0% for a venue
 * whose tax rate is unknown. The two quote procedures hand the use case a
 * lookup (provider + repos + search + reporter) so it can fill the venue cache
 * once; a failed lookup surfaces as TAX_RATE_UNAVAILABLE → 503, retryable.
 */

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const TIER_ID = "44444444-4444-4444-8444-444444444444";

const openEventRepos = (): Ctx["repos"] =>
  ({
    events: {
      getById: vi.fn(async (id: string) =>
        id === EVENT_ID
          ? {
              id: EVENT_ID,
              orgId: "org-1",
              humanId: null,
              gateType: "NONE",
              visibility: "PUBLIC",
              status: "PUBLISHED",
              publishedAt: new Date("2025-12-01T00:00:00.000Z"),
              stewardship: "OWNED",
              passwordHash: null,
              waitlistStatus: "DISABLED",
              waitlistPublishAt: null,
              waitlistDescription: null,
              waitlistCap: null,
            }
          : null,
      ),
    },
    authz: { getOrgMembership: vi.fn() },
    eventUnlocks: { isUnlocked: vi.fn(async () => false) },
  }) as unknown as Ctx["repos"];

const buildCtx = () => {
  const repos = openEventRepos();
  const taxRateLookup = { lookupByPostalCode: vi.fn() };
  const multiSearch = { upsertDocuments: vi.fn(), deleteDocuments: vi.fn() };
  const reportError = vi.fn();
  return {
    repos,
    taxRateLookup,
    multiSearch,
    reportError,
  } as unknown as Partial<Ctx> & {
    repos: Ctx["repos"];
    taxRateLookup: unknown;
    multiSearch: unknown;
    reportError: unknown;
  };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("events quote procedures — tax lookup wiring", () => {
  it("getCheckoutFeeRates passes a tax lookup built from ctx", async () => {
    const spy = vi
      .spyOn(eventsUseCases, "getCheckoutFeeRates")
      .mockRejectedValue(new AppError("TAX_RATE_UNAVAILABLE"));
    const ctx = buildCtx();

    await expect(
      createCallerFromHelpers(eventsRouter, ctx).caller.getCheckoutFeeRates({
        eventId: EVENT_ID,
      }),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });

    expect(spy).toHaveBeenCalledTimes(1);
    const deps = spy.mock.calls[0]![0];
    expect(deps.taxLookup).toMatchObject({
      taxRateLookup: ctx.taxRateLookup,
      repos: ctx.repos,
      search: ctx.multiSearch,
    });
    // A per-venue negative cache rides along.
    expect(deps.taxLookup?.cooldown).toBeDefined();
  });

  it("the quote reporter is THROTTLED and, with the cooldown, shared across requests", async () => {
    const spy = vi
      .spyOn(eventsUseCases, "getCheckoutFeeRates")
      .mockRejectedValue(new AppError("TAX_RATE_UNAVAILABLE"));
    const ctx = buildCtx();
    const call = () =>
      createCallerFromHelpers(eventsRouter, ctx)
        .caller.getCheckoutFeeRates({ eventId: EVENT_ID })
        .catch(() => undefined);

    await call();
    await call();

    const first = spy.mock.calls[0]![0].taxLookup!;
    const second = spy.mock.calls[1]![0].taxLookup!;
    // Memoized per process: the same window and negative cache every request.
    expect(second.cooldown).toBe(first.cooldown);
    expect(second.reportError).toBe(first.reportError);
    expect(first.reportError).not.toBe(ctx.reportError);

    const err = new Error("ziptax 108");
    const context = { tags: { useCase: "lookupAdmissionTaxRate" } };
    first.reportError!(err, context);
    second.reportError!(err, context);
    // One Sentry event per window, not one per page view.
    expect(ctx.reportError).toHaveBeenCalledTimes(1);
    expect(ctx.reportError).toHaveBeenCalledWith(err, context);
  });

  it("getEventFeePreview (the builder) passes the same quote lookup", async () => {
    const spy = vi
      .spyOn(eventsUseCases, "getEventFeePreview")
      .mockRejectedValue(new AppError("EVENT_NOT_FOUND"));
    const ctx = {
      ...buildCtx(),
      actorHumanId: "33333333-3333-4333-8333-333333333333",
    };

    await createCallerFromHelpers(eventsRouter, ctx)
      .caller.getEventFeePreview({ eventId: EVENT_ID })
      .catch(() => undefined);

    expect(spy).toHaveBeenCalledTimes(1);
    const deps = spy.mock.calls[0]![0];
    expect(deps.taxLookup).toMatchObject({
      taxRateLookup: ctx.taxRateLookup,
      repos: ctx.repos,
    });
    expect(deps.taxLookup?.cooldown).toBeDefined();
  });

  it("estimateCheckoutTax passes the same lookup; no provider → null, not undefined", async () => {
    const spy = vi
      .spyOn(eventsUseCases, "estimateCheckoutTax")
      .mockRejectedValue(new AppError("TAX_RATE_UNAVAILABLE"));
    const ctx = buildCtx();
    delete (ctx as Record<string, unknown>).taxRateLookup;

    await expect(
      createCallerFromHelpers(eventsRouter, ctx).caller.estimateCheckoutTax({
        eventId: EVENT_ID,
        items: [{ ticketTypeId: TIER_ID, qty: 1 }],
      }),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });

    const deps = spy.mock.calls[0]![0];
    expect(deps.taxLookup).toMatchObject({
      taxRateLookup: null,
      repos: ctx.repos,
    });
  });
});

describe("TAX_RATE_UNAVAILABLE on the wire", () => {
  it("maps to SERVICE_UNAVAILABLE and keeps its app code", () => {
    const err = toTrpcError(new AppError("TAX_RATE_UNAVAILABLE"));
    expect(err.code).toBe("SERVICE_UNAVAILABLE");
  });
});
