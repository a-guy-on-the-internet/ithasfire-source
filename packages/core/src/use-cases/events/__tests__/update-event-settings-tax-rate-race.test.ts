import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import type { Repos, TxRepos } from "@th/ports/repos";
import { createTestLogger } from "@th/test-utils/fakes/logger";
import { makeStubEventRecord } from "@th/test-utils/fakes/stub-records";

import { updateEventSettings } from "../update-event-settings";

// ─────────────────────────────────────────────────────────────────────────────
// The instructional-admission re-stamp resolves the venue's base rate. When
// the venue's cache is empty that takes a provider round trip, and anything
// that moves the venue in the meantime must not be undone by it:
//
//   settings: reads Place at P1, cache empty → provider → R1
//   upsertPlace: commits address P2 + cached R2          ← in between
//   settings: writes the cache and the stamp
//
// The old code did the round trip INSIDE its transaction and then wrote
// `places.updateTaxRate(R1)` unconditionally (the venue now sits at P2 holding
// P1's rate, so every later checkout there collects the wrong tax) and stamped
// the event R1.
//
// The interleaving is driven from the fake provider: by the time it answers,
// the "concurrent" edit has committed. Cache writes mutate the row object, so
// the assertions read the row's end state.
// ─────────────────────────────────────────────────────────────────────────────

const ACTOR_HUMAN_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const PLACE_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-07-08T00:00:00.000Z");
const FETCHED_AT_R2 = new Date("2026-07-01T00:00:00.000Z");

const R1 = { rateBps: 975, source: "ziptax" };
const R2 = { rateBps: 925, source: "ziptax" };

type PlaceRow = {
  id: string;
  countryCode: string | null;
  region: string | null;
  postalCode: string | null;
  admissionTaxRateBps: number | null;
  taxRateSource: string | null;
  taxRateFetchedAt: Date | null;
};

function makePlace(overrides: Partial<PlaceRow> = {}): PlaceRow {
  return {
    id: PLACE_ID,
    countryCode: "US",
    region: "TN",
    postalCode: "37203",
    admissionTaxRateBps: null,
    taxRateSource: null,
    taxRateFetchedAt: null,
    ...overrides,
  };
}

/** Toggle-OFF of an exempt TN event: the real base rate has to be re-resolved. */
function makeExemptEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return makeStubEventRecord({
    id: EVENT_ID,
    humanId: ACTOR_HUMAN_ID,
    orgId: null,
    stewardship: "OWNED",
    placeId: PLACE_ID,
    instructionalAdmission: true,
    admissionTaxRateBps: 0,
    taxRateSource: "exempt:tn-instruction",
    ...overrides,
  });
}

