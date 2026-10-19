import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type {
  OrderTaxLineRecord,
  TaxNexusRollupRow,
  TaxSplitTicketItem,
} from "@th/ports/repos/orders";

import { callOrDependencyFailed, parseInput } from "../../lib/io";
import { fail } from "@th/errors";
import { allocateRefundTaxSharesByLine } from "../../lib/orders/refund-tax-share";

/**
 * Economic-nexus threshold watch (spec 2026-07-01 §5.3).
 *
 * Read-only, platform-staff-only rollup of net facilitated sales + collected
 * tax grouped by the frozen tax situs (country + state/province) over a rolling
 * window. Lets us see when a jurisdiction approaches its registration threshold
 * (US $100k; the CAD figure for Canada) without a paid vendor's monitoring — we
 * are only summing our own orders. Counts SUCCEEDED + PART_REFUNDED orders.
 */

const NEXUS_STAFF_ROLES = [
  "ADMIN",
  "REVIEWER",
  "SUPPORT",
  "DEVELOPER",
] as const;

export const getTaxNexusRollupInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    /** Rolling window length in months (default 12 — the common nexus window). */
    windowMonths: z.number().int().min(1).max(60).default(12),
  })
  .strict();

/**
 * Synthetic line code for tax collected that cannot be put on a real tax line:
 * orders that predate `OrderTaxLine` (expected), lines that disagree with the
 * order's tax, and refunds on multi-line orders that cannot be split exactly.
 */
export const UNATTRIBUTED_TAX_LINE_CODE = "UNATTRIBUTED";

const taxByLineEntrySchema = z
  .object({
    code: z.string(),
    jurisdiction: z.string(),
    /** Charged minus refunded tax on this line, in cents. */
    collectedCents: z.number().int(),
  })
  .strict();

const taxNexusRollupRowSchema = z
  .object({
    country: z.string().nullable(),
    state: z.string().nullable(),
    netSalesCents: z.number().int(),
    taxCollectedCents: z.number().int(),
    orderCount: z.number().int().nonnegative(),
    /**
     * `taxCollectedCents` broken down per PLATFORM tax line. Σ collectedCents
     * === taxCollectedCents, to the cent. Sorted by code, then jurisdiction.
     */
    taxByLine: z.array(taxByLineEntrySchema),
  })
  .strict();

export const getTaxNexusRollupOutputSchema = z
  .object({
    rows: z.array(taxNexusRollupRowSchema),
    /** ISO timestamp of the rolling-window start actually used. */
    since: z.string(),
    windowMonths: z.number().int(),
  })
  .strict();

export type GetTaxNexusRollupInput = z.infer<
  typeof getTaxNexusRollupInputSchema
>;
export type GetTaxNexusRollupOutput = z.infer<
  typeof getTaxNexusRollupOutputSchema
>;

export type GetTaxNexusRollupDeps = {
  repos: Repos;
  authz: AuthZPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Reports the UNATTRIBUTED fallbacks: a refund stamp on an order with ≥2
   * PLATFORM tax lines that does not split exactly, and orders whose lines
   * disagree with their tax. Never legacy no-line orders (expected).
   * Guarded: a throwing reporter changes nothing.
   */
  reportError?: ReporterPort;
};

