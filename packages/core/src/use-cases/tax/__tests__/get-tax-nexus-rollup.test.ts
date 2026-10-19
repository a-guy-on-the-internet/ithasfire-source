import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type {
  OrderTaxLineRecord,
  TaxNexusRollupRow,
  TaxSplitTicketItem,
} from "@th/ports/repos/orders";

import { getTaxNexusRollup } from "../get-tax-nexus-rollup";

const clock: ClockPort = { now: () => new Date("2026-07-01T00:00:00.000Z") };
const actorHumanId = "00000000-0000-4000-8000-000000000001";

const NO_LINE_PARTS = (unattributedCents: number) => ({
  lines: [],
  unattributedCents,
  lineMismatchOrderCount: 0,
  splitOrders: [],
});

function makeLogger() {
  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
    withTime: async <T>(_: string, fn: () => Promise<T>) => fn(),
  };
  return logger;
}

function makeDeps(opts: {
  allowed?: boolean;
  logger?: ReturnType<typeof makeLogger>;
  rows?: TaxNexusRollupRow[];
  splitItems?: Map<string, TaxSplitTicketItem[]>;
  splitLines?: Map<string, OrderTaxLineRecord[]>;
  reportError?: (err: unknown, ctx?: unknown) => void;
}) {
  const getRollup = vi.fn(async () => opts.rows ?? []);
  const listTicketItemsForTaxSplit = vi.fn(
    async () => opts.splitItems ?? new Map(),
  );
  const listTaxLinesByOrderIds = vi.fn(
    async () => opts.splitLines ?? new Map(),
  );
  const hasStaffRole = vi.fn(async () => ({ allowed: opts.allowed ?? true }));
  const repos = {
    orders: {
      getTaxNexusRollup: getRollup,
      listTicketItemsForTaxSplit,
      listTaxLinesByOrderIds,
    },
  } as unknown as Repos;
  const authz = { hasStaffRole } as unknown as AuthZPort;
  return {
    deps: {
      repos,
      authz,
      clock,
      reportError: opts.reportError,
      logger: opts.logger as unknown as LoggerPort | undefined,
    },
    getRollup,
    hasStaffRole,
    listTicketItemsForTaxSplit,
    listTaxLinesByOrderIds,
  };
}

describe("getTaxNexusRollup", () => {
  it("denies a non-staff actor and never queries", async () => {
    const { deps, getRollup } = makeDeps({ allowed: false });
    await expect(
      getTaxNexusRollup(deps, { actorHumanId }),
    ).rejects.toThrow();
    expect(getRollup).not.toHaveBeenCalled();
  });

  it("derives `since` from the clock minus windowMonths", async () => {
    const { deps, getRollup } = makeDeps({ rows: [] });
    await getTaxNexusRollup(deps, { actorHumanId, windowMonths: 12 });
    expect(getRollup).toHaveBeenCalledTimes(1);
    const arg = getRollup.mock.calls[0]![0] as { since: Date };
    expect(arg.since.toISOString()).toBe("2025-07-01T00:00:00.000Z");
  });

  it("defaults the window to 12 months and returns the grouped rows", async () => {
    const rows = [
      {
        country: "US",
        state: "FL",
        netSalesCents: 900_000,
        taxCollectedCents: 54_000,
        orderCount: 300,
      },
      {
        country: "CA",
        state: "AB",
        netSalesCents: 100_000,
        taxCollectedCents: 5_000,
        orderCount: 40,
      },
    ];
    const { deps } = makeDeps({
      rows: rows.map((row) => ({
        ...row,
        taxLineParts: NO_LINE_PARTS(row.taxCollectedCents),
      })),
    });
    const out = await getTaxNexusRollup(deps, { actorHumanId });
    expect(out.windowMonths).toBe(12);
    expect(out.since).toBe("2025-07-01T00:00:00.000Z");
    expect(out.rows).toEqual([
      {
        ...rows[0],
        taxByLine: [
          { code: "UNATTRIBUTED", jurisdiction: "US/FL", collectedCents: 54_000 },
        ],
      },
      {
        ...rows[1],
        taxByLine: [
          { code: "UNATTRIBUTED", jurisdiction: "CA/AB", collectedCents: 5_000 },
        ],
      },
    ]);
  });

  it("honors a custom window length", async () => {
    const { deps, getRollup } = makeDeps({ rows: [] });
    const out = await getTaxNexusRollup(deps, { actorHumanId, windowMonths: 3 });
    expect(out.windowMonths).toBe(3);
    const arg = getRollup.mock.calls[0]![0] as { since: Date };
    expect(arg.since.toISOString()).toBe("2026-04-01T00:00:00.000Z");
  });
});

