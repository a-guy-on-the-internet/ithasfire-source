import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "@th/test-utils/fakes/logger";
import { makeImageModerationGateFake } from "@th/test-utils/fakes/image-moderation";
import { makeTicketCapacityUsageFake } from "@th/test-utils/fakes/ticket-capacity";

import {
  getEmbedEventDetail,
  type GetEmbedEventDetailDeps,
} from "../get-embed-event-detail";

/**
 * The detail payload's `timezone` is what the checkout sidebar, the tier list
 * and the gated card format the date in. It must already be a usable IANA
 * zone with the same fallback the grid card uses (`resolveTimeZone`, America/
 * Chicago): sending "UTC" for an empty stored value put a 7 PM Central show on
 * the next day in the checkout sidebar, and passing a bogus zone through made
 * `Intl` throw RangeError in the browser.
 */

const TEST_NOW = new Date("2026-01-01T00:00:00.000Z");
const EMBED_ID = "00000000-0000-4000-8000-0000000000c0";
const EVENT_ID = "00000000-0000-4000-8000-0000000000c2";
const ORIGIN = "https://embedder.example.com";

type Gate = "NONE" | "PASSWORD";

function deps(timezone: string, gateType: Gate) {
  const gate = makeImageModerationGateFake({});
  return {
    repos: {
      embeds: {
        getById: vi.fn(async () => ({
          id: EMBED_ID,
          domain: "embedder.example.com",
          subjectType: "event",
          subjectId: EVENT_ID,
          status: "ACTIVE",
          requireAuth: false,
          linkOut: false,
        })),
      },
      events: {
        getById: vi.fn(async () => ({
          id: EVENT_ID,
          title: "Embedded Show",
          slug: "embedded-show",
          startsAt: new Date("2026-02-01T01:00:00.000Z"),
          endsAt: null,
          timezone,
          currency: "usd",
          heroImageUrl: null,
          heroImageKey: null,
          addressText: "123 Main",
          locality: "Nashville",
          region: "TN",
          status: "PUBLISHED",
          gateType,
          locationMode: "EXACT",
          lat: 36.1,
          lng: -86.8,
          locationRadiusMeters: null,
          waitlistStatus: "DISABLED",
          waitlistDescription: null,
        })),
        listTicketTypes: vi.fn(async () => []),
        getContent: vi.fn(async () => null),
      },
      eventHumans: { listByEvent: vi.fn(async () => []) },
      humans: { getByIds: vi.fn(async () => []) },
      tags: { getEventTags: vi.fn(async () => []) },
      images: { resolveByIds: vi.fn(async () => []) },
      seats: { listSectionsByEvent: vi.fn(async () => []) },
      seriesOccurrences: {
        findSeriesIdByEventId: vi.fn(async () => null),
        listPublishedDatesBySeriesId: vi.fn(async () => []),
      },
      places: { getById: vi.fn(async () => null) },
      imageModerationRecords: gate.imageModerationRecords,
      ...makeTicketCapacityUsageFake(),
    } as unknown as GetEmbedEventDetailDeps["repos"],
    publicAppUrl: "http://localhost:3000",
    clock: { now: () => TEST_NOW },
    logger: createTestLogger(),
  } satisfies GetEmbedEventDetailDeps;
}

const input = { embedId: EMBED_ID, eventId: EVENT_ID, hostOrigin: ORIGIN };

describe("getEmbedEventDetail — event timezone", () => {
  describe.each(["NONE", "PASSWORD"] as const)("%s event", (gateType) => {
    it.each([
      ["an empty stored zone", ""],
      ["an unknown stored zone", "Not/AZone"],
    ])("%s falls back to America/Chicago, not UTC", async (_label, stored) => {
      const result = await getEmbedEventDetail(deps(stored, gateType), input);
      // Pins the builder reached: the gated preview withholds the address.
      expect(result.event.addressText === null).toBe(gateType === "PASSWORD");
      expect(result.event.timezone).toBe("America/Chicago");
    });

    it("a valid stored zone passes through unchanged", async () => {
      const result = await getEmbedEventDetail(
        deps("America/Denver", gateType),
        input,
      );
      expect(result.event.timezone).toBe("America/Denver");
    });
  });
});
