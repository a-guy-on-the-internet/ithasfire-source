import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import type { PlaceEventLocationProjection } from "@th/types";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import {
  createFakeCalendarsRepo,
  createFakeSpacesRepo,
} from "@th/test-utils/fakes/venue-hierarchy";

import {
  configureLocationObfuscation,
  resetLocationObfuscationForTests,
} from "../../../lib/location/obfuscation-key";
import { WITHHELD_EVENT_DEFAULT_REVEAL } from "../../../lib/location/place-event-location";

/**
 * THE CASCADE (place-address-withholding D1, B4 / W2).
 *
 * Every event at a withheld venue stores the venue's PUBLIC projection; the
 * true location lives on the Place row only. So when a venue's privacy
 * changes — tighten OR loosen — `upsertPlace` must re-project every event at
 * it, inside the same transaction as the Place write, and then re-index them.
 *
 * The SQL of the re-projection (floor, ARCHIVED, DAY_BEFORE, NEVER) is pinned
 * against real Postgres in
 * `adapters/.../events-place-location.integration.test.ts`. This file pins
 * the use case: WHEN it cascades, WHAT projection it hands the repo, that the
 * exclusive lock precedes the Place write, and the reindex fan-out.
 */

const { reindexSpy } = vi.hoisted(() => ({ reindexSpy: vi.fn() }));
vi.mock("../../search/reindex-after-mutation", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../search/reindex-after-mutation")
    >();
  return {
    ...actual,
    runReindexAfterMutation: (...args: unknown[]) => reindexSpy(...args),
  };
});

import { upsertPlace } from "../upsert-place";
import { bulkUpsertPlaces } from "../bulk-upsert-places";

const NOW = new Date("2026-09-25T12:00:00.000Z");
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const PLACE_ID = "33333333-3333-4333-8333-333333333333";
const EVENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EVENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const TRUE_LAT = 36.1775;
const TRUE_LNG = -86.7412;

function house(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: PLACE_ID,
    name: "The Shelby House",
    formattedAddress: "1417 Shelby Ave, Nashville, TN 37206",
    addressLine1: "1417 Shelby Ave",
    addressLine2: null,
    city: "Nashville",
    region: "TN",
    postalCode: "37206",
    countryCode: "US",
    addressHash: "1417 shelby ave, nashville, tn 37206",
    admissionTaxRateBps: null,
    taxRateSource: null,
    taxRateFetchedAt: null,
    timezone: "America/Chicago",
    capacity: 60,
    lat: TRUE_LAT,
    lng: TRUE_LNG,
    status: "ACTIVE",
    verificationStatus: "VERIFIED",
    orgIdsWithAccess: [],
    humanIdsWithAccess: [ACTOR_ID],
    defaultPrimaryPayoutTermsId: null,
    defaultResalePayoutTermsId: null,
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as PlaceRecord;
}

/**
 * `before` is what the in-tx re-read returns; the upsert returns `before`
 * with the input's privacy fields applied (the adapter's patch semantics).
 */
