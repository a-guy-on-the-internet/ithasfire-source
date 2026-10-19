import { describe, expect, it, vi } from "vitest";

import { publishEvent } from "../publish-event";
import { assignTicketTypeSections } from "../assign-ticket-type-sections";
import type { PublishEventDeps, PublishEventInput } from "../publish-event";
import { buildOffsetPaginatedResult } from "@th/ports";
import type {
  CreateEventAttestationInput,
  EventAttestationRecord,
  EventRecord,
  EventTicketTypeSummary,
} from "@th/ports/repos/events";
import type {
  PayoutTermsRecord,
  PayoutTermsLineRecord,
} from "@th/ports/repos/payout-terms";
import type { FeePolicyRecord } from "@th/ports/repos/fee-policies";
import type { OrgRole } from "@th/ports/repos/authz";
import type { HumanRecord } from "@th/ports/repos/humans";
import type { OrganizationRecord } from "@th/ports/repos/organizations";
import type { PayeeRecord } from "@th/ports/repos/payees";
import type { SeatSectionPriceOverride } from "@th/ports/repos/seats";
import type { Repos, TxRepos } from "@th/ports/repos";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createTestLogger } from "@th/test-utils/fakes/logger";
import { createFakeBookingRequestMessagesRepo } from "@th/test-utils/fakes/venue-hierarchy";
import { createFakeBookingHoldsRepo } from "../../booking-holds/__tests__/fakes";
import { CURRENT_CHARGEBACK_TERMS_VERSION } from "../../../lib/payments/chargeback-terms";

/**
 * A version the owner accepted before the current one. Publish is a
 * version-agnostic backstop: the strict current-version gate lives at Stripe
 * Connect onboarding, so a stale acceptance must still publish.
 */
const STALE_CHARGEBACK_TERMS_VERSION = "2000-01-01";
import {
  HOST_ATTESTATION_FIELDS,
  HOST_ATTESTATION_TEXT,
  HOST_ATTESTATION_VERSION,
} from "../host-attestation-text";

const DEFAULT_EVENT_ID = "00000000-0000-4000-8000-000000000001";
const DEFAULT_ORG_ID = "00000000-0000-4000-8000-000000000002";
const DEFAULT_ACTOR_ID = "00000000-0000-4000-8000-000000000003";
const DEFAULT_CLIENT_KEY = "publish-123456";
const DEFAULT_AGREEMENT_ID = "00000000-0000-4000-8000-000000000004";
const DEFAULT_FEE_POLICY_ID = "00000000-0000-4000-8000-000000000005";
const DEFAULT_CATEGORY_ID = "00000000-0000-4000-8000-000000000006";
const DEFAULT_ORG_NAME = "Acme Org";
const DEFAULT_IP_ADDRESS = "203.0.113.10";
const DEFAULT_USER_AGENT = "vitest/host-attestation";
const DEFAULT_ATTESTATION = {
  legalRightToHost: true,
  zoningAndNoiseCompliance: true,
  alcoholCompliance: true,
  taxResponsibility: true,
  organizerFaqReviewed: true,
} satisfies NonNullable<PublishEventInput["attestation"]>;

interface MakeContextOptions {
  event?: Partial<EventRecord> | null;
  membershipRole?: OrgRole | null;
  ticketTypes?: EventTicketTypeSummary[];
  issuedTickets?: number;
  agreements?: PayoutTermsRecord[];
  agreementLines?: Record<string, PayoutTermsLineRecord[]>;
  resolvedPolicies?: Partial<
    Record<"EVENT" | "ORG" | "GLOBAL", FeePolicyRecord | null>
  >;
  existingFeePolicy?: FeePolicyRecord | null;
  idempotencyBeginSequence?: boolean[];
  /** Payee record to return for the org/human subject. Set to `null` to simulate missing Stripe. */
  payee?: Partial<PayeeRecord> | null;
  /**
   * Payees resolvable via `payees.getByIds` for the splits-flow Gate 2 check.
   * Keyed by payee id; any id requested but not listed here defaults to an
   * ACTIVE payee with `payoutsEnabled: true`, so existing tests are unaffected.
   */
  linePayees?: PayeeRecord[];
  /**
   * `true` = accepted the CURRENT version; `"stale"` = accepted an older
   * version; `false` = never accepted.
   */
  chargebackTermsAccepted?: boolean | "stale";
  /** Seed the owner entity's existing default primary payout terms FK. */
  ownerDefaultPrimaryPayoutTermsId?: string | null;
  /** Best-effort Sentry reporter wired into `PublishEventDeps.reportError`. */
  reportError?: PublishEventDeps["reportError"];
  /** The row `places.getById` returns (W1 publish stamp). Default: none. */
  place?: import("@th/ports/repos/places").PlaceRecord | null;
  /** Whether the publisher passes `canManagePlace`. Default: false. */
  canManagePlace?: boolean;
  /** What `seats.listDistinctPriceOverridesByEvent` returns. Default: none. */
  seatOverrides?: SeatSectionPriceOverride[];
}

interface PublishEventTestContext {
  deps: PublishEventDeps;
  defaults: {
    eventId: string;
    actorHumanId: string;
    clientKey: string;
    now: Date;
    agreementId: string;
    feePolicy: FeePolicyRecord;
  };
  mocks: {
    events: ReturnType<typeof buildEventsRepoMock>;
    tickets: ReturnType<typeof buildTicketsRepoMock>;
    agreements: ReturnType<typeof buildAgreementsRepoMock>;
    feePolicies: ReturnType<typeof buildFeePoliciesRepoMock>;
    authz: ReturnType<typeof buildAuthzRepoMock>;
    audit: ReturnType<typeof buildAuditRepoMock>;
    organizations: ReturnType<typeof buildOrganizationsRepoMock>;
    humans: ReturnType<typeof buildHumansRepoMock>;
    idempotency: ReturnType<typeof createFakeIdempotencyPort>;
    canManagePlace: ReturnType<typeof vi.fn>;
    listDistinctPriceOverridesByEvent: ReturnType<typeof vi.fn>;
    /** `tx.deals.lockTerms` (freeze-the-deal: the terms row locks). */
    dealsLockTerms: ReturnType<typeof vi.fn>;
  };
}

function makeContext(
  options: MakeContextOptions = {},
): PublishEventTestContext {
  const now = new Date("2025-01-01T00:00:00.000Z");
  const actorHumanId = DEFAULT_ACTOR_ID;
  const eventTemplate: EventRecord = {
    id: DEFAULT_EVENT_ID,
    orgId: DEFAULT_ORG_ID,
    humanId: null,
    title: "Launch Party",
    status: "DRAFT",
    visibility: "PRIVATE",
    gateType: "NONE",
    locationMode: "OBSCURED",
    locationRadiusMeters: null,
    locationLabel: null,
    addressRevealAt: null,
    addressRevealPreset: null,
    startsAt: new Date("2025-02-01T20:00:00.000Z"),
    endsAt: new Date("2025-02-01T20:00:00.000Z"),
    placeId: null,
    savedLocationId: null,
    categoryId: DEFAULT_CATEGORY_ID,
    addressText: "123 Test Street, Nashville, TN",
    lat: null,
    lng: null,
    slug: null,
    shortId: null,
    regionCode: null,
    publishedAt: null,
    currentAttestationId: null,
    agreementPrimaryId: DEFAULT_AGREEMENT_ID,
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
    currency: null,
  };

  const baseEvent =
    options.event === null
      ? null
      : { ...eventTemplate, ...(options.event ?? {}) };
  if (baseEvent && typeof baseEvent.categoryId === "undefined") {
    baseEvent.categoryId = DEFAULT_CATEGORY_ID;
  }
  const ticketTypes = options.ticketTypes ?? [buildTicketType({})];
  const issuedTickets = options.issuedTickets ?? 0;
  const payee = Object.prototype.hasOwnProperty.call(options, "payee")
    ? options.payee === null
      ? null
      : buildPayee(options.payee ?? {})
    : buildPayee({});
  const payeesRepo = buildPayeesRepoMock(payee, options.linePayees ?? []);
  const chargebackTermsAccepted = options.chargebackTermsAccepted ?? true;
  const ownerDefaultPrimaryPayoutTermsId =
    options.ownerDefaultPrimaryPayoutTermsId ?? null;
  const organizationsRepo = buildOrganizationsRepoMock(
    chargebackTermsAccepted,
    ownerDefaultPrimaryPayoutTermsId,
  );
  const humansRepo = buildHumansRepoMock(
    chargebackTermsAccepted,
    ownerDefaultPrimaryPayoutTermsId,
  );
  const feePolicy =
    options.existingFeePolicy ??
    buildFeePolicy({ scopeType: "EVENT", scopeId: baseEvent?.id ?? null });
  const agreements = options.agreements ?? [buildAgreement({})];

  const agreementLinesMap = new Map<string, PayoutTermsLineRecord[]>();
  const lineTemplate = buildAgreementLine({
    agreementId: agreements[0]?.id ?? DEFAULT_AGREEMENT_ID,
  });
  agreementLinesMap.set(lineTemplate.agreementId, [lineTemplate]);

  if (options.agreementLines) {
    for (const [agreementId, lines] of Object.entries(options.agreementLines)) {
      agreementLinesMap.set(agreementId, lines);
    }
  }

  let currentEvent = baseEvent ? { ...baseEvent } : null;
  const eventsRepo = buildEventsRepoMock(
    () => currentEvent,
    (next) => {
      currentEvent = next;
    },
    ticketTypes,
    now,
  );
  const ticketsRepo = buildTicketsRepoMock(issuedTickets);
  const agreementsRepo = buildAgreementsRepoMock(
    agreements,
    agreementLinesMap,
    now,
  );
  const dealsLockTerms = vi.fn(async (id: string) =>
    agreements.some((a) => a.id === id),
  );
  const feePoliciesRepo = buildFeePoliciesRepoMock(
    feePolicy,
    options.resolvedPolicies ?? {},
  );
  const membershipRole: OrgRole | null = Object.prototype.hasOwnProperty.call(
    options,
    "membershipRole",
  )
    ? (options.membershipRole ?? null)
    : "ADMIN";
  const authzRepo = buildAuthzRepoMock(membershipRole);
  const auditRepo = buildAuditRepoMock();
  const listDistinctPriceOverridesByEvent = vi.fn(
    async (_input: { eventId: string }) => options.seatOverrides ?? [],
  );

  // Wire `events.linkPayoutTerms` to the agreements fake so a provisioned
  // PRIMARY becomes resolvable via `listByEvent` on the publish re-resolve.
  eventsRepo.linkPayoutTerms.mockImplementation(
    async ({ payoutTermsId }: { payoutTermsId: string }) => {
      agreementsRepo.__link(payoutTermsId);
    },
  );

  if (currentEvent) {
    eventsRepo.publish.mockImplementation(async ({ eventId, publishedAt }) => {
      if (!currentEvent || currentEvent.id !== eventId) {
        throw new Error("event not found");
      }
      currentEvent = { ...currentEvent, status: "PUBLISHED", publishedAt };
      return currentEvent;
    });

    eventsRepo.getById.mockImplementation(async (id: string) => {
      if (!currentEvent || currentEvent.id !== id) {
        return null;
      }
      return { ...currentEvent };
    });

    // Like the adapter: stamp + bind + clear withdrawal, and record the
    // row's own start as the confirmed one (N1).
    (eventsRepo as Record<string, unknown>).setVenueConfirmation = vi.fn(
      async (input: {
        eventId: string;
        placeId: string;
        confirmedByHumanId: string;
        bookingRequestId: string | null;
        at: Date;
      }) => {
        if (!currentEvent || currentEvent.placeId !== input.placeId) {
          throw { code: "event_place_mismatch" };
        }
        currentEvent = {
          ...currentEvent,
          venueConfirmedAt: input.at,
          venueConfirmedByHumanId: input.confirmedByHumanId,
          venueConfirmedPlaceId: input.placeId,
          venueConfirmationRequestId: input.bookingRequestId,
          venueConfirmationWithdrawnAt: null,
          venueConfirmationWithdrawnReason: null,
          venueConfirmedStartsAt: currentEvent.startsAt,
        };
        return { ...currentEvent };
      },
    );
  } else {
    eventsRepo.publish.mockImplementation(async () => {
      throw new Error("event not found");
    });
    eventsRepo.getById.mockResolvedValue(null);
  }

  const txRepos: TxRepos = {
    events: eventsRepo as unknown as TxRepos["events"],
    featuredEvents: {} as TxRepos["featuredEvents"],
    eventApplications: {} as TxRepos["eventApplications"],
    eventWaitlists: {} as TxRepos["eventWaitlists"],
    inviteLists: {} as TxRepos["inviteLists"],
    tickets: ticketsRepo as unknown as TxRepos["tickets"],
    seats: { listDistinctPriceOverridesByEvent } as any,
    agreements: agreementsRepo as unknown as TxRepos["agreements"],
    payoutTerms: agreementsRepo as unknown as TxRepos["payoutTerms"],
    // The resale-clause gate reads the RESALE terms under their lock.
    deals: {
      lockTerms: dealsLockTerms,
      // freeze-the-deal FR-002: the adapter's guarded UPDATE (only while
      // `dealFrozenAt IS NULL`).
      freezeEventDealIfUnfrozen: vi.fn(
        async (input: { eventId: string; frozenAt: Date; frozenByHumanId: string | null }) => {
          if (!currentEvent || currentEvent.id !== input.eventId) return false;
          if (currentEvent.dealFrozenAt) return false;
          currentEvent = {
            ...currentEvent,
            dealFrozenAt: input.frozenAt,
            dealFrozenByHumanId: input.frozenByHumanId,
          };
          return true;
        },
      ),
    } as unknown as TxRepos["deals"],
    feePolicies: feePoliciesRepo as unknown as TxRepos["feePolicies"],
    audit: auditRepo as unknown as TxRepos["audit"],
    authz: authzRepo as unknown as TxRepos["authz"],
    categories: {
      listActive: vi.fn(),
      getBySlug: vi.fn(),
      getById: vi.fn(),
      upsertSeed: vi.fn(),
    } as any,
    eventTemplates: {
      listActive: vi.fn(),
      getBySlug: vi.fn(),
      getById: vi.fn(),
      upsertSeed: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    } as any,
    eventHumans: {} as any,
    entityPages: {getByOwner: vi.fn(async () => null)} as any,
    entityEventNotices: {enqueue: vi.fn()} as any,
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
    humans: humansRepo as unknown as TxRepos["humans"],
    orders: {} as any,
    splits: {} as any,
    payees: payeesRepo as unknown as TxRepos["payees"],
    settlements: {} as any,
    resaleListings: {} as any,
    idempotency: {} as any,
    apiKeys: {} as any,
    organizations: organizationsRepo as unknown as TxRepos["organizations"],
    places: {
      getById: vi.fn(async () => options.place ?? null),
      updateTaxRate: vi.fn(async () => {}),
    } as any,
    savedLocations: {} as any,
    pushDevices: {} as any,
    notificationPrefs: {} as any,
    notificationDigests: {} as any,
    notifications: {} as TxRepos["notifications"],
    placeLayouts: {} as any,
    placeLayoutBlobs: {} as any,
    placeLayoutStatuses: {} as any,
    orderItems: {} as any,
    orderItemSettlementLines: {} as any,
    settlementLines: {} as any,
    payouts: {} as any,
  };

  const repos: Repos = {
    ...txRepos,
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos),
  };

  const idempotency = createFakeIdempotencyPort({
    beginSequence: options.idempotencyBeginSequence,
  });
  const logger = createTestLogger();

  const canManagePlace = vi.fn(async () => ({
    allowed: options.canManagePlace === true,
  }));
  const deps: PublishEventDeps = {
    repos,
    idempotency,
    clock: { now: () => now },
    logger,
    reportError: options.reportError,
    authz: { canManagePlace },
  };

  return {
    deps,
    defaults: {
      eventId: baseEvent?.id ?? DEFAULT_EVENT_ID,
      actorHumanId: actorHumanId,
      clientKey: DEFAULT_CLIENT_KEY,
      now,
      agreementId: agreements[0]?.id ?? DEFAULT_AGREEMENT_ID,
      feePolicy,
    },
    mocks: {
      events: eventsRepo,
      tickets: ticketsRepo,
      agreements: agreementsRepo,
      feePolicies: feePoliciesRepo,
      authz: authzRepo,
      audit: auditRepo,
      organizations: organizationsRepo,
      humans: humansRepo,
      idempotency,
      canManagePlace,
      listDistinctPriceOverridesByEvent,
      dealsLockTerms,
    },
  } satisfies PublishEventTestContext;
}

function buildPublishInput(
  ctx: PublishEventTestContext,
  overrides: Partial<PublishEventInput> = {},
): PublishEventInput {
  return {
    actorHumanId: ctx.defaults.actorHumanId,
    eventId: ctx.defaults.eventId,
    clientKey: ctx.defaults.clientKey,
    ipAddress: DEFAULT_IP_ADDRESS,
    userAgent: DEFAULT_USER_AGENT,
    attestation: { ...DEFAULT_ATTESTATION },
    ...overrides,
  };
}

function buildOrganizationsRepoMock(
  chargebackTermsAccepted: boolean | "stale",
  defaultPrimaryPayoutTermsId: string | null = null,
): Pick<
  TxRepos["organizations"],
  | "getById"
  | "acceptChargebackTerms"
  | "update"
  | "setDefaultPrimaryPayoutTermsIdIfNull"
> {
  const organization: OrganizationRecord = {
    id: DEFAULT_ORG_ID,
    name: DEFAULT_ORG_NAME,
    slug: "acme-org",
    status: "ACTIVE",
    defaultLocale: null,
    contactEmail: null,
    physicalAddress: null,
    defaultPrimaryPayoutTermsId,
    defaultResalePayoutTermsId: null,
    trustTier: "NEW",
    trustBadgeLabel: null,
    trustBadgeIcon: null,
    chargebackTermsVersion:
      chargebackTermsAccepted === "stale"
        ? STALE_CHARGEBACK_TERMS_VERSION
        : chargebackTermsAccepted
          ? CURRENT_CHARGEBACK_TERMS_VERSION
          : null,
    chargebackTermsAcceptedAt: chargebackTermsAccepted
      ? new Date("2024-12-15T00:00:00.000Z")
      : null,
    chargebackTermsAcceptedByHumanId: chargebackTermsAccepted
      ? DEFAULT_ACTOR_ID
      : null,
    createdAt: new Date("2024-12-01T00:00:00.000Z"),
  };

  return {
    getById: vi.fn(async (id: string) =>
      id === DEFAULT_ORG_ID ? { ...organization } : null,
    ),
    acceptChargebackTerms: vi.fn(async () => ({ ...organization })),
    update: vi.fn(async (input) => {
      if (input.defaultPrimaryPayoutTermsId !== undefined) {
        organization.defaultPrimaryPayoutTermsId =
          input.defaultPrimaryPayoutTermsId;
      }
      return { ...organization };
    }),
    setDefaultPrimaryPayoutTermsIdIfNull: vi.fn(
      async (input: { id: string; payoutTermsId: string }) => {
        if (organization.defaultPrimaryPayoutTermsId !== null) {
          return false;
        }
        organization.defaultPrimaryPayoutTermsId = input.payoutTermsId;
        return true;
      },
    ),
  };
}

function buildHumansRepoMock(
  chargebackTermsAccepted: boolean | "stale",
  defaultPrimaryPayoutTermsId: string | null = null,
): Pick<
  TxRepos["humans"],
  | "getById"
  | "acceptChargebackTerms"
  | "update"
  | "setDefaultPrimaryPayoutTermsIdIfNull"
> {
  const human: HumanRecord = {
    id: DEFAULT_ACTOR_ID,
    name: "Host Human",
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
    defaultPrimaryPayoutTermsId,
    defaultResalePayoutTermsId: null,
    trustTier: "NEW",
    trustBadgeLabel: null,
    trustBadgeIcon: null,
    chargebackTermsVersion:
      chargebackTermsAccepted === "stale"
        ? STALE_CHARGEBACK_TERMS_VERSION
        : chargebackTermsAccepted
          ? CURRENT_CHARGEBACK_TERMS_VERSION
          : null,
    chargebackTermsAcceptedAt: chargebackTermsAccepted
      ? new Date("2024-12-15T00:00:00.000Z")
      : null,
    jobs: [],
    genreTags: [],
    otherJobDescription: null,
    createdAt: new Date("2024-12-01T00:00:00.000Z"),
  };

  return {
    getById: vi.fn(async (id: string) =>
      id === DEFAULT_ACTOR_ID ? { ...human } : null,
    ),
    acceptChargebackTerms: vi.fn(async () => ({ ...human })),
    update: vi.fn(async (_id: string, updates) => {
      if (updates.defaultPrimaryPayoutTermsId !== undefined) {
        human.defaultPrimaryPayoutTermsId = updates.defaultPrimaryPayoutTermsId;
      }
      return { ...human };
    }),
    setDefaultPrimaryPayoutTermsIdIfNull: vi.fn(
      async (input: { id: string; payoutTermsId: string }) => {
        if (human.defaultPrimaryPayoutTermsId !== null) {
          return false;
        }
        human.defaultPrimaryPayoutTermsId = input.payoutTermsId;
        return true;
      },
    ),
  };
}

function buildEventsRepoMock(
  getEvent: () => EventRecord | null,
  setEvent: (next: EventRecord | null) => void,
  ticketTypes: EventTicketTypeSummary[],
  now: Date,
) {
  const createAttestation = vi.fn(
    async (
      input: CreateEventAttestationInput,
    ): Promise<EventAttestationRecord> => ({
      id: `attestation-${createAttestation.mock.calls.length}`,
      eventId: input.eventId,
      attestedByHumanId: input.attestedByHumanId,
      attestedAt: input.attestedAt,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      policyVersion: input.policyVersion,
      policyTextSnapshot: input.policyTextSnapshot,
      legalRightToHost: input.legalRightToHost,
      zoningAndNoiseCompliance: input.zoningAndNoiseCompliance,
      alcoholCompliance: input.alcoholCompliance,
      taxResponsibility: input.taxResponsibility,
      organizerFaqReviewed: input.organizerFaqReviewed,
      metadata: input.metadata ?? null,
      createdAt: input.attestedAt,
    }),
  );

  return {
    getById: vi.fn(async (eventId: string) => {
      const event = getEvent();
      if (!event || event.id !== eventId) {
        return null;
      }
      return { ...event };
    }),
    // Publish takes the shared place-location lock for a place-backed event
    // before its tax stamp re-reads the venue.
    lockLocationsAtPlace: vi.fn(async () => undefined),
    // ...and then row-locks the event (FOR UPDATE) and re-reads it, so the
    // venue it stamps from is the one the event points at when it commits.
    lockRows: vi.fn(async (_input: { ids: string[]; mode: "share" | "update" }) => undefined),
    listTicketTypes: vi.fn(async (eventId: string) => {
      const event = getEvent();
      if (!event || event.id !== eventId) return [];
      return ticketTypes.map((tt) => ({ ...tt }));
    }),
    ensureHostPermission: vi.fn(async () => true),
    createAttestation,
    publish: vi.fn(
      async ({
        eventId,
        publishedAt,
        currentAttestationId,
      }: {
        eventId: string;
        publishedAt: Date;
        currentAttestationId?: string | null;
      }) => {
        const current = getEvent();
        if (!current || current.id !== eventId) {
          throw new Error("event not found");
        }
        const updated: EventRecord = {
          ...current,
          status: "PUBLISHED",
          publishedAt,
          currentAttestationId:
            currentAttestationId ?? current.currentAttestationId ?? null,
        };
        setEvent(updated);
        return { ...updated };
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
        const current = getEvent();
        if (!current || current.id !== eventId) {
          throw new Error("event not found");
        }
        const updated: EventRecord = {
          ...current,
          categoryId,
        };
        setEvent(updated);
        return { ...updated };
      },
    ),
    setListingPriority: vi.fn(
      async ({
        eventId,
        listingPriority,
      }: {
        eventId: string;
        listingPriority: number | null;
      }) => {
        const current = getEvent();
        if (!current || current.id !== eventId) {
          throw new Error("event not found");
        }
        const updated: EventRecord = {
          ...current,
          listingPriority,
        };
        setEvent(updated);
        return { ...updated };
      },
    ),
    filterByCategory: vi.fn(async () =>
      buildOffsetPaginatedResult({ items: [], total: 0, limit: 1, offset: 0 }),
    ),
    listPublishedByRegion: vi.fn(async () =>
      buildOffsetPaginatedResult({ items: [], total: 0, limit: 1, offset: 0 }),
    ),
    searchPublished: vi.fn(async () => []),
    listPublishedForSitemap: vi.fn(async () => {
      const current = getEvent();
      return current?.slug
        ? [{ slug: current.slug, updatedAt: current.updatedAt ?? null }]
        : [];
    }),
    updateVisibility: vi.fn(async () => {
      const current = getEvent();
      if (!current) throw new Error("event not found");
      return { ...current };
    }),
    updateGateType: vi.fn(async () => {
      const current = getEvent();
      if (!current) throw new Error("event not found");
      return { ...current };
    }),
    updatePassword: vi.fn(async () => {
      const current = getEvent();
      if (!current) throw new Error("event not found");
      return { ...current };
    }),
    updateWaitlistSettings: vi.fn(async () => {
      const current = getEvent();
      if (!current) throw new Error("event not found");
      return { ...current };
    }),
    getGateSettings: vi.fn(async () => {
      const current = getEvent();
      if (!current) return null;
      return {
        eventId: current.id,
        visibility: current.visibility,
        gateType: current.gateType,
        passwordHash: current.passwordHash,
        passwordUpdatedAt: current.passwordUpdatedAt,
        waitlistStatus: current.waitlistStatus,
        waitlistPublishAt: current.waitlistPublishAt,
        waitlistDescription: current.waitlistDescription,
        waitlistCap: current.waitlistCap,
      };
    }),
    upsertDraft: vi.fn(),
    assignSlug: vi.fn(
      async ({
        eventId,
        slug,
        shortId,
        regionCode,
      }: {
        eventId: string;
        slug: string;
        shortId: string;
        regionCode: string | null;
        assignedAt: Date;
      }) => {
        const current = getEvent();
        if (!current || current.id !== eventId) {
          throw new Error("event not found");
        }
        const updated: EventRecord = {
          ...current,
          slug,
          shortId,
          regionCode,
          publishedAt: current.publishedAt ?? now,
        };
        setEvent(updated);
        return { ...updated };
      },
    ),
    updateSlug: vi.fn(
      async ({
        eventId,
        slug,
        regionCode,
      }: {
        eventId: string;
        slug: string;
        regionCode: string | null;
        updatedAt: Date;
      }) => {
        const current = getEvent();
        if (!current || current.id !== eventId) {
          throw new Error("event not found");
        }
        const updated: EventRecord = {
          ...current,
          slug,
          regionCode,
        };
        setEvent(updated);
        return { ...updated };
      },
    ),
    recordSlugHistory: vi.fn(async () => undefined),
    linkPayoutTerms: vi.fn(async () => undefined),
    resolveBySlug: vi.fn(async () => null),
    getSlugContext: vi.fn(async () => {
      const event = getEvent();
      if (!event) return null;
      return {
        eventId: event.id,
        orgId: event.orgId,
        humanId: event.humanId,
        eventTitle: event.title,
        startsAt: event.startsAt,
        orgName: event.orgId ? DEFAULT_ORG_NAME : null,
        countryCode: "US",
        regionCode: "CA",
        cityOrRegionCode: "SF",
        shortId: event.shortId,
      };
    }),
  };
}

