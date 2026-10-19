/**
 * A TRUTHFUL sold-out signal, on every buyer-facing surface that carries one,
 * in ONE file — for the same reason `per-type-sellability-sites.test.ts` and
 * `scheduled-price-flip-sites.test.ts` exist: the acceptance criterion is "the
 * public ticket list and the embed both stop offering a tier that checkout will
 * refuse", and split across two files that is a claim nobody can check.
 *
 * WHAT WAS BROKEN. Both clients tested `capacity <= 0`. `TicketType.capacity`
 * is the AUTHORED column and no write path decrements it, so that test was
 * essentially never true: a sold-out tier rendered a live quantity stepper, the
 * buyer filled in the whole form, and the pre-charge capacity gate refused them
 * at submit with TICKET_TYPE_SOLD_OUT. Correct (nobody was charged), and a poor
 * experience. `soldOut` / `remainingCapacity` are the server-computed
 * replacement, on the SAME basis the gate refuses on.
 */
import { describe, expect, it, vi } from "vitest";

import type { EventTicketTypeSummary } from "@th/types";
import { makeStubTicketTypeSummary } from "@th/test-utils";
import { createTestLogger } from "@th/test-utils/fakes/logger";
import { makeImageModerationGateFake } from "@th/test-utils/fakes/image-moderation";
import { makeTicketCapacityUsageFake } from "@th/test-utils/fakes/ticket-capacity";

import { listEventTicketTypes } from "../list-event-ticket-types";
import { getEmbedEventDetail } from "../../embeds/get-embed-event-detail";
import type { GetEmbedEventDetailDeps } from "../../embeds/get-embed-event-detail";

// ── Ids and instants ─────────────────────────────────────────────────────────

const NOW = new Date("2026-10-01T20:00:00.000Z");
const clockAt = (now: Date) => ({ now: () => now });

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const EMBED_ID = "55555555-5555-4555-8555-555555555555";
const ORIGIN = "https://embedder.example.com";

const TT_GONE = "aaaaaaa0-0000-4000-8000-000000000001";
const TT_LEFT = "aaaaaaa0-0000-4000-8000-000000000002";
const TT_HELD = "aaaaaaa0-0000-4000-8000-000000000003";

/**
 * THE MIXED SET. Three tiers of identical authored capacity whose only
 * difference is what has happened to their stock:
 *
 *   GONE  every unit issued                    → soldOut, 0 remaining
 *   LEFT  a few issued                         → not sold out, exact remainder
 *   HELD  last units in OTHER buyers' carts    → soldOut (see the holds note)
 */
const TIERS: EventTicketTypeSummary[] = [
  makeStubTicketTypeSummary({
    id: TT_GONE,
    name: "Sold out",
    priceCents: 2500,
    capacity: 10,
  }),
  makeStubTicketTypeSummary({
    id: TT_LEFT,
    name: "Still available",
    priceCents: 2500,
    capacity: 10,
  }),
  makeStubTicketTypeSummary({
    id: TT_HELD,
    name: "All in carts",
    priceCents: 2500,
    capacity: 10,
  }),
];

const USAGE = {
  [TT_GONE]: { issued: 10 },
  [TT_LEFT]: { issued: 6 },
  [TT_HELD]: { issued: 7, held: 3 },
};

