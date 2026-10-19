import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "@th/test-utils/fakes/logger";

import {
  listEmbedAvailableSeats,
  type ListEmbedAvailableSeatsDeps,
} from "../list-embed-available-seats";

// FR-003: the price resolver requires an injected instant. Frozen so these
// assertions describe a fixed moment, and set far enough in the past that no
// fixture's schedule (none of them have one) could flip under it.
const TEST_NOW = new Date("2026-01-01T00:00:00.000Z");
const testClock = { now: () => TEST_NOW };

const EMBED_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const SECTION_ID = "33333333-3333-4333-8333-333333333333";

function buildDeps(
  overrides: Partial<ListEmbedAvailableSeatsDeps> = {},
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
        listTicketTypes: vi.fn(async () => []),
        getById: vi.fn(async () => ({
          id: EVENT_ID,
          orgId: "44444444-4444-4444-8444-444444444444",
          status: "PUBLISHED",
          gateType: "NONE",
          admissionTaxRateBps: 900,
        })),
      },
      seats: {
        getSectionById: vi.fn(async () => ({
          id: SECTION_ID,
          name: "Floor",
          type: "RESERVED",
          capacity: 50,
        })),
        listAvailableBySection: vi.fn(async () => [
          {
            id: "55555555-5555-4555-8555-555555555555",
            label: "A1",
            row: "A",
            number: 1,
            status: "AVAILABLE",
            geometry: null,
            priceOverride: { priceCents: 4000, reason: "front row" },
          },
        ]),
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
    clock: testClock,
    logger: createTestLogger(),
    ...overrides,
  };
}

