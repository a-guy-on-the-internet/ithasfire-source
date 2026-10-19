/**
 * The write-boundary rules of `setSeatPriceOverrides`
 * (docs/specs/2026-08-12/seat-price-overrides.spec.yaml FR-006, D-004):
 *
 *   - SOLD and HELD seats are skipped and counted, seats another transaction
 *     holds right now are counted `busy`, and none of them is written;
 *   - on the seats being WRITTEN, a section with an ADJUSTABLE tier, or with
 *     no FIXED tier, refuses a SET (never a clear); which tiers count depends
 *     on the event (PUBLISHED: ACTIVE only; DRAFT: every tier);
 *   - `priceCents` is capped at the INT4 ceiling a tier price has;
 *   - a paid override on a section with a free FIXED tier passes the same
 *     free→paid gates as `updateTicketType` (Stripe account, then fee policy).
 *
 * Mocked repos. Tier fixtures use only the statuses the events port emits
 * ("ACTIVE" | "DRAFT"; INACTIVE and ARCHIVED rows both read "DRAFT"). The SQL
 * half (the UPDATE's status predicate, the non-waiting lock) is pinned in
 * packages/adapters/src/db/prisma/__tests__/seats-price-overrides*.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EventRecord, Repos, TxRepos } from "@th/ports/repos";
import type { SeatPriceOverrideLock } from "@th/ports/repos/seats";
import type { EventTicketTypeSummary } from "@th/types";

import {
  MAX_SEAT_PRICE_OVERRIDE_CENTS,
  setSeatPriceOverrides,
} from "../set-seat-price-overrides";

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const ORG_ID = "00000000-0000-4000-8000-000000000002";
const HUMAN_ID = "00000000-0000-4000-8000-000000000003";
const SECTION_A = "00000000-0000-4000-8000-0000000000a1";
const SECTION_B = "00000000-0000-4000-8000-0000000000b1";
const SEAT_1 = "00000000-0000-4000-8000-000000000011";
const SEAT_2 = "00000000-0000-4000-8000-000000000012";
const SEAT_3 = "00000000-0000-4000-8000-000000000013";
const SEAT_4 = "00000000-0000-4000-8000-000000000014";
const SEAT_5 = "00000000-0000-4000-8000-000000000015";
const SEAT_GONE = "00000000-0000-4000-8000-000000000019";
const PAYEE_ID = "00000000-0000-4000-8000-000000000040";

const clock = { now: () => new Date("2026-10-08T12:00:00Z") };

function seat(
  id: string,
  status: SeatPriceOverrideLock["status"] = "AVAILABLE",
  sectionId = SECTION_A,
  busy = false,
): SeatPriceOverrideLock {
  return { id, seatSectionId: sectionId, status, busy };
}

type Tier = Pick<
  EventTicketTypeSummary,
  | "id"
  | "status"
  | "seatSectionId"
  | "pricingMode"
  | "priceCents"
  | "minimumCents"
  | "scheduledPriceCents"
  | "scheduledPriceAt"
>;

let tierSeq = 0;
function tier(over: Partial<Tier> = {}): Tier {
  tierSeq += 1;
  return {
    id: `00000000-0000-4000-8000-0000000003${String(tierSeq).padStart(2, "0")}`,
    status: "ACTIVE",
    seatSectionId: SECTION_A,
    pricingMode: "FIXED",
    priceCents: 3000,
    minimumCents: null,
    scheduledPriceCents: null,
    scheduledPriceAt: null,
    ...over,
  };
}

function harness(opts: {
  seats: SeatPriceOverrideLock[];
  tiers: Tier[];
  eventStatus?: "DRAFT" | "PUBLISHED";
  payee?: { stripeAccountId: string | null } | null;
  feePolicy?: boolean | Error;
}) {
  const event = {
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    status: opts.eventStatus ?? "PUBLISHED",
  } as unknown as EventRecord;
  const payee =
    opts.payee === undefined ? { stripeAccountId: "acct_1" } : opts.payee;
  const mocks = {
    events: {
      getById: vi.fn(async () => event),
      listTicketTypes: vi.fn(async () => opts.tiers),
    },
    seats: {
      lockSeatsForPriceOverrideWrite: vi.fn(
        async ({ seatIds }: { seatIds: string[] }) =>
          opts.seats.filter((s) => seatIds.includes(s.id)),
      ),
      updatePriceOverrides: vi.fn(
        async ({ seatIds }: { seatIds: string[] }) => seatIds.length,
      ),
    },
    authz: {
      getOrgMembership: vi.fn(async () => ({
        orgId: ORG_ID,
        humanId: HUMAN_ID,
        role: "ADMIN",
      })),
      getHumanDelegation: vi.fn(async () => null),
    },
    payees: {
      getBySubject: vi.fn(async () => (payee ? { id: PAYEE_ID } : null)),
      getById: vi.fn(async () =>
        payee ? { id: PAYEE_ID, stripeAccountId: payee.stripeAccountId } : null,
      ),
    },
    feePolicies: {
      resolveEffective: vi.fn(async () => {
        if (opts.feePolicy instanceof Error) throw opts.feePolicy;
        return opts.feePolicy === false ? null : { id: "fp-1" };
      }),
    },
    audit: { log: vi.fn() },
  };
  const tx = mocks as unknown as TxRepos;
  const repos = {
    ...mocks,
    tx: async <T>(fn: (t: TxRepos) => Promise<T>) => fn(tx),
  } as unknown as Repos;
  return { repos, mocks };
}

function run(
  repos: Repos,
  seatIds: string[],
  priceOverride: { priceCents: number; reason?: string } | null,
  reportError?: (err: unknown, ctx?: unknown) => void,
) {
  return setSeatPriceOverrides(
    { repos, clock, reportError },
    { actorHumanId: HUMAN_ID, eventId: EVENT_ID, seatIds, priceOverride },
  );
}

beforeEach(() => {
  tierSeq = 0;
});

describe("setSeatPriceOverrides — section tier rule (FR-006)", () => {
  it("refuses a section sold only through a pay-what-you-want tier", async () => {
    const adjustable = tier({
      pricingMode: "ADJUSTABLE",
      priceCents: 0,
      minimumCents: 500,
    });
    const { repos, mocks } = harness({
      seats: [seat(SEAT_1)],
      tiers: [adjustable],
    });

    await expect(
      run(repos, [SEAT_1], { priceCents: 5000 }),
    ).rejects.toMatchObject({
      code: "SEAT_PRICE_OVERRIDE_ADJUSTABLE_TIER",
      meta: { seatSectionIds: [SECTION_A], ticketTypeIds: [adjustable.id] },
    });
    expect(mocks.seats.updatePriceOverrides).not.toHaveBeenCalled();
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });

  it("refuses a section with a FIXED tier AND a pay-what-you-want tier", async () => {
    const { repos, mocks } = harness({
      seats: [seat(SEAT_1)],
      tiers: [tier(), tier({ pricingMode: "ADJUSTABLE", priceCents: 0 })],
    });

    await expect(
      run(repos, [SEAT_1], { priceCents: 5000 }),
    ).rejects.toMatchObject({
      code: "SEAT_PRICE_OVERRIDE_ADJUSTABLE_TIER",
    });
    expect(mocks.seats.updatePriceOverrides).not.toHaveBeenCalled();
  });

  it("refuses the whole write when ONE written section is pay-what-you-want", async () => {
    const { repos, mocks } = harness({
      seats: [seat(SEAT_1), seat(SEAT_2, "AVAILABLE", SECTION_B)],
      tiers: [
        tier(),
        tier({
          seatSectionId: SECTION_B,
          pricingMode: "ADJUSTABLE",
          priceCents: 0,
        }),
      ],
    });

    await expect(
      run(repos, [SEAT_1, SEAT_2], { priceCents: 5000 }),
    ).rejects.toMatchObject({
      code: "SEAT_PRICE_OVERRIDE_ADJUSTABLE_TIER",
      meta: { seatSectionIds: [SECTION_B] },
    });
    expect(mocks.seats.updatePriceOverrides).not.toHaveBeenCalled();
  });

  it("judges only the seats being written: a SOLD or busy seat in a pay-what-you-want section does not refuse", async () => {
    const { repos, mocks } = harness({
      seats: [
        seat(SEAT_1),
        seat(SEAT_2, "SOLD", SECTION_B),
        seat(SEAT_3, "AVAILABLE", SECTION_B, true),
      ],
      tiers: [
        tier(),
        tier({
          seatSectionId: SECTION_B,
          pricingMode: "ADJUSTABLE",
          priceCents: 0,
        }),
      ],
    });

    const result = await run(repos, [SEAT_1, SEAT_2, SEAT_3], {
      priceCents: 5000,
    });

    expect(result.updated).toBe(1);
    expect(result.skipped).toEqual({
      sold: 1,
      held: 0,
      busy: 1,
      notFound: 0,
    });
    expect(mocks.seats.updatePriceOverrides).toHaveBeenCalledWith(
      expect.objectContaining({ seatIds: [SEAT_1] }),
    );
  });

  it("PUBLISHED event: refuses a section with no ACTIVE FIXED tier (none, only a DRAFT one, or one on another section)", async () => {
    for (const tiers of [
      [],
      [tier({ status: "DRAFT" })],
      [tier({ seatSectionId: SECTION_B })],
    ]) {
      const { repos, mocks } = harness({ seats: [seat(SEAT_1)], tiers });
      await expect(
        run(repos, [SEAT_1], { priceCents: 5000 }),
      ).rejects.toMatchObject({
        code: "SEAT_PRICE_OVERRIDE_NO_FIXED_TIER",
        meta: { seatSectionIds: [SECTION_A] },
      });
      expect(mocks.seats.updatePriceOverrides).not.toHaveBeenCalled();
    }
  });

  it("PUBLISHED event: a DRAFT (unsold) pay-what-you-want tier does not block an ACTIVE FIXED section", async () => {
    const { repos } = harness({
      seats: [seat(SEAT_1)],
      tiers: [
        tier(),
        tier({ pricingMode: "ADJUSTABLE", priceCents: 0, status: "DRAFT" }),
      ],
    });
    await expect(
      run(repos, [SEAT_1], { priceCents: 5000 }),
    ).resolves.toMatchObject({
      updated: 1,
    });
  });

  it("DRAFT event: a DRAFT FIXED tier (every tier reads DRAFT before publish) allows the override", async () => {
    const { repos, mocks } = harness({
      eventStatus: "DRAFT",
      seats: [seat(SEAT_1)],
      tiers: [tier({ status: "DRAFT" })],
    });

    await expect(
      run(repos, [SEAT_1], { priceCents: 5000 }),
    ).resolves.toMatchObject({ updated: 1 });
    expect(mocks.seats.updatePriceOverrides).toHaveBeenCalledWith(
      expect.objectContaining({ seatIds: [SEAT_1] }),
    );
  });

  it("DRAFT event: a DRAFT pay-what-you-want tier refuses, since publish activates it", async () => {
    for (const tiers of [
      [tier({ status: "DRAFT", pricingMode: "ADJUSTABLE", priceCents: 0 })],
      [
        tier({ status: "DRAFT" }),
        tier({ status: "DRAFT", pricingMode: "ADJUSTABLE", priceCents: 0 }),
      ],
    ]) {
      const { repos, mocks } = harness({
        eventStatus: "DRAFT",
        seats: [seat(SEAT_1)],
        tiers,
      });
      await expect(
        run(repos, [SEAT_1], { priceCents: 5000 }),
      ).rejects.toMatchObject({ code: "SEAT_PRICE_OVERRIDE_ADJUSTABLE_TIER" });
      expect(mocks.seats.updatePriceOverrides).not.toHaveBeenCalled();
    }
  });

  it("DRAFT event: a section with no tier at all still refuses", async () => {
    const { repos } = harness({
      eventStatus: "DRAFT",
      seats: [seat(SEAT_1)],
      tiers: [tier({ status: "DRAFT", seatSectionId: SECTION_B })],
    });
    await expect(
      run(repos, [SEAT_1], { priceCents: 5000 }),
    ).rejects.toMatchObject({ code: "SEAT_PRICE_OVERRIDE_NO_FIXED_TIER" });
  });

  it("allows a FIXED-only section and writes the override", async () => {
    const { repos, mocks } = harness({
      seats: [seat(SEAT_1), seat(SEAT_2)],
      tiers: [tier()],
    });

    const result = await run(repos, [SEAT_1, SEAT_2], {
      priceCents: 5000,
      reason: "piano side",
    });

    expect(result).toEqual({
      eventId: EVENT_ID,
      updated: 2,
      skipped: { sold: 0, held: 0, busy: 0, notFound: 0 },
    });
    expect(mocks.seats.updatePriceOverrides).toHaveBeenCalledWith({
      seatIds: [SEAT_1, SEAT_2],
      eventId: EVENT_ID,
      priceOverride: { priceCents: 5000, reason: "piano side" },
    });
  });

  it("CLEARING is always allowed, even on a pay-what-you-want or tierless section", async () => {
    for (const tiers of [
      [tier({ pricingMode: "ADJUSTABLE", priceCents: 0 })],
      [],
    ]) {
      const { repos, mocks } = harness({ seats: [seat(SEAT_1)], tiers });
      await expect(run(repos, [SEAT_1], null)).resolves.toMatchObject({
        updated: 1,
      });
      expect(mocks.seats.updatePriceOverrides).toHaveBeenCalledWith(
        expect.objectContaining({ seatIds: [SEAT_1], priceOverride: null }),
      );
      // A clear never needs the tiers at all.
      expect(mocks.events.listTicketTypes).not.toHaveBeenCalled();
    }
  });
});

describe("setSeatPriceOverrides — cap", () => {
  it("accepts the INT4 ceiling and refuses one cent above it", async () => {
    const { repos } = harness({ seats: [seat(SEAT_1)], tiers: [tier()] });
    await expect(
      run(repos, [SEAT_1], { priceCents: MAX_SEAT_PRICE_OVERRIDE_CENTS }),
    ).resolves.toMatchObject({ updated: 1 });

    const { repos: repos2, mocks } = harness({
      seats: [seat(SEAT_1)],
      tiers: [tier()],
    });
    await expect(
      run(repos2, [SEAT_1], { priceCents: MAX_SEAT_PRICE_OVERRIDE_CENTS + 1 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.seats.updatePriceOverrides).not.toHaveBeenCalled();
  });

  it("the cap is the INT4 maximum, the ceiling of TicketType.priceCents", () => {
    expect(MAX_SEAT_PRICE_OVERRIDE_CENTS).toBe(2 ** 31 - 1);
  });
});

describe("setSeatPriceOverrides — seat status: skip and report", () => {
  const mixed = () => [
    seat(SEAT_1, "AVAILABLE"),
    seat(SEAT_2, "SOLD"),
    seat(SEAT_3, "HELD"),
    seat(SEAT_4, "BLOCKED"),
    // Locked by another transaction right now: never written, never judged
    // by its (unlocked, possibly stale) status.
    seat(SEAT_5, "AVAILABLE", SECTION_A, true),
  ];

  it("writes only locked AVAILABLE and BLOCKED seats and counts SOLD, HELD, busy and unknown ids", async () => {
    const { repos, mocks } = harness({ seats: mixed(), tiers: [tier()] });

    const result = await run(
      repos,
      [SEAT_1, SEAT_2, SEAT_3, SEAT_4, SEAT_5, SEAT_GONE, SEAT_1],
      { priceCents: 5000 },
    );

    const skipped = { sold: 1, held: 1, busy: 1, notFound: 1 };
    expect(result).toEqual({ eventId: EVENT_ID, updated: 2, skipped });
    // Duplicates collapse before the lock; updated + skipped = distinct ids.
    expect(mocks.seats.lockSeatsForPriceOverrideWrite).toHaveBeenCalledWith({
      seatIds: [SEAT_1, SEAT_2, SEAT_3, SEAT_4, SEAT_5, SEAT_GONE],
      eventId: EVENT_ID,
    });
    expect(mocks.seats.updatePriceOverrides).toHaveBeenCalledWith(
      expect.objectContaining({ seatIds: [SEAT_1, SEAT_4] }),
    );
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ seatCount: 6, updated: 2, skipped }),
      }),
    );
  });

  it("a CLEAR skips SOLD, HELD and busy seats the same way", async () => {
    const { repos, mocks } = harness({ seats: mixed(), tiers: [] });

    const result = await run(
      repos,
      [SEAT_1, SEAT_2, SEAT_3, SEAT_4, SEAT_5],
      null,
    );

    expect(result.skipped).toEqual({
      sold: 1,
      held: 1,
      busy: 1,
      notFound: 0,
    });
    expect(mocks.seats.updatePriceOverrides).toHaveBeenCalledWith(
      expect.objectContaining({
        seatIds: [SEAT_1, SEAT_4],
        priceOverride: null,
      }),
    );
  });

  it("issues no UPDATE, and judges no tier, when no seat is writable", async () => {
    const { repos, mocks } = harness({
      seats: [
        seat(SEAT_2, "SOLD"),
        seat(SEAT_3, "HELD"),
        seat(SEAT_1, "AVAILABLE", SECTION_A, true),
      ],
      tiers: [],
    });

    const result = await run(repos, [SEAT_1, SEAT_2, SEAT_3], {
      priceCents: 5000,
    });

    expect(result).toEqual({
      eventId: EVENT_ID,
      updated: 0,
      skipped: { sold: 1, held: 1, busy: 1, notFound: 0 },
    });
    expect(mocks.seats.updatePriceOverrides).not.toHaveBeenCalled();
    expect(mocks.events.listTicketTypes).not.toHaveBeenCalled();
  });
});

describe("setSeatPriceOverrides — paid seat on a free tier (Connect gate)", () => {
  it("refuses a PAID override on a $0 FIXED tier when the org has no Connect account", async () => {
    for (const payee of [null, { stripeAccountId: null }]) {
      const { repos, mocks } = harness({
        seats: [seat(SEAT_1)],
        tiers: [tier({ priceCents: 0 })],
        payee,
      });
      await expect(
        run(repos, [SEAT_1], { priceCents: 5000 }),
      ).rejects.toMatchObject({
        code: "PAID_TICKETING_REQUIRES_STRIPE",
      });
      expect(mocks.seats.updatePriceOverrides).not.toHaveBeenCalled();
    }
  });

  it("allows it once the org has a linked Connect account", async () => {
    const { repos, mocks } = harness({
      seats: [seat(SEAT_1)],
      tiers: [tier({ priceCents: 0 })],
    });
    await expect(
      run(repos, [SEAT_1], { priceCents: 5000 }),
    ).resolves.toMatchObject({
      updated: 1,
    });
    expect(mocks.payees.getBySubject).toHaveBeenCalledWith({
      type: "ORGANIZATION",
      id: ORG_ID,
    });
  });

  it("refuses it when no fee policy resolves, after the Stripe gate passes", async () => {
    const { repos, mocks } = harness({
      seats: [seat(SEAT_1)],
      tiers: [tier({ priceCents: 0 })],
      feePolicy: false,
    });
    await expect(
      run(repos, [SEAT_1], { priceCents: 5000 }),
    ).rejects.toMatchObject({
      code: "PAID_TICKETING_REQUIRES_FEE_POLICY",
    });
    expect(mocks.seats.updatePriceOverrides).not.toHaveBeenCalled();
  });

  it("a section with a free AND a paid FIXED tier runs both gates", async () => {
    const { repos, mocks } = harness({
      seats: [seat(SEAT_1)],
      tiers: [tier({ priceCents: 0 }), tier({ priceCents: 3000 })],
    });
    await expect(
      run(repos, [SEAT_1], { priceCents: 5000 }),
    ).resolves.toMatchObject({ updated: 1 });
    expect(mocks.payees.getBySubject).toHaveBeenCalledTimes(1);
    expect(mocks.feePolicies.resolveEffective).toHaveBeenCalled();
  });

  it("forwards reportError to the fee-policy scope walk, which reports a failed read before rethrowing", async () => {
    const boom = new Error("fee policy read failed");
    const reportError = vi.fn();
    const { repos } = harness({
      seats: [seat(SEAT_1)],
      tiers: [tier({ priceCents: 0 })],
      feePolicy: boom,
    });
    await expect(
      run(repos, [SEAT_1], { priceCents: 5000 }, reportError),
    ).rejects.toBe(boom);
    expect(reportError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({
        tags: expect.objectContaining({ source: "setSeatPriceOverrides" }),
      }),
    );
  });

  it("a $0 override on a $0 tier needs no Connect account", async () => {
    const { repos, mocks } = harness({
      seats: [seat(SEAT_1)],
      tiers: [tier({ priceCents: 0 })],
      payee: null,
    });
    await expect(
      run(repos, [SEAT_1], { priceCents: 0 }),
    ).resolves.toMatchObject({
      updated: 1,
    });
    expect(mocks.payees.getBySubject).not.toHaveBeenCalled();
  });

  it("a paid override on an already-paid tier is not re-gated", async () => {
    const { repos, mocks } = harness({
      seats: [seat(SEAT_1)],
      tiers: [tier({ priceCents: 3000 })],
      payee: null,
    });
    await expect(
      run(repos, [SEAT_1], { priceCents: 5000 }),
    ).resolves.toMatchObject({
      updated: 1,
    });
    expect(mocks.payees.getBySubject).not.toHaveBeenCalled();
    expect(mocks.feePolicies.resolveEffective).not.toHaveBeenCalled();
  });
});