function harness(opts: {
  before: PlaceRecord;
  reprojected?: string[];
  search?: boolean;
  /** How the search port's delete behaves: resolve ok, return err, or throw. */
  scrub?: "ok" | "err" | "throw";
}) {
  const order: string[] = [];
  const placesRepo = {
    getById: vi.fn(async () => opts.before),
    upsert: vi.fn(async (input: Record<string, unknown>) => {
      order.push("places.upsert");
      const next = { ...opts.before };
      if ("locationMode" in input) next.locationMode = input.locationMode as never;
      if ("locationRadiusMeters" in input) {
        next.locationRadiusMeters = input.locationRadiusMeters as never;
      }
      if ("locationLabel" in input) next.locationLabel = input.locationLabel as never;
      const geo = input.geo as { lat: number; lng: number } | undefined;
      if (geo) {
        next.lat = geo.lat;
        next.lng = geo.lng;
      }
      return next;
    }),
    updateTaxRate: vi.fn(async () => undefined),
    updateTimezone: vi.fn(async () => undefined),
  };
  const eventsRepo = {
    lockLocationsAtPlace: vi.fn(async (input: { mode: string }) => {
      order.push(`events.lock:${input.mode}`);
    }),
    reprojectLocationForPlace: vi.fn(async () => {
      order.push("events.reproject");
      return opts.reprojected ?? [EVENT_A, EVENT_B];
    }),
  };
  const auditRepo = { log: vi.fn(async () => undefined) };
  const spaces = createFakeSpacesRepo();
  const tx = {
    places: placesRepo,
    events: eventsRepo,
    audit: auditRepo,
    entityPages: { upsert: vi.fn() },
    spaces,
    calendars: createFakeCalendarsRepo({ spaces }),
  } as unknown as TxRepos;
  const repos = {
    places: placesRepo,
    humans: { getById: vi.fn(async () => ({ id: ACTOR_ID })) },
    authz: { getOrgMembership: vi.fn() },
    audit: auditRepo,
    // "commit" is recorded only when the callback RESOLVES, like a real
    // transaction: a throw inside it is a rollback.
    tx: vi.fn(async (fn: (t: TxRepos) => Promise<unknown>) => {
      const out = await fn(tx);
      order.push("commit");
      return out;
    }),
  } as unknown as Repos;

  const deleteDocuments = vi.fn(async (input: { ids?: string[] }) => {
    order.push("search.delete");
    if (opts.scrub === "throw") throw new Error("search db unreachable");
    if (opts.scrub === "err") {
      return { ok: false as const, error: new Error("delete failed") };
    }
    return { ok: true as const, value: { deleted: input.ids?.length ?? 0 } };
  });
  const idempotency = createFakeIdempotencyPort();
  const deps = {
    repos,
    idempotency,
    clock: { now: () => NOW },
    search:
      opts.search === false
        ? undefined
        : ({ deleteDocuments } as unknown as MultiSearchPort),
    reportError: vi.fn(),
  };

  const run = (privacy: Record<string, unknown>, address?: Record<string, unknown>) =>
    upsertPlace(deps, {
      placeId: PLACE_ID,
      actorHumanId: ACTOR_ID,
      owner: { kind: "human", humanId: ACTOR_ID },
      name: "The Shelby House",
      address: {
        formatted: "1417 Shelby Ave, Nashville, TN 37206",
        countryCode: "US",
        ...address,
      },
      clientKey: `cascade-${Math.random().toString(36).slice(2)}`,
      ...privacy,
    });

  return {
    run,
    placesRepo,
    eventsRepo,
    auditRepo,
    order,
    deps,
    deleteDocuments,
    idempotency,
  };
}

function projectionPassed(eventsRepo: {
  reprojectLocationForPlace: ReturnType<typeof vi.fn>;
}): PlaceEventLocationProjection {
  const call = eventsRepo.reprojectLocationForPlace.mock.calls[0]![0] as {
    projection: PlaceEventLocationProjection;
  };
  return call.projection;
}

beforeEach(() => {
  reindexSpy.mockReset();
  reindexSpy.mockImplementation(async () => undefined);
  configureLocationObfuscation({ secret: "cascade-test-secret" });
});

afterEach(() => {
  resetLocationObfuscationForTests();
});