function baseEvent(overrides?: Record<string, unknown>) {
  return {
    id: EVENT_ID,
    title: "Sold Out Show",
    slug: "sold-out-show",
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

const byId = <T extends { id: string }>(rows: T[], id: string): T =>
  rows.find((row) => row.id === id)!;

// ── Surface 1: the public ticket list ────────────────────────────────────────

function publicDeps(
  tiers: EventTicketTypeSummary[] = TIERS,
  usage: Record<string, { issued?: number; held?: number }> = USAGE,
) {
  return {
    repos: {
      events: {
        getById: vi.fn(async () => baseEvent()),
        listTicketTypes: vi.fn(async () => tiers),
      },
      seats: { getSectionById: vi.fn(async () => null) },
      payees: {
        getBySubject: vi.fn(async () => ({ id: "payee-1" })),
        getById: vi.fn(async () => ({
          id: "payee-1",
          status: "ACTIVE",
          chargesEnabled: true,
          payoutsEnabled: true,
        })),
      },
      ...makeTicketCapacityUsageFake(usage),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    clock: clockAt(NOW),
  };
}

describe("listEventTicketTypes — truthful sold-out signal", () => {
  it("gives each tier of the mixed set its own correct stock state", async () => {
    const result = await listEventTicketTypes(publicDeps(), {
      eventId: EVENT_ID,
    });

    expect(byId(result.ticketTypes, TT_GONE)).toMatchObject({
      soldOut: true,
      remainingCapacity: 0,
    });
    expect(byId(result.ticketTypes, TT_LEFT)).toMatchObject({
      soldOut: false,
      remainingCapacity: 4,
    });
    expect(byId(result.ticketTypes, TT_HELD)).toMatchObject({
      soldOut: true,
      remainingCapacity: 0,
    });
  });

  it("leaves the AUTHORED capacity column untouched on the wire", async () => {
    const result = await listEventTicketTypes(publicDeps(), {
      eventId: EVENT_ID,
    });

    // Live consumers (the seat-map picker, mobile's per-tier quantity cap)
    // still read `capacity` as the tier's configured size. Removing it would
    // break them; deriving availability from it is what was broken.
    for (const tier of result.ticketTypes) {
      expect(tier.capacity).toBe(10);
    }
  });

  it("keeps sold-out and the sales WINDOW as independent facts", async () => {
    // A tier can be BOTH sold out and not yet on sale. Folding sold-out into
    // `sellability` would have to pick one reason and lose the other; the
    // clients OR them into one "no stepper" decision and render both notices.
    const notYetOpen = makeStubTicketTypeSummary({
      id: TT_GONE,
      name: "Late release, already gone",
      priceCents: 2500,
      capacity: 10,
      salesOpenAt: new Date(NOW.getTime() + 86_400_000),
    });

    const result = await listEventTicketTypes(
      publicDeps([notYetOpen], { [TT_GONE]: { issued: 10 } }),
      { eventId: EVENT_ID },
    );

    const tier = byId(result.ticketTypes, TT_GONE);
    expect(tier.soldOut).toBe(true);
    expect(tier.sellability.reason).toBe("not_yet_on_sale");
    expect(tier.sellability.opensAt).toEqual(
      new Date(NOW.getTime() + 86_400_000),
    );
  });
});

// ── Surface 2: the embed widget ──────────────────────────────────────────────

function embedDeps(
  tiers: EventTicketTypeSummary[] = TIERS,
  usage: Record<string, { issued?: number; held?: number }> = USAGE,
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
        getById: vi.fn(async () => baseEvent()),
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
      ...makeTicketCapacityUsageFake(usage),
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

describe("getEmbedEventDetail — truthful sold-out signal", () => {
  it("returns the SAME stock fields, with the same values, as the public list", async () => {
    const [embed, publicList] = await Promise.all([
      runEmbed(embedDeps()),
      listEventTicketTypes(publicDeps(), { eventId: EVENT_ID }),
    ]);

    // An embed and the event page showing the same event must not describe
    // its stock in two dialects.
    for (const id of [TT_GONE, TT_LEFT, TT_HELD]) {
      const fromEmbed = byId(embed.ticketTypes, id);
      const fromPage = byId(publicList.ticketTypes, id);
      expect({
        soldOut: fromEmbed.soldOut,
        remainingCapacity: fromEmbed.remainingCapacity,
      }).toEqual({
        soldOut: fromPage.soldOut,
        remainingCapacity: fromPage.remainingCapacity,
      });
    }
  });

  it("counts other buyers' unexpired holds against remaining capacity", async () => {
    // Pins the holds decision on THIS surface too. Under the opposite choice
    // (issued-only, as the POS listing deliberately uses) this tier would
    // report 3 remaining inside a partner's iframe, and checkout would answer
    // TICKET_TYPE_TEMPORARILY_HELD.
    const result = await runEmbed(embedDeps());
    expect(byId(result.ticketTypes, TT_HELD)).toMatchObject({
      soldOut: true,
      remainingCapacity: 0,
    });
  });

  it("counts every tier in ONE batched, lock-free call", async () => {
    const deps = embedDeps();
    await runEmbed(deps);

    const ticketsMock = (
      deps.repos as unknown as {
        tickets: {
          countCapacityUsageForTicketTypes: ReturnType<typeof vi.fn>;
          lockAndCountCapacityForTicketType?: ReturnType<typeof vi.fn>;
        };
      }
    ).tickets;

    // Three tiers, one round trip — never one per tier on a public read.
    expect(ticketsMock.countCapacityUsageForTicketTypes).toHaveBeenCalledTimes(
      1,
    );
    // And NEVER the advisory-locking counter: an embed page view must not
    // queue behind a live checkout for the same tier.
    expect(ticketsMock.lockAndCountCapacityForTicketType).toBeUndefined();
  });
});
