import { describe, expect, it, vi } from "vitest";

import { updateTicketType } from "../update-ticket-type";
import { createTestLogger } from "@th/test-utils/fakes/logger";
import type { EventRecord } from "@th/ports/repos/events";
import type { TicketTypeRecord } from "@th/ports/repos/tickets";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { SeatSectionPriceOverride } from "@th/ports/repos/seats";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "33333333-3333-4333-8333-333333333333";
const TICKET_TYPE_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2025-01-10T00:00:00.000Z");

// Human-owned DRAFT event so the owner path authorizes without an authz mock.
const baseEvent: EventRecord = {
  id: EVENT_ID,
  orgId: null,
  humanId: ACTOR_ID,
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

function makeStoredTicketType(
  overrides: Partial<TicketTypeRecord> = {},
): TicketTypeRecord {
  return {
    id: TICKET_TYPE_ID,
    eventId: EVENT_ID,
    name: "VIP",
    description: null,
    priceCents: 5000,
    pricingMode: "FIXED",
    minimumCents: null,
    suggestedCents: null,
    capacity: 50,
    status: "DRAFT",
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    updatedAt: new Date("2025-01-01T00:00:00.000Z"),
    seatSectionId: null,
    resaleAllowed: false,
    resaleCapCents: null,
    transferAllowed: true,
    scheduledPriceCents: null,
    scheduledPriceAt: null,
    salesOpenAt: null,
    salesCloseAt: null,
    ...overrides,
  };
}

type ContextOptions = {
  /**
   * Fee policy the EVENT → ORG → GLOBAL walk resolves to. Defaults to a GLOBAL
   * policy (the platform-configured normal case); `null` empties every scope.
   */
  feePolicy?: { id: string; scopeType: "EVENT" | "ORG" | "GLOBAL" } | null;
  /**
   * What `payees.getBySubject` returns for the event's owner. Defaults to a
   * connected payee (the normal case); `null` = the owner never onboarded to
   * Stripe Connect. The repo projects `{ id }` only — see `payee` below for
   * the capability fields, which this lookup deliberately cannot see.
   */
  payee?: { id: string; stripeAccountId?: string | null } | null;
  reportError?: ReporterPort;
  /**
   * Event-level sold count `events.getPopularityStats` reports (the measure
   * behind the editor's lock). Defaults to 0 — no sales, no lock.
   */
  ticketsSold?: number;
  /** What `seats.listDistinctPriceOverridesByEvent` returns. Default: none. */
  seatOverrides?: SeatSectionPriceOverride[];
  /**
   * The event's RESALE terms (`Event.resalePayoutTermsId` points at them).
   * Default: none. Carries the resale clause (organiser-resale-share FR-001).
   */
  resaleTerms?: {
    id: string;
    resaleShareType: "PERCENT" | "FLAT" | null;
    resaleShareBps?: number | null;
    resaleShareCents?: number | null;
    resaleSharePayer?: "SELLER" | "BUYER";
  };
  /** RESALE payout lines on those terms. Default: 1. */
  resaleLines?: number;
};

function makeContext(stored: TicketTypeRecord, options: ContextOptions = {}) {
  // Mirrors the Prisma adapter's contract (adapters/src/db/prisma/tickets.ts
  // `updateTicketType`): undefined fields are SKIPPED, so only defined fields
  // overwrite the stored row.
  const updateTicketTypeMock = vi.fn(
    async (input: Record<string, unknown>): Promise<TicketTypeRecord> => {
      const next: Record<string, unknown> = { ...stored };
      for (const [key, value] of Object.entries(input)) {
        if (key !== "id" && value !== undefined) next[key] = value;
      }
      return next as unknown as TicketTypeRecord;
    },
  );

  const ticketsRepo = {
    getTicketTypeById: vi.fn(async (id: string) =>
      id === stored.id ? stored : null,
    ),
    findTicketTypeByName: vi.fn(async () => null),
    updateTicketType: updateTicketTypeMock,
  };
  const eventsRepo = {
    getById: vi.fn(async (id: string) =>
      id === EVENT_ID
        ? { ...baseEvent, resalePayoutTermsId: options.resaleTerms?.id ?? null }
        : null,
    ),
    getPopularityStats: vi.fn(async (eventIds: string[]) =>
      eventIds.map((eventId) => ({
        eventId,
        ticketsSold: options.ticketsSold ?? 0,
        totalCapacity: 0,
        waitlistCount: 0,
      })),
    ),
  };
  const auditRepo = { log: vi.fn(async () => undefined) };

  // The free→paid flip gate walks EVENT → ORG → GLOBAL for a fee policy.
  const resolvedFeePolicy =
    options.feePolicy === undefined
      ? { id: "fee-policy-global", scopeType: "GLOBAL" as const }
      : options.feePolicy;
  const feePoliciesRepo = {
    getById: vi.fn(async () => null),
    resolveEffective: vi.fn(
      async ({ scopeType }: { scopeType: "EVENT" | "ORG" | "GLOBAL" }) =>
        resolvedFeePolicy && resolvedFeePolicy.scopeType === scopeType
          ? resolvedFeePolicy
          : null,
    ),
  };

  // The free→paid flip also gates on Stripe connectivity. `getBySubject`
  // projects `{ id }` only — exactly what the Prisma adapter returns — and
  // the gate then reads the full row for its `stripeAccountId`.
  const payee =
    options.payee === undefined
      ? { id: "payee-1", stripeAccountId: "acct_test" }
      : options.payee;
  const payeesRepo = {
    getBySubject: vi.fn(async () => (payee ? { id: payee.id } : null)),
    getById: vi.fn(async () => payee),
  };

  const listDistinctPriceOverridesByEvent = vi.fn(
    async (_input: { eventId: string }) => options.seatOverrides ?? [],
  );

  /** lockTerms / getById on the RESALE terms, in order. */
  const termsCalls: string[] = [];
  const txRepos = {
    events: eventsRepo,
    tickets: ticketsRepo,
    seats: { listDistinctPriceOverridesByEvent },
    audit: auditRepo,
    feePolicies: feePoliciesRepo,
    payees: payeesRepo,
    payoutTerms: {
      getById: vi.fn(async (id: string) => {
        termsCalls.push(`getById:${id}`);
        return options.resaleTerms?.id === id ? { ...options.resaleTerms } : null;
      }),
      listLines: vi.fn(async (id: string) =>
        options.resaleTerms?.id === id
          ? Array.from({ length: options.resaleLines ?? 1 }, (_, i) => ({ id: `line-${i}` }))
          : [],
      ),
    },
    deals: {
      lockTerms: vi.fn(async (id: string) => {
        termsCalls.push(`lockTerms:${id}`);
        return options.resaleTerms?.id === id;
      }),
    },
  } as unknown as TxRepos;

  const repos = {
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos),
  } as unknown as Repos;

  return {
    // `clock` is REQUIRED on UpdateTicketTypeDeps — it stamps the audit row and
    // is forwarded to the post-edit reindex so the refreshed document carries
    // the effective price at the moment of the edit.
    deps: {
      repos,
      clock: { now: () => NOW },
      logger: createTestLogger(),
      reportError: options.reportError,
    },
    mocks: {
      events: eventsRepo,
      tickets: ticketsRepo,
      audit: auditRepo,
      feePolicies: feePoliciesRepo,
      payees: payeesRepo,
      listDistinctPriceOverridesByEvent,
      termsCalls,
    },
  };
}

const RESALE_TERMS_ID = "55555555-5555-4555-8555-555555555555";
const TEN_PERCENT_TERMS = {
  id: RESALE_TERMS_ID,
  resaleShareType: "PERCENT" as const,
  resaleShareBps: 1000,
  resaleShareCents: null,
  resaleSharePayer: "SELLER" as const,
};

/**
 * organiser-resale-share FR-001: resale cannot be switched on for a ticket
 * type while the event's resale clause is not set.
 */