function makeCtx(opts: { event: EventRecord; place: PlaceRow }) {
  let currentEvent = opts.event;
  const place = opts.place;

  const placesGetById = vi.fn(async (id: string) =>
    id === place.id ? { ...place } : null,
  );
  const placesUpdateTaxRate = vi.fn(
    async (input: {
      id: string;
      admissionTaxRateBps: number;
      taxRateSource: string;
      taxRateFetchedAt: Date;
    }) => {
      if (input.id !== place.id) return;
      place.admissionTaxRateBps = input.admissionTaxRateBps;
      place.taxRateSource = input.taxRateSource;
      place.taxRateFetchedAt = input.taxRateFetchedAt;
    },
  );
  // Compare-and-set, like the adapter: only while the cache is empty and the
  // row still has the address the lookup was for.
  const placesFillTaxRateIfUnset = vi.fn(
    async (input: {
      id: string;
      expectedPostalCode: string | null;
      expectedCountryCode: string | null;
      admissionTaxRateBps: number;
      taxRateSource: string;
      taxRateFetchedAt: Date;
    }) => {
      if (
        input.id !== place.id ||
        place.admissionTaxRateBps != null ||
        place.postalCode !== input.expectedPostalCode ||
        place.countryCode !== input.expectedCountryCode
      ) {
        return false;
      }
      place.admissionTaxRateBps = input.admissionTaxRateBps;
      place.taxRateSource = input.taxRateSource;
      place.taxRateFetchedAt = input.taxRateFetchedAt;
      return true;
    },
  );

  const lockLocationsAtPlace = vi.fn(async () => undefined);
  const lockRows = vi.fn(
    async (_input: { ids: string[]; mode: "share" | "update" }) => undefined,
  );
  const updateEventTaxRate = vi.fn(
    async (input: {
      eventId: string;
      admissionTaxRateBps: number | null;
      taxRateSource: string | null;
    }) => {
      currentEvent = {
        ...currentEvent,
        admissionTaxRateBps: input.admissionTaxRateBps,
        taxRateSource: input.taxRateSource,
      };
    },
  );

  const tx = {
    events: {
      getById: vi.fn(async () => currentEvent),
      updateInstructionalAdmission: vi.fn(
        async ({
          instructionalAdmission,
        }: {
          instructionalAdmission: boolean;
        }) => {
          currentEvent = { ...currentEvent, instructionalAdmission };
          return currentEvent;
        },
      ),
      updateRefundCutoff: vi.fn(
        async ({ refundCutoffAt }: { refundCutoffAt: Date | null }) => {
          currentEvent = { ...currentEvent, refundCutoffAt };
          return currentEvent;
        },
      ),
      updateVolunteerSettings: vi.fn(async () => currentEvent),
      updateTaxRate: updateEventTaxRate,
      lockLocationsAtPlace,
      lockRows,
    },
    places: {
      getById: placesGetById,
      updateTaxRate: placesUpdateTaxRate,
      fillTaxRateIfUnset: placesFillTaxRateIfUnset,
    },
    savedLocations: {
      getById: vi.fn(async () => null),
      updateTaxRate: vi.fn(async () => {}),
      fillTaxRateIfUnset: vi.fn(async () => false),
    },
    authz: { getOrgMembership: vi.fn(async () => null) },
    audit: { log: vi.fn(async () => {}) },
  } as unknown as TxRepos;

  const repoTx = vi.fn((cb: (t: TxRepos) => unknown) => cb(tx));
  const lookupByPostalCode = vi.fn(
    async (): Promise<{ rateBps: number; source: string } | null> => null,
  );
  const reportError = vi.fn();
  const deps = {
    repos: { ...tx, tx: repoTx } as unknown as Repos,
    clock: { now: () => NOW },
    logger: createTestLogger(),
    taxRateLookup: { lookupByPostalCode },
    reportError,
  };

  return {
    deps,
    place,
    repoTx,
    lookupByPostalCode,
    lockLocationsAtPlace,
    lockRows,
    placesGetById,
    placesUpdateTaxRate,
    placesFillTaxRateIfUnset,
    updateEventTaxRate,
    reportError,
    getCurrentEvent: () => currentEvent,
    // A concurrent transaction committing a change to the event row.
    commitEventChange: (change: Partial<EventRecord>) => {
      currentEvent = { ...currentEvent, ...change };
    },
  };
}

const toggleOff = {
  actorHumanId: ACTOR_HUMAN_ID,
  eventId: EVENT_ID,
  instructionalAdmission: false,
};

