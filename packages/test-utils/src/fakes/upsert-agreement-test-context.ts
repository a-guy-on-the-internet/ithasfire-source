import { vi } from "vitest";

import type { UpsertAgreementDeps } from "@th/core/use-cases/agreements";
import { buildOffsetPaginatedResult } from "@th/ports/pagination";
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
import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { Repos, TxOptions, TxRepos } from "@th/ports/repos";
import type {
  HumanRecord,
  HumansRepo,
  HumanWithIdentity,
  AuthIdentityRecord,
} from "@th/ports/repos/humans";
import type { OrganizationRecord } from "@th/ports/repos/organizations";

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
import {
  agreementsRepoPrototype,
  bookingAgreementsRepoPrototype,
  eventsRepoPrototype,
  organizationsRepoPrototype,
  humansRepoPrototype,
  entityPagesRepoPrototype,
  payeesRepoPrototype,
  feePoliciesRepoPrototype,
  auditRepoPrototype,
  authzRepoPrototype,
  categoriesRepoPrototype,
  eventTemplatesRepoPrototype,
  eventHumansRepoPrototype,
  imagesRepoPrototype,
  humanDelegatesRepoPrototype,
} from "./prototypes/repos";

type ListByEventOption =
  | PayoutTermsRecord[]
  | Record<string, PayoutTermsRecord[]>
  | ((eventId: string) => PayoutTermsRecord[])
  | null
  | undefined;

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
  /**
   * Two-party booking Agreement referencing a PayoutTerms id via
   * `payoutTermsId`. When set, the legacy engine's booking fence
   * (`getByPayoutTermsId`) sees those terms as booking-managed.
   */
  bookingAgreement?: AgreementRecord | null;
  idempotencyBeginSequence?: boolean[];
  now?: Date;
};

export type UpsertAgreementTestContext = {
  deps: UpsertAgreementDeps;
  mocks: {
    agreements: typeof agreementsRepoPrototype;
    bookingAgreements: typeof bookingAgreementsRepoPrototype;
    events: typeof eventsRepoPrototype;
    organizations: typeof organizationsRepoPrototype;
    entityPages: typeof entityPagesRepoPrototype;
    humans: typeof humansRepoPrototype;
    payees: typeof payeesRepoPrototype;
    feePolicies: typeof feePoliciesRepoPrototype;
    categories: typeof categoriesRepoPrototype;
    eventTemplates: typeof eventTemplatesRepoPrototype;
    eventHumans: typeof eventHumansRepoPrototype;
    images: typeof imagesRepoPrototype;
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
    settlementCurrency: string;
  };
};

const DEFAULT_EVENT_ID = "aaaa0000-0000-4000-8000-000000000001";
const DEFAULT_ORG_ID = "bbbb0000-0000-4000-8000-000000000002";
const DEFAULT_HUMAN_ID = "cccc0000-0000-4000-8000-000000000003";
const DEFAULT_ACTOR_ID = "dddd0000-0000-4000-8000-000000000004";
const DEFAULT_PAYEE_ID = "eeee0000-0000-4000-8000-000000000005";
const DEFAULT_AGREEMENT_ID = "ffff0000-0000-4000-8000-000000000006";
const DEFAULT_FEE_POLICY_ID = "99990000-0000-4000-8000-000000000099";
const DEFAULT_NOW = new Date("2024-03-15T12:00:00.000Z");
const DEFAULT_SETTLEMENT_CURRENCY = "usd" as const;

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
  maxPlatformFeeCents: null,
  payoutMinimumCents: 1000,
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
  visibility: "PRIVATE",
  gateType: "NONE",
  locationMode: "EXACT",
  locationRadiusMeters: null,
  locationLabel: null,
  addressRevealAt: null,
  addressRevealPreset: null,
  startsAt: new Date("2024-04-01T20:00:00.000Z"),
  endsAt: null,
  placeId: null,
  savedLocationId: null,
  categoryId: "category-rock",
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
  listingPriority: null,
  passwordHash: null,
  passwordUpdatedAt: null,
  waitlistStatus: "DISABLED",
  waitlistPublishAt: null,
  waitlistDescription: null,
  waitlistCap: null,
  placeLayoutId: null,
  currency: null,
};

