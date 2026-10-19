import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildOffsetPaginatedResult } from "@th/ports";
import type { ClockPort } from "@th/ports/clock";
import type { EventRecord, Repos, TxRepos } from "@th/ports/repos";
import type { OrgMembership } from "@th/ports/repos/authz";

import { setEventListingPriority } from "../set-event-listing-priority";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const HUMAN_ID = "00000000-0000-4000-8000-000000000003";
const OTHER_HUMAN_ID = "00000000-0000-4000-8000-000000000004";
const AGREEMENT_ID = "00000000-0000-4000-8000-000000000005";

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

const createRepoMocks = () => {
  const events = {
    getById: vi.fn(),
    listTicketTypes: vi.fn(),
    ensureHostPermission: vi.fn(),
    upsertDraft: vi.fn(),
    publish: vi.fn(),
    setCategory: vi.fn(),
    setListingPriority: vi.fn(),
    filterByCategory: vi.fn(async () =>
      buildOffsetPaginatedResult({ items: [], total: 0, limit: 1, offset: 0 }),
    ),
    listPublishedByRegion: vi.fn(async () =>
      buildOffsetPaginatedResult({ items: [], total: 0, limit: 1, offset: 0 }),
    ),
    searchPublished: vi.fn(),
    updateVisibility: vi.fn(),
    updateGateType: vi.fn(),
    updatePassword: vi.fn(),
    updateWaitlistSettings: vi.fn(),
    getGateSettings: vi.fn(),
    assignSlug: vi.fn(),
    updateSlug: vi.fn(),
    recordSlugHistory: vi.fn(),
    resolveBySlug: vi.fn(),
    getSlugContext: vi.fn(),
  };
  const authz = {
    getHumanDelegation: vi.fn(async () => null),
    getOrgMembership: vi.fn(),
    getEventOrgId: vi.fn(),
    getPlaceAccessContext: vi.fn(),
    isPlaceVerifiedForOrg: vi.fn(),
  };
  const audit = {
    log: vi.fn(),
  };

  const tx = {
    events: events as unknown as TxRepos["events"],
    authz: authz as unknown as TxRepos["authz"],
    audit: audit as unknown as TxRepos["audit"],
  } as unknown as TxRepos;

  const repos: Repos = {
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(tx),
    humans: {} as Repos["humans"],
    events: events as unknown as Repos["events"],
    featuredEvents: {} as Repos["featuredEvents"],
    eventApplications: {} as Repos["eventApplications"],
    eventWaitlists: {} as Repos["eventWaitlists"],
    inviteLists: {} as Repos["inviteLists"],
    categories: {} as Repos["categories"],
    orders: {} as Repos["orders"],
    tickets: {} as Repos["tickets"],
    agreements: {} as Repos["agreements"],
    feePolicies: {} as Repos["feePolicies"],
    splits: {} as Repos["splits"],
    payees: {} as Repos["payees"],
    settlements: {} as Repos["settlements"],
    resaleListings: {} as Repos["resaleListings"],
    idempotency: {} as Repos["idempotency"],
    audit: audit as unknown as Repos["audit"],
    authz: authz as unknown as Repos["authz"],
    apiKeys: {} as Repos["apiKeys"],
    organizations: {} as Repos["organizations"],
    places: {} as Repos["places"],
    savedLocations: {} as Repos["savedLocations"],
    seats: {} as Repos["seats"],
    eventTemplates: {} as Repos["eventTemplates"],
    eventHumans: {} as Repos["eventHumans"],
    series: {} as Repos["series"],
    seriesOccurrences: {} as Repos["seriesOccurrences"],
    pushDevices: {} as Repos["pushDevices"],
    notificationPrefs: {} as Repos["notificationPrefs"],
    notificationDigests: {} as Repos["notificationDigests"],
    notifications: {} as Repos["notifications"],
    placeLayouts: {} as Repos["placeLayouts"],
    placeLayoutBlobs: {} as Repos["placeLayoutBlobs"],
    placeLayoutStatuses: {} as Repos["placeLayoutStatuses"],
    orderItems: {} as Repos["orderItems"],
    orderItemSettlementLines: {} as Repos["orderItemSettlementLines"],
    settlementLines: {} as Repos["settlementLines"],
    payouts: {} as Repos["payouts"],
  };

  return { repos, tx, events, authz, audit };
};

