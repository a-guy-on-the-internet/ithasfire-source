import { describe, expect, it, vi } from "vitest";

import {
  getEmbedCalendarEvents,
  getEmbedCalendarEventsOutputSchema,
  type GetEmbedCalendarEventsDeps,
} from "../get-embed-calendar-events";
import type {
  EventSuggestion,
  MultiSearchAutocompleteInput,
} from "@th/ports/search/multi-index.types";
import type { EmbedRecord } from "@th/types/repos/embeds";

/**
 * FR-022 (`soldOut`) and FR-023 (`priceLabel`) on the PUBLIC, unauthenticated
 * calendar embed (event-calendar-redesign; docs/specs/2026-09-02).
 *
 * What these pin:
 *   - sold-out is the `capacity - issued - held` basis the pre-charge gate
 *     refuses on, NOT the authored `TicketType.capacity` column;
 *   - an event is sold out only when it HAS ACTIVE tiers and EVERY one is
 *     exhausted — one tier with stock keeps the chip live;
 *   - RSVP / ticketless listings are never sold out and never priced;
 *   - the label is the ALL-IN figure of the cheapest ACTIVE tier, in the
 *     EVENT'S currency ("From $X" for several paid tiers), and a non-ACTIVE
 *     tier contributes to neither signal;
 *   - a paid event whose all-in figure cannot be computed (tax rate never
 *     stamped, fee read failed) shows NO price — never the face;
 *   - free-only renders "Free", never "$0"; free + paid renders "Free+";
 *   - ONE batched availability query per page, whatever the event count;
 *   - FR-003 expanded occurrences inherit the parent's values (stock is per
 *     EVENT, not per night);
 *   - a failed availability read degrades in the SAFE direction and reports
 *     through `reportError` (CLAUDE.md swallow convention).
 */

const EMBED_ID = "00000000-0000-4000-8000-0000000000f0";
const ORG_ID = "00000000-0000-4000-8000-0000000000f1";
const DOMAIN = "venue.example.com";
const HOST_ORIGIN = "https://venue.example.com";
const PUBLIC_APP_URL = "http://localhost:3000";

const DAY_MS = 24 * 60 * 60 * 1000;
const inDays = (days: number) => new Date(Date.now() + days * DAY_MS);
const uuidFor = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const embed: EmbedRecord = {
  id: EMBED_ID,
  subjectType: "organization",
  subjectId: ORG_ID,
  domain: DOMAIN,
  status: "ACTIVE",
  requireAuth: false,
  linkOut: false,
  defaultView: "calendar",
  viewToggle: true,
  createdBy: null,
  createdAt: new Date("2026-01-01"),
};

type EventFixture = {
  id: string;
  title: string;
  startsAt: Date;
  currency?: string | null;
  /** Stamped admission-tax rate; defaults to a stamped 0% (all-in = face). */
  admissionTaxRateBps?: number | null;
};

/**
 * The fee-context and situs reads behind the all-in label. Default: no fee
 * policy at any scope, so with a stamped 0% rate the all-in figure equals the
 * face — which keeps the face-shaped expectations below readable.
 */
function feeRepos(opts: {
  globalPolicy?: Record<string, unknown> | null;
  feeThrows?: boolean;
}) {
  return {
    payoutTerms: {
      listByEventIds: vi.fn(async (ids: readonly string[]) =>
        new Map(ids.map((id) => [id, []] as const)),
      ),
      listLinesByTermsIds: vi.fn(async () => new Map()),
    },
    feePolicies: {
      getByIds: vi.fn(async () => new Map()),
      resolveEffectiveForScopes: vi.fn(async () => new Map()),
      resolveEffective: vi.fn(async () => {
        if (opts.feeThrows) throw new Error("fee policy read failed");
        return opts.globalPolicy ?? null;
      }),
    },
    savedLocations: { getById: vi.fn(async () => null) },
  };
}

