import { describe, it, expect, vi, beforeEach } from "vitest";
import { assignTicketTypeSections } from "../assign-ticket-type-sections";
import type { AssignTicketTypeSectionsDeps } from "../assign-ticket-type-sections";

// ── Fixture UUIDs ────────────────────────────────────────────────────────────

const EVENT_ID = "11111111-1111-4111-a111-111111111111";
const ACTOR_ID = "22222222-2222-4222-a222-222222222222";
const TT_ID_1 = "33333333-3333-4333-a333-333333333333";
const TT_ID_2 = "44444444-4444-4444-a444-444444444444";
const SECTION_ID_A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const SECTION_ID_B = "bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb";
const ORG_ID = "cccccccc-cccc-4ccc-accc-cccccccccccc";
/** A real section, of ANOTHER event. */
const FOREIGN_SECTION_ID = "99999999-9999-4999-a999-999999999999";
/** An id no section has. */
const MISSING_SECTION_ID = "88888888-8888-4888-a888-888888888888";

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildEvent(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: EVENT_ID,
    status: "DRAFT",
    orgId: ORG_ID,
    humanId: null,
    placeLayoutId: "dddddddd-dddd-4ddd-addd-dddddddddddd",
    ...overrides,
  };
}

function buildTicketType(
  id: string,
  overrides?: Partial<Record<string, unknown>>,
) {
  return {
    id,
    eventId: EVENT_ID,
    name: `Ticket ${id.slice(0, 4)}`,
    priceCents: 1000,
    capacity: 100,
    status: "ACTIVE",
    seatSectionId: null,
    ...overrides,
  };
}

function buildSection(id: string) {
  return {
    id,
    name: `Section ${id.slice(0, 4)}`,
    type: "RESERVED" as const,
    capacity: 50,
    layoutSectionId: null,
    placeLayoutId: null,
  };
}

/** The sections of EVENT_ID: what `seats.listSectionsByEvent` answers for it. */
function buildEventSections() {
  return [buildSection(SECTION_ID_A), buildSection(SECTION_ID_B)];
}

