import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";

import {
  WITHHELD_EVENT_DEFAULT_REVEAL,
  projectEventLocationAtPlace,
} from "../../../lib/location/place-event-location";

const { reindexSpy } = vi.hoisted(() => ({ reindexSpy: vi.fn() }));
vi.mock("../../search/reindex-after-mutation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../search/reindex-after-mutation")>();
  return {
    ...actual,
    runReindexAfterMutation: (...args: unknown[]) => reindexSpy(...args),
  };
});

import {
  eventLocationIsStale,
  reprojectWithheldPlaceLocations,
} from "../reproject-withheld-place-locations";

/**
 * The rotation / geometry re-projection tool. Pins: which rows count as stale,
 * that a dry run never writes, that a write goes through the upsertPlace
 * cascade path (exclusive lock → re-read → reprojectLocationForPlace → audit,
 * in one tx) and re-indexes, and that a second run is a no-op.
 */

const NOW = new Date("2026-09-25T12:00:00.000Z");
const HOUSE_ID = "33333333-3333-4333-8333-333333333333";
const CLUB_ID = "44444444-4444-4444-8444-444444444444";
const EVENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EVENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function place(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: HOUSE_ID,
    name: "Shelby House",
    formattedAddress: "1417 Shelby Ave, Nashville, TN 37206",
    city: "Nashville",
    region: "TN",
    postalCode: "37206",
    countryCode: "US",
    lat: 36.1775,
    lng: -86.7412,
    locationMode: "OBSCURED",
    locationRadiusMeters: 800,
    locationLabel: "East Nashville",
    ...overrides,
  } as PlaceRecord;
}

/** An event row exactly as the cascade would store it at `venue` now. */
function upToDateEvent(id: string, venue: PlaceRecord): EventRecord {
  const at = projectEventLocationAtPlace(venue, {
    locationMode: "OBSCURED",
    locationRadiusMeters: 800,
  });
  if (!at.withheld) throw new Error("expected a withheld projection");
  return {
    id,
    placeId: venue.id,
    locationMode: at.privacy.locationMode,
    locationRadiusMeters: at.privacy.locationRadiusMeters,
    ...at.columns,
  } as unknown as EventRecord;
}

function harness(opts: {
  places: Record<string, PlaceRecord | null>;
  events: Record<string, EventRecord[]>;
}) {
  const order: string[] = [];
  const reproject = vi.fn(async ({ placeId }: { placeId: string }) => {
    order.push(`reproject:${placeId}`);
    return (opts.events[placeId] ?? []).map((event) => event.id);
  });
  const lock = vi.fn(async ({ placeId, mode }: { placeId: string; mode: string }) => {
    order.push(`lock:${mode}:${placeId}`);
  });
  const audit = vi.fn(async () => undefined);
  const getById = vi.fn(async (id: string) => opts.places[id] ?? null);
  const listAllByPlace = vi.fn(
    async ({ placeId }: { placeId: string }) => opts.events[placeId] ?? [],
  );
  const txRepos = {
    places: { getById },
    events: { lockLocationsAtPlace: lock, reprojectLocationForPlace: reproject },
    audit: { log: audit },
  };
  const repos = {
    places: { getById },
    events: { listAllByPlace },
    tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txRepos)),
  } as unknown as Repos;
  return { repos, order, reproject, lock, audit, listAllByPlace };
}

const deps = (repos: Repos, search = true) => ({
  repos,
  clock: { now: () => NOW },
  ...(search ? { search: {} as MultiSearchPort } : {}),
});

beforeEach(() => {
  reindexSpy.mockReset();
  reindexSpy.mockResolvedValue(undefined);
});

describe("eventLocationIsStale", () => {
  it("a row stored exactly as the projection says NOW is not stale", () => {
    const venue = place();
    expect(eventLocationIsStale(venue, upToDateEvent(EVENT_A, venue))).toBe(false);
  });

  it("a last-digit float8 round-trip difference is NOT stale (no rewrite loop)", () => {
    const venue = place();
    const row = upToDateEvent(EVENT_A, venue);
    expect(
      eventLocationIsStale(venue, {
        ...row,
        lat: (row.lat as number) + 4e-15,
        lng: (row.lng as number) - 4e-15,
      }),
    ).toBe(false);
  });

  it("an OLD public centre (the geometry moved, or the key rotated) is stale", () => {
    const venue = place();
    const row = upToDateEvent(EVENT_A, venue);
    expect(
      eventLocationIsStale(venue, { ...row, lat: (row.lat as number) + 0.001 }),
    ).toBe(true);
  });

  it("a leaked TRUE copy (street, postcode, true pin) is stale", () => {
    const venue = place();
    const row = upToDateEvent(EVENT_A, venue);
    expect(
      eventLocationIsStale(venue, {
        ...row,
        addressText: venue.formattedAddress,
        postalCode: "37206",
      } as EventRecord),
    ).toBe(true);
  });
});

