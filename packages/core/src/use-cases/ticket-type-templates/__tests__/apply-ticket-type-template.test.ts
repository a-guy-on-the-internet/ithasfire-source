import { describe, expect, it, vi } from "vitest";

import { applyTicketTypeTemplate } from "../apply-ticket-type-template";
import { createFakeIdempotencyPort, createTestLogger } from "@th/test-utils";
import type { EventRecord } from "@th/ports/repos/events";
import type {
  TicketTypeTemplateEntry,
  TicketTypeTemplateRecord,
} from "@th/types";
import type { Repos, TxRepos } from "@th/ports/repos";

const DEFAULT_EVENT_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_ORG_ID = "22222222-2222-4222-8222-222222222222";
const DEFAULT_ACTOR_ID = "33333333-3333-4333-8333-333333333333";
const DEFAULT_TEMPLATE_ID = "44444444-4444-4444-8444-444444444444";
const FIXED_NOW = new Date("2026-07-23T12:00:00.000Z");

const BASE_ENTRIES: TicketTypeTemplateEntry[] = [
  {
    name: "GA",
    priceCents: 2500,
    pricingMode: "FIXED",
    minimumCents: null,
    suggestedCents: null,
    capacity: 100,
    resaleAllowed: false,
    resaleCapCents: null,
    transferAllowed: true,
  },
  {
    name: "VIP",
    priceCents: 10000,
    pricingMode: "FIXED",
    minimumCents: null,
    suggestedCents: null,
    capacity: 20,
    resaleAllowed: false,
    resaleCapCents: null,
    transferAllowed: true,
  },
];

interface MakeContextOptions {
  entries?: TicketTypeTemplateEntry[];
  templateArchivedAt?: Date | null;
  event?: Partial<EventRecord> | null;
  membershipRole?: string | null;
  /** Ticket-type names that already exist on the event. */
  existingNames?: string[];
  /**
   * Names that appear on the event only AFTER the pre-check (simulates a
   * concurrent create racing the apply loop).
   */
  lateNames?: string[];
  /** Resolved resale feature gate. Defaults to true (gate on). */
  resaleEnabled?: boolean;
  /**
   * The resale clause on the event's RESALE terms (organiser-resale-share
   * FR-001); the fixture points `event.resalePayoutTermsId` at them when set.
   * Default: no RESALE terms.
   */
  resaleClause?: { resaleShareType: "PERCENT" | "FLAT" | null; resaleShareBps?: number | null };
  /** Turns the fixture into a platform catalogue row (FR-007). */
  platform?: boolean;
  /** Status of the platform row's owning pack. Defaults to LIVE. */
  packStatus?: "DRAFT" | "LIVE";
  /**
   * Event-level sold count behind the ticket-type sales lock
   * (events.getPopularityStats). Defaults to 0 — no sales, no lock.
   */
  ticketsSold?: number;
}

const DEFAULT_PACK_ID = "66666666-6666-4666-8666-666666666666";

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: DEFAULT_EVENT_ID,
    orgId: DEFAULT_ORG_ID,
    humanId: null,
    title: "Launch Party",
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
    timezone: "America/Chicago",
    startsAt: new Date("2026-08-01T20:00:00.000Z"),
    endsAt: null,
    publishedAt: null,
    placeId: null,
    savedLocationId: null,
    addressText: null,
    lat: null,
    lng: null,
    categoryId: null,
    categorySeoType: null,
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
    ...overrides,
  } as EventRecord;
}

function makeTemplate(
  entries: TicketTypeTemplateEntry[],
  archivedAt: Date | null,
  platform = false,
): TicketTypeTemplateRecord {
  return {
    id: DEFAULT_TEMPLATE_ID,
    ownerScope: "ORGANIZATION",
    ownerId: platform ? null : DEFAULT_ORG_ID,
    name: "Standard door split",
    ticketTypes: entries,
    isPlatform: platform,
    packId: platform ? DEFAULT_PACK_ID : null,
    createdByHumanId: platform ? null : DEFAULT_ACTOR_ID,
    createdAt: new Date("2026-07-01T12:00:00.000Z"),
    updatedAt: new Date("2026-07-01T12:00:00.000Z"),
    archivedAt,
  };
}

