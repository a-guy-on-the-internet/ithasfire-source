import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import { updateNotificationPreferences } from "../update-notification-preferences";
import type { UpdateNotificationPreferencesDeps } from "../update-notification-preferences";
import { buildOffsetPaginatedResult } from "@th/ports/pagination";
import type {
  NotificationPreferenceScope,
  NotificationPreferenceSnapshot,
  NotificationPreferencesRepo,
} from "@th/ports/repos/notification-preferences";
import type { HumanRecord, HumansRepo } from "@th/ports/repos/humans";
import type {
  OrganizationRecord,
  OrganizationsRepo,
} from "@th/ports/repos/organizations";
import type { EventRecord, EventsRepo } from "@th/ports/repos/events";
import type {
  PushDeviceRecord,
  PushDevicesRepo,
} from "@th/ports/repos/push-devices";
import type { AuditRepo } from "@th/ports/repos/audit";
import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  NotificationPreferenceTokenPayload,
  NotificationPreferenceTokensPort,
} from "@th/ports/notification-preference-tokens";
import {
  createFakeIdempotencyPort,
  type FakeIdempotencyPort,
} from "@th/test-utils/fakes/idempotency";
import { createTestLogger } from "@th/test-utils/fakes/logger";

const DEFAULT_NOW = new Date("2025-03-01T12:00:00.000Z");
const DEFAULT_HUMAN_ID = "11111111-1111-4111-8111-aaaaaaaaaaaa";
const DEFAULT_ORG_ID = "22222222-2222-4222-8222-bbbbbbbbbbbb";
const DEFAULT_EVENT_ID = "33333333-3333-4333-8333-cccccccccccc";
const DEFAULT_CLIENT_KEY = "client-key-12345678";
const DEFAULT_SCOPE: NotificationPreferenceScope = { kind: "GLOBAL" } as const;

const CHANNEL_TRUE = {
  transactional: true,
  announcements: true,
  reminders: true,
  marketing: true,
  organizerMessages: true,
  billsYoureOn: true,
} as const;

function createSnapshot(
  overrides: Partial<NotificationPreferenceSnapshot> = {},
): NotificationPreferenceSnapshot {
  return {
    in_app: { ...CHANNEL_TRUE, ...(overrides.in_app ?? {}) },
    email: {
      ...CHANNEL_TRUE,
      frequency: "INSTANT",
      ...(overrides.email ?? {}),
    },
    sms: { ...CHANNEL_TRUE, ...(overrides.sms ?? {}) },
    push: { ...CHANNEL_TRUE, ...(overrides.push ?? {}) },
  } satisfies NotificationPreferenceSnapshot;
}

function cloneSnapshot(
  snapshot: NotificationPreferenceSnapshot,
): NotificationPreferenceSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as NotificationPreferenceSnapshot;
}

const asMock = <Args extends unknown[], R>(fn: (...args: Args) => R) =>
  fn as unknown as MockInstance<Args, R>;

interface MakeContextOptions {
  now?: Date;
  scope?: NotificationPreferenceScope;
  human?: Partial<
    HumanRecord & { emailVerified?: boolean; phoneVerified?: boolean }
  > | null;
  organization?: OrganizationRecord | null;
  event?: EventRecord | null;
  pushDevices?: PushDeviceRecord[];
  snapshot?: NotificationPreferenceSnapshot;
  includeTokens?: boolean;
  idempotencyBeginSequence?: boolean[];
}

interface TestContext {
  deps: UpdateNotificationPreferencesDeps;
  defaults: {
    now: Date;
    humanId: string;
    scope: NotificationPreferenceScope;
  };
  mocks: {
    humans: HumansRepo;
    organizations: OrganizationsRepo;
    events: EventsRepo;
    notificationPrefs: NotificationPreferencesRepo;
    pushDevices: PushDevicesRepo;
    audit: AuditRepo;
    idempotency: FakeIdempotencyPort;
    tokens?: NotificationPreferenceTokensPort;
  };
}