/** A GLOBAL policy shaped like production's: 3.33% capped at $0.50, 2.9% + $0.30. */
const GLOBAL_POLICY = {
  id: "pol-global",
  scopeType: "GLOBAL",
  scopeId: null,
  status: "ACTIVE",
  version: 1,
  effectiveFrom: new Date("2026-01-01"),
  effectiveTo: null,
  buyerFeePct: 0.0333,
  maxFeeCents: 50,
  minFeeCents: 0,
  maxPlatformFeeCents: null,
  platformFixedCents: 0,
  feeMode: "PASS_THROUGH",
  processsorFeePct: 0.029,
  processorFixedCents: 30,
  payoutPct: 0.0025,
  payoutFixedCents: 25,
  monthlyPayoutCents: 200,
  payoutMinimumCents: 1000,
  connectAccountFeeCents: 0,
};

/** A tier as `events.listTicketTypesForEventIds` projects it. */
type TierFixture = {
  eventId: string;
  id: string;
  priceCents: number;
  capacity: number;
  status: string;
  salesOpenAt?: Date | null;
  salesCloseAt?: Date | null;
  pricingMode?: "FIXED" | "ADJUSTABLE";
  minimumCents?: number | null;
};

const tier = (t: TierFixture) => ({
  name: `Tier ${t.id}`,
  description: null,
  pricingMode: "FIXED" as const,
  minimumCents: null,
  suggestedCents: null,
  resaleAllowed: false,
  resaleCapCents: null,
  transferAllowed: true,
  scheduledPriceCents: null,
  scheduledPriceAt: null,
  salesOpenAt: null,
  salesCloseAt: null,
  ...t,
});

function toSuggestion(e: EventFixture): EventSuggestion {
  return {
    type: "event",
    id: `doc-${e.id}`,
    eventId: e.id,
    title: e.title,
    subtitle: null,
    helper: null,
    slug: `slug-${e.id}`,
    startsAt: e.startsAt,
    endsAt: null,
    city: "Nashville",
    region: "TN",
    location: "123 Main St",
    lat: null,
    lng: null,
    imageUrl: null,
    lowestPriceCents: null,
    lowestBuyerTotalCents: null,
    currency: "usd",
    paidTierCount: 0,
    hasFreeTier: false,
    confidence: 1,
  };
}

type Usage = { ticketTypeId: string; issued: number; held: number };

