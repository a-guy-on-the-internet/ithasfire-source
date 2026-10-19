import { vi } from "vitest";

import type { UpsertAgreementDeps } from "@th/core/use-cases/agreements";
import type { ClockPort } from "@th/ports/clock";
import type {
  PayoutTermsRecord,
  PayoutTermsLineRecord,
  PayoutTermsLineInput,
} from "@th/ports/repos/payout-terms";
import type { OrgMembership, OrgRole } from "@th/ports/repos/authz";
import type { EventRecord } from "@th/ports/repos/events";
import type { FeePolicyRecord } from "@th/ports/repos/fee-policies";
import type { PayeeRecord } from "@th/ports/repos/payees";
import type { EntityPageRecord } from "@th/ports/repos/entity-pages";
import type { Repos, TxOptions, TxRepos } from "@th/ports/repos";
import type { HumanRecord, HumansRepo } from "@th/ports/repos/humans";
import type { OrganizationRecord } from "@th/ports/repos/organizations";
import { buildOffsetPaginatedResult } from "@th/ports/pagination";

import {
  createFakeIdempotencyPort,
  type FakeIdempotencyPort,
} from "./idempotency";
import { createTestLogger } from "./logger";
import {
  createFakeBookingRequestMessagesRepo,
  createFakeCalendarsRepo,
  createFakeSpacesRepo,
} from "./venue-hierarchy";

type ListByEventOption =
  | PayoutTermsRecord[]
  | Record<string, PayoutTermsRecord[]>
  | ((eventId: string) => PayoutTermsRecord[])
  | null
  | undefined;

const agreementsRepoPrototype = {
  getById: vi.fn(),
  listByEvent: vi.fn(),
  createDraft: vi.fn(),
  updateDraft: vi.fn(),
  replaceLines: vi.fn(),
  listLines: vi.fn(),
  pinFeePolicy: vi.fn(),
};

const eventsRepoPrototype = {
  getById: vi.fn(),
};

const organizationsRepoPrototype = {
  getById: vi.fn(),
  create: vi.fn(),
  addMember: vi.fn(),
  countMembersByRole: vi.fn(),
  listActive: vi.fn(),
  listMembers: vi.fn(),
  removeMember: vi.fn(),
};

const humansRepoPrototype = {
  getById: vi.fn(),
  getByIdWithIdentity: vi.fn(),
  getAccountCreatedAt: vi.fn(),
  stampFirstSignInIfUnset: vi.fn(),
  getByEmail: vi.fn(),
  getByPhone: vi.fn(),
  getByUsername: vi.fn(),
  batchLookupHumanIdsByEmail: vi.fn(),
  getHumanIdForAuthUserId: vi.fn(),
  linkAuthUserToHuman: vi.fn(),
  searchByQuery: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  ensureByProvider: vi.fn(),
  listForSearchIndex: vi.fn(),
};

const entityPagesRepoPrototype = {
  getByOwner: vi.fn(),
  upsert: vi.fn(),
};

const payeesRepoPrototype = {
  getById: vi.fn(),
  getBySubject: vi.fn(),
  syncCapabilities: vi.fn(),
};

const feePoliciesRepoPrototype = {
  getById: vi.fn(),
};

const categoriesRepoPrototype = {
  listActive: vi.fn(),
  listAll: vi.fn(),
  getBySlug: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  upsertSeed: vi.fn(),
};

const eventTemplatesRepoPrototype = {
  getById: vi.fn(),
  findByName: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  list: vi.fn(),
};

const eventHumansRepoPrototype = {
  attach: vi.fn(),
  detach: vi.fn(),
  listByEvent: vi.fn(),
  reorder: vi.fn(),
  getById: vi.fn(),
};

const auditRepoPrototype = {
  log: vi.fn(),
};

const authzRepoPrototype = {
  getOrgMembership: vi.fn(),
  getEventHumanId: vi.fn(),
  getHumanDelegation: vi.fn(),
};

const DEFAULT_EVENT_ID = "aaaa0000-0000-4000-8000-000000000001";
const DEFAULT_ORG_ID = "bbbb0000-0000-4000-8000-000000000002";
const DEFAULT_HUMAN_ID = "cccc0000-0000-4000-8000-000000000003";
const DEFAULT_ACTOR_ID = "dddd0000-0000-4000-8000-000000000004";
const DEFAULT_PAYEE_ID = "eeee0000-0000-4000-8000-000000000005";
const DEFAULT_AGREEMENT_ID = "ffff0000-0000-4000-8000-000000000006";
const DEFAULT_FEE_POLICY_ID = "99990000-0000-4000-8000-000000000099";
const DEFAULT_NOW = new Date("2024-03-15T12:00:00.000Z");