function makeTestContext(options: MakeContextOptions = {}): TestContext {
  const now = options.now ?? new Date(DEFAULT_NOW);
  const scope = options.scope ?? DEFAULT_SCOPE;

  const humanBase: HumanRecord = {
    id: options.human?.id ?? DEFAULT_HUMAN_ID,
    name: "Taylor",
    status: "ACTIVE",
    roles: ["USER"],
    locale: null,
    phone: null,
    billingAddressLine1: null,
    billingAddressLine2: null,
    billingCity: null,
    billingState: null,
    billingPostalCode: null,
    billingCountry: null,
  } satisfies HumanRecord;

  const identityBase = {
    authUserId: options.human?.id ?? DEFAULT_HUMAN_ID,
    email: "user@example.com",
    emailVerified: true,
    phone: "+15555555555",
    phoneVerified: true,
    username: null,
    displayUsername: null,
    image: null,
  };

  const humanRecord: HumanRecord | null =
    options.human === null ? null : { ...humanBase, ...(options.human ?? {}) };
  const identityRecord =
    options.human === null
      ? null
      : { ...identityBase, ...(options.human ?? {}) };

  const humansRepo: HumansRepo = {
    getById: vi.fn(async () => humanRecord),
    getByIdWithIdentity: vi.fn(async () =>
      humanRecord && identityRecord
        ? { human: humanRecord, identity: identityRecord }
        : null,
    ),
    getByEmail: vi.fn(),
    getByPhone: vi.fn(),
    getHumanIdForAuthUserId: vi.fn(),
    linkAuthUserToHuman: vi.fn(async ({ humanId }: any) => ({ humanId })),
    create: vi.fn(),
    update: vi.fn(),
    ensureByProvider: vi.fn(),
    listForSearchIndex: vi.fn(),
    hasSecondFactorEnrolled: vi.fn(async () => false),
  };

  const organizationTemplate: OrganizationRecord = options.organization ?? {
    id: DEFAULT_ORG_ID,
    name: "Default Org",
    slug: "default-org",
    status: "ACTIVE",
    defaultLocale: null,
  };

  const organizationsRepo: OrganizationsRepo = {
    getById: vi.fn(async () =>
      options.organization === null ? null : organizationTemplate,
    ),
    create: vi.fn(),
    addMember: vi.fn(),
    countMembersByRole: vi.fn(),
    listActive: vi.fn(async () => ({ items: [], total: 0 })),
  };

  const eventTemplate: EventRecord = options.event ?? {
    id: DEFAULT_EVENT_ID,
    orgId: DEFAULT_ORG_ID,
    humanId: DEFAULT_HUMAN_ID,
    title: "Launch",
    status: "DRAFT",
    visibility: "PRIVATE",
    gateType: "NONE",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    addressRevealAt: null,
    addressRevealPreset: null,
    startsAt: new Date("2025-04-01T18:00:00.000Z"),
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
    agreementPrimaryId: "44444444-4444-4444-8444-dddddddddddd",
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
  };

  const buildPaginatedEvents = () =>
    buildOffsetPaginatedResult({
      items: options.event === null ? [] : [eventTemplate],
    });

  const eventsRepo: EventsRepo = {
    getById: vi.fn(async () => (options.event === null ? null : eventTemplate)),
    findManyByIds: vi.fn(async () =>
      options.event === null ? [] : [eventTemplate],
    ),
    listTicketTypes: vi.fn(),
    ensureHostPermission: vi.fn(),
    getBody: vi.fn(async () => null),
    updateBody: vi.fn(async () => eventTemplate),
    upsertDraft: vi.fn(),
    publish: vi.fn(),
    setCategory: vi.fn(),
    filterByCategory: vi.fn(async () => buildPaginatedEvents()),
    listPublishedByRegion: vi.fn(async () => buildPaginatedEvents()),
    setListingPriority: vi.fn(async () => eventTemplate),
    searchPublished: vi.fn(async () =>
      options.event === null ? [] : [eventTemplate],
    ),
    listPublishedForSitemap: vi.fn(async () =>
      options.event === null || !eventTemplate.slug
        ? []
        : [
            {
              slug: eventTemplate.slug,
              updatedAt: eventTemplate.updatedAt ?? null,
            },
          ],
    ),
    updateVisibility: vi.fn(async () => eventTemplate),
    updateGateType: vi.fn(async () => eventTemplate),
    updatePassword: vi.fn(async () => eventTemplate),
    updateWaitlistSettings: vi.fn(async () => eventTemplate),
    getGateSettings: vi.fn(async () =>
      options.event === null
        ? null
        : {
            eventId: eventTemplate.id,
            visibility: eventTemplate.visibility,
            gateType: eventTemplate.gateType,
            passwordHash: eventTemplate.passwordHash,
            passwordUpdatedAt: eventTemplate.passwordUpdatedAt,
            waitlistStatus: eventTemplate.waitlistStatus,
            waitlistPublishAt: eventTemplate.waitlistPublishAt ?? null,
            waitlistDescription: eventTemplate.waitlistDescription ?? null,
            waitlistCap: eventTemplate.waitlistCap ?? null,
            payoutTermsId: null,
            resalePayoutTermsId: null,
            placeLayoutId: null,
          },
    ),
    assignSlug: vi.fn(async () => eventTemplate),
    updateSlug: vi.fn(async () => eventTemplate),
    recordSlugHistory: vi.fn(async () => undefined),
    resolveBySlug: vi.fn(async () => null),
    getSlugContext: vi.fn(async () => null),
  } as EventsRepo;

  const pushDevices: PushDeviceRecord[] = options.pushDevices ?? [
    {
      id: "device-1",
      humanId: humanRecord?.id ?? DEFAULT_HUMAN_ID,
      provider: "expo",
      token: "push-token",
      platform: "ios",
      appId: null,
      enabled: true,
      lastSeenAt: null,
      createdAt: now,
      updatedAt: now,
    },
  ];

  const pushDevicesRepo: PushDevicesRepo = {
    upsert: vi.fn(),
    markSeen: vi.fn(),
    disable: vi.fn(),
    disableByToken: vi.fn(),
    disableByHumanToken: vi.fn(),
    findActiveByHuman: vi.fn(async () => pushDevices),
    findByIds: vi.fn(),
  };

  const baseSnapshot = options.snapshot ?? createSnapshot();
  const notificationPrefsRepo: NotificationPreferencesRepo = {
    upsert: vi.fn(async () => undefined),
    readEffective: vi.fn(async () => cloneSnapshot(baseSnapshot)),
  };

  const auditRepo: AuditRepo = {
    log: vi.fn(async () => undefined),
  };

  const txRepos = {
    humans: humansRepo,
    events: eventsRepo,
    featuredEvents: {} as any,
    eventApplications: {} as any,
    eventWaitlists: {} as any,
    inviteLists: {} as any,
    categories: {} as any,
    orders: {} as any,
    tickets: {} as any,
    payoutTerms: {} as any,
    feePolicies: {} as any,
    splits: {} as any,
    payees: {} as any,
    settlements: {} as any,
    resaleListings: {} as any,
    idempotency: {} as any,
    audit: auditRepo,
    authz: {} as any,
    apiKeys: {} as any,
    organizations: organizationsRepo,
    places: {} as any,
    savedLocations: {} as any,
    seats: {} as any,
    eventTemplates: {} as any,
    eventHumans: {} as any,
    series: {} as any,
    seriesOccurrences: {} as any,
    pushDevices: pushDevicesRepo,
    notificationPrefs: notificationPrefsRepo,
    notificationDigests: {} as any,
    notifications: undefined,
    placeLayouts: {} as any,
    placeLayoutBlobs: {} as any,
    placeLayoutStatuses: {} as any,
  } as unknown as TxRepos;

  const repos: Repos = {
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos),
    humans: humansRepo,
    events: eventsRepo,
    featuredEvents: txRepos.featuredEvents,
    eventApplications: txRepos.eventApplications,
    eventWaitlists: txRepos.eventWaitlists,
    inviteLists: txRepos.inviteLists,
    categories: txRepos.categories,
    orders: txRepos.orders,
    tickets: txRepos.tickets,
    payoutTerms: txRepos.payoutTerms,
    feePolicies: txRepos.feePolicies,
    splits: txRepos.splits,
    payees: txRepos.payees,
    settlements: txRepos.settlements,
    resaleListings: txRepos.resaleListings,
    idempotency: txRepos.idempotency,
    audit: auditRepo,
    authz: txRepos.authz,
    apiKeys: txRepos.apiKeys,
    organizations: organizationsRepo,
    places: txRepos.places,
    savedLocations: txRepos.savedLocations,
    seats: txRepos.seats,
    promos: txRepos.promos,
    eventTemplates: txRepos.eventTemplates,
    eventHumans: txRepos.eventHumans,
    series: txRepos.series,
    seriesOccurrences: txRepos.seriesOccurrences,
    pushDevices: pushDevicesRepo,
    notificationPrefs: notificationPrefsRepo,
    notificationDigests: txRepos.notificationDigests,
    notifications: txRepos.notifications,
    placeLayouts: txRepos.placeLayouts,
    placeLayoutBlobs: txRepos.placeLayoutBlobs,
    placeLayoutStatuses: txRepos.placeLayoutStatuses,
  } as unknown as Repos;

  const idempotency = createFakeIdempotencyPort({
    beginSequence: options.idempotencyBeginSequence,
  });
  const logger = createTestLogger();

  const tokensPort =
    options.includeTokens === false
      ? undefined
      : ({
          validateUnsubscribeToken: vi.fn(async () => null),
        } satisfies NotificationPreferenceTokensPort);

  const deps: UpdateNotificationPreferencesDeps = {
    repos,
    clock: { now: () => now },
    idempotency,
    logger,
    tokens: tokensPort,
  };

  return {
    deps,
    defaults: { now, humanId: humanRecord?.id ?? DEFAULT_HUMAN_ID, scope },
    mocks: {
      humans: humansRepo,
      organizations: organizationsRepo,
      events: eventsRepo,
      notificationPrefs: notificationPrefsRepo,
      pushDevices: pushDevicesRepo,
      audit: auditRepo,
      idempotency,
      tokens: tokensPort,
    },
  };
}