function makeContext(options: MakeContextOptions = {}) {
  const template = makeTemplate(
    options.entries ?? BASE_ENTRIES,
    options.templateArchivedAt ?? null,
    options.platform ?? false,
  );
  const eventExists = options.event !== null;
  const RESALE_TERMS_ID = "77777777-7777-4777-8777-777777777777";
  const event = makeEvent({
    ...(options.resaleClause ? { resalePayoutTermsId: RESALE_TERMS_ID } : {}),
    ...(options.event ?? {}),
  });
  const membershipRole =
    options.membershipRole === undefined ? "ADMIN" : options.membershipRole;

  const existingNames = new Set(
    (options.existingNames ?? []).map((n) => n.toLowerCase()),
  );
  const lateNames = new Set(
    (options.lateNames ?? []).map((n) => n.toLowerCase()),
  );
  // The pre-check pass calls findTicketTypeByName once per entry; after that
  // the upsert path sees late (raced) names too.
  let preCheckCallsRemaining = template.ticketTypes.length;

  const packStatus = options.packStatus ?? "LIVE";
  const ticketTypeTemplatesRepo = {
    getById: vi.fn(async (id: string) =>
      id === template.id ? template : null,
    ),
    findByName: vi.fn(async () => null),
    create: vi.fn(),
    list: vi.fn(async () => []),
    archive: vi.fn(),
    getPack: vi.fn(async (id: string) =>
      id === DEFAULT_PACK_ID
        ? {
            id: DEFAULT_PACK_ID,
            key: "general-admission",
            name: "General admission",
            blurb: null,
            status: packStatus,
            sortOrder: 0,
            curatedByHumanId: null,
            createdAt: FIXED_NOW,
            updatedAt: FIXED_NOW,
          }
        : null,
    ),
  };

  let createdCount = 0;
  const ticketsRepo = {
    findTicketTypeByName: vi.fn(async (_eventId: string, name: string) => {
      const key = name.toLowerCase();
      const inPreCheck = preCheckCallsRemaining > 0;
      if (inPreCheck) preCheckCallsRemaining -= 1;
      if (existingNames.has(key)) return { id: `existing-${key}`, name };
      if (!inPreCheck && lateNames.has(key)) return { id: `late-${key}`, name };
      return null;
    }),
    createTicketType: vi.fn(
      async (input: {
        eventId: string;
        name: string;
        priceCents: number;
        capacity: number;
        status: string;
        createdAt: Date;
      }) => {
        createdCount += 1;
        return {
          id: `55555555-5555-4555-8555-55555555555${createdCount}`,
          eventId: input.eventId,
          name: input.name,
          description: null,
          priceCents: input.priceCents,
          pricingMode: "FIXED",
          minimumCents: null,
          suggestedCents: null,
          capacity: input.capacity,
          status: input.status,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
          seatSectionId: null,
          resaleAllowed: false,
          resaleCapCents: null,
          transferAllowed: true,
        };
      },
    ),
  };

  const authzRepo = {
    getHumanDelegation: vi.fn(async () => null),
    getOrgMembership: vi.fn(
      async ({ orgId, humanId }: { orgId: string; humanId: string }) => {
        if (orgId !== DEFAULT_ORG_ID) return null;
        if (humanId !== DEFAULT_ACTOR_ID) return null;
        if (membershipRole === null) return null;
        return { orgId, humanId, role: membershipRole };
      },
    ),
  };

  const auditRepo = { log: vi.fn(async () => {}) };

  const txRepos = {
    ticketTypeTemplates: ticketTypeTemplatesRepo,
    tickets: ticketsRepo,
    events: {
      getById: vi.fn(async (id: string) =>
        eventExists && id === event.id ? event : null,
      ),
      // Event row before RESALE terms (`requireEventResaleClauseSet`).
      lockRows: vi.fn(async (_input: { ids: string[]; mode: "share" | "update" }) => {}),
      // Sales lock read inside upsertTicketType (ticket-sales-lock).
      getPopularityStats: vi.fn(async (eventIds: string[]) =>
        eventIds.map((eventId) => ({
          eventId,
          ticketsSold: options.ticketsSold ?? 0,
          totalCapacity: 0,
          waitlistCount: 0,
        })),
      ),
    },
    authz: authzRepo,
    audit: auditRepo,
    organizations: {
      getById: vi.fn(async (id: string) =>
        id === DEFAULT_ORG_ID ? { id, name: "Org", status: "ACTIVE" } : null,
      ),
    },
    humans: {
      getById: vi.fn(async (id: string) => ({ id, status: "ACTIVE" })),
    },
    payees: {
      getBySubject: vi.fn(async () => ({
        id: "payee-1",
        stripeAccountId: "acct_test",
      })),
      getById: vi.fn(async () => ({
        id: "payee-1",
        stripeAccountId: "acct_test",
      })),
    },
    payoutTerms: {
      getById: vi.fn(async (id: string) =>
        options.resaleClause && id === RESALE_TERMS_ID
          ? { id, ...options.resaleClause }
          : null,
      ),
      listLines: vi.fn(async (id: string) =>
        options.resaleClause && id === RESALE_TERMS_ID ? [{ id: "resale-line-1" }] : [],
      ),
    },
    // The resale-clause gate reads the RESALE terms under their lock.
    deals: {
      lockTerms: vi.fn(async (id: string) => !!options.resaleClause && id === RESALE_TERMS_ID),
    },
    // upsertTicketType gates a money-taking tier on a resolvable fee policy
    // (EVENT → ORG → GLOBAL) alongside the Stripe gate. Templates carry paid
    // entries, so the platform GLOBAL policy has to resolve here.
    feePolicies: {
      getById: vi.fn(async () => null),
      resolveEffective: vi.fn(
        async ({ scopeType }: { scopeType: "EVENT" | "ORG" | "GLOBAL" }) =>
          scopeType === "GLOBAL"
            ? { id: "fee-policy-global", scopeType: "GLOBAL", scopeId: null }
            : null,
      ),
    },
  } as unknown as TxRepos;

  const repos = {
    ...txRepos,
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos),
  } as unknown as Repos;

  const deps = {
    repos,
    idempotency: createFakeIdempotencyPort(),
    clock: { now: () => FIXED_NOW },
    resaleEnabled: options.resaleEnabled ?? true,
    logger: createTestLogger(),
  };

  return {
    deps,
    template,
    event,
    mocks: {
      tickets: ticketsRepo,
      audit: auditRepo,
      ticketTypeTemplates: ticketTypeTemplatesRepo,
    },
  };
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    actorHumanId: DEFAULT_ACTOR_ID,
    eventId: DEFAULT_EVENT_ID,
    templateId: DEFAULT_TEMPLATE_ID,
    clientKey: "apply-template-key",
    ...overrides,
  };
}