describe("updateTicketType — resale needs the event's clause", () => {
  const switchOn = {
    actorHumanId: ACTOR_ID,
    ticketTypeId: TICKET_TYPE_ID,
    resaleAllowed: true,
  };

  it("no RESALE terms on the event → RESALE_TERMS_MISSING, nothing written", async () => {
    const { deps, mocks } = makeContext(makeStoredTicketType({ resaleAllowed: false }));
    await expect(updateTicketType(deps, switchOn)).rejects.toMatchObject({
      code: "RESALE_TERMS_MISSING",
      meta: { reason: "resale_terms_missing" },
    });
    expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
  });

  it("RESALE terms with the clause not set → RESALE_TERMS_MISSING, nothing written", async () => {
    const { deps, mocks } = makeContext(makeStoredTicketType({ resaleAllowed: false }), {
      resaleTerms: { id: RESALE_TERMS_ID, resaleShareType: null },
    });
    await expect(updateTicketType(deps, switchOn)).rejects.toMatchObject({
      code: "RESALE_TERMS_MISSING",
      meta: { reason: "resale_clause_not_set", payoutTermsId: RESALE_TERMS_ID },
    });
    expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
  });

  it("a set clause (a FLAT $3, buyer-paid) lets resale switch on", async () => {
    const { deps, mocks } = makeContext(makeStoredTicketType({ resaleAllowed: false }), {
      resaleTerms: {
        id: RESALE_TERMS_ID,
        resaleShareType: "FLAT",
        resaleShareCents: 300,
        resaleSharePayer: "BUYER",
      },
    });
    await updateTicketType(deps, switchOn);
    expect(mocks.tickets.updateTicketType).toHaveBeenCalledWith(
      expect.objectContaining({ resaleAllowed: true }),
    );
  });

  it("a set clause on terms with no RESALE line → AGREEMENT_MISSING_LINES, nothing written", async () => {
    const { deps, mocks } = makeContext(makeStoredTicketType({ resaleAllowed: false }), {
      resaleTerms: TEN_PERCENT_TERMS,
      resaleLines: 0,
    });
    await expect(updateTicketType(deps, switchOn)).rejects.toMatchObject({
      code: "AGREEMENT_MISSING_LINES",
      meta: { reason: "resale_lines_missing", payoutTermsId: RESALE_TERMS_ID },
    });
    expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
  });

  it("reads the clause under the terms lock, so a concurrent clear cannot slip past (review B2)", async () => {
    const { deps, mocks } = makeContext(makeStoredTicketType({ resaleAllowed: false }), {
      resaleTerms: TEN_PERCENT_TERMS,
    });
    await updateTicketType(deps, switchOn);
    expect(mocks.termsCalls).toEqual([
      `lockTerms:${RESALE_TERMS_ID}`,
      `getById:${RESALE_TERMS_ID}`,
    ]);
  });

  it("only the switch is gated: a type already allowing resale keeps its other edits, and switching off is free", async () => {
    const already = makeContext(makeStoredTicketType({ resaleAllowed: true }));
    await updateTicketType(already.deps, { ...switchOn, name: "VIP Plus" });
    expect(already.mocks.tickets.updateTicketType).toHaveBeenCalled();

    const off = makeContext(makeStoredTicketType({ resaleAllowed: true }));
    await updateTicketType(off.deps, { ...switchOn, resaleAllowed: false });
    expect(off.mocks.tickets.updateTicketType).toHaveBeenCalledWith(
      expect.objectContaining({ resaleAllowed: false }),
    );
  });

  it("an ADJUSTABLE type is clamped to no resale, so it never needs the clause", async () => {
    const { deps, mocks } = makeContext(
      makeStoredTicketType({ resaleAllowed: false, pricingMode: "ADJUSTABLE", priceCents: 0, minimumCents: 0 }),
    );
    await updateTicketType(deps, switchOn);
    expect(mocks.tickets.updateTicketType).toHaveBeenCalledWith(
      expect.objectContaining({ resaleAllowed: false }),
    );
  });
});

describe("updateTicketType — resale field preservation", () => {
  it.each([
    { storedResaleAllowed: true, storedCap: 8000 },
    { storedResaleAllowed: false, storedCap: null },
  ])(
    "preserves stored resaleAllowed=$storedResaleAllowed when the resale fields are omitted (transport gate-off clamp contract)",
    async ({ storedResaleAllowed, storedCap }) => {
      const stored = makeStoredTicketType({
        resaleAllowed: storedResaleAllowed,
        resaleCapCents: storedCap,
      });
      const { deps, mocks } = makeContext(stored);

      const result = await updateTicketType(deps, {
        actorHumanId: ACTOR_ID,
        ticketTypeId: TICKET_TYPE_ID,
        capacity: 100,
      });

      expect(result.capacity).toBe(100);
      expect(mocks.tickets.updateTicketType).toHaveBeenCalledTimes(1);
      const repoInput = mocks.tickets.updateTicketType.mock.calls[0]![0] as {
        resaleAllowed?: boolean;
        resaleCapCents?: number | null;
      };
      // Absent/undefined = "no change" per the adapter's undefined-skip
      // contract — the stored values survive the unrelated edit.
      expect(repoInput.resaleAllowed).toBeUndefined();
      expect(repoInput.resaleCapCents).toBeUndefined();

      const persisted = (await mocks.tickets.updateTicketType.mock.results[0]!
        .value) as TicketTypeRecord;
      expect(persisted.resaleAllowed).toBe(storedResaleAllowed);
      expect(persisted.resaleCapCents).toBe(storedCap);
    },
  );

  it("applies resale fields when they are provided (gate on: transport passes them through)", async () => {
    const stored = makeStoredTicketType({
      resaleAllowed: false,
      resaleCapCents: null,
    });
    const { deps, mocks } = makeContext(stored, { resaleTerms: TEN_PERCENT_TERMS });

    await updateTicketType(deps, {
      actorHumanId: ACTOR_ID,
      ticketTypeId: TICKET_TYPE_ID,
      resaleAllowed: true,
      resaleCapCents: 12000,
    });

    expect(mocks.tickets.updateTicketType).toHaveBeenCalledWith(
      expect.objectContaining({
        id: TICKET_TYPE_ID,
        resaleAllowed: true,
        resaleCapCents: 12000,
      }),
    );

    const persisted = (await mocks.tickets.updateTicketType.mock.results[0]!
      .value) as TicketTypeRecord;
    expect(persisted.resaleAllowed).toBe(true);
    expect(persisted.resaleCapCents).toBe(12000);
  });
});

/**
 * FR-005 on the PARTIAL-UPDATE path. updateTicketType is the boundary where
 * the both-or-neither invariant is easiest to break, because either field can
 * be omitted: the merge against the stored row has to happen BEFORE validation
 * or "clear the date, keep the price" silently persists a half-configuration.
 */
