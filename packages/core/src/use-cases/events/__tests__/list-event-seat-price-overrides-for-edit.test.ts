import { describe, expect, it, vi } from "vitest";

import type { EventRecord, Repos, TxRepos } from "@th/ports/repos";
import type { SeatPriceOverrideEditRecord } from "@th/ports/repos/seats";

import { listEventSeatPriceOverridesForEdit } from "../list-event-seat-price-overrides-for-edit";
import { setSeatPriceOverrides } from "../set-seat-price-overrides";

// ─────────────────────────────────────────────────────────────────────────────
// The organizer's override editor read (seat-price-overrides spec FR-006,
// FR-008). Fakes, not a database: the subject is the authz gate, the shape,
// and that the read agrees with the write on every rule they share.
// ─────────────────────────────────────────────────────────────────────────────

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const ACTOR_ID = "00000000-0000-4000-8000-000000000003";
const OWNER_HUMAN_ID = "00000000-0000-4000-8000-000000000004";
const LAYOUT_ID = "00000000-0000-4000-8000-000000000005";
const SECTION_FIXED = "00000000-0000-4000-8000-0000000000a1";
const SECTION_ADJUSTABLE = "00000000-0000-4000-8000-0000000000a2";
const SECTION_MANUAL = "00000000-0000-4000-8000-0000000000a3";
const SEAT = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const NOW = new Date("2026-10-09T12:00:00Z");
const clock = { now: () => NOW };

const event = (overrides: Partial<EventRecord> = {}) =>
  ({
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    status: "PUBLISHED",
    placeLayoutId: LAYOUT_ID,
    ...overrides,
  }) as EventRecord;

const tier = (overrides: Record<string, unknown>) => ({
  id: "tier-fixed",
  name: "Orchestra",
  description: null,
  priceCents: 3000,
  pricingMode: "FIXED",
  minimumCents: null,
  suggestedCents: null,
  capacity: 100,
  status: "ACTIVE",
  seatSectionId: SECTION_FIXED,
  resaleAllowed: false,
  resaleCapCents: null,
  transferAllowed: true,
  scheduledPriceCents: null,
  scheduledPriceAt: null,
  salesOpenAt: null,
  salesCloseAt: null,
  ...overrides,
});

const sections = [
  {
    id: SECTION_FIXED,
    name: "Orchestra",
    type: "RESERVED",
    capacity: 10,
    layoutSectionId: "ORCH",
    placeLayoutId: LAYOUT_ID,
  },
  {
    id: SECTION_ADJUSTABLE,
    name: "Balcony",
    type: "RESERVED",
    capacity: 10,
    layoutSectionId: "BAL",
    placeLayoutId: LAYOUT_ID,
  },
  {
    id: SECTION_MANUAL,
    name: "Standing",
    type: "GA",
    capacity: 50,
    layoutSectionId: null,
    placeLayoutId: null,
  },
];

const seat = (
  overrides: Partial<SeatPriceOverrideEditRecord> & { id: string },
): SeatPriceOverrideEditRecord => ({
  seatSectionId: SECTION_FIXED,
  status: "AVAILABLE",
  label: "A1",
  row: "A",
  number: 1,
  priceOverride: null,
  ...overrides,
});

/**
 * Layout ids as the CSV parser builds them (`<section>-<row>-<seat>`). Note
 * `ORCH-A-01` (zero-padded: materialised as row A, number 1, label "A1") and
 * `ORCH-BOX` (no row/number: label is the raw id).
 */
const LAYOUT_SEAT_IDS = ["ORCH-A-01", "ORCH-A-2", "ORCH-BOX", "BAL-B-1"];

