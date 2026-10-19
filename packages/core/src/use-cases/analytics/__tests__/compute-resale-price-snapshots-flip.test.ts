/**
 * FR-004 decision test for `computeResalePriceSnapshots`.
 *
 * The decision (argued at length in the use case): this basis is LIVE, and
 * "live" means the price resolved at `now`, not the raw `priceCents`. The
 * snapshot answers "what should a seller ask TOMORROW", is keyed
 * (event, ticketType, date) with no order or ticket in sight, and is multiplied
 * by a forward-looking heuristic — so anchoring it to a stale pre-flip price
 * would systematically under-suggest for every scheduled tier.
 *
 * This is NOT the same question as FR-001's resale FACE VALUE, which is
 * per-ticket and historical and reads OrderItem.unitPriceCents. That distinction
 * is the point of this file.
 */
import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "@th/test-utils/fakes/logger";

import { computeResalePriceSnapshots } from "../compute-resale-price-snapshots";

const T = new Date("2026-10-01T20:00:00.000Z");
const BEFORE = new Date(T.getTime() - 1_000);
const AFTER = new Date(T.getTime() + 60 * 60 * 1000);

const EARLY_BIRD_CENTS = 1200;
const FULL_PRICE_CENTS = 2000;

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const TT_ID = "22222222-2222-4222-8222-222222222222";

function makeDeps(now: Date, ticketTypeOverrides?: Record<string, unknown>) {
  const upsertResaleSnapshotBatch = vi.fn(
    async (rows: unknown[]) => rows.length,
  );

  const repos = {
    events: {
      listPublished: vi.fn(async () => ({
        items: [
          {
            id: EVENT_ID,
            // Comfortably inside the lookahead window.
            startsAt: new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000),
            resalePayoutTermsId: "terms-1",
          },
        ],
      })),
      listTicketTypesForEventIds: vi.fn(async () => [
        {
          id: TT_ID,
          eventId: EVENT_ID,
          priceCents: EARLY_BIRD_CENTS,
          capacity: 100,
          resaleAllowed: true,
          resaleCapCents: null,
          scheduledPriceCents: FULL_PRICE_CENTS,
          scheduledPriceAt: T,
          ...ticketTypeOverrides,
        },
      ]),
    },
    analytics: {
      getLatestDailyStatsBatch: vi.fn(async () => []),
      upsertResaleSnapshotBatch,
    },
    resaleListings: {
      // Below minSampleSize → the heuristic path, which multiplies the face
      // price. Keeps the assertion about the BASIS, not about market data.
      getCompletedResalePrices: vi.fn(async () => []),
    },
  } as any;

  return {
    deps: {
      repos,
      clock: { now: () => now },
      logger: createTestLogger(),
    } as any,
    upsertResaleSnapshotBatch,
  };
}

async function snapshotAt(now: Date, overrides?: Record<string, unknown>) {
  const { deps, upsertResaleSnapshotBatch } = makeDeps(now, overrides);
  await computeResalePriceSnapshots(deps, {
    lookaheadDays: 180,
    minSampleSize: 3,
  });
  const rows = upsertResaleSnapshotBatch.mock.calls[0]?.[0] as
    | Array<{ facePriceCents: number; suggestedPriceCents: number }>
    | undefined;
  return rows?.[0];
}

describe("computeResalePriceSnapshots — LIVE basis, resolved (FR-004 decision)", () => {
  it("anchors to the pre-flip price before T", async () => {
    const row = await snapshotAt(BEFORE);
    expect(row?.facePriceCents).toBe(EARLY_BIRD_CENTS);
  });

  it("anchors to the POST-flip price after T — not the stale stored one", async () => {
    // The regression this test exists for: reading `tt.priceCents` here would
    // keep suggesting early-bird-based asks for the rest of the event's life.
    const row = await snapshotAt(AFTER);
    expect(row?.facePriceCents).toBe(FULL_PRICE_CENTS);
    expect(row?.facePriceCents).not.toBe(EARLY_BIRD_CENTS);
  });

  it("moves the suggested price with the basis", async () => {
    const before = await snapshotAt(BEFORE);
    const after = await snapshotAt(AFTER);
    expect(after!.suggestedPriceCents).toBeGreaterThan(
      before!.suggestedPriceCents,
    );
  });

  it("NFR-001: an unscheduled tier snapshots identically on both sides of T", async () => {
    const plain = { scheduledPriceCents: null, scheduledPriceAt: null };
    expect((await snapshotAt(BEFORE, plain))?.facePriceCents).toBe(
      EARLY_BIRD_CENTS,
    );
    expect((await snapshotAt(AFTER, plain))?.facePriceCents).toBe(
      EARLY_BIRD_CENTS,
    );
  });

  it("skips a tier that becomes FREE at T (no resale basis for a $0 ticket)", async () => {
    const becomesFree = { scheduledPriceCents: 0 };
    expect(await snapshotAt(BEFORE, becomesFree)).toBeDefined();
    // After the flip the effective price is 0, which the existing `=== 0`
    // guard skips — the same behaviour a permanently-free tier already gets.
    expect(await snapshotAt(AFTER, becomesFree)).toBeUndefined();
  });
});