describe("updateEventSettings tax re-stamp: the venue moves while the rate is being looked up", () => {
  it("venue moved to P2 with R2 cached: the venue keeps R2 and the event is stamped R2, never R1", async () => {
    const ctx = makeCtx({ event: makeExemptEvent(), place: makePlace() });
    ctx.lookupByPostalCode.mockImplementation(async () => {
      // upsertPlace commits while the settings save waits on the provider.
      ctx.place.postalCode = "37206";
      ctx.place.admissionTaxRateBps = R2.rateBps;
      ctx.place.taxRateSource = R2.source;
      ctx.place.taxRateFetchedAt = FETCHED_AT_R2;
      return R1;
    });

    await updateEventSettings(ctx.deps, toggleOff);

    expect(ctx.lookupByPostalCode).toHaveBeenCalledWith({
      postalCode: "37203",
      countryCode: "US",
    });
    expect(ctx.place).toMatchObject({
      postalCode: "37206",
      admissionTaxRateBps: R2.rateBps,
      taxRateFetchedAt: FETCHED_AT_R2,
    });
    expect(ctx.placesUpdateTaxRate).not.toHaveBeenCalled();
    expect(ctx.updateEventTaxRate).toHaveBeenCalledTimes(1);
    expect(ctx.updateEventTaxRate).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      admissionTaxRateBps: R2.rateBps,
      taxRateSource: R2.source,
    });
    expect(ctx.lookupByPostalCode).toHaveBeenCalledTimes(1);
  });

  it("venue moved to a TX address: toggling instructional ON does not apply the TN exemption from the OLD address", async () => {
    const ctx = makeCtx({
      event: makeExemptEvent({
        instructionalAdmission: false,
        admissionTaxRateBps: 975,
        taxRateSource: "ziptax",
      }),
      place: makePlace(),
    });
    ctx.lookupByPostalCode.mockImplementation(async () => {
      ctx.place.postalCode = "78701";
      ctx.place.region = "TX";
      ctx.place.admissionTaxRateBps = 825;
      ctx.place.taxRateSource = "ziptax";
      ctx.place.taxRateFetchedAt = FETCHED_AT_R2;
      return R1;
    });

    await updateEventSettings(ctx.deps, {
      ...toggleOff,
      instructionalAdmission: true,
    });

    // TX has no instruction exemption: the venue's real TX rate is stamped.
    expect(ctx.updateEventTaxRate).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      admissionTaxRateBps: 825,
      taxRateSource: "ziptax",
    });
    expect(ctx.place.admissionTaxRateBps).toBe(825);
    expect(ctx.placesUpdateTaxRate).not.toHaveBeenCalled();
  });

  it("venue moved and the new address has no cached rate: no cache write; the exempt sentinel is cleared to NULL for checkout to resolve", async () => {
    const ctx = makeCtx({ event: makeExemptEvent(), place: makePlace() });
    ctx.lookupByPostalCode.mockImplementation(async () => {
      ctx.place.postalCode = "37206";
      return R1;
    });

    await updateEventSettings(ctx.deps, toggleOff);

    expect(ctx.place.admissionTaxRateBps).toBeNull();
    expect(ctx.placesUpdateTaxRate).not.toHaveBeenCalled();
    expect(ctx.placesFillTaxRateIfUnset).toHaveBeenCalledTimes(0);
    // A NULL stamp is "unresolved" (checkout resolves it), never 0%.
    expect(ctx.getCurrentEvent()).toMatchObject({
      admissionTaxRateBps: null,
      taxRateSource: null,
    });
  });

  it("no race: a fresh lookup is cached by compare-and-set and stamped", async () => {
    const ctx = makeCtx({ event: makeExemptEvent(), place: makePlace() });
    ctx.lookupByPostalCode.mockResolvedValue(R1);

    await updateEventSettings(ctx.deps, toggleOff);

    expect(ctx.placesFillTaxRateIfUnset).toHaveBeenCalledWith({
      id: PLACE_ID,
      expectedPostalCode: "37203",
      expectedCountryCode: "US",
      admissionTaxRateBps: R1.rateBps,
      taxRateSource: R1.source,
      taxRateFetchedAt: NOW,
    });
    expect(ctx.place.admissionTaxRateBps).toBe(R1.rateBps);
    expect(ctx.updateEventTaxRate).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      admissionTaxRateBps: R1.rateBps,
      taxRateSource: R1.source,
    });
  });
});