function makeDeps(opts: {
  events: EventFixture[];
  tiers?: TierFixture[];
  /** Capacity usage rows; a tier with no row is zero-filled by the repo contract. */
  usage?: Usage[];
  dates?: {
    id: string;
    eventId: string;
    startsAt: Date;
    endsAt: Date | null;
  }[];
  /** Make the lock-free availability count throw, to exercise the swallow. */
  availabilityThrows?: boolean;
  globalPolicy?: Record<string, unknown> | null;
  feeThrows?: boolean;
}) {
  const autocomplete = vi.fn(async (input: MultiSearchAutocompleteInput) => ({
    ok: true as const,
    value: {
      suggestions: opts.events
        .slice(0, input.limit ?? 10)
        .map((e) => toSuggestion(e)),
      latencyMs: 1,
    },
  }));

  const listTicketTypesForEventIds = vi.fn(async (ids: string[]) =>
    (opts.tiers ?? []).filter((t) => ids.includes(t.eventId)).map(tier),
  );

  const countCapacityUsageForTicketTypes = vi.fn(
    async ({ ticketTypeIds }: { ticketTypeIds: readonly string[] }) => {
      if (opts.availabilityThrows) {
        throw new Error("capacity counter unavailable");
      }
      const byId = new Map((opts.usage ?? []).map((u) => [u.ticketTypeId, u]));
      return ticketTypeIds.map(
        (id) => byId.get(id) ?? { ticketTypeId: id, issued: 0, held: 0 },
      );
    },
  );

  const currencyById = new Map(
    opts.events.map((e) => [e.id, e.currency === undefined ? "usd" : e.currency]),
  );
  const taxRateById = new Map(
    opts.events.map((e) => [
      e.id,
      e.admissionTaxRateBps === undefined ? 0 : e.admissionTaxRateBps,
    ]),
  );

  const repos = {
    embeds: { getById: vi.fn(async () => embed) },
    organizations: {
      getById: vi.fn(async () => ({ id: ORG_ID, name: "Dev QA Collective" })),
    },
    humans: { getById: vi.fn(async () => null) },
    places: { listOwnedBySubject: vi.fn(async () => []) },
    events: {
      getById: vi.fn(),
      findManyByIds: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({
          id,
          orgId: ORG_ID,
          timezone: "America/Chicago",
          currency: currencyById.get(id) ?? null,
          admissionTaxRateBps: taxRateById.get(id) ?? null,
          placeId: null,
          savedLocationId: null,
        })),
      ),
      listTicketTypesForEventIds,
    },
    tickets: { countCapacityUsageForTicketTypes },
    ...feeRepos(opts),
    eventDates: {
      listByEventIds: vi.fn(async () =>
        (opts.dates ?? []).map((d, i) => ({
          ...d,
          ordinal: i + 1,
          status: "SCHEDULED" as const,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      ),
    },
  };

  const reportError = vi.fn();
  const logger = {
    child: vi.fn(() => logger),
    withTime: vi.fn(
      async <T,>(_label: string, fn: () => Promise<T>): Promise<T> => fn(),
    ),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const deps: GetEmbedCalendarEventsDeps = {
    repos: repos as unknown as GetEmbedCalendarEventsDeps["repos"],
    search: { autocomplete } as unknown as GetEmbedCalendarEventsDeps["search"],
    clock: { now: () => new Date() },
    publicAppUrl: PUBLIC_APP_URL,
    reportError,
    logger: logger as unknown as GetEmbedCalendarEventsDeps["logger"],
  };

  return {
    deps,
    reportError,
    logger,
    listTicketTypesForEventIds,
    countCapacityUsageForTicketTypes,
  };
}

const input = {
  embedId: EMBED_ID,
  hostOrigin: HOST_ORIGIN,
  scope: "own" as const,
};

const EVENT_A = uuidFor(1);
const EVENT_B = uuidFor(2);

describe("getEmbedCalendarEvents — FR-022 sold-out", () => {
  it("every ACTIVE tier exhausted (capacity - issued - held <= 0) ⇒ soldOut", async () => {
    const { deps } = makeDeps({
      events: [{ id: EVENT_A, title: "Sold Out Show", startsAt: inDays(3) }],
      tiers: [
        { eventId: EVENT_A, id: "tt-ga", priceCents: 2500, capacity: 50, status: "ACTIVE" },
        { eventId: EVENT_A, id: "tt-vip", priceCents: 7500, capacity: 10, status: "ACTIVE" },
      ],
      usage: [
        // GA fully issued; VIP's last two units are HELD, which counts (the
        // same basis the pre-charge gate refuses on).
        { ticketTypeId: "tt-ga", issued: 50, held: 0 },
        { ticketTypeId: "tt-vip", issued: 8, held: 2 },
      ],
    });

    const result = await getEmbedCalendarEvents(deps, input);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.soldOut).toBe(true);
  });

  it("one tier with stock left keeps the whole event live", async () => {
    const { deps } = makeDeps({
      events: [{ id: EVENT_A, title: "Nearly Out", startsAt: inDays(3) }],
      tiers: [
        { eventId: EVENT_A, id: "tt-ga", priceCents: 2500, capacity: 50, status: "ACTIVE" },
        { eventId: EVENT_A, id: "tt-vip", priceCents: 7500, capacity: 10, status: "ACTIVE" },
      ],
      usage: [
        { ticketTypeId: "tt-ga", issued: 50, held: 0 },
        { ticketTypeId: "tt-vip", issued: 9, held: 0 },
      ],
    });

    const result = await getEmbedCalendarEvents(deps, input);

    expect(result.events[0]!.soldOut).toBe(false);
  });

  it("an event with NO ticket types (RSVP / community listing) is never sold out and carries no price", async () => {
    const { deps } = makeDeps({
      events: [{ id: EVENT_A, title: "Neighbourhood Potluck", startsAt: inDays(4) }],
      tiers: [],
    });

    const result = await getEmbedCalendarEvents(deps, input);

    expect(result.events[0]).toMatchObject({ soldOut: false, priceLabel: null });
  });

  it("a fully-issued tier is sold out even though the authored `capacity` column still reads 50", async () => {
    // The regression this signal exists for: no write path decrements
    // `TicketType.capacity`, so a `capacity <= 0` test is essentially never
    // true and a sold-out event rendered as buyable inside a partner iframe.
    const { deps } = makeDeps({
      events: [{ id: EVENT_A, title: "Capacity Trap", startsAt: inDays(2) }],
      tiers: [
        { eventId: EVENT_A, id: "tt-ga", priceCents: 1500, capacity: 50, status: "ACTIVE" },
      ],
      usage: [{ ticketTypeId: "tt-ga", issued: 50, held: 0 }],
    });

    const result = await getEmbedCalendarEvents(deps, input);

    expect(result.events[0]!.soldOut).toBe(true);
    // And nothing about the stock itself reaches the unauthenticated wire.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("capacity");
    expect(serialized).not.toContain("remaining");
    expect(serialized).not.toContain("issued");
    expect(serialized).not.toContain("held");
  });

  it("a non-ACTIVE (archived) tier is ignored for sold-out as well as for the label", async () => {
    const { deps } = makeDeps({
      events: [{ id: EVENT_A, title: "Archived Tier", startsAt: inDays(5) }],
      tiers: [
        // Exhausted, but ARCHIVED — it must not drag the event to sold out.
        { eventId: EVENT_A, id: "tt-old", priceCents: 500, capacity: 5, status: "ARCHIVED" },
        { eventId: EVENT_A, id: "tt-ga", priceCents: 2500, capacity: 50, status: "ACTIVE" },
      ],
      usage: [{ ticketTypeId: "tt-old", issued: 5, held: 0 }],
    });

    const result = await getEmbedCalendarEvents(deps, input);

    expect(result.events[0]).toMatchObject({ soldOut: false, priceLabel: "$25" });
  });
});

describe("getEmbedCalendarEvents — FR-023 price label", () => {
  it("the cheapest ACTIVE tier wins, worded 'From $X' when more than one paid tier exists", async () => {
    const { deps } = makeDeps({
      events: [{ id: EVENT_A, title: "Two Tiers", startsAt: inDays(3) }],
      tiers: [
        { eventId: EVENT_A, id: "tt-vip", priceCents: 7500, capacity: 10, status: "ACTIVE" },
        { eventId: EVENT_A, id: "tt-ga", priceCents: 2500, capacity: 50, status: "ACTIVE" },
        // Cheaper than both, but DRAFT — must not be quoted.
        { eventId: EVENT_A, id: "tt-draft", priceCents: 500, capacity: 50, status: "DRAFT" },
      ],
    });

    const result = await getEmbedCalendarEvents(deps, input);

    expect(result.events[0]!.priceLabel).toBe("From $25");
  });

  it("a single paid tier has no 'From'", async () => {
    const { deps } = makeDeps({
      events: [{ id: EVENT_A, title: "One Tier", startsAt: inDays(3) }],
      tiers: [
        { eventId: EVENT_A, id: "tt-ga", priceCents: 4550, capacity: 50, status: "ACTIVE" },
      ],
    });

    const result = await getEmbedCalendarEvents(deps, input);

    expect(result.events[0]!.priceLabel).toBe("$45.50");
  });

  it("a free-only event renders 'Free' rather than '$0'", async () => {
    const { deps } = makeDeps({
      events: [{ id: EVENT_A, title: "Free Show", startsAt: inDays(3) }],
      tiers: [
        { eventId: EVENT_A, id: "tt-free", priceCents: 0, capacity: 100, status: "ACTIVE" },
      ],
    });

    const result = await getEmbedCalendarEvents(deps, input);

    expect(result.events[0]!.priceLabel).toBe("Free");
  });

  it("a free + paid event renders 'Free+'", async () => {
    const { deps } = makeDeps({
      events: [{ id: EVENT_A, title: "Mixed", startsAt: inDays(3) }],
      tiers: [
        { eventId: EVENT_A, id: "tt-free", priceCents: 0, capacity: 100, status: "ACTIVE" },
        { eventId: EVENT_A, id: "tt-vip", priceCents: 2500, capacity: 100, status: "ACTIVE" },
      ],
    });

    const result = await getEmbedCalendarEvents(deps, input);

    expect(result.events[0]!.priceLabel).toBe("Free+");
    expect(result.events[0]!.listingPrice).toEqual({ kind: "freePlus" });
  });

  it("a floor-0 pay-what-you-want tier reads 'Pay what you want', never 'Free' (F2)", async () => {
    const { deps } = makeDeps({
      events: [{ id: EVENT_A, title: "Pass the Hat", startsAt: inDays(3) }],
      tiers: [
        {
          eventId: EVENT_A,
          id: "tt-pwyw",
          priceCents: 0,
          pricingMode: "ADJUSTABLE",
          minimumCents: 0,
          capacity: 100,
          status: "ACTIVE",
        },
        { eventId: EVENT_A, id: "tt-vip", priceCents: 2500, capacity: 100, status: "ACTIVE" },
      ],
    });

    const result = await getEmbedCalendarEvents(deps, input);

    expect(result.events[0]).toMatchObject({
      priceLabel: "Pay what you want",
      listingPrice: { kind: "payWhatYouWant" },
    });
    expect(() => getEmbedCalendarEventsOutputSchema.parse(result)).not.toThrow();
  });

  it("carries the price as data for the embed to word ('From $X' → amount, from: true)", async () => {
    const { deps } = makeDeps({
      events: [{ id: EVENT_A, title: "Two tiers", startsAt: inDays(3) }],
      tiers: [
        { eventId: EVENT_A, id: "tt-ga", priceCents: 2500, capacity: 100, status: "ACTIVE" },
        { eventId: EVENT_A, id: "tt-vip", priceCents: 5000, capacity: 100, status: "ACTIVE" },
      ],
    });

    const result = await getEmbedCalendarEvents(deps, input);

    const { priceLabel, listingPrice } = result.events[0]!;
    expect(listingPrice).toMatchObject({ kind: "amount", currency: "USD", from: true });
    expect(priceLabel).toMatch(/^From \$/);
  });

  it("the currency comes from the event row, not an assumed USD", async () => {
    const { deps } = makeDeps({
      events: [
        { id: EVENT_A, title: "Tokyo Night", startsAt: inDays(3), currency: "jpy" },
      ],
      tiers: [
        { eventId: EVENT_A, id: "tt-ga", priceCents: 2500, capacity: 50, status: "ACTIVE" },
      ],
    });

    const result = await getEmbedCalendarEvents(deps, input);

    // JPY is zero-decimal: 2500 minor units are ¥2,500, not ¥25.
    expect(result.events[0]!.priceLabel).toBe("¥2,500");
  });

  it("an off-sale free-only tier gives null, not 'Free'", async () => {
    const { deps } = makeDeps({
      events: [{ id: EVENT_A, title: "Free Later", startsAt: inDays(20) }],
      tiers: [
        {
          eventId: EVENT_A,
          id: "tt-free",
          priceCents: 0,
          capacity: 100,
          status: "ACTIVE",
          salesOpenAt: inDays(10),
        },
      ],
    });

    const result = await getEmbedCalendarEvents(deps, input);

    expect(result.events[0]!.priceLabel).toBeNull();
  });

  it("an off-sale free tier beside an on-sale paid tier gives the all-in price, not 'Free+'", async () => {
    const { deps } = makeDeps({
      events: [{ id: EVENT_A, title: "Paid Now", startsAt: inDays(20) }],
      tiers: [
        {
          eventId: EVENT_A,
          id: "tt-free",
          priceCents: 0,
          capacity: 100,
          status: "ACTIVE",
          salesOpenAt: inDays(10),
        },
        { eventId: EVENT_A, id: "tt-ga", priceCents: 2500, capacity: 100, status: "ACTIVE" },
      ],
    });

    const result = await getEmbedCalendarEvents(deps, input);

    expect(result.events[0]!.priceLabel).toMatch(/^\$\d/);
    expect(result.events[0]!.priceLabel).not.toBe("Free+");
  });

  it("a tier outside its sales window is not quoted (a price nobody can buy is not a price)", async () => {
    const { deps } = makeDeps({
      events: [{ id: EVENT_A, title: "Not Yet", startsAt: inDays(20) }],
      tiers: [
        {
          eventId: EVENT_A,
          id: "tt-ga",
          priceCents: 3000,
          capacity: 50,
          status: "ACTIVE",
          salesOpenAt: inDays(10),
        },
      ],
    });

    const result = await getEmbedCalendarEvents(deps, input);

    expect(result.events[0]!.priceLabel).toBeNull();
    // Still available: no unit of it has been sold.
    expect(result.events[0]!.soldOut).toBe(false);
  });
});

describe("getEmbedCalendarEvents — FR-023 all-in figure", () => {
  it("quotes the all-in figure (fees + tax), not the face", async () => {
    const { deps } = makeDeps({
      events: [
        {
          id: EVENT_A,
          title: "Taxed Show",
          startsAt: inDays(3),
          admissionTaxRateBps: 925,
        },
      ],
      tiers: [
        { eventId: EVENT_A, id: "tt-ga", priceCents: 2500, capacity: 50, status: "ACTIVE" },
      ],
      globalPolicy: GLOBAL_POLICY,
    });

    const result = await getEmbedCalendarEvents(deps, input);

    const label = result.events[0]!.priceLabel;
    expect(label).toMatch(/^\$\d+(\.\d\d)?$/);
    // Above face plus the $0.50-capped platform fee.
    expect(Number(label!.slice(1))).toBeGreaterThan(25.5);
  });

  it("tax rate never stamped, no location ⇒ priced at 0% like the event page, sold-out unaffected", async () => {
    const { deps } = makeDeps({
      events: [
        { id: EVENT_A, title: "Unstamped", startsAt: inDays(3), admissionTaxRateBps: null },
      ],
      tiers: [
        { eventId: EVENT_A, id: "tt-ga", priceCents: 2500, capacity: 1, status: "ACTIVE" },
      ],
      usage: [{ ticketTypeId: "tt-ga", issued: 1, held: 0 }],
    });

    const result = await getEmbedCalendarEvents(deps, input);

    // `resolveQuoteTaxRateBps` quotes 0 for a location-less event (checkout
    // charges 0 there too); no fee policy ⇒ all-in = face.
    expect(result.events[0]).toMatchObject({ soldOut: true, priceLabel: "$25" });
  });

  it("a failed fee read blanks the price only, keeps soldOut, and reports", async () => {
    const { deps, reportError, logger } = makeDeps({
      events: [{ id: EVENT_A, title: "Show", startsAt: inDays(3) }],
      tiers: [
        { eventId: EVENT_A, id: "tt-ga", priceCents: 2500, capacity: 1, status: "ACTIVE" },
      ],
      usage: [{ ticketTypeId: "tt-ga", issued: 1, held: 0 }],
      feeThrows: true,
    });

    const result = await getEmbedCalendarEvents(deps, input);

    expect(result.events[0]).toMatchObject({ soldOut: true, priceLabel: null });
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "getEmbedCalendarEvents", step: "loadListingBuyerTotals" },
      extra: { eventCount: 1 },
    });
    expect(logger.error).toHaveBeenCalledWith(
      "events.listing_buyer_totals_failed",
      expect.objectContaining({ err: expect.any(Error) }),
    );
  });
});

