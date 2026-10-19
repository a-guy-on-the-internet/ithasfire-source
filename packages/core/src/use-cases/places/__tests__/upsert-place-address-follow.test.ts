import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import type { FollowPlaceAddressInput } from "@th/types";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import {
  createFakeCalendarsRepo,
  createFakeSpacesRepo,
} from "@th/test-utils/fakes/venue-hierarchy";

/**
 * EVENTS FOLLOW THEIR PLACE'S ADDRESS EDITS (owner ruling 2026-10-14).
 *
 * An EXACT → EXACT address edit re-projects the place's new address onto its
 * UPCOMING events, inside the place write's transaction. The scope SQL
 * (DRAFT/PUBLISHED, endsAt > now; ended and archived rows untouched) is
 * pinned against Postgres in
 * `adapters/.../events-place-location.integration.test.ts`; this file pins the
 * use case: WHEN it fires, what it hands the repo, the audit row, the reindex
 * marks and fan-out, the timezone skip, and that a failure fails the write.
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
import {
  FOLLOW_AUDIT_MAX_IDS,
  followPlaceAddressOntoEvents,
} from "../_shared/follow-place-address";

const NOW = new Date("2026-10-14T12:00:00.000Z");
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const PLACE_ID = "33333333-3333-4333-8333-333333333333";
const EVENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EVENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const OLD = {
  formatted: "1417 Shelby Ave, Nashville, TN 37206",
  line1: "1417 Shelby Ave",
  city: "Nashville",
  region: "TN",
  postalCode: "37206",
  countryCode: "US",
  lat: 36.1775,
  lng: -86.7412,
};
const NEW = {
  ...OLD,
  formatted: "1500 Shelby Ave, Nashville, TN 37206",
  line1: "1500 Shelby Ave",
  lat: 36.1781,
  lng: -86.7389,
};

function place(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: PLACE_ID,
    name: "The Shelby House",
    formattedAddress: OLD.formatted,
    addressLine1: OLD.line1,
    addressLine2: null,
    city: OLD.city,
    region: OLD.region,
    postalCode: OLD.postalCode,
    countryCode: OLD.countryCode,
    addressHash: OLD.formatted.toLowerCase(),
    admissionTaxRateBps: null,
    taxRateSource: null,
    taxRateFetchedAt: null,
    timezone: "America/Chicago",
    capacity: 60,
    lat: OLD.lat,
    lng: OLD.lng,
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

/** The adapter's patch semantics: address + geo + privacy from the input. */
function applyWrite(
  before: PlaceRecord,
  input: Record<string, unknown>,
): PlaceRecord {
  const next = { ...before, name: input.name as string };
  const a = input.address as typeof OLD | undefined;
  if (a) {
    next.formattedAddress = a.formatted;
    next.addressLine1 = a.line1;
    next.city = a.city ?? null;
    next.region = a.region ?? null;
    next.postalCode = a.postalCode ?? null;
    next.countryCode = a.countryCode;
    next.addressHash = a.formatted.trim().toLowerCase();
  }
  const geo = input.geo as { lat: number; lng: number } | undefined;
  if (geo) {
    next.lat = geo.lat;
    next.lng = geo.lng;
  }
  if ("locationMode" in input) next.locationMode = input.locationMode as never;
  if ("locationRadiusMeters" in input) {
    next.locationRadiusMeters = input.locationRadiusMeters as never;
  }
  return next;
}

function harness(opts: {
  before?: PlaceRecord;
  followed?: string[];
  skipped?: string[];
  followThrows?: boolean;
  timezone?: string | null;
}) {
  const before = opts.before ?? place();
  const order: string[] = [];
  const placesRepo = {
    getById: vi.fn(async () => before),
    upsert: vi.fn(async (input: Record<string, unknown>) => {
      order.push("places.upsert");
      return applyWrite(before, input);
    }),
    updateTaxRate: vi.fn(async () => undefined),
    updateTimezone: vi.fn(async () => undefined),
  };
  const eventsRepo = {
    lockLocationsAtPlace: vi.fn(async () => undefined),
    reprojectLocationForPlace: vi.fn(async () => {
      order.push("events.reproject");
      return [] as string[];
    }),
    followPlaceAddress: vi.fn(async () => {
      order.push("events.follow");
      if (opts.followThrows) throw new Error("db down");
      return {
        followedIds: opts.followed ?? [EVENT_A, EVENT_B],
        skippedIds: opts.skipped ?? [],
      };
    }),
  };
  const auditRepo = { log: vi.fn(async () => undefined) };
  const searchReindexPending = { mark: vi.fn(async () => undefined) };
  const spaces = createFakeSpacesRepo();
  const tx = {
    places: placesRepo,
    events: eventsRepo,
    audit: auditRepo,
    searchReindexPending,
    entityPages: { upsert: vi.fn() },
    spaces,
    calendars: createFakeCalendarsRepo({ spaces }),
  } as unknown as TxRepos;
  const repos = {
    places: placesRepo,
    humans: { getById: vi.fn(async () => ({ id: ACTOR_ID })) },
    authz: { getOrgMembership: vi.fn() },
    audit: auditRepo,
    tx: vi.fn(async (fn: (t: TxRepos) => Promise<unknown>) => {
      const out = await fn(tx);
      order.push("commit");
      return out;
    }),
  } as unknown as Repos;
  const deps = {
    repos,
    idempotency: createFakeIdempotencyPort(),
    clock: { now: () => NOW },
    search: {
      deleteDocuments: vi.fn(async () => ({ ok: true, value: { deleted: 0 } })),
    } as unknown as MultiSearchPort,
    timezoneLookup:
      opts.timezone === undefined ? undefined : vi.fn(() => opts.timezone!),
    reportError: vi.fn(),
  };

  const run = (
    address: typeof OLD,
    extra: Record<string, unknown> = {},
  ) =>
    upsertPlace(deps, {
      placeId: PLACE_ID,
      actorHumanId: ACTOR_ID,
      owner: { kind: "human", humanId: ACTOR_ID },
      name: "The Shelby House",
      address,
      clientKey: `follow-${Math.random().toString(36).slice(2)}`,
      ...extra,
    });

  return {
    run,
    order,
    eventsRepo,
    auditRepo,
    searchReindexPending,
    deps,
  };
}

