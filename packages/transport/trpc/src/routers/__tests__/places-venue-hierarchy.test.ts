import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import {
  createFakeCalendarsRepo,
  createFakeSpacesRepo,
} from "@th/test-utils/fakes/venue-hierarchy";

import { placesRouter } from "../places";
import { createCaller } from "./test-helpers";

/**
 * Transport wiring for the venue-hierarchy procedures on `places.*`
 * (spaces / calendars / availability / named-calendar events — Step 6).
 *
 * Thin-transport contract: authz + invariants live in the use cases; these
 * tests pin (a) the procedure surface Step 7's UI will call, (b) ctx-actor
 * injection (never client-supplied), and (c) the admin/public split of
 * getCalendarEvents.
 */

const ACTOR_ID = "11111111-1111-4111-8111-111111111111"; // test-helpers default
const PLACE_ID = "55555555-5555-4555-8555-555555555555";
const EVENT_ID = "77777777-7777-4777-8777-777777777777";

function buildWorld() {
  const spaces = createFakeSpacesRepo();
  const calendars = createFakeCalendarsRepo({ spaces });

  const space = spaces.seed({ placeId: PLACE_ID, name: "Main Space" });
  const calendar = calendars.seedCalendar({
    placeId: PLACE_ID,
    name: "Social Club",
    slug: "social-club",
    isDefault: true,
  });

  const event = {
    id: EVENT_ID,
    title: "Social Night",
    status: "PUBLISHED",
    visibility: "PUBLIC",
    timezone: "America/Chicago",
    startsAt: new Date("2026-09-10T20:00:00Z"),
    endsAt: new Date("2026-09-10T23:00:00Z"),
    placeId: PLACE_ID,
    calendarId: calendar.id,
    spaceId: space.id,
    slug: "social-night",
    heroImageUrl: null,
    locality: "Nashville",
    region: "TN",
  } as unknown as EventRecord;

  const txRepos = {
    spaces,
    calendars,
    audit: { log: vi.fn(async () => undefined) },
  } as unknown as TxRepos;

  const repos = {
    spaces,
    calendars,
    places: {
      getById: vi.fn(async () => ({
        id: PLACE_ID,
        name: "Drkmttr",
        status: "ACTIVE",
        verificationStatus: "VERIFIED",
        humanIdsWithAccess: [ACTOR_ID],
        orgIdsWithAccess: [],
      })),
    },
    events: {
      listByCalendar: vi.fn(async () => [event]),
      listAllByPlace: vi.fn(async () => [event]),
    },
    imageModerationRecords: {
      getStatusesForKeys: vi.fn(async () => new Map()),
    },
    // Booking-holds FR-014 admin overlay (empty here; shape pinned in core).
    bookingHolds: {
      listLiveForCalendarRange: vi.fn(async () => []),
      listLiveForPlaceRange: vi.fn(async () => []),
    },
    bookingRequests: { getById: vi.fn(async () => null) },
    authz: {
      getPlaceAccessContext: vi.fn(async (placeId: string) =>
        placeId === PLACE_ID
          ? { owningOrgIds: [], verifiedHumanOwnerIds: [ACTOR_ID] }
          : null,
      ),
      getOrgMembership: vi.fn(async () => null),
      getOrgMemberships: vi.fn(async () => []),
    },
    tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) => fn(txRepos)),
  } as unknown as Repos;

  return { repos, spaces, calendars, space, calendar };
}

describe("places venue-hierarchy — procedure surface (Step-7 contract)", () => {
  it("exposes every procedure the management UI will call", () => {
    const names = [
      "listSpaces",
      "createSpace",
      "updateSpace",
      "setSpaceStatus",
      "listCalendars",
      "createCalendar",
      "updateCalendar",
      "assignCalendarSpaces",
      "listCalendarAvailability",
      "upsertCalendarAvailability",
      "deleteCalendarAvailability",
      "getCalendarEventsAdmin",
      "getCalendarEventsPublic",
    ] as const;
    for (const name of names) {
      expect(placesRouter, `places.${name} missing`).toHaveProperty(name);
    }
  });
});

