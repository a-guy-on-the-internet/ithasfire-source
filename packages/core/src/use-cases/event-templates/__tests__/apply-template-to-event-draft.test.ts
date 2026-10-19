import { describe, expect, it, beforeEach, vi } from "vitest";

import { applyTemplateToEventDraft } from "../apply-template-to-event-draft";
import {
  DEFAULT_ACTOR_ID,
  DEFAULT_EVENT_ID,
  DEFAULT_ORG_ID,
  createFakeIdempotencyPort,
  createTestLogger,
} from "@th/test-utils";
import { buildOffsetPaginatedResult } from "@th/ports";
import type { ApplyTemplateToEventDraftInput } from "../schemas";
import type { ApplyTemplateToEventDraftDeps } from "../apply-template-to-event-draft";
import type { EventTemplateRecord } from "@th/types";
import type { EventRecord } from "@th/ports/repos/events";
import type { TemplateOwnerScope } from "@th/types";
import type { TxRepos, Repos } from "@th/ports/repos";

const FIXED_NOW = new Date("2024-03-15T12:00:00.000Z");
const DEFAULT_TEMPLATE_ID = "22222222-2222-4222-8222-222222222222";

interface TestContextOptions {
  ownerScope?: TemplateOwnerScope;
  templateDefaults?: Partial<EventTemplateRecord["defaults"]> | null;
  overrides?: ApplyTemplateToEventDraftInput["overrides"];
  eventOverrides?: Partial<EventRecord>;
  templateActive?: boolean;
  templateArchivedAt?: Date | null;
}

type TestContext = {
  deps: ApplyTemplateToEventDraftDeps;
  template: EventTemplateRecord;
  event: EventRecord;
  tx: TxRepos & {
    events: {
      getById: ReturnType<typeof vi.fn>;
      upsertDraft: ReturnType<typeof vi.fn>;
    };
    eventTemplates: {
      getById: ReturnType<typeof vi.fn>;
    };
    places: { getById: ReturnType<typeof vi.fn> };
    savedLocations: {
      getAccessibleByOrg: ReturnType<typeof vi.fn>;
      getAccessibleByHuman: ReturnType<typeof vi.fn>;
      incrementUsage: ReturnType<typeof vi.fn>;
    };
    audit: { log: ReturnType<typeof vi.fn> };
    authz: { getOrgMembership: ReturnType<typeof vi.fn> };
    organizations: { getById: ReturnType<typeof vi.fn> };
    humans: { getById: ReturnType<typeof vi.fn> };
  };
  apply: (
    inputOverrides?: Partial<ApplyTemplateToEventDraftInput>,
  ) => Promise<void>;
  lastResult?: Awaited<ReturnType<typeof applyTemplateToEventDraft>>;
};

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: DEFAULT_EVENT_ID,
    orgId: DEFAULT_ORG_ID,
    humanId: null,
    title: "Original Title",
    status: "DRAFT",
    visibility: "PRIVATE",
    gateType: "NONE",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    addressRevealAt: null,
    addressRevealPreset: null,
    startsAt: new Date("2024-03-16T18:00:00.000Z"),
    endsAt: null,
    placeId: null,
    savedLocationId: null,
    categoryId: null,
    addressText: null,
    lat: null,
    lng: null,
    slug: null,
    shortId: null,
    regionCode: null,
    publishedAt: null,
    agreementPrimaryId: "agreement-primary",
    agreementResaleId: null,
    defaultLocale: null,
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
  } satisfies EventRecord;
}

function makeTemplate(
  ownerScope: TemplateOwnerScope,
  defaults: EventTemplateRecord["defaults"],
  options: { active?: boolean; archivedAt?: Date | null } = {},
): EventTemplateRecord {
  return {
    id: DEFAULT_TEMPLATE_ID,
    ownerScope,
    ownerId: ownerScope === "ORGANIZATION" ? DEFAULT_ORG_ID : DEFAULT_ACTOR_ID,
    name: "Launch Party",
    description: "",
    active: options.active ?? true,
    defaults,
    createdByHumanId: DEFAULT_ACTOR_ID,
    updatedByHumanId: DEFAULT_ACTOR_ID,
    createdAt: new Date("2024-03-10T12:00:00.000Z"),
    updatedAt: new Date("2024-03-11T12:00:00.000Z"),
    archivedAt: options.archivedAt ?? null,
  } satisfies EventTemplateRecord;
}