describe("upsertPlace re-projects its events when the venue's privacy changes", () => {
  it("EXACT → fully hidden: one withheld projection, no coordinates, no street", async () => {
    const h = harness({ before: house() });

    await h.run({ locationMode: "OBSCURED", locationRadiusMeters: null });

    expect(h.eventsRepo.reprojectLocationForPlace).toHaveBeenCalledTimes(1);
    const call = h.eventsRepo.reprojectLocationForPlace.mock.calls[0]![0] as {
      placeId: string;
      now: Date;
      defaultReveal: unknown;
    };
    expect(call.placeId).toBe(PLACE_ID);
    expect(call.now).toEqual(NOW);
    // The same default the save path gives a newly-OBSCURED event.
    expect(call.defaultReveal).toEqual(WITHHELD_EVENT_DEFAULT_REVEAL);
    expect(projectionPassed(h.eventsRepo)).toEqual({
      kind: "withheld",
      venueRadiusMeters: null,
      publicCentre: null,
      addressText: "Nashville, TN",
      locality: "Nashville",
      region: "TN",
      countryCode: "US",
    });
    // Nothing handed to the repo carries the house.
    const serialized = JSON.stringify(projectionPassed(h.eventsRepo));
    expect(serialized).not.toContain("Shelby");
    expect(serialized).not.toContain("37206");
    expect(serialized).not.toContain(String(TRUE_LAT));
  });

  it("EXACT → circle: the public centre is the venue's keyed circle, not the house", async () => {
    const h = harness({ before: house() });

    await h.run({
      locationMode: "OBSCURED",
      locationRadiusMeters: 800,
      locationLabel: "East Nashville",
    });

    const projection = projectionPassed(h.eventsRepo);
    expect(projection.kind).toBe("withheld");
    if (projection.kind !== "withheld") return;
    // 800 m is snapped UP to the 1,000 m rung on write.
    expect(projection.venueRadiusMeters).toBe(1000);
    expect(projection.addressText).toBe("East Nashville");
    expect(projection.publicCentre).not.toBeNull();
    expect(projection.publicCentre!.lat).not.toBe(TRUE_LAT);
    expect(projection.publicCentre!.lng).not.toBe(TRUE_LNG);
  });

  it("hidden → EXACT: restores the TRUE columns from the Place row", async () => {
    const h = harness({
      before: house({ locationMode: "OBSCURED", locationRadiusMeters: null }),
    });

    await h.run({ locationMode: "EXACT" });

    expect(projectionPassed(h.eventsRepo)).toEqual({
      kind: "exact",
      columns: {
        lat: TRUE_LAT,
        lng: TRUE_LNG,
        geohash6: expect.any(String),
        addressText: "1417 Shelby Ave, Nashville, TN 37206",
        locality: "Nashville",
        region: "TN",
        countryCode: "US",
        postalCode: "37206",
      },
    });
  });

  it("takes the EXCLUSIVE place-location lock BEFORE writing the Place", async () => {
    const h = harness({ before: house() });

    await h.run({ locationMode: "OBSCURED", locationRadiusMeters: null });

    expect(h.order).toEqual([
      "events.lock:exclusive",
      "places.upsert",
      "events.reproject",
      "search.delete",
      "commit",
    ]);
    // And re-reads BEFORE under that lock rather than trusting the pre-tx read.
    expect(h.placesRepo.getById).toHaveBeenCalledTimes(2);
  });

  it("re-projects on a label change while withheld (an old label may say too much)", async () => {
    const h = harness({
      before: house({
        locationMode: "OBSCURED",
        locationRadiusMeters: 800,
        locationLabel: "Behind 1417 Shelby",
      }),
    });

    await h.run({ locationLabel: "East Nashville" });

    expect(h.eventsRepo.reprojectLocationForPlace).toHaveBeenCalledTimes(1);
    const projection = projectionPassed(h.eventsRepo);
    expect(projection.kind === "withheld" && projection.addressText).toBe(
      "East Nashville",
    );
  });

  it("does NOT re-project on an edit that changes nothing the events store", async () => {
    const h = harness({ before: house() });

    // EXACT stays EXACT, privacy omitted.
    await h.run({});

    expect(h.eventsRepo.reprojectLocationForPlace).not.toHaveBeenCalled();
    expect(reindexSpy).not.toHaveBeenCalled();
  });

  it("does NOT re-project, lock or reindex on CREATE (no events yet)", async () => {
    const h = harness({ before: house() });

    await upsertPlace(h.deps, {
      actorHumanId: ACTOR_ID,
      owner: { kind: "human", humanId: ACTOR_ID },
      name: "Brand New House",
      address: { formatted: "1 New St", countryCode: "US" },
      locationMode: "OBSCURED",
      clientKey: "cascade-create-1",
    });

    expect(h.eventsRepo.lockLocationsAtPlace).not.toHaveBeenCalled();
    expect(h.eventsRepo.reprojectLocationForPlace).not.toHaveBeenCalled();
  });

  it("audits the cascade inside the transaction", async () => {
    const h = harness({ before: house() });

    await h.run({ locationMode: "OBSCURED", locationRadiusMeters: null });

    expect(h.auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "place",
        entityId: PLACE_ID,
        action: "place.event_locations_reprojected",
        data: expect.objectContaining({
          fromLocationMode: "EXACT",
          toLocationMode: "OBSCURED",
          projection: "withheld",
          eventCount: 2,
        }),
      }),
    );
  });
});