describe("setEventListingPriority", () => {
  const clock: ClockPort = { now: () => new Date("2024-02-01T00:00:00Z") };

  let repos: Repos;
  let eventsMock: ReturnType<typeof createRepoMocks>["events"];
  let authzMock: ReturnType<typeof createRepoMocks>["authz"];
  let auditMock: ReturnType<typeof createRepoMocks>["audit"];

  beforeEach(() => {
    const mocks = createRepoMocks();
    repos = mocks.repos;
    eventsMock = mocks.events;
    authzMock = mocks.authz;
    auditMock = mocks.audit;
  });

  it("allows org admins to set priority", async () => {
    const event = buildEvent();
    eventsMock.getById.mockResolvedValue(event);
    authzMock.getOrgMembership.mockResolvedValue({
      orgId: ORG_ID,
      humanId: HUMAN_ID,
      role: "ADMIN",
    } satisfies OrgMembership);
    eventsMock.setListingPriority.mockResolvedValue({
      ...event,
      listingPriority: 10,
    });

    const result = await setEventListingPriority(
      { repos, clock },
      { actorHumanId: HUMAN_ID, eventId: EVENT_ID, priority: 10 },
    );

    expect(result).toEqual({ eventId: EVENT_ID, listingPriority: 10 });
    expect(eventsMock.setListingPriority).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      priority: 10,
    });
    expect(auditMock.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "event_listing_priority_set",
        data: expect.objectContaining({ actorHumanId: HUMAN_ID, priority: 10 }),
      }),
    );
  });

  it("requires membership when org event", async () => {
    const event = buildEvent();
    eventsMock.getById.mockResolvedValue(event);
    authzMock.getOrgMembership.mockResolvedValue(undefined);

    await expect(
      setEventListingPriority(
        { repos, clock },
        { actorHumanId: OTHER_HUMAN_ID, eventId: EVENT_ID, priority: 5 },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("allows owners of human events to update priority", async () => {
    const humanEvent = buildEvent({ orgId: null, humanId: HUMAN_ID });
    eventsMock.getById.mockResolvedValue(humanEvent);
    eventsMock.setListingPriority.mockResolvedValue({
      ...humanEvent,
      listingPriority: -5,
    });

    const result = await setEventListingPriority(
      { repos, clock },
      { actorHumanId: HUMAN_ID, eventId: EVENT_ID, priority: -5 },
    );

    expect(result.listingPriority).toBe(-5);
    expect(authzMock.getOrgMembership).not.toHaveBeenCalled();
  });

  it("allows clearing priority via null", async () => {
    const event = buildEvent();
    eventsMock.getById.mockResolvedValue(event);
    authzMock.getOrgMembership.mockResolvedValue({
      orgId: ORG_ID,
      humanId: HUMAN_ID,
      role: "OWNER",
    } satisfies OrgMembership);
    eventsMock.setListingPriority.mockResolvedValue({
      ...event,
      listingPriority: null,
    });

    const result = await setEventListingPriority(
      { repos, clock },
      { actorHumanId: HUMAN_ID, eventId: EVENT_ID, priority: null },
    );

    expect(eventsMock.setListingPriority).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      priority: null,
    });
    expect(result.listingPriority).toBeNull();
  });

  it("rejects when human actor mismatches", async () => {
    const humanEvent = buildEvent({ orgId: null, humanId: HUMAN_ID });
    eventsMock.getById.mockResolvedValue(humanEvent);

    await expect(
      setEventListingPriority(
        { repos, clock },
        { actorHumanId: OTHER_HUMAN_ID, eventId: EVENT_ID, priority: 1 },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("throws not_found when missing", async () => {
    eventsMock.getById.mockResolvedValue(null);

    await expect(
      setEventListingPriority(
        { repos, clock },
        {
          actorHumanId: HUMAN_ID,
          eventId: "00000000-0000-4000-8000-000000000099",
          priority: 0,
        },
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });
});
