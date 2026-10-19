import { beforeAll, describe, expect, it, vi } from "vitest";

import type { EventDateRecord } from "@th/ports/repos/event-dates";
import type { EventRecord } from "@th/ports/repos/events";
import type { PlaceRecord } from "@th/ports/repos/places";

import { configureLocationObfuscation } from "../../../lib/location/obfuscation-key";
import {
  buildOwnerCalendarFeed,
  buildPlaceCalendarFeed,
  feedSequence,
  PUBLIC_CALENDAR_FEED_NOT_FOUND_CODES,
  type PublicCalendarFeedDeps,
} from "../public-calendar-feeds";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-05-01T12:00:00Z");
const PLACE_ID = "aaaaaaaa-1111-4111-a111-aaaaaaaaaaaa";
const ORG_ID = "aaaaaaaa-2222-4222-a222-aaaaaaaaaaaa";
const HUMAN_ID = "aaaaaaaa-3333-4333-a333-aaaaaaaaaaaa";
const BASE = "https://web.example.test";
const UPDATED = new Date("2026-04-20T09:15:00Z");

let seq = 0;
const uuid = (prefix: string) =>
  `${prefix}-${String(++seq).padStart(4, "0")}-4000-8000-000000000000`;

function makePlace(overrides: Partial<PlaceRecord> = {}): PlaceRecord {
  return {
    id: PLACE_ID,
    name: "The Room",
    formattedAddress: "1 Room St, Nashville, TN",
    city: "Nashville",
    region: "TN",
    lat: 36.16,
    lng: -86.77,
    locationMode: "EXACT",
    locationRadiusMeters: null,
    status: "ACTIVE",
    verificationStatus: "VERIFIED",
    orgIdsWithAccess: [ORG_ID],
    humanIdsWithAccess: [],
    ...overrides,
  } as unknown as PlaceRecord;
}

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  const id = overrides.id ?? uuid("eeeeeeee");
  return {
    id,
    orgId: ORG_ID,
    humanId: null,
    title: `Show ${id.slice(9, 13)}`,
    slug: `show-${id.slice(9, 13)}`,
    status: "PUBLISHED",
    visibility: "PUBLIC",
    gateType: "NONE",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    placeId: PLACE_ID,
    addressText: null,
    locality: "Nashville",
    region: "TN",
    lat: 36.16,
    lng: -86.77,
    timezone: "America/Chicago",
    startsAt: new Date("2026-05-10T20:00:00Z"),
    endsAt: null,
    publishedAt: new Date("2026-04-01T00:00:00Z"),
    updatedAt: UPDATED,
    ...overrides,
  } as EventRecord;
}

function night(
  eventId: string,
  startsAt: string,
  status: "SCHEDULED" | "CANCELLED" = "SCHEDULED",
  updatedAt: Date = status === "CANCELLED" ? new Date("2026-04-25T08:00:00Z") : UPDATED,
): EventDateRecord {
  return {
    id: uuid("dddddddd"),
    eventId,
    ordinal: 0,
    startsAt: new Date(startsAt),
    endsAt: null,
    status,
    createdAt: UPDATED,
    updatedAt,
  };
}

/**
 * Repo fakes that honour the filters the way the Prisma adapter does
 * (status / visibility / cancelledWhilePublished / window incl. the EventDate arm /
 * order / limit), so the use case is tested against realistic reads.
 */
