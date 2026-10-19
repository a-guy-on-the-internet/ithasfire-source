import { describe, expect, it, vi } from "vitest";

import type { EventRecord, PlaceRecord } from "@th/ports/repos";
import type { HumanLineupRow } from "@th/ports/repos/event-humans";
import type { UpcomingRsvpEventRow } from "@th/ports/repos/event-rsvps";
import type { UpcomingHeldEventRow } from "@th/ports/repos/tickets";

import {
  getMyNextNight,
  getMyNextNightOutputSchema,
  NEXT_NIGHT_ORDER_STATUSES,
  NEXT_NIGHT_SOURCE_LIMIT,
  type GetMyNextNightDeps,
} from "../get-my-next-night";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const EV_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EV_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EV_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ORDER_1 = "0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d";
const PLACE_ID = "44444444-4444-4444-8444-444444444444";
const VENUE_ORG = "55555555-5555-4555-8555-555555555555";
const OTHER_ORG = "66666666-6666-4666-8666-666666666666";

const NOW = new Date("2026-10-07T18:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR);

const STREET = "1114 Fatherland St";

/** Published, ungated, EXACT, no venue, owned by OTHER_ORG. */
function makeEvent(
  id: string,
  overrides: Record<string, unknown> = {},
): EventRecord {
  const startsAt = (overrides.startsAt as Date | undefined) ?? at(24);
  return {
    id,
    title: `Show ${id.slice(0, 4)}`,
    slug: `show-${id.slice(0, 4)}`,
    status: "PUBLISHED",
    visibility: "PUBLIC",
    gateType: "NONE",
    stewardship: "ORGANIZER",
    orgId: OTHER_ORG,
    humanId: null,
    placeId: null,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 3 * HOUR),
    timezone: "America/Chicago",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    addressText: STREET,
    lat: 36.17,
    lng: -86.75,
    locality: "Nashville",
    region: "TN",
    countryCode: "US",
    postalCode: "37206",
    venueConfirmedAt: null,
    venueConfirmationWithdrawnAt: null,
    venueConfirmedPlaceId: null,
    ...overrides,
  } as unknown as EventRecord;
}

/** Owned by VENUE_ORG; publishes its address (EXACT). */
function makePlace(overrides: Record<string, unknown> = {}): PlaceRecord {
  return {
    id: PLACE_ID,
    name: "The Blue Door",
    orgIdsWithAccess: [VENUE_ORG],
    humanIdsWithAccess: [],
    acceptsCommunityListings: false,
    formattedAddress: "901 Porter Rd, Nashville, TN 37206",
    addressLine1: "901 Porter Rd",
    addressLine2: null,
    city: "Nashville",
    region: "TN",
    postalCode: "37206",
    countryCode: "US",
    lat: 36.1862,
    lng: -86.7291,
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    ...overrides,
  } as unknown as PlaceRecord;
}

const held = (
  eventId: string,
  startsAt: Date,
  ticketCount = 1,
  latestOwnOrderId: string | null = ORDER_1,
): UpcomingHeldEventRow => ({ eventId, startsAt, ticketCount, latestOwnOrderId });

const rsvp = (eventId: string, startsAt: Date): UpcomingRsvpEventRow => ({
  eventId,
  startsAt,
});

const lineup = (eventId: string, startsAt: Date): HumanLineupRow =>
  ({
    eventHumanId: crypto.randomUUID(),
    eventId,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 3 * HOUR),
    status: "PUBLISHED",
  }) as unknown as HumanLineupRow;

function makeDeps(opts: {
  held?: UpcomingHeldEventRow[];
  rsvps?: UpcomingRsvpEventRow[];
  lineups?: HumanLineupRow[];
  events?: EventRecord[];
  places?: PlaceRecord[];
}) {
  const events = new Map((opts.events ?? []).map((e) => [e.id, e]));
  const places = new Map((opts.places ?? []).map((p) => [p.id, p]));
  const repos = {
    tickets: {
      listUpcomingHeldEvents: vi.fn(async () => opts.held ?? []),
    },
    eventRsvps: {
      listUpcomingEventsForUser: vi.fn(async () => opts.rsvps ?? []),
    },
    eventHumans: {
      listLineupsByHuman: vi.fn(async () => opts.lineups ?? []),
    },
    events: {
      getById: vi.fn(async (id: string) => events.get(id) ?? null),
    },
    places: {
      getById: vi.fn(async (id: string) => places.get(id) ?? null),
    },
  };
  const deps = {
    repos,
    clock: { now: () => NOW },
  } as unknown as GetMyNextNightDeps;
  return { deps, repos };
}

const run = (deps: GetMyNextNightDeps) =>
  getMyNextNight(deps, { actorHumanId: ACTOR });