const DEFAULT_ORG: OrganizationRecord = {
  id: DEFAULT_ORG_ID,
  name: "Default Org",
  slug: "default-org",
  status: "ACTIVE",
  defaultLocale: null,
};

const DEFAULT_HUMAN: HumanRecord = {
  id: DEFAULT_HUMAN_ID,
  name: "Pat Person",
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
  trustTier: "NEW",
  trustBadgeLabel: null,
  trustBadgeIcon: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

const DEFAULT_IDENTITY: AuthIdentityRecord = {
  authUserId: DEFAULT_HUMAN_ID, // Convenience: in tests, authUserId === humanId
  email: "human@example.com",
  emailVerified: false,
  phone: "+15555550123",
  phoneVerified: false,
  username: null,
  displayUsername: null,
  image: null,
};

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

type MutableState = {
  currentHuman: HumanRecord | null;
  currentIdentity: AuthIdentityRecord | null;
  currentEntityPage: EntityPageRecord | null;
  currentAgreement: PayoutTermsRecord | null;
  currentLines: PayoutTermsLineRecord[];
};

export function makeUpsertAgreementTestContext(
  options: MakeUpsertAgreementDepsOptions = {},
): UpsertAgreementTestContext {
  const now = options.now ?? DEFAULT_NOW;
  const agreementId = options.agreementId ?? DEFAULT_AGREEMENT_ID;
  const event = options.event ?? DEFAULT_EVENT;
  let currentEventRecord: EventRecord = { ...event };
  let slugHistoryRecords: Array<{ slug: string; recordedAt: Date }> = [];
  const organization = options.organization ?? DEFAULT_ORG;
  const actorHumanId =
    options.actorHumanId ?? options.membership?.humanId ?? DEFAULT_ACTOR_ID;
  const human = options.human ?? DEFAULT_HUMAN;
  const entityPageRecord = options.entityPage ?? DEFAULT_ENTITY_PAGE;
  const settlementCurrency =
    options.existingAgreement?.settlementCurrency ??
    DEFAULT_SETTLEMENT_CURRENCY;

  const state: MutableState = {
    currentHuman: human ? { ...human } : null,
    currentIdentity: human
      ? { ...DEFAULT_IDENTITY, authUserId: human.id }
      : null,
    currentEntityPage:
      entityPageRecord?.ownerId === human?.id ? { ...entityPageRecord } : null,
    currentAgreement: Object.prototype.hasOwnProperty.call(
      options,
      "existingAgreement",
    )
      ? options.existingAgreement
        ? {
            ...options.existingAgreement,
            settlementCurrency:
              options.existingAgreement.settlementCurrency ??
              DEFAULT_SETTLEMENT_CURRENCY,
          }
        : null
      : null,
    currentLines: options.existingLines
      ? options.existingLines.map((line) => ({ ...line }))
      : [],
  };

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
      if (state.currentAgreement && state.currentAgreement.id === id) {
        return state.currentAgreement;
      }
      return null;
    }),
    listByEvent: vi.fn(async (eventId: string) => {
      const custom = resolveListByEvent(options.agreementsForEvent, eventId);
      if (custom) {
        return custom;
      }
      if (state.currentAgreement && eventId === event.id) {
        return [state.currentAgreement];
      }
      return [];
    }),
    createDraft: vi.fn(async (input) => {
      state.currentAgreement = {
        id: agreementId,
        kind: input.kind,
        status: "PENDING",
        feeMode: null,
        feePolicyId: input.feePolicyId ?? null,
        isDefault: false,
        settlementCurrency: input.settlementCurrency,
        payoutSchedule: "WEEK_OF_EVENT",
        version: state.currentAgreement
          ? state.currentAgreement.version + 1
          : 1,
        createdAt: now,
        updatedAt: now,
      } satisfies PayoutTermsRecord;
      state.currentLines = [];
      return state.currentAgreement;
    }),
    updateDraft: vi.fn(async (input) => {
      if (
        !state.currentAgreement ||
        state.currentAgreement.id !== input.payoutTermsId
      ) {
        throw new Error("agreement not found");
      }
      state.currentAgreement = {
        ...state.currentAgreement,
        settlementCurrency: Object.prototype.hasOwnProperty.call(
          input,
          "settlementCurrency",
        )
          ? (input.settlementCurrency ??
            state.currentAgreement.settlementCurrency)
          : state.currentAgreement.settlementCurrency,
        feePolicyId: Object.prototype.hasOwnProperty.call(input, "feePolicyId")
          ? (input.feePolicyId ?? null)
          : state.currentAgreement.feePolicyId,
        updatedAt: now,
      } satisfies PayoutTermsRecord;
      return state.currentAgreement;
    }),
    replaceLines: vi.fn(async (id: string, lines: PayoutTermsLineInput[]) => {
      state.currentLines = lines.map(
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
      if (!state.currentAgreement || state.currentAgreement.id !== id) {
        return [];
      }
      return state.currentLines.map((line) => ({ ...line }));
    }),
    pinFeePolicy: vi.fn(async ({ payoutTermsId, feePolicyId }) => {
      if (
        !state.currentAgreement ||
        state.currentAgreement.id !== payoutTermsId
      ) {
        throw new Error("agreement not found");
      }
      state.currentAgreement = {
        ...state.currentAgreement,
        feePolicyId,
        updatedAt: now,
      };
      return state.currentAgreement;
    }),
  };

  const buildPaginatedEvents = (limit = 25, offset = 0) =>
    buildOffsetPaginatedResult({
      items: currentEventRecord ? [{ ...currentEventRecord }] : [],
      limit,
      offset,
      total: currentEventRecord ? 1 : 0,
    });

  const eventsRepo: typeof eventsRepoPrototype = {
    getById: vi.fn(async (id: string) => {
      if (currentEventRecord && currentEventRecord.id === id) {
        return { ...currentEventRecord };
      }
      return null;
    }),
    getBody: vi.fn(async () => null),
    getContent: vi.fn(async () => null),
    updateBody: vi.fn(async () => {}),
    updateContent: vi.fn(async () => {
      if (!currentEventRecord) {
        throw new Error("event not found");
      }
      return { ...currentEventRecord };
    }),
    listByEvent: vi.fn(),
    listTicketTypes: vi.fn(),
    ensureHostPermission: vi.fn(),
    upsertDraft: vi.fn(),
    publish: vi.fn(
      async ({
        eventId,
        publishedAt,
        currency,
      }: {
        eventId: string;
        publishedAt: Date;
        currency?: string;
      }) => {
        if (!currentEventRecord || currentEventRecord.id !== eventId) {
          throw new Error("event not found");
        }
        currentEventRecord = {
          ...currentEventRecord,
          status: "PUBLISHED",
          publishedAt,
          currency: currency ?? currentEventRecord.currency,
        };
        return { ...currentEventRecord };
      },
    ),
    setCategory: vi.fn(
      async ({
        eventId,
        categoryId,
      }: {
        eventId: string;
        categoryId: string | null;
      }) => {
        if (!currentEventRecord || currentEventRecord.id !== eventId) {
          throw new Error("event not found");
        }
        currentEventRecord = { ...currentEventRecord, categoryId };
        return { ...currentEventRecord };
      },
    ),
    filterByCategory: vi.fn(async ({ limit = 25, offset = 0 } = {}) =>
      buildPaginatedEvents(limit, offset),
    ),
    listPublishedByRegion: vi.fn(async ({ limit = 25, offset = 0 } = {}) =>
      buildPaginatedEvents(limit, offset),
    ),
    listPublished: vi.fn(async ({ limit = 100, offset = 0 } = {}) =>
      buildPaginatedEvents(limit, offset),
    ),
    getPopularityStats: vi.fn(async (eventIds: string[]) =>
      eventIds.map((eventId) => ({
        eventId,
        ticketsSold: 0,
        waitlistCount: 0,
        totalCapacity: 0,
      })),
    ),
    // `stewardship` honoured for the same reason as in `create-event-deps`:
    // the real adapter filters it in SQL before `take`, so a fake that ignored
    // it would be more permissive than production.
    listPublishedByPlace: vi.fn(
      async ({
        limit = 25,
        offset = 0,
        stewardship,
      }: {
        limit?: number;
        offset?: number;
        stewardship?: "OWNED" | "COMMUNITY";
      } = {}) =>
        stewardship !== undefined &&
        currentEventRecord?.stewardship !== stewardship
          ? buildOffsetPaginatedResult({
              items: [],
              limit,
              offset,
              total: 0,
            })
          : buildPaginatedEvents(limit, offset),
    ),
    listPublishedOccurrencesByPlace: vi.fn(async () => []),
    listPublishedByCountry: vi.fn(async ({ limit = 25, offset = 0 } = {}) =>
      buildPaginatedEvents(limit, offset),
    ),
    setListingPriority: vi.fn(
      async ({
        eventId,
        priority,
      }: {
        eventId: string;
        priority: number | null;
      }) => {
        if (!currentEventRecord || currentEventRecord.id !== eventId) {
          throw new Error("event not found");
        }
        currentEventRecord = {
          ...currentEventRecord,
          listingPriority: priority ?? null,
        };
        return { ...currentEventRecord };
      },
    ),
    searchPublished: vi.fn(async () =>
      currentEventRecord ? [{ ...currentEventRecord }] : [],
    ),
    listPublishedForSitemap: vi.fn(async () =>
      currentEventRecord?.slug
        ? [
            {
              slug: currentEventRecord.slug,
              updatedAt: currentEventRecord.updatedAt ?? null,
            },
          ]
        : [],
    ),
    updateVisibility: vi.fn(
      async ({
        eventId,
        visibility,
      }: {
        eventId: string;
        visibility: EventRecord["visibility"];
      }) => {
        if (!currentEventRecord || currentEventRecord.id !== eventId) {
          throw new Error("event not found");
        }
        currentEventRecord = { ...currentEventRecord, visibility };
        return { ...currentEventRecord };
      },
    ),
    updateGateType: vi.fn(
      async ({
        eventId,
        gateType,
      }: {
        eventId: string;
        gateType: EventRecord["gateType"];
      }) => {
        if (!currentEventRecord || currentEventRecord.id !== eventId) {
          throw new Error("event not found");
        }
        currentEventRecord = { ...currentEventRecord, gateType };
        return { ...currentEventRecord };
      },
    ),
    updatePassword: vi.fn(
      async ({
        eventId,
        passwordHash,
        passwordUpdatedAt,
      }: {
        eventId: string;
        passwordHash: string | null;
        passwordUpdatedAt: Date;
      }) => {
        if (!currentEventRecord || currentEventRecord.id !== eventId) {
          throw new Error("event not found");
        }
        currentEventRecord = {
          ...currentEventRecord,
          passwordHash,
          passwordUpdatedAt,
        };
        return { ...currentEventRecord };
      },
    ),
    updateWaitlistSettings: vi.fn(
      async ({
        eventId,
        status,
        publishAt,
        description,
        cap,
      }: {
        eventId: string;
        status: EventRecord["waitlistStatus"];
        publishAt?: Date | null;
        description?: string | null;
        cap?: number | null;
      }) => {
        if (!currentEventRecord || currentEventRecord.id !== eventId) {
          throw new Error("event not found");
        }
        currentEventRecord = {
          ...currentEventRecord,
          waitlistStatus: status,
          waitlistPublishAt: publishAt ?? null,
          waitlistDescription: description ?? null,
          waitlistCap: cap ?? null,
        };
        return { ...currentEventRecord };
      },
    ),
    getGateSettings: vi.fn(async (id: string) => {
      if (!currentEventRecord || currentEventRecord.id !== id) {
        return null;
      }
      return {
        eventId: currentEventRecord.id,
        visibility: currentEventRecord.visibility,
        gateType: currentEventRecord.gateType,
        passwordHash: currentEventRecord.passwordHash ?? null,
        passwordUpdatedAt: currentEventRecord.passwordUpdatedAt ?? null,
        waitlistStatus: currentEventRecord.waitlistStatus,
        waitlistPublishAt: currentEventRecord.waitlistPublishAt ?? null,
        waitlistDescription: currentEventRecord.waitlistDescription ?? null,
        waitlistCap: currentEventRecord.waitlistCap ?? null,
      };
    }),
    assignSlug: vi.fn(async ({ eventId, slug, shortId, regionCode }) => {
      if (!currentEventRecord || currentEventRecord.id !== eventId) {
        throw new Error("event not found");
      }
      currentEventRecord = { ...currentEventRecord, slug, shortId, regionCode };
      return { ...currentEventRecord };
    }),
    updateSlug: vi.fn(async ({ eventId, slug, regionCode }) => {
      if (!currentEventRecord || currentEventRecord.id !== eventId) {
        throw new Error("event not found");
      }
      currentEventRecord = { ...currentEventRecord, slug, regionCode };
      return { ...currentEventRecord };
    }),
    listSluggedPage: vi.fn(async ({ afterId, limit }) => {
      const ev = currentEventRecord;
      if (!ev?.slug || limit < 1) return [];
      if (afterId !== null && ev.id <= afterId) return [];
      return [
        {
          id: ev.id,
          slug: ev.slug,
          startsAt: ev.startsAt,
          timezone: ev.timezone,
          status: ev.status,
          createdAt: ev.createdAt ?? new Date(0),
        },
      ];
    }),
    getSlugDateRow: vi.fn(async (eventId: string) => {
      const ev = currentEventRecord;
      if (!ev?.slug || ev.id !== eventId) return null;
      return {
        id: ev.id,
        slug: ev.slug,
        startsAt: ev.startsAt,
        timezone: ev.timezone,
        status: ev.status,
        createdAt: ev.createdAt ?? new Date(0),
      };
    }),
    setSlugOnly: vi.fn(async ({ eventId, slug }) => {
      if (!currentEventRecord || currentEventRecord.id !== eventId) {
        throw new Error("event not found");
      }
      currentEventRecord = { ...currentEventRecord, slug };
    }),
    recordSlugHistory: vi.fn(async ({ eventId, slug, recordedAt }) => {
      if (!currentEventRecord || currentEventRecord.id !== eventId) {
        throw new Error("event not found");
      }
      slugHistoryRecords = [...slugHistoryRecords, { slug, recordedAt }];
    }),
    resolveBySlug: vi.fn(async ({ slug }) => {
      if (currentEventRecord?.slug === slug) {
        return {
          eventId: currentEventRecord.id,
          currentSlug: currentEventRecord.slug!,
          redirect: false,
        };
      }
      if (
        currentEventRecord &&
        slugHistoryRecords.some((record) => record.slug === slug)
      ) {
        return {
          eventId: currentEventRecord.id,
          currentSlug: currentEventRecord.slug!,
          redirect: true,
        };
      }
      return null;
    }),
    getSlugContext: vi.fn(async ({ eventId }) => {
      if (!currentEventRecord || currentEventRecord.id !== eventId) {
        return null;
      }
      return {
        eventId: currentEventRecord.id,
        orgId: currentEventRecord.orgId,
        humanId: currentEventRecord.humanId,
        eventTitle: currentEventRecord.title,
        startsAt: currentEventRecord.startsAt,
        timezone: currentEventRecord.timezone,
        orgName: organization?.name ?? null,
        countryCode: null,
        regionCode: currentEventRecord.regionCode,
        cityOrRegionCode: null,
        shortId: currentEventRecord.shortId,
      };
    }),
    linkSavedLocation: vi.fn(async () => {}),
    findByPayoutTermsId: vi.fn(async (payoutTermsId: string) => {
      if (
        currentEventRecord &&
        (currentEventRecord.payoutTermsId === payoutTermsId ||
          currentEventRecord.resalePayoutTermsId === payoutTermsId)
      ) {
        return { ...currentEventRecord };
      }
      return null;
    }),
    // freeze-the-deal: a line writer takes the row of the event its terms
    // belong to before the terms lock.
    lockRows: vi.fn(async () => undefined),
    findManyByIds: vi.fn(async (ids: string[]) => {
      if (currentEventRecord && ids.includes(currentEventRecord.id)) {
        return [{ ...currentEventRecord }];
      }
      return [];
    }),
    listAllByPlace: vi.fn(async () => []),
    listByOwner: vi.fn(async () => ({ items: [], total: 0 })),
    cancel: vi.fn(async () => {
      if (!currentEventRecord) throw new Error("event not found");
      currentEventRecord = {
        ...currentEventRecord,
        status: "CANCELLED" as EventRecord["status"],
      };
      return currentEventRecord;
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
      if (state.currentHuman && state.currentHuman.id === id) {
        return { ...state.currentHuman };
      }
      return null;
    }),
    getByIdWithIdentity: vi.fn(async (id: string) => {
      if (
        state.currentHuman &&
        state.currentHuman.id === id &&
        state.currentIdentity
      ) {
        return {
          human: { ...state.currentHuman },
          identity: { ...state.currentIdentity },
        };
      }
      return null;
    }),
    listEmailVerifiedIds: vi.fn(async (humanIds: readonly string[]) =>
      state.currentHuman &&
      state.currentIdentity?.emailVerified === true &&
      humanIds.includes(state.currentHuman.id)
        ? [state.currentHuman.id]
        : [],
    ),
    getAccountCreatedAt: vi.fn(async () => null),
    stampFirstSignInIfUnset: vi.fn(async () => undefined),
    getByEmail: vi.fn(async (email: string) => {
      if (
        state.currentIdentity &&
        state.currentIdentity.email.toLowerCase() === email.toLowerCase() &&
        state.currentHuman
      ) {
        return {
          human: { ...state.currentHuman },
          identity: { ...state.currentIdentity },
        };
      }
      return null;
    }),
    getByPhone: vi.fn(async (phone: string) => {
      if (
        state.currentIdentity &&
        state.currentIdentity.phone === phone &&
        state.currentHuman
      ) {
        return {
          human: { ...state.currentHuman },
          identity: { ...state.currentIdentity },
        };
      }
      return null;
    }),
    getByUsername: vi.fn(async () => null),
    getHumanIdForAuthUserId: vi.fn(async (authUserId: string) => {
      // In this test context we model auth-user-id == human.id for convenience.
      if (state.currentHuman && state.currentHuman.id === authUserId) {
        return { humanId: state.currentHuman.id };
      }
      return null;
    }),
    getAuthActorForAuthUserId: vi.fn(
      async (
        authUserId: string,
        opts?: { sessionId?: string; now?: Date },
      ) => {
        if (state.currentHuman && state.currentHuman.id === authUserId) {
          return {
            humanId: state.currentHuman.id,
            status: state.currentHuman.status,
            // This context models no sessions: a session-bound lookup is
            // treated as live; an unbound one reports null, like the adapter.
            sessionActive: opts?.sessionId ? true : null,
          };
        }
        return null;
      },
    ),
    linkAuthUserToHuman: vi.fn(
      async ({ humanId }: { authUserId: string; humanId: string }) => {
        return { humanId };
      },
    ),
    create: vi.fn(async (input) => {
      state.currentHuman = {
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
        trustTier: "NEW",
        trustBadgeLabel: null,
        trustBadgeIcon: null,
        createdAt: new Date(),
      } satisfies HumanRecord;
      return { ...state.currentHuman };
    }),
    update: vi.fn(async (id, updates) => {
      if (!state.currentHuman || state.currentHuman.id !== id) {
        throw new Error("human not found");
      }
      state.currentHuman = {
        ...state.currentHuman,
        ...updates,
        locale: Object.prototype.hasOwnProperty.call(updates, "locale")
          ? (updates.locale ?? null)
          : state.currentHuman.locale,
      } satisfies HumanRecord;
      return { ...state.currentHuman };
    }),
    ensureByProvider: vi.fn(async () => {
      return { humanId: DEFAULT_HUMAN_ID, created: false };
    }),
    ensureGuestHuman: vi.fn(async () => {
      return { humanId: DEFAULT_HUMAN_ID, created: false };
    }),
    listForSearchIndex: vi.fn(async ({ limit = 100, offset = 0 } = {}) =>
      buildOffsetPaginatedResult({
        items:
          state.currentHuman && state.currentEntityPage
            ? [{ human: state.currentHuman, page: state.currentEntityPage }]
            : [],
        limit,
        offset,
        total: state.currentHuman && state.currentEntityPage ? 1 : 0,
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
    batchLookupHumanIdsByEmail: vi.fn(async () => new Map<string, string>()),
    searchByQuery: vi.fn(async () => []),
    hasSecondFactorEnrolled: vi.fn(async () => false),
  } satisfies HumansRepo;

  const entityPagesRepo: typeof entityPagesRepoPrototype = {
    ...entityPagesRepoPrototype,
    getByOwner: vi.fn(async (ownerType: string, ownerId: string) => {
      if (
        state.currentEntityPage &&
        state.currentEntityPage.ownerType === ownerType &&
        state.currentEntityPage.ownerId === ownerId
      ) {
        return { ...state.currentEntityPage };
      }
      return null;
    }),
    upsert: vi.fn(async (input) => {
      state.currentEntityPage = { ...DEFAULT_ENTITY_PAGE, ...input };
      return { ...state.currentEntityPage };
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
    resolveEffective: vi.fn(),
    upsert: vi.fn(),
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
    deleteById: vi.fn(),
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
    linkHuman: vi.fn(),
  };

  const imagesRepo: typeof imagesRepoPrototype = {
    create: vi.fn(),
    getById: vi.fn(),
    resolveByIds: vi.fn(),
    markUploaded: vi.fn(),
    attach: vi.fn(),
    detach: vi.fn(),
    softDelete: vi.fn(),
    softDeleteIfUnfinalized: vi.fn(),
    listByOwner: vi.fn(),
      getPrimaryImageRefs: vi.fn(),
    listByEventId: vi.fn(),
    listSweepCandidates: vi.fn(),
    listSoftDeleted: vi.fn(),
    hardDelete: vi.fn(),
  };

  const auditRepo: typeof auditRepoPrototype = {
    log: vi.fn(async () => {}),
  };

  const bookingAgreementRecord = options.bookingAgreement ?? null;
  const bookingAgreementsRepo: typeof bookingAgreementsRepoPrototype = {
    getById: vi.fn(async (id: string) =>
      bookingAgreementRecord && bookingAgreementRecord.id === id
        ? { ...bookingAgreementRecord }
        : null,
    ),
    getByEventId: vi.fn(async (eventId: string) =>
      bookingAgreementRecord && bookingAgreementRecord.eventId === eventId
        ? { ...bookingAgreementRecord }
        : null,
    ),
    getByPayoutTermsId: vi.fn(async (payoutTermsId: string) =>
      bookingAgreementRecord &&
      bookingAgreementRecord.payoutTermsId === payoutTermsId
        ? { ...bookingAgreementRecord }
        : null,
    ),
    create: vi.fn(),
    updateHeader: vi.fn(),
    listByParty: vi.fn(async () => []),
    updateStatus: vi.fn(),
  };

  const authzRepo: typeof authzRepoPrototype = {
    getOrgMembership: vi.fn(async () => resolveMembership()),
    getEventOrgId: vi.fn(),
    getEventHumanId: vi.fn(async () => null),
    getPlaceAccessContext: vi.fn(),
    isPlaceVerifiedForOrg: vi.fn(),
    getHumanDelegation: vi.fn(async () => null),
  };

  const txRepos: TxRepos = {
    // ── P4b (deal terms) ── the terms row lock every line writer takes.
    deals: { lockTerms: vi.fn(async () => true) } as unknown as TxRepos["deals"],
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
    orderItems: {
      markItemsPaidOut: vi.fn(async () => {}),
      updateStatus: vi.fn(async () => {}),
      listByOrderId: vi.fn(async () => []),
      getById: vi.fn(async () => null),
    } as any,
    orderItemSettlementLines: {
      addDraft: vi.fn(async () => {}),
      listBySettlementLineId: vi.fn(async () => []),
      listByOrderItemId: vi.fn(async () => []),
      listByOrderItemIds: vi.fn(async () => []),
    } as any,
    tickets: {} as any,
    seats: {} as any,
    payoutTerms: agreementsRepo as any,
    agreements: bookingAgreementsRepo as any,
    feePolicies: feePoliciesRepo as any,
    promos: {} as any,
    splits: {} as any,
    payees: payeesRepo as any,
    settlements: {} as any,
    settlementLines: {} as any,
    payouts: {} as any,
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
    notifications: undefined as unknown as TxRepos["notifications"],
    placeLayouts: {
      getByPlace: vi.fn(),
      replaceWithSnapshot: vi.fn(),
      deleteForPlace: vi.fn(),
    } as any,
    placeLayoutBlobs: {
      putForPlace: vi.fn(),
      getGlyphUrl: vi.fn(),
      deleteForPlace: vi.fn(),
    } as any,
    placeLayoutStatuses: {
      upsertStatuses: vi.fn(),
      deleteByPlace: vi.fn(),
    } as any,
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
    images: {} as any,
    eventUnlocks: {
      upsert: vi.fn(async () => ({})),
      isUnlocked: vi.fn(async () => false),
      get: vi.fn(async () => null),
      revoke: vi.fn(async () => null),
      listByEventId: vi.fn(async () => []),
      listByHumanId: vi.fn(async () => []),
    } as any,
    eventInvites: {
      create: vi.fn(async () => ({})),
      getById: vi.fn(async () => null),
      getByTokenHash: vi.fn(async () => null),
      getLiveShared: vi.fn(async () => null),
      listByEvent: vi.fn(async () => []),
      findLivePersonalByEmail: vi.fn(async () => null),
      revoke: vi.fn(async () => null),
      recordRedemption: vi.fn(async () => null),
      lockIfLive: vi.fn(async () => true),
      rotateShared: vi.fn(),
      markSent: vi.fn(async () => null),
    } as any,
    audioUploads: {
      create: vi.fn(async () => ({})),
      getById: vi.fn(async () => null),
      resolveByIds: vi.fn(async () => []),
      markUploaded: vi.fn(async () => null),
      markTranscoding: vi.fn(async () => null),
      markTranscoded: vi.fn(async () => null),
      markFailed: vi.fn(async () => null),
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      softDelete: vi.fn(async () => {}),
      listByEventId: vi.fn(async () => []),
      listPendingTranscode: vi.fn(async () => []),
    } as any,
    analytics: {} as TxRepos["analytics"],
    contactImports: {} as TxRepos["contactImports"],
    pendingTicketTransfers: {} as TxRepos["pendingTicketTransfers"],
    pendingObjectDeletions: {} as TxRepos["pendingObjectDeletions"],
    humanDelegates: {
      ...humanDelegatesRepoPrototype,
    } as TxRepos["humanDelegates"],
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
    embeds: {} as any,
    platformSettings: {} as any,
    payoutItems: {} as any,
    placeWaivers: {} as any,
    announcements: {} as any,
    resourceQuotas: {} as any,
    eventTypes: {} as any,
    waiverTemplates: {} as any,
    waiverAcceptances: {} as any,
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
    deps,
    mocks: {
      agreements: agreementsRepo,
      bookingAgreements: bookingAgreementsRepo,
      events: eventsRepo,
      organizations: organizationsRepo,
      entityPages: entityPagesRepo,
      humans: humansRepo,
      payees: payeesRepo,
      feePolicies: feePoliciesRepo,
      categories: categoriesRepo,
      eventTemplates: eventTemplatesRepo,
      eventHumans: eventHumansRepo,
      images: imagesRepo,
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
      settlementCurrency,
    },
  };
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
