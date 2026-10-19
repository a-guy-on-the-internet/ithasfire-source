import { describe, expect, it, vi } from "vitest";

import type {
  PayeeLedgerPayableBalance,
  PayeeLedgerUpcomingMaturity,
} from "@th/ports/repos/payee-ledger";

import {
  listUpcomingPayouts,
  UPCOMING_PAYOUTS_MAX_ROWS,
  UPCOMING_PAYOUTS_STATEMENT_TIMEOUT_MS,
  type ListUpcomingPayoutsDeps,
} from "../list-upcoming-payouts";

const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const HUMAN_ID = "22222222-2222-4222-8222-222222222222";
const ORG_PAYEE = "payee-org";
const HUMAN_PAYEE = "payee-human";

const NOW = new Date("2026-09-14T12:00:00.000Z");
const OCT_4 = new Date("2026-10-04T00:00:00.000Z");
const OCT_11 = new Date("2026-10-11T00:00:00.000Z");
const NOV_1 = new Date("2026-11-01T00:00:00.000Z");

function tranche(
  overrides: Partial<PayeeLedgerUpcomingMaturity> = {},
): PayeeLedgerUpcomingMaturity {
  return {
    payeeId: ORG_PAYEE,
    currency: "usd",
    maturesAt: OCT_4,
    creditCents: 12_000,
    heldCents: 0,
    creditCount: 3,
    ...overrides,
  };
}

function payable(
  overrides: Partial<PayeeLedgerPayableBalance> = {},
): PayeeLedgerPayableBalance {
  return {
    payeeId: ORG_PAYEE,
    currency: "usd",
    payableCents: 0,
    oldestMaturedAt: null,
    ...overrides,
  };
}

type Options = {
  allowed?: boolean;
  rows?: PayeeLedgerUpcomingMaturity[];
  /** Payable cells returned for the feed's payees. Default: none (no debt). */
  payables?: PayeeLedgerPayableBalance[];
  payableFail?: boolean;
  payeesFail?: boolean;
  labelsFail?: boolean;
  knownPayees?: string[];
};

function makeDeps(options: Options = {}) {
  const rows = options.rows ?? [tranche()];
  const hasStaffRole = vi.fn(async () => ({ allowed: options.allowed ?? true }));
  const listUpcomingMaturities = vi.fn(async () => rows);
  const payableFailure = new Error("payable read timed out");
  const listPayableBalances = vi.fn(async () => {
    if (options.payableFail) throw payableFailure;
    return options.payables ?? [];
  });
  const lookupFailure = new Error("db down");
  const known = new Set(options.knownPayees ?? [ORG_PAYEE, HUMAN_PAYEE]);
  const payees = {
    getByIds: vi.fn(async (ids: string[]) => {
      if (options.payeesFail) throw lookupFailure;
      return ids
        .filter((id) => known.has(id))
        .map((id) => ({
          id,
          subjectType: id === HUMAN_PAYEE ? "HUMAN" : "ORGANIZATION",
          subjectId: id === HUMAN_PAYEE ? HUMAN_ID : ORG_ID,
          stripeAccountId: `acct_${id}`,
          payoutsEnabled: true,
        }));
    }),
  };
  const organizations = {
    getByIds: vi.fn(async (ids: string[]) => {
      if (options.labelsFail) throw lookupFailure;
      return ids
        .filter((id) => id === ORG_ID)
        .map((id) => ({ id, name: "DRKMTTR", slug: "drkmttr" }));
    }),
  };
  const humans = {
    getByIds: vi.fn(async (ids: string[]) =>
      ids
        .filter((id) => id === HUMAN_ID)
        .map((id) => ({ id, name: "Sole Artist" })),
    ),
  };
  const reportError = vi.fn();
  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);

  const deps = {
    repos: {
      payeeLedger: { listUpcomingMaturities, listPayableBalances },
      payees,
      organizations,
      humans,
    },
    authz: { hasStaffRole },
    clock: { now: () => NOW },
    logger,
    reportError,
  } as unknown as ListUpcomingPayoutsDeps;

  return {
    deps,
    hasStaffRole,
    listUpcomingMaturities,
    listPayableBalances,
    payees,
    organizations,
    logger,
    reportError,
    lookupFailure,
    payableFailure,
  };
}