describe("getMyNextNight", () => {
  it("returns null when nothing is upcoming, without reading any event", async () => {
    const { deps, repos } = makeDeps({});
    expect(await run(deps)).toBeNull();
    expect(repos.events.getById).not.toHaveBeenCalled();
  });

  it("asks each source for a handful of PUBLISHED, not-ended events of the viewer only", async () => {
    const { deps, repos } = makeDeps({});
    await run(deps);
    expect(repos.tickets.listUpcomingHeldEvents).toHaveBeenCalledWith({
      humanId: ACTOR,
      now: NOW,
      eventStatuses: ["PUBLISHED"],
      orderStatuses: NEXT_NIGHT_ORDER_STATUSES,
      limit: NEXT_NIGHT_SOURCE_LIMIT,
    });
    expect(repos.eventRsvps.listUpcomingEventsForUser).toHaveBeenCalledWith({
      humanId: ACTOR,
      now: NOW,
      eventStatuses: ["PUBLISHED"],
      limit: NEXT_NIGHT_SOURCE_LIMIT,
    });
    expect(repos.eventHumans.listLineupsByHuman).toHaveBeenCalledWith({
      humanId: ACTOR,
      when: "upcoming",
      now: NOW,
      after: null,
      limit: NEXT_NIGHT_SOURCE_LIMIT,
      eventStatuses: ["PUBLISHED"],
    });
    expect(NEXT_NIGHT_SOURCE_LIMIT).toBeLessThanOrEqual(10);
  });

  it("ticket orders: paid holder orders the my-tickets list shows (refunded and pending are out)", () => {
    expect([...NEXT_NIGHT_ORDER_STATUSES].sort()).toEqual([
      "PART_REFUNDED",
      "SUCCEEDED",
    ]);
  });

  it("ticket alone: kind ticket with ticketCount and the viewer's own orderId", async () => {
    const { deps } = makeDeps({
      held: [held(EV_A, at(5), 2)],
      events: [makeEvent(EV_A, { startsAt: at(5) })],
    });
    const out = await run(deps);
    expect(out).toEqual({
      kind: "ticket",
      eventId: EV_A,
      slug: "show-aaaa",
      title: "Show aaaa",
      startsAt: at(5),
      timezone: "America/Chicago",
      placeLabel: "Nashville, TN",
      ticketCount: 2,
      orderId: ORDER_1,
    });
    expect(getMyNextNightOutputSchema.safeParse(out).success).toBe(true);
  });

  it("ticket received by transfer only: ticketCount but NO orderId (getMyOrder would refuse it)", async () => {
    const { deps } = makeDeps({
      held: [held(EV_A, at(5), 1, null)],
      events: [makeEvent(EV_A, { startsAt: at(5) })],
    });
    const out = await run(deps);
    expect(out).toMatchObject({ kind: "ticket", ticketCount: 1 });
    expect(out).not.toHaveProperty("orderId");
  });

  it("RSVP alone: kind rsvp, no ticket fields", async () => {
    const { deps } = makeDeps({
      rsvps: [rsvp(EV_B, at(10))],
      events: [makeEvent(EV_B, { startsAt: at(10) })],
    });
    const out = await run(deps);
    expect(out).toMatchObject({ kind: "rsvp", eventId: EV_B });
    expect(out).not.toHaveProperty("ticketCount");
    expect(out).not.toHaveProperty("orderId");
  });

  it("lineup alone: kind lineup", async () => {
    const { deps } = makeDeps({
      lineups: [lineup(EV_C, at(3))],
      events: [makeEvent(EV_C, { startsAt: at(3) })],
    });
    expect(await run(deps)).toMatchObject({ kind: "lineup", eventId: EV_C });
  });

  it("picks the soonest across sources", async () => {
    const { deps, repos } = makeDeps({
      held: [held(EV_A, at(48))],
      rsvps: [rsvp(EV_B, at(2))],
      lineups: [lineup(EV_C, at(30))],
      events: [
        makeEvent(EV_A, { startsAt: at(48) }),
        makeEvent(EV_B, { startsAt: at(2) }),
        makeEvent(EV_C, { startsAt: at(30) }),
      ],
    });
    expect(await run(deps)).toMatchObject({ kind: "rsvp", eventId: EV_B });
    // Only the winner is read in full.
    expect(repos.events.getById).toHaveBeenCalledTimes(1);
  });

  it("same event in all three sources: ONE result, lineup wins, tickets ride along", async () => {
    const { deps } = makeDeps({
      held: [held(EV_A, at(5), 3)],
      rsvps: [rsvp(EV_A, at(5))],
      lineups: [lineup(EV_A, at(5))],
      events: [makeEvent(EV_A, { startsAt: at(5) })],
    });
    expect(await run(deps)).toMatchObject({
      kind: "lineup",
      eventId: EV_A,
      ticketCount: 3,
      orderId: ORDER_1,
    });
  });

  it("ticket beats rsvp on the same event", async () => {
    const { deps } = makeDeps({
      rsvps: [rsvp(EV_A, at(5))],
      held: [held(EV_A, at(5), 1)],
      events: [makeEvent(EV_A, { startsAt: at(5) })],
    });
    expect(await run(deps)).toMatchObject({ kind: "ticket", ticketCount: 1 });
  });

  it("a tie on start time across different events breaks by event id, whatever the source order", async () => {
    const t = at(6);
    const events = [
      makeEvent(EV_A, { startsAt: t }),
      makeEvent(EV_C, { startsAt: t }),
    ];
    const one = makeDeps({
      rsvps: [rsvp(EV_C, t)],
      lineups: [lineup(EV_A, t)],
      events,
    });
    const two = makeDeps({
      rsvps: [rsvp(EV_A, t)],
      lineups: [lineup(EV_C, t)],
      events,
    });
    expect((await run(one.deps))?.eventId).toBe(EV_A);
    expect((await run(two.deps))?.eventId).toBe(EV_A);
  });

  it("an event cancelled between the reads is not surfaced", async () => {
    const { deps } = makeDeps({
      held: [held(EV_A, at(5))],
      events: [makeEvent(EV_A, { startsAt: at(5), status: "CANCELLED" })],
    });
    expect(await run(deps)).toBeNull();
  });

  it("an event that has already ended is not surfaced", async () => {
    const { deps } = makeDeps({
      rsvps: [rsvp(EV_A, at(-5))],
      events: [
        makeEvent(EV_A, { startsAt: at(-5), endsAt: at(-1) }),
      ],
    });
    expect(await run(deps)).toBeNull();
  });

  it("an in-progress event (started, not ended) is still the next night", async () => {
    const { deps } = makeDeps({
      lineups: [lineup(EV_A, at(-1))],
      events: [makeEvent(EV_A, { startsAt: at(-1), endsAt: at(2) })],
    });
    expect(await run(deps)).toMatchObject({ kind: "lineup", eventId: EV_A });
  });

  it("a deleted event is not surfaced", async () => {
    const { deps } = makeDeps({ rsvps: [rsvp(EV_A, at(5))] });
    expect(await run(deps)).toBeNull();
  });

  it("a held row with zero tickets is not a ticket night", async () => {
    const { deps, repos } = makeDeps({ held: [held(EV_A, at(5), 0)] });
    expect(await run(deps)).toBeNull();
    expect(repos.events.getById).not.toHaveBeenCalled();
  });

  it("does not swallow a failing source", async () => {
    const { deps, repos } = makeDeps({});
    repos.eventRsvps.listUpcomingEventsForUser.mockRejectedValueOnce(
      new Error("db down"),
    );
    await expect(run(deps)).rejects.toThrow("db down");
  });

  describe("place label (public projection, never a street)", () => {
    const venueEvent = (overrides: Record<string, unknown> = {}) =>
      makeEvent(EV_A, {
        startsAt: at(5),
        placeId: PLACE_ID,
        orgId: VENUE_ORG, // the venue's own show → confirmed
        addressText: "901 Porter Rd",
        ...overrides,
      });

    const labelFor = async (event: EventRecord, place?: PlaceRecord) => {
      const { deps } = makeDeps({
        held: [held(EV_A, at(5))],
        events: [event],
        places: place ? [place] : [],
      });
      const out = await run(deps);
      expect(JSON.stringify(out)).not.toContain("Porter Rd");
      expect(JSON.stringify(out)).not.toContain(STREET);
      expect(JSON.stringify(out)).not.toContain("37206");
      return out?.placeLabel;
    };

    it("ungated, EXACT, venue-confirmed → the venue name", async () => {
      expect(await labelFor(venueEvent(), makePlace())).toBe("The Blue Door");
    });

    it("EXACT event with no venue → coarse 'locality, region', not the street", async () => {
      expect(await labelFor(makeEvent(EV_A, { startsAt: at(5) }))).toBe(
        "Nashville, TN",
      );
    });

    it("venue does not vouch (third-party event, no stamp) → coarse label, no venue name", async () => {
      expect(
        await labelFor(venueEvent({ orgId: OTHER_ORG }), makePlace()),
      ).toBe("Nashville, TN");
    });

    it("gated (password) event at a confirmed venue → coarse label only", async () => {
      expect(
        await labelFor(venueEvent({ gateType: "PASSWORD" }), makePlace()),
      ).toBe("Nashville, TN");
    });

    it("missing gateType fails closed (treated as gated)", async () => {
      expect(
        await labelFor(venueEvent({ gateType: undefined }), makePlace()),
      ).toBe("Nashville, TN");
    });

    it("venue withholds its address → its public area label, never its name", async () => {
      const out = await labelFor(
        venueEvent({ locationMode: "OBSCURED", locationRadiusMeters: 800 }),
        makePlace({
          locationMode: "OBSCURED",
          locationRadiusMeters: 800,
          locationLabel: "East Nashville",
        }),
      );
      expect(out).toBe("East Nashville");
    });

    it("address-withheld EVENT at a public venue → the author's area label, no venue name", async () => {
      const out = await labelFor(
        venueEvent({
          locationMode: "OBSCURED",
          locationRadiusMeters: 800,
          locationLabel: "Near Five Points",
        }),
        makePlace(),
      );
      expect(out).toBe("Near Five Points");
    });

    it("venue row unreadable (gone) → fully hidden venue, no name", async () => {
      expect(await labelFor(venueEvent())).toBe("Nashville, TN");
    });
  });
});