function makeDeps(opts: {
  events?: EventRecord[];
  dates?: EventDateRecord[];
  place?: PlaceRecord | null;
  org?: { id: string; name: string; status: string } | null;
  human?: { id: string; name: string | null; status: string } | null;
  /** Event ids whose owner the ban rule withholds (adapter-side in prod). */
  withheldEventIds?: string[];
}) {
  const corpus = opts.events ?? [];
  const withheld = new Set(opts.withheldEventIds ?? []);
  const dates = opts.dates ?? [];
  // Mirrors the adapter's CANCELLED_WHILE_PUBLISHED_WHERE: PUBLISHED when
  // cancelled; NULL (cancelled before the column existed) is excluded.
  const cancelledWhilePublished = (e: EventRecord) =>
    e.cancelledFromStatus === "PUBLISHED";
  const dateArm = (
    e: EventRecord,
    statuses: ReadonlyArray<string> | undefined,
    inWindow: (d: Date) => boolean,
  ) =>
    dates.some(
      (d) =>
        d.eventId === e.id &&
        (statuses?.length ? statuses : ["SCHEDULED"]).includes(d.status) &&
        inWindow(d.startsAt),
    );

  // The adapter refuses these prerequisite-less flags; so does the fake.
  const guard = (input: {
    matchDateOccurrencesOnly?: boolean;
    includeDateOccurrences?: boolean;
    withheldOwners?: unknown;
    excludeBannedOwners?: boolean;
  }) => {
    if (input.matchDateOccurrencesOnly && !input.includeDateOccurrences) {
      throw new Error("matchDateOccurrencesOnly requires includeDateOccurrences");
    }
    if (input.withheldOwners && !input.excludeBannedOwners) {
      throw new Error("withheldOwners requires excludeBannedOwners");
    }
  };
  const withheldSet = { humanIds: ["withheld-human"], orgIds: ["withheld-org"] };
  const listWithheldOwners = vi.fn(async () => withheldSet);

  const listPublishedByPlace = vi.fn(
    async (input: Parameters<PublicCalendarFeedDeps["repos"]["events"]["listPublishedByPlace"]>[0]) => {
      guard(input);
      const statuses = input.statuses?.length ? input.statuses : ["PUBLISHED"];
      const inWindow = (d: Date) =>
        d.getTime() >= input.from.getTime() && d.getTime() <= input.to.getTime();
      const matched = corpus
        .filter(
          (e) =>
            e.placeId === input.placeId &&
            (statuses as string[]).includes(e.status) &&
            e.visibility === "PUBLIC" &&
            (!input.cancelledWhilePublished || cancelledWhilePublished(e)) &&
            ((!input.matchDateOccurrencesOnly && inWindow(e.startsAt)) ||
              (input.includeDateOccurrences &&
                dateArm(e, input.dateOccurrenceStatuses, inWindow))),
        )
        .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
      const items = matched.slice(0, input.limit ?? 20);
      return {
        items,
        pageInfo: { total: matched.length, limit: input.limit ?? 20, offset: 0, count: items.length },
      };
    },
  );

  const listByOwner = vi.fn(
    async (input: Parameters<PublicCalendarFeedDeps["repos"]["events"]["listByOwner"]>[0]) => {
      guard(input);
      if (input.matchDateOccurrencesOnly && !input.dateRange?.from && !input.dateRange?.to) {
        throw new Error("matchDateOccurrencesOnly requires a bounded dateRange");
      }
      const from = input.dateRange?.from;
      const inWindow = (d: Date) => !from || d.getTime() >= from.getTime();
      const matched = corpus
        .filter(
          (e) =>
            (input.ownerType === "HUMAN" ? e.humanId : e.orgId) === input.ownerId &&
            (!input.status?.length || input.status.includes(e.status)) &&
            (!input.visibility?.length || input.visibility.includes(e.visibility)) &&
            (!input.cancelledWhilePublished || cancelledWhilePublished(e)) &&
            (!input.excludeBannedOwners || !withheld.has(e.id)) &&
            ((!input.matchDateOccurrencesOnly &&
              (inWindow(e.startsAt) ||
                (input.includeRunning && e.endsAt !== null && inWindow(e.endsAt)))) ||
              (input.includeDateOccurrences &&
                dateArm(e, input.dateOccurrenceStatuses, inWindow))),
        )
        .sort((a, b) =>
          input.startsAtOrder === "asc"
            ? a.startsAt.getTime() - b.startsAt.getTime()
            : b.startsAt.getTime() - a.startsAt.getTime(),
        );
      const items = matched.slice(0, input.limit ?? 50);
      return {
        items,
        pageInfo: { total: matched.length, limit: input.limit ?? 50, offset: 0, count: items.length },
      };
    },
  );

  const listByEventIds = vi.fn(
    async (input: { eventIds: readonly string[]; statuses?: string[] }) =>
      dates.filter(
        (d) =>
          input.eventIds.includes(d.eventId) &&
          (!input.statuses?.length || input.statuses.includes(d.status)),
      ),
  );

  const place = opts.place === undefined ? makePlace() : opts.place;
  const deps = {
    repos: {
      events: { listPublishedByPlace, listByOwner },
      eventDates: { listByEventIds },
      bans: { listWithheldOwners },
      places: { getById: vi.fn(async (id: string) => (place && place.id === id ? place : null)) },
      organizations: {
        getById: vi.fn(async () =>
          opts.org === undefined ? { id: ORG_ID, name: "Cobra Org", status: "ACTIVE" } : opts.org,
        ),
      },
      humans: {
        getById: vi.fn(async () =>
          opts.human === undefined ? { id: HUMAN_ID, name: "Dana Host", status: "ACTIVE" } : opts.human,
        ),
      },
    } as unknown as PublicCalendarFeedDeps["repos"],
    clock: { now: () => NOW },
    appBaseUrl: BASE,
  } satisfies PublicCalendarFeedDeps;
  return {
    deps,
    listPublishedByPlace,
    listByOwner,
    listByEventIds,
    listWithheldOwners,
    withheldSet,
  };
}

/** Unfold, split into VEVENT blocks. */
function vevents(ics: string): string[] {
  const unfolded = ics.replace(/\r\n /g, "");
  return unfolded.split("BEGIN:VEVENT").slice(1).map((b) => b.split("END:VEVENT")[0]!);
}
const prop = (block: string, name: string) =>
  block
    .split("\r\n")
    .find((l) => l.startsWith(`${name}:`))
    ?.slice(name.length + 1);

beforeAll(() => {
  configureLocationObfuscation({ secret: "test-only-location-obfuscation-secret" });
});