describe("getEmbedCalendarEvents — batching and expansion", () => {
  it("resolves a whole page with ONE availability query, regardless of event count", async () => {
    const events = Array.from({ length: 40 }, (_, i) => ({
      id: uuidFor(100 + i),
      title: `Show ${i}`,
      startsAt: inDays(1 + i),
    }));
    const tiers = events.map((e) => ({
      eventId: e.id,
      id: `tt-${e.id}`,
      priceCents: 2000,
      capacity: 10,
      status: "ACTIVE",
    }));
    const { deps, listTicketTypesForEventIds, countCapacityUsageForTicketTypes } =
      makeDeps({ events, tiers });

    const result = await getEmbedCalendarEvents(deps, input);

    expect(result.events).toHaveLength(40);
    expect(listTicketTypesForEventIds).toHaveBeenCalledTimes(1);
    expect(countCapacityUsageForTicketTypes).toHaveBeenCalledTimes(1);
    // ONE call carrying every tier on the page — not 40 calls of one tier.
    expect(
      countCapacityUsageForTicketTypes.mock.calls[0]![0].ticketTypeIds,
    ).toHaveLength(40);
  });

  it("zero events ⇒ zero enrichment queries", async () => {
    const { deps, listTicketTypesForEventIds, countCapacityUsageForTicketTypes } =
      makeDeps({ events: [] });

    const result = await getEmbedCalendarEvents(deps, input);

    expect(result.events).toEqual([]);
    expect(listTicketTypesForEventIds).not.toHaveBeenCalled();
    expect(countCapacityUsageForTicketTypes).not.toHaveBeenCalled();
  });

  it("every EventDate occurrence inherits the parent's soldOut/priceLabel — stock is per EVENT, not per night", async () => {
    const { deps, countCapacityUsageForTicketTypes } = makeDeps({
      events: [{ id: EVENT_A, title: "Residency", startsAt: inDays(1) }],
      tiers: [
        { eventId: EVENT_A, id: "tt-ga", priceCents: 1200, capacity: 20, status: "ACTIVE" },
      ],
      usage: [{ ticketTypeId: "tt-ga", issued: 20, held: 0 }],
      dates: Array.from({ length: 4 }, (_, i) => ({
        id: uuidFor(900_000 + i),
        eventId: EVENT_A,
        startsAt: inDays(1 + i * 7),
        endsAt: null,
      })),
    });

    const result = await getEmbedCalendarEvents(deps, input);

    expect(result.events).toHaveLength(4);
    expect(result.events.map((e) => e.occurrence?.index)).toEqual([1, 2, 3, 4]);
    expect(result.events.every((e) => e.soldOut === true)).toBe(true);
    expect(result.events.every((e) => e.priceLabel === "$12")).toBe(true);
    // Expansion does NOT re-query per night.
    expect(countCapacityUsageForTicketTypes).toHaveBeenCalledTimes(1);
  });

  it("distinct events on one page keep their own answers", async () => {
    const { deps } = makeDeps({
      events: [
        { id: EVENT_A, title: "Gone", startsAt: inDays(2) },
        { id: EVENT_B, title: "Open", startsAt: inDays(3) },
      ],
      tiers: [
        { eventId: EVENT_A, id: "tt-a", priceCents: 3000, capacity: 5, status: "ACTIVE" },
        { eventId: EVENT_B, id: "tt-b", priceCents: 1000, capacity: 5, status: "ACTIVE" },
      ],
      usage: [{ ticketTypeId: "tt-a", issued: 5, held: 0 }],
    });

    const result = await getEmbedCalendarEvents(deps, input);

    expect(result.events.map((e) => [e.id, e.soldOut, e.priceLabel])).toEqual([
      [EVENT_A, true, "$30"],
      [EVENT_B, false, "$10"],
    ]);
  });

  it("the enriched payload still parses against the strict output schema", async () => {
    const { deps } = makeDeps({
      events: [{ id: EVENT_A, title: "Strict", startsAt: inDays(2) }],
      tiers: [
        { eventId: EVENT_A, id: "tt-ga", priceCents: 2500, capacity: 50, status: "ACTIVE" },
      ],
    });

    const result = await getEmbedCalendarEvents(deps, input);

    expect(() => getEmbedCalendarEventsOutputSchema.parse(result)).not.toThrow();
  });
});

