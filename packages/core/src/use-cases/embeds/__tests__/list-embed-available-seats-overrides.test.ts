import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "@th/test-utils/fakes/logger";

import {
  listEmbedAvailableSeats,
  listEmbedAvailableSeatsOutputSchema,
  type ListEmbedAvailableSeatsDeps,
} from "../list-embed-available-seats";

// Per-seat overrides on the embed seat map: privacy of `reason`, and quoting
// through the same per-seat resolver the charge path uses.

const TEST_NOW = new Date("2026-01-01T00:00:00.000Z");
const clock = { now: () => TEST_NOW };

const EMBED_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const SECTION_ID = "33333333-3333-4333-8333-333333333333";
const TIER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SEAT_PAID = "55555555-5555-4555-8555-555555555555";
const SEAT_FREE = "66666666-6666-4666-8666-666666666666";
const SEAT_PLAIN = "77777777-7777-4777-8777-777777777777";

const seat = (id: string, priceOverride: unknown) => ({
  id,
  label: "A1",
  row: "A",
  number: 1,
  status: "AVAILABLE",
  geometry: null,
  priceOverride,
});

const tier = (over: Record<string, unknown> = {}) => ({
  id: TIER,
  name: "GA",
  description: null,
  priceCents: 2000,
  pricingMode: "FIXED",
  minimumCents: null,
  suggestedCents: null,
  capacity: 10,
  status: "ACTIVE",
  seatSectionId: SECTION_ID,
  resaleAllowed: false,
  resaleCapCents: null,
  transferAllowed: false,
  scheduledPriceCents: null,
  scheduledPriceAt: null,
  salesOpenAt: null,
  salesCloseAt: null,
  ...over,
});

function buildDeps(
  seats: unknown[],
  tiers: unknown[],
  extra: Partial<ListEmbedAvailableSeatsDeps> = {},
): ListEmbedAvailableSeatsDeps {
  return {
    repos: {
      embeds: {
        getById: vi.fn(async () => ({
          id: EMBED_ID,
          domain: "embedder.example.com",
          status: "ACTIVE",
          subjectType: "event",
          subjectId: EVENT_ID,
        })),
      },
      events: {
        getById: vi.fn(async () => ({
          id: EVENT_ID,
          orgId: "44444444-4444-4444-8444-444444444444",
          status: "PUBLISHED",
          gateType: "NONE",
          admissionTaxRateBps: 1000,
        })),
        listTicketTypes: vi.fn(async () => tiers),
      },
      seats: {
        getSectionById: vi.fn(async () => ({
          id: SECTION_ID,
          name: "Floor",
          type: "RESERVED",
          capacity: 50,
        })),
        listAvailableBySection: vi.fn(async () => seats),
      },
      payoutTerms: {
        listByEvent: vi.fn(async () => []),
        listLines: vi.fn(async () => []),
      },
      feePolicies: {
        getById: vi.fn(async () => null),
        resolveEffective: vi.fn(async () => null),
      },
    } as unknown as ListEmbedAvailableSeatsDeps["repos"],
    clock,
    logger: createTestLogger(),
    ...extra,
  };
}

const run = (deps: ListEmbedAvailableSeatsDeps) =>
  listEmbedAvailableSeats(deps, {
    embedId: EMBED_ID,
    eventId: EVENT_ID,
    seatSectionId: SECTION_ID,
    hostOrigin: "https://embedder.example.com",
  });

describe("listEmbedAvailableSeats — overrides", () => {
  it("never returns the organizer's private reason", async () => {
    const result = await run(
      buildDeps(
        [seat(SEAT_PAID, { priceCents: 4000, reason: "friend of the band" })],
        [tier()],
      ),
    );
    expect(result.seats[0]!.priceOverride).toEqual({
      priceCents: 4000,
      buyerTotalCents: 4400,
    });
    expect(JSON.stringify(result)).not.toContain("friend of the band");
    expect(JSON.stringify(result)).not.toContain("reason");
  });

  it("the output schema rejects a reason field", () => {
    const parse = (priceOverride: Record<string, unknown>) =>
      listEmbedAvailableSeatsOutputSchema.parse({
        section: { id: SECTION_ID, name: "F", type: "RESERVED", capacity: 1 },
        seats: [{ ...seat(SEAT_PAID, null), priceOverride }],
      });
    expect(() => parse({ priceCents: 1 })).not.toThrow();
    expect(() => parse({ priceCents: 1, reason: "leak" })).toThrow();
  });

  it("quotes an override through the resolver: it replaces the tier price", async () => {
    const result = await run(
      buildDeps(
        [seat(SEAT_PAID, { priceCents: 4000 }), seat(SEAT_PLAIN, null)],
        [tier({ priceCents: 2000 })],
      ),
    );
    const byId = new Map(result.seats.map((s) => [s.id, s]));
    expect(byId.get(SEAT_PAID)!.priceOverride).toEqual({
      priceCents: 4000,
      buyerTotalCents: 4400,
    });
    expect(byId.get(SEAT_PLAIN)!.priceOverride).toBeNull();
  });

  it("quotes a $0 override as free", async () => {
    const result = await run(
      buildDeps([seat(SEAT_FREE, { priceCents: 0 })], [tier()]),
    );
    expect(result.seats[0]!.priceOverride).toEqual({
      priceCents: 0,
      buyerTotalCents: 0,
    });
  });

  it("an ADJUSTABLE tier's seat shows no override", async () => {
    const result = await run(
      buildDeps(
        [seat(SEAT_PAID, { priceCents: 4000 })],
        [tier({ pricingMode: "ADJUSTABLE", minimumCents: 500 })],
      ),
    );
    expect(result.seats[0]!.priceOverride).toBeNull();
  });

  it("a corrupt override is shown as none, reported, and does not blank the map", async () => {
    const reportError = vi.fn();
    const result = await run(
      buildDeps(
        [
          seat(SEAT_PAID, { priceCents: 12.5 }),
          seat(SEAT_FREE, { priceCents: 1000 }),
        ],
        [tier()],
        { reportError },
      ),
    );
    const byId = new Map(result.seats.map((s) => [s.id, s]));
    expect(result.seats).toHaveLength(2);
    expect(byId.get(SEAT_PAID)!.priceOverride).toBeNull();
    expect(byId.get(SEAT_FREE)!.priceOverride).toEqual({
      priceCents: 1000,
      buyerTotalCents: 1100,
    });
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("a section with two FIXED tiers quotes the override, whichever tier sells it", async () => {
    const result = await run(
      buildDeps(
        [seat(SEAT_PAID, { priceCents: 5000 })],
        [
          tier({ priceCents: 3500 }),
          tier({
            id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            priceCents: 2000,
          }),
        ],
      ),
    );
    expect(result.seats[0]!.priceOverride?.priceCents).toBe(5000);
  });

  // LEGACY ROWS (W1). `setSeatPriceOverrides` now refuses an override on any
  // section with an ACTIVE ADJUSTABLE tier (spec FR-006); only a row written
  // before that refusal, or a tier made ADJUSTABLE later, reaches this. The
  // read side is unchanged, as in list-event-seat-availability-overrides.
  it("legacy row: a section with a FIXED and an ADJUSTABLE tier is quoted as the override (writes now refuse it)", async () => {
    const result = await run(
      buildDeps(
        [seat(SEAT_PAID, { priceCents: 4000 })],
        [
          tier(),
          tier({
            id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            pricingMode: "ADJUSTABLE",
            minimumCents: 500,
          }),
        ],
      ),
    );
    expect(result.seats[0]!.priceOverride?.priceCents).toBe(4000);
  });
});
