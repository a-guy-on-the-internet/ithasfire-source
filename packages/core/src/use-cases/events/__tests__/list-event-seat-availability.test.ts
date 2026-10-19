import { describe, expect, it, vi } from "vitest";

import { listEventSeatAvailability } from "../list-event-seat-availability";
import type { ListEventSeatAvailabilityDeps } from "../list-event-seat-availability";
import { createTestLogger } from "@th/test-utils/fakes/logger";

// FR-003: the price resolver requires an injected instant. Frozen so these
// assertions describe a fixed moment, and set far enough in the past that no
// fixture's schedule (none of them have one) could flip under it.
const TEST_NOW = new Date("2026-01-01T00:00:00.000Z");
const testClock = { now: () => TEST_NOW };

// ── Fixtures ─────────────────────────────────────────────────────────────────

const EVENT_ID = "d3f3f3f3-a1a1-4b2b-8c3c-111111111111";

const SEAT_IDS = {
  seat1: "11111111-1111-4111-8111-111111111111",
  seat2: "22222222-2222-4222-8222-222222222222",
  seat3: "33333333-3333-4333-8333-333333333333",
  seat4: "44444444-4444-4444-8444-444444444444",
} as const;

const SECTION_IDS = {
  secA: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  secB: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
} as const;

function buildPublishedEvent() {
  return {
    id: EVENT_ID,
    status: "PUBLISHED" as const,
    orgId: null,
    admissionTaxRateBps: 825,
  };
}

function buildSeats() {
  return [
    {
      id: SEAT_IDS.seat1,
      seatSectionId: SECTION_IDS.secA,
      eventId: EVENT_ID,
      status: "AVAILABLE" as const,
      label: "A1",
      row: "A",
      number: 1,
    },
    {
      id: SEAT_IDS.seat2,
      seatSectionId: SECTION_IDS.secA,
      eventId: EVENT_ID,
      status: "HELD" as const,
      label: "A2",
      row: "A",
      number: 2,
      priceOverride: { priceCents: 3000, reason: "VIP row" },
    },
    {
      id: SEAT_IDS.seat3,
      seatSectionId: SECTION_IDS.secB,
      eventId: EVENT_ID,
      status: "SOLD" as const,
      label: "B1",
      row: "B",
      number: 1,
    },
    {
      id: SEAT_IDS.seat4,
      seatSectionId: SECTION_IDS.secB,
      eventId: EVENT_ID,
      status: "BLOCKED" as const,
      label: "B2",
      row: "B",
      number: 2,
    },
  ];
}

