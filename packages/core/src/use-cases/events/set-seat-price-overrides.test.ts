import { describe, expect, it, beforeEach, vi } from "vitest";

import type { EventRecord, Repos, TxRepos } from "@th/ports/repos";
import type { OrgMembership } from "@th/ports/repos/authz";

import { setSeatPriceOverrides } from "./set-seat-price-overrides";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const HUMAN_ID = "00000000-0000-4000-8000-000000000003";
const OTHER_HUMAN_ID = "00000000-0000-4000-8000-000000000004";
const AGREEMENT_ID = "00000000-0000-4000-8000-000000000005";
const SEAT_ID_1 = "00000000-0000-4000-8000-000000000010";
const SEAT_ID_2 = "00000000-0000-4000-8000-000000000011";

const buildEvent = (overrides: Partial<EventRecord> = {}): EventRecord => ({
  id: EVENT_ID,
  orgId: ORG_ID,
  humanId: null,
  title: "Event 1",
  status: "PUBLISHED",
  visibility: "PUBLIC",
  gateType: "NONE",
  locationMode: "EXACT",
  locationRadiusMeters: null,
  locationLabel: null,
  addressRevealAt: null,
  addressRevealPreset: null,
  startsAt: new Date("2024-01-01T00:00:00Z"),
  endsAt: new Date("2024-01-01T01:00:00Z"),
  placeId: null,
  savedLocationId: null,
  categoryId: null,
  addressText: null,
  lat: null,
  lng: null,
  slug: "ev-1",
  shortId: "EV1",
  regionCode: "US-CA",
  publishedAt: new Date("2023-12-15T00:00:00Z"),
  agreementPrimaryId: AGREEMENT_ID,
  agreementResaleId: null,
  defaultLocale: "en-US",
  listingPriority: null,
  passwordHash: null,
  passwordUpdatedAt: null,
  waitlistStatus: "DISABLED",
  waitlistPublishAt: null,
  waitlistDescription: null,
  waitlistCap: null,
  payoutTermsId: null,
  resalePayoutTermsId: null,
  placeLayoutId: null,
  ...overrides,
});

const SECTION_ID = "00000000-0000-4000-8000-000000000020";
const clock = { now: () => new Date("2024-01-01T00:00:00Z") };
const NO_SKIPS = { sold: 0, held: 0, busy: 0, notFound: 0 };

/** Every requested seat exists, AVAILABLE, in a section with a $30 FIXED tier. */
const lockedSeats = async ({ seatIds }: { seatIds: string[] }) =>
  seatIds.map((id) => ({
    id,
    seatSectionId: SECTION_ID,
    status: "AVAILABLE",
    busy: false,
  }));
const paidFixedTier = {
  id: "00000000-0000-4000-8000-000000000030",
  status: "ACTIVE",
  seatSectionId: SECTION_ID,
  pricingMode: "FIXED",
  priceCents: 3000,
  minimumCents: null,
  scheduledPriceCents: null,
  scheduledPriceAt: null,
};

type RepoMocks = {
  tx: TxRepos;
  events: {
    getById: ReturnType<typeof vi.fn>;
    listTicketTypes: ReturnType<typeof vi.fn>;
  };
  seats: {
    lockSeatsForPriceOverrideWrite: ReturnType<typeof vi.fn>;
    updatePriceOverrides: ReturnType<typeof vi.fn>;
  };
  authz: {
    getOrgMembership: ReturnType<typeof vi.fn>;
    getHumanDelegation: ReturnType<typeof vi.fn>;
  };
  audit: {
    log: ReturnType<typeof vi.fn>;
  };
};

const createRepoMocks = (): { repos: Repos; mocks: RepoMocks } => {
  const events = {
    getById: vi.fn(),
    listTicketTypes: vi.fn(async () => [paidFixedTier]),
  };
  const seats = {
    lockSeatsForPriceOverrideWrite: vi.fn(lockedSeats),
    updatePriceOverrides: vi.fn(),
  };
  const authz = {
    getOrgMembership: vi.fn(),
    getHumanDelegation: vi.fn(async () => null),
  };
  const audit = { log: vi.fn() };

  const tx = {
    events,
    seats,
    authz,
    audit,
  } as unknown as TxRepos;

  const repos = {
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(tx),
    events,
    seats,
    authz,
    audit,
  } as unknown as Repos;

  return { repos, mocks: { tx, events, seats, authz, audit } };
};