beforeEach(() => {
  reindexSpy.mockReset();
  reindexSpy.mockImplementation(async () => undefined);
});

function followCall(eventsRepo: {
  followPlaceAddress: ReturnType<typeof vi.fn>;
}): FollowPlaceAddressInput {
  return eventsRepo.followPlaceAddress.mock.calls[0]![0] as FollowPlaceAddressInput;
}

function auditRow(
  auditRepo: { log: ReturnType<typeof vi.fn> },
  action: string,
): Record<string, unknown> | undefined {
  return auditRepo.log.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .find((row) => row.action === action);
}

describe("upsertPlace: events follow an EXACT place's address edit", () => {
  it("writes the NEW address onto upcoming events in the place's zone, in the same tx", async () => {
    const h = harness({});

    await h.run(NEW);

    expect(h.eventsRepo.followPlaceAddress).toHaveBeenCalledTimes(1);
    const call = followCall(h.eventsRepo);
    expect(call.placeId).toBe(PLACE_ID);
    expect(call.now).toEqual(NOW);
    // No lookup configured → the place's stored zone.
    expect(call.timezone).toBe("America/Chicago");
    expect(call.columns).toEqual({
      lat: NEW.lat,
      lng: NEW.lng,
      geohash6: expect.any(String),
      addressText: NEW.formatted,
      locality: "Nashville",
      region: "TN",
      countryCode: "US",
      postalCode: "37206",
    });
    // The privacy cascade does not run; the follow precedes the commit.
    expect(h.eventsRepo.reprojectLocationForPlace).not.toHaveBeenCalled();
    expect(h.order).toEqual(["places.upsert", "events.follow", "commit"]);
  });

  it("writes one audit row naming the events and both addresses", async () => {
    const h = harness({});

    await h.run(NEW);

    expect(auditRow(h.auditRepo, "place.events_address_followed")).toMatchObject({
      entity: "place",
      entityId: PLACE_ID,
      at: NOW,
      data: {
        actorHumanId: ACTOR_ID,
        eventIds: [EVENT_A, EVENT_B],
        eventCount: 2,
        placeTimezone: "America/Chicago",
        fromAddress: { addressText: OLD.formatted, lat: OLD.lat },
        toAddress: { addressText: NEW.formatted, lat: NEW.lat },
      },
    });
    expect(auditRow(h.auditRepo, "place.events_address_follow_skipped")).toBeUndefined();
  });

  it("marks the followed events for search reindex and re-indexes them after commit", async () => {
    const h = harness({});

    await h.run(NEW);

    expect(h.searchReindexPending.mark).toHaveBeenCalledTimes(1);
    const marked = (
      h.searchReindexPending.mark.mock.calls[0] as unknown as [
        Array<{ entityType: string; entityId: string }>,
      ]
    )[0];
    expect(marked).toEqual(
      expect.arrayContaining([
        { entityType: "place", entityId: PLACE_ID },
        { entityType: "event", entityId: EVENT_A },
        { entityType: "event", entityId: EVENT_B },
      ]),
    );
    await vi.waitFor(() => {
      const reindexed = reindexSpy.mock.calls.map(
        (c) => (c[2] as { kind: string; id: string }).id,
      );
      expect(reindexed).toEqual(expect.arrayContaining([EVENT_A, EVENT_B]));
    });
  });

  it("does NOT follow a name-only edit", async () => {
    const h = harness({});

    await h.run(OLD, { name: "The Shelby House (renamed)" });

    expect(h.eventsRepo.followPlaceAddress).not.toHaveBeenCalled();
    expect(auditRow(h.auditRepo, "place.events_address_followed")).toBeUndefined();
    expect(reindexSpy).not.toHaveBeenCalled();
  });

  it("does NOT follow a privacy change; the cascade owns it", async () => {
    const h = harness({});

    await h.run(NEW, { locationMode: "OBSCURED", locationRadiusMeters: null });

    expect(h.eventsRepo.reprojectLocationForPlace).toHaveBeenCalledTimes(1);
    expect(h.eventsRepo.followPlaceAddress).not.toHaveBeenCalled();
  });

  it("passes the zone this write DERIVED, and audits events in another zone as skipped", async () => {
    const h = harness({
      timezone: "America/Denver",
      followed: [],
      skipped: [EVENT_A],
    });

    await h.run(NEW);

    expect(followCall(h.eventsRepo).timezone).toBe("America/Denver");
    expect(auditRow(h.auditRepo, "place.events_address_followed")).toBeUndefined();
    expect(auditRow(h.auditRepo, "place.events_address_follow_skipped")).toMatchObject({
      data: {
        reason: "timezone_differs",
        placeTimezone: "America/Denver",
        eventIds: [EVENT_A],
        eventCount: 1,
      },
    });
  });

  it("re-derives the zone on a pin move that kept the address text", async () => {
    const h = harness({ timezone: "America/Chicago" });

    // Same formatted string (same addressHash), new coordinates.
    await h.run({ ...OLD, lat: NEW.lat, lng: NEW.lng });

    expect(h.deps.timezoneLookup).toHaveBeenCalledWith(NEW.lat, NEW.lng);
    expect(h.eventsRepo.followPlaceAddress).toHaveBeenCalledTimes(1);
  });

  it("zone unknown (legacy null zone, no lookup): passes null; skipped rows say timezone_unknown", async () => {
    const h = harness({
      before: place({ timezone: null }),
      followed: [],
      skipped: [EVENT_A, EVENT_B],
    });

    await h.run(NEW);

    expect(followCall(h.eventsRepo).timezone).toBeNull();
    expect(auditRow(h.auditRepo, "place.events_address_follow_skipped")).toMatchObject({
      data: { reason: "timezone_unknown", eventCount: 2 },
    });
  });

  it("a follow failure fails the place write (rolled back, not swallowed)", async () => {
    const h = harness({ followThrows: true });

    await expect(h.run(NEW)).rejects.toBeTruthy();

    expect(h.order).not.toContain("commit");
    expect(h.deps.reportError).not.toHaveBeenCalled();
  });
});

