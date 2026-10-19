import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import { TaxRateLookupError } from "@th/ports/tax-rate-lookup";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import {
  MANUAL_EVENT_TAX_RATE_MAX_BPS,
  MANUAL_EVENT_TAX_RATE_SOURCE,
} from "../../../lib/tax/manual-event-tax-rate";
import {
  MANUAL_STAMP_RELOOKUP_BUDGET_MS,
  TAX_LOOKUP_RETRY_BUDGET_MS,
} from "../../orders/_shared/resolve-checkout-tax-rate";
import { setManualEventTaxRate } from "../set-manual-event-tax-rate";

/**
 * `setManualEventTaxRate` (owner ruling R5, spec 2026-10-07 FR-007): who may
 * enter a rate by hand, on which events, within which bounds, and what it
 * records and reports.
 */

const EVENT_ID = "e0000000-0000-4000-8000-000000000001";
const ORG_ID = "a0000000-0000-4000-8000-000000000001";
const OTHER_ORG_ID = "a0000000-0000-4000-8000-000000000002";
const ACTOR_ID = "b0000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-07T21:00:00.000Z");

type Role = "OWNER" | "ADMIN" | "EDITOR" | "FINANCE" | "VIEWER" | "SCANNER";

type EventState = {
  id: string;
  orgId: string | null;
  humanId: string | null;
  status: string;
  admissionTaxRateBps: number | null;
  taxRateSource: string | null;
  placeId: string | null;
  savedLocationId: string | null;
  postalCode: string | null;
  countryCode: string | null;
  region: string | null;
  updatedAt: Date;
};

function makeWorld(
  opts: {
    role?: Role | null;
    /** The org the actor is a member of. Default: the event's org. */
    memberOf?: string;
    event?: Partial<EventState> | null;
    /**
     * The tax provider. Default: failing (ZipTax rate limit), the only state
     * in which entry is allowed. `null` = no provider configured.
     */
    lookup?: ReturnType<typeof vi.fn> | null;
    /** The venue row behind `placeId`, with its cached rate. */
    place?: Record<string, unknown> | null;
  } = {},
) {
  const event: EventState | null =
    opts.event === null
      ? null
      : {
          id: EVENT_ID,
          orgId: ORG_ID,
          humanId: null,
          status: "PUBLISHED",
          admissionTaxRateBps: null,
          taxRateSource: null,
          placeId: null,
          savedLocationId: null,
          postalCode: "37203",
          countryCode: "US",
          region: "TN",
          updatedAt: new Date("2026-10-01T00:00:00.000Z"),
          ...opts.event,
        };
  const role = opts.role === undefined ? "EDITOR" : opts.role;
  const memberOf = opts.memberOf ?? ORG_ID;
  const calls: string[] = [];
  const lookupByPostalCode =
    opts.lookup === undefined
      ? vi.fn(async () => {
          throw new TaxRateLookupError(
            "Ziptax rCode 108 (RESPONSE_CODE_REQUEST_LIMIT_MET)",
            { providerCode: 108, httpStatus: 429 },
          );
        })
      : opts.lookup;
  const taxRateLookup = lookupByPostalCode
    ? {
        lookupByPostalCode: vi.fn(async (...args: unknown[]) => {
          calls.push("lookup");
          return lookupByPostalCode(...args);
        }),
      }
    : null;

  const tx = {
    events: {
      getById: vi.fn(async (id: string) =>
        event && id === event.id ? { ...event } : null,
      ),
      lockRows: vi.fn(async (input: { ids: string[]; mode: string }) => {
        calls.push(`lock:${input.mode}`);
      }),
      updateTaxRate: vi.fn(
        async (input: {
          admissionTaxRateBps: number | null;
          taxRateSource: string | null;
        }) => {
          calls.push("updateTaxRate");
          event!.admissionTaxRateBps = input.admissionTaxRateBps;
          event!.taxRateSource = input.taxRateSource;
        },
      ),
    },
    authz: {
      getOrgMembership: vi.fn(
        async (input: { orgId: string; humanId: string }) =>
          role && input.orgId === memberOf && input.humanId === ACTOR_ID
            ? { orgId: input.orgId, humanId: ACTOR_ID, role }
            : null,
      ),
    },
    audit: {
      log: vi.fn(async () => {
        calls.push("audit");
      }),
    },
    searchReindexPending: {
      mark: vi.fn(async () => {
        calls.push("mark");
      }),
    },
    places: {
      getById: vi.fn(async () => opts.place ?? null),
    },
    savedLocations: { getById: vi.fn(async () => null) },
  };
  const repos = {
    ...tx,
    tx: async <T>(fn: (t: TxRepos) => Promise<T>) => {
      calls.push("tx");
      return fn(tx as unknown as TxRepos);
    },
  } as unknown as Repos;
  const reportError = vi.fn();
  const logger = createTestLogger();
  const deps = {
    repos,
    clock: { now: () => NOW },
    logger,
    reportError,
    taxRateLookup: taxRateLookup as never,
  };
  return { event, tx, deps, reportError, calls, taxRateLookup };
}

