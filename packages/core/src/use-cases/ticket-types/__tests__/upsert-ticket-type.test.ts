import { describe, expect, it, vi } from "vitest";

import { upsertTicketType } from "../upsert-ticket-type";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createTestLogger } from "@th/test-utils/fakes/logger";
import { buildOffsetPaginatedResult } from "@th/ports";
import type { EventRecord } from "@th/ports/repos/events";
import type {
  TicketTypeRecord,
  TicketTypeStatus,
} from "@th/ports/repos/tickets";
import type { OrgRole } from "@th/ports/repos/authz";
import type { FeePolicyRecord } from "@th/ports/repos/fee-policies";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { SeatSectionPriceOverride } from "@th/ports/repos/seats";

const DEFAULT_EVENT_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_ORG_ID = "22222222-2222-4222-8222-222222222222";
const DEFAULT_ACTOR_ID = "33333333-3333-4333-8333-333333333333";
const DEFAULT_TICKET_TYPE_ID = "44444444-4444-4444-8444-444444444444";
/** The one seat section the default context's event has. */
const DEFAULT_SEAT_SECTION_ID = "66666666-6666-4666-8666-666666666666";
/** A real section, of ANOTHER event. */
const FOREIGN_SEAT_SECTION_ID = "99999999-9999-4999-8999-999999999999";
/** An id no section has. */
const MISSING_SEAT_SECTION_ID = "88888888-8888-4888-8888-888888888888";

interface MakeContextOptions {
  event?: Partial<EventRecord> | null;
  membershipRole?: OrgRole | null;
  existingTicketType?: TicketTypeRecord | null;
  ticketTypeId?: string;
  idempotencyBeginSequence?: boolean[];
  payee?: any;
  /**
   * Fee policy the EVENT → ORG → GLOBAL walk resolves to. Defaults to a GLOBAL
   * policy (the platform-configured normal case). Pass `null` to simulate a
   * platform with NO fee policy at any scope.
   */
  feePolicy?: FeePolicyRecord | null;
  /** Best-effort Sentry reporter wired into `UpsertTicketTypeDeps`. */
  reportError?: ReporterPort;
  /**
   * Event-level sold count `events.getPopularityStats` reports (the measure
   * behind the editor's lock). Defaults to 0 — no sales, no lock.
   */
  ticketsSold?: number;
  /** What `seats.listDistinctPriceOverridesByEvent` returns. Default: none. */
  seatOverrides?: SeatSectionPriceOverride[];
  /**
   * Ids of the seat sections that belong to the event (what
   * `seats.listSectionsByEvent` answers for it). Default: one,
   * `DEFAULT_SEAT_SECTION_ID`.
   */
  eventSeatSectionIds?: string[];
  /**
   * The event's RESALE terms, by id (pair with `event.resalePayoutTermsId`).
   * Carries the resale clause (organiser-resale-share FR-001). Default: none.
   */
  resaleTerms?: { id: string; resaleShareType: "PERCENT" | "FLAT" | null; resaleShareBps?: number | null };
  /** RESALE payout lines on those terms. Default: 1. */
  resaleLines?: number;
}

const DEFAULT_FEE_POLICY_ID = "55555555-5555-4555-8555-555555555555";

