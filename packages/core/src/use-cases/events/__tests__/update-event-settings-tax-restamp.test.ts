import { describe, expect, it, vi, type Mock } from "vitest";

import type { LoggerPort } from "@th/ports/logger";
import type { EventRecord } from "@th/ports/repos/events";
import type { Repos, TxRepos } from "@th/ports/repos";
import { createTestLogger } from "@th/test-utils/fakes/logger";
import { makeStubEventRecord } from "@th/test-utils/fakes/stub-records";

import { updateEventSettings } from "../update-event-settings";

// ─────────────────────────────────────────────────────────────────────────────
// Regression tests for the durable tax re-stamp when `instructionalAdmission`
// is toggled via updateEventSettings. The invariant: the persisted stamp (read
// by estimate-checkout-tax) must stay consistent with what checkout charges —
//   toggle ON  in TN → 0 / "exempt:tn-instruction"
//   toggle OFF        → the real venue rate is restored (no silent under-collect)
// and a settings save NOT touching the flag must never trigger a tax lookup.
// ─────────────────────────────────────────────────────────────────────────────

const ACTOR_HUMAN_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const PLACE_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-07-08T00:00:00.000Z");

type PlaceFake = {
  countryCode: string | null;
  region: string | null;
  postalCode: string | null;
  admissionTaxRateBps: number | null;
  taxRateSource: string | null;
} | null;

type SpyLogger = LoggerPort & { error: Mock; warn: Mock };

function makeCtx(opts: {
  event: EventRecord;
  place?: PlaceFake;
  updateTaxRate?: ReturnType<typeof vi.fn>;
  placeGetById?: ReturnType<typeof vi.fn>;
  reportError?: ReturnType<typeof vi.fn>;
}) {
  let currentEvent = opts.event;

  // The use case logs through `logger.child(...)`; keep a handle on the child
  // so `error` / `warn` are the spies the use case actually calls.
  const scopedLogger = createTestLogger() as SpyLogger;
  const logger = {
    ...createTestLogger(),
    child: vi.fn(() => scopedLogger),
  } as LoggerPort;

  const updateTaxRate =
    opts.updateTaxRate ??
    vi.fn(async ({ admissionTaxRateBps, taxRateSource }) => {
      currentEvent = { ...currentEvent, admissionTaxRateBps, taxRateSource };
    });

  const lookupByPostalCode = vi.fn(async () => null);
  const placeGetById =
    opts.placeGetById ??
    vi.fn(async (id: string) => (opts.place ? { id, ...opts.place } : null));

  const tx = {
    events: {
      getById: vi.fn(async () => currentEvent),
      updateInstructionalAdmission: vi.fn(async ({ instructionalAdmission }) => {
        currentEvent = { ...currentEvent, instructionalAdmission };
        return currentEvent;
      }),
      updateRefundCutoff: vi.fn(async ({ refundCutoffAt }) => {
        currentEvent = { ...currentEvent, refundCutoffAt };
        return currentEvent;
      }),
      updateVolunteerSettings: vi.fn(async () => currentEvent),
      updateTaxRate,
      lockLocationsAtPlace: vi.fn(async () => undefined),
      // Settings row-locks the event before re-reading it for the re-stamp.
      lockRows: vi.fn(async () => undefined),
    },
    places: {
      getById: placeGetById,
      updateTaxRate: vi.fn(async () => {}),
      fillTaxRateIfUnset: vi.fn(async () => true),
    },
    savedLocations: {
      getById: vi.fn(async () => null),
      updateTaxRate: vi.fn(async () => {}),
      fillTaxRateIfUnset: vi.fn(async () => true),
    },
    authz: { getOrgMembership: vi.fn(async () => null) },
    audit: { log: vi.fn(async () => {}) },
  } as unknown as TxRepos;

  const reportError = opts.reportError ?? vi.fn();
  const deps = {
    // The re-stamp's rate is prepared BEFORE the transaction, through the
    // root repos; this fake shares the tx's fakes with it.
    repos: {
      ...tx,
      tx: (cb: (t: TxRepos) => unknown) => cb(tx),
    } as unknown as Repos,
    clock: { now: () => NOW },
    logger,
    taxRateLookup: { lookupByPostalCode },
    reportError,
  };

  return {
    deps,
    tx,
    updateTaxRate,
    lookupByPostalCode,
    placeGetById,
    reportError,
    scopedLogger,
    getCurrentEvent: () => currentEvent,
  };
}

function makeTnEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return makeStubEventRecord({
    id: EVENT_ID,
    humanId: ACTOR_HUMAN_ID,
    orgId: null,
    stewardship: "OWNED",
    placeId: PLACE_ID,
    instructionalAdmission: false,
    admissionTaxRateBps: 975,
    taxRateSource: "ziptax",
    ...overrides,
  });
}