function buildRepos(tx: TxRepos): Repos {
  return {
    tx: async <T>(fn: (inner: TxRepos) => Promise<T>) => fn(tx),
    humans: tx.humans as Repos["humans"],
    events: tx.events as Repos["events"],
    featuredEvents: tx.featuredEvents as Repos["featuredEvents"],
    eventApplications: tx.eventApplications as Repos["eventApplications"],
    eventWaitlists: tx.eventWaitlists as Repos["eventWaitlists"],
    inviteLists: tx.inviteLists as Repos["inviteLists"],
    categories: {} as Repos["categories"],
    orders: {} as Repos["orders"],
    orderItems: {} as Repos["orderItems"],
    orderItemSettlementLines: {} as Repos["orderItemSettlementLines"],
    tickets: {} as Repos["tickets"],
    agreements: {} as Repos["agreements"],
    feePolicies: {} as Repos["feePolicies"],
    splits: {} as Repos["splits"],
    payees: {} as Repos["payees"],
    settlements: {} as Repos["settlements"],
    settlementLines: {} as Repos["settlementLines"],
    payouts: {} as Repos["payouts"],
    resaleListings: {} as Repos["resaleListings"],
    idempotency: {} as Repos["idempotency"],
    audit: tx.audit as Repos["audit"],
    authz: tx.authz as Repos["authz"],
    apiKeys: {} as Repos["apiKeys"],
    organizations: tx.organizations as Repos["organizations"],
    places: tx.places as Repos["places"],
    savedLocations: tx.savedLocations as Repos["savedLocations"],
    seats: {} as Repos["seats"],
    eventTemplates: tx.eventTemplates as Repos["eventTemplates"],
    eventHumans: tx.eventHumans as Repos["eventHumans"],
    series: tx.series as Repos["series"],
    seriesOccurrences: tx.seriesOccurrences as Repos["seriesOccurrences"],
    pushDevices: tx.pushDevices as Repos["pushDevices"],
    notificationPrefs: tx.notificationPrefs as Repos["notificationPrefs"],
    notificationDigests: tx.notificationDigests as Repos["notificationDigests"],
    notifications: tx.notifications as Repos["notifications"],
    placeLayouts: tx.placeLayouts as Repos["placeLayouts"],
    placeLayoutBlobs: tx.placeLayoutBlobs as Repos["placeLayoutBlobs"],
    placeLayoutStatuses: tx.placeLayoutStatuses as Repos["placeLayoutStatuses"],
  } satisfies Repos;
}

