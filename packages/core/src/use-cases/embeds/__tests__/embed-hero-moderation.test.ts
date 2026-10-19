import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "@th/test-utils/fakes/logger";
import { makeImageModerationGateFake } from "@th/test-utils/fakes/image-moderation";
import { makeTicketCapacityUsageFake } from "@th/test-utils/fakes/ticket-capacity";
import type { ImageModerationStatus } from "@th/types/repos/image-moderation-records";

import {
  getEmbedForWidget,
  type GetEmbedForWidgetDeps,
} from "../get-embed-for-widget";
import {
  getEmbedEventDetail,
  type GetEmbedEventDetailDeps,
} from "../get-embed-event-detail";

// FR-003: the price resolver requires an injected instant. Frozen so these
// assertions describe a fixed moment, and set far enough in the past that no
// fixture's schedule (none of them have one) could flip under it.
const TEST_NOW = new Date("2026-01-01T00:00:00.000Z");
const testClock = { now: () => TEST_NOW };

// ─────────────────────────────────────────────────────────────────────────────
// Read-time moderation gate (FR-005) on the public embed surfaces.
// ─────────────────────────────────────────────────────────────────────────────

const EMBED_ID = "00000000-0000-4000-8000-0000000000e0";
const ORG_ID = "00000000-0000-4000-8000-0000000000e1";
const EVENT_ID = "00000000-0000-4000-8000-0000000000e2";
const DOMAIN = "embedder.example.com";
const ORIGIN = "https://embedder.example.com";
const HERO_KEY = "events/e/images/hero.png";
const HERO_URL = "https://cdn.example/events/e/images/hero.png";

const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

const widgetEvent = () => ({
  id: EVENT_ID,
  title: "Embedded Show",
  slug: "embedded-show",
  startsAt: future,
  endsAt: null,
  currency: "usd",
  heroImageUrl: HERO_URL,
  heroImageKey: HERO_KEY,
  addressText: "123 Main",
  locality: "Nashville",
  region: "TN",
  orgId: ORG_ID,
  status: "PUBLISHED",
  gateType: "NONE",
});

// ── getEmbedForWidget (organization grid) ────────────────────────────────
//
// The org/human grid is now fully search-served. Hero moderation is applied AT
// INDEX TIME (build-search-index drops non-APPROVED heroes before indexing), so
// the grid serves the index-gated `imageUrl` verbatim and runs NO second
// runtime gate — consistent with the platform-wide search grid. These tests
// pin that contract: the grid returns whatever `imageUrl` search hands back and
// does not call `resolveByKeys`.

function widgetOrgDeps(imageUrl: string | null) {
  const gate = makeImageModerationGateFake({});
  const autocomplete = vi.fn(async () => ({
    ok: true as const,
    value: {
      suggestions: [
        {
          type: "event" as const,
          id: `doc-${EVENT_ID}`,
          eventId: EVENT_ID,
          title: "Embedded Show",
          subtitle: null,
          helper: null,
          slug: "embedded-show",
          startsAt: future,
          endsAt: null,
          city: "Nashville",
          region: "TN",
          location: "123 Main",
          lat: null,
          lng: null,
          imageUrl,
          lowestPriceCents: null,
          lowestBuyerTotalCents: null,
          currency: "usd",
          paidTierCount: 0,
          hasFreeTier: false,
          confidence: 1,
        },
      ],
      latencyMs: 1,
    },
  }));
  return {
    deps: {
      repos: {
        embeds: {
          getById: vi.fn(async () => ({
            id: EMBED_ID,
            domain: DOMAIN,
            subjectType: "organization",
            subjectId: ORG_ID,
            status: "ACTIVE",
            requireAuth: false,
            linkOut: false,
            defaultView: "list",
            viewToggle: false,
          })),
        },
        organizations: {
          getById: vi.fn(async () => ({
            id: ORG_ID,
            name: "Demo Org",
            slug: "demo-org",
          })),
        },
        places: { listOwnedBySubject: vi.fn(async () => []) },
        events: {
          // The card's gate comes from the event row (the index has none).
          findManyByIds: vi.fn(async (ids: string[]) =>
            ids.map((id) => ({ id, gateType: "NONE" })),
          ),
        },
        imageModerationRecords: gate.imageModerationRecords,
        ...makeTicketCapacityUsageFake(),
      } as unknown as GetEmbedForWidgetDeps["repos"],
      search: { autocomplete } as unknown as GetEmbedForWidgetDeps["search"],
      publicAppUrl: "http://localhost:3000",
      clock: testClock,
      logger: createTestLogger(),
    } satisfies GetEmbedForWidgetDeps,
    resolveByKeys: gate.imageModerationRecords.resolveByKeys,
  };
}