describe("places venue-hierarchy — spaces/calendars wiring", () => {
  it("createSpace injects the ctx actor and returns the created row", async () => {
    const w = buildWorld();
    const { caller } = createCaller(placesRouter, { repos: w.repos });

    const created = await caller.createSpace({
      placeId: PLACE_ID,
      name: "Back Bar",
      capacity: 80,
    });

    expect(created).toMatchObject({
      placeId: PLACE_ID,
      name: "Back Bar",
      capacity: 80,
      status: "ACTIVE",
    });
    expect(w.spaces.rows.size).toBe(2);
  });

  it("listSpaces / listCalendars are owner-gated reads that pass through", async () => {
    const w = buildWorld();
    const { caller } = createCaller(placesRouter, { repos: w.repos });

    const spaces = await caller.listSpaces({ placeId: PLACE_ID });
    expect(spaces.map((r: { id: string }) => r.id)).toEqual([w.space.id]);

    const calendars = await caller.listCalendars({ placeId: PLACE_ID });
    expect(calendars).toHaveLength(1);
    expect(calendars[0]).toMatchObject({ slug: "social-club" });
  });

  it("upsertCalendarAvailability requires isOpen (full-PUT — omitting it is a BAD_REQUEST, never a silent reopen)", async () => {
    const w = buildWorld();
    const { caller } = createCaller(placesRouter, { repos: w.repos });

    await expect(
      caller.upsertCalendarAvailability({
        placeId: PLACE_ID,
        calendarId: w.calendar.id,
        dayOfWeek: 5,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const row = await caller.upsertCalendarAvailability({
      placeId: PLACE_ID,
      calendarId: w.calendar.id,
      dayOfWeek: 5,
      isOpen: false,
    });
    expect(row).toMatchObject({ calendarId: w.calendar.id, isOpen: false });
  });

  it("rejects a client-smuggled actorHumanId on mutations (strict inputs)", async () => {
    const w = buildWorld();
    const { caller } = createCaller(placesRouter, { repos: w.repos });

    await expect(
      caller.createSpace({
        placeId: PLACE_ID,
        name: "Smuggled",
        actorHumanId: "99999999-9999-4999-8999-999999999999",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // The ONE hand-built input on this surface (the use-case schema's
    // superRefine blocks `.omit()`) must reject unknown keys too — Step-6
    // review: without `.strict()` it silently diverged from every sibling.
    await expect(
      caller.upsertCalendarAvailability({
        placeId: PLACE_ID,
        calendarId: w.calendar.id,
        dayOfWeek: 5,
        isOpen: false,
        actorHumanId: "99999999-9999-4999-8999-999999999999",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("createCalendar refuses a half rental-rate pair AT THE PROCEDURE INPUT, with the un-prefixed field path", async () => {
    const w = buildWorld();
    const { caller } = createCaller(placesRouter, { repos: w.repos });

    // Amount without currency. The use case's parseInput would also refuse
    // this, but as a bare `invalid_input` with no path — the client can only
    // place the error on a field when the refusal happens here, at the
    // transport schema, where Zod's issue carries `path`.
    let caught: unknown;
    try {
      await caller.createCalendar({
        placeId: PLACE_ID,
        spaceIds: [w.space.id],
        name: "Rentals",
        acceptsRent: true,
        rentalRateCents: 50000,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: "BAD_REQUEST" });
    const issues = JSON.parse((caught as Error).message) as {
      message: string;
      path: unknown[];
    }[];
    expect(issues).toEqual([
      expect.objectContaining({
        message: "rental_rate_requires_amount_and_currency",
        // No `patch` segment on create — `rentalRateFieldFromError` in the
        // web editor reads the LAST segment, so both shapes land on the field.
        path: ["rentalRateCurrency"],
      }),
    ]);
  });

  it("calendar procedures declare `.output()` contracts (Step-6 review) and the rows round-trip them", async () => {
    const w = buildWorld();
    // Join the seeded space so the nested spaces schema is exercised too.
    w.calendars.joins.set(w.calendar.id, [w.space.id]);
    const { caller } = createCaller(placesRouter, { repos: w.repos });

    // A row that violates its output contract must fail loudly, not leak —
    // exercise the three distinct shapes end-to-end through the caller.
    const calendars = await caller.listCalendars({ placeId: PLACE_ID });
    expect(calendars[0]).toMatchObject({
      slug: "social-club",
      spaces: [expect.objectContaining({ id: w.space.id })],
    });

    const created = await caller.createCalendar({
      placeId: PLACE_ID,
      spaceIds: [w.space.id],
      name: "Comedy",
    });
    expect(created).toMatchObject({ placeId: PLACE_ID, slug: "comedy" });

    const availability = await caller.upsertCalendarAvailability({
      placeId: PLACE_ID,
      calendarId: w.calendar.id,
      dayOfWeek: 5,
      isOpen: false,
    });
    expect(availability).toMatchObject({
      calendarId: w.calendar.id,
      isOpen: false,
    });

    const deleted = await caller.deleteCalendarAvailability({
      placeId: PLACE_ID,
      id: availability.id,
    });
    expect(deleted).toEqual({ deleted: true });
  });
});

describe("places venue-hierarchy — getCalendarEvents split", () => {
  it("admin variant injects the ctx actor and returns the overlay shape", async () => {
    const w = buildWorld();
    const { caller } = createCaller(placesRouter, { repos: w.repos });

    const result = await caller.getCalendarEventsAdmin({
      calendarId: w.calendar.id,
      from: new Date("2026-09-01T00:00:00Z"),
      to: new Date("2026-09-30T00:00:00Z"),
    });

    expect(Object.keys(result).sort()).toEqual([
      "availability",
      "calendar",
      "conflicts",
      "events",
      "holds",
    ]);
    expect(result.calendar).toMatchObject({ slug: "social-club" });
  });

  it("public variant needs NO auth and returns the strict public shape (no overlays)", async () => {
    const w = buildWorld();
    const { caller } = createCaller(placesRouter, {
      repos: w.repos,
      auth: null,
      authToken: null,
      actorHumanId: null,
    });

    const result = await caller.getCalendarEventsPublic({
      calendarId: w.calendar.id,
    });

    expect(Object.keys(result).sort()).toEqual(["calendar", "events"]);
    expect(result.events.map((e: { eventId: string }) => e.eventId)).toEqual([
      EVENT_ID,
    ]);
    expect(result).not.toHaveProperty("availability");
    expect(result).not.toHaveProperty("conflicts");
    expect(result).not.toHaveProperty("holds");
  });
});