export type MakeUpsertAgreementDepsOptions = {
  event?: EventRecord | null;
  organization?: OrganizationRecord | null;
  membership?: OrgMembership | null;
  membershipRole?: OrgRole;
  actorHumanId?: string;
  human?: HumanRecord | null;
  entityPage?: EntityPageRecord | null;
  payees?: Record<string, PayeeRecord | null>;
  feePolicy?: FeePolicyRecord | null;
  agreementsForEvent?: ListByEventOption;
  existingAgreement?: PayoutTermsRecord | null;
  existingLines?: PayoutTermsLineRecord[];
  agreementId?: string;
  idempotencyBeginSequence?: boolean[];
  now?: Date;
};

export type UpsertAgreementTestContext = {
  deps: UpsertAgreementDeps;
  mocks: {
    agreements: typeof agreementsRepoPrototype;
    events: typeof eventsRepoPrototype;
    organizations: typeof organizationsRepoPrototype;
    entityPages: typeof entityPagesRepoPrototype;
    humans: typeof humansRepoPrototype;
    payees: typeof payeesRepoPrototype;
    feePolicies: typeof feePoliciesRepoPrototype;
    categories: typeof categoriesRepoPrototype;
    eventTemplates: typeof eventTemplatesRepoPrototype;
    eventHumans: typeof eventHumansRepoPrototype;
    audit: typeof auditRepoPrototype;
    authz: typeof authzRepoPrototype;
    logger: ReturnType<typeof createTestLogger>;
    idempotency: FakeIdempotencyPort;
  };
  defaults: {
    now: Date;
    eventId: string;
    orgId: string;
    humanId: string;
    actorHumanId: string;
    payeeId: string;
    agreementId: string;
    feePolicyId: string;
  };
};

const DEFAULT_FEE_POLICY: FeePolicyRecord = {
  id: DEFAULT_FEE_POLICY_ID,
  scopeType: "GLOBAL",
  scopeId: null,
  status: "ACTIVE",
  version: 1,
  effectiveFrom: new Date("2024-01-01T00:00:00.000Z"),
  effectiveTo: null,
  buyerFeePct: 450,
  maxFeeCents: null,
  minFeeCents: 100,
  platformFixedCents: 0,
  feeMode: "ABSORB",
  processsorFeePct: 290,
  processorFixedCents: 30,
  payoutPct: 9200,
  payoutFixedCents: 0,
  monthlyPayoutCents: 0,
  connectAccountFeeCents: 0,
};

const DEFAULT_PAYEE: PayeeRecord = {
  id: DEFAULT_PAYEE_ID,
  subjectType: "ORGANIZATION",
  subjectId: DEFAULT_ORG_ID,
  stripeAccountId: null,
  status: "ACTIVE",
  payoutsEnabled: true,
  chargesEnabled: true,
  defaultCurrency: "usd",
};

const DEFAULT_EVENT: EventRecord = {
  id: DEFAULT_EVENT_ID,
  orgId: DEFAULT_ORG_ID,
  humanId: null,
  title: "Gala",
  status: "DRAFT",
  attendanceMode: "TICKETED",
  stewardship: "OWNED",
  visibility: "PUBLIC",
  gateType: "NONE",
  locationMode: "EXACT",
  locationRadiusMeters: null,
  locationLabel: null,
  addressRevealAt: null,
  addressRevealPreset: null,
  waitlistStatus: "DISABLED",
  startsAt: new Date("2024-04-01T20:00:00.000Z"),
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
  defaultLocale: null,
  publishedAt: null,
  agreementPrimaryId: DEFAULT_AGREEMENT_ID,
  payoutTermsId: DEFAULT_AGREEMENT_ID,
  agreementResaleId: null,
  resalePayoutTermsId: null,
  placeLayoutId: null,
};

const DEFAULT_ORG: OrganizationRecord = {
  id: DEFAULT_ORG_ID,
  name: "Default Org",
  slug: "default-org",
  status: "ACTIVE",
  defaultLocale: null,
};