describe("getEmbedForWidget grid (index-time-gated hero)", () => {
  it("serves the index-gated imageUrl and runs NO runtime moderation gate", async () => {
    const { deps, resolveByKeys } = widgetOrgDeps(HERO_URL);
    const result = await getEmbedForWidget(deps, {
      embedId: EMBED_ID,
      hostOrigin: ORIGIN,
    });
    expect(result.events?.[0]?.heroImageUrl).toBe(HERO_URL);
    // The grid does not re-gate — moderation was applied when indexing.
    expect(resolveByKeys).not.toHaveBeenCalled();
  });

  it("renders no hero when the index carries none (dropped at index time)", async () => {
    const { deps } = widgetOrgDeps(null);
    const result = await getEmbedForWidget(deps, {
      embedId: EMBED_ID,
      hostOrigin: ORIGIN,
    });
    expect(result.events?.[0]?.heroImageUrl).toBeNull();
  });
});

// ── getEmbedForWidget (single event) ─────────────────────────────────────

function widgetEventDeps(statusByKey: Record<string, ImageModerationStatus>) {
  const gate = makeImageModerationGateFake(statusByKey);
  return {
    repos: {
      embeds: {
        getById: vi.fn(async () => ({
          id: EMBED_ID,
          domain: DOMAIN,
          subjectType: "event",
          subjectId: EVENT_ID,
          status: "ACTIVE",
          requireAuth: false,
          linkOut: false,
        })),
      },
      events: {
        getById: vi.fn(async () => widgetEvent()),
        listTicketTypes: vi.fn(async () => []),
      },
      imageModerationRecords: gate.imageModerationRecords,
      ...makeTicketCapacityUsageFake(),
    } as unknown as GetEmbedForWidgetDeps["repos"],
    // Single-event path reads the event directly; search is never consulted.
    search: {
      autocomplete: vi.fn(),
    } as unknown as GetEmbedForWidgetDeps["search"],
    publicAppUrl: "http://localhost:3000",
    clock: testClock,
    logger: createTestLogger(),
  } satisfies GetEmbedForWidgetDeps;
}

describe("getEmbedForWidget hero moderation gate (single event)", () => {
  it("shows an APPROVED hero", async () => {
    const result = await getEmbedForWidget(
      widgetEventDeps({ [HERO_KEY]: "APPROVED" }),
      { embedId: EMBED_ID, hostOrigin: ORIGIN },
    );
    expect(result.event?.heroImageUrl).toBe(HERO_URL);
  });

  it("omits a FLAGGED hero", async () => {
    const result = await getEmbedForWidget(
      widgetEventDeps({ [HERO_KEY]: "FLAGGED" }),
      { embedId: EMBED_ID, hostOrigin: ORIGIN },
    );
    expect(result.event?.heroImageUrl).toBeNull();
  });

  it("shows a legacy hero (no record)", async () => {
    const result = await getEmbedForWidget(widgetEventDeps({}), {
      embedId: EMBED_ID,
      hostOrigin: ORIGIN,
    });
    expect(result.event?.heroImageUrl).toBe(HERO_URL);
  });
});

// ── getEmbedEventDetail (single event) ───────────────────────────────────

function detailDeps(statusByKey: Record<string, ImageModerationStatus>) {
  const gate = makeImageModerationGateFake(statusByKey);
  return {
    repos: {
      embeds: {
        getById: vi.fn(async () => ({
          id: EMBED_ID,
          domain: DOMAIN,
          subjectType: "event",
          subjectId: EVENT_ID,
          status: "ACTIVE",
          requireAuth: false,
          linkOut: false,
        })),
      },
      events: {
        getById: vi.fn(async () => ({
          ...widgetEvent(),
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
      tags: { getEventTags: vi.fn(async () => []) },
      images: { resolveByIds: vi.fn(async () => []) },
      seats: { listSectionsByEvent: vi.fn(async () => []) },
      seriesOccurrences: {
        findSeriesIdByEventId: vi.fn(async () => null),
        listPublishedDatesBySeriesId: vi.fn(async () => []),
      },
      imageModerationRecords: gate.imageModerationRecords,
      ...makeTicketCapacityUsageFake(),
    } as unknown as GetEmbedEventDetailDeps["repos"],
    publicAppUrl: "http://localhost:3000",
    clock: testClock,
    logger: createTestLogger(),
  } satisfies GetEmbedEventDetailDeps;
}

describe("getEmbedEventDetail hero moderation gate", () => {
  it("shows an APPROVED hero", async () => {
    const result = await getEmbedEventDetail(
      detailDeps({ [HERO_KEY]: "APPROVED" }),
      { embedId: EMBED_ID, eventId: EVENT_ID, hostOrigin: ORIGIN },
    );
    expect(result.event.heroImageUrl).toBe(HERO_URL);
  });

  it.each<ImageModerationStatus>(["PENDING", "FLAGGED", "REJECTED"])(
    "omits a %s hero",
    async (status) => {
      const result = await getEmbedEventDetail(
        detailDeps({ [HERO_KEY]: status }),
        {
          embedId: EMBED_ID,
          eventId: EVENT_ID,
          hostOrigin: ORIGIN,
        },
      );
      expect(result.event.heroImageUrl).toBeNull();
    },
  );

  it("shows a legacy hero (no record)", async () => {
    const result = await getEmbedEventDetail(detailDeps({}), {
      embedId: EMBED_ID,
      eventId: EVENT_ID,
      hostOrigin: ORIGIN,
    });
    expect(result.event.heroImageUrl).toBe(HERO_URL);
  });
});
