import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "@th/test-utils/fakes/logger";
import { makeImageModerationGateFake } from "@th/test-utils/fakes/image-moderation";
import { makeTicketCapacityUsageFake } from "@th/test-utils/fakes/ticket-capacity";

import {
  getEmbedEventDetail,
  isEmbedSalesClosed,
  type GetEmbedEventDetailDeps,
} from "../get-embed-event-detail";

// FR-003: the price resolver requires an injected instant. Frozen so these
// assertions describe a fixed moment, and set far enough in the past that no
// fixture's schedule (none of them have one) could flip under it.
const TEST_NOW = new Date("2026-01-01T00:00:00.000Z");
const testClock = { now: () => TEST_NOW };

// ─────────────────────────────────────────────────────────────────────────────
// `salesClosed` mirrors the canonical purchase guard `ensureEventOnSale`
// (checkout-helpers): closed when now >= (endsAt ?? startsAt). The widget uses
// it to suppress buyable UI up front instead of failing at submit with
// EVENT_SALES_CLOSED.
// ─────────────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-07-27T12:00:00Z");
const PAST = new Date("2026-07-20T20:00:00Z");
const FUTURE = new Date("2026-08-03T20:00:00Z");

describe("isEmbedSalesClosed", () => {
  it("past event (endsAt passed) → true", () => {
    expect(
      isEmbedSalesClosed(PAST, new Date("2026-07-20T23:00:00Z"), NOW),
    ).toBe(true);
  });

  it("endsAt null + startsAt passed → true", () => {
    expect(isEmbedSalesClosed(PAST, null, NOW)).toBe(true);
  });

  it("future event → false", () => {
    expect(isEmbedSalesClosed(FUTURE, null, NOW)).toBe(false);
  });

  it("ongoing event (started, endsAt still ahead) → false — door sales stay open", () => {
    expect(
      isEmbedSalesClosed(new Date("2026-07-27T10:00:00Z"), FUTURE, NOW),
    ).toBe(false);
  });

  it("exactly at close → true (same >= boundary as ensureEventOnSale)", () => {
    expect(isEmbedSalesClosed(PAST, NOW, NOW)).toBe(true);
  });
});

// ── Payload wiring ───────────────────────────────────────────────────────────

const EMBED_ID = "00000000-0000-4000-8000-0000000000f0";
const EVENT_ID = "00000000-0000-4000-8000-0000000000f2";
const ORIGIN = "https://embedder.example.com";

function detailDeps(event: { startsAt: Date; endsAt: Date | null }) {
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
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          currency: "usd",
          heroImageUrl: null,
          heroImageKey: null,
          addressText: "123 Main",
          locality: "Nashville",
          region: "TN",
          status: "PUBLISHED",
          gateType: "NONE",
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

/**
 * FIXTURES ARE RELATIVE TO `TEST_NOW`, NOT `Date.now()`.
 *
 * They used to be wall-clock relative, which worked only because the payload
 * resolved `salesClosed` from a bare `new Date()` while the prices beside it
 * resolved from the INJECTED clock. Phase 2b made the two share one instant —
 * per-tier sellability folds the event-level close in, so resolving them
 * against different clocks lets the payload contradict itself. No production
 * behaviour change: there the injected clock IS the wall clock.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

describe("getEmbedEventDetail salesClosed payload field", () => {
  it("ended event → salesClosed: true", async () => {
    const startsAt = new Date(TEST_NOW.getTime() - 3 * DAY_MS);
    const endsAt = new Date(TEST_NOW.getTime() - 2 * DAY_MS);
    const result = await getEmbedEventDetail(detailDeps({ startsAt, endsAt }), {
      embedId: EMBED_ID,
      eventId: EVENT_ID,
      hostOrigin: ORIGIN,
    });
    expect(result.salesClosed).toBe(true);
  });

  it("endsAt null + startsAt passed → salesClosed: true", async () => {
    const startsAt = new Date(TEST_NOW.getTime() - DAY_MS);
    const result = await getEmbedEventDetail(
      detailDeps({ startsAt, endsAt: null }),
      { embedId: EMBED_ID, eventId: EVENT_ID, hostOrigin: ORIGIN },
    );
    expect(result.salesClosed).toBe(true);
  });

  it("future event → salesClosed: false", async () => {
    const startsAt = new Date(TEST_NOW.getTime() + 7 * DAY_MS);
    const result = await getEmbedEventDetail(
      detailDeps({ startsAt, endsAt: null }),
      { embedId: EMBED_ID, eventId: EVENT_ID, hostOrigin: ORIGIN },
    );
    expect(result.salesClosed).toBe(false);
  });

  it("resolves salesClosed from the INJECTED clock, not the wall clock", async () => {
    // Directly pins the fix: an event that ended a year before TEST_NOW but is
    // still in the real-world future would read `false` from a bare
    // `new Date()`. If this ever flips, the two halves of the payload have
    // drifted apart again.
    const startsAt = new Date(TEST_NOW.getTime() - 365 * DAY_MS);
    const result = await getEmbedEventDetail(
      detailDeps({ startsAt, endsAt: null }),
      { embedId: EMBED_ID, eventId: EVENT_ID, hostOrigin: ORIGIN },
    );
    expect(result.salesClosed).toBe(true);
  });
});
