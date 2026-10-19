import { describe, it, expect, vi } from "vitest";

import { heldSinceFor } from "../../_helpers/assert-ticket-type-capacity";
import { makeTicketCapacityUsageFake } from "@th/test-utils/fakes/ticket-capacity";
import { listEventTicketTypes } from "../list-event-ticket-types";
import type { ListEventTicketTypesDeps } from "../list-event-ticket-types";

// ── Fixture UUIDs ────────────────────────────────────────────────────────────

const EVENT_ID = "11111111-1111-4111-a111-111111111111";
const LAYOUT_ID = "22222222-2222-4222-a222-222222222222";
const TT_GA_ID = "33333333-3333-4333-a333-333333333333";
const TT_VIP_ID = "44444444-4444-4444-a444-444444444444";
const TT_NOSEC_ID = "55555555-5555-4555-a555-555555555555";
const SECTION_DB_1 = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const SECTION_DB_2 = "bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb";

const NOW = new Date("2026-05-30T00:00:00.000Z");

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildEvent(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: EVENT_ID,
    status: "PUBLISHED",
    orgId: "org-000",
    humanId: null,
    placeLayoutId: LAYOUT_ID,
    ...overrides,
  };
}

function buildTicketType(
  id: string,
  name: string,
  seatSectionId: string | null,
  overrides?: Partial<Record<string, unknown>>,
) {
  return {
    id,
    eventId: EVENT_ID,
    name,
    priceCents: 2500,
    capacity: 100,
    status: "ACTIVE" as const,
    seatSectionId,
    resaleAllowed: false,
    resaleCapCents: null,
    transferAllowed: true,
    scheduledPriceCents: null,
    scheduledPriceAt: null,
    ...overrides,
  };
}