/** A resolved, debt-free bucket: expected equals gross. */
const clean = (creditCents: number) => ({
  creditCents,
  debtAppliedCents: 0,
  expectedCents: creditCents,
});

describe("listUpcomingPayouts", () => {
  it("refuses a non-staff actor without touching the ledger", async () => {
    const h = makeDeps({ allowed: false });
    await expect(
      listUpcomingPayouts(h.deps, { actorHumanId: ACTOR }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(h.hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR,
      requiredRoles: ["ADMIN", "SUPPORT"],
    });
    expect(h.listUpcomingMaturities).not.toHaveBeenCalled();
    expect(h.listPayableBalances).not.toHaveBeenCalled();
  });

  it("refuses unknown input keys (strict schema)", async () => {
    const h = makeDeps();
    await expect(
      listUpcomingPayouts(h.deps, { actorHumanId: ACTOR, cursor: "nope" }),
    ).rejects.toBeTruthy();
  });

  it("reads the ledger at the clock's now, with a statement budget", async () => {
    const h = makeDeps();
    const out = await listUpcomingPayouts(h.deps, { actorHumanId: ACTOR });

    // The payee slot is EXPLICITLY undefined — every payee. Asserted
    // positionally on purpose: the budget landing in that slot is the failure
    // mode this signature was arranged to make impossible, and this assertion
    // is the runtime half of that guard.
    expect(h.listUpcomingMaturities).toHaveBeenCalledWith(NOW, undefined, {
      statementTimeoutMs: UPCOMING_PAYOUTS_STATEMENT_TIMEOUT_MS,
    });
    expect(out.asOf).toEqual(NOW);
  });

  it("reads the payable NARROWED to the feed's distinct payees, same instant, same budget", async () => {
    const h = makeDeps({
      rows: [
        tranche({ payeeId: ORG_PAYEE, maturesAt: OCT_4 }),
        tranche({ payeeId: ORG_PAYEE, maturesAt: OCT_11 }),
        tranche({ payeeId: HUMAN_PAYEE, maturesAt: OCT_4 }),
      ],
    });
    await listUpcomingPayouts(h.deps, { actorHumanId: ACTOR });

    expect(h.listPayableBalances).toHaveBeenCalledTimes(1);
    expect(h.listPayableBalances).toHaveBeenCalledWith(
      NOW,
      [ORG_PAYEE, HUMAN_PAYEE],
      { statementTimeoutMs: UPCOMING_PAYOUTS_STATEMENT_TIMEOUT_MS },
    );
  });

  it("skips the payable read entirely when nothing is upcoming", async () => {
    const h = makeDeps({ rows: [] });
    const out = await listUpcomingPayouts(h.deps, { actorHumanId: ACTOR });
    expect(h.listPayableBalances).not.toHaveBeenCalled();
    expect(out.debtResolved).toBe(true);
  });

  // ── byDate: "what goes out on 4 Oct" ──────────────────────────────────────

  it("groups by DATE across payees, counting distinct payees and credits", async () => {
    const h = makeDeps({
      rows: [
        tranche({ payeeId: ORG_PAYEE, maturesAt: OCT_4, creditCents: 4_000, creditCount: 2 }),
        tranche({ payeeId: HUMAN_PAYEE, maturesAt: OCT_4, creditCents: 1_500, creditCount: 1 }),
        tranche({ payeeId: ORG_PAYEE, maturesAt: OCT_11, creditCents: 900, creditCount: 1 }),
      ],
    });

    const out = await listUpcomingPayouts(h.deps, { actorHumanId: ACTOR });

    expect(out.byDate).toEqual([
      {
        maturesAt: OCT_4,
        currency: "usd",
        ...clean(5_500),
        payeeCount: 2,
        creditCount: 3,
      },
      {
        maturesAt: OCT_11,
        currency: "usd",
        ...clean(900),
        payeeCount: 1,
        creditCount: 1,
      },
    ]);
  });

  it("orders byDate ascending even when the ledger feed is not", async () => {
    const h = makeDeps({
      rows: [
        tranche({ maturesAt: NOV_1, creditCents: 100 }),
        tranche({ maturesAt: OCT_4, creditCents: 200 }),
      ],
    });
    const out = await listUpcomingPayouts(h.deps, { actorHumanId: ACTOR });
    expect(out.byDate.map((b) => b.maturesAt)).toEqual([OCT_4, NOV_1]);
  });

  // ── nextByPayee: the "Expected next" column ───────────────────────────────

  it("reports the EARLIEST tranche per payee, and only that tranche's cents", async () => {
    const h = makeDeps({
      rows: [
        tranche({ payeeId: ORG_PAYEE, maturesAt: OCT_4, creditCents: 4_000 }),
        tranche({ payeeId: ORG_PAYEE, maturesAt: OCT_11, creditCents: 9_000 }),
        tranche({ payeeId: ORG_PAYEE, maturesAt: NOV_1, creditCents: 2_000 }),
        tranche({ payeeId: HUMAN_PAYEE, maturesAt: OCT_11, creditCents: 700 }),
      ],
    });

    const out = await listUpcomingPayouts(h.deps, { actorHumanId: ACTOR });

    expect(out.nextByPayee).toEqual([
      {
        payeeId: ORG_PAYEE,
        currency: "usd",
        maturesAt: OCT_4,
        // The FIRST tranche only — NOT 4_000 + 9_000 + 2_000. The whole
        // reason the field is not called `amountCents`.
        nextTrancheCents: 4_000,
        creditCents: 4_000,
        heldCents: 0,
        debtAppliedCents: 0,
      },
      {
        payeeId: HUMAN_PAYEE,
        currency: "usd",
        maturesAt: OCT_11,
        nextTrancheCents: 700,
        creditCents: 700,
        heldCents: 0,
        debtAppliedCents: 0,
      },
    ]);
    // ...while the payee's FULL upcoming total lives in currencyTotals.
    expect(out.currencyTotals).toEqual([
      { currency: "usd", ...clean(15_700), trancheCount: 4 },
    ]);
  });

  it("picks the earliest tranche even if the feed arrives out of order", async () => {
    const h = makeDeps({
      rows: [
        tranche({ maturesAt: NOV_1, creditCents: 5_000 }),
        tranche({ maturesAt: OCT_4, creditCents: 100 }),
      ],
    });
    const out = await listUpcomingPayouts(h.deps, { actorHumanId: ACTOR });
    expect(out.nextByPayee).toEqual([
      {
        payeeId: ORG_PAYEE,
        currency: "usd",
        maturesAt: OCT_4,
        nextTrancheCents: 100,
        creditCents: 100,
        heldCents: 0,
        debtAppliedCents: 0,
      },
    ]);
  });

  // ── Dispute holds: an ANNOTATION, never an operand ────────────────────────
  //
  // A hold bumps the pending-hold rollup at write time and the payable
  // subtracts it every night, so it is ALREADY inside today's payable and
  // reaches the forecast as debt. Subtracting `heldCents` as well counts it
  // twice. Fixtures below are ledger-plausible: a cell with an active
  // 7_000 hold and nothing else has a payable of −7_000, not "no rows".

  it("(A) partial hold: nets the DEBT the hold created, never the hold itself — 7_000 under a 3_000 hold pays 4_000, not 1_000", async () => {
    const h = makeDeps({
      rows: [tranche({ maturesAt: OCT_4, creditCents: 7_000, heldCents: 3_000, creditCount: 1 })],
      // The hold is already in the payable: −3_000 today.
      payables: [payable({ payableCents: -3_000 })],
    });

    const out = await listUpcomingPayouts(h.deps, { actorHumanId: ACTOR });

    expect(out.items[0]).toMatchObject({
      creditCents: 7_000,
      heldCents: 3_000,
      debtAppliedCents: 3_000,
      expectedCents: 4_000,
    });
    expect(out.nextByPayee[0]).toMatchObject({
      nextTrancheCents: 4_000,
      creditCents: 7_000,
      heldCents: 3_000,
      debtAppliedCents: 3_000,
    });
    // Aggregates carry no hold figure at all — nothing to subtract twice.
    expect(out.currencyTotals).toEqual([
      {
        currency: "usd",
        creditCents: 7_000,
        debtAppliedCents: 3_000,
        expectedCents: 4_000,
        trancheCount: 1,
      },
    ]);
    expect(out.byDate).toEqual([
      {
        maturesAt: OCT_4,
        currency: "usd",
        creditCents: 7_000,
        debtAppliedCents: 3_000,
        expectedCents: 4_000,
        payeeCount: 1,
        creditCount: 1,
      },
    ]);
  });

  it("(B) positive balance elsewhere: a fully-held immature credit still pays in FULL on the night", async () => {
    // 10_000 matured on another order, 7_000 immature under a 7_000 hold:
    // payable today +3_000 (pays tonight), so no debt — Oct 4 pays 7_000.
    const h = makeDeps({
      rows: [tranche({ maturesAt: OCT_4, creditCents: 7_000, heldCents: 7_000 })],
      payables: [payable({ payableCents: 3_000 })],
    });

    const out = await listUpcomingPayouts(h.deps, { actorHumanId: ACTOR });

    expect(out.items[0]).toMatchObject({
      creditCents: 7_000,
      heldCents: 7_000,
      debtAppliedCents: 0,
      expectedCents: 7_000,
    });
  });

  it("a fully-held credit with nothing else: the −7_000 debt zeroes the tranche, and the hold is annotated once", async () => {
    const h = makeDeps({
      rows: [
        tranche({ maturesAt: OCT_4, creditCents: 7_000, heldCents: 7_000, creditCount: 1 }),
        tranche({ maturesAt: OCT_11, creditCents: 5_000, heldCents: 0, creditCount: 1 }),
      ],
      payables: [payable({ payableCents: -7_000 })],
    });

    const out = await listUpcomingPayouts(h.deps, { actorHumanId: ACTOR });

    expect(out.items.map((i) => [i.heldCents, i.debtAppliedCents, i.expectedCents])).toEqual([
      [7_000, 7_000, 0],
      [0, 0, 5_000],
    ]);
    expect(out.byDate.map((b) => b.expectedCents)).toEqual([0, 5_000]);
  });

  // ── Carried-forward debt (netted HERE from the payable read) ──────────────

  it("consumes a NEGATIVE payable across tranches, soonest first, carrying the remainder", async () => {
    // A payee at −12_000 with tranches of 10_000 (Oct 4) and 5_000 (Oct 11):
    // the first tranche is eaten whole, the second loses the remaining
    // 2_000. The batch pays max(0, payable), so this IS what will move.
    const h = makeDeps({
      rows: [
        // Feed arrives out of order on purpose: the walk must be by date.
        tranche({ maturesAt: OCT_11, creditCents: 5_000, creditCount: 1 }),
        tranche({ maturesAt: OCT_4, creditCents: 10_000, creditCount: 1 }),
      ],
      payables: [payable({ payableCents: -12_000 })],
    });

    const out = await listUpcomingPayouts(h.deps, { actorHumanId: ACTOR });

    expect(out.debtResolved).toBe(true);
    const byDate = new Map(out.items.map((i) => [i.maturesAt.getTime(), i]));
    expect(byDate.get(OCT_4.getTime())).toMatchObject({
      creditCents: 10_000,
      debtAppliedCents: 10_000,
      expectedCents: 0,
    });
    expect(byDate.get(OCT_11.getTime())).toMatchObject({
      creditCents: 5_000,
      debtAppliedCents: 2_000,
      expectedCents: 3_000,
    });
    expect(out.nextByPayee).toEqual([
      {
        payeeId: ORG_PAYEE,
        currency: "usd",
        maturesAt: OCT_4,
        nextTrancheCents: 0,
        creditCents: 10_000,
        heldCents: 0,
        debtAppliedCents: 10_000,
      },
    ]);
    expect(out.currencyTotals).toEqual([
      {
        currency: "usd",
        creditCents: 15_000,
        debtAppliedCents: 12_000,
        expectedCents: 3_000,
        trancheCount: 2,
      },
    ]);
  });

  it("a debt larger than every tranche zeroes them all and never goes negative", async () => {
    const h = makeDeps({
      rows: [
        tranche({ maturesAt: OCT_4, creditCents: 1_000 }),
        tranche({ maturesAt: OCT_11, creditCents: 2_000 }),
      ],
      payables: [payable({ payableCents: -50_000 })],
    });

    const out = await listUpcomingPayouts(h.deps, { actorHumanId: ACTOR });

    expect(out.items.map((i) => [i.debtAppliedCents, i.expectedCents])).toEqual([
      [1_000, 0],
      [2_000, 0],
    ]);
    // Only what the tranches could absorb is reported as applied — the
    // uncovered 47_000 of debt is not a forecast figure.
    expect(out.currencyTotals[0]).toMatchObject({
      debtAppliedCents: 3_000,
      expectedCents: 0,
    });
  });

  it("(C-shaped) the debt walk uses the GROSS as capacity: 6_000 under a 4_000 hold with −5_000 payable pays 1_000 on Oct 4, nothing carried", async () => {
    // The hold is the reason the payable is −5_000 in the first place
    // (4_000 of it) — reducing capacity by it too would carry 3_000 of
    // phantom debt into the next tranche.
    const h = makeDeps({
      rows: [
        tranche({ maturesAt: OCT_4, creditCents: 6_000, heldCents: 4_000 }),
        tranche({ maturesAt: OCT_11, creditCents: 10_000 }),
      ],
      payables: [payable({ payableCents: -5_000 })],
    });

    const out = await listUpcomingPayouts(h.deps, { actorHumanId: ACTOR });

    expect(out.items.map((i) => [i.heldCents, i.debtAppliedCents, i.expectedCents])).toEqual([
      [4_000, 5_000, 1_000],
      [0, 0, 10_000],
    ]);
  });

  it("a POSITIVE payable applies nothing — debits are already effective against it", async () => {
    // The old rationale, kept where it is right: netting a positive payable's
    // history against a future tranche would double count.
    const h = makeDeps({
      rows: [tranche({ creditCents: 8_000 })],
      payables: [payable({ payableCents: 30_000 })],
    });

    const out = await listUpcomingPayouts(h.deps, { actorHumanId: ACTOR });

    expect(out.items[0]).toMatchObject({
      creditCents: 8_000,
      debtAppliedCents: 0,
      expectedCents: 8_000,
    });
    expect(out.debtResolved).toBe(true);
  });

  it("keys the payable by NORMALISED currency and never nets debt across currencies", async () => {
    const h = makeDeps({
      rows: [
        tranche({ currency: "usd", creditCents: 5_000 }),
        tranche({ currency: "mxn", creditCents: 5_000 }),
      ],
      payables: [
        // Raw casing / padding from the payable query must still find the
        // usd tranche; the mxn tranche is untouched by a usd debt.
        payable({ currency: " USD ", payableCents: -1_000 }),
      ],
    });

    const out = await listUpcomingPayouts(h.deps, { actorHumanId: ACTOR });

    const usd = out.items.find((i) => i.currency === "usd");
    const mxn = out.items.find((i) => i.currency === "mxn");
    expect(usd).toMatchObject({ debtAppliedCents: 1_000, expectedCents: 4_000 });
    expect(mxn).toMatchObject({ debtAppliedCents: 0, expectedCents: 5_000 });
  });

  it("folds the SIGNED payable per normalised currency BEFORE testing for debt — +5_000 'USD' and −3_000 'usd' is one +2_000 cell, not a 3_000 debt", async () => {
    const h = makeDeps({
      rows: [tranche({ currency: "usd", creditCents: 5_000 })],
      payables: [
        payable({ currency: "USD", payableCents: 5_000 }),
        payable({ currency: "usd", payableCents: -3_000 }),
      ],
    });

    const out = await listUpcomingPayouts(h.deps, { actorHumanId: ACTOR });

    expect(out.items[0]).toMatchObject({ debtAppliedCents: 0, expectedCents: 5_000 });
  });

  it("when the payable read FAILS: rows are kept, debt-dependent figures are NULL, debtResolved is false, and the swallow is reported", async () => {
    const h = makeDeps({
      rows: [
        tranche({ maturesAt: OCT_4, creditCents: 7_000, heldCents: 2_000 }),
        tranche({ payeeId: HUMAN_PAYEE, maturesAt: OCT_11, creditCents: 300 }),
      ],
      payableFail: true,
    });

    const out = await listUpcomingPayouts(h.deps, { actorHumanId: ACTOR });

    // The feed is intact: nothing hidden, nothing blanked.
    expect(out.total).toBe(2);
    expect(out.items).toHaveLength(2);
    expect(out.debtResolved).toBe(false);
    // ...but no number pretends to be net. Gross and held are still known.
    expect(out.items[0]).toMatchObject({
      creditCents: 7_000,
      heldCents: 2_000,
      debtAppliedCents: null,
      expectedCents: null,
    });
    expect(out.nextByPayee[0]).toMatchObject({
      nextTrancheCents: null,
      creditCents: 7_000,
      heldCents: 2_000,
      debtAppliedCents: null,
    });
    expect(out.byDate.map((b) => [b.creditCents, b.expectedCents])).toEqual([
      [7_000, null],
      [300, null],
    ]);
    expect(out.currencyTotals).toEqual([
      {
        currency: "usd",
        creditCents: 7_300,
        debtAppliedCents: null,
        expectedCents: null,
        trancheCount: 2,
      },
    ]);

    expect(h.logger.error).toHaveBeenCalledWith(
      "upcoming_payouts_debt_lookup_failed",
      expect.objectContaining({ err: h.payableFailure }),
    );
    expect(h.reportError).toHaveBeenCalledWith(
      h.payableFailure,
      expect.objectContaining({
        tags: { useCase: "listUpcomingPayouts", step: "applyDebt" },
      }),
    );
  });

  it("a throwing reportError on the payable failure never changes the result", async () => {
    const h = makeDeps({ payableFail: true });
    (h.reportError as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("sentry is down");
    });

    await expect(
      listUpcomingPayouts(h.deps, { actorHumanId: ACTOR }),
    ).resolves.toMatchObject({
      total: 1,
      debtResolved: false,
      items: [expect.objectContaining({ creditCents: 12_000, expectedCents: null })],
    });
  });

  it("a MISSING reporter on the payable failure never changes the result either", async () => {
    const h = makeDeps({ payableFail: true });
    (h.deps as { reportError?: unknown }).reportError = undefined;

    await expect(
      listUpcomingPayouts(h.deps, { actorHumanId: ACTOR }),
    ).resolves.toMatchObject({ total: 1, debtResolved: false });
  });

  // ── Currency separation ───────────────────────────────────────────────────

  it("never sums across currencies — not in byDate, nextByPayee or the totals", async () => {
    const h = makeDeps({
      rows: [
        tranche({ currency: "usd", maturesAt: OCT_4, creditCents: 1_000, creditCount: 1 }),
        tranche({ currency: "mxn", maturesAt: OCT_4, creditCents: 2_000, creditCount: 1 }),
      ],
    });

    const out = await listUpcomingPayouts(h.deps, { actorHumanId: ACTOR });

    // Same date, same payee, two currencies: two byDate buckets, never 3_000.
    expect(out.byDate).toEqual([
      {
        maturesAt: OCT_4,
        currency: "mxn",
        ...clean(2_000),
        payeeCount: 1,
        creditCount: 1,
      },
      {
        maturesAt: OCT_4,
        currency: "usd",
        ...clean(1_000),
        payeeCount: 1,
        creditCount: 1,
      },
    ]);
    expect(out.nextByPayee).toEqual([
      {
        payeeId: ORG_PAYEE,
        currency: "mxn",
        maturesAt: OCT_4,
        nextTrancheCents: 2_000,
        creditCents: 2_000,
        heldCents: 0,
        debtAppliedCents: 0,
      },
      {
        payeeId: ORG_PAYEE,
        currency: "usd",
        maturesAt: OCT_4,
        nextTrancheCents: 1_000,
        creditCents: 1_000,
        heldCents: 0,
        debtAppliedCents: 0,
      },
    ]);
    expect(out.currencyTotals).toEqual([
      { currency: "mxn", ...clean(2_000), trancheCount: 1 },
      { currency: "usd", ...clean(1_000), trancheCount: 1 },
    ]);
  });

  // ── Blocked credits ───────────────────────────────────────────────────────

  it("carries only what the ledger returned — blocked credits never reach the view", async () => {
    // The blocked-credit exclusion is applied in SQL (CREDIT_NOT_BLOCKED_SQL,
    // shared verbatim with the payable query), so the use case must not add a
    // second filter of its own — it reports exactly the feed. Proven here by
    // the feed's own arithmetic: a disputed credit that the adapter withheld
    // is simply absent, and nothing in the output re-introduces it.
    const h = makeDeps({
      rows: [tranche({ maturesAt: OCT_4, creditCents: 4_000, creditCount: 1 })],
    });

    const out = await listUpcomingPayouts(h.deps, { actorHumanId: ACTOR });

    expect(out.total).toBe(1);
    expect(out.items).toHaveLength(1);
    expect(out.currencyTotals).toEqual([
      { currency: "usd", ...clean(4_000), trancheCount: 1 },
    ]);
    expect(out.byDate[0]!.creditCents).toBe(4_000);
  });

  it("reports empty everything when nothing is upcoming", async () => {
    const h = makeDeps({ rows: [] });
    const out = await listUpcomingPayouts(h.deps, { actorHumanId: ACTOR });
    expect(out).toMatchObject({
      items: [],
      byDate: [],
      nextByPayee: [],
      currencyTotals: [],
      total: 0,
      truncated: false,
      debtResolved: true,
      asOf: NOW,
    });
  });

  // ── Truncation ────────────────────────────────────────────────────────────

  it("caps the visible list but keeps EVERY aggregate complete, and says it truncated", async () => {
    const over = UPCOMING_PAYOUTS_MAX_ROWS + 5;
    const h = makeDeps({
      rows: Array.from({ length: over }, (_, i) =>
        tranche({
          payeeId: `p-${i}`,
          maturesAt: OCT_4,
          creditCents: 100,
          creditCount: 1,
        }),
      ),
      knownPayees: [],
    });

    const out = await listUpcomingPayouts(h.deps, { actorHumanId: ACTOR });

    expect(out.items).toHaveLength(UPCOMING_PAYOUTS_MAX_ROWS);
    expect(out.truncated).toBe(true);
    expect(out.rowLimit).toBe(UPCOMING_PAYOUTS_MAX_ROWS);
    expect(out.total).toBe(over);
    // The headline describes EVERY tranche, not the visible page — a
    // truncated list must never understate what is coming.
    expect(out.currencyTotals).toEqual([
      { currency: "usd", ...clean(over * 100), trancheCount: over },
    ]);
    expect(out.byDate).toEqual([
      {
        maturesAt: OCT_4,
        currency: "usd",
        ...clean(over * 100),
        payeeCount: over,
        creditCount: over,
      },
    ]);
    // ...and the "Expected next" join stays complete, so a payee whose
    // tranche fell off the page is not rendered as having nothing upcoming.
    expect(out.nextByPayee).toHaveLength(over);
    // The payable read was narrowed to every payee in the feed, not the page.
    expect(h.listPayableBalances.mock.calls[0]![1]).toHaveLength(over);
  });

  // ── Identity ──────────────────────────────────────────────────────────────

  it("resolves who each tranche belongs to", async () => {
    const h = makeDeps({
      rows: [
        tranche({ payeeId: ORG_PAYEE }),
        tranche({ payeeId: HUMAN_PAYEE, creditCents: 800 }),
      ],
    });

    const out = await listUpcomingPayouts(h.deps, { actorHumanId: ACTOR });

    expect(out.items[0]).toMatchObject({
      payeeId: ORG_PAYEE,
      subjectType: "ORGANIZATION",
      subjectId: ORG_ID,
      ownerLabel: "DRKMTTR",
      ownerSlug: "drkmttr",
      identityResolved: true,
    });
    expect(out.items[1]).toMatchObject({
      payeeId: HUMAN_PAYEE,
      subjectType: "HUMAN",
      subjectId: HUMAN_ID,
      ownerLabel: "Sole Artist",
      ownerSlug: null,
      identityResolved: true,
    });
  });

  it("degrades to identityResolved:false WITHOUT dropping the row, and reports the swallow", async () => {
    const h = makeDeps({ payeesFail: true });

    const out = await listUpcomingPayouts(h.deps, { actorHumanId: ACTOR });

    // The money is intact. A naming outage must never hide what is coming.
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({
      payeeId: ORG_PAYEE,
      creditCents: 12_000,
      expectedCents: 12_000,
      maturesAt: OCT_4,
      subjectType: null,
      subjectId: null,
      ownerLabel: null,
      ownerSlug: null,
      identityResolved: false,
    });
    expect(out.currencyTotals).toEqual([
      { currency: "usd", ...clean(12_000), trancheCount: 1 },
    ]);

    expect(h.logger.error).toHaveBeenCalledWith(
      "upcoming_payouts_owner_lookup_failed",
      expect.objectContaining({ err: h.lookupFailure }),
    );
    expect(h.reportError).toHaveBeenCalledWith(
      h.lookupFailure,
      expect.objectContaining({
        tags: { useCase: "listUpcomingPayouts", step: "attachOwners" },
      }),
    );
  });

  it("keeps the subject when only the LABEL read fails, and still reports it", async () => {
    const h = makeDeps({ labelsFail: true });

    const out = await listUpcomingPayouts(h.deps, { actorHumanId: ACTOR });

    expect(out.items[0]).toMatchObject({
      creditCents: 12_000,
      // The Payee read landed, so the subject is known...
      subjectType: "ORGANIZATION",
      subjectId: ORG_ID,
      identityResolved: true,
      // ...only the display name is missing.
      ownerLabel: null,
      ownerSlug: null,
    });
    expect(h.reportError).toHaveBeenCalledTimes(1);
  });

  it("a throwing reportError never changes the result", async () => {
    // The CLAUDE.md regression pattern: a broken Sentry wiring must not turn
    // a degraded panel into a failed one.
    const h = makeDeps({ payeesFail: true });
    (h.reportError as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("sentry is down");
    });

    await expect(
      listUpcomingPayouts(h.deps, { actorHumanId: ACTOR }),
    ).resolves.toMatchObject({
      total: 1,
      items: [expect.objectContaining({ creditCents: 12_000 })],
    });
  });

  it("a MISSING reporter never changes the result either", async () => {
    const h = makeDeps({ payeesFail: true });
    (h.deps as { reportError?: unknown }).reportError = undefined;

    await expect(
      listUpcomingPayouts(h.deps, { actorHumanId: ACTOR }),
    ).resolves.toMatchObject({ total: 1 });
  });
});
