import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "@th/test-utils/fakes/logger";
import type { EventSuggestion } from "@th/ports/search/multi-index.types";

import {
  getEmbedForWidget,
  type GetEmbedForWidgetDeps,
} from "../get-embed-for-widget";

/**
 * The widget's cards print the date in the EVENT's own zone, never the
 * renderer's (the server renders in UTC; everyone going to one show reads the
 * same door time). So every event item carries `timezone`, resolved to a
 * usable IANA zone. On the grid it is read from the event ROW, because the
 * index lacks it on documents indexed before it was stored. The calendar
 * subject's half lives in `calendar-subject-embeds.test.ts`.
 */

const TEST_NOW = new Date("2026-01-01T00:00:00.000Z");
const EMBED_ID = "00000000-0000-4000-8000-0000000000b0";
const ORG_ID = "00000000-0000-4000-8000-0000000000b1";
const EVENT_ID = "00000000-0000-4000-8000-0000000000b2";
const ORIGIN = "https://embedder.example.com";

const embedRow = (subjectType: "organization" | "event") => ({
  id: EMBED_ID,
  domain: "embedder.example.com",
  subjectType,
  subjectId: subjectType === "organization" ? ORG_ID : EVENT_ID,
  status: "ACTIVE",
  requireAuth: false,
  linkOut: false,
  defaultView: "list",
  viewToggle: false,
});

const suggestion = (
  id: string,
  timezone: string | undefined,
): EventSuggestion => ({
  type: "event",
  id,
  eventId: id,
  title: `Night ${id}`,
  subtitle: null,
  helper: null,
  slug: `slug-${id}`,
  startsAt: new Date("2026-02-01T02:00:00.000Z"),
  endsAt: null,
  ...(timezone === undefined ? {} : { timezone }),
  city: "Nashville",
  region: "TN",
  location: "Nashville, TN",
  lat: null,
  lng: null,
  imageUrl: null,
  lowestPriceCents: 2500,
  lowestBuyerTotalCents: null,
  currency: "usd",
  paidTierCount: 1,
  hasFreeTier: false,
  hasPayWhatYouWantTier: false,
  confidence: 1,
}) as EventSuggestion;

const widgetInput = { embedId: EMBED_ID, hostOrigin: ORIGIN, scope: "own" };

function gridDeps(
  suggestions: EventSuggestion[],
  rows: Array<{ id: string; timezone: string }>,
) {
  return {
    repos: {
      embeds: { getById: vi.fn(async () => embedRow("organization")) },
      organizations: {
        getById: vi.fn(async () => ({ id: ORG_ID, name: "Org", slug: "org" })),
      },
      humans: { getById: vi.fn() },
      places: { listOwnedBySubject: vi.fn(async () => []) },
      events: {
        findManyByIds: vi.fn(async (ids: string[]) =>
          rows
            .filter((r) => ids.includes(r.id))
            .map((r) => ({ ...r, gateType: "NONE" })),
        ),
      },
      imageModerationRecords: { resolveByKeys: vi.fn(async () => new Map()) },
    } as unknown as GetEmbedForWidgetDeps["repos"],
    search: {
      autocomplete: vi.fn(async () => ({
        ok: true as const,
        value: { suggestions, latencyMs: 1 },
      })),
    } as unknown as GetEmbedForWidgetDeps["search"],
    publicAppUrl: "http://localhost:3000",
    clock: { now: () => TEST_NOW },
    logger: createTestLogger(),
  } satisfies GetEmbedForWidgetDeps;
}

function singleEventDeps(timezone: string) {
  return {
    repos: {
      embeds: { getById: vi.fn(async () => embedRow("event")) },
      events: {
        getById: vi.fn(async () => ({
          id: EVENT_ID,
          orgId: ORG_ID,
          title: "Open Mic",
          slug: "open-mic",
          startsAt: new Date("2026-02-01T02:00:00.000Z"),
          endsAt: null,
          timezone,
          currency: "usd",
          heroImageUrl: null,
          heroImageKey: null,
          addressText: "123 Main St",
          locality: "Denver",
          region: "CO",
          locationMode: "EXACT",
          placeId: null,
          status: "PUBLISHED",
          gateType: "NONE",
        })),
        listTicketTypes: vi.fn(async () => []),
      },
      imageModerationRecords: {
        resolveByKeys: vi.fn(async () => new Map()),
      },
    } as unknown as GetEmbedForWidgetDeps["repos"],
    search: { autocomplete: vi.fn() } as unknown as GetEmbedForWidgetDeps["search"],
    publicAppUrl: "http://localhost:3000",
    clock: { now: () => TEST_NOW },
    logger: createTestLogger(),
  } satisfies GetEmbedForWidgetDeps;
}

describe("getEmbedForWidget — each card carries its event's zone", () => {
  it("grid: the zone comes from the event row, not the index", async () => {
    const result = await getEmbedForWidget(
      gridDeps(
        [
          // Indexed before the zone was stored: no `timezone` on the document.
          suggestion("ev-old", undefined),
          // The index disagrees with the row; the row wins.
          suggestion("ev-moved", "America/New_York"),
        ],
        [
          { id: "ev-old", timezone: "America/Denver" },
          { id: "ev-moved", timezone: "America/Los_Angeles" },
        ],
      ),
      widgetInput,
    );

    expect(result.events?.map((e) => [e.id, e.timezone])).toEqual([
      ["ev-old", "America/Denver"],
      ["ev-moved", "America/Los_Angeles"],
    ]);
  });

  it("grid: an unusable stored zone reads as the platform default", async () => {
    const result = await getEmbedForWidget(
      gridDeps(
        [suggestion("ev-bad", undefined)],
        [{ id: "ev-bad", timezone: "Not/AZone" }],
      ),
      widgetInput,
    );

    expect(result.events?.[0]?.timezone).toBe("America/Chicago");
  });

  it("single event: the event's own zone", async () => {
    const result = await getEmbedForWidget(
      singleEventDeps("America/Denver"),
      widgetInput,
    );

    expect(result.event?.timezone).toBe("America/Denver");
  });

  it("single event: an unusable stored zone reads as the platform default", async () => {
    const result = await getEmbedForWidget(
      singleEventDeps("Not/AZone"),
      widgetInput,
    );

    expect(result.event?.timezone).toBe("America/Chicago");
  });
});
