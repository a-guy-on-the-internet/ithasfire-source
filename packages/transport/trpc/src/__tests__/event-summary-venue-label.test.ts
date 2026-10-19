import { describe, expect, it } from "vitest";

import {
  countryEventToDto,
  discoverEventToDto,
  localEventToDto,
  nearbyEventToDto,
} from "../event-summary-mapper";

/**
 * The listing card's venue label.
 *
 * An event with a `placeId` is at a NAMED venue, and the card should say
 * "The Blue Room" rather than "801 Red River St" — a street address is noise
 * when you are scanning a list of events. Freeform-address events have no
 * Place, so the address stays the label for them.
 *
 * These pin the preference order at every mapper that produces a card, because
 * the four producers previously disagreed: two called `buildVenueLabel` and two
 * inlined `addressText?.trim() || "Nearby"`.
 */
describe("event summary venue label", () => {
  const base = {
    eventId: "11111111-1111-4111-8111-111111111111",
    title: "Live Music on Red River",
    status: "PUBLISHED",
    slug: "live-music",
    startsAt: new Date("2026-09-05T20:00:00.000Z"),
    heroImageUrl: null,
  };

  it("prefers the place name over the street address", () => {
    const dto = countryEventToDto({
      ...base,
      addressText: "801 Red River St",
      placeName: "The Blue Room",
      regionCode: "TN",
    });
    expect(dto.venue).toBe("The Blue Room");
  });

  it("falls back to the address when the event has no linked place", () => {
    const dto = countryEventToDto({
      ...base,
      addressText: "801 Red River St",
      placeName: null,
      regionCode: "TN",
    });
    expect(dto.venue).toBe("801 Red River St");
  });

  it("ignores a whitespace-only place name", () => {
    const dto = countryEventToDto({
      ...base,
      addressText: "801 Red River St",
      placeName: "   ",
      regionCode: "TN",
    });
    expect(dto.venue).toBe("801 Red River St");
  });

  it("falls back to the region, then to Place TBA", () => {
    expect(
      countryEventToDto({
        ...base,
        addressText: null,
        placeName: null,
        regionCode: "tn",
      }).venue,
    ).toBe("TN");

    expect(
      countryEventToDto({
        ...base,
        addressText: null,
        placeName: null,
        regionCode: null,
      }).venue,
    ).toBe("Place TBA");
  });

  it("prefers the place name in the local and discover mappers too", () => {
    const shape = {
      ...base,
      addressText: "801 Red River St",
      placeName: "The Blue Room",
      regionCode: "TN",
    };
    expect(localEventToDto(shape as never).venue).toBe("The Blue Room");
    expect(discoverEventToDto(shape as never).venue).toBe("The Blue Room");
  });

  // The nearby mapper inlines its own fallback ("Nearby") rather than calling
  // buildVenueLabel, so it needs its own pin or it silently drifts.
  it("prefers the place name in the nearby mapper, keeping its Nearby fallback", () => {
    expect(
      nearbyEventToDto({
        ...base,
        addressText: "801 Red River St",
        placeName: "The Blue Room",
      } as never).venue,
    ).toBe("The Blue Room");

    expect(
      nearbyEventToDto({
        ...base,
        addressText: null,
        placeName: null,
      } as never).venue,
    ).toBe("Nearby");
  });
});