// ── taxByLine netting ────────────────────────────────────────────────────
//
// The Minneapolis order: SALES 349 on BUYER_TOTAL + MPLS_ENTERTAINMENT 105 on
// TICKET_FACE = tax 454. Item a: face 2500 / buyer total 2665; item b: face
// 1000 / buyer total 1200. Refunding a stamped 316 = SALES 241 + MPLS 75
// (largest-remainder split of each line by its own base).

const MN = "US/MN";
const MPLS = "US/MN/Minneapolis";

function taxLine(
  code: string,
  jurisdiction: string,
  base: "BUYER_TOTAL" | "TICKET_FACE",
  amountCents: number,
): OrderTaxLineRecord {
  return {
    id: `tl-${code}`,
    orderId: "o-two",
    code,
    label: code,
    jurisdiction,
    rateBps: 0,
    base,
    collector: "PLATFORM",
    taxableAmountCents: 0,
    amountCents,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
  };
}

const TWO_LINES = [
  taxLine("SALES", MN, "BUYER_TOTAL", 349),
  taxLine("MPLS_ENTERTAINMENT", MPLS, "TICKET_FACE", 105),
];

function twoLineItems(stampA: number | null): TaxSplitTicketItem[] {
  return [
    {
      id: "a",
      amountCents: 2500,
      meta: { buyerTotalCents: 2665 },
      status: "refunded",
      refundedTaxCents: stampA,
    },
    {
      id: "b",
      amountCents: 1000,
      meta: { buyerTotalCents: 1200 },
      status: "active",
      refundedTaxCents: null,
    },
  ];
}

/** The rollup row the adapter emits for that one order. */
function twoLineRow(stampedRefund: number): TaxNexusRollupRow {
  return {
    country: "US",
    state: "MN",
    netSalesCents: 1234,
    taxCollectedCents: 454 - stampedRefund,
    orderCount: 1,
    taxLineParts: {
      lines: [
        {
          code: "MPLS_ENTERTAINMENT",
          jurisdiction: MPLS,
          chargedCents: 105,
          refundedCents: 0,
        },
        { code: "SALES", jurisdiction: MN, chargedCents: 349, refundedCents: 0 },
      ],
      unattributedCents: 0,
      lineMismatchOrderCount: 0,
      splitOrders: [
        { orderId: "o-two", taxAmountCents: 454, refundedTaxCents: stampedRefund },
      ],
    },
  };
}

function sumByLine(row: { taxByLine: Array<{ collectedCents: number }> }) {
  return row.taxByLine.reduce((sum, line) => sum + line.collectedCents, 0);
}