function buildTicketsRepoMock(issued: number) {
  return {
    create: vi.fn(async () => {
      throw new Error("not implemented");
    }),
    findBySeatIds: vi.fn(async () => []),
    markScanned: vi.fn(),
    getByCode: vi.fn(async () => null),
    setStatus: vi.fn(async () => undefined),
    recordScan: vi.fn(async () => undefined),
    transfer: vi.fn(),
    findTicketTypeByName: vi.fn(async () => null),
    createTicketType: vi.fn(),
    countIssuedForTicketType: vi.fn(async () => issued),
    countIssuedForEvent: vi.fn(async () => issued),
    activateDraftTicketTypes: vi.fn(async () => 0),
  };
}

const PROVISIONED_TERMS_ID = "00000000-0000-4000-8000-000000000099";
// The entity-level reusable default row (isDefault:true), distinct from the
// event-owned row (PROVISIONED_TERMS_ID). It is NEVER linked to an event.
const ENTITY_DEFAULT_TERMS_ID = "00000000-0000-4000-8000-000000000098";

function buildAgreementsRepoMock(
  agreements: PayoutTermsRecord[],
  linesMap: Map<string, PayoutTermsLineRecord[]>,
  now: Date,
) {
  const storedAgreements = agreements.map((agreement) => ({ ...agreement }));
  // Models `listByEvent`: only agreements actually linked to the event resolve.
  // `agreements` passed in are seeded as already-linked; provisioned ones add to
  // this set so the publish re-resolve sees them.
  const linkedIds = new Set(storedAgreements.map((a) => a.id));

  return {
    listByEvent: vi.fn(async () =>
      storedAgreements
        .filter((a) => linkedIds.has(a.id))
        .map((agreement) => ({ ...agreement })),
    ),
    listLines: vi.fn(async (agreementId: string) => {
      return (linesMap.get(agreementId) ?? []).map((line) => ({ ...line }));
    }),
    // The owner-line seeding path (lineless fee-mode-only drafts) writes the
    // default 100% owner line via the atomic-if-empty conditional insert.
    // Mirrors the adapter: the seed lands ONLY when the row still has zero
    // lines; otherwise it's a no-op returning false (never overwrites).
    seedLinesIfEmpty: vi.fn(
      async (
        payoutTermsId: string,
        inputs: Array<{
          payeeId: string;
          percent: number;
          floorCents: number;
          priority: number;
        }>,
      ) => {
        if ((linesMap.get(payoutTermsId) ?? []).length > 0) {
          return false;
        }
        linesMap.set(
          payoutTermsId,
          inputs.map((input, index) =>
            buildAgreementLine({
              id: `seeded-line-${payoutTermsId}-${index}`,
              payeeId: input.payeeId,
              percent: input.percent,
              floorCents: input.floorCents,
              priority: input.priority,
            }),
          ),
        );
        return true;
      },
    ),
    // Booking fence discriminator (`tx.agreements.getByPayoutTermsId`): the
    // publish-time owner-line seeding refuses booking-managed terms. Default:
    // nothing is booking-managed.
    getByPayoutTermsId: vi.fn(async () => null),
    // Booking-timeline reverse lookup (`tx.agreements.findByLinkedEventId`):
    // default "this event never came from a booking". The linked case is
    // covered in booking-event-lifecycle.test.ts.
    findByLinkedEventId: vi.fn(async () => null),
    // freeze-the-deal: publish locks the terms of any booking agreement on
    // the event (`lockEventDealTerms`). Default: none.
    findManyByLinkedEventIds: vi.fn(async () => []),
    pinFeePolicy: vi.fn(
      async ({
        payoutTermsId,
        feePolicyId,
      }: {
        payoutTermsId: string;
        feePolicyId: string;
      }) => {
        const index = storedAgreements.findIndex(
          (agreement) => agreement.id === payoutTermsId,
        );
        if (index === -1) {
          throw new Error("agreement not found");
        }
        const current = storedAgreements[index]!;
        const updated: PayoutTermsRecord = {
          ...current,
          feePolicyId,
          updatedAt: now,
        };
        storedAgreements[index] = updated;
        return { ...updated };
      },
    ),
    getById: vi.fn(async (id: string) => {
      const found = storedAgreements.find((a) => a.id === id);
      return found ? { ...found } : null;
    }),
    // Mirrors the adapter's guarded CAS: only transitions rows whose stored
    // status is in `expectedFrom`; a 0-match returns null (never throws).
    activate: vi.fn(
      async ({
        payoutTermsId,
        expectedFrom,
      }: {
        payoutTermsId: string;
        expectedFrom: readonly string[];
      }) => {
        const index = storedAgreements.findIndex((a) => a.id === payoutTermsId);
        if (index === -1) return null;
        const current = storedAgreements[index]!;
        if (!expectedFrom.includes(current.status)) return null;
        const updated: PayoutTermsRecord = {
          ...current,
          status: "ACTIVE",
          updatedAt: now,
        };
        storedAgreements[index] = updated;
        return { ...updated };
      },
    ),
    provisionDefaultPrimary: vi.fn(
      async ({
        payeeId,
        settlementCurrency,
        isDefault,
        payoutSchedule,
      }: {
        payeeId: string;
        settlementCurrency: string;
        isDefault: boolean;
        payoutSchedule?: PayoutTermsRecord["payoutSchedule"];
      }) => {
        // The auto-provision flow mints TWO distinct rows for an event with no
        // terms: the entity default (isDefault:true) then the event-owned row
        // (isDefault:false). Distinguish them so tests can assert the event row
        // is what gets linked and the entity default is never event-linked.
        const id = isDefault ? ENTITY_DEFAULT_TERMS_ID : PROVISIONED_TERMS_ID;
        const record: PayoutTermsRecord = buildAgreement({
          id,
          kind: "PRIMARY",
          status: "ACTIVE",
          feePolicyId: null,
          isDefault,
          settlementCurrency,
          ...(payoutSchedule !== undefined ? { payoutSchedule } : {}),
          createdAt: now,
          updatedAt: now,
        });
        storedAgreements.push({ ...record });
        // Provisioned terms are NOT yet linked — `linkPayoutTerms` does that.
        linesMap.set(id, [
          buildAgreementLine({
            id: `provisioned-line-${id}`,
            agreementId: id,
            payeeId,
            percent: 100,
            floorCents: 0,
            priority: 0,
          }),
        ]);
        return { ...record };
      },
    ),
    // Test-only hook: simulate `events.linkPayoutTerms` making the terms
    // resolvable via `listByEvent`.
    __link: (payoutTermsId: string) => {
      linkedIds.add(payoutTermsId);
    },
    // Test-only hook: seed a row that is resolvable via `getById` but NOT
    // linked to the event (e.g. a pre-existing entity default).
    __seedUnlinked: (record: PayoutTermsRecord) => {
      storedAgreements.push({ ...record });
    },
    // Test-only hook: overwrite a terms row's lines mid-test (simulates a
    // concurrent splits save landing between publish's read and its writes).
    __setLines: (payoutTermsId: string, lines: PayoutTermsLineRecord[]) => {
      linesMap.set(payoutTermsId, lines);
    },
  };
}

function buildFeePoliciesRepoMock(
  existing: FeePolicyRecord | null,
  resolved: Partial<Record<"EVENT" | "ORG" | "GLOBAL", FeePolicyRecord | null>>,
) {
  const resolveEntry = (
    key: "EVENT" | "ORG" | "GLOBAL",
    fallback: FeePolicyRecord | null,
  ) => {
    if (Object.prototype.hasOwnProperty.call(resolved, key)) {
      return resolved[key] ?? null;
    }
    return fallback;
  };

  const resolutionMap = new Map<
    "EVENT" | "ORG" | "GLOBAL",
    FeePolicyRecord | null
  >([
    ["EVENT", resolveEntry("EVENT", existing)],
    ["ORG", resolveEntry("ORG", null)],
    ["GLOBAL", resolveEntry("GLOBAL", null)],
  ]);

  return {
    getById: vi.fn(async (id: string) => {
      if (existing && existing.id === id) {
        return { ...existing };
      }
      return null;
    }),
    resolveEffective: vi.fn(
      async ({
        scopeType,
      }: {
        scopeType: "EVENT" | "ORG" | "GLOBAL";
        scopeId: string | null;
        at: Date;
      }) => {
        const policy = resolutionMap.get(scopeType) ?? null;
        return policy ? { ...policy } : null;
      },
    ),
  };
}

function buildAuthzRepoMock(role: OrgRole | null) {
  return {
    getHumanDelegation: vi.fn(
      async (): Promise<{ orgId: string; humanId: string; role: OrgRole } | null> =>
        null,
    ),
    getOrgMembership: vi.fn(async () => {
      if (!role) return null;
      return {
        orgId: DEFAULT_ORG_ID,
        humanId: DEFAULT_ACTOR_ID,
        role,
      };
    }),
  };
}

function buildAuditRepoMock() {
  return {
    log: vi.fn(async () => undefined),
  };
}

function buildTicketType(
  overrides: Partial<EventTicketTypeSummary>,
): EventTicketTypeSummary {
  return {
    id: "ticket-type-1",
    name: "General Admission",
    priceCents: 1000,
    pricingMode: "FIXED",
    minimumCents: null,
    suggestedCents: null,
    capacity: 100,
    status: "DRAFT",
    seatSectionId: null,
    resaleAllowed: false,
    resaleCapCents: null,
    transferAllowed: true,
    scheduledPriceCents: null,
    scheduledPriceAt: null,
    ...overrides,
  } satisfies EventTicketTypeSummary;
}

function buildAgreement(
  overrides: Partial<PayoutTermsRecord>,
): PayoutTermsRecord {
  return {
    id: DEFAULT_AGREEMENT_ID,
    kind: "PRIMARY_SPLIT",
    status: "ACTIVE",
    feeMode: "PASS_THROUGH",
    feePolicyId: null,
    payoutSchedule: "WEEK_OF_EVENT",
    isDefault: false,
    settlementCurrency: "usd",
    version: 1,
    createdAt: new Date("2024-12-01T00:00:00.000Z"),
    updatedAt: new Date("2024-12-01T00:00:00.000Z"),
    ...overrides,
  } satisfies PayoutTermsRecord;
}

/** One 100% RESALE line on `termsId`, for `makeContext({ agreementLines })`. */
function resaleLineFor(termsId: string): Record<string, PayoutTermsLineRecord[]> {
  return {
    [termsId]: [buildAgreementLine({ id: `${termsId}-line`, agreementId: termsId })],
  };
}

function buildAgreementLine(
  overrides: Partial<PayoutTermsLineRecord>,
): PayoutTermsLineRecord {
  return {
    id: "agreement-line-1",
    agreementId: DEFAULT_AGREEMENT_ID,
    payeeId: "payee-1",
    percent: 100,
    floorCents: 0,
    capPercent: null,
    priority: 0,
    rounding: "FLOOR",
    ...overrides,
  } satisfies PayoutTermsLineRecord;
}

function buildFeePolicy(overrides: Partial<FeePolicyRecord>): FeePolicyRecord {
  return {
    id: DEFAULT_FEE_POLICY_ID,
    scopeType: "EVENT",
    scopeId: DEFAULT_EVENT_ID,
    status: "ACTIVE",
    version: 1,
    effectiveFrom: new Date("2024-12-01T00:00:00.000Z"),
    effectiveTo: null,
    buyerFeePct: 450,
    maxFeeCents: null,
    minFeeCents: 100,
    platformFixedCents: 0,
    feeMode: "PASS_THROUGH",
    processsorFeePct: 290,
    processorFixedCents: 30,
    payoutPct: 9200,
    payoutFixedCents: 0,
    monthlyPayoutCents: 0,
    ...overrides,
  } satisfies FeePolicyRecord;
}

const DEFAULT_PAYEE_ID = "00000000-0000-4000-8000-000000000007";

function buildPayee(overrides: Partial<PayeeRecord>): PayeeRecord {
  return {
    id: DEFAULT_PAYEE_ID,
    subjectType: "ORGANIZATION",
    subjectId: DEFAULT_ORG_ID,
    stripeAccountId: "acct_test_123",
    status: "ACTIVE",
    chargesEnabled: true,
    payoutsEnabled: true,
    defaultCurrency: "usd",
    ...overrides,
  } satisfies PayeeRecord;
}

function buildPayeesRepoMock(
  payee: PayeeRecord | null,
  linePayees: PayeeRecord[] = [],
) {
  // Lookup for the splits-flow Gate 2 (`payees.getByIds`). Indexes both the
  // explicitly-provided line payees and the subject payee so a single-payee
  // test keeps working. Any requested id not present defaults to an ACTIVE
  // payee with `payoutsEnabled: true`, preserving prior behavior.
  const byId = new Map<string, PayeeRecord>();
  if (payee) byId.set(payee.id, payee);
  for (const p of linePayees) byId.set(p.id, p);

  return {
    getBySubject: vi.fn(async () => (payee ? { id: payee.id } : null)),
    getById: vi.fn(async (id: string) =>
      payee && payee.id === id ? { ...payee } : null,
    ),
    getByIds: vi.fn(async (ids: string[]) =>
      ids.map((id) => {
        const found = byId.get(id);
        return found ? { ...found } : buildPayee({ id, payoutsEnabled: true });
      }),
    ),
    syncCapabilities: vi.fn(async () => undefined),
    upsertForSubject: vi.fn(async () => {
      throw new Error("not implemented in test");
    }),
  };
}