describe("updateEventSettings tax re-stamp: ordering", () => {
  it("calls the provider BEFORE the transaction opens", async () => {
    const ctx = makeCtx({ event: makeExemptEvent(), place: makePlace() });
    ctx.lookupByPostalCode.mockResolvedValue(R1);

    await updateEventSettings(ctx.deps, toggleOff);

    expect(ctx.lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(ctx.repoTx).toHaveBeenCalledTimes(1);
    expect(ctx.lookupByPostalCode.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.repoTx.mock.invocationCallOrder[0]!,
    );
  });

  it("takes the SHARED place-location lock before the re-read the stamp uses", async () => {
    const ctx = makeCtx({ event: makeExemptEvent(), place: makePlace() });
    ctx.lookupByPostalCode.mockResolvedValue(R1);
    // Model upsertPlace holding the EXCLUSIVE lock: it commits P2 + R2 the
    // moment our shared lock is granted. A read taken before the lock still
    // sees P1, and would let the prepared R1 through.
    ctx.lockLocationsAtPlace.mockImplementation(async () => {
      ctx.place.postalCode = "37206";
      ctx.place.admissionTaxRateBps = R2.rateBps;
      ctx.place.taxRateSource = R2.source;
      ctx.place.taxRateFetchedAt = FETCHED_AT_R2;
    });

    await updateEventSettings(ctx.deps, toggleOff);

    expect(ctx.lockLocationsAtPlace).toHaveBeenCalledTimes(1);
    expect(ctx.lockLocationsAtPlace).toHaveBeenCalledWith({
      placeId: PLACE_ID,
      mode: "shared",
    });
    // The stamp came from a read that saw the post-lock row (R2 exists only
    // after the lock), and that read came after the lock.
    expect(ctx.updateEventTaxRate).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      admissionTaxRateBps: R2.rateBps,
      taxRateSource: R2.source,
    });
    expect(ctx.place.admissionTaxRateBps).toBe(R2.rateBps);
    const lockOrder = ctx.lockLocationsAtPlace.mock.invocationCallOrder[0]!;
    const txOrder = ctx.repoTx.mock.invocationCallOrder[0]!;
    const inTxPlaceReads = ctx.placesGetById.mock.invocationCallOrder.filter(
      (order) => order > txOrder,
    );
    expect(inTxPlaceReads.length).toBeGreaterThan(0);
    for (const order of inTxPlaceReads) {
      expect(order).toBeGreaterThan(lockOrder);
    }
  });

  it("takes the lock before any event-row write in the transaction", async () => {
    const ctx = makeCtx({ event: makeExemptEvent(), place: makePlace() });
    ctx.lookupByPostalCode.mockResolvedValue(R1);

    await updateEventSettings(ctx.deps, {
      ...toggleOff,
      refundCutoffAt: new Date("2026-08-01T00:00:00.000Z"),
    });

    // upsertPlace takes the advisory lock, then rewrites event rows at the
    // venue; a settings tx that locked an event row first would deadlock it.
    const repos = ctx.deps.repos as unknown as {
      events: {
        updateRefundCutoff: { mock: { invocationCallOrder: number[] } };
      };
    };
    expect(ctx.lockLocationsAtPlace.mock.invocationCallOrder[0]!).toBeLessThan(
      repos.events.updateRefundCutoff.mock.invocationCallOrder[0]!,
    );
  });

  it("a settings save that does not toggle instructional admission takes no lock and calls no provider", async () => {
    const ctx = makeCtx({ event: makeExemptEvent(), place: makePlace() });

    await updateEventSettings(ctx.deps, {
      actorHumanId: ACTOR_HUMAN_ID,
      eventId: EVENT_ID,
      volunteeringEnabled: true,
    });

    expect(ctx.lockLocationsAtPlace).not.toHaveBeenCalled();
    expect(ctx.lookupByPostalCode).not.toHaveBeenCalled();
    expect(ctx.updateEventTaxRate).not.toHaveBeenCalled();
  });

  it("the event moved to another venue between the pre-tx read and the tx: the prepared rate is discarded and the stamp comes from the NEW venue's row", async () => {
    const OTHER_PLACE_ID = "44444444-4444-4444-8444-444444444444";
    // In the tx the event is at venue B (PLACE_ID), cached R2.
    const ctx = makeCtx({
      event: makeExemptEvent(),
      place: makePlace({
        admissionTaxRateBps: R2.rateBps,
        taxRateSource: R2.source,
      }),
    });
    // Before the tx it still read as at venue A, uncached.
    const placeA = makePlace({ id: OTHER_PLACE_ID, postalCode: "37206" });
    const root = ctx.deps.repos as unknown as Record<string, unknown>;
    root.events = {
      getById: vi.fn(async () => ({
        ...makeExemptEvent(),
        placeId: OTHER_PLACE_ID,
      })),
    };
    root.places = {
      getById: vi.fn(async (id: string) =>
        id === OTHER_PLACE_ID ? { ...placeA } : null,
      ),
      fillTaxRateIfUnset: ctx.placesFillTaxRateIfUnset,
      updateTaxRate: ctx.placesUpdateTaxRate,
    };
    ctx.lookupByPostalCode.mockResolvedValue(R1);

    await updateEventSettings(ctx.deps, toggleOff);

    expect(ctx.lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(ctx.lookupByPostalCode).toHaveBeenCalledWith({
      postalCode: "37206",
      countryCode: "US",
    });
    expect(ctx.lookupByPostalCode.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.repoTx.mock.invocationCallOrder[0]!,
    );
    expect(ctx.placesFillTaxRateIfUnset).not.toHaveBeenCalled();
    expect(ctx.placesUpdateTaxRate).not.toHaveBeenCalled();
    expect(placeA.admissionTaxRateBps).toBeNull();
    expect(ctx.lockLocationsAtPlace).toHaveBeenCalledTimes(1);
    expect(ctx.lockLocationsAtPlace).toHaveBeenCalledWith({
      placeId: PLACE_ID,
      mode: "shared",
    });
    expect(ctx.updateEventTaxRate).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      admissionTaxRateBps: R2.rateBps,
      taxRateSource: R2.source,
    });
  });

  it("the flag flipped between the pre-transaction read and the transaction: re-resolved from the row, no provider call inside the tx", async () => {
    // Pre-tx the event already reads as non-instructional (nothing to
    // prepare); inside the tx it is still instructional, so the toggle is
    // real and the stamp must come from the row — cached R2 — not a
    // provider call holding the connection.
    const ctx = makeCtx({
      event: makeExemptEvent(),
      place: makePlace({ admissionTaxRateBps: R2.rateBps, taxRateSource: "ziptax" }),
    });
    // The root repos shares the tx's events fake; give it its own, so only
    // the pre-transaction read sees the stale flag.
    (ctx.deps.repos as unknown as Record<string, unknown>).events = {
      getById: vi.fn(async () => ({
        ...makeExemptEvent(),
        instructionalAdmission: false,
      })),
    };

    await updateEventSettings(ctx.deps, toggleOff);

    expect(ctx.lookupByPostalCode).not.toHaveBeenCalled();
    expect(ctx.updateEventTaxRate).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      admissionTaxRateBps: R2.rateBps,
      taxRateSource: "ziptax",
    });
  });
});

