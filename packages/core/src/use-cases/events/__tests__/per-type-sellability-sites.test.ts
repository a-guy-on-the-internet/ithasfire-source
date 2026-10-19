/**
 * FR-010 — PER-TICKET-TYPE sellability across every surface that carries it,
 * in ONE file for the same reason `scheduled-price-flip-sites.test.ts` exists:
 * the acceptance criterion is "an event with one open and one not-yet-open tier
 * renders distinct, correct states on the public page AND in an embed", and
 * split across four files that is a claim nobody can check.
 *
 * THE MIXED SET, used by every surface below, is the shape the feature exists
 * for — four tiers whose only difference is their window:
 *
 *   OPEN      salesOpenAt in the past, salesCloseAt in the future  → buyable
 *   NOT_YET   salesOpenAt in the future                            → refused, with the open instant
 *   ENDED     salesCloseAt in the past                             → refused, with the close instant
 *   PLAIN     no window at all                                     → NFR-001, behaves exactly as today
 *
 * Spec: docs/specs/2026-08-10/completed/time-based-ticket-pricing.spec.yaml FR-010,
 * FR-009, Q-002, NFR-001.
 */
import { describe, expect, it, vi } from "vitest";

import type { EventTicketTypeSummary } from "@th/types";
import { makeStubTicketTypeSummary } from "@th/test-utils";
import { createTestLogger } from "@th/test-utils/fakes/logger";
import { makeImageModerationGateFake } from "@th/test-utils/fakes/image-moderation";
import { makeTicketCapacityUsageFake } from "@th/test-utils/fakes/ticket-capacity";
import type { AuthZPort } from "@th/ports/authz";
import type { Repos } from "@th/ports/repos";

import { listEventTicketTypes } from "../list-event-ticket-types";
import { summarizePricing } from "../_shared/event-pricing";
import { getEmbedEventDetail } from "../../embeds/get-embed-event-detail";
import type { GetEmbedEventDetailDeps } from "../../embeds/get-embed-event-detail";
import { listSellableItems } from "../../pos/list-sellable-items";

// ── Instants ─────────────────────────────────────────────────────────────────

const NOW = new Date("2026-10-01T20:00:00.000Z");
const PAST = new Date("2026-09-01T20:00:00.000Z");
const FUTURE = new Date("2026-10-08T15:00:00.000Z");
const clockAt = (now: Date) => ({ now: () => now });

// ── Ids ──────────────────────────────────────────────────────────────────────

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const EMBED_ID = "55555555-5555-4555-8555-555555555555";
const ACTOR_ID = "66666666-6666-4666-8666-666666666666";
const ORIGIN = "https://embedder.example.com";

const TT_OPEN = "aaaaaaa0-0000-4000-8000-000000000001";
const TT_NOT_YET = "aaaaaaa0-0000-4000-8000-000000000002";
const TT_ENDED = "aaaaaaa0-0000-4000-8000-000000000003";
const TT_PLAIN = "aaaaaaa0-0000-4000-8000-000000000004";

// ── The mixed set ────────────────────────────────────────────────────────────

const MIXED_TIERS: EventTicketTypeSummary[] = [
  makeStubTicketTypeSummary({
    id: TT_OPEN,
    name: "Advance",
    priceCents: 1500,
    salesOpenAt: PAST,
    salesCloseAt: FUTURE,
  }),
  makeStubTicketTypeSummary({
    id: TT_NOT_YET,
    name: "Late release",
    priceCents: 3000,
    salesOpenAt: FUTURE,
  }),
  makeStubTicketTypeSummary({
    id: TT_ENDED,
    name: "Early bird",
    priceCents: 500,
    salesCloseAt: PAST,
  }),
  makeStubTicketTypeSummary({
    id: TT_PLAIN,
    name: "General",
    priceCents: 2500,
  }),
];

/** Every tier unwindowed — the NFR-001 control group. */
const PLAIN_TIERS: EventTicketTypeSummary[] = [
  makeStubTicketTypeSummary({ id: TT_PLAIN, name: "General", priceCents: 2500 }),
];