describe("the re-projected events are re-indexed", () => {
  it("dispatches one event reindex per rewritten event", async () => {
    const h = harness({ before: house(), reprojected: [EVENT_A, EVENT_B] });

    await h.run({ locationMode: "OBSCURED", locationRadiusMeters: null });

    await vi.waitFor(() => expect(reindexSpy).toHaveBeenCalledTimes(2));
    expect(reindexSpy.mock.calls.map((c) => c[2])).toEqual([
      { kind: "event", id: EVENT_A },
      { kind: "event", id: EVENT_B },
    ]);
    expect(reindexSpy.mock.calls[0]![1]).toBe("upsertPlace");
  });

  it("paces the fan-out: never more than 4 index passes in flight", async () => {
    const ids = Array.from(
      { length: 10 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    let inFlight = 0;
    let peak = 0;
    reindexSpy.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
    });
    const h = harness({ before: house(), reprojected: ids });

    await h.run({ locationMode: "OBSCURED", locationRadiusMeters: null });

    await vi.waitFor(() => expect(reindexSpy).toHaveBeenCalledTimes(10));
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("a failing reindex is reported, never thrown at the caller", async () => {
    reindexSpy.mockImplementation(async () => {
      throw new Error("index down");
    });
    const h = harness({ before: house(), reprojected: [EVENT_A] });

    await expect(
      h.run({ locationMode: "OBSCURED", locationRadiusMeters: null }),
    ).resolves.toBeDefined();

    await vi.waitFor(() => expect(h.deps.reportError).toHaveBeenCalled());
    expect(h.deps.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "upsertPlace", op: "reindexReprojectedEvents" },
      }),
    );
  });

  it("skips the fan-out when search is not wired", async () => {
    const h = harness({ before: house(), search: false });

    await h.run({ locationMode: "OBSCURED", locationRadiusMeters: null });

    // The rows are still re-projected — only the index pass is skipped.
    expect(h.eventsRepo.reprojectLocationForPlace).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 5));
    expect(reindexSpy).not.toHaveBeenCalled();
  });
});

/**
 * FAIL-CLOSED SEARCH SCRUB (`search/privacy-scrub.ts`). Search plots venues
 * and events on a public map from their documents, and the post-commit
 * reindex is best-effort. So a save that leaves the venue withheld deletes
 * the documents BEFORE commit and fails if it cannot.
 */