function buildFeePolicy(
  overrides: Partial<FeePolicyRecord> = {},
): FeePolicyRecord {
  return {
    id: DEFAULT_FEE_POLICY_ID,
    scopeType: "GLOBAL",
    scopeId: null,
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

type TestDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: { now: () => Date };
  logger: ReturnType<typeof createTestLogger>;
  reportError?: ReporterPort;
};

type Context = {
  deps: TestDeps;
  defaults: {
    actorHumanId: string;
    eventId: string;
    name: string;
    description: string | null;
    priceCents: number;
    capacity: number;
    seatSectionId: string | null;
  };
  mocks: {
    events: ReturnType<typeof buildEventsRepoMock>;
    tickets: ReturnType<typeof buildTicketsRepoMock>;
    authz: ReturnType<typeof buildAuthzRepoMock>;
    audit: ReturnType<typeof buildAuditRepoMock>;
    idempotency: ReturnType<typeof createFakeIdempotencyPort>;
    feePolicies: {
      getById: ReturnType<typeof vi.fn>;
      resolveEffective: ReturnType<typeof vi.fn>;
    };
    payees: {
      getBySubject: ReturnType<typeof vi.fn>;
      getById: ReturnType<typeof vi.fn>;
    };
    listDistinctPriceOverridesByEvent: ReturnType<typeof vi.fn>;
    listSectionsByEvent: ReturnType<typeof vi.fn>;
    getSectionById: ReturnType<typeof vi.fn>;
  };
};

function makeContext(options: MakeContextOptions = {}): Context {
  const now = new Date("2025-01-01T00:00:00.000Z");
  const actorHumanId = DEFAULT_ACTOR_ID;

  const baseEvent: EventRecord = {
    id: DEFAULT_EVENT_ID,
    orgId: DEFAULT_ORG_ID,
    humanId: null,
    title: "Launch Party",
    status: "DRAFT",
    visibility: "PUBLIC",
    gateType: "NONE",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    addressRevealAt: null,
    addressRevealPreset: null,
    startsAt: new Date("2025-02-01T20:00:00.000Z"),
    endsAt: null,
    publishedAt: null,
    placeId: null,
    savedLocationId: null,
    addressText: null,
    lat: null,
    lng: null,
    categoryId: "category-rock",
    agreementPrimaryId: "agreement-primary",
    agreementResaleId: null,
    slug: null,
    shortId: null,
    regionCode: null,
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

  const eventOverride = options.event;
  const eventExists = eventOverride !== null;
  const event: EventRecord = eventOverride
    ? { ...baseEvent, ...eventOverride }
    : baseEvent;

  const membershipRole =
    options.membershipRole === undefined ? "ADMIN" : options.membershipRole;
  const existingTicketType = options.existingTicketType ?? null;

  const eventsRepo = buildEventsRepoMock(
    eventExists ? event : null,
    options.ticketsSold ?? 0,
  );
  const ticketsRepo = buildTicketsRepoMock(
    options.ticketTypeId ?? DEFAULT_TICKET_TYPE_ID,
    existingTicketType,
  );
  const authzRepo = buildAuthzRepoMock(
    event.orgId,
    actorHumanId,
    membershipRole,
  );
  const auditRepo = buildAuditRepoMock();

  const defaultPayee = {
    id: "payee-1",
    subjectType: "ORG",
    subjectId: DEFAULT_ORG_ID,
    stripeAccountId: "acct_test",
    status: "ACTIVE",
    chargesEnabled: true,
    payoutsEnabled: true,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
  };

  const payeesRepoMock = {
    getBySubject: vi.fn(async () =>
      options.payee === undefined ? defaultPayee : options.payee,
    ),
    // The Stripe gate reads the full row for `stripeAccountId`.
    getById: vi.fn(async () =>
      options.payee === undefined ? defaultPayee : options.payee,
    ),
  };

  // EVENT → ORG → GLOBAL walk. The default context resolves at GLOBAL (the
  // platform-configured normal case); `feePolicy: null` empties every scope.
  const resolvedFeePolicy =
    options.feePolicy === undefined ? buildFeePolicy() : options.feePolicy;
  const feePoliciesRepoMock = {
    getById: vi.fn(async (id: string) =>
      resolvedFeePolicy && resolvedFeePolicy.id === id
        ? { ...resolvedFeePolicy }
        : null,
    ),
    resolveEffective: vi.fn(
      async ({ scopeType }: { scopeType: "EVENT" | "ORG" | "GLOBAL" }) => {
        if (!resolvedFeePolicy) return null;
        return scopeType === resolvedFeePolicy.scopeType
          ? { ...resolvedFeePolicy }
          : null;
      },
    ),
  };

  const listDistinctPriceOverridesByEvent = vi.fn(
    async (_input: { eventId: string }) => options.seatOverrides ?? [],
  );

  const eventSeatSectionIds = options.eventSeatSectionIds ?? [
    DEFAULT_SEAT_SECTION_ID,
  ];
  const buildSection = (id: string) => ({
    id,
    name: `Section ${id.slice(0, 4)}`,
    type: "RESERVED" as const,
    capacity: 50,
    layoutSectionId: null,
    placeLayoutId: null,
  });
  const listSectionsByEvent = vi.fn(async (eventId: string) =>
    eventId === event.id ? eventSeatSectionIds.map(buildSection) : [],
  );
  // The id-only read finds a section of ANY event (the tests below name the
  // one id it does not), so it cannot answer "is this a section of this
  // event".
  const getSectionById = vi.fn(async (id: string) =>
    id === MISSING_SEAT_SECTION_ID ? null : buildSection(id),
  );

  const txRepos = {
    events: eventsRepo,
    tickets: ticketsRepo,
    seats: {
      listDistinctPriceOverridesByEvent,
      listSectionsByEvent,
      getSectionById,
    } as any,
    agreements: {} as any,
    feePolicies: feePoliciesRepoMock as any,
    authz: authzRepo,
    audit: auditRepo,
    orders: {} as any,
    splits: {} as any,
    payees: payeesRepoMock as any,
    settlements: {} as any,
    resaleListings: {} as any,
    idempotency: {} as any,
    apiKeys: {} as any,
    organizations: {} as any,
    places: {} as any,
    savedLocations: {} as any,
    humans: {} as any,
    categories: {
      listActive: vi.fn(),
      getBySlug: vi.fn(),
      getById: vi.fn(),
      upsertSeed: vi.fn(),
    } as any,
    eventTemplates: {} as any,
    eventHumans: {} as any,
    payoutTerms: {
      getById: vi.fn(async (id: string) =>
        options.resaleTerms?.id === id ? { ...options.resaleTerms } : null,
      ),
      listLines: vi.fn(async (id: string) =>
        options.resaleTerms?.id === id
          ? Array.from({ length: options.resaleLines ?? 1 }, (_, i) => ({ id: `line-${i}` }))
          : [],
      ),
    } as any,
    deals: {
      lockTerms: vi.fn(async (id: string) => options.resaleTerms?.id === id),
    } as any,
  } as unknown as TxRepos;

  const repos = {
    events: eventsRepo,
    tickets: ticketsRepo,
    seats: {} as any,
    agreements: {} as any,
    feePolicies: feePoliciesRepoMock as any,
    authz: authzRepo,
    audit: auditRepo,
    orders: {} as any,
    splits: {} as any,
    payees: payeesRepoMock as any,
    settlements: {} as any,
    resaleListings: {} as any,
    idempotency: {} as any,
    apiKeys: {} as any,
    organizations: {} as any,
    places: {} as any,
    savedLocations: {} as any,
    humans: {} as any,
    categories: txRepos.categories,
    eventTemplates: txRepos.eventTemplates,
    eventHumans: txRepos.eventHumans,
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos),
  } as unknown as Repos;

  const idempotency = createFakeIdempotencyPort({
    beginSequence: options.idempotencyBeginSequence,
  });
  const clock = { now: () => now };
  const logger = createTestLogger();

  return {
    deps: {
      repos,
      idempotency,
      clock,
      logger,
      reportError: options.reportError,
    },
    defaults: {
      actorHumanId,
      eventId: event.id,
      name: "VIP",
      description: "Front row experience",
      priceCents: 15000,
      capacity: 25,
      seatSectionId: null,
    },
    mocks: {
      events: eventsRepo,
      tickets: ticketsRepo,
      authz: authzRepo,
      audit: auditRepo,
      idempotency,
      feePolicies: feePoliciesRepoMock,
      payees: payeesRepoMock,
      listDistinctPriceOverridesByEvent,
      listSectionsByEvent,
      getSectionById,
    },
  };
}

function buildEventsRepoMock(event: EventRecord | null, ticketsSold = 0) {
  return {
    getById: vi.fn(async (id: string) =>
      event && id === event.id ? event : null,
    ),
    // Event row before RESALE terms (`requireEventResaleClauseSet`).
    lockRows: vi.fn(async (_input: { ids: string[]; mode: "share" | "update" }) => {}),
    getPopularityStats: vi.fn(async (eventIds: string[]) =>
      eventIds.map((eventId) => ({
        eventId,
        ticketsSold,
        totalCapacity: 0,
        waitlistCount: 0,
      })),
    ),
    listTicketTypes: vi.fn(),
    ensureHostPermission: vi.fn(),
    upsertDraft: vi.fn(),
    publish: vi.fn(),
    setCategory: vi.fn(),
    filterByCategory: vi.fn(async () =>
      buildOffsetPaginatedResult({ items: [], total: 0, limit: 1, offset: 0 }),
    ),
    listPublishedForSitemap: vi.fn(async () => []),
  };
}

function buildTicketsRepoMock(
  createdId: string,
  existing: TicketTypeRecord | null,
) {
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
    findTicketTypeByName: vi.fn(async (_eventId: string, name: string) => {
      if (!existing) return null;
      return existing.name.toLowerCase() === name.toLowerCase()
        ? existing
        : null;
    }),
    createTicketType: vi.fn(
      async (input: {
        eventId: string;
        name: string;
        description: string | null;
        priceCents: number;
        capacity: number;
        status: TicketTypeStatus;
        createdAt: Date;
        seatSectionId?: string | null;
      }) =>
        ({
          id: createdId,
          eventId: input.eventId,
          name: input.name,
          description: input.description,
          priceCents: input.priceCents,
          pricingMode: "FIXED",
          minimumCents: null,
          suggestedCents: null,
          capacity: input.capacity,
          status: input.status,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
          seatSectionId: input.seatSectionId ?? null,
        }) as TicketTypeRecord,
    ),
    countIssuedForTicketType: vi.fn(async () => 0),
    countIssuedForEvent: vi.fn(async () => 0),
  };
}

function buildAuthzRepoMock(
  orgId: string | null,
  actorHumanId: string,
  role: OrgRole | null,
) {
  return {
    getHumanDelegation: vi.fn(
      async (): Promise<{ orgId: string; humanId: string; role: OrgRole } | null> =>
        null,
    ),
    getOrgMembership: vi.fn(
      async ({
        orgId: queryOrgId,
        humanId,
      }: {
        orgId: string;
        humanId: string;
      }) => {
        if (!orgId || queryOrgId !== orgId) return null;
        if (humanId !== actorHumanId) return null;
        if (role === null) return null;
        return { orgId, humanId, role };
      },
    ),
    getEventOrgId: vi.fn(),
    getPlaceAccessContext: vi.fn(),
    isPlaceVerifiedForOrg: vi.fn(),
  };
}

function buildAuditRepoMock() {
  return {
    log: vi.fn(async () => {}),
  };
}