describe("getEmbedCalendarEvents — degraded availability read", () => {
  it("a thrown availability read degrades to { soldOut: false, priceLabel: null } and reports", async () => {
    const { deps, reportError, logger } = makeDeps({
      events: [
        { id: EVENT_A, title: "Live Show", startsAt: inDays(2) },
        { id: EVENT_B, title: "Other Show", startsAt: inDays(3) },
      ],
      tiers: [
        { eventId: EVENT_A, id: "tt-a", priceCents: 3000, capacity: 5, status: "ACTIVE" },
        { eventId: EVENT_B, id: "tt-b", priceCents: 1000, capacity: 5, status: "ACTIVE" },
      ],
      availabilityThrows: true,
    });

    const result = await getEmbedCalendarEvents(deps, input);

    // The calendar still renders — and in the SAFE direction: a database blip
    // must never tell every visitor a live event is sold out.
    expect(result.events).toHaveLength(2);
    expect(result.events.every((e) => e.soldOut === false)).toBe(true);
    expect(result.events.every((e) => e.priceLabel === null)).toBe(true);

    // CLAUDE.md: a deliberate swallow reports through ReporterPort, and keeps
    // its `logger.error` (warn is not captured by Sentry).
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tags: { useCase: "getEmbedCalendarEvents", stage: "salesState" },
    });
    expect(logger.error).toHaveBeenCalledWith(
      "embeds.calendar_sales_state_failed",
      expect.objectContaining({ eventCount: 2 }),
    );
  });

  it("a throwing reporter never changes the response", async () => {
    const { deps } = makeDeps({
      events: [{ id: EVENT_A, title: "Live Show", startsAt: inDays(2) }],
      tiers: [
        { eventId: EVENT_A, id: "tt-a", priceCents: 3000, capacity: 5, status: "ACTIVE" },
      ],
      availabilityThrows: true,
    });
    deps.reportError = () => {
      throw new Error("sentry is down");
    };

    // The composition root wraps the reporter in `safeReporter`; this asserts
    // the use case does not depend on that to stay up. Reporting a swallowed
    // error must never manufacture a new one.
    const result = await getEmbedCalendarEvents(deps, input);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ soldOut: false, priceLabel: null });
  });
});