export async function getTaxNexusRollup(
  deps: GetTaxNexusRollupDeps,
  rawInput: unknown,
): Promise<GetTaxNexusRollupOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "getTaxNexusRollup" });

  const execute = async () => {
    const input = parseInput(getTaxNexusRollupInputSchema, rawInput);

    const staffCheck = await callOrDependencyFailed(
      () =>
        deps.authz.hasStaffRole({
          actorHumanId: input.actorHumanId,
          requiredRoles: [...NEXUS_STAFF_ROLES],
        }),
      scopedLogger,
      { action: "authz.hasStaffRole", actorHumanId: input.actorHumanId },
    );

    if (!staffCheck.allowed) {
      throw fail("FORBIDDEN");
    }

    // Rolling-window start, derived from the injected clock (never new Date()).
    // Computed in UTC so the boundary is deterministic regardless of the
    // server's local timezone (engineering-standards §5: timestamps are UTC).
    const now = deps.clock.now();
    const since = new Date(now);
    since.setUTCMonth(since.getUTCMonth() - input.windowMonths);

    const rows = await callOrDependencyFailed(
      () => deps.repos.orders.getTaxNexusRollup({ since }),
      scopedLogger,
      { action: "repos.orders.getTaxNexusRollup" },
    );

    const splitOrderIds = rows.flatMap((row) =>
      row.taxLineParts.splitOrders.map((order) => order.orderId),
    );
    let splitItems = new Map<string, TaxSplitTicketItem[]>();
    let splitLines = new Map<string, OrderTaxLineRecord[]>();
    if (splitOrderIds.length > 0) {
      // Two batched reads, only for the orders that need a split.
      [splitItems, splitLines] = await callOrDependencyFailed(
        () =>
          Promise.all([
            deps.repos.orders.listTicketItemsForTaxSplit(splitOrderIds),
            deps.repos.orders.listTaxLinesByOrderIds(splitOrderIds),
          ]),
        scopedLogger,
        { action: "repos.orders.taxSplitInputs" },
      );
    }

    const report: Reporter = (extra, level = "error") => {
      // `warn` only for the benign read race: reportError still carries it
      // to Sentry, and an error log would make it a second event.
      if (level === "warn") {
        scopedLogger?.warn("tax_nexus_rollup.tax_unattributed", extra);
      } else {
        scopedLogger?.error("tax_nexus_rollup.tax_unattributed", extra);
      }
      try {
        deps.reportError?.(
          new Error("tax nexus rollup: collected tax not attributable to lines"),
          { tags: { useCase: "getTaxNexusRollup" }, extra },
        );
      } catch {
        // A throwing reporter must never change the rollup.
      }
    };

    return getTaxNexusRollupOutputSchema.parse({
      rows: rows.map(({ taxLineParts, ...row }) => ({
        ...row,
        taxByLine: buildTaxByLine(
          row,
          taxLineParts,
          splitItems,
          splitLines,
          report,
        ),
      })),
      since: since.toISOString(),
      windowMonths: input.windowMonths,
    });
  };

  if (scopedLogger) {
    return scopedLogger.withTime("getTaxNexusRollup", execute);
  }

  return execute();
}

type TaxLineParts = TaxNexusRollupRow["taxLineParts"];
type Reporter = (
  extra: Record<string, unknown>,
  level?: "error" | "warn",
) => void;

const STAMPS_CHANGED = "stamps_changed_between_reads";

/**
 * Folds the adapter's line parts into `taxByLine`. The SQL already carries
 * every exact case (charged per line, single-line refunds, legacy and residual
 * tax as `unattributedCents`); this only places the refunds of orders with ≥2
 * PLATFORM lines, by the same allocator the refund paths stamped them with.
 */
function buildTaxByLine(
  row: Pick<TaxNexusRollupRow, "country" | "state">,
  parts: TaxLineParts,
  splitItems: Map<string, TaxSplitTicketItem[]>,
  splitLines: Map<string, OrderTaxLineRecord[]>,
  report: Reporter,
): Array<{ code: string; jurisdiction: string; collectedCents: number }> {
  const rowJurisdiction = [row.country, row.state].filter(Boolean).join("/");
  const entries = new Map<
    string,
    { code: string; jurisdiction: string; collectedCents: number }
  >();
  const add = (code: string, jurisdiction: string, cents: number) => {
    const key = `${code}\u0000${jurisdiction}`;
    const entry = entries.get(key) ?? { code, jurisdiction, collectedCents: 0 };
    entry.collectedCents += cents;
    entries.set(key, entry);
  };

  for (const line of parts.lines) {
    add(line.code, line.jurisdiction, line.chargedCents - line.refundedCents);
  }
  let unattributedCents = parts.unattributedCents;

  // Once per row. Split orders are not in this count: their `lineMismatch`
  // is reported per order below, with the order id.
  if (parts.lineMismatchOrderCount > 0) {
    report({
      country: row.country,
      state: row.state,
      lineMismatchOrderCount: parts.lineMismatchOrderCount,
      problems: ["line_mismatch_orders"],
    });
  }

  for (const order of parts.splitOrders) {
    const split = splitRefundedTaxByLine(
      order,
      splitItems.get(order.orderId) ?? [],
      splitLines.get(order.orderId) ?? [],
    );
    for (const { code, jurisdiction, cents } of split.byLine) {
      add(code, jurisdiction, -cents);
    }
    unattributedCents -= split.unattributedCents;
    if (split.problems.length > 0) {
      const raceOnly = split.problems.every((p) => p === STAMPS_CHANGED);
      report(
        {
          orderId: order.orderId,
          country: row.country,
          state: row.state,
          orderTaxCents: order.taxAmountCents,
          stampedRefundedTaxCents: order.refundedTaxCents,
          unattributedCents: split.unattributedCents,
          problems: split.problems,
        },
        raceOnly ? "warn" : "error",
      );
    }
  }

  if (unattributedCents !== 0) {
    add(UNATTRIBUTED_TAX_LINE_CODE, rowJurisdiction, unattributedCents);
  }

  return [...entries.values()].sort((a, b) =>
    a.code === b.code
      ? a.jurisdiction.localeCompare(b.jurisdiction)
      : a.code.localeCompare(b.code),
  );
}