describe("reprojectWithheldPlaceLocations", () => {
  it("DRY RUN (the default) reports what is stale and writes NOTHING", async () => {
    const venue = place();
    const fresh = upToDateEvent(EVENT_A, venue);
    const stale = { ...upToDateEvent(EVENT_B, venue), lat: 36.2, lng: -86.7 };
    const h = harness({
      places: { [HOUSE_ID]: venue },
      events: { [HOUSE_ID]: [fresh, stale] },
    });

    const out = await reprojectWithheldPlaceLocations(deps(h.repos), {
      placeIds: [HOUSE_ID],
    });

    expect(out.dryRun).toBe(true);
    expect(out.places[0]).toMatchObject({
      placeId: HOUSE_ID,
      outcome: "would_reproject",
      eventCount: 2,
      staleEventIds: [EVENT_B],
      staleCentres: [{ lat: 36.2, lng: -86.7 }],
      reprojectedEventIds: [],
    });
    expect(out.places[0]!.publicCentre).not.toBeNull();
    expect(h.repos.tx).not.toHaveBeenCalled();
    expect(h.reproject).not.toHaveBeenCalled();
    expect(reindexSpy).not.toHaveBeenCalled();
  });

  it("WRITE: the cascade path under the exclusive lock, audited, then events + venue re-indexed", async () => {
    const venue = place();
    const stale = { ...upToDateEvent(EVENT_A, venue), lat: 36.2, lng: -86.7 };
    const h = harness({
      places: { [HOUSE_ID]: venue },
      events: { [HOUSE_ID]: [stale] },
    });

    const out = await reprojectWithheldPlaceLocations(deps(h.repos), {
      placeIds: [HOUSE_ID],
      dryRun: false,
    });

    expect(out.places[0]).toMatchObject({
      outcome: "reprojected",
      reprojectedEventIds: [EVENT_A],
    });
    expect(h.order).toEqual([`lock:exclusive:${HOUSE_ID}`, `reproject:${HOUSE_ID}`]);
    expect(h.reproject).toHaveBeenCalledWith(
      expect.objectContaining({
        placeId: HOUSE_ID,
        now: NOW,
        defaultReveal: WITHHELD_EVENT_DEFAULT_REVEAL,
        projection: expect.objectContaining({ kind: "withheld" }),
      }),
    );
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "place",
        entityId: HOUSE_ID,
        action: "place.event_locations_reprojected",
        data: expect.objectContaining({ reason: "obfuscation_reprojection" }),
      }),
    );
    expect(reindexSpy.mock.calls.map((call) => call[2])).toEqual([
      { kind: "event", id: EVENT_A },
      { kind: "place", id: HOUSE_ID },
    ]);
    expect(out.totals).toMatchObject({ staleEvents: 1, reprojectedEvents: 1 });
  });

  it("IDEMPOTENT: up-to-date rows are never written — a second run is a no-op", async () => {
    const venue = place();
    const h = harness({
      places: { [HOUSE_ID]: venue },
      events: { [HOUSE_ID]: [upToDateEvent(EVENT_A, venue)] },
    });

    const out = await reprojectWithheldPlaceLocations(deps(h.repos), {
      placeIds: [HOUSE_ID, HOUSE_ID],
      dryRun: false,
    });

    expect(out.places).toHaveLength(1);
    expect(out.places[0]!.outcome).toBe("up_to_date");
    expect(h.repos.tx).not.toHaveBeenCalled();
    expect(reindexSpy).not.toHaveBeenCalled();
  });

  it("skips EXACT venues and missing rows; a venue un-withheld under the lock is not written", async () => {
    const racing = place();
    const h = harness({
      places: { [CLUB_ID]: place({ id: CLUB_ID, locationMode: "EXACT" }) },
      events: {},
    });
    const outcome = await reprojectWithheldPlaceLocations(deps(h.repos), {
      placeIds: [CLUB_ID, "55555555-5555-4555-8555-555555555555"],
      dryRun: false,
    });
    expect(outcome.places.map((p) => p.outcome)).toEqual(["not_withheld", "missing"]);
    expect(h.listAllByPlace).not.toHaveBeenCalled();

    // Withheld at the first read, EXACT once the lock is held.
    const stale = { ...upToDateEvent(EVENT_A, racing), lat: 1, lng: 1 };
    let reads = 0;
    const raced = harness({ places: { [HOUSE_ID]: racing }, events: { [HOUSE_ID]: [stale] } });
    (raced.repos.places.getById as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      (reads += 1) === 1 ? racing : place({ locationMode: "EXACT" }),
    );
    const out = await reprojectWithheldPlaceLocations(deps(raced.repos), {
      placeIds: [HOUSE_ID],
      dryRun: false,
    });
    expect(out.places[0]!.outcome).toBe("not_withheld");
    expect(raced.reproject).not.toHaveBeenCalled();
  });

  it("a REJECTED reindex is counted and reported, never thrown", async () => {
    const venue = place();
    const stale = { ...upToDateEvent(EVENT_A, venue), lat: 1, lng: 1 };
    const h = harness({ places: { [HOUSE_ID]: venue }, events: { [HOUSE_ID]: [stale] } });
    reindexSpy.mockRejectedValueOnce(new Error("search down"));
    const reportError = vi.fn();
    const out = await reprojectWithheldPlaceLocations(
      { ...deps(h.repos), reportError },
      { placeIds: [HOUSE_ID], dryRun: false },
    );
    expect(out.totals.reindexFailures).toBe(1);
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
