import { describe, expect, it, vi } from "vitest";

import { buildOffsetPaginatedResult } from "@th/ports/pagination";
import type { ReporterPort } from "@th/ports/reporter";
import type { EventRecord } from "@th/ports/repos/events";
import { makeImageModerationGateFake } from "@th/test-utils/fakes/image-moderation";

import { discoverPublicEvents } from "../discover-public-events";
import { listEventsByCategoryAndCity } from "../list-events-by-category-and-city";
import { listEventsByCountry } from "../list-events-by-country";
import { listEventsByLocation } from "../list-events-by-location";
import { listFeaturedEvents } from "../list-featured-events";

/**
 * The five public event lists hand their deps to
 * `resolveVenueConfirmationByEvent`, which SWALLOWS a failed place read: the
 * venue's events render unconfirmed and fully hidden instead of failing the
 * page. Per the ReporterPort convention that swallow must reach Sentry — the
 * lists now declare `reportError` and pass it down. These pin:
 *   - a failed place read is REPORTED, tagged with the list's use case;
 *   - the page still renders, and the degraded event prints no street;
 *   - a THROWING reporter changes nothing;
 *   - a healthy read reports nothing.
 */

const PLACE_ID = "00000000-0000-4000-8000-0000000000a1";
const STREET = "1417 Shelby Ave, Nashville, TN 37206";

const EVENT = {
  id: "00000000-0000-4000-8000-000000000001",
  orgId: "00000000-0000-4000-8000-0000000000f1",
  humanId: null,
  title: "Porch Show",
  status: "PUBLISHED",
  visibility: "PUBLIC",
  gateType: "NONE",
  stewardship: "OWNED",
  attendanceMode: "TICKETED",
  // Stored EXACT (written before the venue was withheld): only the venue
  // floor keeps the street off the card — and the venue read is what fails.
  locationMode: "EXACT",
  locationRadiusMeters: null,
  locationLabel: null,
  startsAt: new Date("2099-06-01T20:00:00.000Z"),
  endsAt: null,
  placeId: PLACE_ID,
  addressText: STREET,
  locality: "Nashville",
  region: "TN",
  countryCode: "US",
  lat: 36.1775,
  lng: -86.7412,
  slug: "porch-show",
  regionCode: "tn",
  recurrenceSchedule: null,
  heroImageUrl: null,
  heroImageKey: null,
} as unknown as EventRecord;

function repos(getById: (id: string) => Promise<unknown>) {
  const page = () => ({
    ...buildOffsetPaginatedResult({
      items: [EVENT],
      total: 1,
      limit: 50,
      offset: 0,
    }),
    // `listPublishedByCategoryAndCity` also reports its ungated count.
    indexableTotal: 1,
  });
  return {
    events: {
      listPublished: vi.fn(async () => page()),
      listPublishedByRegion: vi.fn(async () => page()),
      listPublishedByCountry: vi.fn(async () => page()),
      listPublishedByCategoryAndCity: vi.fn(async () => page()),
      filterByCategory: vi.fn(async () => page()),
      countIndexableByCategory: vi.fn(async () => 1),
      listTicketTypesForEventIds: vi.fn(async () => []),
    },
    places: { getById: vi.fn(getById) },
    categories: {
      getBySlug: vi.fn(async () => ({
        id: "cat-1",
        slug: "music",
        name: "Music",
        active: true,
      })),
    },
    ...makeImageModerationGateFake(),
  };
}

const clock = { now: () => new Date("2026-01-01T00:00:00.000Z") };

type Case = {
  useCase: string;
  run: (
    r: ReturnType<typeof repos>,
    reportError: ReporterPort | undefined,
  ) => Promise<Array<string | null>>;
};

const CASES: Case[] = [
  {
    useCase: "discoverPublicEvents",
    run: async (r, reportError) =>
      (
        await discoverPublicEvents({ repos: r as never, reportError }, {})
      ).events.map((e) => e.addressText),
  },
  {
    useCase: "listEventsByLocation",
    run: async (r, reportError) =>
      (
        await listEventsByLocation(
          { repos: r as never, clock, reportError },
          { regionCode: "tn" },
        )
      ).events.map((e) => e.addressText),
  },
  {
    useCase: "listEventsByCountry",
    run: async (r, reportError) =>
      (
        await listEventsByCountry(
          { repos: r as never, clock, reportError },
          { countryCode: "US" },
        )
      ).events.map((e) => e.addressText),
  },
  {
    useCase: "listFeaturedEvents",
    run: async (r, reportError) =>
      (
        await listFeaturedEvents(
          { repos: r as never, clock, reportError },
          { categorySlug: "music" },
        )
      ).events.map((e) => e.addressText),
  },
  {
    useCase: "listEventsByCategoryAndCity",
    run: async (r, reportError) =>
      (
        await listEventsByCategoryAndCity(
          { repos: r as never, clock, reportError },
          { categorySlug: "music", citySegment: "nashville-tn" },
        )
      ).events.map((e) => e.addressText),
  },
];

describe.each(CASES)("$useCase — swallowed place read", ({ useCase, run }) => {
  it("reports a failed place read with the use case tag, and still renders", async () => {
    const boom = new Error("place read failed");
    const reportError = vi.fn();
    const r = repos(async () => {
      throw boom;
    });

    const labels = await run(r, reportError);

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: { useCase, step: "resolveVenueConfirmedByEvent" },
      extra: { placeId: PLACE_ID },
    });
    // Degraded fail-closed: the event is still listed, without its street.
    expect(labels).toHaveLength(1);
    expect(JSON.stringify(labels)).not.toContain("Shelby");
  });

  it("a throwing reporter does not change the result", async () => {
    const r = repos(async () => {
      throw new Error("place read failed");
    });
    const reportError = vi.fn(() => {
      throw new Error("reporter down");
    });

    const labels = await run(r, reportError);

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(labels).toHaveLength(1);
    expect(JSON.stringify(labels)).not.toContain("Shelby");
  });

  it("reports nothing when the place read succeeds", async () => {
    const reportError = vi.fn();
    const r = repos(async () => ({
      id: PLACE_ID,
      name: "The Shelby House",
      locationMode: "EXACT",
      locationRadiusMeters: null,
      formattedAddress: STREET,
      city: "Nashville",
      region: "TN",
      lat: 36.1775,
      lng: -86.7412,
      orgIdsWithAccess: [],
      humanIdsWithAccess: [],
      acceptsCommunityListings: false,
    }));

    await run(r, reportError);

    expect(reportError).not.toHaveBeenCalled();
  });
});