const input = (rateBps: unknown) => ({
  actorHumanId: ACTOR_ID,
  eventId: EVENT_ID,
  rateBps,
});

describe("setManualEventTaxRate — who", () => {
  it.each(["OWNER", "ADMIN", "EDITOR"] as const)("%s of the event's org may enter it", async (role) => {
    const w = makeWorld({ role });
    const out = await setManualEventTaxRate(w.deps, input(925));
    expect(out).toEqual({
      eventId: EVENT_ID,
      admissionTaxRateBps: 925,
      taxRateSource: MANUAL_EVENT_TAX_RATE_SOURCE,
      changed: true,
    });
  });

  it.each(["SCANNER", "FINANCE", "VIEWER"] as const)(
    "%s is refused, and nothing is locked, written or reported",
    async (role) => {
      const w = makeWorld({ role });
      await expect(setManualEventTaxRate(w.deps, input(925))).rejects.toMatchObject({
        code: "INSUFFICIENT_ROLE",
      });
      expect(w.calls).toEqual([]);
      expect(w.reportError).not.toHaveBeenCalled();
    },
  );

  it("an Editor of ANOTHER org is refused", async () => {
    const w = makeWorld({ role: "EDITOR", memberOf: OTHER_ORG_ID });
    await expect(setManualEventTaxRate(w.deps, input(925))).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
    expect(w.calls).toEqual([]);
    expect(w.event!.admissionTaxRateBps).toBeNull();
  });

  it("a stranger is refused", async () => {
    const w = makeWorld({ role: null });
    await expect(setManualEventTaxRate(w.deps, input(925))).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
  });

  it("a personal (no-org) event is refused: the door sells org events only", async () => {
    const w = makeWorld({ event: { orgId: null, humanId: ACTOR_ID } });
    await expect(setManualEventTaxRate(w.deps, input(925))).rejects.toMatchObject({
      code: "EVENT_NOT_ORG_OWNED",
    });
    expect(w.calls).toEqual([]);
  });

  it("a missing event is EVENT_NOT_FOUND", async () => {
    const w = makeWorld({ event: null });
    await expect(setManualEventTaxRate(w.deps, input(925))).rejects.toMatchObject({
      code: "EVENT_NOT_FOUND",
    });
  });
});

