/**
 * The event builder's zone-adoption rule.
 *
 * MOCKS: none. `event-timezone.ts` is pure and its only import
 * (`isKnownTimeZone` from `event-builder-helpers`) is a thin `Intl` probe, so
 * the real thing is what we want under test — a mocked zone validator would
 * make the "unknown zone is refused" case vacuous.
 */
import { describe, expect, it } from "vitest";

import { toIsoInTimeZone } from "../event-builder-helpers";
import {
  coordinateKey,
  resolveTimezoneForAddressCoordinates,
  resolveTimezoneForPlaceSelection,
  shouldRequestTimezoneForCoordinates,
} from "../event-timezone";
import { buildQuickCreateSaveInput } from "../quick-create-helpers";

const BROWSER_ZONE = "America/Chicago";
const BOWERY = {
  placeId: "11111111-1111-4111-8111-111111111111",
  name: "Bowery Ballroom",
  timezone: "America/New_York",
};
const EXIT_IN = {
  placeId: "22222222-2222-4222-8222-222222222222",
  name: "Exit/In",
  timezone: "America/Chicago",
};

describe("resolveTimezoneForPlaceSelection", () => {
  it("adopts the venue's zone when a venue is selected", () => {
    const result = resolveTimezoneForPlaceSelection({
      currentTimezone: BROWSER_ZONE,
      previousPlaceId: null,
      place: BOWERY,
    });

    expect(result.timezone).toBe("America/New_York");
    expect(result.adopted).toEqual({
      source: { kind: "venue", name: "Bowery Ballroom" },
      timezone: "America/New_York",
      previousTimezone: "America/Chicago",
    });
  });

  it("leaves the zone alone when the venue has no timezone", () => {
    const result = resolveTimezoneForPlaceSelection({
      currentTimezone: BROWSER_ZONE,
      previousPlaceId: null,
      place: { ...BOWERY, timezone: null },
    });

    expect(result.timezone).toBe(BROWSER_ZONE);
    expect(result.adopted).toBeNull();
  });

  it("leaves the zone alone when the venue's zone is not a zone the runtime knows", () => {
    const result = resolveTimezoneForPlaceSelection({
      currentTimezone: BROWSER_ZONE,
      previousPlaceId: null,
      place: { ...BOWERY, timezone: "Middle/Earth" },
    });

    // Adopting it would make every `toIsoInTimeZone` in the save path throw.
    expect(result.timezone).toBe(BROWSER_ZONE);
    expect(result.adopted).toBeNull();
    expect(() => toIsoInTimeZone("2026-08-01T20:00", "Middle/Earth")).toThrow(
      RangeError,
    );
  });

  it("reports no adoption when the venue's zone already matches", () => {
    const result = resolveTimezoneForPlaceSelection({
      currentTimezone: BROWSER_ZONE,
      previousPlaceId: null,
      place: EXIT_IN,
    });

    expect(result.timezone).toBe(BROWSER_ZONE);
    // Nothing moved, so nothing to announce.
    expect(result.adopted).toBeNull();
  });

  it("does NOT restamp the zone when the organizer re-selects the venue the event is already at", () => {
    // The editing case: a saved event at Bowery whose stored zone is the
    // browser zone it was (wrongly) created with. Re-picking the SAME venue
    // must not silently move the show.
    const result = resolveTimezoneForPlaceSelection({
      currentTimezone: BROWSER_ZONE,
      previousPlaceId: BOWERY.placeId,
      place: BOWERY,
    });

    expect(result.timezone).toBe(BROWSER_ZONE);
    expect(result.adopted).toBeNull();
  });

  it("adopts when the organizer switches to a DIFFERENT venue", () => {
    const result = resolveTimezoneForPlaceSelection({
      currentTimezone: BROWSER_ZONE,
      previousPlaceId: EXIT_IN.placeId,
      place: BOWERY,
    });

    expect(result.timezone).toBe("America/New_York");
    expect(result.adopted?.source).toEqual({
      kind: "venue",
      name: "Bowery Ballroom",
    });
  });

  it("keeps the zone when the organizer clears the venue (freeform / online)", () => {
    const result = resolveTimezoneForPlaceSelection({
      currentTimezone: "America/New_York",
      previousPlaceId: BOWERY.placeId,
      place: null,
    });

    // Reverting would re-introduce the browser zone we are trying to stop
    // trusting, and would move times the organizer has already typed.
    expect(result.timezone).toBe("America/New_York");
    expect(result.adopted).toBeNull();
  });
});