function buildDeps(
  overrides?: Partial<Record<string, unknown>>,
): AssignTicketTypeSectionsDeps {
  const txRepos = {
    events: {
      getById: vi.fn(async () => buildEvent()),
    },
    tickets: {
      getTicketTypeById: vi.fn(async (id: string) => {
        if (id === TT_ID_1) return buildTicketType(TT_ID_1);
        if (id === TT_ID_2) return buildTicketType(TT_ID_2);
        return null;
      }),
      updateTicketType: vi.fn(async (input: { id: string }) =>
        buildTicketType(input.id),
      ),
    },
    seats: {
      listSectionsByEvent: vi.fn(async () => buildEventSections()),
    },
    authz: {
      getOrgMembership: vi.fn(async () => ({ role: "ADMIN" })),
    },
    audit: {
      log: vi.fn(async () => {}),
    },
    ...overrides,
  };

  return {
    repos: {
      tx: vi.fn(async (fn: (tx: typeof txRepos) => Promise<unknown>) =>
        fn(txRepos),
      ),
      ...txRepos,
    } as unknown as AssignTicketTypeSectionsDeps["repos"],
    clock: { now: () => new Date("2026-10-10T12:00:00.000Z") },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("assignTicketTypeSections", () => {
  it("assigns one ticket type to a section", async () => {
    const deps = buildDeps();
    const result = await assignTicketTypeSections(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      assignments: [{ ticketTypeId: TT_ID_1, seatSectionId: SECTION_ID_A }],
    });

    expect(result.eventId).toBe(EVENT_ID);
    expect(result.updated).toBe(1);
  });

  it("assigns multiple ticket types in one call", async () => {
    const deps = buildDeps();
    const result = await assignTicketTypeSections(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      assignments: [
        { ticketTypeId: TT_ID_1, seatSectionId: SECTION_ID_A },
        { ticketTypeId: TT_ID_2, seatSectionId: SECTION_ID_B },
      ],
    });

    expect(result.updated).toBe(2);
  });

  it("unassigns a ticket type when seatSectionId is null", async () => {
    const deps = buildDeps();
    const result = await assignTicketTypeSections(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      assignments: [{ ticketTypeId: TT_ID_1, seatSectionId: null }],
    });

    expect(result.updated).toBe(1);
  });

  it("passes seatSectionId to updateTicketType", async () => {
    const deps = buildDeps();
    await assignTicketTypeSections(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      assignments: [{ ticketTypeId: TT_ID_1, seatSectionId: SECTION_ID_A }],
    });

    // The tx mock receives the fn, so we need to verify via the repos mock
    const txFn = (deps.repos.tx as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    // txFn was already invoked; check the mock on the txRepos
    const txRepos = deps.repos as unknown as Record<string, unknown>;
    const updateMock = (
      txRepos.tickets as Record<string, ReturnType<typeof vi.fn>>
    ).updateTicketType;
    expect(updateMock).toHaveBeenCalledWith({
      id: TT_ID_1,
      seatSectionId: SECTION_ID_A,
    });
  });

  it("throws not_found when event does not exist", async () => {
    const deps = buildDeps({
      events: { getById: vi.fn(async () => null) },
    });

    await expect(
      assignTicketTypeSections(deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        assignments: [{ ticketTypeId: TT_ID_1, seatSectionId: SECTION_ID_A }],
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "EVENT_NOT_FOUND" }),
    );
  });

  it("throws forbidden when actor lacks org role", async () => {
    const deps = buildDeps({
      authz: { getOrgMembership: vi.fn(async () => null) },
    });

    await expect(
      assignTicketTypeSections(deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        assignments: [{ ticketTypeId: TT_ID_1, seatSectionId: SECTION_ID_A }],
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "INSUFFICIENT_ROLE" }));
  });

  it("throws not_found when ticket type does not exist", async () => {
    const UNKNOWN_TT = "eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee";
    const deps = buildDeps();

    await expect(
      assignTicketTypeSections(deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        assignments: [
          { ticketTypeId: UNKNOWN_TT, seatSectionId: SECTION_ID_A },
        ],
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "TICKET_TYPE_NOT_FOUND" }),
    );
  });

  it("throws forbidden when ticket type belongs to a different event", async () => {
    const OTHER_EVENT = "ffffffff-ffff-4fff-afff-ffffffffffff";
    const deps = buildDeps({
      tickets: {
        getTicketTypeById: vi.fn(async () =>
          buildTicketType(TT_ID_1, { eventId: OTHER_EVENT }),
        ),
        updateTicketType: vi.fn(async () => buildTicketType(TT_ID_1)),
      },
    });

    await expect(
      assignTicketTypeSections(deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        assignments: [{ ticketTypeId: TT_ID_1, seatSectionId: SECTION_ID_A }],
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "TICKET_TYPE_EVENT_MISMATCH" }),
    );
  });

  it("throws conflict when event is cancelled", async () => {
    const deps = buildDeps({
      events: {
        getById: vi.fn(async () => buildEvent({ status: "CANCELLED" })),
      },
    });

    await expect(
      assignTicketTypeSections(deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        assignments: [{ ticketTypeId: TT_ID_1, seatSectionId: SECTION_ID_A }],
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "EVENT_NOT_EDITABLE" }),
    );
  });

  it("throws invalid_input when assignments array is empty", async () => {
    const deps = buildDeps();

    await expect(
      assignTicketTypeSections(deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        assignments: [],
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "invalid_input" }));
  });

  it("writes an audit log entry", async () => {
    const deps = buildDeps();
    await assignTicketTypeSections(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      assignments: [{ ticketTypeId: TT_ID_1, seatSectionId: SECTION_ID_A }],
    });

    const txRepos = deps.repos as unknown as Record<string, unknown>;
    const auditLog = (txRepos.audit as Record<string, ReturnType<typeof vi.fn>>)
      .log;
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event",
        entityId: EVENT_ID,
        action: "ticket_type_sections_assigned",
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STORED SEAT PRICE OVERRIDES (seat-price-overrides spec, step 7e). Checkout
// charges a FIXED tier's seat at the seat's stored override. Assigning a FREE
// FIXED tier to a section that already holds a paid one starts taking money,
// so it must pass the gates the override write itself runs. An unassign never
// does.
// ─────────────────────────────────────────────────────────────────────────────

describe("assignTicketTypeSections — a section that already stores seat price overrides", () => {
  type Override = {
    seatSectionId: string;
    priceOverride: { priceCents: number; reason: null } | { invalid: true };
  };
  const paid: Override = {
    seatSectionId: SECTION_ID_A,
    priceOverride: { priceCents: 5000, reason: null },
  };
  const corrupt: Override = {
    seatSectionId: SECTION_ID_A,
    priceOverride: { invalid: true },
  };

  function freeFixedTier(id: string, over: Record<string, unknown> = {}) {
    return buildTicketType(id, {
      priceCents: 0,
      pricingMode: "FIXED",
      minimumCents: null,
      scheduledPriceCents: null,
      scheduledPriceAt: null,
      ...over,
    });
  }

  function harness(opts: {
    tiers: ReturnType<typeof buildTicketType>[];
    seatOverrides?: Override[];
    eventStatus?: "DRAFT" | "PUBLISHED";
    /** `null` = the organizer has no linked Stripe account. */
    payee?: { stripeAccountId: string | null } | null;
    feePolicy?: boolean;
    reportError?: AssignTicketTypeSectionsDeps["reportError"];
  }) {
    const payee =
      opts.payee === undefined ? { stripeAccountId: "acct_1" } : opts.payee;
    const mocks = {
      events: {
        getById: vi.fn(async () =>
          buildEvent({ status: opts.eventStatus ?? "PUBLISHED" }),
        ),
      },
      tickets: {
        getTicketTypeById: vi.fn(
          async (id: string) => opts.tiers.find((t) => t.id === id) ?? null,
        ),
        updateTicketType: vi.fn(async (input: { id: string }) =>
          buildTicketType(input.id),
        ),
      },
      seats: {
        listDistinctPriceOverridesByEvent: vi.fn(
          async (_input: { eventId: string }) => opts.seatOverrides ?? [],
        ),
        listSectionsByEvent: vi.fn(async (eventId: string) =>
          eventId === EVENT_ID ? buildEventSections() : [],
        ),
        // The id-only read: it finds a section of ANY event, so it cannot
        // answer "is this a section of this event".
        getSectionById: vi.fn(async (id: string) =>
          id === MISSING_SECTION_ID ? null : buildSection(id),
        ),
      },
      authz: { getOrgMembership: vi.fn(async () => ({ role: "ADMIN" })) },
      payees: {
        getBySubject: vi.fn(async () => (payee ? { id: "payee-1" } : null)),
        getById: vi.fn(async () =>
          payee
            ? { id: "payee-1", stripeAccountId: payee.stripeAccountId }
            : null,
        ),
      },
      feePolicies: {
        resolveEffective: vi.fn(async () =>
          opts.feePolicy === false ? null : { id: "fp-1" },
        ),
      },
      audit: { log: vi.fn(async () => {}) },
    };
    const deps: AssignTicketTypeSectionsDeps = {
      repos: {
        ...mocks,
        tx: async (fn: (tx: typeof mocks) => Promise<unknown>) => fn(mocks),
      } as unknown as AssignTicketTypeSectionsDeps["repos"],
      clock: { now: () => new Date("2026-10-10T12:00:00.000Z") },
      reportError: opts.reportError,
    };
    return { deps, mocks };
  }

  const assign = (
    deps: AssignTicketTypeSectionsDeps,
    assignments: { ticketTypeId: string; seatSectionId: string | null }[],
  ) =>
    assignTicketTypeSections(deps, {
      actorHumanId: ACTOR_ID,
      eventId: EVENT_ID,
      assignments,
    });
  const toSectionA = [{ ticketTypeId: TT_ID_1, seatSectionId: SECTION_ID_A }];

  it.each(["DRAFT", "PUBLISHED"] as const)(
    "refuses a free FIXED tier onto a section with a paid override when no account is linked (%s event)",
    async (eventStatus) => {
      const { deps, mocks } = harness({
        tiers: [freeFixedTier(TT_ID_1)],
        seatOverrides: [paid],
        eventStatus,
        payee: null,
      });

      await expect(assign(deps, toSectionA)).rejects.toMatchObject({
        code: "PAID_TICKETING_REQUIRES_STRIPE",
      });

      expect(
        mocks.seats.listDistinctPriceOverridesByEvent,
      ).toHaveBeenCalledTimes(1);
      expect(
        mocks.seats.listDistinctPriceOverridesByEvent,
      ).toHaveBeenCalledWith({ eventId: EVENT_ID });
      // Refused before ANY assignment of the call is written.
      expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
      expect(mocks.audit.log).not.toHaveBeenCalled();
    },
  );

  it("refuses when the account row exists but was never linked to Stripe", async () => {
    const { deps } = harness({
      tiers: [freeFixedTier(TT_ID_1)],
      seatOverrides: [paid],
      payee: { stripeAccountId: null },
    });

    await expect(assign(deps, toSectionA)).rejects.toMatchObject({
      code: "PAID_TICKETING_REQUIRES_STRIPE",
    });
  });

  it("refuses when no fee policy resolves", async () => {
    const { deps, mocks } = harness({
      tiers: [freeFixedTier(TT_ID_1)],
      seatOverrides: [paid],
      feePolicy: false,
    });

    await expect(assign(deps, toSectionA)).rejects.toMatchObject({
      code: "PAID_TICKETING_REQUIRES_FEE_POLICY",
    });
    expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
  });

  it("allows it with a linked account and a fee policy", async () => {
    const { deps, mocks } = harness({
      tiers: [freeFixedTier(TT_ID_1)],
      seatOverrides: [paid],
    });

    await expect(assign(deps, toSectionA)).resolves.toMatchObject({
      updated: 1,
    });
    expect(mocks.payees.getBySubject).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no override", []],
    [
      "only a $0 override",
      [
        {
          seatSectionId: SECTION_ID_A,
          priceOverride: { priceCents: 0, reason: null },
        },
      ],
    ],
    [
      "nothing, while another section holds a paid one",
      [{ ...paid, seatSectionId: SECTION_ID_B }],
    ],
  ] as [string, Override[]][])(
    "allows it with no account and no fee policy when the section holds %s",
    async (_label, seatOverrides) => {
      const { deps, mocks } = harness({
        tiers: [freeFixedTier(TT_ID_1)],
        seatOverrides,
        payee: null,
        feePolicy: false,
      });

      await expect(assign(deps, toSectionA)).resolves.toMatchObject({
        updated: 1,
      });
      expect(mocks.payees.getBySubject).not.toHaveBeenCalled();
    },
  );

  it("counts a corrupt stored value as paid and reports it", async () => {
    const reportError = vi.fn();
    const { deps, mocks } = harness({
      tiers: [freeFixedTier(TT_ID_1)],
      seatOverrides: [corrupt],
      payee: null,
      reportError,
    });

    await expect(assign(deps, toSectionA)).rejects.toMatchObject({
      code: "PAID_TICKETING_REQUIRES_STRIPE",
    });

    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: {
          useCase: "assignTicketTypeSections",
          fault: "seat_price_override_invalid",
        },
        extra: expect.objectContaining({
          eventId: EVENT_ID,
          seatSectionIds: [SECTION_ID_A],
        }),
      }),
    );
    expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
  });

  it("a throwing reporter does not change the corrupt-value verdict", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry is down");
    });
    const refused = harness({
      tiers: [freeFixedTier(TT_ID_1)],
      seatOverrides: [corrupt],
      payee: null,
      reportError,
    });
    const allowed = harness({
      tiers: [freeFixedTier(TT_ID_1)],
      seatOverrides: [corrupt],
      reportError,
    });

    await expect(assign(refused.deps, toSectionA)).rejects.toMatchObject({
      code: "PAID_TICKETING_REQUIRES_STRIPE",
    });
    await expect(assign(allowed.deps, toSectionA)).resolves.toMatchObject({
      updated: 1,
    });
    expect(reportError).toHaveBeenCalledTimes(2);
  });

  it("never refuses an unassign, and does not read the seats for one", async () => {
    const { deps, mocks } = harness({
      tiers: [freeFixedTier(TT_ID_1, { seatSectionId: SECTION_ID_A })],
      seatOverrides: [paid],
      payee: null,
      feePolicy: false,
    });

    await expect(
      assign(deps, [{ ticketTypeId: TT_ID_1, seatSectionId: null }]),
    ).resolves.toMatchObject({ updated: 1 });

    expect(
      mocks.seats.listDistinctPriceOverridesByEvent,
    ).not.toHaveBeenCalled();
  });

  it("does not read the seats when a tier is re-assigned to the section it already sells", async () => {
    const { deps, mocks } = harness({
      tiers: [freeFixedTier(TT_ID_1, { seatSectionId: SECTION_ID_A })],
      seatOverrides: [paid],
      payee: null,
    });

    await expect(assign(deps, toSectionA)).resolves.toMatchObject({
      updated: 1,
    });
    expect(
      mocks.seats.listDistinctPriceOverridesByEvent,
    ).not.toHaveBeenCalled();
  });

  it("does not read the seats for a pay-what-you-want tier, which ignores overrides", async () => {
    const { deps, mocks } = harness({
      tiers: [
        freeFixedTier(TT_ID_1, { pricingMode: "ADJUSTABLE", minimumCents: 0 }),
      ],
      seatOverrides: [paid],
      payee: null,
    });

    await expect(assign(deps, toSectionA)).resolves.toMatchObject({
      updated: 1,
    });
    expect(
      mocks.seats.listDistinctPriceOverridesByEvent,
    ).not.toHaveBeenCalled();
  });

  it("does not read the seats for a PAID tier, which passed these gates when it was priced", async () => {
    const { deps, mocks } = harness({
      tiers: [freeFixedTier(TT_ID_1, { priceCents: 2000 })],
      seatOverrides: [paid],
      payee: null,
    });

    await expect(assign(deps, toSectionA)).resolves.toMatchObject({
      updated: 1,
    });
    expect(
      mocks.seats.listDistinctPriceOverridesByEvent,
    ).not.toHaveBeenCalled();
    expect(mocks.payees.getBySubject).not.toHaveBeenCalled();
  });

  it("reads the seats once for a call with several assignments", async () => {
    const { deps, mocks } = harness({
      tiers: [freeFixedTier(TT_ID_1), freeFixedTier(TT_ID_2)],
      seatOverrides: [{ ...paid, seatSectionId: SECTION_ID_B }],
      payee: null,
    });

    await expect(
      assign(deps, [
        { ticketTypeId: TT_ID_1, seatSectionId: SECTION_ID_A },
        { ticketTypeId: TT_ID_2, seatSectionId: SECTION_ID_B },
      ]),
    ).rejects.toMatchObject({ code: "PAID_TICKETING_REQUIRES_STRIPE" });

    expect(
      mocks.seats.listDistinctPriceOverridesByEvent,
    ).toHaveBeenCalledTimes(1);
    expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
  });

  it("on a PUBLISHED event a tier that is not ACTIVE sells nothing, so it is not gated", async () => {
    const { deps } = harness({
      tiers: [freeFixedTier(TT_ID_1, { status: "DRAFT" })],
      seatOverrides: [paid],
      payee: null,
      eventStatus: "PUBLISHED",
    });

    await expect(assign(deps, toSectionA)).resolves.toMatchObject({
      updated: 1,
    });
  });

  // ── What the refusal tells the client (`error.data.meta` on the wire) ──────
  // The tier is free, so the bare code reads as "a $0 ticket needs payouts".
  // The meta names the cause and the sections whose stored price is behind it.

  it("the Stripe refusal names the stored seat price and the section behind it", async () => {
    const { deps } = harness({
      tiers: [freeFixedTier(TT_ID_1), freeFixedTier(TT_ID_2)],
      // Only B holds a paid price; the save assigns to A and to B.
      seatOverrides: [{ ...paid, seatSectionId: SECTION_ID_B }],
      payee: null,
    });

    await expect(
      assign(deps, [
        { ticketTypeId: TT_ID_1, seatSectionId: SECTION_ID_A },
        { ticketTypeId: TT_ID_2, seatSectionId: SECTION_ID_B },
      ]),
    ).rejects.toMatchObject({
      code: "PAID_TICKETING_REQUIRES_STRIPE",
      meta: {
        cause: "stored_seat_price",
        seatSectionIds: [SECTION_ID_B],
        invalidSeatSectionIds: [],
      },
    });
  });

  it("the fee-policy refusal carries the same meta", async () => {
    const { deps } = harness({
      tiers: [freeFixedTier(TT_ID_1)],
      seatOverrides: [paid],
      feePolicy: false,
    });

    await expect(assign(deps, toSectionA)).rejects.toMatchObject({
      code: "PAID_TICKETING_REQUIRES_FEE_POLICY",
      meta: {
        cause: "stored_seat_price",
        seatSectionIds: [SECTION_ID_A],
        invalidSeatSectionIds: [],
      },
    });
  });

  it("a corrupt value as the only reason is told apart, as at publish", async () => {
    const { deps } = harness({
      tiers: [freeFixedTier(TT_ID_1)],
      seatOverrides: [corrupt],
      payee: null,
    });

    await expect(assign(deps, toSectionA)).rejects.toMatchObject({
      code: "PAID_TICKETING_REQUIRES_STRIPE",
      meta: {
        cause: "seat_price_override_invalid",
        seatSectionIds: [SECTION_ID_A],
        invalidSeatSectionIds: [SECTION_ID_A],
      },
    });
  });

  // ── Batches ────────────────────────────────────────────────────────────────

  it("a paid tier and a free tier onto the same overridden section: the free one is gated", async () => {
    const tiers = [
      freeFixedTier(TT_ID_1, { priceCents: 2000 }),
      freeFixedTier(TT_ID_2),
    ];
    const both = [
      { ticketTypeId: TT_ID_1, seatSectionId: SECTION_ID_A },
      { ticketTypeId: TT_ID_2, seatSectionId: SECTION_ID_A },
    ];
    const refused = harness({ tiers, seatOverrides: [paid], payee: null });
    const allowed = harness({ tiers, seatOverrides: [paid] });

    // The paid tier beside it does not vouch for the free one.
    await expect(assign(refused.deps, both)).rejects.toMatchObject({
      code: "PAID_TICKETING_REQUIRES_STRIPE",
    });
    expect(refused.mocks.tickets.updateTicketType).not.toHaveBeenCalled();
    expect(
      refused.mocks.seats.listDistinctPriceOverridesByEvent,
    ).toHaveBeenCalledTimes(1);

    await expect(assign(allowed.deps, both)).resolves.toMatchObject({
      updated: 2,
    });
  });

  it("the same tier twice in one call: each assignment is judged against the STORED tier", async () => {
    // Stored: unassigned. The call puts it on A (paid override), then on B.
    // The last write wins and B holds nothing, but A is still gated: stricter
    // than the end state needs, never looser.
    const { deps, mocks } = harness({
      tiers: [freeFixedTier(TT_ID_1)],
      seatOverrides: [paid],
      payee: null,
    });

    await expect(
      assign(deps, [
        { ticketTypeId: TT_ID_1, seatSectionId: SECTION_ID_A },
        { ticketTypeId: TT_ID_1, seatSectionId: SECTION_ID_B },
      ]),
    ).rejects.toMatchObject({ code: "PAID_TICKETING_REQUIRES_STRIPE" });
    expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
  });

  it("the same tier taken off its section and put back in one call starts nothing", async () => {
    // Stored: on A. The call ends where it began, so nothing starts selling.
    const { deps, mocks } = harness({
      tiers: [freeFixedTier(TT_ID_1, { seatSectionId: SECTION_ID_A })],
      seatOverrides: [paid],
      payee: null,
    });

    await expect(
      assign(deps, [
        { ticketTypeId: TT_ID_1, seatSectionId: null },
        { ticketTypeId: TT_ID_1, seatSectionId: SECTION_ID_A },
      ]),
    ).resolves.toMatchObject({ updated: 2 });
    expect(
      mocks.seats.listDistinctPriceOverridesByEvent,
    ).not.toHaveBeenCalled();
    expect(mocks.tickets.updateTicketType).toHaveBeenLastCalledWith({
      id: TT_ID_1,
      seatSectionId: SECTION_ID_A,
    });
  });

  // ── The section must be one of THIS event's ────────────────────────────────
  // The adapter only needs the section to exist (a foreign key), so the use
  // case is what keeps a tier of this event off a section of another event.
  // A free FIXED tier is used throughout: without the refusal it would reach
  // the stored-override gate and its seat read.

  describe("a seat section that is not this event's", () => {
    it.each([
      ["a section of another event", FOREIGN_SECTION_ID],
      ["an id no section has", MISSING_SECTION_ID],
    ])(
      "refuses %s: nothing written, the stored-override gate not run",
      async (_label, seatSectionId) => {
        const { deps, mocks } = harness({
          tiers: [freeFixedTier(TT_ID_1)],
          seatOverrides: [paid],
          payee: null,
        });

        await expect(
          assign(deps, [{ ticketTypeId: TT_ID_1, seatSectionId }]),
        ).rejects.toMatchObject({ code: "SEAT_SECTION_NOT_FOUND" });

        expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
        expect(mocks.audit.log).not.toHaveBeenCalled();
        expect(
          mocks.seats.listDistinctPriceOverridesByEvent,
        ).not.toHaveBeenCalled();
        expect(mocks.payees.getBySubject).not.toHaveBeenCalled();
      },
    );

    it("answers the same for another event's section and for no section at all", async () => {
      const refusal = async (seatSectionId: string) => {
        const { deps } = harness({ tiers: [freeFixedTier(TT_ID_1)] });
        const err = await assign(deps, [
          { ticketTypeId: TT_ID_1, seatSectionId },
        ]).catch((e: unknown) => e);
        const { code, message, meta } = err as {
          code?: string;
          message?: string;
          meta?: unknown;
        };
        return { code, message, meta };
      };

      const foreign = await refusal(FOREIGN_SECTION_ID);
      const missing = await refusal(MISSING_SECTION_ID);

      expect(foreign).toEqual({
        code: "SEAT_SECTION_NOT_FOUND",
        message: "SEAT_SECTION_NOT_FOUND",
        meta: undefined,
      });
      expect(missing).toEqual(foreign);
    });

    it("one foreign section among several assignments: nothing at all is written", async () => {
      const { deps, mocks } = harness({
        tiers: [freeFixedTier(TT_ID_1), freeFixedTier(TT_ID_2)],
        seatOverrides: [paid],
        payee: null,
      });

      // The valid assignment comes first, so a write-as-you-go loop would
      // have saved it before reaching the foreign one.
      await expect(
        assign(deps, [
          { ticketTypeId: TT_ID_1, seatSectionId: SECTION_ID_B },
          { ticketTypeId: TT_ID_2, seatSectionId: FOREIGN_SECTION_ID },
        ]),
      ).rejects.toMatchObject({ code: "SEAT_SECTION_NOT_FOUND" });

      expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
      expect(mocks.audit.log).not.toHaveBeenCalled();
      expect(
        mocks.seats.listDistinctPriceOverridesByEvent,
      ).not.toHaveBeenCalled();
    });

    it("a foreign section is refused even beside an unassign", async () => {
      const { deps, mocks } = harness({
        tiers: [
          freeFixedTier(TT_ID_1, { seatSectionId: SECTION_ID_A }),
          freeFixedTier(TT_ID_2),
        ],
      });

      await expect(
        assign(deps, [
          { ticketTypeId: TT_ID_1, seatSectionId: null },
          { ticketTypeId: TT_ID_2, seatSectionId: FOREIGN_SECTION_ID },
        ]),
      ).rejects.toMatchObject({ code: "SEAT_SECTION_NOT_FOUND" });
      expect(mocks.tickets.updateTicketType).not.toHaveBeenCalled();
    });

    it("writes a section of the same event, after ONE event-scoped section read", async () => {
      const { deps, mocks } = harness({
        tiers: [freeFixedTier(TT_ID_1), freeFixedTier(TT_ID_2)],
      });

      await expect(
        assign(deps, [
          { ticketTypeId: TT_ID_1, seatSectionId: SECTION_ID_A },
          { ticketTypeId: TT_ID_2, seatSectionId: SECTION_ID_B },
        ]),
      ).resolves.toMatchObject({ updated: 2 });

      expect(mocks.seats.listSectionsByEvent).toHaveBeenCalledTimes(1);
      expect(mocks.seats.listSectionsByEvent).toHaveBeenCalledWith(EVENT_ID);
      expect(mocks.tickets.updateTicketType).toHaveBeenCalledWith({
        id: TT_ID_1,
        seatSectionId: SECTION_ID_A,
      });
      expect(mocks.tickets.updateTicketType).toHaveBeenCalledWith({
        id: TT_ID_2,
        seatSectionId: SECTION_ID_B,
      });
    });

    it("writes an unassign without reading any section", async () => {
      const { deps, mocks } = harness({
        tiers: [freeFixedTier(TT_ID_1, { seatSectionId: SECTION_ID_A })],
      });

      await expect(
        assign(deps, [{ ticketTypeId: TT_ID_1, seatSectionId: null }]),
      ).resolves.toMatchObject({ updated: 1 });

      expect(mocks.seats.listSectionsByEvent).not.toHaveBeenCalled();
      expect(mocks.seats.getSectionById).not.toHaveBeenCalled();
      expect(mocks.tickets.updateTicketType).toHaveBeenCalledWith({
        id: TT_ID_1,
        seatSectionId: null,
      });
    });

    it("a missing ticket type is still reported as such, ahead of the section", async () => {
      const { deps } = harness({ tiers: [] });

      await expect(
        assign(deps, [
          { ticketTypeId: TT_ID_1, seatSectionId: FOREIGN_SECTION_ID },
        ]),
      ).rejects.toMatchObject({ code: "TICKET_TYPE_NOT_FOUND" });
    });
  });
});