// ── Single-event subject leg ─────────────────────────────────────────────────

describe("getEmbedCalendarEvents — FR-022/FR-023 on the single-event leg", () => {
  const eventEmbed: EmbedRecord = {
    ...embed,
    subjectType: "event",
    subjectId: EVENT_A,
  };

  const pinnedEvent = {
    id: EVENT_A,
    title: "Pinned Show",
    slug: "pinned-show",
    status: "PUBLISHED",
    startsAt: inDays(6),
    endsAt: null,
    addressText: "1 Road",
    locality: "Nashville",
    region: "TN",
    timezone: "America/Chicago",
    currency: "eur",
    orgId: ORG_ID,
    admissionTaxRateBps: 0,
    placeId: null,
    savedLocationId: null,
  };

  function makeSingleEventDeps(opts: {
    tiers: TierFixture[];
    usage?: Usage[];
  }) {
    const countCapacityUsageForTicketTypes = vi.fn(
      async ({ ticketTypeIds }: { ticketTypeIds: readonly string[] }) => {
        const byId = new Map((opts.usage ?? []).map((u) => [u.ticketTypeId, u]));
        return ticketTypeIds.map(
          (id) => byId.get(id) ?? { ticketTypeId: id, issued: 0, held: 0 },
        );
      },
    );
    const repos = {
      embeds: { getById: vi.fn(async () => eventEmbed) },
      events: {
        getById: vi.fn(async () => pinnedEvent),
        listTicketTypesForEventIds: vi.fn(async () => opts.tiers.map(tier)),
      },
      tickets: { countCapacityUsageForTicketTypes },
      ...feeRepos({}),
      eventDates: { listByEventIds: vi.fn(async () => []) },
    };
    return {
      deps: {
        repos: repos as unknown as GetEmbedCalendarEventsDeps["repos"],
        search: {
          autocomplete: vi.fn(),
        } as unknown as GetEmbedCalendarEventsDeps["search"],
        clock: { now: () => new Date() },
        publicAppUrl: PUBLIC_APP_URL,
      } satisfies GetEmbedCalendarEventsDeps,
      countCapacityUsageForTicketTypes,
    };
  }

  it("the pinned event carries its own sold-out and price, in its own currency", async () => {
    const { deps, countCapacityUsageForTicketTypes } = makeSingleEventDeps({
      tiers: [
        { eventId: EVENT_A, id: "tt-ga", priceCents: 2000, capacity: 30, status: "ACTIVE" },
        { eventId: EVENT_A, id: "tt-vip", priceCents: 5000, capacity: 5, status: "ACTIVE" },
      ],
      usage: [{ ticketTypeId: "tt-ga", issued: 10, held: 0 }],
    });

    const result = await getEmbedCalendarEvents(deps, {
      ...input,
      hostOrigin: HOST_ORIGIN,
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      id: EVENT_A,
      soldOut: false,
      priceLabel: "From €20",
    });
    expect(countCapacityUsageForTicketTypes).toHaveBeenCalledTimes(1);
  });

  it("the pinned event reports sold out once every tier is exhausted", async () => {
    const { deps } = makeSingleEventDeps({
      tiers: [
        { eventId: EVENT_A, id: "tt-ga", priceCents: 2000, capacity: 30, status: "ACTIVE" },
      ],
      usage: [{ ticketTypeId: "tt-ga", issued: 29, held: 1 }],
    });

    const result = await getEmbedCalendarEvents(deps, {
      ...input,
      hostOrigin: HOST_ORIGIN,
    });

    expect(result.events[0]!.soldOut).toBe(true);
  });
});