describe("followPlaceAddressOntoEvents", () => {
  function tx(followedIds: string[], skippedIds: string[] = []) {
    return {
      events: {
        followPlaceAddress: vi.fn(async () => ({ followedIds, skippedIds })),
      },
      audit: { log: vi.fn(async () => undefined) },
    } as unknown as Pick<TxRepos, "events" | "audit"> & {
      audit: { log: ReturnType<typeof vi.fn> };
      events: { followPlaceAddress: ReturnType<typeof vi.fn> };
    };
  }
  const after = applyWrite(place(), {
    name: "The Shelby House",
    address: NEW,
    geo: { lat: NEW.lat, lng: NEW.lng },
  });
  const base = {
    placeBefore: place(),
    placeAfter: after,
    placeTimezone: "America/Chicago",
    actorHumanId: ACTOR_ID,
    at: NOW,
  };

  it("returns the followed and skipped ids (the hook for a future holder notice)", async () => {
    const out = await followPlaceAddressOntoEvents(tx([EVENT_A], [EVENT_B]), base);

    expect(out).toEqual({
      kind: "applied",
      eventIds: [EVENT_A],
      skippedEventIds: [EVENT_B],
    });
  });

  it("caps the audited ids at FOLLOW_AUDIT_MAX_IDS and keeps the full count", async () => {
    const ids = Array.from({ length: FOLLOW_AUDIT_MAX_IDS + 5 }, (_, i) => `ev-${i}`);
    const t = tx(ids);

    await followPlaceAddressOntoEvents(t, base);

    const data = (t.audit.log.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect((data.eventIds as string[]).length).toBe(FOLLOW_AUDIT_MAX_IDS);
    expect(data.truncated).toBe(true);
    expect(data.eventCount).toBe(FOLLOW_AUDIT_MAX_IDS + 5);
  });

  it("returns not_applicable with no ids when nothing the events copy changed", async () => {
    const t = tx([EVENT_A]);
    const out = await followPlaceAddressOntoEvents(t, {
      ...base,
      placeAfter: place({ name: "Renamed" }),
    });

    expect(out).toEqual({ kind: "not_applicable", eventIds: [], skippedEventIds: [] });
    expect(t.events.followPlaceAddress).not.toHaveBeenCalled();
    expect(t.audit.log).not.toHaveBeenCalled();
  });

  it("does not follow from or to a withheld place", async () => {
    const t = tx([EVENT_A]);
    const out = await followPlaceAddressOntoEvents(t, {
      ...base,
      placeBefore: place({ locationMode: "OBSCURED", locationRadiusMeters: 800 }),
      placeAfter: { ...after, locationMode: "OBSCURED", locationRadiusMeters: 800 },
    });

    expect(out.kind).toBe("not_applicable");
    expect(t.events.followPlaceAddress).not.toHaveBeenCalled();
  });
});