describe("updateTicketType — scheduled price change (FR-005)", () => {
  const FLIP_AT = new Date("2025-01-20T18:00:00.000Z");
  const OTHER_AT = new Date("2025-01-25T18:00:00.000Z");

  it("sets a complete schedule", async () => {
    const { deps, mocks } = makeContext(makeStoredTicketType());

    await updateTicketType(deps, {
      actorHumanId: ACTOR_ID,
      ticketTypeId: TICKET_TYPE_ID,
      scheduledPriceCents: 2000,
      scheduledPriceAt: FLIP_AT,
    });

    expect(mocks.tickets.updateTicketType).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduledPriceCents: 2000,
        scheduledPriceAt: FLIP_AT,
      }),
    );
  });

  it("preserves a stored schedule across an unrelated edit", async () => {
    const stored = makeStoredTicketType({
      scheduledPriceCents: 2000,
      scheduledPriceAt: FLIP_AT,
    });
    const { deps, mocks } = makeContext(stored);

    await updateTicketType(deps, {
      actorHumanId: ACTOR_ID,
      ticketTypeId: TICKET_TYPE_ID,
      capacity: 100,
    });

    // Written back as the same pair, not dropped.
    expect(mocks.tickets.updateTicketType).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduledPriceCents: 2000,
        scheduledPriceAt: FLIP_AT,
      }),
    );
  });

  it("changes only the instant of a stored schedule", async () => {
    const stored = makeStoredTicketType({
      scheduledPriceCents: 2000,
      scheduledPriceAt: FLIP_AT,
    });
    const { deps, mocks } = makeContext(stored);

    await updateTicketType(deps, {
      actorHumanId: ACTOR_ID,
      ticketTypeId: TICKET_TYPE_ID,
      scheduledPriceAt: OTHER_AT,
    });

    expect(mocks.tickets.updateTicketType).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduledPriceCents: 2000,
        scheduledPriceAt: OTHER_AT,
      }),
    );
  });

  it("clears both fields together", async () => {
    const stored = makeStoredTicketType({
      scheduledPriceCents: 2000,
      scheduledPriceAt: FLIP_AT,
    });
    const { deps, mocks } = makeContext(stored);

    await updateTicketType(deps, {
      actorHumanId: ACTOR_ID,
      ticketTypeId: TICKET_TYPE_ID,
      scheduledPriceCents: null,
      scheduledPriceAt: null,
    });

    expect(mocks.tickets.updateTicketType).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduledPriceCents: null,
        scheduledPriceAt: null,
      }),
    );
  });

  it("REJECTS clearing only the instant on a scheduled row", async () => {
    const stored = makeStoredTicketType({
      scheduledPriceCents: 2000,
      scheduledPriceAt: FLIP_AT,
    });
    const { deps, mocks } = makeContext(stored);

    await expect(
      updateTicketType(deps, {
        actorHumanId: ACTOR_ID,
        ticketTypeId: TICKET_TYPE_ID,
        scheduledPriceAt: null,
      }),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_SCHEDULE_INCOMPLETE" });

    expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
  });

  it("REJECTS clearing only the price on a scheduled row", async () => {
    const stored = makeStoredTicketType({
      scheduledPriceCents: 2000,
      scheduledPriceAt: FLIP_AT,
    });
    const { deps, mocks } = makeContext(stored);

    await expect(
      updateTicketType(deps, {
        actorHumanId: ACTOR_ID,
        ticketTypeId: TICKET_TYPE_ID,
        scheduledPriceCents: null,
      }),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_SCHEDULE_INCOMPLETE" });

    expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
  });

  it("REJECTS setting only the price on an unscheduled row", async () => {
    const { deps, mocks } = makeContext(makeStoredTicketType());

    await expect(
      updateTicketType(deps, {
        actorHumanId: ACTOR_ID,
        ticketTypeId: TICKET_TYPE_ID,
        scheduledPriceCents: 2000,
      }),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_SCHEDULE_INCOMPLETE" });

    expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
  });

  it("keeps a scheduled price of 0 distinct from null", async () => {
    const stored = makeStoredTicketType({
      scheduledPriceCents: 0,
      scheduledPriceAt: FLIP_AT,
    });
    const { deps, mocks } = makeContext(stored);

    await updateTicketType(deps, {
      actorHumanId: ACTOR_ID,
      ticketTypeId: TICKET_TYPE_ID,
      capacity: 100,
    });

    // 0 must survive the merge. A `?? null` on a falsy-check would have
    // silently unscheduled this tier.
    expect(mocks.tickets.updateTicketType).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduledPriceCents: 0,
        scheduledPriceAt: FLIP_AT,
      }),
    );
  });

  it("clears the schedule when switching to ADJUSTABLE pricing", async () => {
    const stored = makeStoredTicketType({
      scheduledPriceCents: 2000,
      scheduledPriceAt: FLIP_AT,
    });
    const { deps, mocks } = makeContext(stored);

    await updateTicketType(deps, {
      actorHumanId: ACTOR_ID,
      ticketTypeId: TICKET_TYPE_ID,
      pricingMode: "ADJUSTABLE",
    });

    expect(mocks.tickets.updateTicketType).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduledPriceCents: null,
        scheduledPriceAt: null,
      }),
    );
  });
});

/**
 * FR-014 on the PARTIAL-UPDATE path — the boundary where the ORDERING
 * invariant is easiest to break, because either bound can be omitted. Moving
 * only `salesOpenAt` has to be checked against the STORED `salesCloseAt`, or
 * "open at 20:00" on a tier that closes at 18:00 persists a window nobody can
 * ever buy from.
 */
describe("updateTicketType — sales window (FR-014)", () => {
  const OPENS_AT = new Date("2025-01-10T18:00:00.000Z");
  const CLOSES_AT = new Date("2025-01-20T18:00:00.000Z");
  const AFTER_CLOSE = new Date("2025-01-25T18:00:00.000Z");

  it("sets a complete window", async () => {
    const { deps, mocks } = makeContext(makeStoredTicketType());

    await updateTicketType(deps, {
      actorHumanId: ACTOR_ID,
      ticketTypeId: TICKET_TYPE_ID,
      salesOpenAt: OPENS_AT,
      salesCloseAt: CLOSES_AT,
    });

    expect(mocks.tickets.updateTicketType).toHaveBeenCalledWith(
      expect.objectContaining({
        salesOpenAt: OPENS_AT,
        salesCloseAt: CLOSES_AT,
      }),
    );
  });

  it("preserves a stored window across an unrelated edit", async () => {
    const stored = makeStoredTicketType({
      salesOpenAt: OPENS_AT,
      salesCloseAt: CLOSES_AT,
    });
    const { deps, mocks } = makeContext(stored);

    await updateTicketType(deps, {
      actorHumanId: ACTOR_ID,
      ticketTypeId: TICKET_TYPE_ID,
      name: "VIP Plus",
    });

    expect(mocks.tickets.updateTicketType).toHaveBeenCalledWith(
      expect.objectContaining({
        salesOpenAt: OPENS_AT,
        salesCloseAt: CLOSES_AT,
      }),
    );
  });

  it("MERGE-BEFORE-VALIDATE: moving only the open bound past the stored close is rejected", async () => {
    const stored = makeStoredTicketType({
      salesOpenAt: OPENS_AT,
      salesCloseAt: CLOSES_AT,
    });
    const { deps, mocks } = makeContext(stored);

    await expect(
      updateTicketType(deps, {
        actorHumanId: ACTOR_ID,
        ticketTypeId: TICKET_TYPE_ID,
        salesOpenAt: AFTER_CLOSE,
      }),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_SALES_WINDOW_INVALID" });

    expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
  });

  it("MERGE-BEFORE-VALIDATE: moving only the close bound before the stored open is rejected", async () => {
    const stored = makeStoredTicketType({
      salesOpenAt: CLOSES_AT,
      salesCloseAt: AFTER_CLOSE,
    });
    const { deps, mocks } = makeContext(stored);

    await expect(
      updateTicketType(deps, {
        actorHumanId: ACTOR_ID,
        ticketTypeId: TICKET_TYPE_ID,
        salesCloseAt: OPENS_AT,
      }),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_SALES_WINDOW_INVALID" });

    expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
  });

  it("clearing ONE bound is legal — the bounds are independent", async () => {
    const stored = makeStoredTicketType({
      salesOpenAt: OPENS_AT,
      salesCloseAt: CLOSES_AT,
    });
    const { deps, mocks } = makeContext(stored);

    await updateTicketType(deps, {
      actorHumanId: ACTOR_ID,
      ticketTypeId: TICKET_TYPE_ID,
      salesOpenAt: null,
    });

    expect(mocks.tickets.updateTicketType).toHaveBeenCalledWith(
      expect.objectContaining({ salesOpenAt: null, salesCloseAt: CLOSES_AT }),
    );
  });

  it("an ADJUSTABLE tier KEEPS its window (unlike the schedule, which is cleared)", async () => {
    const stored = makeStoredTicketType({
      salesOpenAt: OPENS_AT,
      salesCloseAt: CLOSES_AT,
      scheduledPriceCents: 2000,
      scheduledPriceAt: OPENS_AT,
    });
    const { deps, mocks } = makeContext(stored);

    await updateTicketType(deps, {
      actorHumanId: ACTOR_ID,
      ticketTypeId: TICKET_TYPE_ID,
      pricingMode: "ADJUSTABLE",
    });

    expect(mocks.tickets.updateTicketType).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduledPriceCents: null,
        scheduledPriceAt: null,
        salesOpenAt: OPENS_AT,
        salesCloseAt: CLOSES_AT,
      }),
    );
  });

  it("NFR-001: an edit that mentions no window leaves an UNWINDOWED row unwindowed", async () => {
    const { deps, mocks } = makeContext(makeStoredTicketType());

    await updateTicketType(deps, {
      actorHumanId: ACTOR_ID,
      ticketTypeId: TICKET_TYPE_ID,
      priceCents: 6000,
    });

    expect(mocks.tickets.updateTicketType).toHaveBeenCalledWith(
      expect.objectContaining({ salesOpenAt: null, salesCloseAt: null }),
    );
  });
});