describe("getTaxNexusRollup taxByLine", () => {
  it("splits a two-line order's refund per line: SALES -241, MPLS -75", async () => {
    const reportError = vi.fn();
    const { deps, listTicketItemsForTaxSplit, listTaxLinesByOrderIds } =
      makeDeps({
        rows: [twoLineRow(316)],
        splitItems: new Map([["o-two", twoLineItems(316)]]),
        splitLines: new Map([["o-two", TWO_LINES]]),
        reportError,
      });

    const out = await getTaxNexusRollup(deps, { actorHumanId });

    expect(out.rows[0]!.taxByLine).toEqual([
      { code: "MPLS_ENTERTAINMENT", jurisdiction: MPLS, collectedCents: 105 - 75 },
      { code: "SALES", jurisdiction: MN, collectedCents: 349 - 241 },
    ]);
    expect(sumByLine(out.rows[0]!)).toBe(out.rows[0]!.taxCollectedCents);
    expect(out.rows[0]!.taxCollectedCents).toBe(138);
    expect(reportError).not.toHaveBeenCalled();
    // One batched read each, only for the order that needs the split.
    expect(listTicketItemsForTaxSplit).toHaveBeenCalledTimes(1);
    expect(listTicketItemsForTaxSplit).toHaveBeenCalledWith(["o-two"]);
    expect(listTaxLinesByOrderIds).toHaveBeenCalledWith(["o-two"]);
  });

  it("puts a stamp that does not split exactly on UNATTRIBUTED and reports it", async () => {
    // 300 is not a's per-line share (316): never guess a split.
    const reportError = vi.fn();
    const { deps } = makeDeps({
      rows: [twoLineRow(300)],
      splitItems: new Map([["o-two", twoLineItems(300)]]),
      splitLines: new Map([["o-two", TWO_LINES]]),
      reportError,
    });

    const out = await getTaxNexusRollup(deps, { actorHumanId });

    expect(out.rows[0]!.taxByLine).toEqual([
      { code: "MPLS_ENTERTAINMENT", jurisdiction: MPLS, collectedCents: 105 },
      { code: "SALES", jurisdiction: MN, collectedCents: 349 },
      { code: "UNATTRIBUTED", jurisdiction: MN, collectedCents: -300 },
    ]);
    expect(sumByLine(out.rows[0]!)).toBe(out.rows[0]!.taxCollectedCents);
    expect(reportError).toHaveBeenCalledTimes(1);
    const [, ctx] = reportError.mock.calls[0]! as [
      unknown,
      { tags: Record<string, string>; extra: Record<string, unknown> },
    ];
    expect(ctx.tags.useCase).toBe("getTaxNexusRollup");
    expect(ctx.extra).toMatchObject({
      orderId: "o-two",
      unattributedCents: 300,
      problems: ["share_mismatch:a"],
    });
  });

  it("puts every stamp on UNATTRIBUTED when the lines disagree with the order's tax", async () => {
    const reportError = vi.fn();
    const row = twoLineRow(316);
    // SALES persisted as 359: lines sum to 454 + 10, and SQL puts the -10
    // residual on UNATTRIBUTED.
    row.taxLineParts.lines[1]!.chargedCents = 359;
    row.taxLineParts.unattributedCents = -10;
    const { deps } = makeDeps({
      rows: [row],
      splitItems: new Map([["o-two", twoLineItems(316)]]),
      splitLines: new Map([
        ["o-two", [{ ...TWO_LINES[0]!, amountCents: 359 }, TWO_LINES[1]!]],
      ]),
      reportError,
    });

    const out = await getTaxNexusRollup(deps, { actorHumanId });

    expect(out.rows[0]!.taxByLine).toContainEqual({
      code: "UNATTRIBUTED",
      jurisdiction: MN,
      collectedCents: -10 - 316,
    });
    expect(sumByLine(out.rows[0]!)).toBe(out.rows[0]!.taxCollectedCents);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(
      (reportError.mock.calls[0]![1] as { extra: { problems: string[] } }).extra
        .problems,
    ).toContain("line_mismatch");
  });

  it("puts a legacy order's net tax on UNATTRIBUTED without reporting", async () => {
    const reportError = vi.fn();
    const { deps, listTicketItemsForTaxSplit } = makeDeps({
      rows: [
        {
          country: "US",
          state: "MN",
          netSalesCents: 4000,
          taxCollectedCents: 250,
          orderCount: 1,
          taxLineParts: NO_LINE_PARTS(250),
        },
      ],
      reportError,
    });

    const out = await getTaxNexusRollup(deps, { actorHumanId });

    expect(out.rows[0]!.taxByLine).toEqual([
      { code: "UNATTRIBUTED", jurisdiction: MN, collectedCents: 250 },
    ]);
    expect(reportError).not.toHaveBeenCalled();
    expect(listTicketItemsForTaxSplit).not.toHaveBeenCalled();
  });

  it("a throwing reporter changes nothing", async () => {
    const { deps } = makeDeps({
      rows: [twoLineRow(300)],
      splitItems: new Map([["o-two", twoLineItems(300)]]),
      splitLines: new Map([["o-two", TWO_LINES]]),
      reportError: () => {
        throw new Error("sentry down");
      },
    });

    const out = await getTaxNexusRollup(deps, { actorHumanId });
    expect(sumByLine(out.rows[0]!)).toBe(out.rows[0]!.taxCollectedCents);
  });

  it("falls back to UNATTRIBUTED when the item stamps changed between reads", async () => {
    // The query netted 316, but the item read now shows no refund at all.
    const reportError = vi.fn();
    const logger = makeLogger();
    const { deps } = makeDeps({
      rows: [twoLineRow(316)],
      splitItems: new Map([["o-two", twoLineItems(null)]]),
      splitLines: new Map([["o-two", TWO_LINES]]),
      reportError,
      logger,
    });

    const out = await getTaxNexusRollup(deps, { actorHumanId });

    expect(out.rows[0]!.taxByLine).toContainEqual({
      code: "UNATTRIBUTED",
      jurisdiction: MN,
      collectedCents: -316,
    });
    expect(sumByLine(out.rows[0]!)).toBe(out.rows[0]!.taxCollectedCents);
    expect(reportError).toHaveBeenCalledTimes(1);
    // The benign race logs at warn: reportError already carries it to
    // Sentry, so an error log would be a second event.
    expect(logger.warn).toHaveBeenCalledWith(
      "tax_nexus_rollup.tax_unattributed",
      expect.objectContaining({ problems: ["stamps_changed_between_reads"] }),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("reports a row's line-mismatch orders ONCE, however many there are", async () => {
    // Three orders whose lines disagree with their tax (e.g. a two-line order
    // summing to 464 on tax 454, nothing refunded): SQL leaves the residual
    // on UNATTRIBUTED and counts them; core reports the row once.
    const reportError = vi.fn();
    const logger = makeLogger();
    const { deps, listTicketItemsForTaxSplit } = makeDeps({
      rows: [
        {
          country: "US",
          state: "MN",
          netSalesCents: 9000,
          taxCollectedCents: 1362,
          orderCount: 3,
          taxLineParts: {
            lines: [
              {
                code: "SALES",
                jurisdiction: MN,
                chargedCents: 3 * 359,
                refundedCents: 0,
              },
              {
                code: "MPLS_ENTERTAINMENT",
                jurisdiction: MPLS,
                chargedCents: 3 * 105,
                refundedCents: 0,
              },
            ],
            unattributedCents: -30,
            lineMismatchOrderCount: 3,
            splitOrders: [],
          },
        },
      ],
      reportError,
      logger,
    });

    const out = await getTaxNexusRollup(deps, { actorHumanId });

    expect(out.rows[0]!.taxByLine).toContainEqual({
      code: "UNATTRIBUTED",
      jurisdiction: MN,
      collectedCents: -30,
    });
    expect(sumByLine(out.rows[0]!)).toBe(1362);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(
      (reportError.mock.calls[0]![1] as { extra: Record<string, unknown> })
        .extra,
    ).toMatchObject({ lineMismatchOrderCount: 3, problems: ["line_mismatch_orders"] });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(listTicketItemsForTaxSplit).not.toHaveBeenCalled();
  });

  it("reports orders whose lone line disagrees with their tax, at error", async () => {
    // tax 100, SALES line 60, stamps 90: the SQL leaves SALES at its charge
    // and puts 100 − 60 − 90 = −50 on UNATTRIBUTED.
    const reportError = vi.fn();
    const logger = makeLogger();
    const { deps } = makeDeps({
      rows: [
        {
          country: "US",
          state: "WI",
          netSalesCents: 1000,
          taxCollectedCents: 10,
          orderCount: 1,
          taxLineParts: {
            lines: [
              {
                code: "SALES",
                jurisdiction: "US/WI",
                chargedCents: 60,
                refundedCents: 0,
              },
            ],
            unattributedCents: -50,
            lineMismatchOrderCount: 1,
            splitOrders: [],
          },
        },
      ],
      reportError,
      logger,
    });

    const out = await getTaxNexusRollup(deps, { actorHumanId });

    expect(out.rows[0]!.taxByLine).toEqual([
      { code: "SALES", jurisdiction: "US/WI", collectedCents: 60 },
      { code: "UNATTRIBUTED", jurisdiction: "US/WI", collectedCents: -50 },
    ]);
    expect(sumByLine(out.rows[0]!)).toBe(10);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(
      (reportError.mock.calls[0]![1] as { extra: Record<string, unknown> })
        .extra,
    ).toMatchObject({
      state: "WI",
      lineMismatchOrderCount: 1,
      problems: ["line_mismatch_orders"],
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