// Inline-address TN event: no placeId / savedLocationId, so the only source of
// truth for a base rate is a ZipTax lookup (which can transiently return null).
function makeInlineTnEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return makeStubEventRecord({
    id: EVENT_ID,
    humanId: ACTOR_HUMAN_ID,
    orgId: null,
    stewardship: "OWNED",
    placeId: null,
    savedLocationId: null,
    addressText: "1 Music Row, Nashville, TN 37203",
    countryCode: "US",
    region: "TN",
    postalCode: "37203",
    instructionalAdmission: false,
    admissionTaxRateBps: 975,
    taxRateSource: "ziptax",
    ...overrides,
  });
}

const TN_PLACE: PlaceFake = {
  countryCode: "US",
  region: "TN",
  postalCode: "37203",
  admissionTaxRateBps: 975,
  taxRateSource: "ziptax",
};

describe("updateEventSettings — instructional-admission tax re-stamp", () => {
  it("re-stamps 0 / exempt:tn-instruction when toggling instructional ON (TN)", async () => {
    const { deps, updateTaxRate, getCurrentEvent } = makeCtx({
      event: makeTnEvent(),
      place: TN_PLACE,
    });

    const result = await updateEventSettings(deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      eventId: EVENT_ID,
      instructionalAdmission: true,
    });

    expect(result.instructionalAdmission).toBe(true);
    expect(updateTaxRate).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      admissionTaxRateBps: 0,
      taxRateSource: "exempt:tn-instruction",
    });
    expect(getCurrentEvent().admissionTaxRateBps).toBe(0);
    expect(getCurrentEvent().taxRateSource).toBe("exempt:tn-instruction");
  });

  it("restores the real venue rate when toggling instructional OFF (TN)", async () => {
    const { deps, updateTaxRate, getCurrentEvent } = makeCtx({
      // Event currently instructional with an exempt stamp — the stamp alone
      // has no base rate, so the resolver must re-fetch the venue's real rate.
      event: makeTnEvent({
        instructionalAdmission: true,
        admissionTaxRateBps: 0,
        taxRateSource: "exempt:tn-instruction",
      }),
      place: TN_PLACE,
    });

    const result = await updateEventSettings(deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      eventId: EVENT_ID,
      instructionalAdmission: false,
    });

    expect(result.instructionalAdmission).toBe(false);
    expect(updateTaxRate).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      admissionTaxRateBps: 975,
      taxRateSource: "ziptax",
    });
    expect(getCurrentEvent().admissionTaxRateBps).toBe(975);
    expect(getCurrentEvent().taxRateSource).toBe("ziptax");
  });

  it("round-trips ON→OFF keeping the stamp consistent with checkout", async () => {
    const ctx = makeCtx({ event: makeTnEvent(), place: TN_PLACE });

    await updateEventSettings(ctx.deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      eventId: EVENT_ID,
      instructionalAdmission: true,
    });
    expect(ctx.getCurrentEvent().admissionTaxRateBps).toBe(0);
    expect(ctx.getCurrentEvent().taxRateSource).toBe("exempt:tn-instruction");

    await updateEventSettings(ctx.deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      eventId: EVENT_ID,
      instructionalAdmission: false,
    });
    expect(ctx.getCurrentEvent().admissionTaxRateBps).toBe(975);
    expect(ctx.getCurrentEvent().taxRateSource).toBe("ziptax");
  });

  it("does NOT exempt when toggling ON outside TN (normal rate re-stamped)", async () => {
    const { deps, updateTaxRate } = makeCtx({
      event: makeTnEvent(),
      place: {
        countryCode: "US",
        region: "TX",
        postalCode: "78701",
        admissionTaxRateBps: 825,
        taxRateSource: "ziptax",
      },
    });

    await updateEventSettings(deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      eventId: EVENT_ID,
      instructionalAdmission: true,
    });

    expect(updateTaxRate).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      admissionTaxRateBps: 825,
      taxRateSource: "ziptax",
    });
  });

  it("does NOT re-stamp or look up when the update does not touch instructionalAdmission", async () => {
    const { deps, updateTaxRate, placeGetById, lookupByPostalCode } = makeCtx({
      event: makeTnEvent(),
      place: TN_PLACE,
    });

    await updateEventSettings(deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      eventId: EVENT_ID,
      refundCutoffAt: null,
    });

    expect(updateTaxRate).not.toHaveBeenCalled();
    expect(placeGetById).not.toHaveBeenCalled();
    expect(lookupByPostalCode).not.toHaveBeenCalled();
  });

  it("does NOT re-stamp when instructionalAdmission is sent but unchanged", async () => {
    const { deps, updateTaxRate, placeGetById } = makeCtx({
      event: makeTnEvent({ instructionalAdmission: true }),
      place: TN_PLACE,
    });

    await updateEventSettings(deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      eventId: EVENT_ID,
      instructionalAdmission: true,
    });

    expect(updateTaxRate).not.toHaveBeenCalled();
    expect(placeGetById).not.toHaveBeenCalled();
  });

  // ── Re-stamp failure is FATAL to the save ──────────────────────────────────
  // The re-stamp runs inside the same `repos.tx` as the flag write and the
  // audit row. It used to swallow: on a toggle-OFF the flag and audit
  // committed, the stamp stayed 0 / "exempt:tn-instruction", checkout trusted
  // the non-null stamp forever, and the organiser was told the save succeeded.
  // The fakes model no transaction, so what is pinned here is the OUTCOME the
  // use case controls: the mutation rejects with the repo error, nothing after
  // the failure runs (no audit row), and the failure is reported at `error`.

  it("fails the settings save when the re-stamp write throws (reported, then rethrown)", async () => {
    const boom = new Error("db write failed");
    const updateTaxRate = vi.fn(async () => {
      throw boom;
    });
    const { deps, tx, reportError, scopedLogger } = makeCtx({
      event: makeTnEvent(),
      place: TN_PLACE,
      updateTaxRate,
    });

    await expect(
      updateEventSettings(deps, {
        actorHumanId: ACTOR_HUMAN_ID,
        eventId: EVENT_ID,
        instructionalAdmission: true,
      }),
    ).rejects.toBe(boom);

    expect(updateTaxRate).toHaveBeenCalledTimes(1);
    // Nothing after the failed statement ran.
    expect(tx.audit.log).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: { useCase: "updateEventSettings", op: "tax_restamp" },
      extra: { eventId: EVENT_ID },
    });
    // `error`, not `warn` — warn is not captured by the Sentry pino integration.
    expect(scopedLogger.error).toHaveBeenCalledWith(
      "tax_rate_restamp_failed",
      expect.objectContaining({ eventId: EVENT_ID }),
    );
    expect(scopedLogger.warn).not.toHaveBeenCalledWith(
      "tax_rate_restamp_failed",
      expect.anything(),
    );
  });

  it("toggle-OFF: a failed re-stamp never reports success with the exempt sentinel still in place", async () => {
    // The money bug. Event stamped 0/exempt, organiser turns instruction OFF,
    // the restamp to the real rate fails. The old swallow committed the flag
    // flip and returned `instructionalAdmission: false` while the stamp stayed
    // exempt — every later ticket sold at $0 admission tax.
    const boom = new Error("db write failed");
    const updateTaxRate = vi.fn(async () => {
      throw boom;
    });
    const { deps, tx, reportError } = makeCtx({
      event: makeTnEvent({
        instructionalAdmission: true,
        admissionTaxRateBps: 0,
        taxRateSource: "exempt:tn-instruction",
      }),
      place: TN_PLACE,
      updateTaxRate,
    });

    await expect(
      updateEventSettings(deps, {
        actorHumanId: ACTOR_HUMAN_ID,
        eventId: EVENT_ID,
        instructionalAdmission: false,
      }),
    ).rejects.toBe(boom);

    // The restore to the real venue rate was attempted...
    expect(updateTaxRate).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      admissionTaxRateBps: 975,
      taxRateSource: "ziptax",
    });
    // ...and its failure ended the save: no audit row, no success.
    expect(tx.audit.log).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: { useCase: "updateEventSettings", op: "tax_restamp" },
      extra: { eventId: EVENT_ID },
    });
  });

  it("a THROWING reporter does not change the outcome (the repo error still propagates)", async () => {
    const boom = new Error("db write failed");
    const updateTaxRate = vi.fn(async () => {
      throw boom;
    });
    const reportError = vi.fn(() => {
      throw new Error("sentry is down too");
    });
    const { deps, tx, scopedLogger } = makeCtx({
      event: makeTnEvent(),
      place: TN_PLACE,
      updateTaxRate,
      reportError,
    });

    await expect(
      updateEventSettings(deps, {
        actorHumanId: ACTOR_HUMAN_ID,
        eventId: EVENT_ID,
        instructionalAdmission: true,
      }),
    ).rejects.toBe(boom);

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(tx.audit.log).not.toHaveBeenCalled();
    expect(scopedLogger.error).toHaveBeenCalledWith(
      "tax_rate_restamp_failed",
      expect.objectContaining({ eventId: EVENT_ID }),
    );
  });

  it("a repo fault inside the rate re-resolve (the in-tx place re-read) also fails the save", async () => {
    // The tax-rate resolution rethrows genuine repo faults (its `null` is
    // only the legitimate no-rate outcomes), so the fault reaches this catch
    // and must propagate rather than be turned into a committed toggle.
    const boom = new Error("connection terminated unexpectedly");
    // The pre-transaction prepare reads fine; the in-transaction re-read
    // under the place-location lock fails.
    const placeGetById = vi
      .fn()
      .mockImplementationOnce(async (id: string) => ({ id, ...TN_PLACE }))
      .mockImplementation(async () => {
        throw boom;
      });
    const { deps, tx, updateTaxRate, reportError } = makeCtx({
      event: makeTnEvent(),
      placeGetById,
    });

    await expect(
      updateEventSettings(deps, {
        actorHumanId: ACTOR_HUMAN_ID,
        eventId: EVENT_ID,
        instructionalAdmission: true,
      }),
    ).rejects.toBe(boom);

    expect(updateTaxRate).not.toHaveBeenCalled();
    expect(tx.audit.log).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: { useCase: "updateEventSettings", op: "tax_restamp" },
      extra: { eventId: EVENT_ID },
    });
  });

  it("a repo fault in the PRE-transaction rate read fails the save before the transaction opens (reported, then rethrown)", async () => {
    const boom = new Error("connection terminated unexpectedly");
    const placeGetById = vi.fn().mockRejectedValue(boom);
    const { deps, tx, updateTaxRate, reportError } = makeCtx({
      event: makeTnEvent(),
      placeGetById,
    });
    const repoTx = vi.spyOn(deps.repos, "tx");

    await expect(
      updateEventSettings(deps, {
        actorHumanId: ACTOR_HUMAN_ID,
        eventId: EVENT_ID,
        instructionalAdmission: true,
      }),
    ).rejects.toBe(boom);

    expect(repoTx).not.toHaveBeenCalled();
    expect(updateTaxRate).not.toHaveBeenCalled();
    expect(tx.audit.log).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: expect.objectContaining({ useCase: "resolveEventTaxRate" }),
      }),
    );
  });

  it("does NOT clobber a real non-zero stamp when the re-resolve yields null", async () => {
    // Place row present but with NO cached rate, and the last-chance lookup
    // returns null → the resolution yields null. The current stamp is a
    // real non-zero rate (975/ziptax), so we must leave it untouched.
    const { deps, updateTaxRate, getCurrentEvent } = makeCtx({
      event: makeTnEvent({ admissionTaxRateBps: 975, taxRateSource: "ziptax" }),
      place: {
        countryCode: "US",
        region: "TN",
        postalCode: "37203",
        admissionTaxRateBps: null,
        taxRateSource: null,
      },
    });

    await updateEventSettings(deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      eventId: EVENT_ID,
      instructionalAdmission: true,
    });

    // No clobber: the good rate is preserved, updateTaxRate never called.
    expect(updateTaxRate).not.toHaveBeenCalled();
    expect(getCurrentEvent().admissionTaxRateBps).toBe(975);
    expect(getCurrentEvent().taxRateSource).toBe("ziptax");
  });

  it("nulls a stale 0/exempt stamp on toggle-OFF when the base rate can't be re-resolved (so checkout self-heals)", async () => {
    // Inline-address TN event currently stamped 0/exempt. Toggling OFF, the
    // ZipTax lookup transiently returns null (no cached place/saved-location to
    // fall back on) → the resolution yields null. Leaving the 0/exempt
    // stamp would charge 0/exempt forever (checkout's fast path trusts the 0
    // and never self-heals). We null it so the fresh path re-resolves next time.
    const { deps, updateTaxRate, lookupByPostalCode, getCurrentEvent } = makeCtx({
      event: makeInlineTnEvent({
        instructionalAdmission: true,
        admissionTaxRateBps: 0,
        taxRateSource: "exempt:tn-instruction",
      }),
      // No place / saved-location rows; lookup returns null (makeCtx default).
    });

    await updateEventSettings(deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      eventId: EVENT_ID,
      instructionalAdmission: false,
    });

    // The inline lookup was attempted, yielded null, and the stale exempt stamp
    // was cleared to null (not left at 0/exempt).
    expect(lookupByPostalCode).toHaveBeenCalled();
    expect(updateTaxRate).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      admissionTaxRateBps: null,
      taxRateSource: null,
    });
    expect(getCurrentEvent().admissionTaxRateBps).toBeNull();
    expect(getCurrentEvent().taxRateSource).toBeNull();
  });
});