function buildDeps(overrides?: {
  event?: ReturnType<typeof buildEvent> | null;
  ticketTypes?: ReturnType<typeof buildTicketType>[];
  sections?: Array<{
    id: string;
    layoutSectionId: string | null;
    placeLayoutId: string | null;
    eventId: string;
    label: string;
    capacity: number;
  }>;
  /** Per-tier issued/held counts; absent ids default to 0/0. */
  usage?: Record<string, { issued?: number; held?: number }>;
}): ListEventTicketTypesDeps {
  const event = overrides?.event === undefined ? buildEvent() : overrides.event;
  const ticketTypes = overrides?.ticketTypes ?? [
    buildTicketType(TT_GA_ID, "GA Floor", SECTION_DB_1),
    buildTicketType(TT_VIP_ID, "VIP Balcony", SECTION_DB_2),
  ];
  const sections = overrides?.sections ?? [
    {
      id: SECTION_DB_1,
      layoutSectionId: "ga-floor",
      placeLayoutId: LAYOUT_ID,
      eventId: EVENT_ID,
      label: "GA Floor",
      capacity: 200,
    },
    {
      id: SECTION_DB_2,
      layoutSectionId: "vip-balcony",
      placeLayoutId: LAYOUT_ID,
      eventId: EVENT_ID,
      label: "VIP Balcony",
      capacity: 100,
    },
  ];

  return {
    repos: {
      events: {
        getById: vi.fn(async () => event),
        listTicketTypes: vi.fn(async () => ticketTypes),
      },
      seats: {
        getSectionById: vi.fn(
          async (id: string) => sections.find((s) => s.id === id) ?? null,
        ),
      },
      // Sellability gate (paid events): use case looks up a payee for the
      // event's org/human subject and verifies it is ACTIVE + charges/payouts
      // enabled. Default mock returns a healthy payee so the existing
      // assertions keep passing.
      payees: {
        getBySubject: vi.fn(async () => ({ id: "payee-1" })),
        getById: vi.fn(async () => ({
          id: "payee-1",
          status: "ACTIVE",
          chargesEnabled: true,
          payoutsEnabled: true,
        })),
      },
      // Per-tier availability: the LOCK-FREE batch read. Default is
      // "nothing issued, nothing held", so every tier is fully available and
      // the pre-existing assertions are unaffected.
      ...makeTicketCapacityUsageFake(overrides?.usage),
    } as unknown as ListEventTicketTypesDeps["repos"],
    clock: { now: () => NOW } as ListEventTicketTypesDeps["clock"],
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("listEventTicketTypes", () => {
  it("returns ticket types with layoutSectionId resolved", async () => {
    const deps = buildDeps();
    const result = await listEventTicketTypes(deps, { eventId: EVENT_ID });

    expect(result.eventId).toBe(EVENT_ID);
    expect(result.placeLayoutId).toBe(LAYOUT_ID);
    expect(result.ticketTypes).toHaveLength(2);

    const ga = result.ticketTypes.find((tt) => tt.id === TT_GA_ID)!;
    expect(ga.seatSectionId).toBe(SECTION_DB_1);
    expect(ga.layoutSectionId).toBe("ga-floor");

    const vip = result.ticketTypes.find((tt) => tt.id === TT_VIP_ID)!;
    expect(vip.seatSectionId).toBe(SECTION_DB_2);
    expect(vip.layoutSectionId).toBe("vip-balcony");
  });

  it("returns null layoutSectionId for ticket types without a section", async () => {
    const deps = buildDeps({
      ticketTypes: [buildTicketType(TT_NOSEC_ID, "General Admission", null)],
    });

    const result = await listEventTicketTypes(deps, { eventId: EVENT_ID });
    const tt = result.ticketTypes[0]!;
    expect(tt.seatSectionId).toBeNull();
    expect(tt.layoutSectionId).toBeNull();
  });

  it("returns null placeLayoutId for events without a layout", async () => {
    const deps = buildDeps({
      event: buildEvent({ placeLayoutId: null }),
      ticketTypes: [buildTicketType(TT_NOSEC_ID, "GA", null)],
      sections: [],
    });

    const result = await listEventTicketTypes(deps, { eventId: EVENT_ID });
    expect(result.placeLayoutId).toBeNull();
  });

  it("filters out non-ACTIVE ticket types", async () => {
    const deps = buildDeps({
      ticketTypes: [
        buildTicketType(TT_GA_ID, "GA Floor", SECTION_DB_1),
        buildTicketType(TT_VIP_ID, "VIP (draft)", SECTION_DB_2, {
          status: "DRAFT",
        }),
      ],
    });

    const result = await listEventTicketTypes(deps, { eventId: EVENT_ID });
    expect(result.ticketTypes).toHaveLength(1);
    expect(result.ticketTypes[0]!.id).toBe(TT_GA_ID);
  });

  it("deduplicates getSectionById calls for repeated seatSectionIds", async () => {
    const deps = buildDeps({
      ticketTypes: [
        buildTicketType(TT_GA_ID, "GA Floor", SECTION_DB_1),
        buildTicketType(TT_VIP_ID, "VIP Balcony", SECTION_DB_1), // same section
      ],
    });
    await listEventTicketTypes(deps, { eventId: EVENT_ID });

    const seatsMock = deps.repos.seats as unknown as {
      getSectionById: ReturnType<typeof vi.fn>;
    };
    // Should only be called once because the lookup is cached
    expect(seatsMock.getSectionById).toHaveBeenCalledTimes(1);
    expect(seatsMock.getSectionById).toHaveBeenCalledWith(SECTION_DB_1);
  });

  it("throws not_found for missing event", async () => {
    const deps = buildDeps({ event: null });

    await expect(
      listEventTicketTypes(deps, { eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("throws conflict for non-published event", async () => {
    const deps = buildDeps({ event: buildEvent({ status: "DRAFT" }) });

    await expect(
      listEventTicketTypes(deps, { eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_ON_SALE" });
  });

  it("reports sales_closed once the event has ended", async () => {
    const deps = buildDeps({
      event: buildEvent({
        startsAt: new Date("2026-05-29T18:00:00.000Z"),
        endsAt: new Date("2026-05-29T23:00:00.000Z"), // before NOW
      }),
    });

    const result = await listEventTicketTypes(deps, { eventId: EVENT_ID });
    expect(result.sellability).toEqual({
      available: false,
      reason: "sales_closed",
    });
    // Ticket types are still returned so the page can render the lineup.
    expect(result.ticketTypes).toHaveLength(2);
  });

  it("stays sellable for an event that has not yet ended", async () => {
    const deps = buildDeps({
      event: buildEvent({
        startsAt: new Date("2026-06-01T18:00:00.000Z"),
        endsAt: new Date("2026-06-01T23:00:00.000Z"), // after NOW
      }),
    });

    const result = await listEventTicketTypes(deps, { eventId: EVENT_ID });
    expect(result.sellability.available).toBe(true);
    expect(result.sellability.reason).toBe("ok");
  });

  // ── time-based-ticket-pricing: the free/paid reason must be HONEST ──────
  //
  // A tier priced $0 today that flips to $20 at T is not a free event. Saying
  // `{ available: true, reason: "free" }` until T means the moment the page
  // stops calling it free is the moment checkout starts failing — the gate
  // arms itself exactly one instant too late to be useful.

  it("does NOT report reason 'free' for a $0-now / $20-at-T tier", async () => {
    const deps = buildDeps({
      ticketTypes: [
        buildTicketType(TT_GA_ID, "Early Bird", null, {
          priceCents: 0,
          scheduledPriceCents: 2000,
          scheduledPriceAt: new Date(NOW.getTime() + 86_400_000),
        }),
      ],
    });

    const result = await listEventTicketTypes(deps, { eventId: EVENT_ID });

    // The harness's default payee is healthy, so the honest answer is "ok" —
    // the point is that the paid gate RAN at all.
    expect(result.sellability.reason).toBe("ok");
  });

  it("reports stripe_not_connected BEFORE the flip when the payee is not ready", async () => {
    // The failure this whole predicate exists to prevent: without it the page
    // advertises the tier as free and available right up to T, then every
    // checkout fails from T onward with nothing on the page having changed.
    const deps = buildDeps({
      ticketTypes: [
        buildTicketType(TT_GA_ID, "Early Bird", null, {
          priceCents: 0,
          scheduledPriceCents: 2000,
          scheduledPriceAt: new Date(NOW.getTime() + 86_400_000),
        }),
      ],
    });
    (
      deps.repos.payees as unknown as { getBySubject: ReturnType<typeof vi.fn> }
    ).getBySubject.mockResolvedValue(null);

    const result = await listEventTicketTypes(deps, { eventId: EVENT_ID });

    expect(result.sellability).toEqual({
      available: false,
      reason: "stripe_not_connected",
    });
  });


  it("NFR-001: a genuinely free tier still reports 'free'", async () => {
    const deps = buildDeps({
      ticketTypes: [
        buildTicketType(TT_GA_ID, "Free entry", null, {
          priceCents: 0,
        }),
      ],
    });

    const result = await listEventTicketTypes(deps, { eventId: EVENT_ID });
    expect(result.sellability).toEqual({ available: true, reason: "free" });
  });

  it("rejects invalid eventId", async () => {
    const deps = buildDeps();

    await expect(
      listEventTicketTypes(deps, { eventId: "not-a-uuid" }),
    ).rejects.toThrow();
  });

  // FR-003 (community-managed-event-listings): RSVP events have no ticket
  // types and nothing to sell — the use case early-returns an empty,
  // unsellable list without touching the owner/payee resolution (COMMUNITY
  // RSVP rows are ownerless).
  it("returns an empty, unsellable list for an RSVP event", async () => {
    const deps = buildDeps({
      event: buildEvent({
        attendanceMode: "RSVP",
        stewardship: "COMMUNITY",
        orgId: null,
        humanId: null,
        placeLayoutId: null,
      }),
    });

    const result = await listEventTicketTypes(deps, { eventId: EVENT_ID });
    expect(result.ticketTypes).toEqual([]);
    expect(result.sellability).toEqual({
      available: false,
      reason: "no_payee",
    });

    // Never queries ticket types or payees for RSVP events.
    const eventsMock = deps.repos.events as unknown as {
      listTicketTypes: ReturnType<typeof vi.fn>;
    };
    const payeesMock = deps.repos.payees as unknown as {
      getBySubject: ReturnType<typeof vi.fn>;
    };
    expect(eventsMock.listTicketTypes).not.toHaveBeenCalled();
    expect(payeesMock.getBySubject).not.toHaveBeenCalled();
  });

  it("leaves TICKETED events unaffected by the RSVP early-return", async () => {
    const deps = buildDeps({
      event: buildEvent({ attendanceMode: "TICKETED" }),
    });

    const result = await listEventTicketTypes(deps, { eventId: EVENT_ID });
    expect(result.ticketTypes).toHaveLength(2);
    expect(result.sellability.available).toBe(true);
  });

  // ── Per-tier availability ───────────────────────────────────────────────
  //
  // `capacity` is the AUTHORED column and no write path decrements it, so the
  // clients' old `capacity <= 0` sold-out test was essentially never true: a
  // sold-out tier still rendered a live stepper and the buyer was refused at
  // submit. These pin the truthful replacement.

  it("reports soldOut for a fully-issued tier", async () => {
    const deps = buildDeps({
      ticketTypes: [buildTicketType(TT_GA_ID, "GA", null, { capacity: 40 })],
      usage: { [TT_GA_ID]: { issued: 40 } },
    });

    const result = await listEventTicketTypes(deps, { eventId: EVENT_ID });
    const ga = result.ticketTypes[0]!;
    expect(ga.soldOut).toBe(true);
    expect(ga.remainingCapacity).toBe(0);
    // The authored column is untouched — it is the tier's configured size,
    // never its availability, and live consumers still read it as such.
    expect(ga.capacity).toBe(40);
  });

  it("reports the exact remaining count for a partially-sold tier", async () => {
    const deps = buildDeps({
      ticketTypes: [buildTicketType(TT_GA_ID, "GA", null, { capacity: 40 })],
      usage: { [TT_GA_ID]: { issued: 33 } },
    });

    const result = await listEventTicketTypes(deps, { eventId: EVENT_ID });
    const ga = result.ticketTypes[0]!;
    expect(ga.remainingCapacity).toBe(7);
    expect(ga.soldOut).toBe(false);
  });

  // THE HOLDS DECISION, pinned. `remainingCapacity` uses the SAME basis as the
  // pre-charge gate (`capacity - issued - HELD`), NOT the issued-only basis the
  // POS listing deliberately uses. Under the opposite choice this tier would
  // report 2 remaining and not sold out — and the buyer would fill in the whole
  // form only to be refused with TICKET_TYPE_TEMPORARILY_HELD.
  it("counts other buyers' unexpired HOLDS against remaining capacity", async () => {
    const deps = buildDeps({
      ticketTypes: [buildTicketType(TT_GA_ID, "GA", null, { capacity: 10 })],
      usage: { [TT_GA_ID]: { issued: 8, held: 2 } },
    });

    const result = await listEventTicketTypes(deps, { eventId: EVENT_ID });
    const ga = result.ticketTypes[0]!;
    expect(ga.remainingCapacity).toBe(0);
    expect(ga.soldOut).toBe(true);
  });

  it("never reports a negative remaining count when oversold", async () => {
    const deps = buildDeps({
      ticketTypes: [buildTicketType(TT_GA_ID, "GA", null, { capacity: 5 })],
      usage: { [TT_GA_ID]: { issued: 9 } },
    });

    const result = await listEventTicketTypes(deps, { eventId: EVENT_ID });
    expect(result.ticketTypes[0]!.remainingCapacity).toBe(0);
    expect(result.ticketTypes[0]!.soldOut).toBe(true);
  });

  it("counts every tier in ONE batched, lock-free call", async () => {
    const deps = buildDeps({
      ticketTypes: [
        buildTicketType(TT_GA_ID, "GA Floor", SECTION_DB_1),
        buildTicketType(TT_VIP_ID, "VIP Balcony", SECTION_DB_2),
        buildTicketType(TT_NOSEC_ID, "General", null),
      ],
    });

    await listEventTicketTypes(deps, { eventId: EVENT_ID });

    const ticketsMock = deps.repos.tickets as unknown as {
      countCapacityUsageForTicketTypes: ReturnType<typeof vi.fn>;
      lockAndCountCapacityForTicketType?: ReturnType<typeof vi.fn>;
    };
    // One round trip for three tiers — never one per tier.
    expect(ticketsMock.countCapacityUsageForTicketTypes).toHaveBeenCalledTimes(
      1,
    );
    expect(
      ticketsMock.countCapacityUsageForTicketTypes.mock.calls[0]![0]
        .ticketTypeIds,
    ).toEqual([TT_GA_ID, TT_VIP_ID, TT_NOSEC_ID]);
    // And NEVER the advisory-locking counter: a page view must not queue
    // behind a live checkout for the same tier.
    expect(ticketsMock.lockAndCountCapacityForTicketType).toBeUndefined();
  });

  it("does not query capacity at all for an RSVP event (no tiers)", async () => {
    const deps = buildDeps({
      event: buildEvent({ attendanceMode: "RSVP", orgId: null, humanId: null }),
    });

    await listEventTicketTypes(deps, { eventId: EVENT_ID });

    const ticketsMock = deps.repos.tickets as unknown as {
      countCapacityUsageForTicketTypes: ReturnType<typeof vi.fn>;
    };
    expect(ticketsMock.countCapacityUsageForTicketTypes).not.toHaveBeenCalled();
  });

  it("passes the SAME instant to the counter that it prices against", async () => {
    const deps = buildDeps();
    await listEventTicketTypes(deps, { eventId: EVENT_ID });

    const ticketsMock = deps.repos.tickets as unknown as {
      countCapacityUsageForTicketTypes: ReturnType<typeof vi.fn>;
    };
    // Derived from that instant, not the instant itself — see `heldSinceFor`.
    expect(
      ticketsMock.countCapacityUsageForTicketTypes.mock.calls[0]![0].heldSince,
    ).toEqual(heldSinceFor(NOW));
  });

  it("gracefully handles section not in lookup (returns null)", async () => {
    // Ticket type references a seatSectionId that wasn't returned by listSectionsByEvent
    const orphanSectionId = "ffffffff-ffff-4fff-afff-ffffffffffff";
    const deps = buildDeps({
      ticketTypes: [buildTicketType(TT_GA_ID, "Orphan", orphanSectionId)],
      sections: [], // No sections returned
    });

    const result = await listEventTicketTypes(deps, { eventId: EVENT_ID });
    expect(result.ticketTypes[0]!.layoutSectionId).toBeNull();
  });
});