// ─────────────────────────────────────────────────────────────────────────────
// Place feed
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPlaceCalendarFeed", () => {
  it("resolves the withheld-owner set once per request and hands it to all three reads", async () => {
    const { deps, listPublishedByPlace, listWithheldOwners, withheldSet } = makeDeps({
      events: [makeEvent()],
    });

    await buildPlaceCalendarFeed(deps, { placeId: PLACE_ID });

    expect(listWithheldOwners).toHaveBeenCalledTimes(1);
    expect(listPublishedByPlace).toHaveBeenCalledTimes(3);
    for (const [input] of listPublishedByPlace.mock.calls) {
      expect(input.excludeBannedOwners).toBe(true);
      expect(input.withheldOwners).toBe(withheldSet);
    }
  });

  it("V1: a multi-night listing is N VEVENTs with N distinct per-night UIDs", async () => {
    const listing = makeEvent({ title: "Wednesday Open Mic", startsAt: new Date("2026-05-06T01:00:00Z") });
    const nights = [
      night(listing.id, "2026-05-06T01:00:00Z"),
      night(listing.id, "2026-05-13T01:00:00Z"),
      night(listing.id, "2026-05-20T01:00:00Z"),
    ];
    const single = makeEvent({ startsAt: new Date("2026-05-08T20:00:00Z") });
    const { deps } = makeDeps({ events: [listing, single], dates: nights });

    const { icsBody } = await buildPlaceCalendarFeed(deps, { placeId: PLACE_ID });
    const blocks = vevents(icsBody);
    const uids = blocks.map((b) => prop(b, "UID"));

    expect(blocks).toHaveLength(4);
    expect(new Set(uids).size).toBe(4);
    for (const n of nights) {
      expect(uids).toContain(`${listing.id}-${n.id}@ithasfire.com`);
    }
    expect(uids).not.toContain(`${listing.id}@ithasfire.com`);
    expect(uids).toContain(`${single.id}@ithasfire.com`);
  });

  it("Q6/V3: a called-off night of a live listing stays, CANCELLED, real title, the UID it had while live", async () => {
    const listing = makeEvent({ title: "Wednesday Open Mic", startsAt: new Date("2026-05-06T01:00:00Z") });
    const live = night(listing.id, "2026-05-06T01:00:00Z");
    const off = night(listing.id, "2026-05-13T01:00:00Z", "CANCELLED");
    const { deps } = makeDeps({ events: [listing], dates: [live, off] });

    const blocks = vevents((await buildPlaceCalendarFeed(deps, { placeId: PLACE_ID })).icsBody);
    const offBlock = blocks.find((b) => prop(b, "UID") === `${listing.id}-${off.id}@ithasfire.com`)!;
    expect(offBlock).toBeDefined();
    expect(prop(offBlock, "SUMMARY")).toBe("Wednesday Open Mic");
    expect(prop(offBlock, "STATUS")).toBe("CANCELLED");
    // Monotonic SEQUENCE from LAST-MODIFIED (the night's later write).
    expect(Number(prop(offBlock, "SEQUENCE"))).toBe(feedSequence(off.updatedAt));
    const liveBlock = blocks.find((b) => prop(b, "UID") === `${listing.id}-${live.id}@ithasfire.com`)!;
    expect(prop(liveBlock, "STATUS")).toBe("CONFIRMED");
    expect(Number(prop(liveBlock, "SEQUENCE"))).toBe(feedSequence(UPDATED));
  });

  it("lang=es: a called-off night leads with Cancelado.; no lang stays Cancelled.", async () => {
    const listing = makeEvent({ title: "Wednesday Open Mic", startsAt: new Date("2026-05-06T01:00:00Z") });
    const off = night(listing.id, "2026-05-13T01:00:00Z", "CANCELLED");
    const { deps } = makeDeps({ events: [listing], dates: [night(listing.id, "2026-05-06T01:00:00Z"), off] });
    const offDescription = async (lang?: string) => {
      const blocks = vevents((await buildPlaceCalendarFeed(deps, { placeId: PLACE_ID, lang })).icsBody);
      return prop(blocks.find((b) => prop(b, "UID")!.includes(off.id))!, "DESCRIPTION");
    };
    expect(await offDescription("es")).toMatch(/^Cancelado\./);
    expect(await offDescription("es-MX")).toMatch(/^Cancelado\./);
    expect(await offDescription()).toMatch(/^Cancelled\./);
    expect(await offDescription("klingon")).toMatch(/^Cancelled\./);
  });

  it("Q6: a taken-down listing (CANCELLED event, nights flipped CANCELLED, stale pin) shows every upcoming night CANCELLED", async () => {
    // Take-down leaves the pinned startsAt where it was; here it is already
    // past, so only the CANCELLED-night arm of the read admits the listing.
    const takenDown = makeEvent({
      title: "Thursday Jam",
      status: "CANCELLED",
      cancelledFromStatus: "PUBLISHED",
      startsAt: new Date("2026-04-24T01:00:00Z"),
    });
    const nights = [
      night(takenDown.id, "2026-04-24T01:00:00Z"), // past, stays SCHEDULED
      night(takenDown.id, "2026-05-08T01:00:00Z", "CANCELLED"),
      night(takenDown.id, "2026-05-15T01:00:00Z", "CANCELLED"),
    ];
    const { deps } = makeDeps({ events: [takenDown], dates: nights });

    const blocks = vevents((await buildPlaceCalendarFeed(deps, { placeId: PLACE_ID })).icsBody);
    expect(blocks.map((b) => [prop(b, "UID"), prop(b, "STATUS"), prop(b, "SUMMARY")])).toEqual([
      [`${takenDown.id}-${nights[1]!.id}@ithasfire.com`, "CANCELLED", "Thursday Jam"],
      [`${takenDown.id}-${nights[2]!.id}@ithasfire.com`, "CANCELLED", "Thursday Jam"],
    ]);
  });

  it("never leaks a cancelled event that was never public: never published, PRIVATE, or already past", async () => {
    const neverPublished = makeEvent({ title: "Secret draft", status: "CANCELLED", cancelledFromStatus: "DRAFT", publishedAt: null });
    const privateOne = makeEvent({ title: "Private party", status: "CANCELLED", cancelledFromStatus: "PUBLISHED", visibility: "PRIVATE" });
    const past = makeEvent({ title: "Old news", status: "CANCELLED", cancelledFromStatus: "PUBLISHED", startsAt: new Date("2026-04-20T20:00:00Z") });
    const shown = makeEvent({ title: "Called off", status: "CANCELLED", cancelledFromStatus: "PUBLISHED" });
    const { deps } = makeDeps({ events: [neverPublished, privateOne, past, shown] });

    const { icsBody } = await buildPlaceCalendarFeed(deps, { placeId: PLACE_ID });
    expect(icsBody).not.toContain("Secret draft");
    expect(icsBody).not.toContain("Private party");
    expect(icsBody).not.toContain("Old news");
    expect(icsBody).toContain("SUMMARY:Called off");
  });

  it("owner ruling 10-17: a show lists as CANCELLED only if it was PUBLISHED when cancelled", async () => {
    // Published, then cancelled while live: stays, CANCELLED.
    const cancelledLive = makeEvent({ title: "Cancelled while live", status: "CANCELLED", cancelledFromStatus: "PUBLISHED" });
    // Published, unpublished (publishedAt kept), edited, then cancelled as a draft.
    const unpublishedFirst = makeEvent({
      title: "Renamed while private",
      status: "CANCELLED",
      cancelledFromStatus: "DRAFT",
      addressText: "12 Secret Lane",
    });
    // Never published at all, cancelled as a draft.
    const draftOnly = makeEvent({ title: "Never public", status: "CANCELLED", cancelledFromStatus: "DRAFT", publishedAt: null });
    // Cancelled before the column existed (NULL), though once published: its
    // status at cancel is unknown, so it stays out.
    const legacy = makeEvent({ title: "Legacy take-down", status: "CANCELLED", cancelledFromStatus: null });
    // A still-PUBLISHED listing with one called-off night: public, listed.
    const liveListing = makeEvent({ title: "Weekly Jam", startsAt: new Date("2026-05-06T01:00:00Z") });
    const nights = [
      night(liveListing.id, "2026-05-06T01:00:00Z"),
      night(liveListing.id, "2026-05-13T01:00:00Z", "CANCELLED"),
    ];
    const { deps } = makeDeps({
      events: [cancelledLive, unpublishedFirst, draftOnly, legacy, liveListing],
      dates: nights,
    });

    const { icsBody } = await buildPlaceCalendarFeed(deps, { placeId: PLACE_ID });
    const blocks = vevents(icsBody);
    const statusOf = (title: string) =>
      blocks.filter((b) => prop(b, "SUMMARY") === title).map((b) => prop(b, "STATUS"));
    expect(statusOf("Cancelled while live")).toEqual(["CANCELLED"]);
    expect(statusOf("Weekly Jam")).toEqual(["CONFIRMED", "CANCELLED"]);
    expect(icsBody).not.toContain("Renamed while private");
    expect(icsBody).not.toContain("12 Secret Lane");
    expect(icsBody).not.toContain("Never public");
    expect(icsBody).not.toContain("Legacy take-down");
  });

  it("cap independence: 20 live shows fill the live limit and a cancelled one is still listed", async () => {
    const live = Array.from({ length: 25 }, (_, i) =>
      makeEvent({ startsAt: new Date(Date.UTC(2026, 4, 2 + i, 20)) }),
    );
    const cancelled = makeEvent({ title: "Called off", status: "CANCELLED", cancelledFromStatus: "PUBLISHED", startsAt: new Date("2026-07-01T20:00:00Z") });
    const { deps, listPublishedByPlace } = makeDeps({ events: [...live, cancelled] });

    const blocks = vevents((await buildPlaceCalendarFeed(deps, { placeId: PLACE_ID })).icsBody);
    expect(blocks.filter((b) => prop(b, "STATUS") === "CONFIRMED")).toHaveLength(20);
    expect(blocks.filter((b) => prop(b, "STATUS") === "CANCELLED")).toHaveLength(1);
    expect(listPublishedByPlace).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20 }),
    );
    expect(listPublishedByPlace).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 50,
        statuses: ["CANCELLED"],
        cancelledWhilePublished: true,
        dateOccurrenceStatuses: ["SCHEDULED", "CANCELLED"],
      }),
    );
  });

  it("both reads apply the public place predicates (venue-confirmed here, banned owners withheld, upcoming 90 days)", async () => {
    const { deps, listPublishedByPlace } = makeDeps({ events: [] });
    await buildPlaceCalendarFeed(deps, { placeId: PLACE_ID });
    expect(listPublishedByPlace).toHaveBeenCalledTimes(3);
    for (const [input] of listPublishedByPlace.mock.calls) {
      expect(input).toMatchObject({
        placeId: PLACE_ID,
        from: NOW,
        to: new Date(NOW.getTime() + 90 * 24 * 60 * 60 * 1000),
        status: "upcoming",
        includeDateOccurrences: true,
        excludeBannedOwners: true,
        venueConfirmedFor: { orgIds: [ORG_ID], humanIds: [], acceptsCommunityListings: false },
      });
    }
  });

  it("LAST-MODIFIED from updatedAt, links on the configured web origin, no ORGANIZER", async () => {
    const ev = makeEvent({ slug: "big-night" });
    const { deps } = makeDeps({ events: [ev] });
    const { icsBody } = await buildPlaceCalendarFeed(deps, { placeId: PLACE_ID });
    const [block] = vevents(icsBody);
    expect(prop(block!, "LAST-MODIFIED")).toBe("20260420T091500Z");
    expect(prop(block!, "URL")).toBe(`${BASE}/events/big-night`);
    expect(icsBody).not.toContain("ithasfire.com/events");
    expect(icsBody).not.toContain("ORGANIZER");
    expect(icsBody).toContain("X-WR-CALNAME:The Room — Ithas Fire");
  });

  it("a gated cancelled show carries no LOCATION or GEO", async () => {
    const gated = makeEvent({ status: "CANCELLED", cancelledFromStatus: "PUBLISHED", gateType: "PASSWORD" });
    const { deps } = makeDeps({ events: [gated] });
    const [block] = vevents((await buildPlaceCalendarFeed(deps, { placeId: PLACE_ID })).icsBody);
    expect(prop(block!, "STATUS")).toBe("CANCELLED");
    expect(block).not.toContain("LOCATION:");
    expect(block).not.toContain("GEO:");
  });

  it("W2: a live listing whose LAST upcoming night was called off (pin re-pinned to the past) still shows that night CANCELLED", async () => {
    // repinEventStartsAt pins a drained listing to the call-off moment.
    const listing = makeEvent({ title: "Last Wednesday", startsAt: new Date("2026-04-30T12:00:00Z") });
    const nights = [
      night(listing.id, "2026-04-22T01:00:00Z"),
      night(listing.id, "2026-05-06T01:00:00Z", "CANCELLED"),
    ];
    const { deps, listPublishedByPlace } = makeDeps({ events: [listing], dates: nights });

    const blocks = vevents((await buildPlaceCalendarFeed(deps, { placeId: PLACE_ID })).icsBody);
    expect(blocks.map((b) => [prop(b, "UID"), prop(b, "STATUS")])).toEqual([
      [`${listing.id}-${nights[1]!.id}@ithasfire.com`, "CANCELLED"],
    ]);
    expect(listPublishedByPlace).toHaveBeenCalledWith(
      expect.objectContaining({
        matchDateOccurrencesOnly: true,
        dateOccurrenceStatuses: ["CANCELLED"],
        limit: 50,
        excludeBannedOwners: true,
      }),
    );
  });

  it("dedupes a listing every read returns: one VEVENT per night", async () => {
    // Live (pin in window) AND has a called-off night: matched by two reads.
    const listing = makeEvent({ startsAt: new Date("2026-05-06T01:00:00Z") });
    const nights = [
      night(listing.id, "2026-05-06T01:00:00Z"),
      night(listing.id, "2026-05-13T01:00:00Z", "CANCELLED"),
    ];
    const { deps } = makeDeps({ events: [listing], dates: nights });
    const uids = vevents((await buildPlaceCalendarFeed(deps, { placeId: PLACE_ID })).icsBody).map((b) =>
      prop(b, "UID"),
    );
    expect(uids).toHaveLength(2);
    expect(new Set(uids).size).toBe(2);
  });

  it("W1: SEQUENCE never decreases across cancel → restore of a night", async () => {
    const listing = makeEvent({ startsAt: new Date("2026-05-06T01:00:00Z") });
    const live = night(listing.id, "2026-05-06T01:00:00Z");
    const t0 = night(listing.id, "2026-05-13T01:00:00Z", "SCHEDULED", new Date("2026-04-20T09:15:00Z"));
    const sequenceOf = async (row: EventDateRecord) => {
      const { deps } = makeDeps({ events: [listing], dates: [live, row] });
      const blocks = vevents((await buildPlaceCalendarFeed(deps, { placeId: PLACE_ID })).icsBody);
      const block = blocks.find((b) => prop(b, "UID") === `${listing.id}-${row.id}@ithasfire.com`)!;
      return { status: prop(block, "STATUS"), sequence: Number(prop(block, "SEQUENCE")) };
    };
    // Each status flip is a write, so `updatedAt` moves forward.
    const before = await sequenceOf(t0);
    const cancelled = await sequenceOf({ ...t0, status: "CANCELLED", updatedAt: new Date("2026-04-25T10:00:00Z") });
    const restored = await sequenceOf({ ...t0, status: "SCHEDULED", updatedAt: new Date("2026-04-26T10:00:00Z") });
    expect([before.status, cancelled.status, restored.status]).toEqual(["CONFIRMED", "CANCELLED", "CONFIRMED"]);
    expect(cancelled.sequence).toBeGreaterThan(before.sequence);
    expect(restored.sequence).toBeGreaterThan(cancelled.sequence);
  });

  it.each([
    ["PLACE_NOT_FOUND", null, PLACE_ID],
    ["PLACE_NOT_VERIFIED", makePlace({ verificationStatus: "PENDING" } as Partial<PlaceRecord>), PLACE_ID],
    ["PLACE_NOT_ACTIVE", makePlace({ status: "ARCHIVED" } as Partial<PlaceRecord>), PLACE_ID],
    ["invalid_input", makePlace(), "not-a-uuid"],
  ])("%s → a code the route maps to 404", async (code, place, placeId) => {
    const { deps } = makeDeps({ place });
    await expect(buildPlaceCalendarFeed(deps, { placeId })).rejects.toMatchObject({ code });
    expect(PUBLIC_CALENDAR_FEED_NOT_FOUND_CODES.has(code)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Owner feeds
// ─────────────────────────────────────────────────────────────────────────────

describe("buildOwnerCalendarFeed", () => {
  it.each(["ORGANIZATION", "HUMAN"] as const)(
    "%s feed resolves the withheld-owner set once per request and hands it to all three reads",
    async (ownerType) => {
      const { deps, listByOwner, listWithheldOwners, withheldSet } = makeDeps({});

      await buildOwnerCalendarFeed(deps, {
        ownerType,
        ownerId: ownerType === "ORGANIZATION" ? ORG_ID : HUMAN_ID,
      });

      expect(listWithheldOwners).toHaveBeenCalledTimes(1);
      expect(listByOwner).toHaveBeenCalledTimes(3);
      for (const [input] of listByOwner.mock.calls) {
        expect(input.excludeBannedOwners).toBe(true);
        expect(input.withheldOwners).toBe(withheldSet);
      }
    },
  );

  it("V5: reads nearest-first from 30 days back, so a full page keeps the NEXT shows", async () => {
    const events = Array.from({ length: 250 }, (_, i) =>
      makeEvent({ startsAt: new Date(NOW.getTime() + (i + 1) * 24 * 60 * 60 * 1000) }),
    );
    const { deps, listByOwner } = makeDeps({ events });

    const blocks = vevents(
      (await buildOwnerCalendarFeed(deps, { ownerType: "ORGANIZATION", ownerId: ORG_ID })).icsBody,
    );
    const uids = blocks.map((b) => prop(b, "UID"));
    expect(blocks).toHaveLength(200);
    expect(uids).toContain(`${events[0]!.id}@ithasfire.com`); // tomorrow survives
    expect(uids).not.toContain(`${events[249]!.id}@ithasfire.com`); // furthest is cut
    expect(listByOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ["PUBLISHED"],
        visibility: ["PUBLIC"],
        startsAtOrder: "asc",
        dateRange: { from: new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000) },
        limit: 200,
      }),
    );
  });

  it("includes upcoming previously-published CANCELLED shows as STATUS:CANCELLED, outside the live cap", async () => {
    const live = makeEvent({ title: "Live one" });
    const off = makeEvent({ title: "Owner cancelled", status: "CANCELLED", cancelledFromStatus: "PUBLISHED" });
    const neverLive = makeEvent({ title: "Draft cancelled", status: "CANCELLED", cancelledFromStatus: "DRAFT", publishedAt: null });
    const { deps, listByOwner } = makeDeps({ events: [live, off, neverLive] });

    const { icsBody } = await buildOwnerCalendarFeed(deps, { ownerType: "ORGANIZATION", ownerId: ORG_ID });
    const offBlock = vevents(icsBody).find((b) => prop(b, "SUMMARY") === "Owner cancelled")!;
    expect(prop(offBlock, "STATUS")).toBe("CANCELLED");
    expect(prop(offBlock, "UID")).toBe(`${off.id}@ithasfire.com`);
    // W5: "Cancelled." leads, then the host.
    expect(prop(offBlock, "DESCRIPTION")).toMatch(/^Cancelled\.\\nHosted by Cobra Org\\n/);
    expect(icsBody).not.toContain("Draft cancelled");
    expect(listByOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        status: ["CANCELLED"],
        visibility: ["PUBLIC"],
        cancelledWhilePublished: true,
        dateRange: { from: NOW },
        limit: 50,
      }),
    );
  });

  it.each([
    { ownerType: "ORGANIZATION" as const, owner: { orgId: ORG_ID, humanId: null }, ownerId: ORG_ID },
    { ownerType: "HUMAN" as const, owner: { orgId: null, humanId: HUMAN_ID }, ownerId: HUMAN_ID },
  ])(
    "owner ruling 10-17 ($ownerType feed): only a show cancelled while PUBLISHED lists as CANCELLED",
    async ({ ownerType, owner, ownerId }) => {
      const cancelledLive = makeEvent({ ...owner, title: "Cancelled while live", status: "CANCELLED", cancelledFromStatus: "PUBLISHED" });
      const unpublishedFirst = makeEvent({
        ...owner,
        title: "Renamed while private",
        status: "CANCELLED",
        cancelledFromStatus: "DRAFT",
        addressText: "12 Secret Lane",
      });
      const draftOnly = makeEvent({ ...owner, title: "Never public", status: "CANCELLED", cancelledFromStatus: "DRAFT", publishedAt: null });
      const liveListing = makeEvent({ ...owner, title: "Weekly Jam", startsAt: new Date("2026-05-06T01:00:00Z") });
      const nights = [
        night(liveListing.id, "2026-05-06T01:00:00Z"),
        night(liveListing.id, "2026-05-13T01:00:00Z", "CANCELLED"),
      ];
      const { deps } = makeDeps({ events: [cancelledLive, unpublishedFirst, draftOnly, liveListing], dates: nights });

      const { icsBody } = await buildOwnerCalendarFeed(deps, { ownerType, ownerId });
      const blocks = vevents(icsBody);
      const statusOf = (title: string) =>
        blocks.filter((b) => prop(b, "SUMMARY") === title).map((b) => prop(b, "STATUS"));
      expect(statusOf("Cancelled while live")).toEqual(["CANCELLED"]);
      expect(statusOf("Weekly Jam")).toEqual(["CONFIRMED", "CANCELLED"]);
      expect(icsBody).not.toContain("Renamed while private");
      expect(icsBody).not.toContain("12 Secret Lane");
      expect(icsBody).not.toContain("Never public");
    },
  );

  it("expands an owner's multi-night listing with per-night UIDs and folds the host into DESCRIPTION", async () => {
    const listing = makeEvent({ humanId: HUMAN_ID, orgId: null, startsAt: new Date("2026-05-06T01:00:00Z") });
    const nights = [night(listing.id, "2026-05-06T01:00:00Z"), night(listing.id, "2026-05-13T01:00:00Z")];
    const { deps } = makeDeps({ events: [listing], dates: nights });

    const { icsBody } = await buildOwnerCalendarFeed(deps, { ownerType: "HUMAN", ownerId: HUMAN_ID });
    const blocks = vevents(icsBody);
    expect(blocks.map((b) => prop(b, "UID"))).toEqual(
      nights.map((n) => `${listing.id}-${n.id}@ithasfire.com`),
    );
    expect(prop(blocks[0]!, "DESCRIPTION")).toMatch(/^Hosted by Dana Host\\n/);
    expect(icsBody).not.toContain("ORGANIZER");
    expect(icsBody).toContain("PRODID:-//Ithas Fire//HostCalendar//EN");
  });

  it("lang=es: Spanish host line and fallback calendar name; English unchanged", async () => {
    const listing = makeEvent({ humanId: HUMAN_ID, orgId: null, startsAt: new Date("2026-05-06T01:00:00Z") });
    const nights = [night(listing.id, "2026-05-06T01:00:00Z")];
    const { deps } = makeDeps({ events: [listing], dates: nights });
    const es = (await buildOwnerCalendarFeed(deps, { ownerType: "HUMAN", ownerId: HUMAN_ID, lang: "es" })).icsBody;
    expect(prop(vevents(es)[0]!, "DESCRIPTION")).toMatch(/^Organiza: Dana Host\\n/);
    expect(es).not.toContain("Hosted by");
    const en = (await buildOwnerCalendarFeed(deps, { ownerType: "HUMAN", ownerId: HUMAN_ID, lang: "xx" })).icsBody;
    expect(prop(vevents(en)[0]!, "DESCRIPTION")).toMatch(/^Hosted by Dana Host\\n/);

    const unnamed = makeDeps({
      events: [listing],
      dates: nights,
      human: { id: HUMAN_ID, name: null, status: "ACTIVE" },
    });
    const calName = (lang?: string) =>
      buildOwnerCalendarFeed(unnamed.deps, { ownerType: "HUMAN", ownerId: HUMAN_ID, lang }).then(
        (r) => r.icsBody.match(/X-WR-CALNAME:(.*)\r\n/)![1],
      );
    expect(await calName()).toBe("Host calendar — Ithas Fire");
    expect(await calName("es")).toBe("Calendario del anfitrión — Ithas Fire");
  });

  it("W3: a show still running (started > 30 days ago, ends later) stays in the owner feed", async () => {
    const exhibition = makeEvent({
      title: "Long Exhibition",
      startsAt: new Date("2026-03-01T15:00:00Z"),
      endsAt: new Date("2026-06-30T23:00:00Z"),
    });
    const ended = makeEvent({
      title: "Long Gone",
      startsAt: new Date("2026-02-01T15:00:00Z"),
      endsAt: new Date("2026-03-15T23:00:00Z"),
    });
    const { deps, listByOwner } = makeDeps({ events: [exhibition, ended] });
    const { icsBody } = await buildOwnerCalendarFeed(deps, { ownerType: "ORGANIZATION", ownerId: ORG_ID });
    expect(icsBody).toContain("SUMMARY:Long Exhibition");
    expect(icsBody).not.toContain("Long Gone");
    expect(listByOwner).toHaveBeenCalledWith(
      expect.objectContaining({ status: ["PUBLISHED"], includeRunning: true, startsAtOrder: "asc" }),
    );
  });

  it("W2: an owner's live listing with only a called-off night ahead shows it CANCELLED", async () => {
    const listing = makeEvent({ startsAt: new Date("2026-03-25T12:00:00Z") }); // re-pinned, past the window
    const off = night(listing.id, "2026-05-06T01:00:00Z", "CANCELLED");
    const { deps } = makeDeps({ events: [listing], dates: [off] });
    const [block] = vevents(
      (await buildOwnerCalendarFeed(deps, { ownerType: "ORGANIZATION", ownerId: ORG_ID })).icsBody,
    );
    expect(prop(block!, "UID")).toBe(`${listing.id}-${off.id}@ithasfire.com`);
    expect(prop(block!, "STATUS")).toBe("CANCELLED");
  });

  it("W4: every owner-feed read withholds a banned owner's events (live and cancelled)", async () => {
    const live = makeEvent({ title: "Banned live" });
    const off = makeEvent({ title: "Banned cancelled", status: "CANCELLED", cancelledFromStatus: "PUBLISHED" });
    const { deps, listByOwner } = makeDeps({ events: [live, off], withheldEventIds: [live.id, off.id] });
    const { icsBody } = await buildOwnerCalendarFeed(deps, { ownerType: "ORGANIZATION", ownerId: ORG_ID });
    expect(icsBody).not.toContain("BEGIN:VEVENT");
    expect(listByOwner).toHaveBeenCalledTimes(3);
    for (const [input] of listByOwner.mock.calls) {
      expect(input).toMatchObject({ excludeBannedOwners: true, visibility: ["PUBLIC"] });
    }
  });

  it.each([
    ["ORG_NOT_FOUND", "ORGANIZATION", ORG_ID, { org: null }],
    ["ORG_NOT_FOUND", "ORGANIZATION", ORG_ID, { org: { id: ORG_ID, name: "x", status: "SUSPENDED" } }],
    ["HUMAN_NOT_FOUND", "HUMAN", HUMAN_ID, { human: { id: HUMAN_ID, name: "x", status: "BANNED" } }],
    ["invalid_input", "ORGANIZATION", "nope", {}],
    ["invalid_input", "HUMAN", "123", {}],
  ] as const)("%s (%s %s) → a code the route maps to 404", async (code, ownerType, ownerId, extra) => {
    const { deps } = makeDeps(extra);
    await expect(buildOwnerCalendarFeed(deps, { ownerType, ownerId })).rejects.toMatchObject({ code });
    expect(PUBLIC_CALENDAR_FEED_NOT_FOUND_CODES.has(code)).toBe(true);
  });
});

describe("feedSequence", () => {
  it("is 0 without a timestamp and grows with the last write", () => {
    expect(feedSequence(null)).toBe(0);
    const a = feedSequence(new Date("2026-10-17T10:00:00Z"));
    const b = feedSequence(new Date("2026-10-17T10:00:01Z"));
    expect(b).toBe(a + 1);
  });

  it("stays inside the RFC 5545 signed 32-bit INTEGER range", () => {
    expect(feedSequence(new Date("2038-01-20T00:00:00Z"))).toBeLessThan(2 ** 31);
    expect(feedSequence(new Date("2088-01-01T00:00:00Z"))).toBeLessThan(2 ** 31);
    expect(feedSequence(new Date("2200-01-01T00:00:00Z"))).toBe(2 ** 31 - 1);
    expect(feedSequence(new Date("2019-01-01T00:00:00Z"))).toBe(0);
  });
});