describe("updateNotificationPreferences", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = makeTestContext();
  });

  it("persists sanitized deltas and returns eligible snapshot", async () => {
    const input = {
      actorHumanId: ctx.defaults.humanId,
      humanId: ctx.defaults.humanId,
      scope: ctx.defaults.scope,
      clientKey: DEFAULT_CLIENT_KEY,
      updates: {
        categories: { marketing: false },
        channels: {
          email: { marketing: false, frequency: "DAILY_DIGEST" },
          sms: { marketing: false },
        },
      },
    } as const;

    const result = await updateNotificationPreferences(ctx.deps, input);

    expect(result).toMatchObject({
      ok: true,
      scope: ctx.defaults.scope,
      persistedDelta: {
        categories: { marketing: false },
        channels: {
          email: { marketing: false, frequency: "DAILY_DIGEST" },
          sms: { marketing: false },
        },
      },
    });

    expect(ctx.mocks.notificationPrefs.upsert).toHaveBeenCalledWith({
      humanId: ctx.defaults.humanId,
      scope: ctx.defaults.scope,
      delta: {
        categories: { marketing: false },
        channels: {
          email: { marketing: false, frequency: "DAILY_DIGEST" },
          sms: {
            announcements: false,
            billsYoureOn: false,
            marketing: false,
            organizerMessages: false,
            reminders: false,
          },
        },
      },
    });

    expect(ctx.mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "human",
        entityId: ctx.defaults.humanId,
        action: "comms.notification_prefs.updated",
      }),
    );

    expect(ctx.mocks.idempotency.__mocks.commit).toHaveBeenCalled();
  });

  it("rejects mismatched actor without token", async () => {
    await expect(
      updateNotificationPreferences(ctx.deps, {
        actorHumanId: "99999999-9999-4999-8999-ffffffffffff",
        humanId: ctx.defaults.humanId,
        scope: ctx.defaults.scope,
        clientKey: DEFAULT_CLIENT_KEY,
        updates: {
          categories: { marketing: false },
        },
      }),
    ).rejects.toMatchObject({ code: "ACTOR_MISMATCH" });
  });

  it("prevents email updates when email is not verified", async () => {
    const localCtx = makeTestContext({ human: { emailVerified: false } });

    await expect(
      updateNotificationPreferences(localCtx.deps, {
        actorHumanId: localCtx.defaults.humanId,
        humanId: localCtx.defaults.humanId,
        scope: localCtx.defaults.scope,
        clientKey: DEFAULT_CLIENT_KEY,
        updates: {
          channels: {
            email: { marketing: false },
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "channel_ineligible",
      channel: "email",
    });
  });

  it("rejects mismatched token scopes", async () => {
    const tokenCtx = makeTestContext();
    const payload: NotificationPreferenceTokenPayload = {
      tokenId: "token-1",
      humanId: tokenCtx.defaults.humanId,
      scope: { kind: "ORG", orgId: DEFAULT_ORG_ID },
      categories: { marketing: false },
      expiresAt: new Date(tokenCtx.defaults.now.getTime() + 60_000),
    } satisfies NotificationPreferenceTokenPayload;
    asMock(
      tokenCtx.mocks.tokens!.validateUnsubscribeToken,
    ).mockResolvedValueOnce(payload);

    await expect(
      updateNotificationPreferences(tokenCtx.deps, {
        token: "signed-token",
        humanId: tokenCtx.defaults.humanId,
        scope: { kind: "GLOBAL" },
      }),
    ).rejects.toMatchObject({ code: "TOKEN_SCOPE_MISMATCH" });
  });

  it("returns idempotent response when payload was already processed", async () => {
    const input = {
      actorHumanId: ctx.defaults.humanId,
      humanId: ctx.defaults.humanId,
      scope: ctx.defaults.scope,
      clientKey: DEFAULT_CLIENT_KEY,
      updates: {
        categories: { marketing: false },
        channels: {
          email: { marketing: false },
        },
      },
    } as const;

    const first = await updateNotificationPreferences(ctx.deps, input);

    asMock(ctx.mocks.notificationPrefs.upsert).mockClear();
    asMock(ctx.mocks.audit.log).mockClear();
    ctx.mocks.idempotency.__mocks.begin.mockClear();
    ctx.mocks.idempotency.__mocks.commit.mockClear();
    ctx.mocks.idempotency.__mocks.get.mockClear();

    const replay = await updateNotificationPreferences(ctx.deps, input);

    expect(replay).toEqual(first);
    expect(ctx.mocks.notificationPrefs.upsert).not.toHaveBeenCalled();
    expect(ctx.mocks.audit.log).not.toHaveBeenCalled();
    expect(ctx.mocks.idempotency.__mocks.begin).not.toHaveBeenCalled();
    expect(ctx.mocks.idempotency.__mocks.commit).not.toHaveBeenCalled();
    expect(ctx.mocks.idempotency.__mocks.get).toHaveBeenCalledTimes(1);
  });

  it("surfaces dependency failure when in-app snapshot is missing", async () => {
    const brokenCtx = makeTestContext();
    asMock(
      brokenCtx.mocks.notificationPrefs.readEffective,
    ).mockResolvedValueOnce({
      email: { ...CHANNEL_TRUE },
      sms: { ...CHANNEL_TRUE },
      push: { ...CHANNEL_TRUE },
    } as unknown as NotificationPreferenceSnapshot);

    await expect(
      updateNotificationPreferences(brokenCtx.deps, {
        actorHumanId: brokenCtx.defaults.humanId,
        humanId: brokenCtx.defaults.humanId,
        scope: brokenCtx.defaults.scope,
        clientKey: DEFAULT_CLIENT_KEY,
        updates: { categories: { marketing: false } },
      }),
    ).rejects.toMatchObject({ code: "MISSING_IN_APP_PREFERENCES" });
  });

  it("blocks disabling transactional category", async () => {
    await expect(
      updateNotificationPreferences(ctx.deps, {
        actorHumanId: ctx.defaults.humanId,
        humanId: ctx.defaults.humanId,
        scope: ctx.defaults.scope,
        clientKey: DEFAULT_CLIENT_KEY,
        updates: {
          categories: { transactional: false },
        },
      }),
    ).rejects.toMatchObject({ code: "TRANSACTIONAL_CANNOT_BE_DISABLED" });

    expect(ctx.mocks.notificationPrefs.upsert).not.toHaveBeenCalled();
  });
});