function makeRepos(
  opts: {
    event?: EventRecord | null;
    role?: string | null;
    delegationRole?: string | null;
    seats?: SeatPriceOverrideEditRecord[];
    tiers?: ReturnType<typeof tier>[];
    layout?: () => Promise<unknown>;
    /** Connect state of the organizing org's payee. Default: linked. */
    payee?: "linked" | "placeholder" | "none";
    /** Whether a fee policy resolves at some scope. Default: yes. */
    feePolicy?: boolean;
  } = {},
) {
  const events = {
    getById: vi.fn(async () =>
      opts.event === undefined ? event() : opts.event,
    ),
    listTicketTypes: vi.fn(async () =>
      opts.tiers ?? [
        tier({}),
        tier({
          id: "tier-pwyw",
          name: "Balcony PWYW",
          pricingMode: "ADJUSTABLE",
          minimumCents: 500,
          seatSectionId: SECTION_ADJUSTABLE,
        }),
      ],
    ),
  };
  const seats = {
    listSectionsByEvent: vi.fn(async () => sections),
    listPriceOverridesByEvent: vi.fn(async () =>
      opts.seats ?? [
        seat({
          id: SEAT(1),
          priceOverride: { priceCents: 5000, reason: "piano side" },
        }),
        seat({ id: SEAT(2), label: "A2", number: 2 }),
        seat({ id: SEAT(3), label: "ORCH-BOX", row: null, number: null }),
        seat({ id: SEAT(4), label: "Z9", row: "Z", number: 9 }),
        seat({
          id: SEAT(5),
          seatSectionId: SECTION_ADJUSTABLE,
          label: "B1",
          row: "B",
          number: 1,
        }),
        seat({
          id: SEAT(6),
          seatSectionId: SECTION_MANUAL,
          label: "GA-1",
          row: null,
          number: null,
        }),
      ],
    ),
    lockSeatsForPriceOverrideWrite: vi.fn(
      async ({ seatIds }: { seatIds: string[] }) =>
        seatIds.map((id) => ({
          id,
          seatSectionId: id === SEAT(5) ? SECTION_ADJUSTABLE : SECTION_FIXED,
          status: "AVAILABLE",
          busy: false,
        })),
    ),
    updatePriceOverrides: vi.fn(async ({ seatIds }: { seatIds: string[] }) =>
      seatIds.length,
    ),
  };
  const placeLayouts = {
    getById: vi.fn(
      opts.layout ?? (async () => ({ id: LAYOUT_ID, seatIds: LAYOUT_SEAT_IDS })),
    ),
  };
  const authz = {
    getOrgMembership: vi.fn(async () =>
      opts.role === null ? null : { role: opts.role ?? "EDITOR" },
    ),
    getHumanDelegation: vi.fn(async () =>
      opts.delegationRole ? { role: opts.delegationRole } : null,
    ),
  };
  const audit = { log: vi.fn() };
  const payeeState = opts.payee ?? "linked";
  const payees = {
    getBySubject: vi.fn(async () =>
      payeeState === "none" ? null : { id: "payee-1" },
    ),
    getById: vi.fn(async () => ({
      id: "payee-1",
      stripeAccountId: payeeState === "linked" ? "acct_123" : null,
    })),
  };
  const feePolicies = {
    resolveEffective: vi.fn(async () =>
      opts.feePolicy === false ? null : { id: "policy-1" },
    ),
  };
  const tx = {
    events,
    seats,
    authz,
    audit,
    payees,
    feePolicies,
  } as unknown as TxRepos;
  const repos = {
    tx: async <T>(fn: (t: TxRepos) => Promise<T>) => fn(tx),
    events,
    seats,
    placeLayouts,
    authz,
    audit,
    payees,
    feePolicies,
  } as unknown as Repos;
  return { repos, events, seats, placeLayouts, authz, payees, feePolicies };
}

const read = (
  repos: Repos,
  reportError?: (...args: unknown[]) => void,
  actorHumanId = ACTOR_ID,
) =>
  listEventSeatPriceOverridesForEdit(
    { repos, clock, reportError },
    { eventId: EVENT_ID, actorHumanId },
  );

// ─────────────────────────────────────────────────────────────────────────────
// Authz: the write's gate, byte for byte
// ─────────────────────────────────────────────────────────────────────────────