function makeContext(options: TestContextOptions = {}): TestContext {
  const ownerScope = options.ownerScope ?? "ORGANIZATION";
  const templateDefaults =
    options.templateDefaults === undefined
      ? ({
          title: "New Title",
          location: { kind: "place", placeId: "place-123" } as const,
        } satisfies NonNullable<EventTemplateRecord["defaults"]>)
      : options.templateDefaults;

  const template = makeTemplate(
    ownerScope,
    templateDefaults as EventTemplateRecord["defaults"],
    {
      active: options.templateActive ?? true,
      archivedAt: options.templateArchivedAt ?? null,
    },
  );

  let currentEvent = makeEvent(options.eventOverrides);

  const tx = {
    eventTemplates: {
      getById: vi.fn(async (id: string) =>
        id === template.id ? template : null,
      ),
      findByName: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
      list: vi.fn(),
    },
    events: {
      getById: vi.fn(async (id: string) =>
        id === currentEvent.id ? currentEvent : null,
      ),
      listTicketTypes: vi.fn(),
      ensureHostPermission: vi.fn(),
      upsertDraft: vi.fn(
        async (input: Parameters<TxRepos["events"]["upsertDraft"]>[0]) => {
          currentEvent = {
            ...currentEvent,
            title: input.title,
            placeId:
              input.location.kind === "place" ? input.location.placeId : null,
            savedLocationId:
              input.location.kind === "saved-location"
                ? input.location.savedLocationId
                : null,
            addressText:
              input.location.kind === "freeform"
                ? input.location.addressText
                : null,
            lat: input.location.kind === "freeform" ? input.location.lat : null,
            lng: input.location.kind === "freeform" ? input.location.lng : null,
          } satisfies EventRecord;
          return currentEvent;
        },
      ),
      publish: vi.fn(),
      setCategory: vi.fn(),
      filterByCategory: vi.fn(async () =>
        buildOffsetPaginatedResult({
          items: [],
          total: 0,
          limit: 1,
          offset: 0,
        }),
      ),
      assignSlug: vi.fn(async () => currentEvent),
      updateSlug: vi.fn(async () => currentEvent),
      recordSlugHistory: vi.fn(async () => {}),
      resolveBySlug: vi.fn(async () => null),
      getSlugContext: vi.fn(async () => null),
    },
    eventHumans: {} as any,
    savedLocations: {
      getAccessibleByOrg: vi.fn(
        async ({ id, orgId }: { id: string; orgId: string }) =>
          orgId === template.ownerId
            ? {
                id,
                ownerType: "ORGANIZATION",
                ownerId: template.ownerId,
                usageCount: 0,
              }
            : null,
      ),
      getAccessibleByHuman: vi.fn(async () => null),
      incrementUsage: vi.fn(async () => {}),
    },
    places: {
      getById: vi.fn(async (id: string) => ({
        id,
        status: "ACTIVE",
        verificationStatus: "VERIFIED",
        orgIdsWithAccess: [template.ownerId],
        humanIdsWithAccess: [DEFAULT_ACTOR_ID],
      })),
    },
    audit: {
      log: vi.fn(async () => {}),
    },
    // arrival-areas FR-014 (the template's location hook): no areas.
    arrivalAreas: {
      listForEvent: vi.fn(async () => []),
      setDisabledForEvent: vi.fn(async () => 0),
      deleteHidesForEventNotInPlace: vi.fn(async () => []),
    },
    authz: {
      getOrgMembership: vi.fn(async () => ({
        orgId: template.ownerId,
        humanId: DEFAULT_ACTOR_ID,
        role: "ADMIN",
      })),
      getEventOrgId: vi.fn(),
      getPlaceAccessContext: vi.fn(),
      isPlaceVerifiedForOrg: vi.fn(),
    },
    organizations: {
      getById: vi.fn(async () => ({
        id: template.ownerId,
        name: "Org",
        status: "ACTIVE",
      })),
      create: vi.fn(),
      addMember: vi.fn(),
      countMembersByRole: vi.fn(),
    },
    humans: {
      getById: vi.fn(async (id: string) =>
        id === template.ownerId
          ? {
              id,
              email: "owner@example.com",
              name: "Owner",
              phone: null,
              status: "ACTIVE" as const,

              roles: ["USER"],
              emailVerified: true,
              phoneVerified: true,
              locale: null,
            }
          : null,
      ),
      getByEmail: vi.fn(),
      getByPhone: vi.fn(),

      create: vi.fn(),
      update: vi.fn(),
      ensureByProvider: vi.fn(),
    },
    tickets: {} as TxRepos["tickets"],
    seats: {} as TxRepos["seats"],
    auditTrail: {} as never,
    feePolicies: {} as TxRepos["feePolicies"],
    orders: {} as TxRepos["orders"],
    orderItems: {} as TxRepos["orderItems"],
    orderItemSettlementLines: {} as TxRepos["orderItemSettlementLines"],
    agreements: {} as TxRepos["agreements"],
    splits: {} as TxRepos["splits"],
    payees: {} as TxRepos["payees"],
    settlements: {} as TxRepos["settlements"],
    settlementLines: {} as TxRepos["settlementLines"],
    payouts: {} as TxRepos["payouts"],
    resaleListings: {} as TxRepos["resaleListings"],
    idempotency: {} as TxRepos["idempotency"],
    apiKeys: {} as TxRepos["apiKeys"],
    categories: {} as TxRepos["categories"],
    series: {
      getById: vi.fn(),
      findActiveByName: vi.fn(),
      nameExists: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
      listByOwner: vi.fn(),
    } as TxRepos["series"],
    seriesOccurrences: {
      getById: vi.fn(),
      listBySeries: vi.fn(),
      bulkUpsert: vi.fn(),
      attachEvent: vi.fn(),
      applyOverrides: vi.fn(),
      markStatus: vi.fn(),
      uniqueCheck: vi.fn(),
      getCalendarInfoForEventIds: vi.fn().mockResolvedValue([]),
    } as TxRepos["seriesOccurrences"],
    pushDevices: {} as TxRepos["pushDevices"],
    notificationPrefs: {} as TxRepos["notificationPrefs"],
    notificationDigests: {} as TxRepos["notificationDigests"],
    notifications: {} as TxRepos["notifications"],
    placeLayouts: {} as TxRepos["placeLayouts"],
    placeLayoutBlobs: {} as TxRepos["placeLayoutBlobs"],
    placeLayoutStatuses: {} as TxRepos["placeLayoutStatuses"],
    featuredEvents: {} as TxRepos["featuredEvents"],
    eventApplications: {} as TxRepos["eventApplications"],
    eventWaitlists: {} as TxRepos["eventWaitlists"],
    inviteLists: {} as TxRepos["inviteLists"],
  } as unknown as TestContext["tx"];

  const repos = buildRepos(tx as unknown as TxRepos);

  const deps: ApplyTemplateToEventDraftDeps = {
    repos,
    idempotency: createFakeIdempotencyPort(),
    clock: { now: () => FIXED_NOW },
    logger: createTestLogger(),
  };

  const apply = async (
    inputOverrides: Partial<ApplyTemplateToEventDraftInput> = {},
  ) => {
    const input: ApplyTemplateToEventDraftInput = {
      actorHumanId: DEFAULT_ACTOR_ID,
      templateId: template.id,
      eventId: currentEvent.id,
      overrides: options.overrides,
      clientKey: "apply-key-123",
      ...inputOverrides,
    };

    const result = await applyTemplateToEventDraft(deps, input);
    (ctx as TestContext).lastResult = result;
  };

  const ctx: TestContext = {
    deps,
    template,
    event: currentEvent,
    tx,
    apply,
    lastResult: undefined,
  };

  return ctx;
}