describe("upsertTicketType", () => {
  it("creates a ticket type for a draft event", async () => {
    const ctx = makeContext();

    const result = await upsertTicketType(ctx.deps, {
      actorHumanId: ctx.defaults.actorHumanId,
      eventId: ctx.defaults.eventId,
      name: "  VIP ",
      description: ctx.defaults.description,
      priceCents: ctx.defaults.priceCents,
      capacity: ctx.defaults.capacity,
      clientKey: "new-ticket-type",
    });

    expect(result).toEqual({
      ticketTypeId: DEFAULT_TICKET_TYPE_ID,
      status: "DRAFT",
    });

    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "VIP",
        status: "DRAFT",
      }),
    );

    expect(ctx.mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ entity: "ticket_type", action: "created" }),
    );
  });

  it("activates the ticket type when the event is published", async () => {
    const ctx = makeContext({ event: { status: "PUBLISHED" } });

    const result = await upsertTicketType(ctx.deps, {
      actorHumanId: ctx.defaults.actorHumanId,
      eventId: ctx.defaults.eventId,
      name: ctx.defaults.name,
      description: ctx.defaults.description,
      priceCents: ctx.defaults.priceCents,
      capacity: ctx.defaults.capacity,
      clientKey: "publish-ticket-type",
    });

    expect(result.status).toBe("ACTIVE");
    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ACTIVE" }),
    );
  });

  it("rejects duplicate ticket type names", async () => {
    const existing: TicketTypeRecord = {
      id: "55555555-5555-4555-8555-555555555555",
      eventId: DEFAULT_EVENT_ID,
      name: "VIP",
      description: null,
      priceCents: 10000,
      pricingMode: "FIXED",
      minimumCents: null,
      suggestedCents: null,
      capacity: 10,
      status: "DRAFT",
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
      resaleAllowed: false,
      resaleCapCents: null,
      transferAllowed: true,
    };
    const ctx = makeContext({ existingTicketType: existing });

    await expect(
      upsertTicketType(ctx.deps, {
        actorHumanId: ctx.defaults.actorHumanId,
        eventId: ctx.defaults.eventId,
        name: existing.name,
        description: ctx.defaults.description,
        priceCents: ctx.defaults.priceCents,
        capacity: ctx.defaults.capacity,
        clientKey: "dup-name",
      }),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_NAME_TAKEN" });
  });

  it("requires sufficient organization role", async () => {
    const ctx = makeContext({ membershipRole: "VIEWER" });

    await expect(
      upsertTicketType(ctx.deps, {
        actorHumanId: ctx.defaults.actorHumanId,
        eventId: ctx.defaults.eventId,
        name: ctx.defaults.name,
        description: ctx.defaults.description,
        priceCents: ctx.defaults.priceCents,
        capacity: ctx.defaults.capacity,
        clientKey: "low-role",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("rejects when event belongs to a different human", async () => {
    const ctx = makeContext({
      event: { orgId: null, humanId: "99999999-9999-4999-8999-999999999999" },
    });

    await expect(
      upsertTicketType(ctx.deps, {
        actorHumanId: ctx.defaults.actorHumanId,
        eventId: ctx.defaults.eventId,
        name: ctx.defaults.name,
        description: ctx.defaults.description,
        priceCents: ctx.defaults.priceCents,
        capacity: ctx.defaults.capacity,
        clientKey: "human-mismatch",
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  // Owner ruling 2026-09-28: tickets are part of the builder, so an
  // edit-role delegate of the human owner edits them.
  describe("a delegate of the human owner", () => {
    const PRINCIPAL_ID = "99999999-9999-4999-8999-999999999999";
    const run = async (role: OrgRole | null) => {
      const ctx = makeContext({ event: { orgId: null, humanId: PRINCIPAL_ID } });
      ctx.mocks.authz.getHumanDelegation.mockResolvedValue(
        role
          ? { orgId: PRINCIPAL_ID, humanId: ctx.defaults.actorHumanId, role }
          : null,
      );
      const result = upsertTicketType(ctx.deps, {
        actorHumanId: ctx.defaults.actorHumanId,
        eventId: ctx.defaults.eventId,
        name: ctx.defaults.name,
        description: ctx.defaults.description,
        priceCents: ctx.defaults.priceCents,
        capacity: ctx.defaults.capacity,
        clientKey: `delegate-${role ?? "none"}`,
      });
      return { ctx, result };
    };

    it.each(["OWNER", "ADMIN", "EDITOR"] as const)(
      "a %s delegate creates a ticket type",
      async (role) => {
        const { ctx, result } = await run(role);
        await expect(result).resolves.toMatchObject({ status: "DRAFT" });
        expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledTimes(1);
      },
    );

    it.each([["VIEWER"], ["FINANCE"], ["SCANNER"], [null]] as const)(
      "a %s delegate (or a stranger) is refused",
      async (role) => {
        const { ctx, result } = await run(role);
        await expect(result).rejects.toMatchObject({
          code: "NOT_RESOURCE_OWNER",
        });
        expect(ctx.mocks.tickets.createTicketType).not.toHaveBeenCalled();
      },
    );
  });

  it("rejects archived events", async () => {
    const ctx = makeContext({ event: { status: "ARCHIVED" } });

    await expect(
      upsertTicketType(ctx.deps, {
        actorHumanId: ctx.defaults.actorHumanId,
        eventId: ctx.defaults.eventId,
        name: ctx.defaults.name,
        description: ctx.defaults.description,
        priceCents: ctx.defaults.priceCents,
        capacity: ctx.defaults.capacity,
        clientKey: "archived",
      }),
    ).rejects.toMatchObject({ code: "EVENT_ARCHIVED" });
  });

  it("requires the event to exist", async () => {
    const ctx = makeContext({ event: null });

    await expect(
      upsertTicketType(ctx.deps, {
        actorHumanId: ctx.defaults.actorHumanId,
        eventId: ctx.defaults.eventId,
        name: ctx.defaults.name,
        description: ctx.defaults.description,
        priceCents: ctx.defaults.priceCents,
        capacity: ctx.defaults.capacity,
        clientKey: "missing-event",
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("replays the same result under idempotency", async () => {
    const ctx = makeContext();

    const input = {
      actorHumanId: ctx.defaults.actorHumanId,
      eventId: ctx.defaults.eventId,
      name: ctx.defaults.name,
      description: ctx.defaults.description,
      priceCents: ctx.defaults.priceCents,
      capacity: ctx.defaults.capacity,
      clientKey: "idem-key",
    } as const;

    const first = await upsertTicketType(ctx.deps, input);
    const second = await upsertTicketType(ctx.deps, input);

    expect(first).toEqual(second);
    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledTimes(1);
  });

  it("rejects idempotency mismatches", async () => {
    const ctx = makeContext();

    const baseInput = {
      actorHumanId: ctx.defaults.actorHumanId,
      eventId: ctx.defaults.eventId,
      name: ctx.defaults.name,
      description: ctx.defaults.description,
      capacity: ctx.defaults.capacity,
      clientKey: "idem-conflict",
    };

    await upsertTicketType(ctx.deps, { ...baseInput, priceCents: 1000 });

    await expect(
      upsertTicketType(ctx.deps, { ...baseInput, priceCents: 2000 }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
  });

  // A type that takes money LATER (or at the door) needs a connected account
  // just as much as one that takes money now — and before this predicate
  // widened, neither reached the gate.

  it("requires Stripe for a $0-now / $20-at-T tier", async () => {
    const ctx = makeContext({ payee: null });

    await expect(
      upsertTicketType(
        ctx.deps,
        scheduleInput(ctx, "sched-requires-stripe", {
          priceCents: 0,
          scheduledPriceCents: 2000,
          scheduledPriceAt: FLIP_AT,
        }),
      ),
    ).rejects.toMatchObject({ code: "PAID_TICKETING_REQUIRES_STRIPE" });

    expect(ctx.mocks.tickets.createTicketType).not.toHaveBeenCalled();
  });

  it("ignores a doorPriceCents left in a stale client's payload: not stored, and a $0 tier stays free (FR-012)", async () => {
    // The field was removed. The input schema is not strict, so an old
    // browser tab that still sends it has the key stripped rather than the
    // save refused — and it can no longer arm (or skip) the Stripe gate.
    const ctx = makeContext({ payee: null });

    await upsertTicketType(
      ctx.deps,
      scheduleInput(ctx, "stale-door-field", {
        priceCents: 0,
        doorPriceCents: 3500,
      }),
    );

    const created = ctx.mocks.tickets.createTicketType.mock.calls[0]?.[0];
    expect(created).toMatchObject({ priceCents: 0 });
    expect(created).not.toHaveProperty("doorPriceCents");
  });

  it("NFR-001: a genuinely free tier still needs no Stripe", async () => {
    const ctx = makeContext({ payee: null });

    await upsertTicketType(
      ctx.deps,
      scheduleInput(ctx, "free-no-stripe", { priceCents: 0 }),
    );

    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalled();
  });

  it("NFR-001: pay-what-you-want with NO minimum still needs no Stripe (the narrower ADJUSTABLE rule is preserved)", async () => {
    const ctx = makeContext({ payee: null });

    await upsertTicketType(
      ctx.deps,
      scheduleInput(ctx, "pwyw-no-minimum", {
        priceCents: 0,
        pricingMode: "ADJUSTABLE",
        minimumCents: 0,
      }),
    );

    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalled();
  });

  it("requires Stripe to create paid ticket types", async () => {
    const ctx = makeContext({ payee: null });

    await expect(
      upsertTicketType(ctx.deps, {
        actorHumanId: ctx.defaults.actorHumanId,
        eventId: ctx.defaults.eventId,
        name: ctx.defaults.name,
        description: ctx.defaults.description,
        priceCents: 1000,
        capacity: ctx.defaults.capacity,
        clientKey: "paid-requires-stripe",
      }),
    ).rejects.toMatchObject({ code: "PAID_TICKETING_REQUIRES_STRIPE" });
  });

  // ── Fee-policy gate (the free→paid flip) ────────────────────────────────
  //
  // `publishEvent` no longer requires a fee policy for a FREE event, so a free
  // event can be PUBLISHED with nothing pinned on its payout terms. Adding a
  // money-taking tier to that event afterwards is the flip that would surface
  // at the BUYER's checkout. Refuse it here instead, next to the Stripe gate
  // and on the same `isEverPaidTicketType` predicate.

  function paidInput(ctx: Context, clientKey: string, extra = {}) {
    return {
      actorHumanId: ctx.defaults.actorHumanId,
      eventId: ctx.defaults.eventId,
      name: ctx.defaults.name,
      description: ctx.defaults.description,
      priceCents: 1000,
      capacity: ctx.defaults.capacity,
      clientKey,
      ...extra,
    };
  }

  it("refuses a paid ticket type when no fee policy resolves at any scope", async () => {
    const ctx = makeContext({ feePolicy: null });

    await expect(
      upsertTicketType(ctx.deps, paidInput(ctx, "paid-no-fee-policy")),
    ).rejects.toMatchObject({ code: "PAID_TICKETING_REQUIRES_FEE_POLICY" });

    expect(ctx.mocks.tickets.createTicketType).not.toHaveBeenCalled();
  });

  it("refuses a paid tier on a PUBLISHED (previously free) event — the flip", async () => {
    const ctx = makeContext({
      feePolicy: null,
      event: { status: "PUBLISHED", publishedAt: new Date("2025-01-01") },
    });

    await expect(
      upsertTicketType(ctx.deps, paidInput(ctx, "flip-to-paid")),
    ).rejects.toMatchObject({ code: "PAID_TICKETING_REQUIRES_FEE_POLICY" });

    expect(ctx.mocks.tickets.createTicketType).not.toHaveBeenCalled();
  });

  it("refuses a $0-now / $20-at-T tier with no fee policy", async () => {
    const ctx = makeContext({ feePolicy: null });

    await expect(
      upsertTicketType(
        ctx.deps,
        paidInput(ctx, "sched-no-fee-policy", {
          priceCents: 0,
          scheduledPriceCents: 2000,
          scheduledPriceAt: new Date("2026-12-01T00:00:00.000Z"),
        }),
      ),
    ).rejects.toMatchObject({ code: "PAID_TICKETING_REQUIRES_FEE_POLICY" });
  });

  it("refuses a pure pay-what-you-want (ADJUSTABLE, no minimum) tier with no fee policy", async () => {
    // The fee-policy arm is WIDER than the Stripe arm on purpose. `requiresStripe`
    // excludes this shape for historical reasons, but `publishEvent`'s
    // `isEverPaidTicketType` treats ADJUSTABLE as paid — so without the wider
    // predicate the editor would accept a tier publish then rejects.
    const ctx = makeContext({ feePolicy: null });

    await expect(
      upsertTicketType(
        ctx.deps,
        paidInput(ctx, "adjustable-no-fee-policy", {
          priceCents: 0,
          pricingMode: "ADJUSTABLE",
          minimumCents: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "PAID_TICKETING_REQUIRES_FEE_POLICY" });

    expect(ctx.mocks.tickets.createTicketType).not.toHaveBeenCalled();
  });

  it("an ADJUSTABLE tier with no minimum still needs NO Stripe (narrower arm intact)", async () => {
    // Guards the asymmetry in the other direction: widening the fee-policy arm
    // must not have widened the Stripe arm, whose historical rule is untouched.
    const ctx = makeContext({ payee: null });

    await upsertTicketType(
      ctx.deps,
      paidInput(ctx, "adjustable-no-stripe", {
        priceCents: 0,
        pricingMode: "ADJUSTABLE",
        minimumCents: null,
      }),
    );

    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalled();
  });

  it("still creates a genuinely FREE tier when no fee policy exists", async () => {
    // The control, and the whole point: a platform with no fee policy must
    // not block free ticketing anywhere in the flow.
    const ctx = makeContext({ feePolicy: null });

    await upsertTicketType(
      ctx.deps,
      paidInput(ctx, "free-no-fee-policy", { priceCents: 0 }),
    );

    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalled();
    expect(ctx.mocks.feePolicies.resolveEffective).not.toHaveBeenCalled();
  });

  it("creates a paid tier normally when a GLOBAL policy resolves", async () => {
    const ctx = makeContext();

    await upsertTicketType(ctx.deps, paidInput(ctx, "paid-with-fee-policy"));

    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalled();
    // EVENT → ORG → GLOBAL: three probes, resolving on the last.
    expect(ctx.mocks.feePolicies.resolveEffective).toHaveBeenCalledTimes(3);
  });

  it("rethrows a per-scope repo failure from the fee-policy walk instead of creating the tier", async () => {
    // The walk used to swallow a failing EVENT read and continue to GLOBAL —
    // unreachable inside `repos.tx`, where the first failed statement aborts
    // the session. The fault now propagates (wrapped as `dependency_failed`)
    // rather than becoming a misleading PAID_TICKETING_REQUIRES_FEE_POLICY.
    const boom = new Error("connection terminated unexpectedly");
    const reportError = vi.fn();
    const ctx = makeContext({ reportError });
    ctx.mocks.feePolicies.resolveEffective.mockRejectedValueOnce(boom);

    await expect(
      upsertTicketType(ctx.deps, paidInput(ctx, "scope-walk-repo-error")),
    ).rejects.toMatchObject({ code: "dependency_failed", cause: boom });

    expect(ctx.mocks.feePolicies.resolveEffective).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.tickets.createTicketType).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: expect.objectContaining({
          resolver: "resolveScopedFeePolicy",
          scopeType: "EVENT",
          source: "upsertTicketType",
        }),
      }),
    );
  });

  // ── FR-005: scheduled price change, both-or-neither ─────────────────────
  //
  // The invariant is enforced as a REJECTED WRITE with a named code, never a
  // silently-ignored half-configuration: an organizer who set "$20" but no
  // date would otherwise get a tier that looks scheduled in the admin and
  // never flips.

  const FLIP_AT = new Date("2025-01-20T18:00:00.000Z");

  function scheduleInput(
    ctx: Context,
    clientKey: string,
    extra: Record<string, unknown>,
  ) {
    return {
      actorHumanId: ctx.defaults.actorHumanId,
      eventId: ctx.defaults.eventId,
      name: ctx.defaults.name,
      description: ctx.defaults.description,
      priceCents: 1200,
      capacity: ctx.defaults.capacity,
      clientKey,
      ...extra,
    };
  }

  it("round-trips a complete schedule onto the created ticket type", async () => {
    const ctx = makeContext();

    await upsertTicketType(
      ctx.deps,
      scheduleInput(ctx, "schedule-ok", {
        scheduledPriceCents: 2000,
        scheduledPriceAt: FLIP_AT,
      }),
    );

    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledWith(
      expect.objectContaining({
        priceCents: 1200,
        scheduledPriceCents: 2000,
        scheduledPriceAt: FLIP_AT,
      }),
    );
  });

  it("rejects a price with no instant (TICKET_TYPE_SCHEDULE_INCOMPLETE)", async () => {
    const ctx = makeContext();

    await expect(
      upsertTicketType(
        ctx.deps,
        scheduleInput(ctx, "schedule-price-only", {
          scheduledPriceCents: 2000,
        }),
      ),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_SCHEDULE_INCOMPLETE" });

    expect(ctx.mocks.tickets.createTicketType).not.toHaveBeenCalled();
  });

  it("rejects an instant with no price (TICKET_TYPE_SCHEDULE_INCOMPLETE)", async () => {
    const ctx = makeContext();

    await expect(
      upsertTicketType(
        ctx.deps,
        scheduleInput(ctx, "schedule-date-only", {
          scheduledPriceAt: FLIP_AT,
        }),
      ),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_SCHEDULE_INCOMPLETE" });

    expect(ctx.mocks.tickets.createTicketType).not.toHaveBeenCalled();
  });

  it("accepts a scheduled price of 0 — a tier that becomes free at T", async () => {
    const ctx = makeContext();

    await upsertTicketType(
      ctx.deps,
      scheduleInput(ctx, "schedule-free-after", {
        scheduledPriceCents: 0,
        scheduledPriceAt: FLIP_AT,
      }),
    );

    // 0 must survive as 0 and not be normalized away as "absent".
    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduledPriceCents: 0,
        scheduledPriceAt: FLIP_AT,
      }),
    );
  });

  it("rejects a negative scheduled price at the schema boundary", async () => {
    const ctx = makeContext();

    await expect(
      upsertTicketType(
        ctx.deps,
        scheduleInput(ctx, "schedule-negative", {
          scheduledPriceCents: -1,
          scheduledPriceAt: FLIP_AT,
        }),
      ),
    ).rejects.toBeTruthy();

    expect(ctx.mocks.tickets.createTicketType).not.toHaveBeenCalled();
  });

  it("clears the schedule for ADJUSTABLE pricing (the buyer names the amount)", async () => {
    const ctx = makeContext();

    await upsertTicketType(
      ctx.deps,
      scheduleInput(ctx, "schedule-adjustable", {
        pricingMode: "ADJUSTABLE",
        minimumCents: 500,
        scheduledPriceCents: 2000,
        scheduledPriceAt: FLIP_AT,
      }),
    );

    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledWith(
      expect.objectContaining({
        pricingMode: "ADJUSTABLE",
        scheduledPriceCents: null,
        scheduledPriceAt: null,
      }),
    );
  });

  it("NFR-001: omitting the schedule entirely writes null/null", async () => {
    const ctx = makeContext();

    await upsertTicketType(ctx.deps, scheduleInput(ctx, "schedule-absent", {}));

    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduledPriceCents: null,
        scheduledPriceAt: null,
      }),
    );
  });
});

/**
 * FR-014 at the CREATE write boundary. The invariant is deliberately different
 * from the schedule's: the two bounds are INDEPENDENT (there is no
 * both-or-neither rule), and only the ORDERING is enforced.
 */
describe("upsertTicketType — sales window (FR-014)", () => {
  const OPENS_AT = new Date("2026-09-01T17:00:00.000Z");
  const CLOSES_AT = new Date("2026-09-20T17:00:00.000Z");

  function windowInput(
    ctx: Context,
    clientKey: string,
    extra: Record<string, unknown>,
  ) {
    return {
      actorHumanId: ctx.defaults.actorHumanId,
      eventId: ctx.defaults.eventId,
      name: ctx.defaults.name,
      description: ctx.defaults.description,
      priceCents: 1200,
      capacity: ctx.defaults.capacity,
      clientKey,
      ...extra,
    };
  }

  it("round-trips a well-ordered window onto the created ticket type", async () => {
    const ctx = makeContext();

    await upsertTicketType(
      ctx.deps,
      windowInput(ctx, "window-ok", {
        salesOpenAt: OPENS_AT,
        salesCloseAt: CLOSES_AT,
      }),
    );

    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledWith(
      expect.objectContaining({
        salesOpenAt: OPENS_AT,
        salesCloseAt: CLOSES_AT,
      }),
    );
  });

  it("accepts an OPEN bound alone — one bound is a complete configuration", async () => {
    const ctx = makeContext();

    await upsertTicketType(
      ctx.deps,
      windowInput(ctx, "window-open-only", { salesOpenAt: OPENS_AT }),
    );

    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledWith(
      expect.objectContaining({ salesOpenAt: OPENS_AT, salesCloseAt: null }),
    );
  });

  it("accepts a CLOSE bound alone", async () => {
    const ctx = makeContext();

    await upsertTicketType(
      ctx.deps,
      windowInput(ctx, "window-close-only", { salesCloseAt: CLOSES_AT }),
    );

    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledWith(
      expect.objectContaining({ salesOpenAt: null, salesCloseAt: CLOSES_AT }),
    );
  });

  it("rejects an INVERTED window and writes nothing", async () => {
    const ctx = makeContext();

    await expect(
      upsertTicketType(
        ctx.deps,
        windowInput(ctx, "window-inverted", {
          salesOpenAt: CLOSES_AT,
          salesCloseAt: OPENS_AT,
        }),
      ),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_SALES_WINDOW_INVALID" });

    expect(ctx.mocks.tickets.createTicketType).not.toHaveBeenCalled();
  });

  it("rejects a ZERO-WIDTH window and writes nothing", async () => {
    const ctx = makeContext();

    await expect(
      upsertTicketType(
        ctx.deps,
        windowInput(ctx, "window-zero", {
          salesOpenAt: OPENS_AT,
          salesCloseAt: OPENS_AT,
        }),
      ),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_SALES_WINDOW_INVALID" });

    expect(ctx.mocks.tickets.createTicketType).not.toHaveBeenCalled();
  });

  it("keeps the window on an ADJUSTABLE tier — sellability is not a price", async () => {
    // The schedule is cleared for ADJUSTABLE because it IS a price and a
    // buyer-priced tier has no list price to override. A window
    // says nothing about the amount, so clearing it would silently discard a
    // legitimate "pay-what-you-can, doors only" configuration.
    const ctx = makeContext();

    await upsertTicketType(
      ctx.deps,
      windowInput(ctx, "window-adjustable", {
        pricingMode: "ADJUSTABLE",
        minimumCents: 0,
        salesOpenAt: OPENS_AT,
        salesCloseAt: CLOSES_AT,
      }),
    );

    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledWith(
      expect.objectContaining({
        pricingMode: "ADJUSTABLE",
        salesOpenAt: OPENS_AT,
        salesCloseAt: CLOSES_AT,
      }),
    );
  });

  it("NFR-001: omitting the window entirely writes null/null", async () => {
    const ctx = makeContext();

    await upsertTicketType(ctx.deps, windowInput(ctx, "window-absent", {}));

    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledWith(
      expect.objectContaining({ salesOpenAt: null, salesCloseAt: null }),
    );
  });
});

// ── Sales lock ───────────────────────────────────────────────────────────────
// The admin editor stops offering new ticket types once the event-level
// `ticketsSold` (events.getPopularityStats) is above zero; the server refuses
// them with the same measure.
describe("upsertTicketType — sales lock", () => {
  it("refuses to create a ticket type once the event has sold a ticket", async () => {
    const ctx = makeContext({ event: { status: "PUBLISHED" }, ticketsSold: 1 });

    await expect(
      upsertTicketType(ctx.deps, {
        actorHumanId: ctx.defaults.actorHumanId,
        eventId: ctx.defaults.eventId,
        name: "Late Add",
        priceCents: 2000,
        capacity: 10,
        clientKey: "locked-create",
      }),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_LOCKED_BY_SALES" });

    expect(ctx.mocks.events.getPopularityStats).toHaveBeenCalledWith([
      DEFAULT_EVENT_ID,
    ]);
    expect(ctx.mocks.tickets.createTicketType).not.toHaveBeenCalled();
    expect(ctx.mocks.audit.log).not.toHaveBeenCalled();
  });

  it("refuses a FREE ticket type too — the lock is about sales, not money", async () => {
    const ctx = makeContext({ ticketsSold: 4 });

    await expect(
      upsertTicketType(ctx.deps, {
        actorHumanId: ctx.defaults.actorHumanId,
        eventId: ctx.defaults.eventId,
        name: "Free Add",
        priceCents: 0,
        capacity: 10,
        clientKey: "locked-free-create",
      }),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_LOCKED_BY_SALES" });

    expect(ctx.mocks.tickets.createTicketType).not.toHaveBeenCalled();
  });

  it("still checks access first: a non-member learns nothing about sales", async () => {
    const ctx = makeContext({ membershipRole: "VIEWER", ticketsSold: 4 });

    await expect(
      upsertTicketType(ctx.deps, {
        actorHumanId: ctx.defaults.actorHumanId,
        eventId: ctx.defaults.eventId,
        name: "Sneaky",
        priceCents: 0,
        capacity: 10,
        clientKey: "locked-non-member",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

    expect(ctx.mocks.events.getPopularityStats).not.toHaveBeenCalled();
  });

  it("creates as before on an event with no sales", async () => {
    const ctx = makeContext({ ticketsSold: 0 });

    const result = await upsertTicketType(ctx.deps, {
      actorHumanId: ctx.defaults.actorHumanId,
      eventId: ctx.defaults.eventId,
      name: "Early Bird",
      priceCents: 1500,
      capacity: 10,
      clientKey: "unlocked-create",
    });

    expect(result).toEqual({
      ticketTypeId: DEFAULT_TICKET_TYPE_ID,
      status: "DRAFT",
    });
    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STORED SEAT PRICE OVERRIDES (seat-price-overrides spec, step 7e). Checkout
// charges a FIXED tier's seat at the seat's stored override, so a FREE FIXED
// tier created on a section that already holds a paid one starts taking money.
// It must pass the gates the override write itself runs.
// ─────────────────────────────────────────────────────────────────────────────

describe("upsertTicketType — a section that already stores seat price overrides", () => {
  const SECTION = DEFAULT_SEAT_SECTION_ID;
  const OTHER_SECTION = "77777777-7777-4777-8777-777777777777";
  const paid: SeatSectionPriceOverride = {
    seatSectionId: SECTION,
    priceOverride: { priceCents: 5000, reason: null },
  };
  const corrupt: SeatSectionPriceOverride = {
    seatSectionId: SECTION,
    priceOverride: { invalid: true },
  };

  function seatedInput(
    ctx: Context,
    clientKey: string,
    extra: Record<string, unknown> = {},
  ) {
    return {
      actorHumanId: ctx.defaults.actorHumanId,
      eventId: ctx.defaults.eventId,
      name: "Floor",
      description: null,
      priceCents: 0,
      capacity: 10,
      seatSectionId: SECTION,
      clientKey,
      ...extra,
    };
  }

  it.each(["DRAFT", "PUBLISHED"] as const)(
    "refuses a free FIXED tier on a section with a paid override when no account is linked (%s event)",
    async (status) => {
      const ctx = makeContext({
        event: { status },
        payee: null,
        seatOverrides: [paid],
      });

      await expect(
        upsertTicketType(ctx.deps, seatedInput(ctx, `no-link-${status}`)),
      ).rejects.toMatchObject({ code: "PAID_TICKETING_REQUIRES_STRIPE" });

      expect(ctx.mocks.listDistinctPriceOverridesByEvent).toHaveBeenCalledTimes(
        1,
      );
      expect(ctx.mocks.listDistinctPriceOverridesByEvent).toHaveBeenCalledWith({
        eventId: ctx.defaults.eventId,
      });
      expect(ctx.mocks.tickets.createTicketType).not.toHaveBeenCalled();
    },
  );

  it("refuses it when no fee policy resolves", async () => {
    const ctx = makeContext({ feePolicy: null, seatOverrides: [paid] });

    await expect(
      upsertTicketType(ctx.deps, seatedInput(ctx, "no-policy")),
    ).rejects.toMatchObject({ code: "PAID_TICKETING_REQUIRES_FEE_POLICY" });

    expect(ctx.mocks.tickets.createTicketType).not.toHaveBeenCalled();
  });

  it("allows it with a linked account and a fee policy", async () => {
    const ctx = makeContext({ seatOverrides: [paid] });

    await upsertTicketType(ctx.deps, seatedInput(ctx, "both-gates"));

    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.payees.getBySubject).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no override", []],
    [
      "only a $0 override",
      [
        {
          seatSectionId: SECTION,
          priceOverride: { priceCents: 0, reason: null },
        },
      ],
    ],
    [
      "nothing, while another section holds a paid one",
      [{ ...paid, seatSectionId: OTHER_SECTION }],
    ],
  ] as [string, SeatSectionPriceOverride[]][])(
    "allows it with no account and no fee policy when the section holds %s",
    async (_label, seatOverrides) => {
      const ctx = makeContext({ payee: null, feePolicy: null, seatOverrides });

      await upsertTicketType(ctx.deps, seatedInput(ctx, "free-section"));

      expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledTimes(1);
      expect(ctx.mocks.payees.getBySubject).not.toHaveBeenCalled();
    },
  );

  it("counts a corrupt stored value as paid and reports it", async () => {
    const reportError = vi.fn();
    const ctx = makeContext({
      payee: null,
      reportError,
      seatOverrides: [corrupt],
    });

    await expect(
      upsertTicketType(ctx.deps, seatedInput(ctx, "corrupt-value")),
    ).rejects.toMatchObject({ code: "PAID_TICKETING_REQUIRES_STRIPE" });

    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: {
          useCase: "upsertTicketType",
          fault: "seat_price_override_invalid",
        },
        extra: expect.objectContaining({
          eventId: ctx.defaults.eventId,
          seatSectionIds: [SECTION],
        }),
      }),
    );
  });

  it("a throwing reporter does not change the corrupt-value verdict", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry is down");
    });
    const refused = makeContext({
      payee: null,
      reportError,
      seatOverrides: [corrupt],
    });
    const allowed = makeContext({ reportError, seatOverrides: [corrupt] });

    await expect(
      upsertTicketType(refused.deps, seatedInput(refused, "corrupt-throw-1")),
    ).rejects.toMatchObject({ code: "PAID_TICKETING_REQUIRES_STRIPE" });
    await upsertTicketType(
      allowed.deps,
      seatedInput(allowed, "corrupt-throw-2"),
    );

    expect(reportError).toHaveBeenCalledTimes(2);
    expect(allowed.mocks.tickets.createTicketType).toHaveBeenCalledTimes(1);
  });

  it("does not read the seats for a tier with no seat section", async () => {
    const ctx = makeContext({ payee: null, seatOverrides: [paid] });

    await upsertTicketType(
      ctx.deps,
      seatedInput(ctx, "no-section", { seatSectionId: null }),
    );

    expect(ctx.mocks.listDistinctPriceOverridesByEvent).not.toHaveBeenCalled();
    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledTimes(1);
  });

  it("does not read the seats for a pay-what-you-want tier, which ignores overrides", async () => {
    const ctx = makeContext({ seatOverrides: [paid] });

    await upsertTicketType(
      ctx.deps,
      seatedInput(ctx, "pwyw-tier", { pricingMode: "ADJUSTABLE" }),
    );

    expect(ctx.mocks.listDistinctPriceOverridesByEvent).not.toHaveBeenCalled();
    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledTimes(1);
  });

  it("a PAID tier runs its own gates exactly once and never reads the seats", async () => {
    const ctx = makeContext({ seatOverrides: [paid] });

    await upsertTicketType(
      ctx.deps,
      seatedInput(ctx, "paid-tier", { priceCents: 2000 }),
    );

    expect(ctx.mocks.listDistinctPriceOverridesByEvent).not.toHaveBeenCalled();
    // One Stripe gate (one payee lookup) and one fee-policy scope walk (no
    // scope asked twice).
    expect(ctx.mocks.payees.getBySubject).toHaveBeenCalledTimes(1);
    const scopesWalked = ctx.mocks.feePolicies.resolveEffective.mock.calls.map(
      ([arg]) => (arg as { scopeType: string }).scopeType,
    );
    expect(scopesWalked.length).toBeGreaterThan(0);
    expect(new Set(scopesWalked).size).toBe(scopesWalked.length);
    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledTimes(1);
  });

  it("the refusal names the stored seat price and the section behind it", async () => {
    const paidCase = makeContext({ payee: null, seatOverrides: [paid] });
    const corruptCase = makeContext({ feePolicy: null, seatOverrides: [corrupt] });

    await expect(
      upsertTicketType(paidCase.deps, seatedInput(paidCase, "meta-paid")),
    ).rejects.toMatchObject({
      code: "PAID_TICKETING_REQUIRES_STRIPE",
      meta: {
        cause: "stored_seat_price",
        seatSectionIds: [SECTION],
        invalidSeatSectionIds: [],
      },
    });
    await expect(
      upsertTicketType(
        corruptCase.deps,
        seatedInput(corruptCase, "meta-corrupt"),
      ),
    ).rejects.toMatchObject({
      code: "PAID_TICKETING_REQUIRES_FEE_POLICY",
      meta: {
        cause: "seat_price_override_invalid",
        seatSectionIds: [SECTION],
        invalidSeatSectionIds: [SECTION],
      },
    });
  });

  it("a PAID tier refused for no linked account carries no stored-price meta", async () => {
    // The paid tier's own gate refuses, before the stored-override gate: the
    // cause is the tier's price, so the meta must not blame a seat price.
    const ctx = makeContext({ payee: null, seatOverrides: [paid] });

    const refusal = await upsertTicketType(
      ctx.deps,
      seatedInput(ctx, "paid-no-link", { priceCents: 2000 }),
    ).catch((err: unknown) => err);

    expect(refusal).toMatchObject({ code: "PAID_TICKETING_REQUIRES_STRIPE" });
    expect((refusal as { meta?: unknown }).meta).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE SEAT SECTION MUST BE ONE OF THIS EVENT'S. The adapter only needs the
// section to exist (a foreign key), so the use case is what keeps a tier of
// this event off a section of another event, and it answers the same whether
// that section exists somewhere else or nowhere.
// ─────────────────────────────────────────────────────────────────────────────

describe("upsertTicketType — a seat section that is not this event's", () => {
  function input(
    ctx: Context,
    clientKey: string,
    extra: Record<string, unknown> = {},
  ) {
    return {
      actorHumanId: ctx.defaults.actorHumanId,
      eventId: ctx.defaults.eventId,
      name: "Floor",
      description: null,
      // Free and FIXED: without the refusal it reaches the stored-override
      // gate and its seat read.
      priceCents: 0,
      capacity: 10,
      seatSectionId: DEFAULT_SEAT_SECTION_ID,
      clientKey,
      ...extra,
    };
  }

  it.each([
    ["a section of another event", FOREIGN_SEAT_SECTION_ID],
    ["an id no section has", MISSING_SEAT_SECTION_ID],
  ])(
    "refuses %s: nothing written, the stored-override gate not run",
    async (_label, seatSectionId) => {
      const ctx = makeContext({ payee: null });

      await expect(
        upsertTicketType(
          ctx.deps,
          input(ctx, `not-ours-${seatSectionId}`, { seatSectionId }),
        ),
      ).rejects.toMatchObject({ code: "SEAT_SECTION_NOT_FOUND" });

      expect(ctx.mocks.tickets.createTicketType).not.toHaveBeenCalled();
      expect(ctx.mocks.audit.log).not.toHaveBeenCalled();
      expect(ctx.mocks.listDistinctPriceOverridesByEvent).not.toHaveBeenCalled();
      expect(ctx.mocks.payees.getBySubject).not.toHaveBeenCalled();
      // The claimed key is failed, never committed: nothing to replay.
      expect(ctx.mocks.idempotency.__mocks.commit).not.toHaveBeenCalled();
      expect(ctx.mocks.idempotency.__mocks.fail).toHaveBeenCalledTimes(1);
    },
  );

  it("answers the same for another event's section and for no section at all", async () => {
    const refusal = async (seatSectionId: string) => {
      const ctx = makeContext();
      const err = await upsertTicketType(
        ctx.deps,
        input(ctx, `same-answer-${seatSectionId}`, { seatSectionId }),
      ).catch((e: unknown) => e);
      const { code, message, meta } = err as {
        code?: string;
        message?: string;
        meta?: unknown;
      };
      return { code, message, meta };
    };

    const foreign = await refusal(FOREIGN_SEAT_SECTION_ID);
    const missing = await refusal(MISSING_SEAT_SECTION_ID);

    expect(foreign).toEqual({
      code: "SEAT_SECTION_NOT_FOUND",
      message: "SEAT_SECTION_NOT_FOUND",
      meta: undefined,
    });
    expect(missing).toEqual(foreign);
  });

  it("a PAID tier with no linked account is refused for the section, not for Stripe", async () => {
    const ctx = makeContext({ payee: null, feePolicy: null });

    await expect(
      upsertTicketType(
        ctx.deps,
        input(ctx, "paid-foreign", {
          priceCents: 2000,
          seatSectionId: FOREIGN_SEAT_SECTION_ID,
        }),
      ),
    ).rejects.toMatchObject({ code: "SEAT_SECTION_NOT_FOUND" });

    expect(ctx.mocks.payees.getBySubject).not.toHaveBeenCalled();
    expect(ctx.mocks.feePolicies.resolveEffective).not.toHaveBeenCalled();
    expect(ctx.mocks.tickets.createTicketType).not.toHaveBeenCalled();
  });

  it("writes a section of the same event, after one event-scoped section read", async () => {
    const ctx = makeContext();

    await upsertTicketType(ctx.deps, input(ctx, "own-section"));

    expect(ctx.mocks.listSectionsByEvent).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.listSectionsByEvent).toHaveBeenCalledWith(
      ctx.defaults.eventId,
    );
    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledWith(
      expect.objectContaining({ seatSectionId: DEFAULT_SEAT_SECTION_ID }),
    );
  });

  it.each([
    ["null", { seatSectionId: null }],
    ["left out", { seatSectionId: undefined }],
  ])(
    "writes a tier with no seat section (%s) without reading any section",
    async (label, extra) => {
      const ctx = makeContext({ eventSeatSectionIds: [] });

      await upsertTicketType(ctx.deps, input(ctx, `no-section-${label}`, extra));

      expect(ctx.mocks.listSectionsByEvent).not.toHaveBeenCalled();
      expect(ctx.mocks.getSectionById).not.toHaveBeenCalled();
      expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledWith(
        expect.objectContaining({ seatSectionId: null }),
      );
    },
  );

  it("a caller with no edit role is refused for the role, before any section read", async () => {
    const ctx = makeContext({ membershipRole: null });

    await expect(
      upsertTicketType(
        ctx.deps,
        input(ctx, "no-edit-role", { seatSectionId: FOREIGN_SEAT_SECTION_ID }),
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

    expect(ctx.mocks.listSectionsByEvent).not.toHaveBeenCalled();
  });
});

/**
 * organiser-resale-share FR-001: a new ticket type allowing resale needs the
 * event's resale clause set, as `updateTicketType` refuses the switch.
 */
describe("upsertTicketType — resale needs the event's clause", () => {
  const RESALE_TERMS_ID = "66666666-6666-4666-8666-666666666666";
  const create = (ctx: Context) =>
    upsertTicketType(ctx.deps, {
      actorHumanId: ctx.defaults.actorHumanId,
      eventId: ctx.defaults.eventId,
      name: "Resellable",
      description: null,
      priceCents: 4000,
      capacity: 10,
      resaleAllowed: true,
      clientKey: "resale-gate",
    });

  it("no RESALE terms → RESALE_TERMS_MISSING, nothing created", async () => {
    const ctx = makeContext();
    await expect(create(ctx)).rejects.toMatchObject({ code: "RESALE_TERMS_MISSING" });
    expect(ctx.mocks.tickets.createTicketType).not.toHaveBeenCalled();
  });

  it("RESALE terms with the clause not set → RESALE_TERMS_MISSING, nothing created", async () => {
    const ctx = makeContext({
      event: { resalePayoutTermsId: RESALE_TERMS_ID },
      resaleTerms: { id: RESALE_TERMS_ID, resaleShareType: null },
    });
    await expect(create(ctx)).rejects.toMatchObject({
      code: "RESALE_TERMS_MISSING",
      meta: { reason: "resale_clause_not_set" },
    });
    expect(ctx.mocks.tickets.createTicketType).not.toHaveBeenCalled();
  });

  it("a set clause on terms with no RESALE line → AGREEMENT_MISSING_LINES, nothing created", async () => {
    const ctx = makeContext({
      event: { resalePayoutTermsId: RESALE_TERMS_ID },
      resaleTerms: { id: RESALE_TERMS_ID, resaleShareType: "PERCENT", resaleShareBps: 500 },
      resaleLines: 0,
    });
    await expect(create(ctx)).rejects.toMatchObject({
      code: "AGREEMENT_MISSING_LINES",
      meta: { reason: "resale_lines_missing" },
    });
    expect(ctx.mocks.tickets.createTicketType).not.toHaveBeenCalled();
  });

  it("locks the event row (share) before the RESALE terms: the publish lock order (review: 40P01)", async () => {
    const ctx = makeContext({
      event: { resalePayoutTermsId: RESALE_TERMS_ID },
      resaleTerms: { id: RESALE_TERMS_ID, resaleShareType: "PERCENT", resaleShareBps: 500 },
    });
    await create(ctx);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx = (await ctx.deps.repos.tx(async (t) => t)) as any;
    expect(tx.events.lockRows).toHaveBeenCalledWith({ ids: [ctx.defaults.eventId], mode: "share" });
    const [lockRowsAt] = tx.events.lockRows.mock.invocationCallOrder;
    const [lockTermsAt] = tx.deals.lockTerms.mock.invocationCallOrder;
    expect(lockRowsAt).toBeLessThan(lockTermsAt);
    expect(tx.deals.lockTerms.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.mocks.tickets.createTicketType.mock.invocationCallOrder[0],
    );
  });

  it("a type without resale takes no event lock", async () => {
    const ctx = makeContext();
    await upsertTicketType(ctx.deps, {
      actorHumanId: ctx.defaults.actorHumanId,
      eventId: ctx.defaults.eventId,
      name: "Plain",
      description: null,
      priceCents: 4000,
      capacity: 10,
      resaleAllowed: false,
      clientKey: "no-resale",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx = (await ctx.deps.repos.tx(async (t) => t)) as any;
    expect(tx.events.lockRows).not.toHaveBeenCalled();
  });

  it("a set clause → created with resale allowed", async () => {
    const ctx = makeContext({
      event: { resalePayoutTermsId: RESALE_TERMS_ID },
      resaleTerms: { id: RESALE_TERMS_ID, resaleShareType: "PERCENT", resaleShareBps: 500 },
    });
    await create(ctx);
    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledWith(
      expect.objectContaining({ resaleAllowed: true }),
    );
  });
});