describe("listEventSeatPriceOverridesForEdit — authz", () => {
  it("refuses a caller with no membership in the organizing org (another org, a buyer), before any seat is read", async () => {
    const { repos, seats } = makeRepos({ role: null });
    await expect(read(repos)).rejects.toMatchObject({
      code: "INSUFFICIENT_ROLE",
    });
    expect(seats.listPriceOverridesByEvent).not.toHaveBeenCalled();
    expect(seats.listSectionsByEvent).not.toHaveBeenCalled();
  });

  it.each(["VIEWER", "FINANCE", "SCANNER"])(
    "refuses a %s of the organizing org (not an edit role)",
    async (role) => {
      const { repos, seats } = makeRepos({ role });
      await expect(read(repos)).rejects.toMatchObject({
        code: "INSUFFICIENT_ROLE",
      });
      expect(seats.listPriceOverridesByEvent).not.toHaveBeenCalled();
    },
  );

  it("refuses exactly as the write does, code for code", async () => {
    for (const opts of [
      { role: null },
      { role: "VIEWER" },
      { event: null },
      { event: event({ orgId: null, humanId: OWNER_HUMAN_ID }), role: null },
      { event: event({ orgId: null, humanId: null }), role: null },
    ]) {
      const { repos } = makeRepos(opts);
      const readErr = await read(repos).catch((e: unknown) => e);
      const writeErr = await setSeatPriceOverrides(
        { repos, clock },
        {
          eventId: EVENT_ID,
          actorHumanId: ACTOR_ID,
          seatIds: [SEAT(1)],
          priceOverride: null,
        },
      ).catch((e: unknown) => e);
      expect(readErr).toMatchObject({
        code: (writeErr as { code: string }).code,
      });
    }
  });

  it("checks the role on the EVENT's org, with the session actor", async () => {
    const { repos, authz } = makeRepos();
    await read(repos);
    expect(authz.getOrgMembership).toHaveBeenCalledWith({
      orgId: ORG_ID,
      humanId: ACTOR_ID,
    });
  });

  it("a person-owned event admits an edit-role delegate and refuses a stranger", async () => {
    const personEvent = event({ orgId: null, humanId: OWNER_HUMAN_ID });
    await expect(
      read(makeRepos({ event: personEvent }).repos),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    await expect(
      read(makeRepos({ event: personEvent, delegationRole: "EDITOR" }).repos),
    ).resolves.toMatchObject({ eventId: EVENT_ID });
  });

  it("missing event is EVENT_NOT_FOUND", async () => {
    await expect(
      read(makeRepos({ event: null }).repos),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it.each(["DRAFT", "PUBLISHED", "CANCELLED"] as const)(
    "reads a %s event (no on-sale gate); `editable` follows the write",
    async (status) => {
      const out = await read(makeRepos({ event: event({ status }) }).repos);
      expect(out.sections).toHaveLength(3);
      expect(out.editable).toBe(status !== "CANCELLED");
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Shape
// ─────────────────────────────────────────────────────────────────────────────

describe("listEventSeatPriceOverridesForEdit — shape", () => {
  it("returns the private reason with the override", async () => {
    const out = await read(makeRepos().repos);
    const a1 = out.sections[0]!.seats.find((s) => s.id === SEAT(1))!;
    expect(a1.priceOverride).toEqual({ priceCents: 5000, reason: "piano side" });
    expect(a1.overrideInvalid).toBe(false);
    const a2 = out.sections[0]!.seats.find((s) => s.id === SEAT(2))!;
    expect(a2.priceOverride).toBeNull();
  });

  it("a $0 override is a free seat, not 'no override'", async () => {
    const out = await read(
      makeRepos({
        seats: [seat({ id: SEAT(1), priceOverride: { priceCents: 0 } })],
      }).repos,
    );
    expect(out.sections[0]!.seats[0]!.priceOverride).toEqual({
      priceCents: 0,
      reason: null,
    });
  });

  it("maps each seat to the glyph it was materialised from", async () => {
    const out = await read(makeRepos().repos);
    const keys = Object.fromEntries(
      out.sections.flatMap((s) => s.seats.map((x) => [x.id, x.glyphKey])),
    );
    expect(keys).toEqual({
      // Zero-padded seat: NOT rebuildable as `ORCH-A-1`; the replay finds it.
      [SEAT(1)]: "ORCH-A-01",
      [SEAT(2)]: "ORCH-A-2",
      // No row/number: the label IS the glyph id.
      [SEAT(3)]: "ORCH-BOX",
      // No glyph of the layout derives "Z9".
      [SEAT(4)]: null,
      [SEAT(5)]: "BAL-B-1",
      // Manually created section: no layout, no glyphs.
      [SEAT(6)]: null,
    });
  });

  it("reads each layout once, however many sections share it", async () => {
    const { repos, placeLayouts } = makeRepos();
    await read(repos);
    expect(placeLayouts.getById).toHaveBeenCalledTimes(1);
    expect(placeLayouts.getById).toHaveBeenCalledWith(LAYOUT_ID);
  });

  it("returns every section field and the tiers an override replaces", async () => {
    const out = await read(makeRepos().repos);
    expect(out.sections.map((s) => s.seatSectionId)).toEqual([
      SECTION_FIXED,
      SECTION_ADJUSTABLE,
      SECTION_MANUAL,
    ]);
    expect(out.sections[0]).toMatchObject({
      name: "Orchestra",
      type: "RESERVED",
      layoutSectionId: "ORCH",
      placeLayoutId: LAYOUT_ID,
      tiers: [
        {
          id: "tier-fixed",
          name: "Orchestra",
          pricingMode: "FIXED",
          status: "ACTIVE",
          currentPriceCents: 3000,
          upcomingPriceChange: null,
        },
      ],
    });
    // ADJUSTABLE: the buyer names the price.
    expect(out.sections[1]!.tiers[0]!.currentPriceCents).toBeNull();
    expect(out.sections[2]).toMatchObject({
      layoutSectionId: null,
      placeLayoutId: null,
      tiers: [],
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FR-006: the refused-section flag agrees with the write
// ─────────────────────────────────────────────────────────────────────────────

describe("listEventSeatPriceOverridesForEdit — refusal agrees with setSeatPriceOverrides", () => {
  const writeOne = (repos: Repos, seatId: string) =>
    setSeatPriceOverrides(
      { repos, clock },
      {
        eventId: EVENT_ID,
        actorHumanId: ACTOR_ID,
        seatIds: [seatId],
        // $0: the paid-seat gates (Stripe, fee policy) are not the subject.
        priceOverride: { priceCents: 0 },
      },
    );

  it("FIXED section: open in the read, written by the write", async () => {
    const { repos } = makeRepos();
    const out = await read(repos);
    expect(out.sections[0]!.overrideRefusal).toBeNull();
    await expect(writeOne(repos, SEAT(1))).resolves.toMatchObject({
      updated: 1,
    });
  });

  it("ADJUSTABLE section: ADJUSTABLE_TIER in the read, refused by the write", async () => {
    const { repos } = makeRepos();
    const out = await read(repos);
    expect(out.sections[1]!.overrideRefusal).toBe("ADJUSTABLE_TIER");
    await expect(writeOne(repos, SEAT(5))).rejects.toMatchObject({
      code: "SEAT_PRICE_OVERRIDE_ADJUSTABLE_TIER",
    });
  });

  it("FIXED and ADJUSTABLE tiers sharing a section: ADJUSTABLE_TIER in both (the FIXED tier does not win)", async () => {
    const { repos } = makeRepos({
      tiers: [
        tier({}),
        tier({ id: "tier-pwyw-shared", pricingMode: "ADJUSTABLE" }),
      ],
    });
    const out = await read(repos);
    expect(out.sections[0]!.overrideRefusal).toBe("ADJUSTABLE_TIER");
    expect(out.sections[0]!.tiers.map((t) => t.id)).toEqual([
      "tier-fixed",
      "tier-pwyw-shared",
    ]);
    await expect(writeOne(repos, SEAT(1))).rejects.toMatchObject({
      code: "SEAT_PRICE_OVERRIDE_ADJUSTABLE_TIER",
    });
  });

  it("PUBLISHED event, only a DRAFT tier: NO_FIXED_TIER in both", async () => {
    const { repos } = makeRepos({ tiers: [tier({ status: "DRAFT" })] });
    const out = await read(repos);
    expect(out.sections[0]!.overrideRefusal).toBe("NO_FIXED_TIER");
    expect(out.sections[0]!.tiers).toEqual([]);
    await expect(writeOne(repos, SEAT(1))).rejects.toMatchObject({
      code: "SEAT_PRICE_OVERRIDE_NO_FIXED_TIER",
    });
  });

  it("DRAFT event: the same DRAFT tier counts, in both", async () => {
    const { repos } = makeRepos({
      event: event({ status: "DRAFT" }),
      tiers: [tier({ status: "DRAFT" })],
    });
    const out = await read(repos);
    expect(out.sections[0]!.overrideRefusal).toBeNull();
    expect(out.sections[0]!.tiers.map((t) => t.status)).toEqual(["DRAFT"]);
    await expect(writeOne(repos, SEAT(1))).resolves.toMatchObject({
      updated: 1,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FR-008: a pending schedule flip overrides will not follow
// ─────────────────────────────────────────────────────────────────────────────

describe("listEventSeatPriceOverridesForEdit — pending schedule (FR-008)", () => {
  it("flags a FIXED tier whose flip is still ahead, and names it", async () => {
    const at = new Date("2026-10-20T00:00:00Z");
    const out = await read(
      makeRepos({
        tiers: [tier({ scheduledPriceCents: 4500, scheduledPriceAt: at })],
      }).repos,
    );
    expect(out.sections[0]!.hasPendingScheduledPriceChange).toBe(true);
    expect(out.sections[0]!.tiers[0]).toMatchObject({
      currentPriceCents: 3000,
      upcomingPriceChange: { toPriceCents: 4500, at },
    });
  });

  it("a flip already past is not pending, and the current price is the flipped one", async () => {
    const out = await read(
      makeRepos({
        tiers: [
          tier({
            scheduledPriceCents: 4500,
            scheduledPriceAt: new Date("2026-10-01T00:00:00Z"),
          }),
        ],
      }).repos,
    );
    expect(out.sections[0]!.hasPendingScheduledPriceChange).toBe(false);
    expect(out.sections[0]!.tiers[0]!.currentPriceCents).toBe(4500);
  });

  it("no schedule: not pending", async () => {
    const out = await read(makeRepos().repos);
    expect(out.sections.map((s) => s.hasPendingScheduledPriceChange)).toEqual([
      false,
      false,
      false,
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Corrupt data never 500s the editor; it is flagged and reported
// ─────────────────────────────────────────────────────────────────────────────

describe("listEventSeatPriceOverridesForEdit — corrupt overrides", () => {
  const corruptSeats = () => [
    seat({ id: SEAT(1), priceOverride: { invalid: true } }),
    seat({ id: SEAT(2), label: "A2", priceOverride: { priceCents: -100 } }),
    seat({ id: SEAT(3), label: "A3", priceOverride: { priceCents: 12.5 } }),
    seat({ id: SEAT(4), label: "A4", priceOverride: { priceCents: 700 } }),
  ];

  it("flags each seat checkout would refuse and reports them once", async () => {
    const reportError = vi.fn();
    const out = await read(
      makeRepos({ seats: corruptSeats() }).repos,
      reportError,
    );
    const bySeat = Object.fromEntries(
      out.sections[0]!.seats.map((s) => [
        s.id,
        [s.priceOverride, s.overrideInvalid],
      ]),
    );
    expect(bySeat).toEqual({
      [SEAT(1)]: [null, true],
      [SEAT(2)]: [null, true],
      [SEAT(3)]: [null, true],
      [SEAT(4)]: [{ priceCents: 700, reason: null }, false],
    });
    expect(reportError).toHaveBeenCalledTimes(1);
    const [err, context] = reportError.mock.calls[0]!;
    expect(err).toMatchObject({
      code: "INTERNAL",
      message: "seat_price_override_invalid",
    });
    expect(context).toMatchObject({
      tags: { useCase: "listEventSeatPriceOverridesForEdit" },
      extra: {
        eventId: EVENT_ID,
        invalidCount: 3,
        seatIds: [SEAT(1), SEAT(2), SEAT(3)],
      },
    });
  });

  it("a throwing reporter does not change the result", async () => {
    const out = await read(makeRepos({ seats: corruptSeats() }).repos, () => {
      throw new Error("sentry down");
    });
    expect(out.sections[0]!.seats.filter((s) => s.overrideInvalid)).toHaveLength(
      3,
    );
  });

  it("no corrupt rows, no report", async () => {
    const reportError = vi.fn();
    await read(makeRepos().repos, reportError);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("an unreadable layout is reported and leaves glyph keys null; the editor still opens", async () => {
    const reportError = vi.fn();
    const out = await read(
      makeRepos({
        layout: async () => {
          throw new Error("place_layout_metadata_invalid");
        },
      }).repos,
      reportError,
    );
    expect(
      out.sections.flatMap((s) => s.seats.map((x) => x.glyphKey)),
    ).toEqual([null, null, null, null, null, null]);
    expect(out.sections[0]!.seats[0]!.priceOverride).toEqual({
      priceCents: 5000,
      reason: "piano side",
    });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      extra: { eventId: EVENT_ID, placeLayoutId: LAYOUT_ID },
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WRITE RULES 4: a paid price on a FREE tier, read vs the real write
// ─────────────────────────────────────────────────────────────────────────────

describe("listEventSeatPriceOverridesForEdit — paidOverrideBlockedBy agrees with setSeatPriceOverrides", () => {
  const FREE = [tier({ priceCents: 0 })];
  const PAID = [tier({})];

  /** What the real write does with a $price override on SEAT(1). */
  const writeOutcome = async (repos: Repos, priceCents: number) => {
    try {
      await setSeatPriceOverrides(
        { repos, clock },
        {
          eventId: EVENT_ID,
          actorHumanId: ACTOR_ID,
          seatIds: [SEAT(1)],
          priceOverride: { priceCents },
        },
      );
      return null;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "PAID_TICKETING_REQUIRES_STRIPE") return "STRIPE";
      if (code === "PAID_TICKETING_REQUIRES_FEE_POLICY") return "FEE_POLICY";
      throw err;
    }
  };

  it.each([
    ["free tier, no payee", "STRIPE", { tiers: FREE, payee: "none" }],
    [
      "free tier, placeholder payee (no Connect account)",
      "STRIPE",
      { tiers: FREE, payee: "placeholder" },
    ],
    [
      "free tier, no payee AND no fee policy (Stripe first)",
      "STRIPE",
      { tiers: FREE, payee: "none", feePolicy: false },
    ],
    [
      "free tier, Connect linked, no fee policy",
      "FEE_POLICY",
      { tiers: FREE, feePolicy: false },
    ],
    ["free tier, Connect linked, fee policy resolves", null, { tiers: FREE }],
    [
      "paid tier, nothing linked (no free→paid flip, no gate)",
      null,
      { tiers: PAID, payee: "none", feePolicy: false },
    ],
    [
      "free and paid tier in one section, no payee (the free one gates)",
      "STRIPE",
      { tiers: [tier({ priceCents: 0 }), tier({})], payee: "none" },
    ],
    [
      "DRAFT event, free DRAFT tier, no payee (a draft's tiers all count)",
      "STRIPE",
      {
        event: event({ status: "DRAFT" }),
        tiers: [tier({ priceCents: 0, status: "DRAFT" })],
        payee: "none",
      },
    ],
    [
      "PUBLISHED event, paid ACTIVE + free DRAFT tier, no payee (the DRAFT one does not count)",
      null,
      {
        tiers: [tier({}), tier({ priceCents: 0, status: "DRAFT" })],
        payee: "none",
      },
    ],
  ] as const)("%s → %s, as the write refuses $50", async (_name, expected, opts) => {
    const { repos } = makeRepos({ ...opts, tiers: [...opts.tiers] });
    const out = await read(repos);
    expect(out.sections[0]!.paidOverrideBlockedBy).toBe(expected);
    await expect(writeOutcome(repos, 5000)).resolves.toBe(expected);
  });

  it("a blocked section still takes a $0 override (the gate is for paid prices only)", async () => {
    const { repos } = makeRepos({ tiers: FREE, payee: "none" });
    expect((await read(repos)).sections[0]!.paidOverrideBlockedBy).toBe(
      "STRIPE",
    );
    await expect(writeOutcome(repos, 0)).resolves.toBeNull();
  });

  it("is null where the section rule already refuses (ADJUSTABLE, no FIXED tier)", async () => {
    const out = await read(
      makeRepos({
        tiers: [
          tier({ priceCents: 0 }),
          tier({
            id: "tier-pwyw",
            pricingMode: "ADJUSTABLE",
            priceCents: 0,
            seatSectionId: SECTION_ADJUSTABLE,
          }),
        ],
        payee: "none",
      }).repos,
    );
    expect(out.sections.map((s) => [s.overrideRefusal, s.paidOverrideBlockedBy])).toEqual([
      [null, "STRIPE"],
      ["ADJUSTABLE_TIER", null],
      ["NO_FIXED_TIER", null],
    ]);
  });

  it("checks Connect and the fee policy once per read, and not at all with no free tier", async () => {
    const free = makeRepos({
      tiers: [
        tier({ priceCents: 0 }),
        tier({ id: "tier-free-2", priceCents: 0, seatSectionId: SECTION_ADJUSTABLE }),
      ],
    });
    await read(free.repos);
    expect(free.payees.getBySubject).toHaveBeenCalledTimes(1);
    expect(free.feePolicies.resolveEffective).toHaveBeenCalledTimes(1);

    const paid = makeRepos();
    await read(paid.repos);
    expect(paid.payees.getBySubject).not.toHaveBeenCalled();
    expect(paid.feePolicies.resolveEffective).not.toHaveBeenCalled();
  });
  // An outage is not a refusal: reading "db down" as "no Connect account"
  // would tell the organizer to go link Stripe. The read fails instead, and
  // the backstops (and the fee-policy walk's own report) capture it.
  it("a payee read outage throws the outage, never a STRIPE block", async () => {
    const outage = new Error("db down");
    const { repos, payees } = makeRepos({ tiers: FREE });
    payees.getBySubject.mockRejectedValue(outage);
    await expect(read(repos)).rejects.toBe(outage);
  });

  it("a fee-policy read outage throws the outage, never a FEE_POLICY block, and the walk reports it", async () => {
    const outage = new Error("db down");
    const reportError = vi.fn();
    const { repos, feePolicies } = makeRepos({ tiers: FREE });
    feePolicies.resolveEffective.mockRejectedValue(outage);
    await expect(read(repos, reportError)).rejects.toBe(outage);
    expect(reportError).toHaveBeenCalledWith(
      outage,
      expect.objectContaining({
        tags: expect.objectContaining({
          resolver: "resolveScopedFeePolicy",
          source: "listEventSeatPriceOverridesForEdit",
        }),
      }),
    );
  });
});