// ── Free → paid flip gate ────────────────────────────────────────────────
//
// This use case is the OTHER way a tier becomes money-taking. Since
// `publishEvent` now lets a FREE event publish with no fee policy pinned, a
// flip performed here would otherwise be discovered by the BUYER at checkout.

describe("updateTicketType — fee-policy gate on the free→paid flip", () => {
  const FREE = () => makeStoredTicketType({ priceCents: 0 });

  it("refuses a $0 → $20 edit when no fee policy resolves at any scope", async () => {
    const { deps, mocks } = makeContext(FREE(), { feePolicy: null });

    await expect(
      updateTicketType(deps, {
        actorHumanId: ACTOR_ID,
        ticketTypeId: TICKET_TYPE_ID,
        priceCents: 2000,
      }),
    ).rejects.toMatchObject({ code: "PAID_TICKETING_REQUIRES_FEE_POLICY" });

    expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
  });

  it("refuses SCHEDULING a flip to a paid price on a free tier", async () => {
    const { deps, mocks } = makeContext(FREE(), { feePolicy: null });

    await expect(
      updateTicketType(deps, {
        actorHumanId: ACTOR_ID,
        ticketTypeId: TICKET_TYPE_ID,
        scheduledPriceCents: 2000,
        scheduledPriceAt: new Date("2026-12-01T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "PAID_TICKETING_REQUIRES_FEE_POLICY" });

    expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
  });

  it("refuses flipping a free tier to ADJUSTABLE (pay-what-you-want)", async () => {
    const { deps } = makeContext(FREE(), { feePolicy: null });

    await expect(
      updateTicketType(deps, {
        actorHumanId: ACTOR_ID,
        ticketTypeId: TICKET_TYPE_ID,
        pricingMode: "ADJUSTABLE",
      }),
    ).rejects.toMatchObject({ code: "PAID_TICKETING_REQUIRES_FEE_POLICY" });
  });

  it("ALLOWS the flip when a GLOBAL policy resolves", async () => {
    const { deps, mocks } = makeContext(FREE());

    await updateTicketType(deps, {
      actorHumanId: ACTOR_ID,
      ticketTypeId: TICKET_TYPE_ID,
      priceCents: 2000,
    });

    expect(mocks.tickets.updateTicketType).toHaveBeenCalled();
    // EVENT → ORG is skipped (human-owned event) → GLOBAL.
    expect(mocks.feePolicies.resolveEffective).toHaveBeenCalled();
  });

  it("does NOT gate an edit that keeps the tier free", async () => {
    const { deps, mocks } = makeContext(FREE(), { feePolicy: null });

    await updateTicketType(deps, {
      actorHumanId: ACTOR_ID,
      ticketTypeId: TICKET_TYPE_ID,
      capacity: 120,
    });

    expect(mocks.tickets.updateTicketType).toHaveBeenCalled();
    expect(mocks.feePolicies.resolveEffective).not.toHaveBeenCalled();
  });

  it("does NOT re-gate an edit to an ALREADY-paid tier", async () => {
    // Fires on the TRANSITION only. An event that is already selling has a
    // policy by construction; re-gating would let an unrelated platform blip
    // block a routine capacity change.
    const { deps, mocks } = makeContext(
      makeStoredTicketType({
        priceCents: 5000,
      }),
      { feePolicy: null },
    );

    await updateTicketType(deps, {
      actorHumanId: ACTOR_ID,
      ticketTypeId: TICKET_TYPE_ID,
      priceCents: 7500,
    });

    expect(mocks.tickets.updateTicketType).toHaveBeenCalled();
    expect(mocks.feePolicies.resolveEffective).not.toHaveBeenCalled();
  });

  it("rethrows a per-scope repo failure during the flip walk instead of flipping the tier", async () => {
    // The walk used to swallow a failing scope read and continue — unreachable
    // inside `repos.tx`, where the first failed statement aborts the session.
    // The fault now propagates rather than becoming a misleading
    // PAID_TICKETING_REQUIRES_FEE_POLICY, and is reported at the failing scope.
    const boom = new Error("connection terminated unexpectedly");
    const reportError = vi.fn();
    const { deps, mocks } = makeContext(FREE(), { reportError });
    mocks.feePolicies.resolveEffective.mockRejectedValueOnce(boom);

    await expect(
      updateTicketType(deps, {
        actorHumanId: ACTOR_ID,
        ticketTypeId: TICKET_TYPE_ID,
        priceCents: 2000,
      }),
    ).rejects.toBe(boom);

    expect(mocks.feePolicies.resolveEffective).toHaveBeenCalledTimes(1);
    expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: expect.objectContaining({
          resolver: "resolveScopedFeePolicy",
          scopeType: "EVENT",
          source: "updateTicketType",
        }),
      }),
    );
  });
});

// ── Stripe gate on the free→paid flip ────────────────────────────────────
//
// The other precondition a sale needs, and the other half of the hole:
// `publishEvent` only runs its Stripe check when the event ALREADY has a paid
// tier, so a FREE event publishes with no connected payee and a price edit here
// used to turn it into a tier every buyer fails to check out. Same transition
// shape as the fee-policy gate above, same shared module as `upsertTicketType`
// (`_shared/ensure-stripe-connected-for-paid-ticketing`).

describe("updateTicketType — Stripe gate on the free→paid flip", () => {
  const FREE = () => makeStoredTicketType({ priceCents: 0 });
  const FLIP_AT = new Date("2026-12-01T00:00:00.000Z");

  it("refuses a $0 → $20 edit when the owner has no connected payee", async () => {
    const { deps, mocks } = makeContext(FREE(), { payee: null });

    await expect(
      updateTicketType(deps, {
        actorHumanId: ACTOR_ID,
        ticketTypeId: TICKET_TYPE_ID,
        priceCents: 2000,
      }),
    ).rejects.toMatchObject({ code: "PAID_TICKETING_REQUIRES_STRIPE" });

    expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
    // Human-owned event → the HUMAN subject, not an org.
    expect(mocks.payees.getBySubject).toHaveBeenCalledWith({
      type: "HUMAN",
      id: ACTOR_ID,
    });
  });

  it("refuses SCHEDULING a flip to a paid price when there is no connected payee", async () => {
    // $0 now, $20 at T. Nothing about the tier is paid TODAY, which is exactly
    // the shape a `priceCents > 0` gate waves through.
    const { deps, mocks } = makeContext(FREE(), { payee: null });

    await expect(
      updateTicketType(deps, {
        actorHumanId: ACTOR_ID,
        ticketTypeId: TICKET_TYPE_ID,
        scheduledPriceCents: 2000,
        scheduledPriceAt: FLIP_AT,
      }),
    ).rejects.toMatchObject({ code: "PAID_TICKETING_REQUIRES_STRIPE" });

    expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
  });

  it("ALLOWS the flip when the owner IS connected", async () => {
    const { deps, mocks } = makeContext(FREE(), {
      payee: { id: "payee-1", stripeAccountId: "acct_connected" },
    });

    await updateTicketType(deps, {
      actorHumanId: ACTOR_ID,
      ticketTypeId: TICKET_TYPE_ID,
      priceCents: 2000,
    });

    expect(mocks.payees.getBySubject).toHaveBeenCalledTimes(1);
    expect(mocks.tickets.updateTicketType).toHaveBeenCalledWith(
      expect.objectContaining({ priceCents: 2000 }),
    );
  });

  it("does NOT invoke the gate on an edit that keeps the tier free", async () => {
    const { deps, mocks } = makeContext(FREE(), { payee: null });

    await updateTicketType(deps, {
      actorHumanId: ACTOR_ID,
      ticketTypeId: TICKET_TYPE_ID,
      capacity: 120,
    });

    expect(mocks.tickets.updateTicketType).toHaveBeenCalled();
    expect(mocks.payees.getBySubject).not.toHaveBeenCalled();
  });

  it("does NOT re-gate an ALREADY-paid tier edited to a different paid price", async () => {
    // Fires on the TRANSITION only. Re-gating would wall an organizer changing
    // a price on an event that is already selling.
    const { deps, mocks } = makeContext(
      makeStoredTicketType({ priceCents: 5000 }),
      { payee: null },
    );

    await updateTicketType(deps, {
      actorHumanId: ACTOR_ID,
      ticketTypeId: TICKET_TYPE_ID,
      priceCents: 7500,
    });

    expect(mocks.tickets.updateTicketType).toHaveBeenCalled();
    expect(mocks.payees.getBySubject).not.toHaveBeenCalled();
  });

  it("EXISTENCE, not capability: a payee mid-Connect-onboarding still permits the flip", async () => {
    // `PayeesRepo.getBySubject` projects `{ id }` only, and that is the gate's
    // contract on purpose: the Payee row is created when the organizer STARTS
    // onboarding, before Stripe enables charges. Demanding
    // ACTIVE + chargesEnabled + payoutsEnabled here would block AUTHORING paid
    // tiers for as long as Stripe spends verifying the account. That check
    // lives at PUBLISH (`ensureStripeConnectedForPaidEvent`), the last gate
    // before the event is buyable.
    const pendingPayee = {
      id: "payee-pending",
      // Onboarding started: the Connect account is linked, not yet enabled.
      stripeAccountId: "acct_pending",
      status: "PENDING",
      chargesEnabled: false,
      payoutsEnabled: false,
    };
    const { deps, mocks } = makeContext(FREE(), {
      payee: pendingPayee as unknown as { id: string },
    });

    await updateTicketType(deps, {
      actorHumanId: ACTOR_ID,
      ticketTypeId: TICKET_TYPE_ID,
      priceCents: 2000,
    });

    expect(mocks.payees.getBySubject).toHaveBeenCalledTimes(1);
    expect(mocks.tickets.updateTicketType).toHaveBeenCalled();
  });

  it("a PLACEHOLDER payee (no Connect account) is refused: a door cash sale's payee is not onboarding", async () => {
    // Placeholders are created with no Stripe account by a door cash sale
    // (spec 2026-10-07, R6), event splits, resale seller splits and booking
    // lines. A paid tier on such an owner would fail every online checkout
    // with STRIPE_NOT_CONNECTED, which the BUYER sees, not the organizer.
    const { deps, mocks } = makeContext(FREE(), {
      payee: { id: "payee-placeholder", stripeAccountId: null },
    });

    await expect(
      updateTicketType(deps, {
        actorHumanId: ACTOR_ID,
        ticketTypeId: TICKET_TYPE_ID,
        priceCents: 2000,
      }),
    ).rejects.toMatchObject({ code: "PAID_TICKETING_REQUIRES_STRIPE" });
    expect(mocks.payees.getById).toHaveBeenCalledWith("payee-placeholder");
    expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
  });

  it("ASYMMETRY: a pure ADJUSTABLE flip is refused by the FEE-POLICY gate but never reaches the Stripe gate", async () => {
    // The two predicates differ on purpose. `ticketTypeNeedsFeePolicy` counts
    // pay-what-you-want as paid (matching `publishEvent`);
    // `ticketTypeRequiresStripe` keeps the narrower historical rule and
    // excludes it when there is no minimum. Both preconditions are absent here
    // and the FEE-POLICY code is the one that surfaces.
    const { deps, mocks } = makeContext(FREE(), {
      payee: null,
      feePolicy: null,
    });

    await expect(
      updateTicketType(deps, {
        actorHumanId: ACTOR_ID,
        ticketTypeId: TICKET_TYPE_ID,
        pricingMode: "ADJUSTABLE",
      }),
    ).rejects.toMatchObject({ code: "PAID_TICKETING_REQUIRES_FEE_POLICY" });

    expect(mocks.payees.getBySubject).not.toHaveBeenCalled();
  });

  it("ASYMMETRY: an ADJUSTABLE flip WITH a minimum does require Stripe", async () => {
    const { deps, mocks } = makeContext(FREE(), { payee: null });

    await expect(
      updateTicketType(deps, {
        actorHumanId: ACTOR_ID,
        ticketTypeId: TICKET_TYPE_ID,
        pricingMode: "ADJUSTABLE",
        minimumCents: 500,
      }),
    ).rejects.toMatchObject({ code: "PAID_TICKETING_REQUIRES_STRIPE" });

    expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
  });

  it("reports the STRIPE code first when BOTH preconditions are missing (same ordering as upsertTicketType)", async () => {
    const { deps } = makeContext(FREE(), { payee: null, feePolicy: null });

    await expect(
      updateTicketType(deps, {
        actorHumanId: ACTOR_ID,
        ticketTypeId: TICKET_TYPE_ID,
        priceCents: 2000,
      }),
    ).rejects.toMatchObject({ code: "PAID_TICKETING_REQUIRES_STRIPE" });
  });
});

// ── Sales lock ───────────────────────────────────────────────────────────────
// The admin editor locks an event's ticket types once `ticketsSold` (the
// event-level `events.getPopularityStats` count) is above zero. These pin the
// server half: a change to a locked column is refused with
// TICKET_TYPE_LOCKED_BY_SALES; capacity stays editable exactly as before.
describe("updateTicketType — sales lock", () => {
  const SCHEDULE_AT = new Date("2025-01-20T18:00:00.000Z");
  const OPEN_AT = new Date("2025-01-12T18:00:00.000Z");
  const CLOSE_AT = new Date("2025-02-01T18:00:00.000Z");

  // A FIXED row carrying every locked column so each one can be moved.
  const LOCKABLE = () =>
    makeStoredTicketType({
      resaleAllowed: true,
      resaleCapCents: 8000,
      scheduledPriceCents: 6000,
      scheduledPriceAt: SCHEDULE_AT,
      salesOpenAt: OPEN_AT,
      salesCloseAt: CLOSE_AT,
    });

  it("refuses a price change once the event has sold a ticket", async () => {
    const { deps, mocks } = makeContext(LOCKABLE(), { ticketsSold: 3 });

    await expect(
      updateTicketType(deps, {
        actorHumanId: ACTOR_ID,
        ticketTypeId: TICKET_TYPE_ID,
        priceCents: 4500,
      }),
    ).rejects.toMatchObject({
      code: "TICKET_TYPE_LOCKED_BY_SALES",
      meta: { fields: ["priceCents"] },
    });

    expect(mocks.events.getPopularityStats).toHaveBeenCalledWith([EVENT_ID]);
    expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });

  it("refuses a rename once the event has sold a ticket", async () => {
    const { deps, mocks } = makeContext(LOCKABLE(), { ticketsSold: 1 });

    await expect(
      updateTicketType(deps, {
        actorHumanId: ACTOR_ID,
        ticketTypeId: TICKET_TYPE_ID,
        name: "VIP Deluxe",
      }),
    ).rejects.toMatchObject({
      code: "TICKET_TYPE_LOCKED_BY_SALES",
      meta: { fields: ["name"] },
    });

    // The lock answers before the name-conflict lookup does.
    expect(mocks.tickets.findTicketTypeByName).not.toHaveBeenCalled();
    expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
  });

  it.each([
    { label: "pricingMode", patch: { pricingMode: "ADJUSTABLE" as const } },
    { label: "resaleAllowed", patch: { resaleAllowed: false } },
    { label: "resaleCapCents", patch: { resaleCapCents: 9000 } },
    { label: "resaleCapCents cleared", patch: { resaleCapCents: null } },
    { label: "scheduledPriceCents", patch: { scheduledPriceCents: 6500 } },
    {
      label: "schedule cleared",
      patch: { scheduledPriceCents: null, scheduledPriceAt: null },
    },
    {
      label: "salesOpenAt",
      patch: { salesOpenAt: new Date("2025-01-13T18:00:00.000Z") },
    },
    { label: "salesCloseAt cleared", patch: { salesCloseAt: null } },
  ])("refuses a $label change once sold", async ({ patch }) => {
    const { deps, mocks } = makeContext(LOCKABLE(), { ticketsSold: 2 });

    await expect(
      updateTicketType(deps, {
        actorHumanId: ACTOR_ID,
        ticketTypeId: TICKET_TYPE_ID,
        ...patch,
      }),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_LOCKED_BY_SALES" });

    expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
  });

  it("still accepts a capacity-only edit after sales, without reading the sales count", async () => {
    const { deps, mocks } = makeContext(LOCKABLE(), { ticketsSold: 40 });

    const result = await updateTicketType(deps, {
      actorHumanId: ACTOR_ID,
      ticketTypeId: TICKET_TYPE_ID,
      capacity: 120,
    });

    expect(result.capacity).toBe(120);
    expect(mocks.tickets.updateTicketType).toHaveBeenCalledWith(
      expect.objectContaining({ id: TICKET_TYPE_ID, capacity: 120 }),
    );
    expect(mocks.events.getPopularityStats).not.toHaveBeenCalled();
  });

  it("accepts an identical resend of every locked field plus a capacity change (the editor's save shape)", async () => {
    const { deps, mocks } = makeContext(LOCKABLE(), { ticketsSold: 5 });

    const result = await updateTicketType(deps, {
      actorHumanId: ACTOR_ID,
      ticketTypeId: TICKET_TYPE_ID,
      name: "VIP",
      priceCents: 5000,
      pricingMode: "FIXED",
      minimumCents: null,
      suggestedCents: null,
      capacity: 75,
      resaleAllowed: true,
      resaleCapCents: 8000,
      // Equal instants in fresh Date objects: compared by value, not identity.
      scheduledPriceCents: 6000,
      scheduledPriceAt: new Date(SCHEDULE_AT.getTime()),
      salesOpenAt: new Date(OPEN_AT.getTime()),
      salesCloseAt: new Date(CLOSE_AT.getTime()),
    });

    expect(result.capacity).toBe(75);
    expect(mocks.tickets.updateTicketType).toHaveBeenCalledTimes(1);
    expect(mocks.events.getPopularityStats).not.toHaveBeenCalled();
  });

  it("judges an ADJUSTABLE row by what is written: a stray priceCents is clamped to 0, so it is not a change", async () => {
    const stored = makeStoredTicketType({
      pricingMode: "ADJUSTABLE",
      priceCents: 0,
      minimumCents: 500,
      suggestedCents: 1500,
    });
    const { deps, mocks } = makeContext(stored, { ticketsSold: 5 });

    await updateTicketType(deps, {
      actorHumanId: ACTOR_ID,
      ticketTypeId: TICKET_TYPE_ID,
      priceCents: 2500,
      capacity: 60,
    });

    expect(mocks.tickets.updateTicketType).toHaveBeenCalledWith(
      expect.objectContaining({ priceCents: 0, capacity: 60 }),
    );
  });

  it("refuses resending pricingMode on an ADJUSTABLE row when the omitted minimum would be reset", async () => {
    const stored = makeStoredTicketType({
      pricingMode: "ADJUSTABLE",
      priceCents: 0,
      minimumCents: 500,
      suggestedCents: null,
    });
    const { deps, mocks } = makeContext(stored, { ticketsSold: 5 });

    await expect(
      updateTicketType(deps, {
        actorHumanId: ACTOR_ID,
        ticketTypeId: TICKET_TYPE_ID,
        pricingMode: "ADJUSTABLE",
      }),
    ).rejects.toMatchObject({
      code: "TICKET_TYPE_LOCKED_BY_SALES",
      meta: { fields: ["minimumCents"] },
    });

    expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
  });

  // ── Values the editor cannot round-trip are not "changes" ──────────────
  // The editor hydrates a 0 amount as an empty field and saves it as null,
  // sends null for FIXED min/suggested and for the resale cap while resale is
  // off. Its save shape (TicketTypeEditor `updateMutation.mutateAsync`) must
  // pass on an untouched row after a sale; only the comparison normalises.
  const ADJUSTABLE_ROW = (overrides: Partial<TicketTypeRecord> = {}) =>
    makeStoredTicketType({
      pricingMode: "ADJUSTABLE",
      priceCents: 0,
      minimumCents: 500,
      suggestedCents: 1500,
      ...overrides,
    });

  // What the editor sends for an ADJUSTABLE row it hydrated without edits.
  const editorAdjustableSave = (min: number | null, sug: number | null) => ({
    actorHumanId: ACTOR_ID,
    ticketTypeId: TICKET_TYPE_ID,
    name: "VIP",
    priceCents: 0,
    pricingMode: "ADJUSTABLE" as const,
    minimumCents: min,
    suggestedCents: sug,
    capacity: 90,
    resaleAllowed: false,
    resaleCapCents: null,
  });

  it("accepts the editor's untouched ADJUSTABLE save shape after a sale", async () => {
    const { deps, mocks } = makeContext(ADJUSTABLE_ROW(), { ticketsSold: 5 });

    await updateTicketType(deps, editorAdjustableSave(500, 1500));

    expect(mocks.tickets.updateTicketType).toHaveBeenCalledWith(
      expect.objectContaining({ capacity: 90, minimumCents: 500 }),
    );
    expect(mocks.events.getPopularityStats).not.toHaveBeenCalled();
  });

  it("(a) ADJUSTABLE: a stored suggestedCents 0 resent as null is not a change", async () => {
    const { deps, mocks } = makeContext(ADJUSTABLE_ROW({ suggestedCents: 0 }), {
      ticketsSold: 5,
    });

    await updateTicketType(deps, editorAdjustableSave(500, null));

    // What is WRITTEN is unchanged by the normalisation: null goes to the row.
    expect(mocks.tickets.updateTicketType).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedCents: null, capacity: 90 }),
    );
  });

  it("ADJUSTABLE: a stored minimumCents null resent as null (written as 0) is not a change", async () => {
    const { deps, mocks } = makeContext(ADJUSTABLE_ROW({ minimumCents: null }), {
      ticketsSold: 5,
    });

    await updateTicketType(deps, editorAdjustableSave(null, 1500));

    expect(mocks.tickets.updateTicketType).toHaveBeenCalledWith(
      expect.objectContaining({ minimumCents: 0 }),
    );
  });

  it("(b) a stored resaleCapCents with resale OFF, resent as null, is not a change", async () => {
    const stored = makeStoredTicketType({
      resaleAllowed: false,
      resaleCapCents: 8000,
    });
    const { deps, mocks } = makeContext(stored, { ticketsSold: 5 });

    await updateTicketType(deps, {
      actorHumanId: ACTOR_ID,
      ticketTypeId: TICKET_TYPE_ID,
      name: "VIP",
      priceCents: 5000,
      pricingMode: "FIXED",
      minimumCents: null,
      suggestedCents: null,
      capacity: 90,
      resaleAllowed: false,
      resaleCapCents: null,
    });

    expect(mocks.tickets.updateTicketType).toHaveBeenCalledWith(
      expect.objectContaining({ resaleCapCents: null, capacity: 90 }),
    );
  });

  it("(b) still refuses turning resale ON, cap included", async () => {
    const stored = makeStoredTicketType({
      resaleAllowed: false,
      resaleCapCents: 8000,
    });
    const { deps, mocks } = makeContext(stored, { ticketsSold: 5 });

    await expect(
      updateTicketType(deps, {
        actorHumanId: ACTOR_ID,
        ticketTypeId: TICKET_TYPE_ID,
        resaleAllowed: true,
        resaleCapCents: 8000,
      }),
    ).rejects.toMatchObject({
      code: "TICKET_TYPE_LOCKED_BY_SALES",
      meta: { fields: ["resaleAllowed"] },
    });
    expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
  });

  it("(c) FIXED: a stored non-null minimumCents / suggestedCents resent as null is not a change", async () => {
    const stored = makeStoredTicketType({
      minimumCents: 300,
      suggestedCents: 400,
    });
    const { deps, mocks } = makeContext(stored, { ticketsSold: 5 });

    await updateTicketType(deps, {
      actorHumanId: ACTOR_ID,
      ticketTypeId: TICKET_TYPE_ID,
      name: "VIP",
      priceCents: 5000,
      pricingMode: "FIXED",
      minimumCents: null,
      suggestedCents: null,
      capacity: 90,
      resaleAllowed: false,
      resaleCapCents: null,
    });

    expect(mocks.tickets.updateTicketType).toHaveBeenCalledWith(
      expect.objectContaining({
        minimumCents: null,
        suggestedCents: null,
        capacity: 90,
      }),
    );
  });

  it.each([
    { label: "minimumCents 500 → 800", min: 800, sug: 1500, field: "minimumCents" },
    { label: "minimumCents 500 → cleared (0)", min: null, sug: 1500, field: "minimumCents" },
    { label: "suggestedCents 1500 → 2000", min: 500, sug: 2000, field: "suggestedCents" },
  ])(
    "ADJUSTABLE: still refuses a genuine $label after a sale",
    async ({ min, sug, field }) => {
      const { deps, mocks } = makeContext(ADJUSTABLE_ROW(), { ticketsSold: 5 });

      await expect(
        updateTicketType(deps, editorAdjustableSave(min, sug)),
      ).rejects.toMatchObject({
        code: "TICKET_TYPE_LOCKED_BY_SALES",
        meta: { fields: [field] },
      });
      expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
    },
  );

  it("ADJUSTABLE: an older row the clamp rewrites (schedule, price, resale) still takes the editor's save + new capacity", async () => {
    const stored = ADJUSTABLE_ROW({
      priceCents: 700,
      resaleAllowed: true,
      resaleCapCents: 9000,
      scheduledPriceCents: 6000,
      scheduledPriceAt: new Date("2025-01-20T18:00:00.000Z"),
    });
    const { deps, mocks } = makeContext(stored, { ticketsSold: 5 });

    const result = await updateTicketType(deps, editorAdjustableSave(500, 1500));

    expect(result.capacity).toBe(90);
    // The clamp's values are still what gets written.
    expect(mocks.tickets.updateTicketType).toHaveBeenCalledWith(
      expect.objectContaining({
        capacity: 90,
        priceCents: 0,
        resaleAllowed: false,
        resaleCapCents: null,
        scheduledPriceCents: null,
        scheduledPriceAt: null,
      }),
    );
    expect(mocks.events.getPopularityStats).not.toHaveBeenCalled();
  });

  it("still refuses switching ADJUSTABLE → FIXED after a sale", async () => {
    const { deps, mocks } = makeContext(ADJUSTABLE_ROW(), { ticketsSold: 5 });

    await expect(
      updateTicketType(deps, {
        actorHumanId: ACTOR_ID,
        ticketTypeId: TICKET_TYPE_ID,
        pricingMode: "FIXED",
        priceCents: 0,
        capacity: 90,
      }),
    ).rejects.toMatchObject({
      code: "TICKET_TYPE_LOCKED_BY_SALES",
      meta: { fields: expect.arrayContaining(["pricingMode"]) },
    });
    expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
  });

  it("still refuses switching FIXED → ADJUSTABLE after a sale", async () => {
    const { deps, mocks } = makeContext(makeStoredTicketType(), {
      ticketsSold: 5,
    });

    await expect(
      updateTicketType(deps, editorAdjustableSave(500, 1500)),
    ).rejects.toMatchObject({ code: "TICKET_TYPE_LOCKED_BY_SALES" });
    expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
  });

  it("leaves an unsold event's edits alone (price + name change are written)", async () => {
    const { deps, mocks } = makeContext(LOCKABLE(), { ticketsSold: 0 });

    const result = await updateTicketType(deps, {
      actorHumanId: ACTOR_ID,
      ticketTypeId: TICKET_TYPE_ID,
      name: "VIP Deluxe",
      priceCents: 4500,
    });

    expect(result).toMatchObject({ name: "VIP Deluxe", priceCents: 4500 });
    expect(mocks.events.getPopularityStats).toHaveBeenCalledWith([EVENT_ID]);
    expect(mocks.tickets.updateTicketType).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STORED SEAT PRICE OVERRIDES (seat-price-overrides spec, step 7e). A
// pay-what-you-want tier ignores its section's stored overrides; a FIXED tier
// is charged them. So a switch to FIXED at $0 starts taking money on a
// section that already holds a paid override, and must pass the gates the
// override write itself runs.
// ─────────────────────────────────────────────────────────────────────────────

describe("updateTicketType — a switch to FIXED on a section that stores seat price overrides", () => {
  const SECTION = "66666666-6666-4666-8666-666666666666";
  const OTHER_SECTION = "77777777-7777-4777-8777-777777777777";
  const paid: SeatSectionPriceOverride = {
    seatSectionId: SECTION,
    priceOverride: { priceCents: 5000, reason: null },
  };
  const corrupt: SeatSectionPriceOverride = {
    seatSectionId: SECTION,
    priceOverride: { invalid: true },
  };
  // No minimum: the one tier shape that never needed a linked account.
  const PWYW = () =>
    makeStoredTicketType({
      priceCents: 0,
      pricingMode: "ADJUSTABLE",
      minimumCents: 0,
      seatSectionId: SECTION,
    });
  const toFixedFree = {
    actorHumanId: ACTOR_ID,
    ticketTypeId: TICKET_TYPE_ID,
    pricingMode: "FIXED" as const,
    priceCents: 0,
  };

  it("refuses the switch when the section holds a paid override and no account is linked", async () => {
    const { deps, mocks } = makeContext(PWYW(), {
      payee: null,
      seatOverrides: [paid],
    });

    await expect(updateTicketType(deps, toFixedFree)).rejects.toMatchObject({
      code: "PAID_TICKETING_REQUIRES_STRIPE",
    });

    expect(mocks.listDistinctPriceOverridesByEvent).toHaveBeenCalledTimes(1);
    expect(mocks.listDistinctPriceOverridesByEvent).toHaveBeenCalledWith({
      eventId: EVENT_ID,
    });
    expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
  });

  it("refuses the switch when no fee policy resolves", async () => {
    const { deps, mocks } = makeContext(PWYW(), {
      feePolicy: null,
      seatOverrides: [paid],
    });

    await expect(updateTicketType(deps, toFixedFree)).rejects.toMatchObject({
      code: "PAID_TICKETING_REQUIRES_FEE_POLICY",
    });

    expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
  });

  it("allows the switch with a linked account and a fee policy", async () => {
    const { deps, mocks } = makeContext(PWYW(), { seatOverrides: [paid] });

    await updateTicketType(deps, toFixedFree);

    expect(mocks.tickets.updateTicketType).toHaveBeenCalledTimes(1);
    expect(mocks.payees.getBySubject).toHaveBeenCalledTimes(1);
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
    "allows the switch with no account and no fee policy when the section holds %s",
    async (_label, seatOverrides) => {
      const { deps, mocks } = makeContext(PWYW(), {
        payee: null,
        feePolicy: null,
        seatOverrides,
      });

      await updateTicketType(deps, toFixedFree);

      expect(mocks.tickets.updateTicketType).toHaveBeenCalledTimes(1);
      expect(mocks.payees.getBySubject).not.toHaveBeenCalled();
    },
  );

  it("counts a corrupt stored value as paid and reports it", async () => {
    const reportError = vi.fn();
    const { deps } = makeContext(PWYW(), {
      payee: null,
      reportError,
      seatOverrides: [corrupt],
    });

    await expect(updateTicketType(deps, toFixedFree)).rejects.toMatchObject({
      code: "PAID_TICKETING_REQUIRES_STRIPE",
    });

    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: {
          useCase: "updateTicketType",
          fault: "seat_price_override_invalid",
        },
        extra: expect.objectContaining({
          eventId: EVENT_ID,
          seatSectionIds: [SECTION],
        }),
      }),
    );
  });

  it("a throwing reporter does not change the corrupt-value verdict", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry is down");
    });
    const refused = makeContext(PWYW(), {
      payee: null,
      reportError,
      seatOverrides: [corrupt],
    });
    const allowed = makeContext(PWYW(), {
      reportError,
      seatOverrides: [corrupt],
    });

    await expect(
      updateTicketType(refused.deps, toFixedFree),
    ).rejects.toMatchObject({ code: "PAID_TICKETING_REQUIRES_STRIPE" });
    await updateTicketType(allowed.deps, toFixedFree);

    expect(reportError).toHaveBeenCalledTimes(2);
    expect(allowed.mocks.tickets.updateTicketType).toHaveBeenCalledTimes(1);
  });

  it("never refuses a switch to pay-what-you-want, and does not read the seats", async () => {
    const { deps, mocks } = makeContext(
      makeStoredTicketType({ priceCents: 0, seatSectionId: SECTION }),
      { payee: null, seatOverrides: [paid] },
    );

    await updateTicketType(deps, {
      actorHumanId: ACTOR_ID,
      ticketTypeId: TICKET_TYPE_ID,
      pricingMode: "ADJUSTABLE",
    });

    expect(mocks.listDistinctPriceOverridesByEvent).not.toHaveBeenCalled();
    expect(mocks.tickets.updateTicketType).toHaveBeenCalledTimes(1);
  });

  it("does not read the seats when a FIXED tier stays FIXED on its section", async () => {
    const { deps, mocks } = makeContext(
      makeStoredTicketType({ priceCents: 0, seatSectionId: SECTION }),
      { payee: null, seatOverrides: [paid] },
    );

    await updateTicketType(deps, {
      actorHumanId: ACTOR_ID,
      ticketTypeId: TICKET_TYPE_ID,
      name: "Floor",
    });

    expect(mocks.listDistinctPriceOverridesByEvent).not.toHaveBeenCalled();
    expect(mocks.tickets.updateTicketType).toHaveBeenCalledTimes(1);
  });

  it("does not read the seats when the tier has no seat section", async () => {
    const { deps, mocks } = makeContext(
      makeStoredTicketType({
        priceCents: 0,
        pricingMode: "ADJUSTABLE",
        minimumCents: 0,
      }),
      { payee: null, seatOverrides: [paid] },
    );

    await updateTicketType(deps, toFixedFree);

    expect(mocks.listDistinctPriceOverridesByEvent).not.toHaveBeenCalled();
    expect(mocks.tickets.updateTicketType).toHaveBeenCalledTimes(1);
  });

  it("a switch to a PAID FIXED price runs the existing Stripe gate once and does not read the seats", async () => {
    const { deps, mocks } = makeContext(PWYW(), { seatOverrides: [paid] });

    await updateTicketType(deps, { ...toFixedFree, priceCents: 2000 });

    expect(mocks.listDistinctPriceOverridesByEvent).not.toHaveBeenCalled();
    expect(mocks.payees.getBySubject).toHaveBeenCalledTimes(1);
    expect(mocks.tickets.updateTicketType).toHaveBeenCalledTimes(1);
  });

  it("the refusal names the stored seat price and the section behind it", async () => {
    const paidCase = makeContext(PWYW(), { payee: null, seatOverrides: [paid] });
    const corruptCase = makeContext(PWYW(), {
      feePolicy: null,
      seatOverrides: [corrupt],
    });

    await expect(
      updateTicketType(paidCase.deps, toFixedFree),
    ).rejects.toMatchObject({
      code: "PAID_TICKETING_REQUIRES_STRIPE",
      meta: {
        cause: "stored_seat_price",
        seatSectionIds: [SECTION],
        invalidSeatSectionIds: [],
      },
    });
    await expect(
      updateTicketType(corruptCase.deps, toFixedFree),
    ).rejects.toMatchObject({
      code: "PAID_TICKETING_REQUIRES_FEE_POLICY",
      meta: {
        cause: "seat_price_override_invalid",
        seatSectionIds: [SECTION],
        invalidSeatSectionIds: [SECTION],
      },
    });
  });

  it("a pay-what-you-want tier WITH a minimum switched to FIXED $0 is gated: the old minimum does not make it paid", async () => {
    // Stored: ADJUSTABLE, $5 minimum (a tier that needed a linked account
    // when it was priced). Written: FIXED at $0, which takes no money of its
    // own, so the stored override is what it would start charging.
    const { deps, mocks } = makeContext(
      makeStoredTicketType({
        priceCents: 0,
        pricingMode: "ADJUSTABLE",
        minimumCents: 500,
        seatSectionId: SECTION,
      }),
      { payee: null, seatOverrides: [paid] },
    );

    await expect(updateTicketType(deps, toFixedFree)).rejects.toMatchObject({
      code: "PAID_TICKETING_REQUIRES_STRIPE",
    });

    expect(mocks.listDistinctPriceOverridesByEvent).toHaveBeenCalledTimes(1);
    expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
  });

  it("ACCEPTED GAP: a paid FIXED tier edited to $0 on a section with a paid override is not gated", async () => {
    // The tier already sells the section at a FIXED price, so the edit starts
    // nothing; it passed these gates when it was priced. After the edit a
    // free tier sells a paid seat with no gate run at this moment (spec
    // as_built "tier write gate (7e)", accepted list). Publish and checkout
    // still require a Ready account.
    const { deps, mocks } = makeContext(
      makeStoredTicketType({ priceCents: 2000, seatSectionId: SECTION }),
      { payee: null, feePolicy: null, seatOverrides: [paid] },
    );

    await updateTicketType(deps, {
      actorHumanId: ACTOR_ID,
      ticketTypeId: TICKET_TYPE_ID,
      priceCents: 0,
    });

    expect(mocks.listDistinctPriceOverridesByEvent).not.toHaveBeenCalled();
    expect(mocks.payees.getBySubject).not.toHaveBeenCalled();
    expect(mocks.tickets.updateTicketType).toHaveBeenCalledTimes(1);
  });
});