describe("upsertPlace scrubs the search index before committing a withheld location", () => {
  it("EXACT → hidden: deletes the venue AND every re-projected event document, before commit", async () => {
    const h = harness({ before: house(), reprojected: [EVENT_A, EVENT_B] });

    await h.run({ locationMode: "OBSCURED", locationRadiusMeters: null });

    expect(h.deleteDocuments).toHaveBeenCalledTimes(1);
    expect(h.deleteDocuments).toHaveBeenCalledWith({
      ids: [`place_${PLACE_ID}`, `event_${EVENT_A}`, `event_${EVENT_B}`],
    });
    // Inside the transaction, as its last step.
    expect(h.order.indexOf("search.delete")).toBeLessThan(
      h.order.indexOf("commit"),
    );
    expect(h.order.at(-1)).toBe("commit");
  });

  it("scrubs on EXACT → circle, on a bigger circle, and on a moved point while withheld", async () => {
    const tighten = harness({ before: house() });
    await tighten.run({ locationMode: "OBSCURED", locationRadiusMeters: 800 });
    expect(tighten.deleteDocuments).toHaveBeenCalledTimes(1);

    const widen = harness({
      before: house({ locationMode: "OBSCURED", locationRadiusMeters: 500 }),
    });
    await widen.run({ locationRadiusMeters: 2000 });
    expect(widen.deleteDocuments).toHaveBeenCalledTimes(1);

    const moved = harness({
      before: house({ locationMode: "OBSCURED", locationRadiusMeters: 1000 }),
    });
    await moved.run({}, { lat: 36.2, lng: -86.7 });
    expect(moved.deleteDocuments).toHaveBeenCalledTimes(1);
  });

  it("does NOT scrub a loosening (hidden → EXACT) or an edit that leaves the location alone", async () => {
    const loosen = harness({
      before: house({ locationMode: "OBSCURED", locationRadiusMeters: null }),
    });
    await loosen.run({ locationMode: "EXACT" });
    expect(loosen.deleteDocuments).not.toHaveBeenCalled();

    const unrelated = harness({ before: house() });
    await unrelated.run({});
    expect(unrelated.deleteDocuments).not.toHaveBeenCalled();
  });

  it.each(["err", "throw"] as const)(
    "a failed scrub (%s) FAILS the save: nothing commits, the error is retryable, the key is released",
    async (mode) => {
      const h = harness({ before: house(), scrub: mode });

      await expect(
        h.run({ locationMode: "OBSCURED", locationRadiusMeters: null }),
      ).rejects.toMatchObject({
        code: "SEARCH_UPDATE_RETRY",
      });

      // Rolled back: the old (EXACT) place row stands, so the old document
      // is still the right one. No state has "withheld + old pin served".
      expect(h.order).not.toContain("commit");
      // No post-commit reindex ran against a half-state.
      await new Promise((r) => setTimeout(r, 5));
      expect(reindexSpy).not.toHaveBeenCalled();
    },
  );

  it("the owner's retry after a failed scrub goes through", async () => {
    let calls = 0;
    const h = harness({ before: house() });
    h.deleteDocuments.mockImplementation(async (input: { ids?: string[] }) => {
      calls += 1;
      if (calls === 1) {
        return { ok: false as const, error: new Error("blip") };
      }
      return { ok: true as const, value: { deleted: input.ids?.length ?? 0 } };
    });
    const input = {
      placeId: PLACE_ID,
      actorHumanId: ACTOR_ID,
      owner: { kind: "human" as const, humanId: ACTOR_ID },
      name: "The Shelby House",
      address: {
        formatted: "1417 Shelby Ave, Nashville, TN 37206",
        countryCode: "US",
      },
      locationMode: "OBSCURED" as const,
      locationRadiusMeters: null,
      clientKey: "cascade-retry-same-key",
    };

    await expect(upsertPlace(h.deps, input)).rejects.toMatchObject({
      code: "SEARCH_UPDATE_RETRY",
    });
    // SAME clientKey: the failed attempt must not be replayed as a success.
    await expect(upsertPlace(h.deps, input)).resolves.toMatchObject({
      placeId: PLACE_ID,
    });
    expect(h.deleteDocuments).toHaveBeenCalledTimes(2);
    expect(h.order.filter((o) => o === "commit")).toHaveLength(1);
    // Released (owner-checked), never a 15-minute `failed:` marker.
    expect(h.idempotency.release).toHaveBeenCalledTimes(1);
    expect(h.idempotency.fail).not.toHaveBeenCalled();
  });

  it("keeps the claim when the save committed and only the idempotency commit throws", async () => {
    const h = harness({ before: house() });
    vi.spyOn(h.idempotency, "commit").mockRejectedValueOnce(
      new Error("redis down"),
    );
    const input = {
      placeId: PLACE_ID,
      actorHumanId: ACTOR_ID,
      owner: { kind: "human" as const, humanId: ACTOR_ID },
      name: "The Shelby House",
      address: {
        formatted: "1417 Shelby Ave, Nashville, TN 37206",
        countryCode: "US",
      },
      locationMode: "OBSCURED" as const,
      locationRadiusMeters: null,
      clientKey: "cascade-commit-throws",
    };

    await expect(upsertPlace(h.deps, input)).rejects.toMatchObject({
      code: "dependency_failed",
      message: "upsert_place",
      cause: expect.objectContaining({ message: "redis down" }),
    });
    // A same-key retry is refused, so committed work cannot be redone.
    await expect(upsertPlace(h.deps, input)).rejects.toMatchObject({
      code: "IDEMPOTENCY_LOCK_IN_PROGRESS",
    });

    expect(h.order.filter((o) => o === "commit")).toHaveLength(1);
    expect(h.idempotency.release).not.toHaveBeenCalled();
    expect(h.idempotency.fail).not.toHaveBeenCalled();
  });


  it("no search port wired: no scrub, the save still commits", async () => {
    const h = harness({ before: house(), search: false });

    await h.run({ locationMode: "OBSCURED", locationRadiusMeters: null });

    expect(h.order).toContain("commit");
  });
});

describe("bulkUpsertPlaces inherits the fail-closed scrub", () => {
  it.each(["err", "throw"] as const)(
    "a failed scrub (%s) is that ITEM's error, and nothing of it commits",
    async (mode) => {
      const h = harness({ before: house(), scrub: mode });

      const result = await bulkUpsertPlaces(h.deps, {
        actorHumanId: ACTOR_ID,
        places: [
          {
            placeId: PLACE_ID,
            owner: { kind: "human", humanId: ACTOR_ID },
            name: "The Shelby House",
            address: {
              formatted: "1417 Shelby Ave, Nashville, TN 37206",
              countryCode: "US",
            },
            locationMode: "OBSCURED",
            locationRadiusMeters: null,
            clientKey: `bulk-scrub-${mode}`,
          },
        ],
      });

      expect(result).toMatchObject({ total: 1, imported: 0, skipped: 1 });
      expect(result.results).toEqual([
        { index: 0, error: "SEARCH_UPDATE_RETRY" },
      ]);
      expect(h.order).toContain("search.delete");
      expect(h.order).not.toContain("commit");
    },
  );
});