let ctx: TestContext;

beforeEach(() => {
  ctx = makeContext();
});

describe("applyTemplateToEventDraft", () => {
  it("applies template defaults to a draft event", async () => {
    await ctx.apply();

    expect(ctx.tx.eventTemplates.getById).toHaveBeenCalledWith(ctx.template.id);
    expect(ctx.tx.events.upsertDraft).toHaveBeenCalledTimes(1);

    const draftInput = ctx.tx.events.upsertDraft.mock.calls[0]![0];
    expect(draftInput).toMatchObject({
      eventId: ctx.event.id,
      orgId: ctx.event.orgId,
      humanId: ctx.event.humanId,
      title: "New Title",
      status: "DRAFT",
      location: { kind: "place", placeId: "place-123" },
    });

    expect(ctx.lastResult).toEqual({
      eventId: ctx.event.id,
      appliedFields: ["title", "location"],
    });

    expect(ctx.tx.audit.log).toHaveBeenCalledWith({
      entity: "event_template",
      entityId: ctx.template.id,
      action: "applied",
      data: {
        eventId: ctx.event.id,
        appliedFields: ["title", "location"],
      },
      at: FIXED_NOW,
    });
  });

  it("allows overrides to take precedence", async () => {
    ctx = makeContext({
      templateDefaults: {
        title: "Default Title",
        location: { kind: "place", placeId: "place-123" },
      },
      overrides: {
        title: "Override Title",
        location: {
          kind: "freeform",
          addressText: "123 Main St",
          lat: 40,
          lng: -73,
        },
      },
    });

    await ctx.apply();

    expect(ctx.tx.events.upsertDraft).toHaveBeenCalledTimes(1);
    const draftInput = ctx.tx.events.upsertDraft.mock.calls[0]![0];
    expect(draftInput.title).toBe("Override Title");
    expect(draftInput.location).toEqual({
      kind: "freeform",
      addressText: "123 Main St",
      lat: 40,
      lng: -73,
    });
    expect(ctx.lastResult?.appliedFields).toEqual(["title", "location"]);
  });

  it("skips updates when no fields change", async () => {
    ctx = makeContext({ templateDefaults: null });

    await ctx.apply({ overrides: undefined });

    expect(ctx.tx.events.upsertDraft).not.toHaveBeenCalled();
    expect(ctx.lastResult).toEqual({
      eventId: ctx.event.id,
      appliedFields: [],
    });
  });

  it("requires the event to remain a draft", async () => {
    ctx = makeContext({ eventOverrides: { status: "PUBLISHED" } });

    await expect(ctx.apply()).rejects.toMatchObject({ code: "EVENT_NOT_DRAFT" });
    expect(ctx.tx.events.upsertDraft).not.toHaveBeenCalled();
  });

  it("requires the event to belong to the template owner", async () => {
    ctx = makeContext({ eventOverrides: { orgId: "another-org" } });

    await expect(ctx.apply()).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(ctx.tx.events.upsertDraft).not.toHaveBeenCalled();
  });

  it("replays from idempotency on subsequent calls", async () => {
    await ctx.apply();
    expect(ctx.tx.events.upsertDraft).toHaveBeenCalledTimes(1);

    await ctx.apply();
    expect(ctx.tx.events.upsertDraft).toHaveBeenCalledTimes(1);
    expect(ctx.lastResult).toEqual({
      eventId: ctx.event.id,
      appliedFields: ["title", "location"],
    });
  });

  it("throws when the template is inactive", async () => {
    ctx = makeContext({ templateActive: false });
    await expect(ctx.apply()).rejects.toMatchObject({ code: "TEMPLATE_INACTIVE" });
  });

  it("throws when the template is archived", async () => {
    ctx = makeContext({ templateArchivedAt: new Date() });
    await expect(ctx.apply()).rejects.toMatchObject({ code: "TEMPLATE_ARCHIVED" });
  });

  it("validates saved location access for org templates", async () => {
    ctx = makeContext({
      templateDefaults: {
        title: "Same Title",
        location: { kind: "saved-location", savedLocationId: "saved-1" },
      },
      eventOverrides: { title: "Same Title" },
    });

    await ctx.apply();

    expect(ctx.tx.savedLocations.getAccessibleByOrg).toHaveBeenCalledWith({
      id: "saved-1",
      orgId: ctx.template.ownerId,
    });
    expect(ctx.tx.savedLocations.incrementUsage).toHaveBeenCalledWith(
      "saved-1",
    );
    expect(ctx.lastResult?.appliedFields).toEqual(["location"]);
  });

  it("arrival-areas FR-014: a template that moves the draft to another place switches its areas off, audited", async () => {
    const OLD_PLACE_ID = "33333333-3333-4333-8333-333333333311";
    const AREA_ID = "33333333-3333-4333-8333-333333333312";
    const moved = makeContext({
      eventOverrides: { placeId: OLD_PLACE_ID } as Partial<EventRecord>,
    });
    const arrivalAreas = moved.tx.arrivalAreas as unknown as Record<
      string,
      ReturnType<typeof vi.fn>
    >;
    arrivalAreas.listForEvent!.mockResolvedValue([
      { id: AREA_ID, eventId: DEFAULT_EVENT_ID, placeId: null, disabledAt: null },
    ]);
    arrivalAreas.setDisabledForEvent!.mockResolvedValue(1);

    await moved.apply();

    expect(arrivalAreas.setDisabledForEvent).toHaveBeenCalledWith(
      DEFAULT_EVENT_ID,
      expect.any(Date),
    );
    expect(arrivalAreas.deleteHidesForEventNotInPlace).toHaveBeenCalledWith(
      DEFAULT_EVENT_ID,
      "place-123",
    );
    expect(moved.tx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event",
        action: "arrival_areas.disabled_for_location_change",
        data: expect.objectContaining({ arrivalAreaIds: [AREA_ID] }),
      }),
    );
  });

  it("arrival-areas FR-014: a template that keeps the place touches no area", async () => {
    const same = makeContext({
      eventOverrides: { placeId: "place-123" } as Partial<EventRecord>,
    });
    await same.apply();
    const arrivalAreas = same.tx.arrivalAreas as unknown as Record<
      string,
      ReturnType<typeof vi.fn>
    >;
    expect(arrivalAreas.setDisabledForEvent).not.toHaveBeenCalled();
  });
});