/**
 * One multi-line order's refunded tax, per line. Runs the allocator over ALL
 * the order's ticket items and lines (as the refund paths did) and, for each
 * refunded item, takes its per-line shares only when they sum exactly to the
 * item's stamp. Anything else lands on UNATTRIBUTED — never a guess:
 * a NULL stamp (nothing was netted, so nothing moves), `lineMismatch`, a line
 * code the order carries twice with different jurisdictions, an item whose
 * shares disagree with its stamp, or items whose stamps no longer add up to
 * what the rollup query netted (the order changed between the two reads).
 */
function splitRefundedTaxByLine(
  order: TaxLineParts["splitOrders"][number],
  ticketItems: TaxSplitTicketItem[],
  taxLines: OrderTaxLineRecord[],
): {
  byLine: Array<{ code: string; jurisdiction: string; cents: number }>;
  unattributedCents: number;
  problems: string[];
} {
  const problems: string[] = [];
  const refunded = ticketItems.filter((item) => item.status === "refunded");
  const stampedTotal = refunded.reduce(
    (sum, item) => sum + (item.refundedTaxCents ?? 0),
    0,
  );
  if (stampedTotal !== order.refundedTaxCents) {
    // The item read disagrees with the query's own netting: put exactly what
    // the query netted on UNATTRIBUTED so the row still sums.
    return {
      byLine: [],
      unattributedCents: order.refundedTaxCents,
      problems: [STAMPS_CHANGED],
    };
  }

  const platformLines = taxLines.filter(
    (line) => line.collector === "PLATFORM" && line.amountCents > 0,
  );
  const jurisdictionByCode = new Map<string, string>();
  let ambiguousCode = false;
  for (const line of platformLines) {
    const seen = jurisdictionByCode.get(line.code);
    if (seen !== undefined && seen !== line.jurisdiction) ambiguousCode = true;
    jurisdictionByCode.set(line.code, line.jurisdiction);
  }

  const allocation = allocateRefundTaxSharesByLine(
    ticketItems,
    order.taxAmountCents,
    taxLines,
  );
  if (allocation.lineMismatch) problems.push("line_mismatch");
  if (ambiguousCode) problems.push("ambiguous_line_code");

  const perLine = new Map<string, number>();
  let unattributedCents = 0;
  for (const item of refunded) {
    if (item.refundedTaxCents === null) {
      problems.push(`null_stamp:${item.id}`);
      continue;
    }
    const shares: Array<[string, number]> = [];
    for (const [code, byItem] of allocation.byLine) {
      shares.push([code, byItem.get(item.id) ?? 0]);
    }
    const sharesTotal = shares.reduce((sum, [, cents]) => sum + cents, 0);
    if (
      allocation.lineMismatch ||
      ambiguousCode ||
      shares.length === 0 ||
      sharesTotal !== item.refundedTaxCents
    ) {
      if (!allocation.lineMismatch && !ambiguousCode) {
        problems.push(`share_mismatch:${item.id}`);
      }
      unattributedCents += item.refundedTaxCents;
      continue;
    }
    for (const [code, cents] of shares) {
      perLine.set(code, (perLine.get(code) ?? 0) + cents);
    }
  }

  return {
    byLine: [...perLine].map(([code, cents]) => ({
      code,
      jurisdiction: jurisdictionByCode.get(code) ?? "",
      cents,
    })),
    unattributedCents,
    problems,
  };
}