function buildDeps(
  overrides: Partial<ListEventSeatAvailabilityDeps> = {},
): ListEventSeatAvailabilityDeps {
  const eventsRepo = {
    getById: vi.fn(async () => buildPublishedEvent()),
    listTicketTypes: vi.fn(async () => []),
  };

  const seatsRepo = {
    listByEvent: vi.fn(async () => buildSeats()),
  };

  const repos = {
    events: eventsRepo,
    seats: seatsRepo,
    payoutTerms: {
      listByEvent: vi.fn(async () => []),
      listLines: vi.fn(async () => []),
    },
    feePolicies: {
      getById: vi.fn(async () => null),
      resolveEffective: vi.fn(async () => null),
    },
  } as unknown as ListEventSeatAvailabilityDeps["repos"];

  return {
    repos,
    clock: testClock,
    logger: createTestLogger(),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("listEventSeatAvailability", () => {
  it("returns all seats with their current status", async () => {
    const deps = buildDeps();

    const result = await listEventSeatAvailability(deps, { eventId: EVENT_ID });

    expect(result.eventId).toBe(EVENT_ID);
    expect(result.seats).toHaveLength(4);
    expect(result.seats).toEqual(
      expect.arrayContaining([
        {
          id: SEAT_IDS.seat1,
          seatSectionId: SECTION_IDS.secA,
          status: "AVAILABLE",
          label: "A1",
          row: "A",
          number: 1,
          priceOverride: null,
        },
        {
          id: SEAT_IDS.seat2,
          seatSectionId: SECTION_IDS.secA,
          status: "HELD",
          label: "A2",
          row: "A",
          number: 2,
          priceOverride: {
            priceCents: 3000,
            buyerTotalCents: 3248,
          },
        },
        {
          id: SEAT_IDS.seat3,
          seatSectionId: SECTION_IDS.secB,
          status: "SOLD",
          label: "B1",
          row: "B",
          number: 1,
          priceOverride: null,
        },
        {
          id: SEAT_IDS.seat4,
          seatSectionId: SECTION_IDS.secB,
          status: "BLOCKED",
          label: "B2",
          row: "B",
          number: 2,
          priceOverride: null,
        },
      ]),
    );
  });

  it("returns empty seats array when event has no seats", async () => {
    const deps = buildDeps({
      repos: {
        events: { getById: vi.fn(async () => buildPublishedEvent()) },
        seats: { listByEvent: vi.fn(async () => []) },
      } as unknown as ListEventSeatAvailabilityDeps["repos"],
    });

    const result = await listEventSeatAvailability(deps, { eventId: EVENT_ID });

    expect(result.eventId).toBe(EVENT_ID);
    expect(result.seats).toHaveLength(0);
  });

  it("throws not_found when event does not exist", async () => {
    const deps = buildDeps({
      repos: {
        events: { getById: vi.fn(async () => null) },
        seats: { listByEvent: vi.fn() },
      } as unknown as ListEventSeatAvailabilityDeps["repos"],
    });

    await expect(
      listEventSeatAvailability(deps, { eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("throws conflict when event is not published", async () => {
    const deps = buildDeps({
      repos: {
        events: {
          getById: vi.fn(async () => ({
            ...buildPublishedEvent(),
            status: "DRAFT",
          })),
        },
        seats: { listByEvent: vi.fn() },
      } as unknown as ListEventSeatAvailabilityDeps["repos"],
    });

    await expect(
      listEventSeatAvailability(deps, { eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_ON_SALE" });
  });

  it("throws invalid_input for missing eventId", async () => {
    const deps = buildDeps();

    await expect(listEventSeatAvailability(deps, {})).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("throws invalid_input for non-uuid eventId", async () => {
    const deps = buildDeps();

    await expect(
      listEventSeatAvailability(deps, { eventId: "not-a-uuid" }),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("passes eventId to seats.listByEvent", async () => {
    const deps = buildDeps();

    await listEventSeatAvailability(deps, { eventId: EVENT_ID });

    expect(deps.repos.seats.listByEvent).toHaveBeenCalledWith({
      eventId: EVENT_ID,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Jurisdictional taxable base on a per-seat OVERRIDE price
//
// The override seat's `buyerTotalCents` is an ALL-IN number, and the same map
// takes its NON-override seat prices from `events.getCheckoutFeeRates`, which is
// base-aware. On a Tennessee event a defaulted face-only base put two identical
// $25 seats on one map at $29.09 (override) and $29.25 (non-override) — with the
// override one UNDER what checkout charges, and ~$4 under on a $500 override
// seat, which is exactly where overrides get used.
// ─────────────────────────────────────────────────────────────────────────────
describe("listEventSeatAvailability — per-seat override taxable base", () => {
  const OVERRIDE_SEAT = "99999999-9999-4999-8999-999999999999";
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
  const NOWHERE: Situs = { countryCode: null, region: null, postalCode: null };

  /** PASS_THROUGH, flat 50¢ platform fee, Stripe card rate — the charge fixture. */
  function buildPassThroughDeps(situs: Situs): ListEventSeatAvailabilityDeps {
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
    const repos = {
      events: {
        listTicketTypes: vi.fn(async () => []),
        getById: vi.fn(async () => ({
          id: EVENT_ID,
          status: "PUBLISHED" as const,
          orgId: null,
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
        listByEvent: vi.fn(async () => [
          {
            id: OVERRIDE_SEAT,
            seatSectionId: SECTION_IDS.secA,
            eventId: EVENT_ID,
            status: "AVAILABLE" as const,
            label: "A9",
            row: "A",
            number: 9,
            priceOverride: { priceCents: FACE_CENTS, reason: "VIP" },
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
    } as unknown as ListEventSeatAvailabilityDeps["repos"];

    return { repos, clock: testClock, logger: createTestLogger() };
  }

  const overrideTotal = async (situs: Situs) => {
    const result = await listEventSeatAvailability(
      buildPassThroughDeps(situs),
      { eventId: EVENT_ID },
    );
    return result.seats.find((seat) => seat.id === OVERRIDE_SEAT)?.priceOverride
      ?.buyerTotalCents;
  };

  it("US/TN: the override seat quotes the CHARGE (2925), not the face-only 2909", async () => {
    expect(await overrideTotal(NASHVILLE)).toBe(TN_CHARGE_CENTS);
    expect(await overrideTotal(NASHVILLE)).not.toBe(FACE_CHARGE_CENTS);
  });

  it("US/FL and a situs-less event are byte-identical to HEAD", async () => {
    expect(await overrideTotal(MIAMI)).toBe(FACE_CHARGE_CENTS);
    expect(await overrideTotal(NOWHERE)).toBe(FACE_CHARGE_CENTS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NULL admission-tax stamp — checkout resolves the rate LIVE. The override seat
// is quoted at the rate the seat map's regular seats use (`getCheckoutFeeRates`
// → `resolveQuoteTaxRateBps`): a cached venue rate, 0 with no location, and
// no buyer total at all when the rate is unknown (never a 0%-tax figure).
// ─────────────────────────────────────────────────────────────────────────────
describe("listEventSeatAvailability — NULL admission-tax stamp", () => {
  const FREE_SEAT = "55555555-5555-4555-8555-555555555555";
  const PLACE_ID = "66666666-6666-4666-8666-666666666666";

  function buildUnstampedDeps(
    admissionTaxRateBps: number | null | undefined,
    place: { cachedRateBps: number | null } | null,
  ) {
    const deps = buildDeps();
    const repos = deps.repos as unknown as {
      events: { getById: ReturnType<typeof vi.fn> };
      seats: { listByEvent: ReturnType<typeof vi.fn> };
      places: { getById: unknown };
      savedLocations: { getById: unknown };
    };
    repos.events.getById.mockImplementation(async () => ({
      ...buildPublishedEvent(),
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
    repos.seats.listByEvent.mockImplementation(async () => [
      ...buildSeats(),
      {
        id: FREE_SEAT,
        seatSectionId: SECTION_IDS.secB,
        eventId: EVENT_ID,
        status: "AVAILABLE" as const,
        label: "B3",
        row: "B",
        number: 3,
        priceOverride: { priceCents: 0, reason: "comp" },
      },
    ]);
    return deps;
  }

  const overrideOf = async (
    deps: ListEventSeatAvailabilityDeps,
    seatId: string,
  ) => {
    const result = await listEventSeatAvailability(deps, { eventId: EVENT_ID });
    return result.seats.find((seat) => seat.id === seatId)?.priceOverride;
  };

  it("a cached venue rate gives the override a real all-in total (3248 at 8.25%)", async () => {
    const override = await overrideOf(
      buildUnstampedDeps(null, { cachedRateBps: 825 }),
      SEAT_IDS.seat2,
    );
    expect(override?.buyerTotalCents).toBe(3248);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
  ])(
    "a %s stamp with a cache miss gives the PAID override no buyer total",
    async (_label, stamp) => {
      const override = await overrideOf(
        buildUnstampedDeps(stamp, { cachedRateBps: null }),
        SEAT_IDS.seat2,
      );
      expect(override?.buyerTotalCents).toBeNull();
      expect(override?.priceCents).toBe(3000);
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
    const override = await overrideOf(
      buildUnstampedDeps(null, null),
      SEAT_IDS.seat2,
    );
    expect(override?.buyerTotalCents).toBe(3000);
  });

  it("a stamped event is unchanged (3248 for 3000 at 8.25%)", async () => {
    const override = await overrideOf(
      buildUnstampedDeps(825, null),
      SEAT_IDS.seat2,
    );
    expect(override?.buyerTotalCents).toBe(3248);
  });
});