describe("setSeatPriceOverrides", () => {
  let repos: Repos;
  let mocks: RepoMocks;

  beforeEach(() => {
    ({ repos, mocks } = createRepoMocks());
  });

  it("sets price overrides for org members with edit role", async () => {
    mocks.events.getById.mockResolvedValue(buildEvent());
    mocks.authz.getOrgMembership.mockResolvedValue({
      orgId: ORG_ID,
      humanId: HUMAN_ID,
      role: "ADMIN",
    } satisfies OrgMembership);
    mocks.seats.updatePriceOverrides.mockResolvedValue(2);

    const result = await setSeatPriceOverrides(
      { repos, clock },
      {
        actorHumanId: HUMAN_ID,
        eventId: EVENT_ID,
        seatIds: [SEAT_ID_1, SEAT_ID_2],
        priceOverride: { priceCents: 5000, reason: "VIP upgrade" },
      },
    );

    expect(result).toEqual({
      eventId: EVENT_ID,
      updated: 2,
      skipped: NO_SKIPS,
    });
    expect(mocks.seats.updatePriceOverrides).toHaveBeenCalledWith({
      seatIds: [SEAT_ID_1, SEAT_ID_2],
      eventId: EVENT_ID,
      priceOverride: { priceCents: 5000, reason: "VIP upgrade" },
    });
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event",
        entityId: EVENT_ID,
        action: "seat_price_overrides_set",
      }),
    );
  });

  it("clears price overrides when null is passed", async () => {
    mocks.events.getById.mockResolvedValue(buildEvent());
    mocks.authz.getOrgMembership.mockResolvedValue({
      orgId: ORG_ID,
      humanId: HUMAN_ID,
      role: "ADMIN",
    } satisfies OrgMembership);
    mocks.seats.updatePriceOverrides.mockResolvedValue(2);

    const result = await setSeatPriceOverrides(
      { repos, clock },
      {
        actorHumanId: HUMAN_ID,
        eventId: EVENT_ID,
        seatIds: [SEAT_ID_1, SEAT_ID_2],
        priceOverride: null,
      },
    );

    expect(result).toEqual({
      eventId: EVENT_ID,
      updated: 2,
      skipped: NO_SKIPS,
    });
    expect(mocks.seats.updatePriceOverrides).toHaveBeenCalledWith(
      expect.objectContaining({ priceOverride: null }),
    );
  });

  it("throws not_found when event does not exist", async () => {
    mocks.events.getById.mockResolvedValue(null);

    await expect(
      setSeatPriceOverrides(
        { repos, clock },
        {
          actorHumanId: HUMAN_ID,
          eventId: EVENT_ID,
          seatIds: [SEAT_ID_1],
          priceOverride: { priceCents: 1000 },
        },
      ),
    ).rejects.toEqual(expect.objectContaining({ code: "EVENT_NOT_FOUND" }));
  });

  it("throws forbidden when actor lacks org edit role", async () => {
    mocks.events.getById.mockResolvedValue(buildEvent());
    // requireOrgMembership checks return value — null means no membership
    mocks.authz.getOrgMembership.mockResolvedValue(null);

    await expect(
      setSeatPriceOverrides(
        { repos, clock },
        {
          actorHumanId: OTHER_HUMAN_ID,
          eventId: EVENT_ID,
          seatIds: [SEAT_ID_1],
          priceOverride: { priceCents: 1000 },
        },
      ),
    ).rejects.toEqual(expect.objectContaining({ code: "INSUFFICIENT_ROLE" }));
  });

  it("throws conflict for cancelled events", async () => {
    mocks.events.getById.mockResolvedValue(buildEvent({ status: "CANCELLED" }));
    mocks.authz.getOrgMembership.mockResolvedValue({
      orgId: ORG_ID,
      humanId: HUMAN_ID,
      role: "ADMIN",
    } satisfies OrgMembership);

    await expect(
      setSeatPriceOverrides(
        { repos, clock },
        {
          actorHumanId: HUMAN_ID,
          eventId: EVENT_ID,
          seatIds: [SEAT_ID_1],
          priceOverride: { priceCents: 1000 },
        },
      ),
    ).rejects.toEqual(expect.objectContaining({ code: "EVENT_NOT_EDITABLE" }));
  });

  it("rejects invalid input (negative priceCents)", async () => {
    await expect(
      setSeatPriceOverrides(
        { repos, clock },
        {
          actorHumanId: HUMAN_ID,
          eventId: EVENT_ID,
          seatIds: [SEAT_ID_1],
          priceOverride: { priceCents: -100 },
        },
      ),
    ).rejects.toEqual(expect.objectContaining({ code: "invalid_input" }));
  });

  it("rejects empty seatIds array", async () => {
    await expect(
      setSeatPriceOverrides(
        { repos, clock },
        {
          actorHumanId: HUMAN_ID,
          eventId: EVENT_ID,
          seatIds: [],
          priceOverride: { priceCents: 1000 },
        },
      ),
    ).rejects.toEqual(expect.objectContaining({ code: "invalid_input" }));
  });

  it("allows personal event owners to set overrides", async () => {
    const personalEvent = buildEvent({ orgId: null, humanId: HUMAN_ID });
    mocks.events.getById.mockResolvedValue(personalEvent);
    mocks.seats.updatePriceOverrides.mockResolvedValue(1);

    const result = await setSeatPriceOverrides(
      { repos, clock },
      {
        actorHumanId: HUMAN_ID,
        eventId: EVENT_ID,
        seatIds: [SEAT_ID_1],
        priceOverride: { priceCents: 2500 },
      },
    );

    expect(result).toEqual({
      eventId: EVENT_ID,
      updated: 1,
      skipped: NO_SKIPS,
    });
  });

  it("throws forbidden for non-owner of personal event", async () => {
    const personalEvent = buildEvent({ orgId: null, humanId: OTHER_HUMAN_ID });
    mocks.events.getById.mockResolvedValue(personalEvent);

    await expect(
      setSeatPriceOverrides(
        { repos, clock },
        {
          actorHumanId: HUMAN_ID,
          eventId: EVENT_ID,
          seatIds: [SEAT_ID_1],
          priceOverride: { priceCents: 2500 },
        },
      ),
    ).rejects.toEqual(expect.objectContaining({ code: "NOT_RESOURCE_OWNER" }));
  });
});