function baseEvent(overrides?: Record<string, unknown>) {
  return {
    id: EVENT_ID,
    title: "Windowed Show",
    slug: "windowed-show",
    status: "PUBLISHED",
    gateType: "NONE",
    orgId: ORG_ID,
    humanId: null,
    attendanceMode: "TICKETED",
    placeLayoutId: null,
    startsAt: new Date("2026-12-01T20:00:00.000Z"),
    endsAt: new Date("2026-12-01T23:00:00.000Z"),
    timezone: "America/Chicago",
    currency: "usd",
    heroImageUrl: null,
    heroImageKey: null,
    addressText: "123 Main",
    locality: "Nashville",
    region: "TN",
    locationMode: "EXACT",
    lat: 36.1,
    lng: -86.8,
    locationRadiusMeters: null,
    waitlistStatus: "DISABLED",
    waitlistDescription: null,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The public ticket list
// ─────────────────────────────────────────────────────────────────────────────

function publicDeps(
  tiers: EventTicketTypeSummary[],
  eventOverrides?: Record<string, unknown>,
  payeeHealthy = true,
) {
  return {
    repos: {
      events: {
        getById: vi.fn(async () => baseEvent(eventOverrides)),
        listTicketTypes: vi.fn(async () => tiers),
      },
      seats: { getSectionById: vi.fn(async () => null) },
      // Per-tier availability (lock-free batch read): nothing issued or held,
      // so every tier is fully available and these window assertions stand.
      ...makeTicketCapacityUsageFake(),
      payees: {
        getBySubject: vi.fn(async () => (payeeHealthy ? { id: "payee-1" } : null)),
        getById: vi.fn(async () => ({
          id: "payee-1",
          status: "ACTIVE",
          chargesEnabled: true,
          payoutsEnabled: true,
        })),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    clock: clockAt(NOW),
  };
}

const byId = <T extends { id: string }>(rows: T[], id: string): T =>
  rows.find((row) => row.id === id)!;

describe("listEventTicketTypes — per-tier sellability (FR-010)", () => {
  it("gives each tier of a mixed set its own distinct, correct state", async () => {
    const result = await listEventTicketTypes(publicDeps(MIXED_TIERS), {
      eventId: EVENT_ID,
    });

    expect(byId(result.ticketTypes, TT_OPEN).sellability).toEqual({
      available: true,
      reason: "ok",
      opensAt: null,
      closedAt: null,
    });
    expect(byId(result.ticketTypes, TT_NOT_YET).sellability).toEqual({
      available: false,
      reason: "not_yet_on_sale",
      opensAt: FUTURE,
      closedAt: null,
    });
    expect(byId(result.ticketTypes, TT_ENDED).sellability).toEqual({
      available: false,
      reason: "sales_ended",
      opensAt: null,
      closedAt: PAST,
    });
    expect(byId(result.ticketTypes, TT_PLAIN).sellability).toEqual({
      available: true,
      reason: "ok",
      opensAt: null,
      closedAt: null,
    });
  });

  it("keeps the EVENT-level flag available while a sibling tier is closed", async () => {
    // The whole point of the move: "not on sale yet" is a tier fact, and it
    // must not drag the event-wide verdict down with it.
    const result = await listEventTicketTypes(publicDeps(MIXED_TIERS), {
      eventId: EVENT_ID,
    });
    expect(result.sellability).toEqual({ available: true, reason: "ok" });
  });

  it("lets the EVENT-level reason win on every tier once the event has ended", async () => {
    const result = await listEventTicketTypes(
      publicDeps(MIXED_TIERS, {
        startsAt: new Date("2026-09-01T18:00:00.000Z"),
        endsAt: new Date("2026-09-01T23:00:00.000Z"), // before NOW
      }),
      { eventId: EVENT_ID },
    );

    expect(result.sellability.reason).toBe("sales_closed");
    for (const tt of result.ticketTypes) {
      expect(tt.sellability.available, tt.name).toBe(false);
      expect(tt.sellability.reason, tt.name).toBe("sales_closed");
      // No "come back Friday" invitation on an event that already happened.
      expect(tt.sellability.opensAt, tt.name).toBeNull();
    }
  });

  it("lets stripe_not_connected win over a tier's own window", async () => {
    const result = await listEventTicketTypes(
      publicDeps(MIXED_TIERS, undefined, false),
      { eventId: EVENT_ID },
    );
    expect(result.sellability.reason).toBe("stripe_not_connected");
    expect(byId(result.ticketTypes, TT_NOT_YET).sellability.reason).toBe(
      "stripe_not_connected",
    );
  });

  it("NFR-001: an unwindowed, unscheduled tier mirrors the event-level answer", async () => {
    const result = await listEventTicketTypes(publicDeps(PLAIN_TIERS), {
      eventId: EVENT_ID,
    });
    const tier = byId(result.ticketTypes, TT_PLAIN);
    expect(tier.sellability.available).toBe(result.sellability.available);
    expect(tier.sellability.reason).toBe(result.sellability.reason);
    expect(tier.sellability.opensAt).toBeNull();
    expect(tier.sellability.closedAt).toBeNull();
    expect(tier.upcomingPriceChange).toBeNull();
  });
});

describe("listEventTicketTypes — upcoming price change (Q-002)", () => {
  const scheduled = (at: Date) => [
    makeStubTicketTypeSummary({
      id: TT_PLAIN,
      name: "Early Bird",
      priceCents: 1200,
      scheduledPriceCents: 2000,
      scheduledPriceAt: at,
    }),
  ];

  it("BEFORE the flip: quotes $12 and offers the pending $20", async () => {
    const result = await listEventTicketTypes(publicDeps(scheduled(FUTURE)), {
      eventId: EVENT_ID,
    });
    const tier = byId(result.ticketTypes, TT_PLAIN);
    expect(tier.priceCents).toBe(1200);
    expect(tier.upcomingPriceChange).toEqual({ toPriceCents: 2000, at: FUTURE });
  });

  it("AFTER the flip: quotes $20 and offers NOTHING — never still 'until'", async () => {
    const result = await listEventTicketTypes(publicDeps(scheduled(PAST)), {
      eventId: EVENT_ID,
    });
    const tier = byId(result.ticketTypes, TT_PLAIN);
    expect(tier.priceCents).toBe(2000);
    expect(tier.upcomingPriceChange).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Embeds — the second, previously incompatible representation
// ─────────────────────────────────────────────────────────────────────────────

function embedDeps(
  tiers: EventTicketTypeSummary[],
  eventOverrides?: Record<string, unknown>,
): GetEmbedEventDetailDeps {
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
        getById: vi.fn(async () => baseEvent(eventOverrides)),
        listTicketTypes: vi.fn(async () => tiers),
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
    clock: clockAt(NOW),
    logger: createTestLogger(),
  };
}

const runEmbed = (deps: GetEmbedEventDetailDeps) =>
  getEmbedEventDetail(deps, {
    embedId: EMBED_ID,
    eventId: EVENT_ID,
    hostOrigin: ORIGIN,
  });

describe("getEmbedEventDetail — per-tier sellability (FR-010)", () => {
  it("gains the SAME per-tier shape the public list returns", async () => {
    const result = await runEmbed(embedDeps(MIXED_TIERS));

    expect(byId(result.ticketTypes, TT_OPEN).sellability.available).toBe(true);
    expect(byId(result.ticketTypes, TT_NOT_YET).sellability).toEqual({
      available: false,
      reason: "not_yet_on_sale",
      opensAt: FUTURE,
      closedAt: null,
    });
    expect(byId(result.ticketTypes, TT_ENDED).sellability).toEqual({
      available: false,
      reason: "sales_ended",
      opensAt: null,
      closedAt: PAST,
    });
    expect(byId(result.ticketTypes, TT_PLAIN).sellability.available).toBe(true);
  });

  it("KEEPS the top-level salesClosed boolean working (the live consumer)", async () => {
    // `EmbedEventDetail.tsx` gates its entire buyable UI on
    // `data.salesClosed === true`. The per-tier shape is additive; this is the
    // regression that would otherwise take out every embedded checkout.
    const open = await runEmbed(embedDeps(MIXED_TIERS));
    expect(open.salesClosed).toBe(false);

    const ended = await runEmbed(
      embedDeps(MIXED_TIERS, {
        startsAt: new Date("2026-09-01T18:00:00.000Z"),
        endsAt: new Date("2026-09-01T23:00:00.000Z"),
      }),
    );
    expect(ended.salesClosed).toBe(true);
  });

  it("agrees with its own salesClosed flag on every tier", async () => {
    // The contradiction this guards: a tier reporting `not_yet_on_sale`
    // ("come back Friday") beside a top-level salesClosed:true. Reachable only
    // if the two were resolved against different clocks, which is exactly what
    // the code did before Phase 2b (`new Date()` here, `clock.now()` there).
    const ended = await runEmbed(
      embedDeps(MIXED_TIERS, {
        startsAt: new Date("2026-09-01T18:00:00.000Z"),
        endsAt: new Date("2026-09-01T23:00:00.000Z"),
      }),
    );
    expect(ended.salesClosed).toBe(true);
    for (const tt of ended.ticketTypes) {
      expect(tt.sellability.reason, tt.name).toBe("sales_closed");
      expect(tt.sellability.available, tt.name).toBe(false);
    }
  });

  it("carries the Q-002 price-change copy in both tenses", async () => {
    const before = await runEmbed(
      embedDeps([
        makeStubTicketTypeSummary({
          id: TT_PLAIN,
          priceCents: 1200,
          scheduledPriceCents: 2000,
          scheduledPriceAt: FUTURE,
        }),
      ]),
    );
    expect(byId(before.ticketTypes, TT_PLAIN).priceCents).toBe(1200);
    expect(byId(before.ticketTypes, TT_PLAIN).upcomingPriceChange).toEqual({
      toPriceCents: 2000,
      at: FUTURE,
    });

    const after = await runEmbed(
      embedDeps([
        makeStubTicketTypeSummary({
          id: TT_PLAIN,
          priceCents: 1200,
          scheduledPriceCents: 2000,
          scheduledPriceAt: PAST,
        }),
      ]),
    );
    expect(byId(after.ticketTypes, TT_PLAIN).priceCents).toBe(2000);
    expect(byId(after.ticketTypes, TT_PLAIN).upcomingPriceChange).toBeNull();
  });

  it("NFR-001: an unwindowed tier is available with reason ok", async () => {
    const result = await runEmbed(embedDeps(PLAIN_TIERS));
    expect(byId(result.ticketTypes, TT_PLAIN).sellability).toEqual({
      available: true,
      reason: "ok",
      opensAt: null,
      closedAt: null,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POS — the till listing (surfacing only; enforcement already lands at sale)
// ─────────────────────────────────────────────────────────────────────────────

const denyingAuthz = {
  hasStaffRole: vi.fn(async () => ({ allowed: false })),
} as unknown as AuthZPort;

function posDeps(tiers: EventTicketTypeSummary[]) {
  return {
    repos: {
      events: {
        getById: vi.fn(async () => ({
          id: EVENT_ID,
          orgId: ORG_ID,
          status: "PUBLISHED",
          currency: "usd",
          timezone: "America/Chicago",
        })),
        listTicketTypes: vi.fn(async () => tiers),
      },
      authz: {
        getOrgMembership: vi.fn(async () => ({
          orgId: ORG_ID,
          humanId: ACTOR_ID,
          role: "SCANNER" as const,
        })),
      },
      tickets: {
        countIssuedForTicketType: vi.fn(async () => 0),
        // The till listing shares the pre-charge gate's basis now
        // (capacity - issued - held), so it reads capacity through the same
        // availability helper the public sold-out badge uses.
        countCapacityUsageForTicketTypes: vi.fn(
          async ({ ticketTypeIds }: { ticketTypeIds: string[] }) =>
            ticketTypeIds.map((ticketTypeId) => ({
              ticketTypeId,
              issued: 0,
              held: 0,
            })),
        ),
      },
    } as unknown as Repos,
    authz: denyingAuthz,
    clock: clockAt(NOW),
  };
}

describe("listSellableItems — per-tier sellability at the till (FR-010)", () => {
  const run = (tiers: EventTicketTypeSummary[]) =>
    listSellableItems(posDeps(tiers), {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
    });

  it("still LISTS a windowed tier, but says why it cannot be sold", async () => {
    // Surfacing, not filtering: hiding the row is how a door team concludes the
    // tier was never configured. The till already refuses it at sale time.
    const result = await run(MIXED_TIERS);
    expect(result.ticketTypes).toHaveLength(4);

    const notYet = result.ticketTypes.find(
      (t) => t.ticketTypeId === TT_NOT_YET,
    )!;
    expect(notYet.sellability).toEqual({
      available: false,
      reason: "not_yet_on_sale",
      opensAt: FUTURE,
      closedAt: null,
    });

    const ended = result.ticketTypes.find((t) => t.ticketTypeId === TT_ENDED)!;
    expect(ended.sellability.reason).toBe("sales_ended");
    expect(ended.sellability.closedAt).toEqual(PAST);
  });

  it("has NO event-wide close — a door tier stays sellable after doors", async () => {
    // The POS asymmetry, preserved deliberately: `ok` is the honest event-level
    // verdict at a till, because cash needs no payee and door sales happen
    // after the event starts.
    const result = await run(MIXED_TIERS);
    const open = result.ticketTypes.find((t) => t.ticketTypeId === TT_OPEN)!;
    expect(open.sellability).toEqual({
      available: true,
      reason: "ok",
      opensAt: null,
      closedAt: null,
    });
  });

  it("carries the EVENT's timezone so the till renders the venue's clock", async () => {
    expect((await run(MIXED_TIERS)).timezone).toBe("America/Chicago");
  });

  it("NFR-001: an unwindowed tier is plain `ok`", async () => {
    const result = await run(PLAIN_TIERS);
    expect(result.ticketTypes[0]!.sellability).toEqual({
      available: true,
      reason: "ok",
      opensAt: null,
      closedAt: null,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The "$25+" card label — a price CLAIM, so only purchasable tiers may pin it
// ─────────────────────────────────────────────────────────────────────────────

describe("summarizePricing — windowed tiers must not pin a card price", () => {
  it("ignores a not-yet-open FREE tier that would otherwise say 'Free'", async () => {
    // The live failure: "Early RSVP — free, opens Monday" beside "General $30"
    // made the browse card read **Free** all weekend while the only purchasable
    // tier was $30 and checkout correctly threw TICKET_TYPE_NOT_YET_ON_SALE.
    const summary = summarizePricing(
      [
        makeStubTicketTypeSummary({
          id: TT_NOT_YET,
          priceCents: 0,
          salesOpenAt: FUTURE,
        }),
        makeStubTicketTypeSummary({ id: TT_PLAIN, priceCents: 3000 }),
      ],
      NOW,
    );
    expect(summary).toEqual({
      hasFreeTier: false,
      hasPayWhatYouWantTier: false,
      paidTierCount: 1,
      minPaidPriceCents: 3000,
    });
  });

  it("ignores an ELAPSED early bird that would otherwise pin 'from $5'", async () => {
    const summary = summarizePricing(
      [
        makeStubTicketTypeSummary({
          id: TT_ENDED,
          priceCents: 500,
          salesCloseAt: PAST,
        }),
        makeStubTicketTypeSummary({ id: TT_PLAIN, priceCents: 3000 }),
      ],
      NOW,
    );
    expect(summary.minPaidPriceCents).toBe(3000);
    expect(summary.paidTierCount).toBe(1);
  });

  it("rolls up only the OPEN and UNWINDOWED tiers of the mixed set", async () => {
    // Advance $15 (open) + General $25 (unwindowed); Late release $30 and
    // Early bird $5 contribute nothing.
    expect(summarizePricing(MIXED_TIERS, NOW)).toEqual({
      hasFreeTier: false,
      hasPayWhatYouWantTier: false,
      paidTierCount: 2,
      minPaidPriceCents: 1500,
    });
  });

  it("an event whose tiers are ALL not-yet-open quotes NOTHING, deliberately", async () => {
    // Zeroed rollup → `formatPriceLabel` renders its "See details" fallback.
    // Declining to quote is the honest answer; the click lands on a detail page
    // that now says exactly when the tier opens.
    expect(
      summarizePricing(
        [
          makeStubTicketTypeSummary({
            id: TT_NOT_YET,
            priceCents: 3000,
            salesOpenAt: FUTURE,
          }),
        ],
        NOW,
      ),
    ).toEqual({
      hasFreeTier: false,
      hasPayWhatYouWantTier: false,
      paidTierCount: 0,
      minPaidPriceCents: null,
    });
  });

  it("NFR-001: a purely unwindowed event rolls up exactly as before", async () => {
    expect(
      summarizePricing(
        [
          makeStubTicketTypeSummary({ id: TT_PLAIN, priceCents: 2500 }),
          makeStubTicketTypeSummary({ id: TT_OPEN, priceCents: 0 }),
        ],
        NOW,
      ),
    ).toEqual({
      hasFreeTier: true,
      hasPayWhatYouWantTier: false,
      paidTierCount: 1,
      minPaidPriceCents: 2500,
    });
  });

  it("respects the half-open boundary at the window edges", async () => {
    // Open is INCLUSIVE: a tier opening at exactly NOW pins its price.
    expect(
      summarizePricing(
        [makeStubTicketTypeSummary({ priceCents: 700, salesOpenAt: NOW })],
        NOW,
      ).minPaidPriceCents,
    ).toBe(700);
    // Close is EXCLUSIVE: a tier closing at exactly NOW does not.
    expect(
      summarizePricing(
        [makeStubTicketTypeSummary({ priceCents: 700, salesCloseAt: NOW })],
        NOW,
      ).minPaidPriceCents,
    ).toBeNull();
  });
});