describe("publishEvent", () => {
  it("publishes the event and pins a fee policy", async () => {
    const ctx = makeContext();
    const input = buildPublishInput(ctx);

    const result = await publishEvent(ctx.deps, input);

    expect(result).toEqual({
      eventId: ctx.defaults.eventId,
      status: "PUBLISHED",
      publishedAt: ctx.defaults.now,
    });

    expect(ctx.mocks.events.publish).toHaveBeenCalledWith({
      eventId: ctx.defaults.eventId,
      publishedAt: ctx.defaults.now,
      currentAttestationId: "attestation-1",
      currency: "usd",
      admissionTaxRateBps: null,
      taxRateSource: null,
    });
    expect(ctx.mocks.events.createAttestation).toHaveBeenCalledWith({
      eventId: ctx.defaults.eventId,
      attestedByHumanId: ctx.defaults.actorHumanId,
      attestedAt: ctx.defaults.now,
      ipAddress: DEFAULT_IP_ADDRESS,
      userAgent: DEFAULT_USER_AGENT,
      policyVersion: HOST_ATTESTATION_VERSION,
      policyTextSnapshot: HOST_ATTESTATION_TEXT,
      ...DEFAULT_ATTESTATION,
      metadata: {
        source: "publish_event",
      },
    });
    expect(ctx.mocks.agreements.pinFeePolicy).toHaveBeenCalledWith({
      payoutTermsId: ctx.defaults.agreementId,
      feePolicyId: ctx.defaults.feePolicy.id,
    });
    expect(ctx.mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event",
        action: "event.attestation_recorded",
        data: expect.objectContaining({
          actorHumanId: ctx.defaults.actorHumanId,
          attestationId: "attestation-1",
          policyVersion: HOST_ATTESTATION_VERSION,
          acknowledgedFields: HOST_ATTESTATION_FIELDS,
          acknowledgements: DEFAULT_ATTESTATION,
        }),
        at: ctx.defaults.now,
      }),
    );
    expect(ctx.mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event",
        action: "published",
        at: ctx.defaults.now,
      }),
    );
  });

  it("replays from idempotency on subsequent calls", async () => {
    const ctx = makeContext();
    const input = buildPublishInput(ctx);

    const first = await publishEvent(ctx.deps, input);

    ctx.mocks.events.publish.mockClear();
    ctx.mocks.events.createAttestation.mockClear();

    const second = await publishEvent(ctx.deps, input);

    expect(second).toEqual(first);
    expect(ctx.mocks.events.publish).not.toHaveBeenCalled();
    expect(ctx.mocks.events.createAttestation).not.toHaveBeenCalled();
  });

  it("rejects reused client keys when attestation evidence changes", async () => {
    const ctx = makeContext();
    const input = buildPublishInput(ctx);

    await publishEvent(ctx.deps, input);

    await expect(
      publishEvent(
        ctx.deps,
        buildPublishInput(ctx, {
          userAgent: "different-agent",
        }),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
  });

  it("returns existing publication info if the event is already published", async () => {
    const now = new Date("2025-02-01T00:00:00.000Z");
    const ctx = makeContext({
      event: { status: "PUBLISHED", publishedAt: now },
    });

    const result = await publishEvent(ctx.deps, {
      actorHumanId: ctx.defaults.actorHumanId,
      eventId: ctx.defaults.eventId,
      clientKey: ctx.defaults.clientKey,
    });

    expect(result).toEqual({
      eventId: ctx.defaults.eventId,
      status: "PUBLISHED",
      publishedAt: now,
    });
    expect(ctx.mocks.events.publish).not.toHaveBeenCalled();
    expect(ctx.mocks.events.createAttestation).not.toHaveBeenCalled();
  });

  it("publishes an EXACT event without any attestation (gate only applies to OBSCURED)", async () => {
    const ctx = makeContext({ event: { locationMode: "EXACT" } });

    const result = await publishEvent(ctx.deps, {
      actorHumanId: ctx.defaults.actorHumanId,
      eventId: ctx.defaults.eventId,
      clientKey: ctx.defaults.clientKey,
    });

    expect(result.status).toBe("PUBLISHED");
    expect(ctx.mocks.events.createAttestation).not.toHaveBeenCalled();
  });

  it("publishes an OBSCURED fully-hidden event (null radius) with reveal config + attestation", async () => {
    // The default fixture is OBSCURED + locationRadiusMeters: null; pin a
    // concrete reveal config to assert publish accepts the full OBSCURED shape.
    const ctx = makeContext({
      event: {
        locationRadiusMeters: null,
        addressRevealAt: new Date("2025-01-31T20:00:00.000Z"),
        addressRevealPreset: "DAY_BEFORE",
      },
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
    expect(ctx.mocks.events.createAttestation).toHaveBeenCalledTimes(1);
  });

  it("publishes an OBSCURED circle event (non-null radius) with attestation", async () => {
    const ctx = makeContext({
      event: {
        locationRadiusMeters: 500,
        addressRevealAt: new Date("2025-01-31T20:00:00.000Z"),
        addressRevealPreset: "DAY_BEFORE",
      },
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
    expect(ctx.mocks.events.createAttestation).toHaveBeenCalledTimes(1);
  });

  it("rejects missing attestation for an otherwise publishable draft", async () => {
    const ctx = makeContext();

    await expect(
      publishEvent(ctx.deps, {
        actorHumanId: ctx.defaults.actorHumanId,
        eventId: ctx.defaults.eventId,
        clientKey: ctx.defaults.clientKey,
      }),
    ).rejects.toMatchObject({
      code: "attestation_incomplete",
      message: "attestation_incomplete",
      meta: { missingFields: [...HOST_ATTESTATION_FIELDS] },
    });

    expect(ctx.mocks.events.createAttestation).not.toHaveBeenCalled();
    expect(ctx.mocks.agreements.pinFeePolicy).not.toHaveBeenCalled();
    expect(ctx.mocks.events.publish).not.toHaveBeenCalled();
  });

  it("rejects false attestation fields and reports which fields are missing", async () => {
    const ctx = makeContext();

    await expect(
      publishEvent(
        ctx.deps,
        buildPublishInput(ctx, {
          attestation: {
            ...DEFAULT_ATTESTATION,
            alcoholCompliance: false,
            organizerFaqReviewed: false,
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "attestation_incomplete",
      message: "attestation_incomplete",
      meta: { missingFields: ["alcoholCompliance", "organizerFaqReviewed"] },
    });

    expect(ctx.mocks.events.createAttestation).not.toHaveBeenCalled();
    expect(ctx.mocks.events.publish).not.toHaveBeenCalled();
  });

  it("reports omitted fields from a partial attestation block", async () => {
    const ctx = makeContext();

    await expect(
      publishEvent(
        ctx.deps,
        buildPublishInput(ctx, {
          attestation: {
            legalRightToHost: true,
            zoningAndNoiseCompliance: true,
            alcoholCompliance: true,
            organizerFaqReviewed: true,
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "attestation_incomplete",
      message: "attestation_incomplete",
      meta: { missingFields: ["taxResponsibility"] },
    });

    expect(ctx.mocks.events.createAttestation).not.toHaveBeenCalled();
    expect(ctx.mocks.events.publish).not.toHaveBeenCalled();
  });

  it("requires a fresh attestation when a previously attested event is back in draft", async () => {
    const ctx = makeContext({
      event: { currentAttestationId: "old-attestation" },
    });

    await expect(
      publishEvent(ctx.deps, {
        actorHumanId: ctx.defaults.actorHumanId,
        eventId: ctx.defaults.eventId,
        clientKey: ctx.defaults.clientKey,
      }),
    ).rejects.toMatchObject({ code: "attestation_incomplete" });

    await publishEvent(
      ctx.deps,
      buildPublishInput(ctx, { clientKey: "republish-fresh-key" }),
    );

    expect(ctx.mocks.events.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        currentAttestationId: "attestation-1",
      }),
    );
  });

  it("throws when the event does not exist", async () => {
    const ctx = makeContext({ event: null });

    await expect(
      publishEvent(ctx.deps, {
        actorHumanId: ctx.defaults.actorHumanId,
        eventId: ctx.defaults.eventId,
        clientKey: ctx.defaults.clientKey,
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("throws when the actor lacks org permissions", async () => {
    const ctx = makeContext({ membershipRole: null });

    await expect(
      publishEvent(ctx.deps, {
        actorHumanId: ctx.defaults.actorHumanId,
        eventId: ctx.defaults.eventId,
        clientKey: ctx.defaults.clientKey,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("requires the event to be draft", async () => {
    const ctx = makeContext({ event: { status: "CANCELLED" } });

    await expect(
      publishEvent(ctx.deps, {
        actorHumanId: ctx.defaults.actorHumanId,
        eventId: ctx.defaults.eventId,
        clientKey: ctx.defaults.clientKey,
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_PUBLISHABLE" });
  });

  it("requires a location (placeId, savedLocationId, or addressText)", async () => {
    const ctx = makeContext({
      event: { placeId: null, savedLocationId: null, addressText: null },
    });

    await expect(
      publishEvent(ctx.deps, {
        actorHumanId: ctx.defaults.actorHumanId,
        eventId: ctx.defaults.eventId,
        clientKey: ctx.defaults.clientKey,
      }),
    ).rejects.toMatchObject({ code: "EVENT_LOCATION_REQUIRED" });
  });

  it("requires at least one ticket type", async () => {
    const ctx = makeContext({ ticketTypes: [] });

    await expect(
      publishEvent(ctx.deps, {
        actorHumanId: ctx.defaults.actorHumanId,
        eventId: ctx.defaults.eventId,
        clientKey: ctx.defaults.clientKey,
      }),
    ).rejects.toMatchObject({ code: "TICKET_TYPES_REQUIRED" });
  });

  it("requires ticket types to have capacity", async () => {
    const ctx = makeContext({
      ticketTypes: [buildTicketType({ capacity: 0 })],
    });

    await expect(
      publishEvent(ctx.deps, {
        actorHumanId: ctx.defaults.actorHumanId,
        eventId: ctx.defaults.eventId,
        clientKey: ctx.defaults.clientKey,
      }),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_CAPACITY_INVALID" });
  });

  it("rejects if tickets have already been issued", async () => {
    const ctx = makeContext({ issuedTickets: 5 });

    await expect(
      publishEvent(ctx.deps, {
        actorHumanId: ctx.defaults.actorHumanId,
        eventId: ctx.defaults.eventId,
        clientKey: ctx.defaults.clientKey,
      }),
    ).rejects.toMatchObject({ code: "TICKETS_ALREADY_ISSUED" });
  });

  it("requires a category", async () => {
    const ctx = makeContext({
      event: { categoryId: null },
    });

    await expect(
      publishEvent(ctx.deps, {
        actorHumanId: ctx.defaults.actorHumanId,
        eventId: ctx.defaults.eventId,
        clientKey: ctx.defaults.clientKey,
      }),
    ).rejects.toMatchObject({ code: "EVENT_CATEGORY_MISSING" });
  });

  it("rejects resale-enabled ticket types without resale terms", async () => {
    const ctx = makeContext({
      event: { resalePayoutTermsId: null },
      ticketTypes: [buildTicketType({ resaleAllowed: true })],
    });

    await expect(
      publishEvent(ctx.deps, buildPublishInput(ctx)),
    ).rejects.toMatchObject({ code: "RESALE_TERMS_MISSING" });
  });

  it("publishes a resale-enabled ticket type when resale terms with a clause are set", async () => {
    const ctx = makeContext({
      event: { resalePayoutTermsId: "resale-terms-1" },
      agreements: [
        buildAgreement({}),
        buildAgreement({
          id: "resale-terms-1",
          kind: "RESALE",
          status: "PENDING",
          resaleShareType: "PERCENT",
          resaleShareBps: 1000,
          resaleShareCents: null,
          resaleSharePayer: "SELLER",
        }),
      ],
      agreementLines: resaleLineFor("resale-terms-1"),
      ticketTypes: [buildTicketType({ resaleAllowed: true })],
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
  });

  it("a set clause on RESALE terms with no line → AGREEMENT_MISSING_LINES (review W4)", async () => {
    const ctx = makeContext({
      event: { resalePayoutTermsId: "resale-terms-1" },
      agreements: [
        buildAgreement({}),
        buildAgreement({
          id: "resale-terms-1",
          kind: "RESALE",
          status: "PENDING",
          resaleShareType: "PERCENT",
          resaleShareBps: 1000,
          resaleShareCents: null,
          resaleSharePayer: "SELLER",
        }),
      ],
      ticketTypes: [buildTicketType({ resaleAllowed: true })],
    });

    await expect(publishEvent(ctx.deps, buildPublishInput(ctx))).rejects.toMatchObject({
      code: "AGREEMENT_MISSING_LINES",
      meta: { reason: "resale_lines_missing", payoutTermsId: "resale-terms-1" },
    });
  });

  // organiser-resale-share FR-001: resale terms alone are not enough — every
  // resale pays the event side a share set up front.
  it("rejects resale-enabled ticket types while the resale clause is not set", async () => {
    const ctx = makeContext({
      event: { resalePayoutTermsId: "resale-terms-1" },
      agreements: [
        buildAgreement({}),
        buildAgreement({
          id: "resale-terms-1",
          kind: "RESALE",
          status: "PENDING",
          resaleShareType: null,
        }),
      ],
      ticketTypes: [buildTicketType({ resaleAllowed: true })],
    });

    await expect(
      publishEvent(ctx.deps, buildPublishInput(ctx)),
    ).rejects.toMatchObject({
      code: "RESALE_TERMS_MISSING",
      meta: { reason: "resale_clause_not_set", payoutTermsId: "resale-terms-1" },
    });
  });

  it("a set clause of zero (PERCENT 0) is a set clause: publishes", async () => {
    const ctx = makeContext({
      event: { resalePayoutTermsId: "resale-terms-1" },
      agreements: [
        buildAgreement({}),
        buildAgreement({
          id: "resale-terms-1",
          kind: "RESALE",
          status: "PENDING",
          resaleShareType: "PERCENT",
          resaleShareBps: 0,
          resaleSharePayer: "SELLER",
        }),
      ],
      agreementLines: resaleLineFor("resale-terms-1"),
      ticketTypes: [buildTicketType({ resaleAllowed: true })],
    });

    await expect(publishEvent(ctx.deps, buildPublishInput(ctx))).resolves.toMatchObject({
      status: "PUBLISHED",
    });
  });

  it("an event with no resale-enabled type publishes with the clause not set", async () => {
    const ctx = makeContext({
      event: { resalePayoutTermsId: "resale-terms-1" },
      agreements: [
        buildAgreement({}),
        buildAgreement({ id: "resale-terms-1", kind: "RESALE", status: "PENDING", resaleShareType: null }),
      ],
      ticketTypes: [buildTicketType({ resaleAllowed: false })],
    });

    await expect(publishEvent(ctx.deps, buildPublishInput(ctx))).resolves.toMatchObject({
      status: "PUBLISHED",
    });
  });

  it("rejects when splits do not reconcile to 100%", async () => {
    const ctx = makeContext({
      agreementLines: {
        [DEFAULT_AGREEMENT_ID]: [
          buildAgreementLine({
            percent: 80,
            requiresConfirmation: true,
            confirmationStatus: "CONFIRMED",
          }),
        ],
      },
    });

    await expect(
      publishEvent(ctx.deps, buildPublishInput(ctx)),
    ).rejects.toMatchObject({
      code: "precondition_failed",
      message: "splits_total_invalid",
      data: { totalAllocatedPct: 80, targetPct: 100 },
    });
  });

  it("publishes when splits reconcile to exactly 100%", async () => {
    const ctx = makeContext({
      agreementLines: {
        [DEFAULT_AGREEMENT_ID]: [
          buildAgreementLine({
            percent: 100,
            requiresConfirmation: true,
            confirmationStatus: "CONFIRMED",
          }),
        ],
      },
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
  });

  // Gate 1b. A `capPercent` is not the harmless "only limits a payout" field
  // the pre-2026-09 comment here claimed: settlement honours it, so terms that
  // cannot reach 100% distribute less than the basis and under-pay everyone.
  //
  // But it takes an ALL-capped set to do that. `distributeRemainder` never
  // skips an uncapped line, so one uncapped line absorbs every withheld cent.
  // This test previously used 60-capped-at-10 + 40-UNCAPPED and asserted a
  // refusal — a set that distributes to 1 000 / 9 000, summing to the basis
  // exactly. It pinned the bug. It is now an all-capped set, and the
  // capped-plus-uncapped shape has its own PUBLISHES test below.
  it("refuses to publish when every line is capped and the caps fall short", async () => {
    const ctx = makeContext({
      agreementLines: {
        [DEFAULT_AGREEMENT_ID]: [
          buildAgreementLine({
            id: "agreement-line-1",
            percent: 60,
            capPercent: 10,
            payeeId: "payee-1",
            requiresConfirmation: true,
            confirmationStatus: "CONFIRMED",
          }),
          buildAgreementLine({
            id: "agreement-line-2",
            percent: 40,
            capPercent: 40,
            payeeId: "payee-2",
            requiresConfirmation: true,
            confirmationStatus: "CONFIRMED",
          }),
        ],
      },
    });

    // Σ percent = 100, so Gate 1 is happy; the ceilings sum to 50, so half of
    // every order would be left unallocated.
    await expect(
      publishEvent(ctx.deps, buildPublishInput(ctx)),
    ).rejects.toMatchObject({
      code: "SPLITS_CAPS_UNSATISFIABLE",
      meta: {
        totalCapPct: 50,
        totalAllocatedPct: 100,
        targetPct: 100,
        cappedLineIds: ["agreement-line-1"],
      },
    });

    expect(ctx.mocks.events.publish).not.toHaveBeenCalled();
  });

  // The canonical deal the first cut of this gate refused: a venue on "20% of
  // net, capped at 5%" beside an organiser on the other 80%. Σ min(percent,
  // cap) = 85, which the old predicate compared against 100 and threw — while
  // `computeOrderSplits` distributes it to 500 / 9 500 on a 10 000c basis.
  it("publishes a capped line beside an uncapped one", async () => {
    const ctx = makeContext({
      agreementLines: {
        [DEFAULT_AGREEMENT_ID]: [
          buildAgreementLine({
            id: "agreement-line-1",
            percent: 20,
            capPercent: 5,
            payeeId: "payee-1",
            requiresConfirmation: true,
            confirmationStatus: "CONFIRMED",
          }),
          buildAgreementLine({
            id: "agreement-line-2",
            percent: 80,
            capPercent: null,
            payeeId: "payee-2",
            requiresConfirmation: true,
            confirmationStatus: "CONFIRMED",
          }),
        ],
      },
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
  });

  // The ±1 tolerance the first cut inherited from Gate 1 admitted this: two
  // ceilings summing to 99 against a target of 100, `100 - 99 > 1` false, so
  // it published and then dropped 100c of every 10 000c order. Caps are
  // compared exactly.
  it("refuses an all-capped set that is short by exactly one point", async () => {
    const ctx = makeContext({
      agreementLines: {
        [DEFAULT_AGREEMENT_ID]: [
          buildAgreementLine({
            id: "agreement-line-1",
            percent: 50,
            capPercent: 50,
            payeeId: "payee-1",
            requiresConfirmation: true,
            confirmationStatus: "CONFIRMED",
          }),
          buildAgreementLine({
            id: "agreement-line-2",
            percent: 50,
            capPercent: 49,
            payeeId: "payee-2",
            requiresConfirmation: true,
            confirmationStatus: "CONFIRMED",
          }),
        ],
      },
    });

    await expect(
      publishEvent(ctx.deps, buildPublishInput(ctx)),
    ).rejects.toMatchObject({
      code: "SPLITS_CAPS_UNSATISFIABLE",
      meta: { totalCapPct: 99, targetPct: 100 },
    });

    expect(ctx.mocks.events.publish).not.toHaveBeenCalled();
  });

  // `requiresConfirmation` is stamped only on NON-OWNER lines, so a solely
  // owner-line terms row never enters the `usesNewSplitsFlow` branch. Gate 1b
  // is deliberately outside it: this event would otherwise publish and retain
  // half of every order for nobody.
  it("refuses a sole OWNER line whose cap cannot reach 100% (no splits flow)", async () => {
    const ctx = makeContext({
      agreementLines: {
        [DEFAULT_AGREEMENT_ID]: [
          buildAgreementLine({
            id: "agreement-line-1",
            percent: 100,
            capPercent: 50,
            payeeId: "payee-1",
            requiresConfirmation: false,
            confirmationStatus: null,
          }),
        ],
      },
    });

    await expect(
      publishEvent(ctx.deps, buildPublishInput(ctx)),
    ).rejects.toMatchObject({
      code: "SPLITS_CAPS_UNSATISFIABLE",
      meta: { totalCapPct: 50, totalAllocatedPct: 100, targetPct: 100 },
    });

    expect(ctx.mocks.events.publish).not.toHaveBeenCalled();
  });

  it("publishes an all-capped set whose ceilings DO reach 100%", async () => {
    // Σ min(percent, cap) = 20 + 60 = 80 — refused by the old predicate — but
    // the ceilings sum to 120, so the remainder pass fills both lines.
    const ctx = makeContext({
      agreementLines: {
        [DEFAULT_AGREEMENT_ID]: [
          buildAgreementLine({
            id: "agreement-line-1",
            percent: 20,
            capPercent: 60,
            payeeId: "payee-1",
            requiresConfirmation: true,
            confirmationStatus: "CONFIRMED",
          }),
          buildAgreementLine({
            id: "agreement-line-2",
            percent: 80,
            capPercent: 60,
            payeeId: "payee-2",
            requiresConfirmation: true,
            confirmationStatus: "CONFIRMED",
          }),
        ],
      },
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
  });

  // A DECLINED line is excluded from the cap sum exactly as it is from Gate
  // 1's percent sum — otherwise removing a decliner's line would flip the
  // gate's verdict on terms nobody changed.
  it("ignores a DECLINED line when judging the caps", async () => {
    const ctx = makeContext({
      agreementLines: {
        [DEFAULT_AGREEMENT_ID]: [
          buildAgreementLine({
            id: "agreement-line-1",
            percent: 100,
            capPercent: null,
            payeeId: "payee-1",
            requiresConfirmation: true,
            confirmationStatus: "CONFIRMED",
          }),
          buildAgreementLine({
            id: "agreement-line-2",
            percent: 0,
            capPercent: 0,
            payeeId: "payee-2",
            requiresConfirmation: true,
            confirmationStatus: "DECLINED",
          }),
        ],
      },
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
  });

  it("publishes when the caps still leave the whole basis reachable", async () => {
    const ctx = makeContext({
      agreementLines: {
        [DEFAULT_AGREEMENT_ID]: [
          buildAgreementLine({
            id: "agreement-line-1",
            percent: 60,
            capPercent: 60, // exactly its own share: binding but satisfiable
            payeeId: "payee-1",
            requiresConfirmation: true,
            confirmationStatus: "CONFIRMED",
          }),
          buildAgreementLine({
            id: "agreement-line-2",
            percent: 40,
            capPercent: 80, // above its share: inert
            payeeId: "payee-2",
            requiresConfirmation: true,
            confirmationStatus: "CONFIRMED",
          }),
        ],
      },
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
  });

  // The gate reuses Gate 1's ±1 tolerance on purpose: with no caps,
  // min(percent, ∞) === percent, so anything Gate 1 admits must pass Gate 1b.
  // A 99% uncapped set published before this gate existed and still does.
  it("leaves uncapped terms alone, including the ±1 slack Gate 1 allows", async () => {
    const ctx = makeContext({
      agreementLines: {
        [DEFAULT_AGREEMENT_ID]: [
          buildAgreementLine({
            id: "agreement-line-1",
            percent: 50,
            payeeId: "payee-1",
            requiresConfirmation: true,
            confirmationStatus: "CONFIRMED",
          }),
          buildAgreementLine({
            id: "agreement-line-2",
            percent: 49,
            payeeId: "payee-2",
            requiresConfirmation: true,
            confirmationStatus: "CONFIRMED",
          }),
        ],
      },
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
  });

  it("ignores a cap on a DECLINED line, matching Gate 1's filter", async () => {
    const ctx = makeContext({
      agreementLines: {
        [DEFAULT_AGREEMENT_ID]: [
          buildAgreementLine({
            id: "agreement-line-1",
            percent: 100,
            payeeId: "payee-1",
            requiresConfirmation: true,
            confirmationStatus: "CONFIRMED",
          }),
          buildAgreementLine({
            id: "agreement-line-2",
            percent: 0,
            capPercent: 0,
            payeeId: "payee-2",
            requiresConfirmation: true,
            confirmationStatus: "DECLINED",
          }),
        ],
      },
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
  });

  it("publishes when splits reconcile within the ±1 tolerance (101%)", async () => {
    const ctx = makeContext({
      agreementLines: {
        [DEFAULT_AGREEMENT_ID]: [
          buildAgreementLine({
            id: "agreement-line-1",
            percent: 51,
            payeeId: "payee-1",
            requiresConfirmation: true,
            confirmationStatus: "CONFIRMED",
          }),
          buildAgreementLine({
            id: "agreement-line-2",
            percent: 50,
            payeeId: "payee-2",
            requiresConfirmation: true,
            confirmationStatus: "CONFIRMED",
          }),
        ],
      },
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
  });

  // ── P4b (deal terms) ── Gate 1c: DEAL-WRITTEN terms (a stored remainder
  // holder) divide each order exactly; the ±1 tolerance above stays for
  // legacy terms only. 101% on deal terms is the signature of two deal
  // writes that each added a set.
  it("P4b: refuses deal-written terms whose per-order lines are not exactly 100% — and publishes them at 100%", async () => {
    const DEAL_TERMS_ID = "00000000-0000-4000-8000-0000000000d4";
    const build = (percents: [number, number]) =>
      makeContext({
        agreements: [
          buildAgreement({
            id: DEAL_TERMS_ID,
            kind: "PRIMARY",
            status: "PENDING",
            remainderPayeeId: "payee-1",
          }),
        ],
        agreementLines: {
          [DEAL_TERMS_ID]: percents.map((percent, i) =>
            buildAgreementLine({
              id: `agreement-line-${i + 1}`,
              percent,
              payeeId: `payee-${i + 1}`,
              requiresConfirmation: true,
              confirmationStatus: "CONFIRMED",
            }),
          ),
        },
      });

    const doubled = build([51, 50]);
    await expect(publishEvent(doubled.deps, buildPublishInput(doubled))).rejects.toMatchObject({
      code: "PAYOUT_LINES_TOTAL_INVALID",
    });
    expect(doubled.mocks.events.publish).not.toHaveBeenCalled();

    const whole = build([90, 10]);
    const result = await publishEvent(whole.deps, buildPublishInput(whole));
    expect(result.status).toBe("PUBLISHED");
  });

  // DELIBERATE behavior change (review finding): a DECLINED line with a
  // non-zero share used to be merely EXCLUDED from the reconcile total (this
  // test formerly published with a DECLINED 50% line). But checkout/
  // settlement (`loadPayoutTermsContext` → `computeOrderSplits`) apply no
  // confirmation filter — every stored line is paid from the full basis, so
  // the decliner would be paid and everyone else diluted. Now that publish
  // ACTIVATES pending terms, that combination must block.
  it("blocks publish while a DECLINED line still carries a share (terms stay PENDING)", async () => {
    const PENDING_TERMS_ID = "00000000-0000-4000-8000-0000000000c1";
    const ctx = makeContext({
      agreements: [
        buildAgreement({
          id: PENDING_TERMS_ID,
          kind: "PRIMARY",
          status: "PENDING",
        }),
      ],
      agreementLines: {
        [PENDING_TERMS_ID]: [
          buildAgreementLine({
            id: "agreement-line-1",
            percent: 100,
            payeeId: "payee-1",
            requiresConfirmation: true,
            confirmationStatus: "CONFIRMED",
          }),
          buildAgreementLine({
            id: "agreement-line-2",
            percent: 40,
            payeeId: "payee-2",
            requiresConfirmation: true,
            confirmationStatus: "DECLINED",
          }),
        ],
      },
    });

    await expect(
      publishEvent(ctx.deps, buildPublishInput(ctx)),
    ).rejects.toMatchObject({
      code: "precondition_failed",
      message: "declined_line_present",
      data: { lineIds: ["agreement-line-2"], payeeIds: ["payee-2"] },
    });

    expect(ctx.mocks.events.publish).not.toHaveBeenCalled();
    expect(ctx.mocks.agreements.activate).not.toHaveBeenCalled();
    await expect(
      ctx.mocks.agreements.getById(PENDING_TERMS_ID),
    ).resolves.toMatchObject({ status: "PENDING" });
  });

  it("publishes when a DECLINED line has been fully zeroed out (percent 0 AND floor 0)", async () => {
    const PENDING_TERMS_ID = "00000000-0000-4000-8000-0000000000c2";
    const ctx = makeContext({
      agreements: [
        buildAgreement({
          id: PENDING_TERMS_ID,
          kind: "PRIMARY",
          status: "PENDING",
        }),
      ],
      agreementLines: {
        [PENDING_TERMS_ID]: [
          buildAgreementLine({
            id: "agreement-line-1",
            percent: 100,
            payeeId: "payee-1",
            requiresConfirmation: true,
            confirmationStatus: "CONFIRMED",
          }),
          buildAgreementLine({
            id: "agreement-line-2",
            percent: 0,
            floorCents: 0,
            payeeId: "payee-2",
            requiresConfirmation: true,
            confirmationStatus: "DECLINED",
          }),
        ],
      },
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
    // A fully-zeroed DECLINED line can receive nothing at settlement —
    // activation proceeds normally.
    expect(ctx.mocks.agreements.activate).toHaveBeenCalledWith({
      payoutTermsId: PENDING_TERMS_ID,
      expectedFrom: ["PENDING"],
    });
  });

  it("publishes when a DECLINED line has percent 0 and a stale non-zero floor (floors are inert)", async () => {
    // 2026-08: per-order floors are no longer honoured anywhere in the split
    // math, so a DECLINED percent-0 line with a leftover `floorCents` can
    // receive nothing — the same "harmless" case as a fully-zeroed line. Gate 0
    // must NOT block on it: the editors no longer surface floors, and
    // `declined_line_present` has no user-facing copy, so blocking here would
    // be an invisible, unexplained wall. Stale floors in the DB are inert.
    const PENDING_TERMS_ID = "00000000-0000-4000-8000-0000000000c6";
    const ctx = makeContext({
      agreements: [
        buildAgreement({
          id: PENDING_TERMS_ID,
          kind: "PRIMARY",
          status: "PENDING",
        }),
      ],
      agreementLines: {
        [PENDING_TERMS_ID]: [
          buildAgreementLine({
            id: "agreement-line-1",
            percent: 100,
            payeeId: "payee-1",
            requiresConfirmation: true,
            confirmationStatus: "CONFIRMED",
          }),
          buildAgreementLine({
            id: "agreement-line-2",
            percent: 0,
            floorCents: 500,
            payeeId: "payee-2",
            requiresConfirmation: true,
            confirmationStatus: "DECLINED",
          }),
        ],
      },
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
    expect(ctx.mocks.events.publish).toHaveBeenCalled();
    expect(ctx.mocks.agreements.activate).toHaveBeenCalledWith({
      payoutTermsId: PENDING_TERMS_ID,
      expectedFrom: ["PENDING"],
    });
  });

  it("rejects when a splits-line payee cannot receive payouts", async () => {
    const ctx = makeContext({
      agreementLines: {
        [DEFAULT_AGREEMENT_ID]: [
          buildAgreementLine({
            id: "agreement-line-1",
            percent: 50,
            payeeId: "payee-1",
            requiresConfirmation: true,
            confirmationStatus: "CONFIRMED",
          }),
          buildAgreementLine({
            id: "agreement-line-2",
            percent: 50,
            payeeId: "payee-2",
            requiresConfirmation: true,
            confirmationStatus: "CONFIRMED",
          }),
        ],
      },
      linePayees: [
        buildPayee({ id: "payee-1", payoutsEnabled: true }),
        buildPayee({ id: "payee-2", payoutsEnabled: false }),
      ],
    });

    await expect(
      publishEvent(ctx.deps, buildPublishInput(ctx)),
    ).rejects.toMatchObject({
      code: "precondition_failed",
      message: "payee_not_active",
      data: { payeeIds: ["payee-2"] },
    });
  });

  it("auto-provisions a default PRIMARY agreement for an org event with an active payee", async () => {
    const ctx = makeContext({
      agreements: [],
      payee: { id: DEFAULT_PAYEE_ID, subjectType: "ORGANIZATION" },
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");

    // Two distinct rows: the entity default (isDefault:true) and a SEPARATE
    // event-owned row (isDefault:false). Each a 100% owner line.
    expect(ctx.mocks.agreements.provisionDefaultPrimary).toHaveBeenCalledTimes(
      2,
    );
    expect(
      ctx.mocks.agreements.provisionDefaultPrimary,
    ).toHaveBeenNthCalledWith(1, {
      payeeId: DEFAULT_PAYEE_ID,
      settlementCurrency: "usd",
      isDefault: true,
    });
    expect(
      ctx.mocks.agreements.provisionDefaultPrimary,
    ).toHaveBeenNthCalledWith(2, {
      payeeId: DEFAULT_PAYEE_ID,
      settlementCurrency: "usd",
      isDefault: false,
      // Inherited from the entity default minted in call 1.
      payoutSchedule: "WEEK_OF_EVENT",
    });

    // Only the EVENT-owned row is linked to the event. The entity default is
    // NEVER event-linked.
    expect(ctx.mocks.events.linkPayoutTerms).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.events.linkPayoutTerms).toHaveBeenCalledWith({
      eventId: ctx.defaults.eventId,
      payoutTermsId: PROVISIONED_TERMS_ID,
      kind: "PRIMARY",
    });

    // The org's default points at the ENTITY default row, not the event row —
    // written through the IS-NULL CAS guard.
    expect(
      ctx.mocks.organizations.setDefaultPrimaryPayoutTermsIdIfNull,
    ).toHaveBeenCalledWith({
      id: DEFAULT_ORG_ID,
      payoutTermsId: ENTITY_DEFAULT_TERMS_ID,
    });

    // GLOBAL fee policy pinned onto the EVENT-owned terms (what publish uses).
    expect(ctx.mocks.agreements.pinFeePolicy).toHaveBeenCalledWith({
      payoutTermsId: PROVISIONED_TERMS_ID,
      feePolicyId: ctx.defaults.feePolicy.id,
    });

    // Provisioned rows are minted ACTIVE — no publish-time activation needed.
    expect(ctx.mocks.agreements.activate).not.toHaveBeenCalled();
  });

  it("auto-provisions a default PRIMARY agreement for a human-owned event", async () => {
    const ctx = makeContext({
      agreements: [],
      event: { orgId: null, humanId: DEFAULT_ACTOR_ID },
      payee: {
        id: DEFAULT_PAYEE_ID,
        subjectType: "HUMAN",
        subjectId: DEFAULT_ACTOR_ID,
        defaultCurrency: "cad",
      },
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
    expect(
      ctx.mocks.agreements.provisionDefaultPrimary,
    ).toHaveBeenNthCalledWith(1, {
      payeeId: DEFAULT_PAYEE_ID,
      settlementCurrency: "cad",
      isDefault: true,
    });
    expect(
      ctx.mocks.agreements.provisionDefaultPrimary,
    ).toHaveBeenNthCalledWith(2, {
      payeeId: DEFAULT_PAYEE_ID,
      settlementCurrency: "cad",
      isDefault: false,
      // Inherited from the entity default minted in call 1.
      payoutSchedule: "WEEK_OF_EVENT",
    });
    // Human entity default points at the entity default row, never the event
    // row — written through the IS-NULL CAS guard.
    expect(
      ctx.mocks.humans.setDefaultPrimaryPayoutTermsIdIfNull,
    ).toHaveBeenCalledWith({
      id: DEFAULT_ACTOR_ID,
      payoutTermsId: ENTITY_DEFAULT_TERMS_ID,
    });
  });

  // Owner ruling 2026-09-28: an edit-role delegate publishes the principal's
  // personal event. The event, its payee and its entity default stay the
  // PRINCIPAL's; the attestation and audit name the DELEGATE as the actor.
  describe("a delegate publishing the principal's event", () => {
    const PRINCIPAL_ID = "00000000-0000-4000-8000-0000000000d1";

    const delegateContext = (role: OrgRole | null) => {
      const ctx = makeContext({
        agreements: [],
        event: { orgId: null, humanId: PRINCIPAL_ID },
        payee: {
          id: DEFAULT_PAYEE_ID,
          subjectType: "HUMAN",
          subjectId: PRINCIPAL_ID,
          defaultCurrency: "usd",
        },
      });
      ctx.mocks.authz.getHumanDelegation.mockResolvedValue(
        role
          ? { orgId: PRINCIPAL_ID, humanId: DEFAULT_ACTOR_ID, role }
          : null,
      );
      // The chargeback-terms gate is the OWNER's: only the principal's human
      // row exists (and has accepted), the delegate's does not.
      const baseHuman = vi.mocked(ctx.mocks.humans.getById).getMockImplementation()!;
      vi.mocked(ctx.mocks.humans.getById).mockImplementation(async (id) => {
        if (id !== PRINCIPAL_ID) return null;
        const human = await baseHuman(DEFAULT_ACTOR_ID);
        return human ? { ...human, id: PRINCIPAL_ID } : null;
      });
      return ctx;
    };

    it.each(["OWNER", "ADMIN", "EDITOR"] as const)(
      "a %s delegate publishes; ownership and money provisioning stay with the principal",
      async (role) => {
        const ctx = delegateContext(role);

        const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

        expect(result.status).toBe("PUBLISHED");
        expect(ctx.mocks.authz.getHumanDelegation).toHaveBeenCalledWith({
          principalId: PRINCIPAL_ID,
          delegateId: DEFAULT_ACTOR_ID,
        });
        expect(
          ctx.mocks.humans.setDefaultPrimaryPayoutTermsIdIfNull,
        ).toHaveBeenCalledWith(expect.objectContaining({ id: PRINCIPAL_ID }));
        expect(ctx.mocks.events.createAttestation).toHaveBeenCalledWith(
          expect.objectContaining({ attestedByHumanId: DEFAULT_ACTOR_ID }),
        );
        expect(ctx.mocks.audit.log).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "event.attestation_recorded",
            data: expect.objectContaining({ actorHumanId: DEFAULT_ACTOR_ID }),
          }),
        );
      },
    );

    it.each([["VIEWER"], ["FINANCE"], ["SCANNER"], [null]] as const)(
      "a %s delegate (or a stranger) is refused and nothing publishes",
      async (role) => {
        const ctx = delegateContext(role);

        await expect(
          publishEvent(ctx.deps, buildPublishInput(ctx)),
        ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
        expect(ctx.mocks.events.publish).not.toHaveBeenCalled();
      },
    );
  });

  it("does not overwrite an existing entity default; still creates a separate event row", async () => {
    const EXISTING_DEFAULT_ID = "00000000-0000-4000-8000-0000000000aa";
    const ctx = makeContext({
      agreements: [],
      ownerDefaultPrimaryPayoutTermsId: EXISTING_DEFAULT_ID,
      payee: { id: DEFAULT_PAYEE_ID, subjectType: "ORGANIZATION" },
    });
    // Seed the existing entity default as an UNLINKED row so the entity-default
    // idempotency check resolves it via getById without short-circuiting the
    // event-level provision (it must NOT be linked to the event).
    (ctx.mocks.agreements as any).__seedUnlinked(
      buildAgreement({
        id: EXISTING_DEFAULT_ID,
        kind: "PRIMARY",
        status: "ACTIVE",
        isDefault: true,
      }),
    );

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
    // Entity default already existed → only the event-owned row is provisioned.
    expect(ctx.mocks.agreements.provisionDefaultPrimary).toHaveBeenCalledTimes(
      1,
    );
    expect(ctx.mocks.agreements.provisionDefaultPrimary).toHaveBeenCalledWith({
      payeeId: DEFAULT_PAYEE_ID,
      settlementCurrency: "usd",
      isDefault: false,
      // The event row inherits the pre-existing entity default's schedule.
      payoutSchedule: "WEEK_OF_EVENT",
    });
    // The entity default pointer is left untouched.
    expect(ctx.mocks.organizations.update).not.toHaveBeenCalled();
  });

  it("still throws primary_agreement_missing when the owner has no payee", async () => {
    // Free-only event (priceCents 0) so the Stripe-connectivity guard is
    // skipped and the flow actually reaches the agreement gate. With no payee,
    // provisioning returns null and the original error stands.
    const ctx = makeContext({
      agreements: [],
      payee: null,
      ticketTypes: [buildTicketType({ priceCents: 0 })],
    });

    await expect(
      publishEvent(ctx.deps, buildPublishInput(ctx)),
    ).rejects.toMatchObject({ code: "PRIMARY_AGREEMENT_MISSING" });

    expect(ctx.mocks.agreements.provisionDefaultPrimary).not.toHaveBeenCalled();
  });

  it("throws stripe_not_connected_owner for a paid event with no payee before reaching provisioning", async () => {
    const ctx = makeContext({
      agreements: [],
      payee: null,
      ticketTypes: [buildTicketType({ priceCents: 2000 })],
    });

    await expect(
      publishEvent(ctx.deps, buildPublishInput(ctx)),
    ).rejects.toMatchObject({ code: "STRIPE_NOT_CONNECTED_OWNER" });

    expect(ctx.mocks.agreements.provisionDefaultPrimary).not.toHaveBeenCalled();
  });

  // ── time-based-ticket-pricing: "ever paid", not "paid right now" ────────
  //
  // FR-005 makes "free now, $20 at T" expressible for the first time. Publish
  // is the LAST gate before an event is buyable, so if it only asks "is
  // priceCents > 0 today?" the event ships with no connected payee, sells fine
  // until T, and then fails EVERY checkout from T onward — fail-closed, but a
  // total sales outage the organizer cannot diagnose.

  it("REFUSES to publish a $0-now / $20-at-T tier when the owner has no payee", async () => {
    const ctx = makeContext({
      agreements: [],
      payee: null,
      ticketTypes: [
        buildTicketType({
          priceCents: 0,
          scheduledPriceCents: 2000,
          scheduledPriceAt: new Date("2026-12-01T00:00:00.000Z"),
        }),
      ],
    });

    await expect(
      publishEvent(ctx.deps, buildPublishInput(ctx)),
    ).rejects.toMatchObject({ code: "STRIPE_NOT_CONNECTED_OWNER" });

    expect(ctx.mocks.agreements.provisionDefaultPrimary).not.toHaveBeenCalled();
  });

  it("NFR-001: a GENUINELY free tier still publishes without a payee", async () => {
    // The control. A $0 tier with no schedule must not be
    // caught by the widened predicate — free events stay free to publish.
    const ctx = makeContext({
      agreements: [],
      payee: null,
      ticketTypes: [buildTicketType({ priceCents: 0 })],
    });

    // Reaches the agreement gate, i.e. it got PAST the Stripe guard — the same
    // assertion the pre-existing free-event test above makes.
    await expect(
      publishEvent(ctx.deps, buildPublishInput(ctx)),
    ).rejects.toMatchObject({ code: "PRIMARY_AGREEMENT_MISSING" });
  });

  it("a tier scheduled to become FREE at T is not treated as paid by the schedule term alone", async () => {
    // scheduledPriceCents 0 must not trip the predicate on its own; here it is
    // priceCents that makes the type paid, and it does still require a payee.
    const ctx = makeContext({
      agreements: [],
      payee: null,
      ticketTypes: [
        buildTicketType({
          priceCents: 2000,
          scheduledPriceCents: 0,
          scheduledPriceAt: new Date("2026-12-01T00:00:00.000Z"),
        }),
      ],
    });

    await expect(
      publishEvent(ctx.deps, buildPublishInput(ctx)),
    ).rejects.toMatchObject({ code: "STRIPE_NOT_CONNECTED_OWNER" });
  });

  it("does not auto-provision when an active primary agreement already exists", async () => {
    const ctx = makeContext();

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
    expect(ctx.mocks.agreements.provisionDefaultPrimary).not.toHaveBeenCalled();
  });

  // ── Publish-time activation of PENDING primaries ────────────────────────
  // DELIBERATE behavior change (payout-terms activation gap): a builder-
  // authored PENDING primary used to dead-end publish with
  // PRIMARY_AGREEMENT_MISSING. Publish now treats PENDING as eligible, runs
  // every gate against it, and CAS-activates it once they all pass.

  it("activates a builder-authored PENDING primary at publish (auto-provision stays a no-op)", async () => {
    const BUILDER_TERMS_ID = "00000000-0000-4000-8000-0000000000bb";
    const ctx = makeContext({
      agreements: [
        buildAgreement({
          id: BUILDER_TERMS_ID,
          kind: "PRIMARY",
          status: "PENDING",
        }),
      ],
      payee: { id: DEFAULT_PAYEE_ID, subjectType: "ORGANIZATION" },
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");

    // The authored terms were NOT clobbered, re-linked, or duplicated…
    expect(ctx.mocks.agreements.provisionDefaultPrimary).not.toHaveBeenCalled();
    expect(ctx.mocks.events.linkPayoutTerms).not.toHaveBeenCalled();
    expect(ctx.mocks.organizations.update).not.toHaveBeenCalled();

    // …and they are now validated-in-force: CAS PENDING→ACTIVE + audit row.
    expect(ctx.mocks.agreements.activate).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.agreements.activate).toHaveBeenCalledWith({
      payoutTermsId: BUILDER_TERMS_ID,
      expectedFrom: ["PENDING"],
    });
    await expect(
      ctx.mocks.agreements.getById(BUILDER_TERMS_ID),
    ).resolves.toMatchObject({ status: "ACTIVE" });
    expect(ctx.mocks.audit.log).toHaveBeenCalledWith({
      entity: "payoutTerms",
      entityId: BUILDER_TERMS_ID,
      action: "activated",
      data: { reason: "activated_at_publish", eventId: ctx.defaults.eventId },
      at: ctx.defaults.now,
    });
  });

  it("keeps a PENDING primary PENDING when the payee gate blocks publish", async () => {
    const PENDING_TERMS_ID = "00000000-0000-4000-8000-0000000000bc";
    const ctx = makeContext({
      agreements: [
        buildAgreement({
          id: PENDING_TERMS_ID,
          kind: "PRIMARY",
          status: "PENDING",
        }),
      ],
      agreementLines: {
        [PENDING_TERMS_ID]: [
          buildAgreementLine({
            id: "line-1",
            percent: 50,
            payeeId: "payee-1",
            requiresConfirmation: true,
            confirmationStatus: "CONFIRMED",
          }),
          buildAgreementLine({
            id: "line-2",
            percent: 50,
            payeeId: "payee-2",
            requiresConfirmation: true,
            confirmationStatus: "CONFIRMED",
          }),
        ],
      },
      linePayees: [
        buildPayee({ id: "payee-1", payoutsEnabled: true }),
        buildPayee({ id: "payee-2", payoutsEnabled: false }),
      ],
    });

    await expect(
      publishEvent(ctx.deps, buildPublishInput(ctx)),
    ).rejects.toMatchObject({
      code: "precondition_failed",
      message: "payee_not_active",
      data: { payeeIds: ["payee-2"] },
    });

    // Activation only happens AFTER every gate passes: the terms stay PENDING.
    expect(ctx.mocks.agreements.activate).not.toHaveBeenCalled();
    await expect(
      ctx.mocks.agreements.getById(PENDING_TERMS_ID),
    ).resolves.toMatchObject({ status: "PENDING" });
  });

  it("still throws primary_agreement_missing for an ARCHIVED-only primary and never touches it", async () => {
    const ARCHIVED_TERMS_ID = "00000000-0000-4000-8000-0000000000bd";
    const ctx = makeContext({
      agreements: [
        buildAgreement({
          id: ARCHIVED_TERMS_ID,
          kind: "PRIMARY",
          status: "ARCHIVED",
        }),
      ],
      payee: { id: DEFAULT_PAYEE_ID, subjectType: "ORGANIZATION" },
    });

    await expect(
      publishEvent(ctx.deps, buildPublishInput(ctx)),
    ).rejects.toMatchObject({ code: "PRIMARY_AGREEMENT_MISSING" });

    // ARCHIVED is never a candidate: no activation attempt, row untouched,
    // and the linked-row guard keeps auto-provision from minting a duplicate.
    expect(ctx.mocks.agreements.activate).not.toHaveBeenCalled();
    expect(ctx.mocks.agreements.provisionDefaultPrimary).not.toHaveBeenCalled();
    await expect(
      ctx.mocks.agreements.getById(ARCHIVED_TERMS_ID),
    ).resolves.toMatchObject({ status: "ARCHIVED" });
  });

  it("does not attempt activation (or write a duplicate audit row) for an already-ACTIVE primary", async () => {
    const ctx = makeContext();

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
    expect(ctx.mocks.agreements.activate).not.toHaveBeenCalled();
    expect(ctx.mocks.audit.log).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "activated" }),
    );
  });

  it("tolerates losing the activation CAS to a concurrent activation (row re-reads ACTIVE)", async () => {
    const PENDING_TERMS_ID = "00000000-0000-4000-8000-0000000000be";
    const ctx = makeContext({
      agreements: [
        buildAgreement({
          id: PENDING_TERMS_ID,
          kind: "PRIMARY",
          status: "PENDING",
        }),
      ],
    });

    // Simulate a concurrent transaction winning the CAS: our write matches 0
    // rows (null), but the re-read sees the row ACTIVE.
    const stored = await ctx.mocks.agreements.getById(PENDING_TERMS_ID);
    expect(stored).not.toBeNull();
    ctx.mocks.agreements.activate.mockImplementationOnce(async () => {
      ctx.mocks.agreements.getById.mockResolvedValueOnce({
        ...stored!,
        status: "ACTIVE",
      });
      return null;
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
    // The concurrent winner owns the audit trail — no row from this publish.
    expect(ctx.mocks.audit.log).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "activated" }),
    );
  });

  it("fails publish when the activation CAS misses and the row is no longer usable", async () => {
    const PENDING_TERMS_ID = "00000000-0000-4000-8000-0000000000bf";
    const ctx = makeContext({
      agreements: [
        buildAgreement({
          id: PENDING_TERMS_ID,
          kind: "PRIMARY",
          status: "PENDING",
        }),
      ],
    });

    // CAS misses and the re-read shows the row was concurrently ARCHIVED.
    const stored = await ctx.mocks.agreements.getById(PENDING_TERMS_ID);
    expect(stored).not.toBeNull();
    ctx.mocks.agreements.activate.mockImplementationOnce(async () => {
      ctx.mocks.agreements.getById.mockResolvedValueOnce({
        ...stored!,
        status: "ARCHIVED",
      });
      return null;
    });

    await expect(
      publishEvent(ctx.deps, buildPublishInput(ctx)),
    ).rejects.toMatchObject({ code: "PRIMARY_AGREEMENT_MISSING" });
    expect(ctx.mocks.events.publish).not.toHaveBeenCalled();
  });

  it("publishes with PENDING resale terms (presence-only check) and leaves them PENDING", async () => {
    // Org resale defaults are created PENDING; the resale gate only checks
    // that `resalePayoutTermsId` is set, never the status. Publish must
    // neither block on nor activate resale terms.
    const RESALE_TERMS_ID = "00000000-0000-4000-8000-0000000000c0";
    const ctx = makeContext({
      event: { resalePayoutTermsId: RESALE_TERMS_ID },
      agreements: [
        buildAgreement({}),
        buildAgreement({
          id: RESALE_TERMS_ID,
          kind: "RESALE",
          status: "PENDING",
          resaleShareType: "FLAT",
          resaleShareCents: 300,
          resaleSharePayer: "BUYER",
        }),
      ],
      agreementLines: resaleLineFor(RESALE_TERMS_ID),
      ticketTypes: [buildTicketType({ resaleAllowed: true })],
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
    expect(ctx.mocks.agreements.activate).not.toHaveBeenCalled();
    await expect(
      ctx.mocks.agreements.getById(RESALE_TERMS_ID),
    ).resolves.toMatchObject({ status: "PENDING" });
  });

  it("requires agreement lines to exist", async () => {
    // Default primary is ACTIVE: the lineless-draft seeding repair applies
    // only to PENDING drafts, so an ACTIVE lineless row still hard-fails.
    const ctx = makeContext({ agreementLines: { [DEFAULT_AGREEMENT_ID]: [] } });

    await expect(
      publishEvent(ctx.deps, buildPublishInput(ctx)),
    ).rejects.toMatchObject({ code: "AGREEMENT_MISSING_LINES" });
    expect(ctx.mocks.agreements.seedLinesIfEmpty).not.toHaveBeenCalled();
  });

  // ── Lineless fee-mode-only drafts (setEventFeeMode shell repair) ─────────
  // setEventFeeMode auto-creates a LINELESS PENDING primary and links it when
  // an event has no terms yet. ensureDefaultPrimaryPayoutTerms refuses linked
  // rows, so publish seeds the default 100%-owner line itself when the owner
  // has a usable payee.

  it("seeds a default 100% owner line into a lineless PENDING primary and publishes", async () => {
    const FEE_MODE_SHELL_ID = "00000000-0000-4000-8000-0000000000c3";
    const ctx = makeContext({
      agreements: [
        buildAgreement({
          id: FEE_MODE_SHELL_ID,
          kind: "PRIMARY",
          status: "PENDING",
        }),
      ],
      agreementLines: { [FEE_MODE_SHELL_ID]: [] },
      payee: { id: DEFAULT_PAYEE_ID, subjectType: "ORGANIZATION" },
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
    expect(ctx.mocks.agreements.seedLinesIfEmpty).toHaveBeenCalledWith(
      FEE_MODE_SHELL_ID,
      [
        {
          payeeId: DEFAULT_PAYEE_ID,
          percent: 100,
          floorCents: 0,
          capPercent: null,
          priority: 0,
          rounding: "FLOOR",
          requiresConfirmation: false,
        },
      ],
    );
    expect(ctx.mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "payoutTerms",
        entityId: FEE_MODE_SHELL_ID,
        action: "lines_seeded",
        data: expect.objectContaining({
          reason: "seeded_default_owner_line_at_publish",
          eventId: ctx.defaults.eventId,
          payeeId: DEFAULT_PAYEE_ID,
        }),
      }),
    );
    // No duplicate agreement is minted — the shell itself is repaired…
    expect(ctx.mocks.agreements.provisionDefaultPrimary).not.toHaveBeenCalled();
    // …and then activated like any other validated PENDING primary.
    expect(ctx.mocks.agreements.activate).toHaveBeenCalledWith({
      payoutTermsId: FEE_MODE_SHELL_ID,
      expectedFrom: ["PENDING"],
    });
    await expect(
      ctx.mocks.agreements.getById(FEE_MODE_SHELL_ID),
    ).resolves.toMatchObject({ status: "ACTIVE" });
  });

  it("does not overwrite lines that appear concurrently: gates run against the real lines (valid → publishes)", async () => {
    const FEE_MODE_SHELL_ID = "00000000-0000-4000-8000-0000000000c7";
    const ctx = makeContext({
      agreements: [
        buildAgreement({
          id: FEE_MODE_SHELL_ID,
          kind: "PRIMARY",
          status: "PENDING",
        }),
      ],
      agreementLines: { [FEE_MODE_SHELL_ID]: [] },
      payee: { id: DEFAULT_PAYEE_ID, subjectType: "ORGANIZATION" },
    });

    // Simulate a concurrent updateEventSplits commit landing between the
    // empty listLines read and the conditional insert: the atomic seed
    // 0-matches (returns false) and the organizer's real lines survive.
    const concurrentLines = [
      buildAgreementLine({
        id: "concurrent-line-1",
        percent: 60,
        payeeId: "payee-1",
        requiresConfirmation: true,
        confirmationStatus: "CONFIRMED",
      }),
      buildAgreementLine({
        id: "concurrent-line-2",
        percent: 40,
        payeeId: "payee-2",
        requiresConfirmation: true,
        confirmationStatus: "CONFIRMED",
      }),
    ];
    ctx.mocks.agreements.seedLinesIfEmpty.mockImplementationOnce(async () => {
      (ctx.mocks.agreements as any).__setLines(
        FEE_MODE_SHELL_ID,
        concurrentLines,
      );
      return false;
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
    // The seed did NOT clobber the concurrent lines, and no seed audit row.
    await expect(
      ctx.mocks.agreements.listLines(FEE_MODE_SHELL_ID),
    ).resolves.toEqual(concurrentLines);
    expect(ctx.mocks.audit.log).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "lines_seeded" }),
    );
    // The real (valid, fully-confirmed) lines passed the gates → activated.
    expect(ctx.mocks.agreements.activate).toHaveBeenCalledWith({
      payoutTermsId: FEE_MODE_SHELL_ID,
      expectedFrom: ["PENDING"],
    });
  });

  it("does not overwrite lines that appear concurrently: gates run against the real lines (invalid → blocked)", async () => {
    const FEE_MODE_SHELL_ID = "00000000-0000-4000-8000-0000000000c8";
    const ctx = makeContext({
      agreements: [
        buildAgreement({
          id: FEE_MODE_SHELL_ID,
          kind: "PRIMARY",
          status: "PENDING",
        }),
      ],
      agreementLines: { [FEE_MODE_SHELL_ID]: [] },
      payee: { id: DEFAULT_PAYEE_ID, subjectType: "ORGANIZATION" },
    });

    // Concurrent lines that DON'T reconcile (80% total): proves the gates
    // evaluated the organizer's real lines, not the would-be seeded 100%
    // owner line.
    ctx.mocks.agreements.seedLinesIfEmpty.mockImplementationOnce(async () => {
      (ctx.mocks.agreements as any).__setLines(FEE_MODE_SHELL_ID, [
        buildAgreementLine({
          id: "concurrent-line-1",
          percent: 80,
          payeeId: "payee-1",
          requiresConfirmation: true,
          confirmationStatus: "CONFIRMED",
        }),
      ]);
      return false;
    });

    await expect(
      publishEvent(ctx.deps, buildPublishInput(ctx)),
    ).rejects.toMatchObject({
      code: "precondition_failed",
      message: "splits_total_invalid",
      data: { totalAllocatedPct: 80, targetPct: 100 },
    });

    expect(ctx.mocks.audit.log).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "lines_seeded" }),
    );
    expect(ctx.mocks.agreements.activate).not.toHaveBeenCalled();
    await expect(
      ctx.mocks.agreements.getById(FEE_MODE_SHELL_ID),
    ).resolves.toMatchObject({ status: "PENDING" });
  });

  it("still throws agreement_missing_lines for a lineless PENDING primary when the owner has no usable payee", async () => {
    const FEE_MODE_SHELL_ID = "00000000-0000-4000-8000-0000000000c4";
    const ctx = makeContext({
      agreements: [
        buildAgreement({
          id: FEE_MODE_SHELL_ID,
          kind: "PRIMARY",
          status: "PENDING",
        }),
      ],
      agreementLines: { [FEE_MODE_SHELL_ID]: [] },
      // Free-only tickets so the Stripe guard doesn't fire first; no payee →
      // seeding can't resolve a payout target and falls through.
      payee: null,
      ticketTypes: [buildTicketType({ priceCents: 0 })],
    });

    await expect(
      publishEvent(ctx.deps, buildPublishInput(ctx)),
    ).rejects.toMatchObject({ code: "AGREEMENT_MISSING_LINES" });

    expect(ctx.mocks.agreements.seedLinesIfEmpty).not.toHaveBeenCalled();
    expect(ctx.mocks.agreements.activate).not.toHaveBeenCalled();
  });

  // Booking-managed terms: the fence is NARROWED, not dropped (venue-
  // confirmation follow-up). A requester with no payout-ready Payee at accept
  // gets a bare draft; finalize activates it lineless; without a repair here
  // publish dead-ends at AGREEMENT_MISSING_LINES with no editor left to fix
  // it. Zero lines is not a negotiated position, so the owner line is seeded.
  it.each(["PENDING", "ACTIVE"] as const)(
    "seeds the 100%-owner line into LINELESS booking-managed terms (%s) when the owner has a payout-ready payee, and publishes",
    async (status) => {
      const BOOKING_TERMS_ID = "00000000-0000-4000-8000-0000000000c5";
      const ctx = makeContext({
        agreements: [buildAgreement({ id: BOOKING_TERMS_ID, kind: "PRIMARY", status })],
        agreementLines: { [BOOKING_TERMS_ID]: [] },
      });
      ctx.mocks.agreements.getByPayoutTermsId.mockResolvedValue({ id: "booking-agreement-1" } as never);

      const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

      expect(result.status).toBe("PUBLISHED");
      expect(ctx.mocks.agreements.seedLinesIfEmpty).toHaveBeenCalledWith(BOOKING_TERMS_ID, [
        expect.objectContaining({ percent: 100, requiresConfirmation: false }),
      ]);
      expect(ctx.mocks.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "lines_seeded",
          data: expect.objectContaining({
            reason: "seeded_owner_line_on_lineless_booking_terms_at_publish",
            bookingAgreementId: "booking-agreement-1",
          }),
        }),
      );
    },
  );

  it("lineless booking-managed terms whose owner has NO payout-ready payee still fail AGREEMENT_MISSING_LINES (the non-booking owner's outcome)", async () => {
    const BOOKING_TERMS_ID = "00000000-0000-4000-8000-0000000000c5";
    const ctx = makeContext({
      agreements: [buildAgreement({ id: BOOKING_TERMS_ID, kind: "PRIMARY", status: "ACTIVE" })],
      agreementLines: { [BOOKING_TERMS_ID]: [] },
      payee: null,
      ticketTypes: [buildTicketType({ priceCents: 0 })],
    });
    ctx.mocks.agreements.getByPayoutTermsId.mockResolvedValue({ id: "booking-agreement-1" } as never);

    await expect(publishEvent(ctx.deps, buildPublishInput(ctx))).rejects.toMatchObject({ code: "AGREEMENT_MISSING_LINES" });
    expect(ctx.mocks.agreements.seedLinesIfEmpty).not.toHaveBeenCalled();
  });

  it("never REWRITES booking-managed terms that carry a line (the fence still holds)", async () => {
    const BOOKING_TERMS_ID = "00000000-0000-4000-8000-0000000000c5";
    const ctx = makeContext({
      agreements: [buildAgreement({ id: BOOKING_TERMS_ID, kind: "PRIMARY", status: "ACTIVE" })],
      agreementLines: { [BOOKING_TERMS_ID]: [buildAgreementLine({ agreementId: BOOKING_TERMS_ID, percent: 100 })] },
    });
    ctx.mocks.agreements.getByPayoutTermsId.mockResolvedValue({ id: "booking-agreement-1" } as never);

    await publishEvent(ctx.deps, buildPublishInput(ctx));
    expect(ctx.mocks.agreements.seedLinesIfEmpty).not.toHaveBeenCalled();
  });

  it("a non-booking ACTIVE primary with zero lines is NOT seeded (only PENDING organizer drafts are)", async () => {
    const ACTIVE_ID = "00000000-0000-4000-8000-0000000000c6";
    const ctx = makeContext({
      agreements: [buildAgreement({ id: ACTIVE_ID, kind: "PRIMARY", status: "ACTIVE" })],
      agreementLines: { [ACTIVE_ID]: [] },
    });
    await expect(publishEvent(ctx.deps, buildPublishInput(ctx))).rejects.toMatchObject({ code: "AGREEMENT_MISSING_LINES" });
    expect(ctx.mocks.agreements.seedLinesIfEmpty).not.toHaveBeenCalled();
  });

  // Negotiated terms are never bypassed: an ACCEPTED booking agreement that
  // is not finalize-linked to this event refuses the publish — otherwise the
  // auto-provision below would mint fresh 100%-owner terms over the deal.
  describe("BOOKING_TERMS_NOT_FINALIZED", () => {
    const AGREEMENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const REQUEST = "44444444-4444-4444-8444-444444444444";
    function withThread(ctx: PublishEventTestContext, agreement: Record<string, unknown>) {
      ctx.mocks.agreements.findByLinkedEventId.mockResolvedValue({
        id: AGREEMENT,
        status: "ACCEPTED",
        payoutTermsId: "00000000-0000-4000-8000-0000000000c7",
        // The venue counterparty is ANOTHER org by default: the fixture
        // event (owned by DEFAULT_ORG_ID) is the REQUESTER's.
        counterpartyType: "organization",
        counterpartyId: "99999999-9999-4999-8999-999999999999",
        ...agreement,
      } as never);
      const originalTx = ctx.deps.repos.tx;
      ctx.deps.repos.tx = vi.fn(async <T,>(fn: (tx: TxRepos) => Promise<T>): Promise<T> =>
        originalTx(async (tx) => {
          Object.assign(tx, {
            bookingRequests: {
              getById: vi.fn(async () => null),
              findByAgreementId: vi.fn(async () => ({ id: REQUEST, assigneeHumanId: null, status: "ACCEPTED", agreementId: AGREEMENT })),
              touchLastMessageAt: vi.fn(async () => undefined),
            },
            bookingRequestMessages: createFakeBookingRequestMessagesRepo(),
          });
          return fn(tx);
        }),
      ) as typeof originalTx;
    }

    it("REQUESTER-owned: an ACCEPTED agreement anchoring this event as an UNFINALIZED draft refuses the publish: nothing provisioned, nothing published", async () => {
      const ctx = makeContext({ agreements: [] });
      withThread(ctx, { eventId: null, draftEventId: DEFAULT_EVENT_ID });

      await expect(publishEvent(ctx.deps, buildPublishInput(ctx))).rejects.toMatchObject({
        code: "BOOKING_TERMS_NOT_FINALIZED",
        meta: { eventId: DEFAULT_EVENT_ID, agreementId: AGREEMENT, bookingRequestId: REQUEST },
      });
      expect(ctx.mocks.events.publish).not.toHaveBeenCalled();
      expect(ctx.mocks.agreements.listByEvent).not.toHaveBeenCalled();
      expect(ctx.mocks.idempotency.commit).not.toHaveBeenCalled();
    });

    // The pre-existing VENUE-owned PERFORM flow is untouched: venue accepts,
    // the mint's finalize is blocked (lines_unconfirmed / payee_not_ready),
    // the venue publishes its own show now and finalizes later.
    it("VENUE-owned event (the agreement's counterparty org owns it) with an ACCEPTED, unfinalized agreement — finalize blocked by lines_unconfirmed — still publishes", async () => {
      const ctx = makeContext();
      withThread(ctx, {
        eventId: null,
        draftEventId: DEFAULT_EVENT_ID,
        counterpartyType: "organization",
        counterpartyId: DEFAULT_ORG_ID,
      });
      const result = await publishEvent(ctx.deps, buildPublishInput(ctx));
      expect(result.status).toBe("PUBLISHED");
    });

    it("a venue-HUMAN counterparty who owns the event publishes too; the same human publishing as the REQUESTER (counterparty is another human) is refused", async () => {
      // The publishing actor owns the event in both cases (publish's own
      // access gate); what differs is whether that human is the agreement's
      // venue counterparty.
      const owned = makeContext({ event: { orgId: null, humanId: DEFAULT_ACTOR_ID } });
      withThread(owned, { eventId: null, draftEventId: DEFAULT_EVENT_ID, counterpartyType: "human", counterpartyId: DEFAULT_ACTOR_ID });
      await expect(publishEvent(owned.deps, buildPublishInput(owned))).resolves.toMatchObject({ status: "PUBLISHED" });

      const requester = makeContext({ event: { orgId: null, humanId: DEFAULT_ACTOR_ID } });
      withThread(requester, { eventId: null, draftEventId: DEFAULT_EVENT_ID, counterpartyType: "human", counterpartyId: "31313131-3131-4131-8131-313131313131" });
      await expect(publishEvent(requester.deps, buildPublishInput(requester))).rejects.toMatchObject({ code: "BOOKING_TERMS_NOT_FINALIZED" });
    });

    it("finalize-linked (agreement.eventId === event.id) publishes as normal", async () => {
      const ctx = makeContext();
      withThread(ctx, { eventId: DEFAULT_EVENT_ID, draftEventId: null });
      const result = await publishEvent(ctx.deps, buildPublishInput(ctx));
      expect(result.status).toBe("PUBLISHED");
    });

    it.each(["DRAFT", "PROPOSED", "FULFILLED"] as const)("a %s agreement is not the ACCEPTED-but-unlinked case: publishes", async (status) => {
      const ctx = makeContext();
      withThread(ctx, { status, eventId: null, draftEventId: DEFAULT_EVENT_ID });
      await expect(publishEvent(ctx.deps, buildPublishInput(ctx))).resolves.toMatchObject({ status: "PUBLISHED" });
    });
  });

  it("throws when no fee policy can be resolved", async () => {
    const ctx = makeContext({
      resolvedPolicies: { EVENT: null, ORG: null, GLOBAL: null },
    });

    await expect(
      publishEvent(ctx.deps, buildPublishInput(ctx)),
    ).rejects.toMatchObject({ code: "FEE_POLICY_NOT_FOUND" });
  });

  // ── Free events don't need a fee policy ──────────────────────────────────
  //
  // The gate above used to fire unconditionally. On prod the FIRST EVER publish
  // attempt died on it, because the platform had no FeePolicy row yet — and the
  // fee policy is PLATFORM configuration, so the organizer had no way to clear
  // the error. For an event whose every tier is free, no money will ever move
  // and no fee will ever be charged, so the policy is not a precondition of
  // anything. It stays a hard precondition for a paid event.

  const NO_POLICIES = { EVENT: null, ORG: null, GLOBAL: null } as const;

  it("publishes a FREE event when no fee policy resolves at any scope", async () => {
    const ctx = makeContext({
      resolvedPolicies: { ...NO_POLICIES },
      ticketTypes: [buildTicketType({ priceCents: 0 })],
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
    expect(ctx.mocks.events.publish).toHaveBeenCalled();
    // Nothing resolved, so nothing may be pinned — a pin of a non-existent
    // policy id would be a dangling FK at checkout.
    expect(ctx.mocks.agreements.pinFeePolicy).not.toHaveBeenCalled();
  });

  it("still PINS the resolved policy on a free event when one does resolve", async () => {
    // A free event that later flips a tier to paid must already carry the
    // policy version that was in force at publish.
    const ctx = makeContext({
      ticketTypes: [buildTicketType({ priceCents: 0 })],
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
    expect(ctx.mocks.agreements.pinFeePolicy).toHaveBeenCalledWith({
      payoutTermsId: ctx.defaults.agreementId,
      feePolicyId: ctx.defaults.feePolicy.id,
    });
  });

  it("STILL throws for a $0-now / $20-at-T tier with no fee policy", async () => {
    const ctx = makeContext({
      resolvedPolicies: { ...NO_POLICIES },
      ticketTypes: [
        buildTicketType({
          priceCents: 0,
          scheduledPriceCents: 2000,
          scheduledPriceAt: new Date("2026-12-01T00:00:00.000Z"),
        }),
      ],
    });

    await expect(
      publishEvent(ctx.deps, buildPublishInput(ctx)),
    ).rejects.toMatchObject({ code: "FEE_POLICY_NOT_FOUND" });

    expect(ctx.mocks.events.publish).not.toHaveBeenCalled();
  });

  it("STILL throws for an ADJUSTABLE (pay-what-you-want) tier with no fee policy", async () => {
    const ctx = makeContext({
      resolvedPolicies: { ...NO_POLICIES },
      ticketTypes: [
        buildTicketType({ priceCents: 0, pricingMode: "ADJUSTABLE" }),
      ],
    });

    await expect(
      publishEvent(ctx.deps, buildPublishInput(ctx)),
    ).rejects.toMatchObject({ code: "FEE_POLICY_NOT_FOUND" });
  });

  it("a MIXED event (one free tier, one paid) is treated as paid", async () => {
    const ctx = makeContext({
      resolvedPolicies: { ...NO_POLICIES },
      ticketTypes: [
        buildTicketType({ id: "tt-free", priceCents: 0 }),
        buildTicketType({ id: "tt-paid", name: "VIP", priceCents: 5000 }),
      ],
    });

    await expect(
      publishEvent(ctx.deps, buildPublishInput(ctx)),
    ).rejects.toMatchObject({ code: "FEE_POLICY_NOT_FOUND" });
  });

  describe("missing-fee-policy reporting", () => {
    // A missing GLOBAL policy is OUR misconfiguration and the organizer cannot
    // fix it, so it must be visible to us on both branches. The free branch is
    // a deliberate swallow (publish proceeds anyway), which is precisely the
    // case CLAUDE.md's error convention requires a ReporterPort for — a bare
    // `logger.warn` is NOT captured by Sentry.

    it("reports the unresolved policy when a FREE event publishes anyway", async () => {
      const reportError = vi.fn();
      const ctx = makeContext({
        resolvedPolicies: { ...NO_POLICIES },
        ticketTypes: [buildTicketType({ priceCents: 0 })],
        reportError,
      });

      const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

      expect(result.status).toBe("PUBLISHED");
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: expect.objectContaining({
            useCase: "publishEvent",
            outcome: "published_free",
          }),
          extra: expect.objectContaining({
            eventId: ctx.defaults.eventId,
            hasPaidTickets: false,
          }),
        }),
      );
    });

    it("reports the unresolved policy on the PAID branch before throwing", async () => {
      const reportError = vi.fn();
      const ctx = makeContext({
        resolvedPolicies: { ...NO_POLICIES },
        reportError,
      });

      await expect(
        publishEvent(ctx.deps, buildPublishInput(ctx)),
      ).rejects.toMatchObject({ code: "FEE_POLICY_NOT_FOUND" });

      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: expect.objectContaining({ outcome: "blocked_publish" }),
          extra: expect.objectContaining({ hasPaidTickets: true }),
        }),
      );
    });

    it("a THROWING reporter never breaks the free publish", async () => {
      const reportError = vi.fn(() => {
        throw new Error("sentry is down too");
      });
      const ctx = makeContext({
        resolvedPolicies: { ...NO_POLICIES },
        ticketTypes: [buildTicketType({ priceCents: 0 })],
        reportError,
      });

      await expect(
        publishEvent(ctx.deps, buildPublishInput(ctx)),
      ).resolves.toMatchObject({ status: "PUBLISHED" });
      expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("publishes the free event when no reporter is wired at all", async () => {
      const ctx = makeContext({
        resolvedPolicies: { ...NO_POLICIES },
        ticketTypes: [buildTicketType({ priceCents: 0 })],
      });

      await expect(
        publishEvent(ctx.deps, buildPublishInput(ctx)),
      ).resolves.toMatchObject({ status: "PUBLISHED" });
    });

    it("does not report when a policy resolves normally", async () => {
      const reportError = vi.fn();
      const ctx = makeContext({ reportError });

      await publishEvent(ctx.deps, buildPublishInput(ctx));

      expect(reportError).not.toHaveBeenCalled();
    });

    it("rethrows a per-scope REPO FAILURE from the scope walk instead of publishing on GLOBAL", async () => {
      // The walk used to swallow a failing EVENT read and fall through to
      // GLOBAL. Inside `repos.tx` that could never work (the session is
      // aborted after the first failed statement), so the swallow only ever
      // produced a fabricated `null` and a misleading FEE_POLICY_NOT_FOUND.
      // The fault now propagates — as `dependency_failed` wrapping the cause —
      // and is reported against the scope that broke.
      const boom = new Error("connection terminated unexpectedly");
      const reportError = vi.fn();
      const globalPolicy = buildFeePolicy({
        id: "00000000-0000-4000-8000-0000000000f1",
        scopeType: "GLOBAL",
        scopeId: null,
      });
      const ctx = makeContext({
        reportError,
        resolvedPolicies: { GLOBAL: globalPolicy },
      });
      ctx.mocks.feePolicies.resolveEffective.mockRejectedValueOnce(boom);

      await expect(
        publishEvent(ctx.deps, buildPublishInput(ctx)),
      ).rejects.toMatchObject({ code: "dependency_failed", cause: boom });

      // Stopped at EVENT; ORG and GLOBAL were never read, nothing was pinned,
      // nothing was published.
      expect(ctx.mocks.feePolicies.resolveEffective).toHaveBeenCalledTimes(1);
      expect(ctx.mocks.agreements.pinFeePolicy).not.toHaveBeenCalled();
      expect(ctx.mocks.events.publish).not.toHaveBeenCalled();
      expect(reportError).toHaveBeenCalledWith(
        boom,
        expect.objectContaining({
          tags: expect.objectContaining({
            resolver: "resolveScopedFeePolicy",
            scopeType: "EVENT",
            source: "publishEvent",
          }),
        }),
      );
    });
  });

  // ── Stripe connectivity guard ─────────────────────────────────────────

  it("rejects a paid org event when chargeback terms are not accepted", async () => {
    const ctx = makeContext({ chargebackTermsAccepted: false });

    await expect(
      publishEvent(ctx.deps, {
        actorHumanId: ctx.defaults.actorHumanId,
        eventId: ctx.defaults.eventId,
        clientKey: ctx.defaults.clientKey,
      }),
    ).rejects.toMatchObject({
      code: "chargeback_terms_required",
      message: "chargeback_terms_required",
    });

    expect(ctx.mocks.events.publish).not.toHaveBeenCalled();
  });

  it("publishes a paid org event when chargeback terms are current", async () => {
    const ctx = makeContext({ chargebackTermsAccepted: true });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
    expect(ctx.mocks.events.publish).toHaveBeenCalledTimes(1);
  });

  // Publish is a VERSION-AGNOSTIC backstop. The strict current-version gate
  // sits at Stripe Connect onboarding; bumping the terms version must never
  // block an owner who accepted an older version from publishing.
  it("publishes a paid org event when the chargeback acceptance is a stale version", async () => {
    const ctx = makeContext({ chargebackTermsAccepted: "stale" });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
    expect(ctx.mocks.events.publish).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.organizations.getById).toHaveBeenCalledWith(
      DEFAULT_ORG_ID,
    );
  });

  it("publishes a direct human paid event when the chargeback acceptance is a stale version", async () => {
    const ctx = makeContext({
      chargebackTermsAccepted: "stale",
      event: { orgId: null, humanId: DEFAULT_ACTOR_ID },
      payee: { subjectType: "HUMAN", subjectId: DEFAULT_ACTOR_ID },
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
    expect(ctx.mocks.events.publish).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.humans.getById).toHaveBeenCalledWith(DEFAULT_ACTOR_ID);
  });

  it("rejects a direct human paid event when chargeback terms are not accepted", async () => {
    const ctx = makeContext({
      chargebackTermsAccepted: false,
      event: { orgId: null, humanId: DEFAULT_ACTOR_ID },
      payee: { subjectType: "HUMAN", subjectId: DEFAULT_ACTOR_ID },
    });

    await expect(
      publishEvent(ctx.deps, {
        actorHumanId: ctx.defaults.actorHumanId,
        eventId: ctx.defaults.eventId,
        clientKey: ctx.defaults.clientKey,
      }),
    ).rejects.toMatchObject({
      code: "chargeback_terms_required",
      message: "chargeback_terms_required",
    });

    expect(ctx.mocks.events.publish).not.toHaveBeenCalled();
  });

  it("rejects publishing paid tickets without a connected Stripe account", async () => {
    const ctx = makeContext({
      ticketTypes: [buildTicketType({ priceCents: 2000 })],
      payee: null,
    });

    await expect(
      publishEvent(ctx.deps, {
        actorHumanId: ctx.defaults.actorHumanId,
        eventId: ctx.defaults.eventId,
        clientKey: ctx.defaults.clientKey,
      }),
    ).rejects.toMatchObject({ code: "STRIPE_NOT_CONNECTED_OWNER" });
  });

  it("rejects publishing when Stripe payee is not fully active", async () => {
    const ctx = makeContext({
      ticketTypes: [buildTicketType({ priceCents: 2000 })],
      payee: {
        status: "PENDING",
        chargesEnabled: false,
        payoutsEnabled: false,
      },
    });

    await expect(
      publishEvent(ctx.deps, {
        actorHumanId: ctx.defaults.actorHumanId,
        eventId: ctx.defaults.eventId,
        clientKey: ctx.defaults.clientKey,
      }),
    ).rejects.toMatchObject({ code: "STRIPE_NOT_CONNECTED_OWNER" });
  });

  it("allows publishing free-only events without Stripe", async () => {
    const ctx = makeContext({
      ticketTypes: [buildTicketType({ priceCents: 0 })],
      payee: null,
      chargebackTermsAccepted: false,
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEAT PRICE OVERRIDES take money (spec 2026-08-12). Checkout charges a FIXED
// tier's seat at its stored override, so a $0 tier selling a $50 seat is a
// paid event: every money gate (chargeback terms, Stripe, fee policy) applies.
// ─────────────────────────────────────────────────────────────────────────────

describe("publishEvent — a paid seat override on a free tier", () => {
  const NO_POLICIES = { EVENT: null, ORG: null, GLOBAL: null } as const;
  const SECTION = "section-floor";
  const OTHER_SECTION = "section-balcony";
  const freeSeatedTier = (
    overrides: Partial<EventTicketTypeSummary> = {},
  ): EventTicketTypeSummary =>
    buildTicketType({ priceCents: 0, seatSectionId: SECTION, ...overrides });
  const override = (
    priceOverride: SeatSectionPriceOverride["priceOverride"],
    seatSectionId = SECTION,
  ): SeatSectionPriceOverride => ({ seatSectionId, priceOverride });

  it("refuses STRIPE_NOT_CONNECTED_OWNER for a $50 seat on a $0 tier with no payee", async () => {
    const ctx = makeContext({
      ticketTypes: [freeSeatedTier()],
      seatOverrides: [override({ priceCents: 5000, reason: null })],
      payee: null,
    });

    await expect(
      publishEvent(ctx.deps, buildPublishInput(ctx)),
    ).rejects.toMatchObject({ code: "STRIPE_NOT_CONNECTED_OWNER" });

    expect(ctx.mocks.listDistinctPriceOverridesByEvent).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.listDistinctPriceOverridesByEvent).toHaveBeenCalledWith({
      eventId: ctx.defaults.eventId,
    });
    expect(ctx.mocks.events.publish).not.toHaveBeenCalled();
  });

  it("refuses FEE_POLICY_NOT_FOUND for a $50 seat on a $0 tier when no fee policy resolves", async () => {
    const reportError = vi.fn();
    const ctx = makeContext({
      ticketTypes: [freeSeatedTier()],
      seatOverrides: [override({ priceCents: 5000, reason: null })],
      resolvedPolicies: { ...NO_POLICIES },
      reportError,
    });

    await expect(
      publishEvent(ctx.deps, buildPublishInput(ctx)),
    ).rejects.toMatchObject({ code: "FEE_POLICY_NOT_FOUND" });

    expect(ctx.mocks.events.publish).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ outcome: "blocked_publish" }),
        extra: expect.objectContaining({ hasPaidTickets: true }),
      }),
    );
  });

  it("refuses an owner with no chargeback terms for a $50 seat on a $0 tier", async () => {
    const ctx = makeContext({
      ticketTypes: [freeSeatedTier()],
      seatOverrides: [override({ priceCents: 5000, reason: null })],
      chargebackTermsAccepted: false,
    });

    await expect(
      publishEvent(ctx.deps, buildPublishInput(ctx)),
    ).rejects.toMatchObject({ code: "chargeback_terms_required" });
  });

  it("publishes a $50 seat on a $0 tier when Stripe and the fee policy are in place", async () => {
    const ctx = makeContext({
      ticketTypes: [freeSeatedTier()],
      seatOverrides: [override({ priceCents: 5000, reason: null })],
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
  });

  it("a $0 override alone keeps the event free (no Stripe, no fee policy, no terms)", async () => {
    const reportError = vi.fn();
    const ctx = makeContext({
      ticketTypes: [freeSeatedTier()],
      seatOverrides: [override({ priceCents: 0, reason: null })],
      payee: null,
      chargebackTermsAccepted: false,
      resolvedPolicies: { ...NO_POLICIES },
      reportError,
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ outcome: "published_free" }),
      }),
    );
  });

  it("ignores a paid override in a section no FIXED tier sells", async () => {
    const ctx = makeContext({
      ticketTypes: [freeSeatedTier()],
      seatOverrides: [
        override({ priceCents: 5000, reason: null }, OTHER_SECTION),
      ],
      payee: null,
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
  });

  it("counts a corrupt override in a FIXED section as paid, and reports it", async () => {
    const reportError = vi.fn();
    const ctx = makeContext({
      ticketTypes: [freeSeatedTier()],
      seatOverrides: [override({ invalid: true })],
      payee: null,
      reportError,
    });

    // The refusal names its cause: this event is free but for the corrupt
    // value, and "connect Stripe" alone would not tell anyone why.
    await expect(
      publishEvent(ctx.deps, buildPublishInput(ctx)),
    ).rejects.toMatchObject({
      code: "STRIPE_NOT_CONNECTED_OWNER",
      meta: {
        cause: "seat_price_override_invalid",
        seatSectionIds: [SECTION],
      },
    });

    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          useCase: "publishEvent",
          fault: "seat_price_override_invalid",
        }),
        extra: expect.objectContaining({
          eventId: ctx.defaults.eventId,
          seatSectionIds: [SECTION],
        }),
      }),
    );
  });

  it("the Stripe refusal carries no cause when a valid paid override is why the event takes money", async () => {
    const paidOnly = makeContext({
      ticketTypes: [freeSeatedTier()],
      seatOverrides: [override({ priceCents: 5000, reason: null })],
      payee: null,
    });
    const paidAndCorrupt = makeContext({
      ticketTypes: [freeSeatedTier()],
      seatOverrides: [
        override({ priceCents: 5000, reason: null }),
        override({ invalid: true }),
      ],
      payee: null,
    });

    for (const ctx of [paidOnly, paidAndCorrupt]) {
      const refusal = await publishEvent(
        ctx.deps,
        buildPublishInput(ctx),
      ).catch((err: unknown) => err);
      expect(refusal).toMatchObject({ code: "STRIPE_NOT_CONNECTED_OWNER" });
      expect((refusal as { meta?: unknown }).meta).toBeUndefined();
    }
  });

  it("counts a negative override amount as corrupt, hence paid", async () => {
    const ctx = makeContext({
      ticketTypes: [freeSeatedTier()],
      seatOverrides: [override({ priceCents: -100, reason: null })],
      payee: null,
    });

    await expect(
      publishEvent(ctx.deps, buildPublishInput(ctx)),
    ).rejects.toMatchObject({ code: "STRIPE_NOT_CONNECTED_OWNER" });
  });

  it("a throwing reporter does not change the corrupt-override verdict", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry is down");
    });
    const ctx = makeContext({
      ticketTypes: [freeSeatedTier()],
      seatOverrides: [override({ invalid: true })],
      payee: null,
      reportError,
    });

    await expect(
      publishEvent(ctx.deps, buildPublishInput(ctx)),
    ).rejects.toMatchObject({ code: "STRIPE_NOT_CONNECTED_OWNER" });
    expect(reportError).toHaveBeenCalled();
  });

  it("ignores a corrupt override in a section no FIXED tier sells, unreported", async () => {
    const reportError = vi.fn();
    const ctx = makeContext({
      ticketTypes: [freeSeatedTier()],
      seatOverrides: [override({ invalid: true }, OTHER_SECTION)],
      payee: null,
      reportError,
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
    expect(reportError).not.toHaveBeenCalled();
  });

  it("does not read the seats when no tier sells a section at a FIXED price", async () => {
    const ctx = makeContext({
      ticketTypes: [buildTicketType({ priceCents: 0 })],
      seatOverrides: [override({ priceCents: 5000, reason: null })],
      payee: null,
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
    expect(ctx.mocks.listDistinctPriceOverridesByEvent).not.toHaveBeenCalled();
  });

  it("does not read the seats when a tier already takes money", async () => {
    const ctx = makeContext({
      ticketTypes: [freeSeatedTier({ priceCents: 2000 })],
      seatOverrides: [override({ priceCents: 5000, reason: null })],
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
    expect(ctx.mocks.listDistinctPriceOverridesByEvent).not.toHaveBeenCalled();
  });

  // The path step 7e closes, run through the real use cases. The override is
  // already stored on the section (its write and gates are pinned in
  // set-seat-price-overrides-guards.test.ts) and the organizer has no payee
  // now. Unassigning the tier makes publish see a free event, correctly: no
  // tier sells the section. Assigning it back is what would put the $50 seat
  // on sale, so that write is the one refused.
  it("override stored, tier unassigned, published as free: assigning the tier back is refused", async () => {
    const TIER_ID = "00000000-0000-4000-8000-0000000007e1";
    const SECTION_ID = "00000000-0000-4000-8000-0000000007e2";
    const tier = buildTicketType({
      id: TIER_ID,
      priceCents: 0,
      seatSectionId: SECTION_ID,
    });
    const ctx = makeContext({
      ticketTypes: [tier],
      seatOverrides: [override({ priceCents: 5000, reason: null }, SECTION_ID)],
      payee: null,
    });
    // The publish harness has no tier store; give it one over `tier`.
    Object.assign(ctx.mocks.tickets, {
      getTicketTypeById: vi.fn(async (id: string) =>
        id === tier.id ? { ...tier, eventId: ctx.defaults.eventId } : null,
      ),
      updateTicketType: vi.fn(
        async (patch: { seatSectionId?: string | null }) => {
          if (patch.seatSectionId !== undefined) {
            tier.seatSectionId = patch.seatSectionId;
          }
          return { ...tier, eventId: ctx.defaults.eventId };
        },
      ),
    });
    ctx.mocks.tickets.activateDraftTicketTypes.mockImplementation(async () => {
      tier.status = "ACTIVE";
      return 1;
    });
    // Nor a section store, which the assign reads to check the section is
    // this event's. `repos.seats` is the object the transaction sees too.
    Object.assign(ctx.deps.repos.seats, {
      listSectionsByEvent: vi.fn(async (eventId: string) =>
        eventId === ctx.defaults.eventId
          ? [
              {
                id: SECTION_ID,
                name: "Floor",
                type: "RESERVED",
                capacity: 50,
                layoutSectionId: null,
                placeLayoutId: null,
              },
            ]
          : [],
      ),
    });
    const assignDeps = { repos: ctx.deps.repos, clock: ctx.deps.clock };
    const assign = (seatSectionId: string | null) =>
      assignTicketTypeSections(assignDeps, {
        actorHumanId: ctx.defaults.actorHumanId,
        eventId: ctx.defaults.eventId,
        assignments: [{ ticketTypeId: TIER_ID, seatSectionId }],
      });

    // While the tier sells the section, publish refuses: the event takes money.
    await expect(
      publishEvent(ctx.deps, buildPublishInput(ctx)),
    ).rejects.toMatchObject({ code: "STRIPE_NOT_CONNECTED_OWNER" });

    // An unassign is never refused, payee or not.
    await expect(assign(null)).resolves.toMatchObject({ updated: 1 });
    expect(tier.seatSectionId).toBeNull();

    // Now nothing sells the section, and the event publishes as free.
    const published = await publishEvent(ctx.deps, {
      ...buildPublishInput(ctx),
      clientKey: "publish-after-unassign",
    });
    expect(published.status).toBe("PUBLISHED");
    expect(tier.status).toBe("ACTIVE");

    // Assigning the tier back would start charging the stored $50.
    ctx.mocks.events.getById.mockClear();
    await expect(assign(SECTION_ID)).rejects.toMatchObject({
      code: "PAID_TICKETING_REQUIRES_STRIPE",
      meta: { cause: "stored_seat_price", seatSectionIds: [SECTION_ID] },
    });
    expect(tier.seatSectionId).toBeNull();
    // The refusal is the PUBLISHED branch: the event the assign read is the
    // one publish left behind, where only ACTIVE tiers count.
    expect(ctx.mocks.events.getById).toHaveBeenCalledTimes(1);
    const eventAssignRead = (await ctx.mocks.events.getById.mock.results[0]!
      .value) as { status: string };
    expect(eventAssignRead.status).toBe("PUBLISHED");

    // And it is that branch deciding: had publish not activated the tier, it
    // would sell nothing on the published event and the assign would pass.
    // (On a DRAFT event the same tier is gated, so this cannot pass there.)
    tier.status = "DRAFT";
    await expect(assign(SECTION_ID)).resolves.toMatchObject({ updated: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BOOKING TIMELINE — `booking_event.published`. A show minted from an
// agreement logs "published" on its booking thread, inside the publish tx;
// every other event writes nothing. Cancel/complete live in
// booking-event-lifecycle.test.ts; this one rides the publish harness above.
// ─────────────────────────────────────────────────────────────────────────────
describe("publishEvent — booking_event.published", () => {
  const BOOKING_AGREEMENT_ID = "00000000-0000-4000-8000-0000000000aa";
  const BOOKING_REQUEST_ID = "00000000-0000-4000-8000-0000000000bb";

  /**
   * Point the harness at a BOOKED event. `ctx.deps.repos.tx` closes over a
   * private txRepos object, so the booking-side repos are attached to
   * whatever `tx` hands out — same object the use case sees.
   */
  function linkToBooking(
    ctx: PublishEventTestContext,
    options: { linked?: boolean } = {},
  ) {
    const linked = options.linked ?? true;
    const messages = createFakeBookingRequestMessagesRepo();
    const findByLinkedEventId = vi.fn(async () =>
      linked ? { id: BOOKING_AGREEMENT_ID, eventId: DEFAULT_EVENT_ID } : null,
    );
    const bookingRequests = {
      findByAgreementId: vi.fn(async () =>
        linked ? { id: BOOKING_REQUEST_ID } : null,
      ),
      touchLastMessageAt: vi.fn(async () => undefined),
    };
    const originalTx = ctx.deps.repos.tx;
    ctx.deps.repos.tx = vi.fn(
      async <T>(fn: (tx: TxRepos) => Promise<T>): Promise<T> =>
        originalTx(async (tx) => {
          (tx.agreements as unknown as Record<string, unknown>).findByLinkedEventId =
            findByLinkedEventId;
          Object.assign(tx, {
            bookingRequests,
            bookingRequestMessages: messages,
          });
          return fn(tx);
        }),
    ) as typeof originalTx;
    return {
      findByLinkedEventId,
      tx: ctx.deps.repos.tx as ReturnType<typeof vi.fn>,
      entries: () =>
        [...messages.rows.values()].filter((row) => row.systemKind),
    };
  }

  it("writes the entry with the start snapshotted, inside the publish tx", async () => {
    const ctx = makeContext({ event: { locationMode: "EXACT" } });
    const ledger = linkToBooking(ctx);

    const result = await publishEvent(
      ctx.deps,
      buildPublishInput(ctx, { attestation: undefined }),
    );

    expect(result.status).toBe("PUBLISHED");
    expect(ledger.entries()).toHaveLength(1);
    expect(ledger.entries()[0]).toMatchObject({
      bookingRequestId: BOOKING_REQUEST_ID,
      authorSide: "SYSTEM",
      authorHumanId: DEFAULT_ACTOR_ID,
      systemKind: "booking_event.published",
      systemData: {
        eventId: DEFAULT_EVENT_ID,
        // ISO STRING, never a Date — systemData is a Json column.
        startsAt: "2025-02-01T20:00:00.000Z",
      },
    });
    // The entry and the PUBLISHED row commit together: one transaction.
    expect(ledger.tx).toHaveBeenCalledTimes(1);
  });

  it("writes nothing for an event that never came from a booking — and still publishes", async () => {
    const ctx = makeContext({ event: { locationMode: "EXACT" } });
    const ledger = linkToBooking(ctx, { linked: false });

    const result = await publishEvent(
      ctx.deps,
      buildPublishInput(ctx, { attestation: undefined }),
    );

    expect(result.status).toBe("PUBLISHED");
    expect(ledger.entries()).toEqual([]);
    // Two thread walks per publish, both bounded (unique-index probes): the
    // BOOKING_TERMS_NOT_FINALIZED gate in ensureAgreementsReady, then the
    // ledger's own. Never one per row.
    expect(ledger.findByLinkedEventId).toHaveBeenCalledTimes(2);
  });

  it("does not re-log on the idempotent already-PUBLISHED return", async () => {
    const ctx = makeContext({
      event: {
        locationMode: "EXACT",
        status: "PUBLISHED",
        publishedAt: new Date("2024-12-31T00:00:00.000Z"),
      },
    });
    const ledger = linkToBooking(ctx);

    await publishEvent(ctx.deps, buildPublishInput(ctx, { attestation: undefined }));

    // Nothing transitioned, so nothing is recorded — a ledger that logs
    // "published" on every re-submit is noise, not history.
    expect(ledger.entries()).toEqual([]);
    expect(ledger.findByLinkedEventId).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FR-018 — a publish TAKES its date from the holds on its calendar. The line
// mechanics are pinned by the helper's own suite; here the helper's writes
// are asserted through the same fakes, inside publish's tx, and the refusal
// is shown to leave the event a DRAFT.
// ─────────────────────────────────────────────────────────────────────────────

describe("publishEvent — FR-018 held dates", () => {
  const CALENDAR_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const PLACE_ID = "33333333-3333-4333-8333-333333333333";
  const REQUEST_A = "44444444-4444-4444-8444-444444444444";
  const REQUEST_B = "45454545-4545-4545-8545-454545454545";
  const ASSIGNEE_ID = "12121212-1212-4121-8121-121212121212";
  /** 20:00 America/Chicago (CST) on 2025-02-01 — the template's startsAt is 20:00Z = 14:00 CST, same day. */
  const HELD_DATE = "2025-02-01";

  function withHolds(ctx: PublishEventTestContext, options: { provenanceRequestId?: string | null; placeStatus?: "ACTIVE" | "SUSPENDED"; placeOrgIds?: string[] } = {}) {
    const bookingHolds = createFakeBookingHoldsRepo();
    const messages = createFakeBookingRequestMessagesRepo();
    const requests = new Map<string, { id: string; assigneeHumanId: string | null; status: string; agreementId: string | null }>([
      [REQUEST_A, { id: REQUEST_A, assigneeHumanId: ASSIGNEE_ID, status: "ACCEPTED", agreementId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
      [REQUEST_B, { id: REQUEST_B, assigneeHumanId: null, status: "PENDING", agreementId: null }],
    ]);
    const provenance = options.provenanceRequestId ?? null;
    const extra = {
      bookingHolds,
      bookingRequestMessages: messages,
      bookingRequests: {
        getById: vi.fn(async (id: string) => requests.get(id) ?? null),
        findByAgreementId: vi.fn(async () => (provenance ? requests.get(provenance) : null)),
        touchLastMessageAt: vi.fn(async () => undefined),
      },
      calendars: { findById: vi.fn(async (id: string) => (id === CALENDAR_ID ? { id, placeId: PLACE_ID } : null)) },
      places: {
        getById: vi.fn(async (id: string) =>
          id === PLACE_ID
            ? { id, timezone: "America/Chicago", status: options.placeStatus ?? "ACTIVE", orgIdsWithAccess: options.placeOrgIds ?? [DEFAULT_ORG_ID], humanIdsWithAccess: [] }
            : null,
        ),
      },
      eventDates: { listByEvent: vi.fn(async () => []) },
      authz: { ...ctx.mocks.authz, getOrgMemberships: vi.fn(async () => []) },
    };
    const findByLinkedEventId = vi.fn(async () =>
      provenance ? { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", eventId: DEFAULT_EVENT_ID } : null,
    );
    const originalTx = ctx.deps.repos.tx;
    ctx.deps.repos.tx = vi.fn(
      async <T>(fn: (tx: TxRepos) => Promise<T>): Promise<T> =>
        originalTx(async (tx) => {
          (tx.agreements as unknown as Record<string, unknown>).findByLinkedEventId = findByLinkedEventId;
          Object.assign(tx, extra);
          return fn(tx);
        }),
    ) as typeof originalTx;
    return {
      bookingHolds,
      extra,
      seedHold: (bookingRequestId: string, overrides: Record<string, unknown> = {}) =>
        bookingHolds.seed({ bookingRequestId, calendarId: CALENDAR_ID, date: HELD_DATE, ...overrides }),
      entries: (requestId: string) =>
        [...messages.rows.values()].filter((r) => r.bookingRequestId === requestId && r.systemKind).map((r) => ({ kind: r.systemKind, data: r.systemData })),
    };
  }

  const onCalendar = { locationMode: "EXACT" as const, placeId: PLACE_ID, calendarId: CALENDAR_ID };

  it("draft → publish on a held calendar+date releases every hold (EVENT_SCHEDULED) and returns the intents + hint", async () => {
    const ctx = makeContext({ event: onCalendar });
    const holds = withHolds(ctx);
    const a = holds.seedHold(REQUEST_A);
    const b = holds.seedHold(REQUEST_B);

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx, { attestation: undefined }));

    expect(result.status).toBe("PUBLISHED");
    expect(ctx.mocks.events.publish).toHaveBeenCalledTimes(1);
    expect(holds.bookingHolds.rows.get(a.id)).toMatchObject({ status: "RELEASED", releasedReason: "EVENT_SCHEDULED" });
    expect(holds.bookingHolds.rows.get(b.id)).toMatchObject({ status: "RELEASED", releasedReason: "EVENT_SCHEDULED" });
    expect(holds.entries(REQUEST_A)).toEqual([{ kind: "booking_hold.released", data: { holdId: a.id, reason: "EVENT_SCHEDULED" } }]);
    expect(result.notificationIntents?.map((i) => [i.kind, i.audience, i.holdId])).toEqual([
      ["hold.released", "act", a.id],
      ["hold.released", "staff", a.id],
      ["hold.released", "act", b.id],
      ["hold.released", "staff", b.id],
    ]);
    expect(result.staffRecipientHint).toEqual({
      assigneeHumanId: null,
      placedByHumanId: ctx.defaults.actorHumanId,
      orgId: DEFAULT_ORG_ID,
      placeId: PLACE_ID,
    });
  });

  it("the event's own booking request holds the date → CONFIRMED with the event id on the ledger; competitors lose the date", async () => {
    const ctx = makeContext({ event: onCalendar });
    const holds = withHolds(ctx, { provenanceRequestId: REQUEST_A });
    const own = holds.seedHold(REQUEST_A);
    const competitor = holds.seedHold(REQUEST_B);

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx, { attestation: undefined }));

    expect(holds.bookingHolds.rows.get(own.id)).toMatchObject({ status: "CONFIRMED" });
    expect(holds.bookingHolds.rows.get(competitor.id)).toMatchObject({ status: "RELEASED", releasedReason: "CONFIRMED_OTHER" });
    expect(holds.entries(REQUEST_A).map((e) => e.kind)).toEqual([
      "booking_hold.confirmed",
      "booking_event.published",
    ]);
    expect(holds.entries(REQUEST_A)[0]).toEqual({ kind: "booking_hold.confirmed", data: { holdId: own.id, eventId: DEFAULT_EVENT_ID } });
    expect(result.notificationIntents?.map((i) => i.kind)).toEqual(["hold.confirmed", "hold.lost_date"]);
    expect(result.staffRecipientHint?.assigneeHumanId).toBe(ASSIGNEE_ID);
  });

  it("an OPEN challenge on another hold refuses the publish: HOLD_LINE_HAS_OPEN_CHALLENGE, the tx (status write included) is refused, idempotency failed", async () => {
    const ctx = makeContext({ event: onCalendar });
    const holds = withHolds(ctx);
    const challenged = holds.seedHold(REQUEST_B, { status: "CHALLENGED", challengedAt: ctx.defaults.now, respondBy: new Date("2025-01-03T00:00:00.000Z") });

    await expect(publishEvent(ctx.deps, buildPublishInput(ctx, { attestation: undefined }))).rejects.toMatchObject({
      code: "HOLD_LINE_HAS_OPEN_CHALLENGE",
      meta: { holdId: null, challengedHoldId: challenged.id, calendarId: CALENDAR_ID, date: HELD_DATE },
    });

    // The status write now precedes the settle (row lock before line locks)
    // and rolls back with it: the fake tx is passthrough, so what is pinned
    // is that the SAME tx refused (failed idempotency, no commit, no hold
    // written) — in production the UPDATE is undone by the rollback.
    expect(ctx.mocks.events.publish).toHaveBeenCalledTimes(1);
    expect(holds.bookingHolds.updateStatus).not.toHaveBeenCalled();
    expect(holds.bookingHolds.rows.get(challenged.id)?.status).toBe("CHALLENGED");
    expect(ctx.mocks.idempotency.fail).toHaveBeenCalled();
    expect(ctx.mocks.idempotency.commit).not.toHaveBeenCalled();
    expect(ctx.mocks.audit.log).not.toHaveBeenCalledWith(expect.objectContaining({ action: "published" }));
  });

  // Booking-holds spec (locked 2026-09-07): only a VENUE-OWNED or
  // VENUE-CONFIRMED published event takes a line. A third-party publish at a
  // venue that has not confirmed it settles NOTHING and does not throw — the
  // venue's confirmation takes the line later (confirmVenueEvent).
  it("an UNCONFIRMED third-party event (owner not on the place, no stamp) publishes without touching a hold: no access check, no hold read, no throw", async () => {
    const ctx = makeContext({ event: onCalendar });
    const holds = withHolds(ctx, { placeOrgIds: ["99999999-9999-4999-8999-999999999999"] });
    const a = holds.seedHold(REQUEST_A);

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx, { attestation: undefined }));

    expect(result.status).toBe("PUBLISHED");
    expect(ctx.mocks.events.publish).toHaveBeenCalledTimes(1);
    expect(holds.extra.authz.getOrgMemberships).not.toHaveBeenCalled();
    expect(holds.bookingHolds.listForRequest).not.toHaveBeenCalled();
    expect(holds.bookingHolds.lockLine).not.toHaveBeenCalled();
    expect(holds.bookingHolds.listLine).not.toHaveBeenCalled();
    expect(holds.bookingHolds.rows.get(a.id)?.status).toBe("ACTIVE");
    expect("notificationIntents" in result).toBe(false);
  });

  it("a VENUE-CONFIRMED third-party event (active stamp for this place) takes the line on publish; the owner's place access is not re-checked", async () => {
    const ctx = makeContext({
      event: {
        ...onCalendar,
        venueConfirmedAt: new Date("2024-12-01T00:00:00.000Z"),
        venueConfirmedPlaceId: PLACE_ID,
        venueConfirmedByHumanId: ASSIGNEE_ID,
        venueConfirmationWithdrawnAt: null,
      },
    });
    const holds = withHolds(ctx, { placeOrgIds: ["99999999-9999-4999-8999-999999999999"] });
    const a = holds.seedHold(REQUEST_A);

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx, { attestation: undefined }));

    expect(result.status).toBe("PUBLISHED");
    expect(holds.bookingHolds.rows.get(a.id)).toMatchObject({ status: "RELEASED", releasedReason: "EVENT_SCHEDULED" });
    expect(result.notificationIntents?.map((i) => i.kind)).toEqual(["hold.released", "hold.released"]);
  });

  // The publish↔confirm race: the pre-tx `event` is an UNLOCKED snapshot.
  // Settling on it before the status write let a concurrent confirm stamp
  // the row (and read DRAFT → skip) while publish settled on a stamp-less
  // snapshot (→ skip): PUBLISHED + venue-confirmed with every competitor
  // hold still live. The settle now runs AFTER `tx.events.publish`, on the
  // row that UPDATE returns — which carries whatever committed before the
  // row lock was taken.
  it("a confirmation that lands between publish's read and its status write is honoured: the settle runs on the PUBLISHED row and takes the line", async () => {
    const ctx = makeContext({ event: onCalendar });
    const holds = withHolds(ctx, { placeOrgIds: ["99999999-9999-4999-8999-999999999999"] });
    const a = holds.seedHold(REQUEST_A);
    // The row `publish` hands back is what the DB has under the row lock: a
    // confirm that committed first has stamped it by then.
    const original = ctx.mocks.events.publish.getMockImplementation()!;
    ctx.mocks.events.publish.mockImplementation(async (input) => {
      const row = await original(input);
      return {
        ...row,
        venueConfirmedAt: new Date("2024-12-31T00:00:00.000Z"),
        venueConfirmedPlaceId: PLACE_ID,
        venueConfirmationWithdrawnAt: null,
      };
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx, { attestation: undefined }));

    expect(result.status).toBe("PUBLISHED");
    // Order pinned: the row write BEFORE the first line lock.
    const publishOrder = ctx.mocks.events.publish.mock.invocationCallOrder[0]!;
    const lockOrder = holds.bookingHolds.lockLine.mock.invocationCallOrder[0]!;
    expect(publishOrder).toBeLessThan(lockOrder);
    expect(holds.bookingHolds.rows.get(a.id)).toMatchObject({ status: "RELEASED", releasedReason: "EVENT_SCHEDULED" });
    expect(result.notificationIntents?.map((i) => i.kind)).toEqual(["hold.released", "hold.released"]);
  });

  it("a WITHDRAWN confirmation reads as unconfirmed: the third-party publish takes nothing", async () => {
    const ctx = makeContext({
      event: {
        ...onCalendar,
        venueConfirmedAt: new Date("2024-12-01T00:00:00.000Z"),
        venueConfirmedPlaceId: PLACE_ID,
        venueConfirmationWithdrawnAt: new Date("2024-12-02T00:00:00.000Z"),
      },
    });
    const holds = withHolds(ctx, { placeOrgIds: ["99999999-9999-4999-8999-999999999999"] });
    const a = holds.seedHold(REQUEST_A);

    await publishEvent(ctx.deps, buildPublishInput(ctx, { attestation: undefined }));

    expect(holds.bookingHolds.lockLine).not.toHaveBeenCalled();
    expect(holds.bookingHolds.rows.get(a.id)?.status).toBe("ACTIVE");
  });

  it("the calendar's place is SUSPENDED → PLACE_NOT_ACTIVE before any hold is read; the tx is refused and nothing commits", async () => {
    const ctx = makeContext({ event: onCalendar });
    const holds = withHolds(ctx, { placeStatus: "SUSPENDED" });
    const a = holds.seedHold(REQUEST_A);

    await expect(publishEvent(ctx.deps, buildPublishInput(ctx, { attestation: undefined }))).rejects.toMatchObject({ code: "PLACE_NOT_ACTIVE" });

    // Same rollback posture as the open-challenge case above.
    expect(ctx.mocks.events.publish).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.idempotency.commit).not.toHaveBeenCalled();
    expect(holds.bookingHolds.lockLine).not.toHaveBeenCalled();
    expect(holds.bookingHolds.listLine).not.toHaveBeenCalled();
    expect(holds.bookingHolds.rows.get(a.id)?.status).toBe("ACTIVE");
  });

  it("an event with no calendar never touches the holds world (no reads)", async () => {
    const ctx = makeContext({ event: { locationMode: "EXACT", placeId: PLACE_ID, calendarId: null } });
    const holds = withHolds(ctx);
    const a = holds.seedHold(REQUEST_A);

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx, { attestation: undefined }));

    expect(result.status).toBe("PUBLISHED");
    expect(holds.extra.calendars.findById).not.toHaveBeenCalled();
    expect(holds.bookingHolds.lockLine).not.toHaveBeenCalled();
    expect(holds.bookingHolds.rows.get(a.id)?.status).toBe("ACTIVE");
    expect("notificationIntents" in result).toBe(false);
  });

  it("an idempotent replay returns the wire shape — no intents re-emitted", async () => {
    const ctx = makeContext({ event: onCalendar });
    const holds = withHolds(ctx);
    holds.seedHold(REQUEST_A);
    const input = buildPublishInput(ctx, { attestation: undefined });

    const first = await publishEvent(ctx.deps, input);
    const replay = await publishEvent(ctx.deps, input);

    expect(first.notificationIntents).toHaveLength(2);
    expect(replay).toEqual({ eventId: ctx.defaults.eventId, status: "PUBLISHED", publishedAt: ctx.defaults.now });
    expect(holds.bookingHolds.lockLine).toHaveBeenCalledTimes(2); // up-front sweep + settleLine's re-entrant lock, ONE run
  });
});

/**
 * Publish-time slug behaviour.
 *
 * Three branches, none of which had a single test before slug-at-create — the
 * publish-time slug ASSIGN was entirely uncovered:
 *
 *   1. no slug        → assign (hard requirement: a live event needs a URL);
 *   2. slug + FIRST publish → re-derive from the final title, old slug to
 *                             history (best-effort);
 *   3. slug + already published before → leave it alone.
 *
 * The fake's `getSlugContext` answers `US / CA / SF` with the event's own
 * title, start, timezone and shortId, so the derived slug is
 * `acme-org/us/sf/<title>-2025-02-01-1400--<shortId>` (20:00Z is 14:00 in
 * the event's America/Chicago).
 *
 * ── WHAT THESE ASSERTIONS DO NOT COVER ────────────────────────────────────
 * The `repos.tx()` fake in this file is `fn => fn(txRepos)`: it models NO
 * transaction. Nothing here rolls back, nothing aborts, and a write that would
 * fail at a real database simply resolves. So every expectation below is about
 * the JAVASCRIPT contract — which repo methods get called, with what, in what
 * order — and is NOT evidence that any of it is durable.
 *
 * That distinction is the whole reason the first-publish re-derive was moved
 * out of the publish transaction. Under a real Postgres, a failed statement
 * aborts the enclosing transaction and the COMMIT is answered with ROLLBACK
 * and no error, which Prisma does not surface — so the in-tx version resolved
 * with `{status: "PUBLISHED"}` for an event that was still DRAFT. These fakes
 * were green for it. Durability is an integration-test question; treat green
 * here as "the code calls the right things", nothing more.
 */
describe("publishEvent — slug", () => {
  const DERIVED_SUFFIX = "-2025-02-01-1400--";

  it("ASSIGNS a slug when the event has none", async () => {
    const ctx = makeContext();

    await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(ctx.mocks.events.assignSlug).toHaveBeenCalledTimes(1);
    const assigned = vi.mocked(ctx.mocks.events.assignSlug).mock.calls[0]![0];
    expect(assigned.slug).toBe(
      `acme-org/us/sf/launch-party${DERIVED_SUFFIX}${assigned.shortId}`,
    );
    expect(assigned.regionCode).toBe("CA");
    expect(ctx.mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "event.slug_assigned" }),
    );
  });

  it("writes NO EventSlugHistory row on the assign path", async () => {
    // The old code recorded the NEW slug here. `EventSlugHistory.slug` is
    // GLOBALLY unique and `regenerateEventSlug` records the PREVIOUS slug, so
    // the first regenerate after a publish hit P2002 on a call that sits
    // outside the try/catch that maps conflicts. History now means one thing:
    // SUPERSEDED slugs.
    const ctx = makeContext();

    await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(ctx.mocks.events.recordSlugHistory).not.toHaveBeenCalled();
  });

  it("RE-DERIVES a create-time slug on the FIRST publish and files the old one", async () => {
    // The create-time slug encodes whatever the title was when the organiser
    // first hit save. The live URL has to reflect the final title.
    const staleSlug = "acme-org/us/sf/untitled-event-2025-02-01-1400--aaaaaaaaaa";
    const ctx = makeContext({
      event: { slug: staleSlug, shortId: "aaaaaaaaaa", publishedAt: null },
    });

    await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(ctx.mocks.events.updateSlug).toHaveBeenCalledTimes(1);
    const updated = vi.mocked(ctx.mocks.events.updateSlug).mock.calls[0]![0];
    expect(updated.slug).toBe(
      "acme-org/us/sf/launch-party-2025-02-01-1400--aaaaaaaaaa",
    );
    // The OLD value goes to history so existing links 307 to the new one.
    expect(ctx.mocks.events.recordSlugHistory).toHaveBeenCalledWith(
      expect.objectContaining({ slug: staleSlug }),
    );
    // `assignSlug` is the no-slug path only — it must not fire here (it would
    // rewrite shortId).
    expect(ctx.mocks.events.assignSlug).not.toHaveBeenCalled();
    expect(ctx.mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "event.slug_rederived_at_publish",
        data: expect.objectContaining({ previousSlug: staleSlug }),
      }),
    );
  });

  it("keeps the shortId stable across the re-derive", async () => {
    const ctx = makeContext({
      event: {
        slug: "acme-org/us/sf/untitled-event-2025-02-01-1400--aaaaaaaaaa",
        shortId: "aaaaaaaaaa",
        publishedAt: null,
      },
    });

    await publishEvent(ctx.deps, buildPublishInput(ctx));

    const updated = vi.mocked(ctx.mocks.events.updateSlug).mock.calls[0]![0];
    expect(updated.slug.endsWith("--aaaaaaaaaa")).toBe(true);
    // `updateSlug`'s input has no shortId field at all — that is the guarantee.
    expect("shortId" in updated).toBe(false);
  });

  it("is a NO-OP when the re-derived slug matches the one it already has", async () => {
    const sameSlug = "acme-org/us/sf/launch-party-2025-02-01-1400--aaaaaaaaaa";
    const ctx = makeContext({
      event: { slug: sameSlug, shortId: "aaaaaaaaaa", publishedAt: null },
    });

    await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(ctx.mocks.events.updateSlug).not.toHaveBeenCalled();
    expect(ctx.mocks.events.recordSlugHistory).not.toHaveBeenCalled();
    expect(ctx.mocks.events.assignSlug).not.toHaveBeenCalled();
  });

  it("LEAVES the slug alone for an event that has been published before", async () => {
    // Unpublished, retitled, re-published. The URL has been shared, indexed
    // and printed — moving it here would break those links for a rename nobody
    // asked to propagate. `regenerateEventSlug` stays the explicit path.
    const liveSlug = "acme-org/us/sf/untitled-event-2025-02-01-1400--aaaaaaaaaa";
    const ctx = makeContext({
      event: {
        slug: liveSlug,
        shortId: "aaaaaaaaaa",
        status: "DRAFT",
        publishedAt: new Date("2024-12-01T00:00:00.000Z"),
      },
    });

    await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(ctx.mocks.events.updateSlug).not.toHaveBeenCalled();
    expect(ctx.mocks.events.assignSlug).not.toHaveBeenCalled();
    expect(ctx.mocks.events.recordSlugHistory).not.toHaveBeenCalled();
  });

  it("re-derives AFTER the publish transaction has committed", async () => {
    // The ordering IS the fix. While this ran inside the publish transaction,
    // a P2002 on the globally-unique `EventSlugHistory.slug` aborted that
    // transaction; Postgres then answered COMMIT with ROLLBACK and no error,
    // Prisma resolved anyway, and `publishEvent` returned PUBLISHED for an
    // event that was still DRAFT — with the response cached under the
    // idempotency key for 120s. Running the re-slug only once the publish is
    // durably committed removes the mechanism entirely.
    const ctx = makeContext({
      event: {
        slug: "acme-org/us/sf/untitled-event-2025-02-01-1400--aaaaaaaaaa",
        shortId: "aaaaaaaaaa",
        publishedAt: null,
      },
    });

    await publishEvent(ctx.deps, buildPublishInput(ctx));

    const commitOrder =
      ctx.mocks.idempotency.__mocks.commit.mock.invocationCallOrder[0]!;
    const historyOrder = vi.mocked(ctx.mocks.events.recordSlugHistory).mock
      .invocationCallOrder[0]!;
    const updateOrder = vi.mocked(ctx.mocks.events.updateSlug).mock
      .invocationCallOrder[0]!;
    const publishOrder = vi.mocked(ctx.mocks.events.publish).mock
      .invocationCallOrder[0]!;

    expect(publishOrder).toBeLessThan(commitOrder);
    expect(historyOrder).toBeGreaterThan(commitOrder);
    expect(updateOrder).toBeGreaterThan(commitOrder);
  });

  it("PUBLISHES ANYWAY when the re-derive fails, and REPORTS it", async () => {
    // Everything the re-derive touches is cosmetic — the event already has a
    // working, unique URL. Refusing a publish over it would be strictly worse
    // for an organiser whose tickets go on sale the moment this returns.
    const reportError = vi.fn();
    const ctx = makeContext({
      event: {
        slug: "acme-org/us/sf/untitled-event-2025-02-01-1400--aaaaaaaaaa",
        shortId: "aaaaaaaaaa",
        publishedAt: null,
      },
      reportError,
    });
    const boom = new Error("history write failed");
    vi.mocked(ctx.mocks.events.recordSlugHistory).mockRejectedValueOnce(boom);

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
    expect(reportError).toHaveBeenCalled();
    const call = reportError.mock.calls.find(
      ([, context]) => context?.tags?.stage === "rederive_slug_at_publish",
    );
    expect(call).toBeDefined();
    expect(call![0]).toBe(boom);
    expect(call![1]?.tags?.useCase).toBe("publishEvent");
  });

  it("does NOT re-derive when the slug context yields no country code", async () => {
    const ctx = makeContext({
      event: {
        slug: "acme-org/us/sf/untitled-event-2025-02-01-1400--aaaaaaaaaa",
        shortId: "aaaaaaaaaa",
        publishedAt: null,
      },
      reportError: vi.fn(),
    });
    vi.mocked(ctx.mocks.events.getSlugContext).mockImplementationOnce(
      async () => ({
        eventId: ctx.defaults.eventId,
        orgId: DEFAULT_ORG_ID,
        humanId: null,
        eventTitle: "Launch Party",
        startsAt: new Date("2025-02-01T20:00:00.000Z"),
        orgName: DEFAULT_ORG_NAME,
        countryCode: null,
        regionCode: null,
        cityOrRegionCode: null,
        shortId: "aaaaaaaaaa",
      }),
    );

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
    expect(ctx.mocks.events.updateSlug).not.toHaveBeenCalled();
    // EVENT_LOCATION_REQUIRED is an EXPECTED outcome, not an incident.
    expect(ctx.deps.reportError).not.toHaveBeenCalled();
  });
});

describe("publication follower outbox", () => {
  function spyOnEnqueue(ctx: ReturnType<typeof makeContext>) {
    const enqueue = vi.fn();
    const originalTx = ctx.deps.repos.tx;
    ctx.deps.repos.tx = fn => originalTx(tx => {
      tx.entityPages.getByOwner = vi.fn(async () => ({id:"owner-page",ownerType:"ORGANIZATION",ownerId:DEFAULT_ORG_ID,visibility:"PUBLIC",allowFollows:true} as any));
      tx.entityEventNotices.enqueue = enqueue;
      return fn(tx);
    });
    return enqueue;
  }
  it.each([null, "acme-org/us/sf/preexisting-slug--aaaaaaaaaa"])("enqueues first publication with slug %s inside the mutation transaction", async slug => {
    const ctx = makeContext({event:{slug,publishedAt:null,visibility:"PUBLIC"}});
    const enqueue = spyOnEnqueue(ctx);
    await publishEvent(ctx.deps,buildPublishInput(ctx));
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith({entityPageId:"owner-page",eventId:DEFAULT_EVENT_ID,at:ctx.defaults.now});
  });
  it("does NOT enqueue a re-publication (the event was published before)", async () => {
    const ctx = makeContext({event:{publishedAt:new Date("2024-12-31T00:00:00.000Z"),visibility:"PUBLIC"}});
    const enqueue = spyOnEnqueue(ctx);
    await publishEvent(ctx.deps,buildPublishInput(ctx));
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("does NOT enqueue a gated first publication", async () => {
    const ctx = makeContext({event:{publishedAt:null,visibility:"PUBLIC",gateType:"PASSWORD"}});
    const enqueue = spyOnEnqueue(ctx);
    await publishEvent(ctx.deps,buildPublishInput(ctx));
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("publishEvent — W1: a publisher who MANAGES the place stamps the venue confirmation", () => {
  const PLACE_ID = "00000000-0000-4000-8000-0000000000a1";
  const SARAH_PERSONALLY = "00000000-0000-4000-8000-0000000000a2";
  /** A withheld house owned by a HUMAN — not by the event's org. */
  const house = {
    id: PLACE_ID,
    name: "Sarah's House",
    slug: null,
    formattedAddress: "901 Porter Rd",
    addressLine1: "901 Porter Rd",
    addressLine2: null,
    city: "Nashville",
    region: "TN",
    postalCode: "37206",
    countryCode: "US",
    admissionTaxRateBps: 925,
    taxRateSource: "fake",
    taxRateFetchedAt: new Date("2024-12-01T00:00:00.000Z"),
    timezone: "America/Chicago",
    capacity: null,
    lat: 36.1862,
    lng: -86.7291,
    phone: null,
    website: null,
    status: "ACTIVE",
    verificationStatus: "VERIFIED",
    listedInDirectory: false,
    acceptsBookingRequests: false,
    acceptsCommunityListings: false,
    locationMode: "OBSCURED",
    locationRadiusMeters: 500,
    orgIdsWithAccess: [],
    humanIdsWithAccess: [SARAH_PERSONALLY],
    defaultPrimaryPayoutTermsId: null,
    defaultResalePayoutTermsId: null,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
  } as unknown as import("@th/ports/repos/places").PlaceRecord;

  it("publisher manages the place → stamped (arm: stamp), with the event's start as the confirmed one", async () => {
    const ctx = makeContext({
      event: { placeId: PLACE_ID, addressText: "Nashville, TN" },
      place: house,
      canManagePlace: true,
    });

    await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(ctx.mocks.canManagePlace).toHaveBeenCalledWith({
      actorHumanId: ctx.defaults.actorHumanId,
      placeId: PLACE_ID,
    });
    const setVenueConfirmation = (
      ctx.mocks.events as unknown as {
        setVenueConfirmation: ReturnType<typeof vi.fn>;
      }
    ).setVenueConfirmation;
    expect(setVenueConfirmation).toHaveBeenCalledWith({
      eventId: ctx.defaults.eventId,
      placeId: PLACE_ID,
      confirmedByHumanId: ctx.defaults.actorHumanId,
      bookingRequestId: null,
      at: ctx.defaults.now,
    });
    const row = await ctx.mocks.events.getById(ctx.defaults.eventId);
    expect(row?.venueConfirmedStartsAt).toEqual(row?.startsAt);
    expect(ctx.mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "event.place_confirmed_by_manager" }),
    );
  });

  it("publisher does NOT manage the place → nothing stamped", async () => {
    const ctx = makeContext({
      event: { placeId: PLACE_ID, addressText: "Nashville, TN" },
      place: house,
      canManagePlace: false,
    });

    await publishEvent(ctx.deps, buildPublishInput(ctx));

    const setVenueConfirmation = (
      ctx.mocks.events as unknown as {
        setVenueConfirmation: ReturnType<typeof vi.fn>;
      }
    ).setVenueConfirmation;
    expect(setVenueConfirmation).not.toHaveBeenCalled();
  });

  it("a venue-owned event (owner arm) is not stamped, even by a manager", async () => {
    const ctx = makeContext({
      event: { placeId: PLACE_ID, addressText: "Nashville, TN" },
      place: { ...house, orgIdsWithAccess: [DEFAULT_ORG_ID] },
      canManagePlace: true,
    });

    await publishEvent(ctx.deps, buildPublishInput(ctx));

    const setVenueConfirmation = (
      ctx.mocks.events as unknown as {
        setVenueConfirmation: ReturnType<typeof vi.fn>;
      }
    ).setVenueConfirmation;
    expect(setVenueConfirmation).not.toHaveBeenCalled();
  });

  it("R3-2: an ACTIVE stamp is left alone at publish — even one for a date the organizer has since moved away from", async () => {
    const ctx = makeContext({
      event: {
        placeId: PLACE_ID,
        addressText: "Nashville, TN",
        venueConfirmedAt: new Date("2024-12-20T00:00:00.000Z"),
        venueConfirmedPlaceId: PLACE_ID,
        venueConfirmationWithdrawnAt: null,
        // Confirmed for a later date than the event's current start.
        venueConfirmedStartsAt: new Date("2025-03-01T20:00:00.000Z"),
      },
      place: house,
      canManagePlace: true,
    });

    await publishEvent(ctx.deps, buildPublishInput(ctx));

    const setVenueConfirmation = (
      ctx.mocks.events as unknown as {
        setVenueConfirmation: ReturnType<typeof vi.fn>;
      }
    ).setVenueConfirmation;
    expect(setVenueConfirmation).not.toHaveBeenCalled();
    const row = await ctx.mocks.events.getById(ctx.defaults.eventId);
    expect(row?.venueConfirmedStartsAt).toEqual(
      new Date("2025-03-01T20:00:00.000Z"),
    );
  });

  it("an event with no place never probes", async () => {
    const ctx = makeContext({ canManagePlace: true });

    await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(ctx.mocks.canManagePlace).not.toHaveBeenCalled();
  });
});

// ── Lineup notices (owner ruling "option A", 2026-09-30) ────────────────────
// publishEvent only RUNS the sweep (awaited, never throwing); which rows are owed, and
// exactly-once, live in event-humans/notify-lineup-notices (tested there).
describe("publishEvent — lineup notice sweep", () => {
  // Inert tx repos that concurrent (uncommitted) workstreams write inside the
  // publish tx; absent from this harness at HEAD. Harmless when unused.
  const lineupCtx = (options?: Parameters<typeof makeContext>[0]) => {
    const ctx = makeContext(options);
    const originalTx = ctx.deps.repos.tx;
    ctx.deps.repos.tx = ((fn: (tx: TxRepos) => unknown) =>
      originalTx((tx) => {
        const t = tx as unknown as Record<string, unknown>;
        t.searchReindexPending ??= { mark: vi.fn(async () => undefined) };
        return fn(tx) as never;
      })) as typeof ctx.deps.repos.tx;
    return ctx;
  };

  it("runs once after a first publish, AWAITED inside the request (Cloud Run starves post-response work)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const dispatch = vi.fn(async () => gate);
    const ctx = lineupCtx();
    ctx.deps.lineupNotices = { dispatch };

    let settled = false;
    const publishing = publishEvent(ctx.deps, buildPublishInput(ctx)).then((r) => {
      settled = true;
      return r;
    });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    expect(dispatch).toHaveBeenCalledWith({
      kind: "published",
      eventId: DEFAULT_EVENT_ID,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false); // still waiting on the sweep
    release();
    await expect(publishing).resolves.toMatchObject({ status: "PUBLISHED" });
  });

  it("fires on a RE-publish too (unpublished events come back as DRAFT)", async () => {
    const dispatch = vi.fn(async () => undefined);
    const ctx = lineupCtx({
      event: { publishedAt: new Date("2024-12-01T00:00:00.000Z") },
    });
    ctx.deps.lineupNotices = { dispatch };

    await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not fire for an already-PUBLISHED echo or an idempotent replay", async () => {
    const dispatch = vi.fn(async () => undefined);
    const already = lineupCtx({
      event: { status: "PUBLISHED", publishedAt: new Date("2024-12-01T00:00:00.000Z") },
    });
    already.deps.lineupNotices = { dispatch };
    await publishEvent(already.deps, buildPublishInput(already));

    const ctx = lineupCtx();
    ctx.deps.lineupNotices = { dispatch };
    await publishEvent(ctx.deps, buildPublishInput(ctx));
    await publishEvent(ctx.deps, buildPublishInput(ctx));
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("a rejecting sweep never fails the publish — it is reported", async () => {
    const reportError = vi.fn();
    const ctx = lineupCtx({ reportError });
    ctx.deps.lineupNotices = {
      dispatch: vi.fn(async () => {
        throw new Error("sweep exploded");
      }),
    };

    await expect(
      publishEvent(ctx.deps, buildPublishInput(ctx)),
    ).resolves.toMatchObject({ status: "PUBLISHED" });

    const lineupReports = () =>
      reportError.mock.calls.filter(
        (c) => (c[1] as { tags?: { stage?: string } })?.tags?.stage === "lineup_notice",
      );
    expect(lineupReports()).toHaveLength(1);
    expect(lineupReports()[0]![1]).toMatchObject({
      tags: { useCase: "publishEvent", stage: "lineup_notice" },
      extra: { eventId: DEFAULT_EVENT_ID },
    });
  });

  it("a hook that throws synchronously, plus a throwing reporter, still never escapes", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    const ctx = lineupCtx({ reportError });
    ctx.deps.lineupNotices = {
      dispatch: vi.fn(() => {
        throw new Error("sync explode");
      }) as never,
    };
    await expect(
      publishEvent(ctx.deps, buildPublishInput(ctx)),
    ).resolves.toMatchObject({ status: "PUBLISHED" });
    expect(reportError).toHaveBeenCalled();
  });
});

// ── ABSORB is removed (docs/decisions/absorb-removed.md) ────────────────────
//
// Publish used to refuse pinning a legacy ABSORB policy onto modeless terms.
// A pin now carries rates only: pricing never reads its mode (SALE_FEE_MODE),
// so an ABSORB row is pinned like any other and nothing is reported.
describe("publishEvent — a legacy ABSORB fee policy is pinned like any other", () => {
  const absorbPolicy = buildFeePolicy({
    id: "absorb-policy",
    scopeType: "ORG",
    scopeId: DEFAULT_ORG_ID,
    feeMode: "ABSORB",
  });

  it("a PAID event, modeless terms + an ABSORB policy in force: publishes, pins, no report", async () => {
    const reportError = vi.fn();
    const ctx = makeContext({
      agreements: [buildAgreement({ feeMode: null })],
      resolvedPolicies: { EVENT: null, ORG: absorbPolicy, GLOBAL: null },
      reportError,
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
    expect(ctx.mocks.agreements.pinFeePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ feePolicyId: "absorb-policy" }),
    );
    expect(reportError).not.toHaveBeenCalled();
  });

  it("a FREE event + an ABSORB policy: publishes PINNED (no unpinned special case)", async () => {
    const ctx = makeContext({
      agreements: [buildAgreement({ feeMode: null })],
      resolvedPolicies: { EVENT: null, ORG: absorbPolicy, GLOBAL: null },
      ticketTypes: [buildTicketType({ priceCents: 0 })],
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
    expect(ctx.mocks.agreements.pinFeePolicy).toHaveBeenCalled();
  });

  it("modeless terms + a PASS_THROUGH policy: pins as before", async () => {
    const ctx = makeContext({
      agreements: [buildAgreement({ feeMode: null })],
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));

    expect(result.status).toBe("PUBLISHED");
    expect(ctx.mocks.agreements.pinFeePolicy).toHaveBeenCalled();
  });

  it("an EXISTING pin is left alone", async () => {
    const ctx = makeContext({
      agreements: [
        buildAgreement({ feeMode: null, feePolicyId: absorbPolicy.id }),
      ],
      existingFeePolicy: absorbPolicy,
    });

    const result = await publishEvent(ctx.deps, buildPublishInput(ctx));
    expect(result.status).toBe("PUBLISHED");
    expect(ctx.mocks.agreements.pinFeePolicy).not.toHaveBeenCalled();
  });
});

// ── Tax rate: the venue moves while publish looks the rate up ──────────────
// publish: reads Place at P1, cache empty → provider → R1
// upsertPlace: commits address P2 + cached R2          ← in between
// publish: writes the cache and stamps the event
// The old code made the provider call INSIDE the publish transaction and then
// wrote `places.updateTaxRate(R1)` unconditionally: the venue sat at P2 with
// P1's rate, and the event was published stamped R1, so every later checkout
// there collected the wrong tax. The interleaving is driven from the fake
// provider; cache writes mutate the row object.
describe("publishEvent — tax rate when the venue moves mid-publish", () => {
  const TAX_PLACE_ID = "00000000-0000-4000-8000-0000000000c1";
  const R1 = { rateBps: 975, source: "ziptax" };
  const R2 = { rateBps: 925, source: "ziptax" };
  const FETCHED_AT_R2 = new Date("2024-12-15T00:00:00.000Z");

  type Row = import("@th/ports/repos/places").PlaceRecord;

  function venue(overrides: Partial<Row> = {}): Row {
    return {
      id: TAX_PLACE_ID,
      name: "The Venue",
      slug: null,
      formattedAddress: "1 Music Row",
      addressLine1: "1 Music Row",
      addressLine2: null,
      city: "Nashville",
      region: "TN",
      postalCode: "37203",
      countryCode: "US",
      admissionTaxRateBps: null,
      taxRateSource: null,
      taxRateFetchedAt: null,
      capacity: null,
      lat: null,
      lng: null,
      phone: null,
      website: null,
      status: "ACTIVE",
      verificationStatus: "VERIFIED",
      listedInDirectory: true,
      acceptsBookingRequests: false,
      orgIdsWithAccess: [],
      humanIdsWithAccess: [],
      defaultPrimaryPayoutTermsId: null,
      defaultResalePayoutTermsId: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
      ...overrides,
    } as Row;
  }

  function taxCtx(
    place: Row,
    eventOverrides: Partial<EventRecord> = {},
  ) {
    const ctx = makeContext({
      event: {
        placeId: TAX_PLACE_ID,
        addressText: "1 Music Row, Nashville, TN",
        ...eventOverrides,
      },
    });
    // Root repos and tx repos share their fakes in this harness; split the
    // place reads so the in-transaction ones can be told apart.
    const placesGetById = vi.fn(async (id: string) =>
      id === place.id ? { ...place } : null,
    );
    const preTxPlacesGetById = vi.fn(async (id: string) =>
      id === place.id ? { ...place } : null,
    );
    const placesUpdateTaxRate = vi.fn(
      async (input: {
        id: string;
        admissionTaxRateBps: number;
        taxRateSource: string;
        taxRateFetchedAt: Date;
      }) => {
        if (input.id !== place.id) return;
        place.admissionTaxRateBps = input.admissionTaxRateBps;
        place.taxRateSource = input.taxRateSource;
        place.taxRateFetchedAt = input.taxRateFetchedAt;
      },
    );
    const placesFillTaxRateIfUnset = vi.fn(
      async (input: {
        id: string;
        expectedPostalCode: string | null;
        expectedCountryCode: string | null;
        admissionTaxRateBps: number;
        taxRateSource: string;
        taxRateFetchedAt: Date;
      }) => {
        if (
          input.id !== place.id ||
          place.admissionTaxRateBps != null ||
          place.postalCode !== input.expectedPostalCode ||
          place.countryCode !== input.expectedCountryCode
        ) {
          return false;
        }
        place.admissionTaxRateBps = input.admissionTaxRateBps;
        place.taxRateSource = input.taxRateSource;
        place.taxRateFetchedAt = input.taxRateFetchedAt;
        return true;
      },
    );
    const lockLocationsAtPlace = vi.fn(async () => undefined);
    const lookupByPostalCode = vi.fn(
      async (): Promise<{ rateBps: number; source: string } | null> => null,
    );

    const txPlaces = {
      getById: placesGetById,
      updateTaxRate: placesUpdateTaxRate,
      fillTaxRateIfUnset: placesFillTaxRateIfUnset,
    };
    const originalTx = ctx.deps.repos.tx;
    const repoTx = vi.fn(<T,>(fn: (tx: TxRepos) => Promise<T>) =>
      originalTx((tx) => {
        const t = tx as unknown as Record<string, unknown>;
        t.places = txPlaces;
        (t.events as Record<string, unknown>).lockLocationsAtPlace =
          lockLocationsAtPlace;
        return fn(tx);
      }),
    );
    ctx.deps = {
      ...ctx.deps,
      repos: {
        ...ctx.deps.repos,
        places: {
          ...txPlaces,
          getById: preTxPlacesGetById,
        } as unknown as Repos["places"],
        tx: repoTx as unknown as Repos["tx"],
      },
      taxRateLookup: { lookupByPostalCode },
    };

    return {
      ctx,
      place,
      repoTx,
      lookupByPostalCode,
      lockLocationsAtPlace,
      placesGetById,
      preTxPlacesGetById,
      placesUpdateTaxRate,
      placesFillTaxRateIfUnset,
    };
  }

  function publishedStamp(ctx: PublishEventTestContext) {
    expect(ctx.mocks.events.publish).toHaveBeenCalledTimes(1);
    const input = ctx.mocks.events.publish.mock.calls[0]![0] as unknown as {
      admissionTaxRateBps: number | null;
      taxRateSource: string | null;
    };
    return {
      admissionTaxRateBps: input.admissionTaxRateBps,
      taxRateSource: input.taxRateSource,
    };
  }

  it("venue moved to P2 with R2 cached: the venue keeps R2 and the event is published stamped R2, never R1", async () => {
    const t = taxCtx(venue());
    t.lookupByPostalCode.mockImplementation(async () => {
      // upsertPlace commits while publish waits on the provider.
      t.place.postalCode = "37206";
      t.place.admissionTaxRateBps = R2.rateBps;
      t.place.taxRateSource = R2.source;
      t.place.taxRateFetchedAt = FETCHED_AT_R2;
      return R1;
    });

    const result = await publishEvent(t.ctx.deps, buildPublishInput(t.ctx));

    expect(result.status).toBe("PUBLISHED");
    expect(t.lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(t.lookupByPostalCode).toHaveBeenCalledWith(expect.objectContaining({
      postalCode: "37203",
      countryCode: "US",
    }));
    expect(t.place).toMatchObject({
      postalCode: "37206",
      admissionTaxRateBps: R2.rateBps,
      taxRateFetchedAt: FETCHED_AT_R2,
    });
    expect(t.placesUpdateTaxRate).not.toHaveBeenCalled();
    expect(publishedStamp(t.ctx)).toEqual({
      admissionTaxRateBps: R2.rateBps,
      taxRateSource: R2.source,
    });
  });

  it("venue moved and the new address has no cached rate: no cache write, published with a NULL stamp for checkout to resolve", async () => {
    const t = taxCtx(venue());
    t.lookupByPostalCode.mockImplementation(async () => {
      t.place.postalCode = "37206";
      return R1;
    });

    const result = await publishEvent(t.ctx.deps, buildPublishInput(t.ctx));

    expect(result.status).toBe("PUBLISHED");
    expect(t.place.admissionTaxRateBps).toBeNull();
    expect(t.placesUpdateTaxRate).not.toHaveBeenCalled();
    expect(publishedStamp(t.ctx)).toEqual({
      admissionTaxRateBps: null,
      taxRateSource: null,
    });
  });

  it("venue moved from TN to TX: an instructional event is not exempted on the OLD address's situs", async () => {
    const t = taxCtx(venue(), { instructionalAdmission: true });
    t.lookupByPostalCode.mockImplementation(async () => {
      t.place.postalCode = "78701";
      t.place.region = "TX";
      t.place.admissionTaxRateBps = 825;
      t.place.taxRateSource = "ziptax";
      return R1;
    });

    await publishEvent(t.ctx.deps, buildPublishInput(t.ctx));

    expect(publishedStamp(t.ctx)).toEqual({
      admissionTaxRateBps: 825,
      taxRateSource: "ziptax",
    });
  });

  it("no race: a fresh lookup is cached by compare-and-set and stamped", async () => {
    const t = taxCtx(venue());
    t.lookupByPostalCode.mockResolvedValue(R1);

    await publishEvent(t.ctx.deps, buildPublishInput(t.ctx));

    expect(t.placesFillTaxRateIfUnset).toHaveBeenCalledWith({
      id: TAX_PLACE_ID,
      expectedPostalCode: "37203",
      expectedCountryCode: "US",
      admissionTaxRateBps: R1.rateBps,
      taxRateSource: R1.source,
      taxRateFetchedAt: t.ctx.defaults.now,
    });
    expect(t.place.admissionTaxRateBps).toBe(R1.rateBps);
    expect(t.placesUpdateTaxRate).not.toHaveBeenCalled();
    expect(publishedStamp(t.ctx)).toEqual({
      admissionTaxRateBps: R1.rateBps,
      taxRateSource: R1.source,
    });
  });

  it("calls the provider BEFORE the transaction opens", async () => {
    const t = taxCtx(venue());
    t.lookupByPostalCode.mockResolvedValue(R1);

    await publishEvent(t.ctx.deps, buildPublishInput(t.ctx));

    expect(t.lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(t.repoTx).toHaveBeenCalledTimes(1);
    expect(t.lookupByPostalCode.mock.invocationCallOrder[0]).toBeLessThan(
      t.repoTx.mock.invocationCallOrder[0]!,
    );
  });

  it("a venue cache fill re-indexes the venue's other unstamped events AFTER the commit", async () => {
    const t = taxCtx(venue());
    t.lookupByPostalCode.mockResolvedValue(R1);
    let committed = false;
    const innerTx = t.ctx.deps.repos.tx;
    t.ctx.deps = {
      ...t.ctx.deps,
      repos: {
        ...t.ctx.deps.repos,
        tx: (async (fn: (tx: TxRepos) => Promise<unknown>) => {
          const out = await innerTx(fn as never);
          committed = true;
          return out;
        }) as unknown as Repos["tx"],
      },
    };
    const committedAtListing: boolean[] = [];
    const listUnstamped = vi.fn(async () => {
      committedAtListing.push(committed);
      return ["sibling-1", "sibling-2"];
    });
    (
      t.ctx.deps.repos.events as unknown as Record<string, unknown>
    ).listUnstampedUpcomingIdsAtTaxLocation = listUnstamped;

    const result = await publishEvent(t.ctx.deps, buildPublishInput(t.ctx));

    expect(result.status).toBe("PUBLISHED");
    expect(t.placesFillTaxRateIfUnset).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(listUnstamped).toHaveBeenCalledTimes(1));
    expect(listUnstamped).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "place", placeId: TAX_PLACE_ID },
      }),
    );
    // Listed only once the publish transaction had committed.
    expect(committedAtListing).toEqual([true]);
  });

  it("a FAILING sibling reindex is reported, never thrown: the publish still succeeds", async () => {
    const reportError = vi.fn();
    const t = taxCtx(venue());
    t.ctx.deps = { ...t.ctx.deps, reportError };
    t.lookupByPostalCode.mockResolvedValue(R1);
    const boom = new Error("listing query failed");
    (
      t.ctx.deps.repos.events as unknown as Record<string, unknown>
    ).listUnstampedUpcomingIdsAtTaxLocation = vi.fn(async () => {
      throw boom;
    });

    const result = await publishEvent(t.ctx.deps, buildPublishInput(t.ctx));

    expect(result.status).toBe("PUBLISHED");
    await vi.waitFor(() =>
      expect(reportError).toHaveBeenCalledWith(
        boom,
        expect.objectContaining({
          tags: { useCase: "publishEvent", op: "reindexEventsAtTaxLocation" },
        }),
      ),
    );
  });

  it("no cache fill (the venue already had a rate) → no sibling reindex", async () => {
    const t = taxCtx(venue({ admissionTaxRateBps: 975, taxRateSource: "ziptax" }));
    const listUnstamped = vi.fn(async () => []);
    (
      t.ctx.deps.repos.events as unknown as Record<string, unknown>
    ).listUnstampedUpcomingIdsAtTaxLocation = listUnstamped;

    await publishEvent(t.ctx.deps, buildPublishInput(t.ctx));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(t.lookupByPostalCode).not.toHaveBeenCalled();
    expect(listUnstamped).not.toHaveBeenCalled();
  });

  it("takes the SHARED place-location lock before the re-read the stamp uses", async () => {
    const t = taxCtx(venue());
    t.lookupByPostalCode.mockResolvedValue(R1);
    // Model upsertPlace holding the EXCLUSIVE lock: it commits P2 + R2 the
    // moment our shared lock is granted. A read taken before the lock still
    // sees P1 and would let the prepared R1 through.
    t.lockLocationsAtPlace.mockImplementation(async () => {
      t.place.postalCode = "37206";
      t.place.admissionTaxRateBps = R2.rateBps;
      t.place.taxRateSource = R2.source;
      t.place.taxRateFetchedAt = FETCHED_AT_R2;
    });

    await publishEvent(t.ctx.deps, buildPublishInput(t.ctx));

    expect(t.lockLocationsAtPlace).toHaveBeenCalledTimes(1);
    expect(t.lockLocationsAtPlace).toHaveBeenCalledWith({
      placeId: TAX_PLACE_ID,
      mode: "shared",
    });
    // R2 exists only after the lock, so a stamp of R2 came from a read made
    // under it.
    expect(publishedStamp(t.ctx)).toEqual({
      admissionTaxRateBps: R2.rateBps,
      taxRateSource: R2.source,
    });
    expect(t.place.admissionTaxRateBps).toBe(R2.rateBps);
    const lockOrder = t.lockLocationsAtPlace.mock.invocationCallOrder[0]!;
    expect(t.placesGetById.mock.invocationCallOrder.length).toBeGreaterThan(0);
    for (const order of t.placesGetById.mock.invocationCallOrder) {
      expect(order).toBeGreaterThan(lockOrder);
    }
    // ...and before any write the transaction makes (upsertPlace takes the
    // advisory lock, then rewrites event rows: the reverse order deadlocks).
    expect(lockOrder).toBeLessThan(
      t.ctx.mocks.events.publish.mock.invocationCallOrder[0]!,
    );
    expect(lockOrder).toBeLessThan(
      t.ctx.mocks.events.listTicketTypes.mock.invocationCallOrder.at(-1)!,
    );
    // Every write the publish makes before its status write, too.
    const earlyWrites = [
      t.ctx.mocks.agreements.seedLinesIfEmpty,
      t.ctx.mocks.agreements.pinFeePolicy,
      t.ctx.mocks.agreements.activate,
      t.ctx.mocks.events.createAttestation,
    ];
    // OBSCURED by default, so at least the attestation write happened.
    expect(
      t.ctx.mocks.events.createAttestation.mock.invocationCallOrder.length,
    ).toBeGreaterThan(0);
    for (const write of earlyWrites) {
      for (const order of write.mock.invocationCallOrder) {
        expect(order).toBeGreaterThan(lockOrder);
      }
    }
  });

  it("the event moved to another venue between the pre-tx read and the tx: the prepared rate is discarded and the stamp comes from the NEW venue's row", async () => {
    const OTHER_PLACE_ID = "00000000-0000-4000-8000-0000000000c2";
    // In the tx the event is at venue B (this harness's place), cached RB.
    const t = taxCtx(
      venue({ admissionTaxRateBps: R2.rateBps, taxRateSource: R2.source }),
    );
    // Before the tx the event still read as at venue A, uncached.
    const placeA = venue({ id: OTHER_PLACE_ID, postalCode: "37206" });
    t.preTxPlacesGetById.mockImplementation(async (id: string) =>
      id === OTHER_PLACE_ID ? { ...placeA } : null,
    );
    const rootEvents = t.ctx.deps.repos.events;
    t.ctx.deps.repos = {
      ...t.ctx.deps.repos,
      events: {
        ...rootEvents,
        getById: vi.fn(async (id: string) => {
          const row = await rootEvents.getById(id);
          return row ? { ...row, placeId: OTHER_PLACE_ID } : null;
        }),
      } as unknown as Repos["events"],
    };
    t.lookupByPostalCode.mockResolvedValue(R1);

    await publishEvent(t.ctx.deps, buildPublishInput(t.ctx));

    // A's lookup happened once, before the transaction...
    expect(t.lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(t.lookupByPostalCode).toHaveBeenCalledWith(expect.objectContaining({
      postalCode: "37206",
      countryCode: "US",
    }));
    expect(t.lookupByPostalCode.mock.invocationCallOrder[0]).toBeLessThan(
      t.repoTx.mock.invocationCallOrder[0]!,
    );
    // ...and was discarded: nothing cached anywhere, B's rate stamped.
    expect(t.placesFillTaxRateIfUnset).not.toHaveBeenCalled();
    expect(t.placesUpdateTaxRate).not.toHaveBeenCalled();
    expect(placeA.admissionTaxRateBps).toBeNull();
    expect(t.lockLocationsAtPlace).toHaveBeenCalledTimes(1);
    expect(t.lockLocationsAtPlace).toHaveBeenCalledWith({
      placeId: TAX_PLACE_ID,
      mode: "shared",
    });
    expect(publishedStamp(t.ctx)).toEqual({
      admissionTaxRateBps: R2.rateBps,
      taxRateSource: R2.source,
    });
  });

  describe("a concurrent save re-points the event to another venue after publish read it in the tx", () => {
    // publish:  in-tx read → event at A; SHARED lock on A
    // save:     (holds SHARED lock on B, re-points the event A → B, commits)
    // publish:  stamps the rate
    //
    // The shared lock on A pins A's ADDRESS, not WHICH venue the event points
    // at. Stamping from the first in-tx read put A's rate on an event at B.
    // The save is modelled as committing the moment publish's lock on A is
    // granted: the earliest point the lock order allows it to land.
    const VENUE_B_ID = "00000000-0000-4000-8000-0000000000c2";
    const RB = { rateBps: 825, source: "ziptax" };

    type EventLocation = Pick<EventRecord, "placeId" | "savedLocationId">;

    function repointCtx(
      opts: {
        before?: EventLocation;
        after?: EventLocation;
        // The lock whose grant the save's commit lands on: the venue lock
        // when publish takes one, else the row lock (it waits the save out).
        commitsAt?: "venue-lock" | "row-lock";
        // The stamp on the row before the move, and whether the move restamps
        // it. An event save does; a template apply or series sync
        // (`upsertDraft`) does not, and leaves the OLD venue's stamp behind.
        stampBefore?: Pick<EventRecord, "admissionTaxRateBps" | "taxRateSource">;
        restamps?: boolean;
      } = {},
    ) {
      const before = opts.before ?? { placeId: TAX_PLACE_ID, savedLocationId: null };
      const after = opts.after ?? { placeId: VENUE_B_ID, savedLocationId: null };
      // Venue A: uncached, so the pre-tx lookup prepares a fresh R1 for it.
      const t = taxCtx(venue());
      const venueB = venue({
        id: VENUE_B_ID,
        postalCode: "78701",
        region: "TX",
        admissionTaxRateBps: RB.rateBps,
        taxRateSource: RB.source,
      });
      t.placesGetById.mockImplementation(async (id: string) =>
        id === TAX_PLACE_ID
          ? { ...t.place }
          : id === VENUE_B_ID
            ? { ...venueB }
            : null,
      );
      t.lookupByPostalCode.mockResolvedValue(R1);

      let pointsAt: EventLocation = before;
      const baseGetById = t.ctx.mocks.events.getById.getMockImplementation()!;
      t.ctx.mocks.events.getById.mockImplementation(async (id: string) => {
        const row = await baseGetById(id);
        return row ? { ...row, ...pointsAt } : null;
      });
      // The save stamped the event from the venue it moved it to, under that
      // venue's lock (B's cached RB; a saved location's 700).
      let rowStamp: Pick<EventRecord, "admissionTaxRateBps" | "taxRateSource"> =
        opts.stampBefore ?? { admissionTaxRateBps: null, taxRateSource: null };
      const baseGetByIdForStamp = t.ctx.mocks.events.getById.getMockImplementation()!;
      t.ctx.mocks.events.getById.mockImplementation(async (id: string) => {
        const row = await baseGetByIdForStamp(id);
        return row ? { ...row, ...rowStamp } : null;
      });
      const saveCommits = async (): Promise<undefined> => {
        pointsAt = after;
        if (opts.restamps ?? true) {
          rowStamp = after.placeId === VENUE_B_ID
            ? { admissionTaxRateBps: RB.rateBps, taxRateSource: RB.source }
            : { admissionTaxRateBps: 700, taxRateSource: "manual" };
        }
        return undefined;
      };
      if ((opts.commitsAt ?? "venue-lock") === "venue-lock") {
        t.lockLocationsAtPlace.mockImplementation(saveCommits);
      } else {
        t.ctx.mocks.events.lockRows.mockImplementation(saveCommits);
      }
      return { t, venueB };
    }

    it("never stamps venue A's rate onto an event that now sits at venue B", async () => {
      const { t, venueB } = repointCtx();

      const result = await publishEvent(t.ctx.deps, buildPublishInput(t.ctx));

      expect(result.status).toBe("PUBLISHED");
      // A's rate was looked up before the tx, for A...
      expect(t.lookupByPostalCode).toHaveBeenCalledTimes(1);
      expect(t.lookupByPostalCode).toHaveBeenCalledWith(expect.objectContaining({
        postalCode: "37203",
        countryCode: "US",
      }));
      // ...and is neither stamped nor cached. Publish holds no lock on B (it
      // cannot take one after the row lock without risking a deadlock with
      // upsertPlace), so it does not read B's place row either. Nor does it
      // trust the row's stamp (not every re-point restamps): it publishes
      // NULL, which checkout re-resolves from B's cache.
      expect(publishedStamp(t.ctx)).toEqual({
        admissionTaxRateBps: null,
        taxRateSource: null,
      });
      expect(
        t.placesGetById.mock.calls.some(([id]) => id === VENUE_B_ID),
      ).toBe(false);
      expect(t.placesFillTaxRateIfUnset).not.toHaveBeenCalled();
      expect(t.placesUpdateTaxRate).not.toHaveBeenCalled();
      expect(t.place.admissionTaxRateBps).toBeNull();
      expect(venueB.admissionTaxRateBps).toBe(RB.rateBps);
    });

    it("row-locks the event FOR UPDATE after the venue lock and before any write, then re-reads it", async () => {
      const { t } = repointCtx();

      await publishEvent(t.ctx.deps, buildPublishInput(t.ctx));

      const events = t.ctx.mocks.events;
      expect(events.lockRows).toHaveBeenCalledTimes(1);
      expect(events.lockRows).toHaveBeenCalledWith({
        ids: [t.ctx.defaults.eventId],
        mode: "update",
      });
      const venueLock = t.lockLocationsAtPlace.mock.invocationCallOrder[0]!;
      const rowLock = events.lockRows.mock.invocationCallOrder[0]!;
      // Venue first, rows second: the order upsertPlace's cascade uses.
      expect(venueLock).toBeLessThan(rowLock);
      // The row the transaction acts on is read right AFTER the row lock:
      // the first read after it comes before the first gate that reads
      // anything else (`ensureTicketTypesReady` → `listTicketTypes`), so it
      // is the row the gates and the stamp use, not some later read.
      const firstReadAfterLock = events.getById.mock.invocationCallOrder.find(
        (order) => order > rowLock,
      );
      const firstTicketTypesRead =
        events.listTicketTypes.mock.invocationCallOrder.find(
          (order) => order > rowLock,
        );
      expect(firstReadAfterLock).toBeDefined();
      expect(firstTicketTypesRead).toBeDefined();
      expect(firstReadAfterLock!).toBeLessThan(firstTicketTypesRead!);
      for (const write of [
        events.createAttestation,
        events.publish,
        t.ctx.mocks.agreements.seedLinesIfEmpty,
        t.ctx.mocks.agreements.pinFeePolicy,
        t.ctx.mocks.agreements.activate,
      ]) {
        for (const order of write.mock.invocationCallOrder) {
          expect(order).toBeGreaterThan(rowLock);
        }
      }
    });

    it("no venue before the lock, venue B after it: no venue lock is held for B, so the stamp is NULL", async () => {
      const { t } = repointCtx({
        before: { placeId: null, savedLocationId: null },
        commitsAt: "row-lock",
      });

      await publishEvent(t.ctx.deps, buildPublishInput(t.ctx));

      expect(t.lockLocationsAtPlace).not.toHaveBeenCalled();
      expect(t.ctx.mocks.events.lockRows).toHaveBeenCalledTimes(1);
      // Neither the row's stamp nor a fresh (unlocked) read of B's place row.
      expect(publishedStamp(t.ctx)).toEqual({
        admissionTaxRateBps: null,
        taxRateSource: null,
      });
      expect(
        t.placesGetById.mock.calls.some(([id]) => id === VENUE_B_ID),
      ).toBe(false);
      expect(t.placesFillTaxRateIfUnset).not.toHaveBeenCalled();
    });

    it("a template-style move (no restamp) leaves venue A's stamp on a row now at venue B: it is NOT published, the stamp is NULL", async () => {
      // A's TN rate was stamped on the draft; a template apply / series sync
      // moved it to B (TX) through `upsertDraft`, which leaves the stamp.
      const { t } = repointCtx({
        stampBefore: { admissionTaxRateBps: 925, taxRateSource: "ziptax" },
        restamps: false,
      });

      await publishEvent(t.ctx.deps, buildPublishInput(t.ctx));

      expect(publishedStamp(t.ctx)).toEqual({
        admissionTaxRateBps: null,
        taxRateSource: null,
      });
      expect(
        t.placesGetById.mock.calls.some(([id]) => id === VENUE_B_ID),
      ).toBe(false);
    });

    it("venue A before the lock, a saved location after it: not NULL — the stamp comes from that location's row, without the provider", async () => {
      const SAVED_ID = "00000000-0000-4000-8000-0000000000d1";
      const { t } = repointCtx({
        after: { placeId: null, savedLocationId: SAVED_ID },
      });
      const savedGetById = vi.fn(async (id: string) =>
        id === SAVED_ID
          ? {
              id: SAVED_ID,
              postalCode: "37206",
              countryCode: "US",
              region: "TN",
              admissionTaxRateBps: 700,
              taxRateSource: "manual",
            }
          : null,
      );
      const innerTx = t.ctx.deps.repos.tx;
      t.ctx.deps.repos = {
        ...t.ctx.deps.repos,
        tx: (<T,>(fn: (tx: TxRepos) => Promise<T>) =>
          innerTx((tx) => {
            (tx as unknown as Record<string, unknown>).savedLocations = {
              getById: savedGetById,
            };
            return fn(tx);
          })) as unknown as Repos["tx"],
      };

      await publishEvent(t.ctx.deps, buildPublishInput(t.ctx));

      expect(savedGetById).toHaveBeenCalledWith(SAVED_ID);
      expect(t.lookupByPostalCode).toHaveBeenCalledTimes(1); // A, pre-tx only
      expect(publishedStamp(t.ctx)).toEqual({
        admissionTaxRateBps: 700,
        taxRateSource: "manual",
      });
      expect(t.placesFillTaxRateIfUnset).not.toHaveBeenCalled();
      expect(t.place.admissionTaxRateBps).toBeNull();
    });
  });

  it("no provider call for an event with no category (the transaction refuses it)", async () => {
    const t = taxCtx(venue(), { categoryId: null });
    t.lookupByPostalCode.mockResolvedValue(R1);

    await expect(
      publishEvent(t.ctx.deps, buildPublishInput(t.ctx)),
    ).rejects.toMatchObject({ code: "EVENT_CATEGORY_MISSING" });

    expect(t.lookupByPostalCode).not.toHaveBeenCalled();
  });

  it("no provider call for an OBSCURED event with an incomplete host attestation (the transaction refuses it)", async () => {
    const t = taxCtx(venue(), { locationMode: "OBSCURED" });
    t.lookupByPostalCode.mockResolvedValue(R1);

    await expect(
      publishEvent(
        t.ctx.deps,
        buildPublishInput(t.ctx, {
          attestation: { ...DEFAULT_ATTESTATION, taxResponsibility: false },
        }),
      ),
    ).rejects.toMatchObject({ code: "attestation_incomplete" });

    expect(t.lookupByPostalCode).not.toHaveBeenCalled();
  });

  it("an EXACT event needs no attestation: the rate is still prepared before the tx", async () => {
    const t = taxCtx(venue(), { locationMode: "EXACT" });
    t.lookupByPostalCode.mockResolvedValue(R1);

    await publishEvent(
      t.ctx.deps,
      buildPublishInput(t.ctx, { attestation: undefined }),
    );

    expect(t.lookupByPostalCode).toHaveBeenCalledTimes(1);
    expect(t.lookupByPostalCode.mock.invocationCallOrder[0]).toBeLessThan(
      t.repoTx.mock.invocationCallOrder[0]!,
    );
  });

  it("an event with no place takes no lock", async () => {
    const t = taxCtx(venue(), { placeId: null });

    await publishEvent(t.ctx.deps, buildPublishInput(t.ctx));

    expect(t.lockLocationsAtPlace).not.toHaveBeenCalled();
  });

  it("an already-PUBLISHED event spends no provider call", async () => {
    const t = taxCtx(venue(), {
      status: "PUBLISHED",
      publishedAt: new Date("2024-12-01T00:00:00.000Z"),
    });
    t.lookupByPostalCode.mockResolvedValue(R1);

    await publishEvent(t.ctx.deps, buildPublishInput(t.ctx));

    expect(t.lookupByPostalCode).not.toHaveBeenCalled();
  });

  it("an actor who may not publish the event spends no provider call", async () => {
    const t = taxCtx(venue());
    t.lookupByPostalCode.mockResolvedValue(R1);
    t.ctx.mocks.authz.getOrgMembership.mockResolvedValue(null);

    await expect(
      publishEvent(t.ctx.deps, buildPublishInput(t.ctx)),
    ).rejects.toBeTruthy();

    expect(t.lookupByPostalCode).not.toHaveBeenCalled();
  });
});

describe("publishEvent — the transaction acts on the row it re-read under the row lock", () => {
  it("the event changed owner before the row lock was granted: access is re-checked for the NEW owner and refused", async () => {
    const ORG_Y_ID = "00000000-0000-4000-8000-0000000000e2";
    const ctx = makeContext();
    const events = ctx.mocks.events;
    // Org X (the default org) before the lock; org Y once the lock is
    // granted, as if an ownership change committed in between.
    let ownerOrgId = DEFAULT_ORG_ID;
    const baseGetById = events.getById.getMockImplementation()!;
    events.getById.mockImplementation(async (id: string) => {
      const row = await baseGetById(id);
      return row ? { ...row, orgId: ownerOrgId } : null;
    });
    events.lockRows.mockImplementation(async () => {
      ownerOrgId = ORG_Y_ID;
    });
    // The actor is an editor of X only.
    ctx.mocks.authz.getOrgMembership.mockImplementation((async (input: {
      orgId: string;
      humanId: string;
    }) =>
      input.orgId === DEFAULT_ORG_ID
        ? { orgId: DEFAULT_ORG_ID, humanId: input.humanId, role: "OWNER" }
        : null) as unknown as () => Promise<never>);

    await expect(
      publishEvent(ctx.deps, buildPublishInput(ctx)),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

    expect(events.lockRows).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.authz.getOrgMembership).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_Y_ID }),
    );
    expect(events.publish).not.toHaveBeenCalled();
    expect(events.createAttestation).not.toHaveBeenCalled();
  });
});

// freeze-the-deal FR-002: the first publish freezes the deal; a re-publish
// never unfreezes it or moves its date.
describe("publishEvent — freezes the deal", () => {
  it("the first publish freezes the deal (automatic: no human), audited source PUBLISH", async () => {
    const ctx = makeContext();
    await publishEvent(ctx.deps, buildPublishInput(ctx));

    const after = await ctx.mocks.events.getById(ctx.defaults.eventId);
    expect(after).toMatchObject({ dealFrozenAt: ctx.defaults.now, dealFrozenByHumanId: null });
    expect(ctx.mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event",
        entityId: ctx.defaults.eventId,
        action: "event.deal_frozen",
        data: expect.objectContaining({ source: "PUBLISH", actorHumanId: ctx.defaults.actorHumanId, frozenByHumanId: null }),
      }),
    );
  });

  it("a deal frozen before publish (manual) keeps its date and who froze it", async () => {
    const manualAt = new Date("2024-12-20T00:00:00.000Z");
    const ctx = makeContext({
      event: { dealFrozenAt: manualAt, dealFrozenByHumanId: DEFAULT_ACTOR_ID } as Partial<EventRecord>,
    });
    await publishEvent(ctx.deps, buildPublishInput(ctx));
    const after = await ctx.mocks.events.getById(ctx.defaults.eventId);
    expect(after).toMatchObject({ dealFrozenAt: manualAt, dealFrozenByHumanId: DEFAULT_ACTOR_ID });
    expect(ctx.mocks.audit.log).not.toHaveBeenCalledWith(expect.objectContaining({ action: "event.deal_frozen" }));
  });

  it("re-publishing an event published before freezes existed (never frozen) freezes it now", async () => {
    const firstPublish = new Date("2024-11-01T00:00:00.000Z");
    // Published before the migration, unpublished on backfill day: the
    // backfill froze only PUBLISHED events, so this one comes back unfrozen.
    const ctx = makeContext({
      event: { publishedAt: firstPublish, dealFrozenAt: null, dealFrozenByHumanId: null } as Partial<EventRecord>,
    });
    await expect(publishEvent(ctx.deps, buildPublishInput(ctx))).resolves.toMatchObject({ status: "PUBLISHED" });
    const after = await ctx.mocks.events.getById(ctx.defaults.eventId);
    expect(after).toMatchObject({ dealFrozenAt: ctx.defaults.now, dealFrozenByHumanId: null });
    expect(ctx.mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "event.deal_frozen", data: expect.objectContaining({ source: "PUBLISH" }) }),
    );
  });

  it("the deal's terms are locked BEFORE the agreement gates read them", async () => {
    const ctx = makeContext();
    await publishEvent(ctx.deps, buildPublishInput(ctx));
    const locked = ctx.mocks.agreements.findManyByLinkedEventIds.mock.invocationCallOrder[0]!;
    const gatesRead = ctx.mocks.agreements.listByEvent.mock.invocationCallOrder[0]!;
    expect(locked).toBeLessThan(gatesRead);
  });

  it("both the PRIMARY and the RESALE terms are locked, and the first lock precedes the gates' terms read", async () => {
    const ctx = makeContext({
      event: { payoutTermsId: DEFAULT_AGREEMENT_ID, resalePayoutTermsId: "resale-terms-1" },
      agreements: [
        buildAgreement({}),
        buildAgreement({
          id: "resale-terms-1",
          kind: "RESALE",
          status: "PENDING",
          resaleShareType: "PERCENT",
          resaleShareBps: 1000,
          resaleShareCents: null,
          resaleSharePayer: "SELLER",
        }),
      ],
      agreementLines: resaleLineFor("resale-terms-1"),
      ticketTypes: [buildTicketType({ resaleAllowed: true })],
    });
    await expect(publishEvent(ctx.deps, buildPublishInput(ctx))).resolves.toMatchObject({ status: "PUBLISHED" });
    const lockedIds = ctx.mocks.dealsLockTerms.mock.calls.map((c) => c[0]);
    expect(lockedIds).toEqual(expect.arrayContaining([DEFAULT_AGREEMENT_ID, "resale-terms-1"]));
    const firstLock = ctx.mocks.dealsLockTerms.mock.invocationCallOrder[0]!;
    const gatesRead = ctx.mocks.agreements.listByEvent.mock.invocationCallOrder[0]!;
    expect(firstLock).toBeLessThan(gatesRead);
    // Both terms rows are locked before the gates read them, not just one.
    const locksBeforeRead = ctx.mocks.dealsLockTerms.mock.calls.filter(
      (_c, i) => ctx.mocks.dealsLockTerms.mock.invocationCallOrder[i]! < gatesRead,
    );
    expect(locksBeforeRead.map((c) => c[0])).toEqual(
      expect.arrayContaining([DEFAULT_AGREEMENT_ID, "resale-terms-1"]),
    );
  });

  it("unpublish + re-publish keeps the original dealFrozenAt", async () => {
    const firstFreeze = new Date("2024-12-01T00:00:00.000Z");
    // Unpublished events come back as DRAFT with publishedAt kept.
    const ctx = makeContext({
      event: { publishedAt: firstFreeze, dealFrozenAt: firstFreeze, dealFrozenByHumanId: null } as Partial<EventRecord>,
    });
    await expect(publishEvent(ctx.deps, buildPublishInput(ctx))).resolves.toMatchObject({ status: "PUBLISHED" });
    const after = await ctx.mocks.events.getById(ctx.defaults.eventId);
    expect(after).toMatchObject({ dealFrozenAt: firstFreeze });
    expect(ctx.mocks.audit.log).not.toHaveBeenCalledWith(expect.objectContaining({ action: "event.deal_frozen" }));
  });
});