describe("listEmbedAvailableSeats", () => {
  it("returns buyer totals for override seats", async () => {
    const deps = buildDeps();

    const result = await listEmbedAvailableSeats(deps, {
      embedId: EMBED_ID,
      hostOrigin: "https://embedder.example.com",
      eventId: EVENT_ID,
      seatSectionId: SECTION_ID,
    });

    expect(result.seats).toEqual([
      expect.objectContaining({
        id: "55555555-5555-4555-8555-555555555555",
        priceOverride: {
          priceCents: 4000,
          buyerTotalCents: 4360,
        },
      }),
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Jurisdictional taxable base — same rule as the first-party seat map: an ALL-IN
// per-seat override price has to be built from the venue's taxable base, or the
// embed quotes below what checkout charges.
// ─────────────────────────────────────────────────────────────────────────────
describe("listEmbedAvailableSeats — per-seat override taxable base", () => {
  const SEAT_ID = "55555555-5555-4555-8555-555555555555";
  const FACE_CENTS = 2500;
  /** The charge for this fixture, pinned in create-checkout.test.ts. */
  const TN_CHARGE_CENTS = 2925;
  /** What HEAD quoted for the same seat (face-only base). */
  const FACE_CHARGE_CENTS = 2909;

  type Situs = {
    countryCode: string | null;
    region: string | null;
    postalCode: string | null;
  };

  const NASHVILLE: Situs = {
    countryCode: "US",
    region: "TN",
    postalCode: "37203",
  };
  const MIAMI: Situs = { countryCode: "US", region: "FL", postalCode: "33139" };

  function buildPassThroughDeps(situs: Situs): ListEmbedAvailableSeatsDeps {
    const feePolicy = {
      id: "policy-1",
      version: 1,
      status: "ACTIVE",
      feeMode: "PASS_THROUGH",
      buyerFeePct: 0,
      maxFeeCents: null,
      minFeeCents: 0,
      maxPlatformFeeCents: null,
      platformFixedCents: 50,
      processsorFeePct: 0.029,
      processorFixedCents: 30,
      payoutPct: 0,
      payoutFixedCents: 0,
      monthlyPayoutCents: 0,
    };
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
          listTicketTypes: vi.fn(async () => []),
          getById: vi.fn(async () => ({
            id: EVENT_ID,
            orgId: "44444444-4444-4444-8444-444444444444",
            status: "PUBLISHED",
            gateType: "NONE",
            admissionTaxRateBps: 975,
            // Inline jurisdiction — no Place / SavedLocation read needed.
            placeId: null,
            savedLocationId: null,
            postalCode: situs.postalCode,
            countryCode: situs.countryCode,
            region: situs.region,
          })),
        },
        seats: {
          getSectionById: vi.fn(async () => ({
            id: SECTION_ID,
            name: "Floor",
            type: "RESERVED",
            capacity: 50,
          })),
          listAvailableBySection: vi.fn(async () => [
            {
              id: SEAT_ID,
              label: "A1",
              row: "A",
              number: 1,
              status: "AVAILABLE",
              geometry: null,
              priceOverride: { priceCents: FACE_CENTS, reason: "front row" },
            },
          ]),
        },
        payoutTerms: {
          listByEvent: vi.fn(async () => [
            {
              id: "agreement-1",
              kind: "PRIMARY",
              status: "ACTIVE",
              feeMode: "PASS_THROUGH",
              feePolicyId: "policy-1",
              version: 1,
            },
          ]),
          listLines: vi.fn(async () => [
            {
              id: "line-1",
              agreementId: "agreement-1",
              payeeId: "payee-1",
              percent: 100,
              floorCents: 0,
              capPercent: null,
              priority: 0,
              rounding: "FLOOR",
            },
          ]),
        },
        feePolicies: {
          getById: vi.fn(async (id: string) =>
            id === "policy-1" ? feePolicy : null,
          ),
          resolveEffective: vi.fn(async () => null),
        },
        places: { getById: vi.fn(async () => null) },
        savedLocations: { getById: vi.fn(async () => null) },
      } as unknown as ListEmbedAvailableSeatsDeps["repos"],
      clock: testClock,
      logger: createTestLogger(),
    };
  }

  const overrideTotal = async (situs: Situs) => {
    const result = await listEmbedAvailableSeats(buildPassThroughDeps(situs), {
      embedId: EMBED_ID,
      hostOrigin: "https://embedder.example.com",
      eventId: EVENT_ID,
      seatSectionId: SECTION_ID,
    });
    return result.seats[0]?.priceOverride?.buyerTotalCents;
  };

  it("US/TN: the override seat quotes the CHARGE (2925), not the face-only 2909", async () => {
    expect(await overrideTotal(NASHVILLE)).toBe(TN_CHARGE_CENTS);
  });

  it("US/FL is byte-identical to HEAD", async () => {
    expect(await overrideTotal(MIAMI)).toBe(FACE_CHARGE_CENTS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NULL admission-tax stamp — checkout resolves the rate LIVE. The override seat
// is quoted at the rate the embed's regular seats use (`getCheckoutFeeRates`
// → `resolveQuoteTaxRateBps`): a cached venue rate, 0 with no location, and
// no buyer total at all when the rate is unknown (never a 0%-tax figure).
// ─────────────────────────────────────────────────────────────────────────────
describe("listEmbedAvailableSeats — NULL admission-tax stamp", () => {
  const PAID_SEAT = "55555555-5555-4555-8555-555555555555";
  const FREE_SEAT = "66666666-6666-4666-8666-666666666666";
  const PLACE_ID = "77777777-7777-4777-8777-777777777777";

  function buildUnstampedDeps(
    admissionTaxRateBps: number | null | undefined,
    place: { cachedRateBps: number | null } | null,
  ): ListEmbedAvailableSeatsDeps {
    const deps = buildDeps();
    const repos = deps.repos as unknown as {
      events: { getById: ReturnType<typeof vi.fn> };
      seats: { listAvailableBySection: ReturnType<typeof vi.fn> };
      places: { getById: unknown };
      savedLocations: { getById: unknown };
    };
    repos.events.getById.mockImplementation(async () => ({
      id: EVENT_ID,
      orgId: "44444444-4444-4444-8444-444444444444",
      status: "PUBLISHED",
      gateType: "NONE",
      admissionTaxRateBps,
      placeId: place ? PLACE_ID : null,
      savedLocationId: null,
    }));
    repos.places = {
      getById: vi.fn(async () =>
        place
          ? {
              id: PLACE_ID,
              countryCode: "US",
              region: "FL",
              postalCode: "33139",
              admissionTaxRateBps: place.cachedRateBps,
              taxRateSource: place.cachedRateBps == null ? null : "ziptax",
            }
          : null,
      ),
    };
    repos.savedLocations = { getById: vi.fn(async () => null) };
    repos.seats.listAvailableBySection.mockImplementation(async () => [
      {
        id: PAID_SEAT,
        label: "A1",
        row: "A",
        number: 1,
        status: "AVAILABLE",
        geometry: null,
        priceOverride: { priceCents: 4000, reason: "front row" },
      },
      {
        id: FREE_SEAT,
        label: "A2",
        row: "A",
        number: 2,
        status: "AVAILABLE",
        geometry: null,
        priceOverride: { priceCents: 0, reason: "comp" },
      },
    ]);
    return deps;
  }

  const overrideOf = async (deps: ListEmbedAvailableSeatsDeps, seatId: string) => {
    const result = await listEmbedAvailableSeats(deps, {
      embedId: EMBED_ID,
      hostOrigin: "https://embedder.example.com",
      eventId: EVENT_ID,
      seatSectionId: SECTION_ID,
    });
    return result.seats.find((s) => s.id === seatId)?.priceOverride;
  };

  it("a cached venue rate gives the override a real all-in total (4360 at 9%)", async () => {
    const override = await overrideOf(
      buildUnstampedDeps(null, { cachedRateBps: 900 }),
      PAID_SEAT,
    );
    expect(override?.buyerTotalCents).toBe(4360);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
  ])(
    "a %s stamp with a cache miss gives the PAID override no buyer total",
    async (_label, stamp) => {
      const override = await overrideOf(
        buildUnstampedDeps(stamp, { cachedRateBps: null }),
        PAID_SEAT,
      );
      expect(override?.buyerTotalCents).toBeNull();
      expect(override?.priceCents).toBe(4000);
    },
  );

  it("a cache miss keeps a $0 override's genuine 0 (tax on $0 is $0)", async () => {
    const override = await overrideOf(
      buildUnstampedDeps(null, { cachedRateBps: null }),
      FREE_SEAT,
    );
    expect(override?.buyerTotalCents).toBe(0);
  });

  it("no location at all: checkout charges 0 tax, so the total is taxed at 0", async () => {
    const override = await overrideOf(buildUnstampedDeps(null, null), PAID_SEAT);
    expect(override?.buyerTotalCents).toBe(4000);
  });

  it("a stamped event is unchanged (4360 for 4000 at 9%)", async () => {
    const override = await overrideOf(buildUnstampedDeps(900, null), PAID_SEAT);
    expect(override?.buyerTotalCents).toBe(4360);
  });
});