describe("interpretation: the wall clock stays, the instant moves", () => {
  const WALL_CLOCK = "2026-08-01T20:00";

  it("westward → eastward: 8:00 PM Central becomes 8:00 PM Eastern (one hour EARLIER in absolute time)", () => {
    const before = toIsoInTimeZone(WALL_CLOCK, BROWSER_ZONE);
    expect(before).toBe("2026-08-02T01:00:00.000Z");

    const { timezone } = resolveTimezoneForPlaceSelection({
      currentTimezone: BROWSER_ZONE,
      previousPlaceId: null,
      place: BOWERY,
    });

    // The builder holds `startsAt` as a bare wall clock, so adoption re-reads
    // the SAME string against the new zone. The instant moves by design.
    const after = toIsoInTimeZone(WALL_CLOCK, timezone);
    expect(after).toBe("2026-08-02T00:00:00.000Z");
    expect(after).not.toBe(before);
  });

  it("eastward → westward: 8:00 PM Eastern becomes 8:00 PM Pacific (three hours LATER in absolute time)", () => {
    const before = toIsoInTimeZone(WALL_CLOCK, "America/New_York");
    expect(before).toBe("2026-08-02T00:00:00.000Z");

    const { timezone } = resolveTimezoneForPlaceSelection({
      currentTimezone: "America/New_York",
      previousPlaceId: BOWERY.placeId,
      place: {
        placeId: "33333333-3333-4333-8333-333333333333",
        name: "The Echo",
        timezone: "America/Los_Angeles",
      },
    });

    const after = toIsoInTimeZone(WALL_CLOCK, timezone);
    expect(after).toBe("2026-08-02T03:00:00.000Z");
  });

  it("does NOT preserve the instant (the rejected alternative)", () => {
    const before = toIsoInTimeZone(WALL_CLOCK, BROWSER_ZONE);
    const { timezone } = resolveTimezoneForPlaceSelection({
      currentTimezone: BROWSER_ZONE,
      previousPlaceId: null,
      place: BOWERY,
    });

    // Instant-preserving would have shown "21:00" in the new zone. It doesn't:
    // the reading the organizer sees is untouched.
    const readingIfInstantPreserved = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(before));
    expect(readingIfInstantPreserved).toBe("21:00");
    expect(WALL_CLOCK.slice(11)).toBe("20:00");
  });
});

describe("quick create sends the adopted zone", () => {
  it("stamps the venue's zone and reads the typed wall clock against it", () => {
    const { timezone } = resolveTimezoneForPlaceSelection({
      currentTimezone: BROWSER_ZONE,
      previousPlaceId: null,
      place: BOWERY,
    });

    const input = buildQuickCreateSaveInput({
      title: "Warehouse Show",
      startsAtLocal: "2026-08-01T20:00",
      timezone,
      location: { thPlaceId: BOWERY.placeId },
      clientKey: "abc123",
    });

    expect(input.timezone).toBe("America/New_York");
    expect(input.startsAt).toBe("2026-08-02T00:00:00.000Z");
  });

  it("freeform address with no coordinates yet: the browser zone is still what is sent", () => {
    // The place path has nothing to say about a freeform address — its zone
    // comes from the COORDINATE path below, and until coordinates exist there
    // is nothing to look up. The browser zone is what the typed wall clock
    // already means at that point, so it is what goes out.
    const { timezone, adopted } = resolveTimezoneForPlaceSelection({
      currentTimezone: BROWSER_ZONE,
      previousPlaceId: null,
      place: null,
    });
    expect(adopted).toBeNull();

    const input = buildQuickCreateSaveInput({
      title: "Backyard Show",
      startsAtLocal: "2026-08-01T20:00",
      timezone,
      location: {
        addressText: "123 Main St",
        lat: 36.16,
        lng: -86.78,
      },
      clientKey: "abc123",
    });

    expect(input.timezone).toBe(BROWSER_ZONE);
    expect(input.location).toEqual({
      addressText: "123 Main St",
      lat: 36.16,
      lng: -86.78,
    });
  });
});

// ── Freeform addresses ───────────────────────────────────────────────────────
//
// A typed or dragged address carries only coordinates, so the zone is looked
// up (`places.resolveTimezone`) rather than read off a row. Two decisions,
// split so each is pinned on its own: whether to ASK, and whether to ADOPT the
// answer.

const NASHVILLE = { lat: 36.1627, lng: -86.7816 }; // America/Chicago
const BROOKLYN = { lat: 40.7182, lng: -73.9884 }; // America/New_York