describe("setManualEventTaxRate — bounds (basis points, 0 to 25%)", () => {
  it.each([
    ["negative", -1],
    ["above 25%", MANUAL_EVENT_TAX_RATE_MAX_BPS + 1],
    ["a percent typed as basis points by 100x (92.5%)", 9250],
    ["a fraction of a basis point", 9.25],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a string", "925"],
    ["null", null],
  ])("%s is refused as invalid input, nothing written", async (_name, rate) => {
    const w = makeWorld();
    await expect(setManualEventTaxRate(w.deps, input(rate))).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(w.calls).toEqual([]);
    expect(w.reportError).not.toHaveBeenCalled();
  });

  it.each([0, 1, MANUAL_EVENT_TAX_RATE_MAX_BPS])("%i bps is accepted", async (rate) => {
    const w = makeWorld();
    const out = await setManualEventTaxRate(w.deps, input(rate));
    expect(out.admissionTaxRateBps).toBe(rate);
    expect(w.event!.admissionTaxRateBps).toBe(rate);
  });

  it("an extra field is refused (.strict)", async () => {
    const w = makeWorld();
    await expect(
      setManualEventTaxRate(w.deps, { ...input(925), taxRateSource: "ziptax" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("setManualEventTaxRate — which events", () => {
  it.each(["DRAFT", "CANCELLED", "COMPLETED", "ARCHIVED"])(
    "a %s event is refused (the door sells published events only), nothing written",
    async (status) => {
      const w = makeWorld({ event: { status } });
      await expect(setManualEventTaxRate(w.deps, input(925))).rejects.toMatchObject({
        code: "EVENT_NOT_PUBLISHED",
        meta: { status },
      });
      expect(w.tx.events.updateTaxRate).not.toHaveBeenCalled();
      expect(w.reportError).not.toHaveBeenCalled();
    },
  );

  it("an event the provider already rated is refused: a person never overrides a looked-up rate", async () => {
    const w = makeWorld({
      event: { admissionTaxRateBps: 975, taxRateSource: "ziptax" },
    });
    await expect(setManualEventTaxRate(w.deps, input(500))).rejects.toMatchObject({
      code: "MANUAL_TAX_RATE_NOT_ALLOWED",
      meta: { reason: "rate_resolved" },
    });
    expect(w.event!.admissionTaxRateBps).toBe(975);
    expect(w.event!.taxRateSource).toBe("ziptax");
  });

  it("a TN instruction exemption (0 / exempt) is a resolved rate too", async () => {
    const w = makeWorld({
      event: { admissionTaxRateBps: 0, taxRateSource: "exempt:tn-instruction" },
    });
    await expect(setManualEventTaxRate(w.deps, input(975))).rejects.toMatchObject({
      code: "MANUAL_TAX_RATE_NOT_ALLOWED",
      meta: { reason: "rate_resolved" },
    });
  });

  it("an event with no tax location is refused: its lookup can never fail", async () => {
    const w = makeWorld({
      event: { postalCode: null, countryCode: null, region: null },
    });
    await expect(setManualEventTaxRate(w.deps, input(925))).rejects.toMatchObject({
      code: "MANUAL_TAX_RATE_NOT_ALLOWED",
      meta: { reason: "no_location" },
    });
  });

  it("decides on the row read under FOR UPDATE: a provider stamp that landed before the lock wins", async () => {
    const w = makeWorld();
    // The first (unlocked) read sees no stamp; the provider's lands, then the
    // lock is taken and the row re-read.
    w.tx.events.lockRows.mockImplementationOnce(async () => {
      w.event!.admissionTaxRateBps = 975;
      w.event!.taxRateSource = "ziptax";
    });
    await expect(setManualEventTaxRate(w.deps, input(500))).rejects.toMatchObject({
      code: "MANUAL_TAX_RATE_NOT_ALLOWED",
    });
    expect(w.event!.admissionTaxRateBps).toBe(975);
  });
});

describe("setManualEventTaxRate — what it records and reports", () => {
  it("stamps rate + manual source under a row lock, records who and when on an audit row, and alerts the platform once", async () => {
    const w = makeWorld();

    await setManualEventTaxRate(w.deps, input(925));

    // The lookup runs BEFORE the transaction (NFR-002); the reindex mark is
    // written in the same transaction as the stamp.
    expect(w.calls).toEqual(["lookup", "tx", "lock:update", "updateTaxRate", "audit", "mark"]);
    expect(w.tx.searchReindexPending.mark).toHaveBeenCalledWith(
      [{ entityType: "event", entityId: EVENT_ID }],
      NOW,
    );
    expect(w.event!.admissionTaxRateBps).toBe(925);
    expect(w.event!.taxRateSource).toBe("manual:event");
    expect(w.tx.audit.log).toHaveBeenCalledWith({
      entity: "event",
      entityId: EVENT_ID,
      action: "event_manual_tax_rate_set",
      data: {
        eventId: EVENT_ID,
        orgId: ORG_ID,
        actorHumanId: ACTOR_ID,
        rateBps: 925,
        previousRateBps: null,
        previousSource: null,
      },
      at: NOW,
    });
    expect(w.reportError).toHaveBeenCalledTimes(1);
    const [err, ctx] = w.reportError.mock.calls[0]!;
    expect((err as Error).message).toBe("manual_tax_rate_entered");
    expect(ctx).toEqual({
      tags: {
        area: "tax",
        kind: "manual_rate_entered",
        useCase: "setManualEventTaxRate",
      },
      extra: {
        eventId: EVENT_ID,
        orgId: ORG_ID,
        rateBps: 925,
        previousManualRateBps: null,
        actorHumanId: ACTOR_ID,
        enteredAt: NOW.toISOString(),
        lookupProviderCode: 108,
        lookupHttpStatus: 429,
        lookupBudgetExhausted: false,
      },
    });
  });

  it("the SAME manual rate again is a no-op: no lookup, no write, no audit row, no report", async () => {
    const w = makeWorld({
      event: { admissionTaxRateBps: 925, taxRateSource: MANUAL_EVENT_TAX_RATE_SOURCE },
    });
    const out = await setManualEventTaxRate(w.deps, input(925));
    expect(out.changed).toBe(false);
    expect(w.calls).toEqual([]);
    expect(w.tx.events.updateTaxRate).not.toHaveBeenCalled();
    expect(w.tx.audit.log).not.toHaveBeenCalled();
    expect(w.reportError).not.toHaveBeenCalled();
  });

  it("a DIFFERENT manual rate replaces the earlier one, recorded and reported with the previous rate", async () => {
    const w = makeWorld({
      event: { admissionTaxRateBps: 925, taxRateSource: MANUAL_EVENT_TAX_RATE_SOURCE },
    });
    const out = await setManualEventTaxRate(w.deps, input(950));
    expect(out.changed).toBe(true);
    expect(w.event!.admissionTaxRateBps).toBe(950);
    expect(w.tx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rateBps: 950,
          previousRateBps: 925,
          previousSource: "manual:event",
        }),
      }),
    );
    expect(w.reportError.mock.calls[0]![1]).toMatchObject({
      extra: { rateBps: 950, previousManualRateBps: 925 },
    });
  });

  it("a reporter that throws changes nothing: the rate is stamped and the result returned", async () => {
    const w = makeWorld();
    w.reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });
    const out = await setManualEventTaxRate(w.deps, input(925));
    expect(out.changed).toBe(true);
    expect(w.event!.admissionTaxRateBps).toBe(925);
  });

  it("with no reporter wired it still stamps", async () => {
    const w = makeWorld();
    const out = await setManualEventTaxRate(
      { ...w.deps, reportError: undefined },
      input(925),
    );
    expect(out.changed).toBe(true);
  });
});

describe("setManualEventTaxRate — only while the lookup is actually failing", () => {
  it("the provider answers with a rate: refused (lookup_available), nothing written", async () => {
    const w = makeWorld({
      lookup: vi.fn(async () => ({ rateBps: 975, source: "ziptax" })),
    });
    await expect(setManualEventTaxRate(w.deps, input(925))).rejects.toMatchObject({
      code: "MANUAL_TAX_RATE_NOT_ALLOWED",
      meta: { reason: "lookup_available", lookedUpRateBps: 975 },
    });
    expect(w.calls).toEqual(["lookup"]);
    expect(w.event!.admissionTaxRateBps).toBeNull();
    expect(w.reportError).not.toHaveBeenCalled();
  });

  it("the provider answers \"no rate here\": refused too — the door would sell at no rate, not refuse", async () => {
    const w = makeWorld({ lookup: vi.fn(async () => null) });
    await expect(setManualEventTaxRate(w.deps, input(2500))).rejects.toMatchObject({
      code: "MANUAL_TAX_RATE_NOT_ALLOWED",
      meta: { reason: "lookup_available", lookedUpRateBps: null },
    });
    expect(w.event!.admissionTaxRateBps).toBeNull();
    expect(w.tx.events.updateTaxRate).not.toHaveBeenCalled();
  });

  it("the VENUE's cached rate answers first, as for a sale: refused with no provider call", async () => {
    const w = makeWorld({
      event: { placeId: "c0000000-0000-4000-8000-0000000000p1" },
      place: {
        id: "c0000000-0000-4000-8000-0000000000p1",
        postalCode: "37203",
        countryCode: "US",
        region: "TN",
        admissionTaxRateBps: 975,
        taxRateSource: "ziptax",
      },
    });
    await expect(setManualEventTaxRate(w.deps, input(925))).rejects.toMatchObject({
      code: "MANUAL_TAX_RATE_NOT_ALLOWED",
      meta: { reason: "lookup_available", lookedUpRateBps: 975 },
    });
    expect(w.calls).toEqual([]);
  });

  it("no provider configured: refused (lookup_not_configured) — no sale is ever refused there", async () => {
    const w = makeWorld({ lookup: null });
    await expect(setManualEventTaxRate(w.deps, input(925))).rejects.toMatchObject({
      code: "MANUAL_TAX_RATE_NOT_ALLOWED",
      meta: { reason: "lookup_not_configured" },
    });
    expect(w.tx.events.updateTaxRate).not.toHaveBeenCalled();
  });

  it("a lookup still running at a SALE's budget counts as failing: the entry goes through", async () => {
    vi.useFakeTimers();
    try {
      const w = makeWorld({ lookup: vi.fn(() => new Promise<never>(() => {})) });
      let settled = false;
      const pending = setManualEventTaxRate(w.deps, input(925)).finally(() => {
        settled = true;
      });
      // Not the 2 s relookup cap: a provider that answers in 3-5 s would have
      // served a sale, so it must not open the door to a hand-entered rate.
      await vi.advanceTimersByTimeAsync(MANUAL_STAMP_RELOOKUP_BUDGET_MS);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(
        TAX_LOOKUP_RETRY_BUDGET_MS - MANUAL_STAMP_RELOOKUP_BUDGET_MS,
      );
      const out = await pending;
      expect(out.changed).toBe(true);
      expect(w.reportError.mock.calls[0]![1]).toMatchObject({
        extra: { lookupBudgetExhausted: true },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a stranger spends no lookup: the role is checked first", async () => {
    const w = makeWorld({ role: "SCANNER" });
    await expect(setManualEventTaxRate(w.deps, input(925))).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
    expect(w.taxRateLookup!.lookupByPostalCode).not.toHaveBeenCalled();
  });

  it("a published-but-rated event spends no lookup", async () => {
    const w = makeWorld({ event: { admissionTaxRateBps: 975, taxRateSource: "ziptax" } });
    await expect(setManualEventTaxRate(w.deps, input(925))).rejects.toMatchObject({
      meta: { reason: "rate_resolved" },
    });
    expect(w.taxRateLookup!.lookupByPostalCode).not.toHaveBeenCalled();
  });

  it("the venue moved between the lookup and the lock: refused (location_changed), nothing written", async () => {
    const w = makeWorld();
    w.tx.events.lockRows.mockImplementationOnce(async () => {
      w.event!.postalCode = "37206";
    });
    await expect(setManualEventTaxRate(w.deps, input(925))).rejects.toMatchObject({
      code: "MANUAL_TAX_RATE_NOT_ALLOWED",
      meta: { reason: "location_changed" },
    });
    expect(w.tx.events.updateTaxRate).not.toHaveBeenCalled();
  });
});