describe("applyTicketTypeTemplate", () => {
  it("creates every entry on the event and audits the apply", async () => {
    const ctx = makeContext();

    const result = await applyTicketTypeTemplate(ctx.deps, baseInput());

    expect(result).toEqual({ created: ["GA", "VIP"], skipped: [], warnings: [] });
    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledTimes(2);
    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: DEFAULT_EVENT_ID,
        name: "GA",
        priceCents: 2500,
        capacity: 100,
        status: "DRAFT",
        seatSectionId: null,
      }),
    );
    expect(ctx.mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "ticket_type_template",
        entityId: DEFAULT_TEMPLATE_ID,
        action: "applied",
        data: expect.objectContaining({
          eventId: DEFAULT_EVENT_ID,
          created: ["GA", "VIP"],
          skipped: [],
        }),
        at: FIXED_NOW,
      }),
    );
  });

  it("skips entries whose name already exists on the event", async () => {
    const ctx = makeContext({ existingNames: ["GA"] });

    const result = await applyTicketTypeTemplate(ctx.deps, baseInput());

    expect(result).toEqual({ created: ["VIP"], skipped: ["GA"], warnings: [] });
    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledTimes(1);
    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledWith(
      expect.objectContaining({ name: "VIP" }),
    );
  });

  it("skips entries that lose a same-name race after the pre-check", async () => {
    const ctx = makeContext({ lateNames: ["VIP"] });

    const result = await applyTicketTypeTemplate(ctx.deps, baseInput());

    expect(result).toEqual({ created: ["GA"], skipped: ["VIP"], warnings: [] });
    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledTimes(1);
  });

  it("clamps stored resale config when the resale gate is off", async () => {
    const resaleEntry: TicketTypeTemplateEntry = {
      ...BASE_ENTRIES[1]!,
      name: "Resale VIP",
      resaleAllowed: true,
      resaleCapCents: 20000,
    };
    const ctx = makeContext({
      entries: [resaleEntry],
      resaleEnabled: false,
    });

    const result = await applyTicketTypeTemplate(ctx.deps, baseInput());

    expect(result).toEqual({ created: ["Resale VIP"], skipped: [], warnings: [] });
    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Resale VIP",
        resaleAllowed: false,
        resaleCapCents: null,
      }),
    );
  });

  it("preserves stored resale config when the resale gate is on", async () => {
    const resaleEntry: TicketTypeTemplateEntry = {
      ...BASE_ENTRIES[1]!,
      name: "Resale VIP",
      resaleAllowed: true,
      resaleCapCents: 20000,
    };
    const ctx = makeContext({
      entries: [resaleEntry],
      resaleEnabled: true,
      resaleClause: { resaleShareType: "PERCENT", resaleShareBps: 1000 },
    });

    const result = await applyTicketTypeTemplate(ctx.deps, baseInput());

    expect(result).toEqual({ created: ["Resale VIP"], skipped: [], warnings: [] });
    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Resale VIP",
        resaleAllowed: true,
        resaleCapCents: 20000,
      }),
    );
    // Event row before RESALE terms, in the precheck and in the per-entry
    // upsert alike (the publish lock order; opposite orders deadlock).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repos = ctx.deps.repos as any;
    const rows: number[] = repos.events.lockRows.mock.invocationCallOrder;
    const terms: number[] = repos.deals.lockTerms.mock.invocationCallOrder;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBe(terms.length);
    rows.forEach((at, i) => expect(at).toBeLessThan(terms[i]!));
    expect(repos.events.lockRows).toHaveBeenCalledWith({ ids: [ctx.event.id], mode: "share" });
  });

  // organiser-resale-share FR-001: refused whole, before any entry is made.
  it("refuses a template that would switch resale on while the event's clause is not set, creating nothing", async () => {
    const ctx = makeContext({
      entries: [
        { ...BASE_ENTRIES[0]!, name: "General" },
        { ...BASE_ENTRIES[1]!, name: "Resale VIP", resaleAllowed: true, resaleCapCents: 20000 },
      ],
      resaleEnabled: true,
      resaleClause: { resaleShareType: null },
    });

    await expect(applyTicketTypeTemplate(ctx.deps, baseInput())).rejects.toMatchObject({
      code: "RESALE_TERMS_MISSING",
    });
    expect(ctx.mocks.tickets.createTicketType).not.toHaveBeenCalled();
  });

  it("with the resale gate off, resale entries are clamped and need no clause", async () => {
    const ctx = makeContext({
      entries: [{ ...BASE_ENTRIES[1]!, name: "Resale VIP", resaleAllowed: true, resaleCapCents: 20000 }],
      resaleEnabled: false,
    });

    await expect(applyTicketTypeTemplate(ctx.deps, baseInput())).resolves.toMatchObject({
      created: ["Resale VIP"],
    });
  });

  it("rejects an archived template", async () => {
    const ctx = makeContext({ templateArchivedAt: new Date() });

    await expect(
      applyTicketTypeTemplate(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "TEMPLATE_ARCHIVED" });
    expect(ctx.mocks.tickets.createTicketType).not.toHaveBeenCalled();
  });

  it("rejects a missing template", async () => {
    const ctx = makeContext();

    await expect(
      applyTicketTypeTemplate(
        ctx.deps,
        baseInput({ templateId: "99999999-9999-4999-8999-999999999999" }),
      ),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
  });

  it("requires edit access to the event", async () => {
    // VIEWER passes the template VIEW gate but fails the event EDIT gate.
    const ctx = makeContext({ membershipRole: "VIEWER" });

    await expect(
      applyTicketTypeTemplate(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(ctx.mocks.tickets.createTicketType).not.toHaveBeenCalled();
  });

  it("rejects events the template owner cannot touch", async () => {
    const ctx = makeContext({
      event: { orgId: null, humanId: "99999999-9999-4999-8999-999999999999" },
    });

    await expect(
      applyTicketTypeTemplate(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("refuses the apply on an event that has sold tickets (upsertTicketType's sales lock)", async () => {
    const ctx = makeContext({ event: { status: "PUBLISHED" }, ticketsSold: 2 });

    await expect(
      applyTicketTypeTemplate(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_LOCKED_BY_SALES" });
    expect(ctx.mocks.tickets.createTicketType).not.toHaveBeenCalled();
  });

  it("rejects archived events before creating anything", async () => {
    const ctx = makeContext({ event: { status: "ARCHIVED" } });

    await expect(
      applyTicketTypeTemplate(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "EVENT_ARCHIVED" });
    expect(ctx.mocks.tickets.createTicketType).not.toHaveBeenCalled();
  });

  // ── FR-007: LIVE platform templates apply; DRAFT is indistinguishable
  //    from absent ─────────────────────────────────────────────────────────

  it("applies a LIVE platform template through the same path", async () => {
    const ctx = makeContext({ platform: true });

    const result = await applyTicketTypeTemplate(ctx.deps, baseInput());

    expect(result).toEqual({ created: ["GA", "VIP"], skipped: [], warnings: [] });
    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledTimes(2);
  });

  it("rejects a DRAFT pack's template as TEMPLATE_NOT_FOUND", async () => {
    const ctx = makeContext({ platform: true, packStatus: "DRAFT" });

    await expect(
      applyTicketTypeTemplate(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
    expect(ctx.mocks.tickets.createTicketType).not.toHaveBeenCalled();
  });

  it("still requires event edit access for a platform template", async () => {
    const ctx = makeContext({ platform: true, membershipRole: "VIEWER" });

    await expect(
      applyTicketTypeTemplate(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(ctx.mocks.tickets.createTicketType).not.toHaveBeenCalled();
  });

  it("fails closed on a null-owner row without the platform flag", async () => {
    const ctx = makeContext({ platform: true });
    const template = makeTemplate(BASE_ENTRIES, null, true);
    ctx.mocks.ticketTypeTemplates.getById.mockResolvedValue({
      ...template,
      isPlatform: false,
    });

    await expect(
      applyTicketTypeTemplate(ctx.deps, baseInput()),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
  });

  // ── Legacy stored entries: the removed door price (FR-012) ───────────────

  it("applies a stored entry that still carries the removed doorPriceCents key at the list price", async () => {
    // Templates saved before door-sales-same-price-and-tax FR-012 hold the
    // key in their JSON. It must neither block the apply nor reach the
    // created ticket type: the door sells at the event-page price.
    const legacyEntry = {
      name: "Advance",
      priceCents: 1500,
      pricingMode: "FIXED",
      minimumCents: null,
      suggestedCents: null,
      capacity: 100,
      resaleAllowed: false,
      resaleCapCents: null,
      transferAllowed: true,
      doorPriceCents: 2000,
    };
    const ctx = makeContext({
      entries: [legacyEntry] as unknown as MakeContextOptions["entries"],
    });

    const result = await applyTicketTypeTemplate(ctx.deps, baseInput());

    expect(result).toEqual({ created: ["Advance"], skipped: [], warnings: [] });
    const created = ctx.mocks.tickets.createTicketType.mock.calls[0]?.[0];
    expect(created).toMatchObject({ name: "Advance", priceCents: 1500 });
    expect(created).not.toHaveProperty("doorPriceCents");
  });

  // ── FR-011 / FR-016: relative schedule + window materialization ─────────

  /** An early-bird entry: on sale at publish, closing 14 days out, $12 → $20. */
  const RELATIVE_ENTRY: TicketTypeTemplateEntry = {
    name: "Early bird",
    priceCents: 1200,
    pricingMode: "FIXED",
    minimumCents: null,
    suggestedCents: null,
    capacity: 30,
    resaleAllowed: false,
    resaleCapCents: null,
    transferAllowed: true,
    salesOpen: { anchor: "EVENT_PUBLISH", offsetMinutes: 0 },
    salesClose: { anchor: "EVENT_START", offsetMinutes: -20160 },
    scheduledPriceChange: {
      at: { anchor: "EVENT_START", offsetMinutes: -10080 },
      priceCents: 2000,
    },
  };

  it("materializes a relative entry into absolute instants on the created type", async () => {
    const ctx = makeContext({
      entries: [RELATIVE_ENTRY],
      // 2026-10-01T20:00Z — 14 days out is 2026-09-17T20:00Z, 7 days out is
      // 2026-09-24T20:00Z. Both are after FIXED_NOW (2026-07-23T12:00Z).
      event: { startsAt: new Date("2026-10-01T20:00:00.000Z") },
    });

    const result = await applyTicketTypeTemplate(ctx.deps, baseInput());

    expect(result).toEqual({
      created: ["Early bird"],
      skipped: [],
      warnings: [],
    });
    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Early bird",
        priceCents: 1200,
        // EVENT_PUBLISH resolves against APPLY TIME (FR-016), not the event's
        // publishedAt — which is null on this DRAFT event anyway.
        salesOpenAt: FIXED_NOW,
        salesCloseAt: new Date("2026-09-17T20:00:00.000Z"),
        scheduledPriceCents: 2000,
        scheduledPriceAt: new Date("2026-09-24T20:00:00.000Z"),
      }),
    );
  });

  it("ACCEPTANCE — one template applied to two events on different dates yields different instants", async () => {
    const october = makeContext({
      entries: [RELATIVE_ENTRY],
      event: { startsAt: new Date("2026-10-01T20:00:00.000Z") },
    });
    await applyTicketTypeTemplate(october.deps, baseInput());

    const december = makeContext({
      entries: [RELATIVE_ENTRY],
      event: { startsAt: new Date("2026-12-05T02:00:00.000Z") },
    });
    await applyTicketTypeTemplate(december.deps, baseInput());

    const octoberCall = october.mocks.tickets.createTicketType.mock.calls[0]![0];
    const decemberCall =
      december.mocks.tickets.createTicketType.mock.calls[0]![0];

    expect(octoberCall.salesCloseAt).toEqual(
      new Date("2026-09-17T20:00:00.000Z"),
    );
    expect(decemberCall.salesCloseAt).toEqual(
      new Date("2026-11-21T02:00:00.000Z"),
    );
    expect(octoberCall.scheduledPriceAt).toEqual(
      new Date("2026-09-24T20:00:00.000Z"),
    );
    expect(decemberCall.scheduledPriceAt).toEqual(
      new Date("2026-11-28T02:00:00.000Z"),
    );
  });

  it("still creates the type, with a per-entry warning, when the window has already elapsed", async () => {
    const ctx = makeContext({
      entries: [RELATIVE_ENTRY],
      // A show 3 days out: the 14-day close is already in the past at apply
      // time, and so is the 7-day price flip.
      event: { startsAt: new Date("2026-07-26T20:00:00.000Z") },
    });

    const result = await applyTicketTypeTemplate(ctx.deps, baseInput());

    expect(result).toEqual({
      created: ["Early bird"],
      skipped: [],
      warnings: [
        {
          entryName: "Early bird",
          field: "salesWindow",
          reason: "already_elapsed",
        },
        {
          entryName: "Early bird",
          field: "scheduledPrice",
          reason: "already_elapsed",
        },
      ],
    });
    // Never a born-unsellable or already-flipped tier: the fields are nulled,
    // the list price is untouched, and the type exists.
    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Early bird",
        priceCents: 1200,
        salesOpenAt: null,
        salesCloseAt: null,
        scheduledPriceCents: null,
        scheduledPriceAt: null,
      }),
    );
  });

  it("audits the drops alongside the created/skipped names", async () => {
    const ctx = makeContext({
      entries: [RELATIVE_ENTRY],
      event: { startsAt: new Date("2026-07-26T20:00:00.000Z") },
    });

    await applyTicketTypeTemplate(ctx.deps, baseInput());

    expect(ctx.mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "ticket_type_template",
        action: "applied",
        data: expect.objectContaining({
          warnings: [
            {
              entryName: "Early bird",
              field: "salesWindow",
              reason: "already_elapsed",
            },
            {
              entryName: "Early bird",
              field: "scheduledPrice",
              reason: "already_elapsed",
            },
          ],
        }),
      }),
    );
  });

  it("does not warn about an entry that was skipped for a name collision", async () => {
    const ctx = makeContext({
      entries: [RELATIVE_ENTRY],
      existingNames: ["Early bird"],
      event: { startsAt: new Date("2026-07-26T20:00:00.000Z") },
    });

    const result = await applyTicketTypeTemplate(ctx.deps, baseInput());

    expect(result).toEqual({
      created: [],
      skipped: ["Early bird"],
      warnings: [],
    });
  });

  it("withdraws a warning when the entry loses a same-name race after the pre-check", async () => {
    const ctx = makeContext({
      entries: [RELATIVE_ENTRY],
      lateNames: ["Early bird"],
      event: { startsAt: new Date("2026-07-26T20:00:00.000Z") },
    });

    const result = await applyTicketTypeTemplate(ctx.deps, baseInput());

    expect(result).toEqual({
      created: [],
      skipped: ["Early bird"],
      warnings: [],
    });
  });

  it("a CORRUPT relative field degrades that entry instead of aborting the apply", async () => {
    // The regression this pins: a non-finite offset used to resolve to an
    // Invalid Date, pass both drop rules (every NaN comparison is false), and
    // throw TICKET_TYPE_SALES_WINDOW_INVALID out of `upsertTicketType` — which
    // `createEntries` does not catch, so entry 1 stayed committed and entries 3+
    // were never attempted. A `Json` column has no schema to stop that.
    const ctx = makeContext({
      entries: [
        BASE_ENTRIES[0]!,
        {
          ...RELATIVE_ENTRY,
          salesClose: {
            anchor: "EVENT_START",
            offsetMinutes: "fourteen days" as never,
          },
        },
        BASE_ENTRIES[1]!,
      ],
      event: { startsAt: new Date("2026-10-01T20:00:00.000Z") },
    });

    const result = await applyTicketTypeTemplate(ctx.deps, baseInput());

    // Every entry created; only the unreadable field dropped.
    expect(result.created).toEqual(["GA", "Early bird", "VIP"]);
    expect(result.warnings).toEqual([
      {
        entryName: "Early bird",
        field: "salesWindow",
        reason: "unresolvable",
      },
    ]);
    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledTimes(3);
    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Early bird",
        salesOpenAt: null,
        salesCloseAt: null,
        // The half of the entry that DID resolve is untouched.
        scheduledPriceAt: new Date("2026-09-24T20:00:00.000Z"),
      }),
    );
  });

  it("NFR-001 — an entry with no relative fields sends the same nulls as before", async () => {
    // BASE_ENTRIES predate the relative keys entirely, exactly like every
    // template stored before 2026-08-12.
    const ctx = makeContext();

    await applyTicketTypeTemplate(ctx.deps, baseInput());

    for (const call of ctx.mocks.tickets.createTicketType.mock.calls) {
      expect(call[0]).toMatchObject({
        salesOpenAt: null,
        salesCloseAt: null,
        scheduledPriceCents: null,
        scheduledPriceAt: null,
      });
    }
  });

  it("replays the same result under idempotency", async () => {
    const ctx = makeContext();
    const input = baseInput();

    const first = await applyTicketTypeTemplate(ctx.deps, input);
    const second = await applyTicketTypeTemplate(ctx.deps, input);

    expect(first).toEqual(second);
    expect(ctx.mocks.tickets.createTicketType).toHaveBeenCalledTimes(2);
    expect(ctx.mocks.audit.log).toHaveBeenCalledTimes(3); // 2 per-entry + 1 apply
  });
});

describe("applyTicketTypeTemplate — an entry the write boundary refuses", () => {
  // Stored before the $10,000.00 PWYW cap existed (the read schema is
  // deliberately lenient, so it still loads).
  const OVER_CAP: TicketTypeTemplateEntry = {
    name: "Sliding scale",
    priceCents: 0,
    pricingMode: "ADJUSTABLE",
    minimumCents: 1_000_001,
    suggestedCents: 1_500_000,
    capacity: 50,
    resaleAllowed: false,
    resaleCapCents: null,
    transferAllowed: true,
  };

  it("regression: refuses the WHOLE apply, by entry name, before creating anything", async () => {
    // GA first: the old one-at-a-time loop created it, then failed on the
    // second entry with a generic invalid-input 400 — a half-applied template.
    const ctx = makeContext({ entries: [BASE_ENTRIES[0]!, OVER_CAP] });

    await expect(
      applyTicketTypeTemplate(ctx.deps, baseInput()),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "template_entry_invalid",
      meta: {
        entryName: "Sliding scale",
        reason: expect.stringMatching(/capped at \$10,000\.00 per ticket/),
      },
    });
    expect(ctx.mocks.tickets.createTicketType).not.toHaveBeenCalled();
  });

  it("an entry that is SKIPPED (name already on the event) is not checked", async () => {
    const ctx = makeContext({
      entries: [BASE_ENTRIES[0]!, OVER_CAP],
      existingNames: ["Sliding scale"],
    });
    const result = await applyTicketTypeTemplate(ctx.deps, baseInput());
    expect(result).toEqual({
      created: ["GA"],
      skipped: ["Sliding scale"],
      warnings: [],
    });
  });
});