describe("shouldRequestTimezoneForCoordinates", () => {
  it("asks once when an address first acquires coordinates", () => {
    expect(
      shouldRequestTimezoneForCoordinates({
        coordinates: BROOKLYN,
        lastRequestedKey: null,
      }),
    ).toBe(true);
  });

  it("does NOT re-ask for coordinates it already asked about", () => {
    // The case that matters: one map drag calls back TWICE with the same
    // point — once so the pin tracks, once when the reverse-geocoded address
    // lands. The second must cost nothing.
    expect(
      shouldRequestTimezoneForCoordinates({
        coordinates: BROOKLYN,
        lastRequestedKey: coordinateKey(BROOKLYN),
      }),
    ).toBe(false);
  });

  it("treats a sub-millimeter float wobble as the same point", () => {
    const wobbled = {
      lat: BROOKLYN.lat + 1e-12,
      lng: BROOKLYN.lng - 1e-12,
    };
    expect(wobbled.lat).not.toBe(BROOKLYN.lat);
    expect(
      shouldRequestTimezoneForCoordinates({
        coordinates: wobbled,
        lastRequestedKey: coordinateKey(BROOKLYN),
      }),
    ).toBe(false);
  });

  it("asks again when the address actually moves", () => {
    expect(
      shouldRequestTimezoneForCoordinates({
        coordinates: BROOKLYN,
        lastRequestedKey: coordinateKey(NASHVILLE),
      }),
    ).toBe(true);
  });

  it("asks nothing when there are no coordinates", () => {
    expect(
      shouldRequestTimezoneForCoordinates({
        coordinates: null,
        lastRequestedKey: coordinateKey(NASHVILLE),
      }),
    ).toBe(false);
  });

  it("refuses coordinates the endpoint would reject rather than shipping a doomed request", () => {
    // `places.resolveTimezone` validates -90..90 / -180..180 and 400s outside
    // it; tz-lookup throws on the same input.
    for (const bad of [
      { lat: 91, lng: 0 },
      { lat: 0, lng: 181 },
      { lat: Number.NaN, lng: 0 },
      { lat: 0, lng: Number.POSITIVE_INFINITY },
    ]) {
      expect(
        shouldRequestTimezoneForCoordinates({
          coordinates: bad,
          lastRequestedKey: null,
        }),
      ).toBe(false);
    }
  });

  it("asks nothing for the coordinates a saved event was hydrated with", () => {
    // The hydration guard, stated as a rule: the hook primes its baseline with
    // whatever the form loaded with, so "did this change?" is false and no
    // lookup happens. A saved event's stored `timezone` is authoritative and
    // must not be re-derived out from under it.
    const hydrated = BROOKLYN;
    expect(
      shouldRequestTimezoneForCoordinates({
        coordinates: hydrated,
        lastRequestedKey: coordinateKey(hydrated),
      }),
    ).toBe(false);
  });
});

describe("resolveTimezoneForAddressCoordinates", () => {
  it("adopts the address's zone, naming no venue", () => {
    const result = resolveTimezoneForAddressCoordinates({
      currentTimezone: BROWSER_ZONE,
      requestedCoordinates: BROOKLYN,
      currentCoordinates: BROOKLYN,
      timezone: "America/New_York",
    });

    expect(result.timezone).toBe("America/New_York");
    expect(result.adopted).toEqual({
      source: { kind: "address" },
      timezone: "America/New_York",
      previousTimezone: "America/Chicago",
    });
  });

  it("leaves the zone alone when the lookup returns null", () => {
    // Ocean point, gap in the boundary data, or a lookup that failed — the
    // endpoint reports null rather than inventing a fallback, and so do we.
    const result = resolveTimezoneForAddressCoordinates({
      currentTimezone: BROWSER_ZONE,
      requestedCoordinates: { lat: 0, lng: -160 },
      currentCoordinates: { lat: 0, lng: -160 },
      timezone: null,
    });

    expect(result.timezone).toBe(BROWSER_ZONE);
    expect(result.adopted).toBeNull();
  });

  it("refuses a zone the runtime does not know", () => {
    const result = resolveTimezoneForAddressCoordinates({
      currentTimezone: BROWSER_ZONE,
      requestedCoordinates: BROOKLYN,
      currentCoordinates: BROOKLYN,
      timezone: "Middle/Earth",
    });

    // Same reason as the venue path: adopting it makes every
    // `toIsoInTimeZone` in the save path throw.
    expect(result.timezone).toBe(BROWSER_ZONE);
    expect(result.adopted).toBeNull();
    expect(() => toIsoInTimeZone("2026-08-01T20:00", "Middle/Earth")).toThrow(
      RangeError,
    );
  });

  it("reports no adoption when the address's zone already matches", () => {
    const result = resolveTimezoneForAddressCoordinates({
      currentTimezone: BROWSER_ZONE,
      requestedCoordinates: NASHVILLE,
      currentCoordinates: NASHVILLE,
      timezone: "America/Chicago",
    });

    expect(result.timezone).toBe(BROWSER_ZONE);
    expect(result.adopted).toBeNull();
  });

  it("keeps the zone when the organizer CLEARED the address while the lookup was in flight", () => {
    const result = resolveTimezoneForAddressCoordinates({
      currentTimezone: "America/New_York",
      requestedCoordinates: BROOKLYN,
      currentCoordinates: null,
      timezone: "America/New_York",
    });

    // Clearing must never revert the zone: the typed times keep meaning what
    // they meant, and the only thing to revert to is the browser zone this
    // whole change exists to stop trusting.
    expect(result.timezone).toBe("America/New_York");
    expect(result.adopted).toBeNull();
  });

  it("discards an answer about a point the organizer has already dragged away from", () => {
    const result = resolveTimezoneForAddressCoordinates({
      currentTimezone: BROWSER_ZONE,
      requestedCoordinates: BROOKLYN,
      currentCoordinates: NASHVILLE,
      timezone: "America/New_York",
    });

    expect(result.timezone).toBe(BROWSER_ZONE);
    expect(result.adopted).toBeNull();
  });
});