const DEFAULT_HUMAN = {
  id: DEFAULT_HUMAN_ID,
  name: "Pat Person",
  status: "ACTIVE" as const,
  roles: [],
  locale: null,
  phone: null,
  billingAddressLine1: null,
  billingAddressLine2: null,
  billingCity: null,
  billingState: null,
  billingPostalCode: null,
  billingCountry: null,
  defaultPrimaryPayoutTermsId: null,
  defaultResalePayoutTermsId: null,
} satisfies HumanRecord;

const DEFAULT_ENTITY_PAGE: EntityPageRecord = {
  id: "page-default",
  ownerType: "HUMAN",
  ownerId: DEFAULT_HUMAN_ID,
  slug: "pat-person",
  displayName: "Pat Person",
  bio: null,
  avatarUrl: null,
  bannerUrl: null,
  visibility: "PUBLIC",
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
  updatedAt: new Date("2024-01-01T00:00:00.000Z"),
};

export function makeUpsertAgreementTestContext(
  options: MakeUpsertAgreementDepsOptions = {},
): UpsertAgreementTestContext {
  const now = options.now ?? DEFAULT_NOW;
  const agreementId = options.agreementId ?? DEFAULT_AGREEMENT_ID;
  const event = options.event ?? DEFAULT_EVENT;
  const organization = options.organization ?? DEFAULT_ORG;
  const actorHumanId =
    options.actorHumanId ?? options.membership?.humanId ?? DEFAULT_ACTOR_ID;
  const human = options.human ?? DEFAULT_HUMAN;
  const entityPageRecord = options.entityPage ?? DEFAULT_ENTITY_PAGE;

  let currentHuman: HumanRecord | null = human ? { ...human } : null;
  let currentEntityPage: EntityPageRecord | null =
    entityPageRecord?.ownerId === currentHuman?.id
      ? { ...entityPageRecord }
      : null;

  let currentAgreement: PayoutTermsRecord | null =
    Object.prototype.hasOwnProperty.call(options, "existingAgreement")
      ? (options.existingAgreement ?? null)
      : null;

  let currentLines: PayoutTermsLineRecord[] = options.existingLines
    ? options.existingLines.map((line) => ({ ...line }))
    : [];

  const resolveMembership = (): OrgMembership | null => {
    if (Object.prototype.hasOwnProperty.call(options, "membership")) {
      return options.membership ?? null;
    }
    const role = options.membershipRole ?? "ADMIN";
    return {
      orgId: organization.id,
      humanId: actorHumanId,
      role,
    } satisfies OrgMembership;
  };

  const payeeMap = new Map<string, PayeeRecord>();
  const payeesOption = options.payees ?? {};
  const defaultPayee = payeesOption[DEFAULT_PAYEE.id] ?? DEFAULT_PAYEE;
  if (defaultPayee) {
    payeeMap.set(DEFAULT_PAYEE.id, defaultPayee);
  }
  for (const [id, record] of Object.entries(payeesOption)) {
    if (record) {
      payeeMap.set(id, record);
    } else {
      payeeMap.delete(id);
    }
  }

  const feePolicyMap = new Map<string, FeePolicyRecord>();
  const feePolicy = options.feePolicy ?? DEFAULT_FEE_POLICY;
  feePolicyMap.set(feePolicy.id, feePolicy);

  const agreementsRepo: typeof agreementsRepoPrototype = {
    getById: vi.fn(async (id: string) => {
      if (currentAgreement && currentAgreement.id === id) {
        return currentAgreement;
      }
      return null;
    }),
    listByEvent: vi.fn(async (eventId: string) => {
      const custom = resolveListByEvent(options.agreementsForEvent, eventId);
      if (custom) {
        return custom;
      }
      if (currentAgreement && eventId === event.id) {
        return [currentAgreement];
      }
      return [];
    }),
    createDraft: vi.fn(async (input) => {
      currentAgreement = {
        id: agreementId,
        kind: input.kind,
        status: "PENDING",
        feeMode: null,
        feePolicyId: input.feePolicyId ?? null,
        settlementCurrency: input.settlementCurrency,
        payoutSchedule: "WEEK_OF_EVENT",
        isDefault: false,
        version: currentAgreement ? currentAgreement.version + 1 : 1,
        createdAt: now,
        updatedAt: now,
      } satisfies PayoutTermsRecord;
      currentLines = [];
      return currentAgreement;
    }),
    updateDraft: vi.fn(async (input) => {
      if (!currentAgreement || currentAgreement.id !== input.agreementId) {
        throw new Error("agreement not found");
      }
      currentAgreement = {
        ...currentAgreement,
        feePolicyId: Object.prototype.hasOwnProperty.call(input, "feePolicyId")
          ? (input.feePolicyId ?? null)
          : currentAgreement.feePolicyId,
        settlementCurrency:
          input.settlementCurrency ?? currentAgreement.settlementCurrency,
        updatedAt: now,
      } satisfies PayoutTermsRecord;
      return currentAgreement;
    }),
    replaceLines: vi.fn(async (id: string, lines: PayoutTermsLineInput[]) => {
      currentLines = lines.map(
        (line, index): PayoutTermsLineRecord => ({
          id: line.id ?? `line-${index + 1}`,
          payoutTermsId: id,
          payeeId: line.payeeId,
          percent: line.percent,
          floorCents: line.floorCents,
          capPercent: line.capPercent ?? null,
          priority: line.priority,
          rounding: line.rounding,
        }),
      );
    }),
    listLines: vi.fn(async (id) => {
      if (!currentAgreement || currentAgreement.id !== id) {
        return [];
      }
      return currentLines.map((line) => ({ ...line }));
    }),
    pinFeePolicy: vi.fn(async ({ agreementId, feePolicyId }) => {
      if (!currentAgreement || currentAgreement.id !== agreementId) {
        throw new Error("agreement not found");
      }
      currentAgreement = {
        ...currentAgreement,
        feePolicyId,
        updatedAt: now,
      };
      return currentAgreement;
    }),
  };

  const eventsRepo: typeof eventsRepoPrototype = {
    getById: vi.fn(async (id: string) => {
      if (event && event.id === id) {
        return event;
      }
      return null;
    }),
  };

  const organizationsRepo: typeof organizationsRepoPrototype = {
    getById: vi.fn(async (id: string) => {
      if (organization && organization.id === id) {
        return organization;
      }
      return null;
    }),
    create: vi.fn(),
    addMember: vi.fn(),
    countMembersByRole: vi.fn(),
    listActive: vi.fn(async () => []),
    listMembers: vi.fn(async () => ({ items: [], total: 0 })),
    removeMember: vi.fn(async () => true),
  };

  const humansRepo: typeof humansRepoPrototype = {
    getById: vi.fn(async (id: string) => {
      if (currentHuman && currentHuman.id === id) {
        return { ...currentHuman };
      }
      return null;
    }),
    getByIdWithIdentity: vi.fn(async () => null),
    listEmailVerifiedIds: vi.fn(async () => []),
    getAccountCreatedAt: vi.fn(async () => null),
    stampFirstSignInIfUnset: vi.fn(async () => undefined),
    getByEmail: vi.fn(async () => null),
    getByPhone: vi.fn(async () => null),
    getByUsername: vi.fn(async () => null),
    batchLookupHumanIdsByEmail: vi.fn(async () => new Map()),
    getHumanIdForAuthUserId: vi.fn(async () => null),
    linkAuthUserToHuman: vi.fn(
      async ({ humanId }: { authUserId: string; humanId: string }) => ({
        humanId,
      }),
    ),
    searchByQuery: vi.fn(async () => []),
    create: vi.fn(async (input) => {
      currentHuman = {
        id: DEFAULT_HUMAN_ID,
        name: input.name ?? null,
        status: input.status,
        roles: [],
        locale: input.locale ?? null,
        phone: null,
        billingAddressLine1: null,
        billingAddressLine2: null,
        billingCity: null,
        billingState: null,
        billingPostalCode: null,
        billingCountry: null,
        defaultPrimaryPayoutTermsId: null,
        defaultResalePayoutTermsId: null,
      } satisfies HumanRecord;
      return { ...currentHuman };
    }),
    update: vi.fn(async (id, updates) => {
      if (!currentHuman || currentHuman.id !== id) {
        throw new Error("human not found");
      }
      currentHuman = {
        ...currentHuman,
        ...updates,
        locale: Object.prototype.hasOwnProperty.call(updates, "locale")
          ? (updates.locale ?? null)
          : currentHuman.locale,
      } satisfies HumanRecord;
      return { ...currentHuman };
    }),
    ensureByProvider: vi.fn(async ({ providerUserId }) => {
      if (currentHuman && currentHuman.id === providerUserId) {
        return { humanId: currentHuman.id, created: false };
      }
      const ensured: HumanRecord = {
        id: providerUserId,
        name: null,
        status: "ACTIVE",
        roles: [],
        locale: null,
        phone: null,
        billingAddressLine1: null,
        billingAddressLine2: null,
        billingCity: null,
        billingState: null,
        billingPostalCode: null,
        billingCountry: null,
        defaultPrimaryPayoutTermsId: null,
        defaultResalePayoutTermsId: null,
      };
      currentHuman = ensured;
      return { humanId: ensured.id, created: true };
    }),
    ensureGuestHuman: vi.fn(async ({ name }) => {
      if (currentHuman) return { humanId: currentHuman.id, created: false };
      const guestId = "guest-" + Math.random().toString(36).slice(2, 10);
      return { humanId: guestId, created: true };
    }),
    listForSearchIndex: vi.fn(async ({ limit = 100, offset = 0 } = {}) =>
      buildOffsetPaginatedResult({
        items:
          currentHuman && currentEntityPage
            ? [{ human: currentHuman, page: currentEntityPage }]
            : [],
        limit,
        offset,
        total: currentHuman && currentEntityPage ? 1 : 0,
      }),
    ),
    listAllWithMemberships: vi.fn(async ({ limit = 25, offset = 0 } = {}) =>
      buildOffsetPaginatedResult({
        items: [],
        limit,
        offset,
        total: 0,
      }),
    ),
    hasSecondFactorEnrolled: vi.fn(async () => false),
  } satisfies HumansRepo;

  const entityPagesRepo: typeof entityPagesRepoPrototype = {
    ...entityPagesRepoPrototype,
    getByOwner: vi.fn(async (ownerType: string, ownerId: string) => {
      if (
        currentEntityPage &&
        currentEntityPage.ownerType === ownerType &&
        currentEntityPage.ownerId === ownerId
      ) {
        return { ...currentEntityPage };
      }
      return null;
    }),
    upsert: vi.fn(async (input) => {
      currentEntityPage = { ...DEFAULT_ENTITY_PAGE, ...input };
      return { ...currentEntityPage };
    }),
  };

  const payeesRepo: typeof payeesRepoPrototype = {
    getById: vi.fn(async (id: string) => {
      return payeeMap.get(id) ?? null;
    }),
    getBySubject: vi.fn(),
    syncCapabilities: vi.fn(),
  };

  const feePoliciesRepo: typeof feePoliciesRepoPrototype = {
    getById: vi.fn(async (id: string) => {
      return feePolicyMap.get(id) ?? null;
    }),
  };

  const categoriesRepo: typeof categoriesRepoPrototype = {
    listActive: vi.fn(async () => []),
    listAll: vi.fn(async () => []),
    getBySlug: vi.fn(async () => null),
    getById: vi.fn(async () => null),
    create: vi.fn(async (input: any) => ({
      id: "category-test-id",
      slug: input.slug,
      name: input.name,
      active: input.active ?? true,
      sortOrder: input.sortOrder ?? 0,
      createdAt: now,
      updatedAt: now,
    })),
    upsertSeed: vi.fn(async () => {}),
  };

  const eventTemplatesRepo: typeof eventTemplatesRepoPrototype = {
    getById: vi.fn(async () => null),
    findByName: vi.fn(async () => null),
    create: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
    list: vi.fn(async () => ({ total: 0, items: [] })),
  };

  const eventHumansRepo: typeof eventHumansRepoPrototype = {
    attach: vi.fn(),
    detach: vi.fn(),
    listByEvent: vi.fn(async () => []),
    reorder: vi.fn(),
    getById: vi.fn(async () => null),
  };

  const auditRepo: typeof auditRepoPrototype = {
    log: vi.fn(async () => {}),
  };

  const authzRepo: typeof authzRepoPrototype = {
    getOrgMembership: vi.fn(async () => resolveMembership()),
    getEventHumanId: vi.fn(async () => null),
    getHumanDelegation: vi.fn(async () => null),
  };

  const txRepos: TxRepos = {
    humans: humansRepo as any,
    entityPages: entityPagesRepo as any,
    events: eventsRepo as any,
    spaces: createFakeSpacesRepo(),
    calendars: createFakeCalendarsRepo(),
    bookingRequestMessages: createFakeBookingRequestMessagesRepo(),
    featuredEvents: {} as any,
    eventApplications: {} as any,
    eventWaitlists: {} as any,
    inviteLists: {} as any,
    orders: {} as any,
    orderItems: {} as any,
    orderItemSettlementLines: {} as any,
    tickets: {} as any,
    seats: {} as any,
    payoutTerms: agreementsRepo as any,
    feePolicies: feePoliciesRepo as any,
    promos: {} as any,
    splits: {} as any,
    payees: payeesRepo as any,
    payouts: {} as any,
    settlements: {} as any,
    settlementLines: {} as any,
    resaleListings: {} as any,
    claims: {} as any,
    idempotency: {} as any,
    audit: auditRepo as any,
    authz: authzRepo as any,
    apiKeys: {} as any,
    organizations: organizationsRepo as any,
    places: {} as any,
    savedLocations: {} as any,
    categories: categoriesRepo as any,
    categoryRequests: {} as any,
    tags: {} as any,
    eventTemplates: eventTemplatesRepo as any,
    eventHumans: eventHumansRepo as any,
    pushDevices: {} as any,
    notificationPrefs: {} as any,
    notificationDigests: {} as any,
    placeLayouts: {} as any,
    placeLayoutBlobs: {} as any,
    placeLayoutStatuses: {} as any,
    series: {
      getById: vi.fn(),
      findActiveByName: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      archive: vi.fn(),
      listByOwner: vi.fn(),
    } as any,
    seriesOccurrences: {
      getById: vi.fn(),
      listBySeries: vi.fn(),
      bulkUpsert: vi.fn(),
      attachEvent: vi.fn(),
      applyOverrides: vi.fn(),
      markStatus: vi.fn(),
      uniqueCheck: vi.fn(),
    } as any,
    analytics: {} as TxRepos["analytics"],
    contactImports: {} as TxRepos["contactImports"],
    pendingTicketTransfers: {} as TxRepos["pendingTicketTransfers"],
    pendingObjectDeletions: {} as TxRepos["pendingObjectDeletions"],
    humanDelegates: {} as TxRepos["humanDelegates"],
    images: {} as TxRepos["images"],
    eventUnlocks: {} as TxRepos["eventUnlocks"],
    eventInvites: {} as TxRepos["eventInvites"],
    audioUploads: {} as TxRepos["audioUploads"],
    placeVerificationRequests: {
      create: vi.fn(async () => ({})),
      getById: vi.fn(async () => null),
      getLatestForPlace: vi.fn(async () => null),
      listForPlace: vi.fn(async () => []),
      hasPendingForPlace: vi.fn(async () => false),
      updateDecision: vi.fn(async () => ({})),
    } as unknown as TxRepos["placeVerificationRequests"],
    placeVerificationDocuments: {
      createMany: vi.fn(async () => []),
      listByRequestId: vi.fn(async () => []),
      markDeleted: vi.fn(async () => 0),
      listStale: vi.fn(async () => []),
    } as unknown as TxRepos["placeVerificationDocuments"],
    announcements: {} as unknown as TxRepos["announcements"],
    resourceQuotas: {} as unknown as TxRepos["resourceQuotas"],
  };

  const repos: Repos = {
    ...txRepos,
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>, _options?: TxOptions) =>
      fn(txRepos),
  };

  const clock: ClockPort = {
    now: () => now,
  };

  const idempotency = createFakeIdempotencyPort({
    beginSequence: options.idempotencyBeginSequence,
  });
  const logger = createTestLogger();
  const guardedRepos = repos;

  const deps: UpsertAgreementDeps = {
    repos: guardedRepos,
    clock,
    idempotency,
    logger,
  };

  return {
    deps: {
      repos: guardedRepos,
      clock,
      idempotency,
      logger,
    },
    mocks: {
      agreements: agreementsRepo,
      events: eventsRepo,
      organizations: organizationsRepo,
      entityPages: entityPagesRepo,
      humans: humansRepo,
      payees: payeesRepo,
      feePolicies: feePoliciesRepo,
      categories: categoriesRepo,
      eventTemplates: eventTemplatesRepo,
      eventHumans: eventHumansRepo,
      audit: auditRepo,
      authz: authzRepo,
      logger,
      idempotency,
    },
    defaults: {
      now,
      eventId: event.id,
      orgId: organization.id,
      humanId: human.id,
      actorHumanId,
      payeeId: DEFAULT_PAYEE_ID,
      agreementId,
      feePolicyId: feePolicy.id,
    },
  } satisfies UpsertAgreementTestContext;
}

function resolveListByEvent(
  option: ListByEventOption,
  eventId: string,
): PayoutTermsRecord[] | null {
  if (!option) {
    return null;
  }

  if (Array.isArray(option)) {
    return option;
  }

  if (typeof option === "function") {
    return option(eventId);
  }

  return option[eventId] ?? [];
}