describe("updateEventSettings tax re-stamp: a concurrent save re-points the event to another venue", () => {
  // settings: in-tx read → event at A; SHARED lock on A
  // save:     (holds SHARED lock on B) moves the event A → B, stamps B's rate
  //           with the flag as it stood, commits
  // settings: toggles the flag and re-stamps
  //
  // The lock on A pins A's ADDRESS, not WHICH venue the event points at. The
  // re-stamp used the location from the first in-tx read, so it put A's rate
  // (or an exemption decided on A's TN situs) on an event at B, overwriting
  // the save's correct stamp. The save is modelled as committing inside
  // `lockRows`: the row lock waits it out, so its commit is visible to the
  // re-read and nothing earlier.
  const VENUE_B_ID = "55555555-5555-4555-8555-555555555555";
  const RB = { rateBps: 825, source: "ziptax" };
  const EXEMPT = { rateBps: 0, source: "exempt:tn-instruction" };

  function repointCtx(
    opts: {
      event?: Partial<EventRecord>;
      venueB?: Partial<PlaceRow>;
      // What the moving save stamped from B, with the flag as it stood.
      saveStamp?: { rateBps: number; source: string };
    } = {},
  ) {
    // Venue A (TN): uncached, so the pre-tx lookup prepares a fresh R1 for it.
    const ctx = makeCtx({
      event: makeExemptEvent({
        instructionalAdmission: false,
        admissionTaxRateBps: null,
        taxRateSource: null,
        ...opts.event,
      }),
      place: makePlace(),
    });
    const venueB = makePlace({
      id: VENUE_B_ID,
      region: "TX",
      postalCode: "78701",
      admissionTaxRateBps: RB.rateBps,
      taxRateSource: RB.source,
      ...opts.venueB,
    });
    ctx.placesGetById.mockImplementation(async (id: string) =>
      id === PLACE_ID ? { ...ctx.place } : id === VENUE_B_ID ? { ...venueB } : null,
    );
    ctx.lookupByPostalCode.mockResolvedValue(R1);
    const saveStamp = opts.saveStamp ?? RB;
    ctx.lockRows.mockImplementation(async () => {
      ctx.commitEventChange({
        placeId: VENUE_B_ID,
        admissionTaxRateBps: saveStamp.rateBps,
        taxRateSource: saveStamp.source,
      });
      return undefined;
    });
    return { ctx, venueB };
  }

  const toggleOn = {
    actorHumanId: ACTOR_HUMAN_ID,
    eventId: EVENT_ID,
    instructionalAdmission: true,
  };

  it("toggle ON, event now at TX venue B: never A's TN exemption, and the save's real B rate stands (checkout applies any exemption to a stamped rate itself)", async () => {
    const { ctx, venueB } = repointCtx();

    await updateEventSettings(ctx.deps, toggleOn);

    // A's rate was looked up before the tx, for A...
    expect(ctx.lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(ctx.lookupByPostalCode).toHaveBeenCalledWith({
      postalCode: "37203",
      countryCode: "US",
    });
    // ...and neither A's rate nor its exemption reaches the event. Nor does
    // a NULL: the save's B stamp is a real rate, and a NULL would send
    // checkout down the fresh path, which charges 0 when B's cache is empty
    // and the provider fails.
    expect(ctx.updateEventTaxRate).not.toHaveBeenCalled();
    expect(ctx.getCurrentEvent()).toMatchObject({
      placeId: VENUE_B_ID,
      instructionalAdmission: true,
      admissionTaxRateBps: RB.rateBps,
      taxRateSource: RB.source,
    });
    // B's place row is not read: no lock is held on it.
    expect(ctx.placesGetById.mock.calls.some(([id]) => id === VENUE_B_ID)).toBe(
      false,
    );
    expect(ctx.placesFillTaxRateIfUnset).not.toHaveBeenCalled();
    expect(ctx.placesUpdateTaxRate).not.toHaveBeenCalled();
    expect(ctx.place.admissionTaxRateBps).toBeNull();
    expect(venueB.admissionTaxRateBps).toBe(RB.rateBps);
  });

  it("toggle OFF, event now at TN venue B where the save stamped the exempt sentinel: cleared to NULL, so checkout stops trusting the 0", async () => {
    const { ctx } = repointCtx({
      event: {
        instructionalAdmission: true,
        admissionTaxRateBps: EXEMPT.rateBps,
        taxRateSource: EXEMPT.source,
      },
      venueB: { region: "TN", postalCode: "37206", admissionTaxRateBps: 925 },
      saveStamp: EXEMPT,
    });

    await updateEventSettings(ctx.deps, toggleOff);

    expect(ctx.updateEventTaxRate).toHaveBeenCalledTimes(1);
    expect(ctx.updateEventTaxRate).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      admissionTaxRateBps: null,
      taxRateSource: null,
    });
    expect(ctx.getCurrentEvent()).toMatchObject({
      placeId: VENUE_B_ID,
      instructionalAdmission: false,
      admissionTaxRateBps: null,
      taxRateSource: null,
    });
    expect(ctx.placesGetById.mock.calls.some(([id]) => id === VENUE_B_ID)).toBe(
      false,
    );
  });

  it("toggle OFF, event now at TX venue B where the save stamped a real rate: left alone", async () => {
    const { ctx } = repointCtx({
      event: {
        instructionalAdmission: true,
        admissionTaxRateBps: EXEMPT.rateBps,
        taxRateSource: EXEMPT.source,
      },
    });

    await updateEventSettings(ctx.deps, toggleOff);

    expect(ctx.updateEventTaxRate).not.toHaveBeenCalled();
    expect(ctx.getCurrentEvent()).toMatchObject({
      placeId: VENUE_B_ID,
      admissionTaxRateBps: RB.rateBps,
      taxRateSource: RB.source,
    });
  });

  it("toggle OFF, event now at venue B with a 0 stamp that is NOT the TN sentinel (a real exemption): left alone", async () => {
    // A 0 rate from another source (a venue-level "exempt" rate) is a real
    // rate under either flag; only the TN-instruction sentinel is cleared.
    const { ctx } = repointCtx({
      event: {
        instructionalAdmission: true,
        admissionTaxRateBps: EXEMPT.rateBps,
        taxRateSource: EXEMPT.source,
      },
      saveStamp: { rateBps: 0, source: "exempt" },
    });

    await updateEventSettings(ctx.deps, toggleOff);

    expect(ctx.updateEventTaxRate).not.toHaveBeenCalled();
    expect(ctx.getCurrentEvent()).toMatchObject({
      placeId: VENUE_B_ID,
      admissionTaxRateBps: 0,
      taxRateSource: "exempt",
    });
  });

  it("no venue before the lock, TN venue B after it (no venue lock held at all): the sentinel is still cleared on toggle OFF", async () => {
    const { ctx } = repointCtx({
      event: {
        placeId: null,
        postalCode: "37203",
        countryCode: "US",
        region: "TN",
        instructionalAdmission: true,
        admissionTaxRateBps: EXEMPT.rateBps,
        taxRateSource: EXEMPT.source,
      },
      venueB: { region: "TN", postalCode: "37206" },
      saveStamp: EXEMPT,
    });

    await updateEventSettings(ctx.deps, toggleOff);

    expect(ctx.lockLocationsAtPlace).not.toHaveBeenCalled();
    expect(ctx.lockRows).toHaveBeenCalledTimes(1);
    expect(ctx.updateEventTaxRate).toHaveBeenCalledTimes(1);
    expect(ctx.updateEventTaxRate).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      admissionTaxRateBps: null,
      taxRateSource: null,
    });
    expect(ctx.placesGetById.mock.calls.some(([id]) => id === VENUE_B_ID)).toBe(
      false,
    );
  });

  it("the flag did not change but the event moved: no re-stamp, the save's stamp for B stands", async () => {
    // The event is already instructional; re-sending true is not a toggle.
    const { ctx } = repointCtx({ event: { instructionalAdmission: true } });

    await updateEventSettings(ctx.deps, toggleOn);

    expect(ctx.updateEventTaxRate).not.toHaveBeenCalled();
    expect(ctx.getCurrentEvent()).toMatchObject({
      placeId: VENUE_B_ID,
      admissionTaxRateBps: RB.rateBps,
      taxRateSource: RB.source,
    });
  });

  it("row-locks the event FOR UPDATE after the venue lock and before any write, then re-reads it", async () => {
    const { ctx } = repointCtx();
    const repos = ctx.deps.repos as unknown as {
      events: {
        getById: ReturnType<typeof vi.fn>;
        updateRefundCutoff: ReturnType<typeof vi.fn>;
        updateInstructionalAdmission: ReturnType<typeof vi.fn>;
      };
    };

    await updateEventSettings(ctx.deps, {
      ...toggleOn,
      refundCutoffAt: new Date("2026-08-01T00:00:00.000Z"),
    });

    expect(ctx.lockRows).toHaveBeenCalledTimes(1);
    expect(ctx.lockRows).toHaveBeenCalledWith({
      ids: [EVENT_ID],
      mode: "update",
    });
    const venueLock = ctx.lockLocationsAtPlace.mock.invocationCallOrder[0]!;
    const rowLock = ctx.lockRows.mock.invocationCallOrder[0]!;
    const firstWrite = repos.events.updateRefundCutoff.mock.invocationCallOrder[0]!;
    // Venue first, rows second (upsertPlace's order), both before any write.
    expect(venueLock).toBeLessThan(rowLock);
    expect(rowLock).toBeLessThan(firstWrite);
    // The row the transaction acts on is read between the row lock and the
    // first write.
    expect(
      repos.events.getById.mock.invocationCallOrder.some(
        (order) => order > rowLock && order < firstWrite,
      ),
    ).toBe(true);
  });
});

describe("updateEventSettings: the edit check follows the row re-read under the row lock", () => {
  it("the event changed owner before the row lock was granted: the edit check runs again for the NEW owner and refuses", async () => {
    const OTHER_HUMAN_ID = "66666666-6666-4666-8666-666666666666";
    const ctx = makeCtx({ event: makeExemptEvent(), place: makePlace() });
    // The actor holds no delegation from the new owner.
    (
      ctx.deps.repos as unknown as { authz: Record<string, unknown> }
    ).authz.getHumanDelegation = vi.fn(async () => null);
    ctx.lockRows.mockImplementation(async () => {
      ctx.commitEventChange({ humanId: OTHER_HUMAN_ID });
    });

    await expect(updateEventSettings(ctx.deps, toggleOff)).rejects.toMatchObject(
      { code: "INSUFFICIENT_ROLE" },
    );

    expect(ctx.lockRows).toHaveBeenCalledTimes(1);
    expect(ctx.updateEventTaxRate).not.toHaveBeenCalled();
  });
});