describe("freeform interpretation: the wall clock stays, the instant moves", () => {
  const WALL_CLOCK = "2026-08-01T20:00";

  it("westward → eastward: 8:00 PM Central becomes 8:00 PM Eastern (one hour EARLIER in absolute time)", () => {
    const before = toIsoInTimeZone(WALL_CLOCK, BROWSER_ZONE);
    expect(before).toBe("2026-08-02T01:00:00.000Z");

    const { timezone } = resolveTimezoneForAddressCoordinates({
      currentTimezone: BROWSER_ZONE,
      requestedCoordinates: BROOKLYN,
      currentCoordinates: BROOKLYN,
      timezone: "America/New_York",
    });

    const after = toIsoInTimeZone(WALL_CLOCK, timezone);
    expect(after).toBe("2026-08-02T00:00:00.000Z");
    expect(after).not.toBe(before);
  });

  it("eastward → westward: 8:00 PM Eastern becomes 8:00 PM Pacific (three hours LATER in absolute time)", () => {
    const before = toIsoInTimeZone(WALL_CLOCK, "America/New_York");
    expect(before).toBe("2026-08-02T00:00:00.000Z");

    const { timezone } = resolveTimezoneForAddressCoordinates({
      currentTimezone: "America/New_York",
      requestedCoordinates: { lat: 34.0781, lng: -118.2606 },
      currentCoordinates: { lat: 34.0781, lng: -118.2606 },
      timezone: "America/Los_Angeles",
    });

    const after = toIsoInTimeZone(WALL_CLOCK, timezone);
    expect(after).toBe("2026-08-02T03:00:00.000Z");
  });

  it("does NOT preserve the instant (the rejected alternative)", () => {
    const before = toIsoInTimeZone(WALL_CLOCK, BROWSER_ZONE);
    const { timezone } = resolveTimezoneForAddressCoordinates({
      currentTimezone: BROWSER_ZONE,
      requestedCoordinates: BROOKLYN,
      currentCoordinates: BROOKLYN,
      timezone: "America/New_York",
    });

    const readingIfInstantPreserved = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(before));
    expect(readingIfInstantPreserved).toBe("21:00");
    expect(WALL_CLOCK.slice(11)).toBe("20:00");
  });
});

describe("quick create sends the address-adopted zone", () => {
  it("stamps the zone looked up from the freeform address's coordinates", () => {
    const { timezone } = resolveTimezoneForAddressCoordinates({
      currentTimezone: BROWSER_ZONE,
      requestedCoordinates: BROOKLYN,
      currentCoordinates: BROOKLYN,
      timezone: "America/New_York",
    });

    const input = buildQuickCreateSaveInput({
      title: "Warehouse Show",
      startsAtLocal: "2026-08-01T20:00",
      timezone,
      location: {
        addressText: "6 Delancey St",
        lat: BROOKLYN.lat,
        lng: BROOKLYN.lng,
      },
      clientKey: "abc123",
    });

    expect(input.timezone).toBe("America/New_York");
    // The wall clock the organiser typed, read against the ADDRESS's zone.
    expect(input.startsAt).toBe("2026-08-02T00:00:00.000Z");
  });
});
