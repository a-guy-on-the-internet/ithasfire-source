import { z } from "zod";

import { fail } from "@th/errors";
import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import { CURSOR_MAX_LIMIT } from "@th/ports/pagination";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { PAYEE_DEBT_READ_ROLES } from "./list-payee-debt-positions";

// ─────────────────────────────────────────────────────────────────────────────
// listUnrecoveredCashDebts — the staff "Unpaid cash balances" read model
// (spec 2026-10-07 door-sales-same-price-and-tax, R6 / FR-013).
//
// A door cash sale leaves the tax with the organiser (the platform fee too,
// for a sale recorded before the owner ruling of 2026-10-08), and the
// ledger records that as a CASH_SALE_DEBIT on the organisation's payee. The
// payout batch recovers it from later card/online revenue. An organiser who
// sells only cash never has any, and their placeholder payee has no Stripe
// account to pay out to, so the debt sits there. This lists every payee
// whose cash-sale debt has gone unrecovered for MORE THAN 30 DAYS, so staff
// can collect it by hand.
//
// "Unrecovered for more than 30 days" (the adapter header has the proof):
// per payee and currency, later credits pay the oldest debits first (FIFO,
// any debit type), a refund/cancel reversal cancels its own debit rather
// than paying an older one, and the part of a cash debit that FIFO leaves
// unpaid counts once the debit is more than 30 days old (`createdAt <
// now − 30 days`). Equivalently: the newest debits that together make up the
// negative balance are what is still owed, and a listed payee is one whose
// cash debits inside that tail include one older than the cutoff.
//
// Card-refund clawbacks and lost disputes are NOT cash debt; they live on
// the "Payees in debt" view (`list-payee-debt-positions.ts`), which this
// complements.
//
// Roles: ADMIN | SUPPORT, the same read set as "Payees in debt", enforced
// HERE (STAFF_ONLY); the transport checks only that an actor exists.
// Read-only.
// ─────────────────────────────────────────────────────────────────────────────

/** FR-013: a cash debit unrecovered for MORE than this many days is listed. */
export const CASH_DEBT_OVERDUE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Statement budget for the ledger read, same reasoning and value as the
 * "Payees in debt" view: past this the adapter surfaces SERVICE_UNAVAILABLE
 * and the page renders an inline "timed out — try again".
 */
export const UNRECOVERED_CASH_DEBT_STATEMENT_TIMEOUT_MS = 8_000;

export type ListUnrecoveredCashDebtsDeps = {
  repos: Pick<Repos, "payeeLedger">;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
};

export const listUnrecoveredCashDebtsInputSchema = z
  .object({
    actorHumanId: z.string().min(1),
    cursor: z.string().min(1).max(2_000).nullable().optional(),
    limit: z.number().int().min(1).max(CURSOR_MAX_LIMIT).optional(),
  })
  .strict();

export type ListUnrecoveredCashDebtsInput = z.infer<
  typeof listUnrecoveredCashDebtsInputSchema
>;

export const unrecoveredCashDebtSchema = z
  .object({
    payeeId: z.string(),
    subjectType: z.enum(["ORGANIZATION", "HUMAN"]),
    subjectId: z.string(),
    /** Null for a HUMAN payee or a missing organisation row. */
    orgName: z.string().nullable(),
    /** For the `/admin/<slug>` link; null when there is no organisation. */
    orgSlug: z.string().nullable(),
    currency: z.string(),
    /** Cash-sale debt not yet recovered, any age (cents). */
    unrecoveredCashDebtCents: z.number().int().positive(),
    /** The part from cash sales more than 30 days old (cents). */
    overdueCashDebtCents: z.number().int().positive(),
    /** When the oldest still-unrecovered cash sale debit was written. */
    oldestUnrecoveredAt: z.date(),
    /**
     * False = no connected Stripe account (the placeholder payee a first
     * cash sale creates): the ledger can never recover this by netting a
     * payout, so collecting by hand is the only way.
     */
    hasStripeAccount: z.boolean(),
    payoutsEnabled: z.boolean(),
    /** The payable as the payout batch sees it (holds included). */
    payableCents: z.number().int(),
  })
  .strict();

export type UnrecoveredCashDebt = z.infer<typeof unrecoveredCashDebtSchema>;

export const listUnrecoveredCashDebtsOutputSchema = z
  .object({
    items: z.array(unrecoveredCashDebtSchema),
    nextCursor: z.string().min(1).nullable(),
    /** Payees at or after the cursor; the grand total on the first page. */
    total: z.number().int().nonnegative(),
    /** The cutoff used: cash debits written before this instant are overdue. */
    overdueBefore: z.date(),
  })
  .strict();

export type ListUnrecoveredCashDebtsOutput = z.infer<
  typeof listUnrecoveredCashDebtsOutputSchema
>;

export async function listUnrecoveredCashDebts(
  deps: ListUnrecoveredCashDebtsDeps,
  rawInput: unknown,
): Promise<ListUnrecoveredCashDebtsOutput> {
  const input = parseInput(listUnrecoveredCashDebtsInputSchema, rawInput);

  const staffCheck = await deps.authz.hasStaffRole({
    actorHumanId: input.actorHumanId,
    requiredRoles: PAYEE_DEBT_READ_ROLES,
  });
  if (!staffCheck.allowed) {
    throw fail("STAFF_ONLY");
  }

  const now = deps.clock.now();
  const overdueBefore = new Date(
    now.getTime() - CASH_DEBT_OVERDUE_DAYS * DAY_MS,
  );

  const page = await deps.repos.payeeLedger.listUnrecoveredCashDebts({
    now,
    olderThan: overdueBefore,
    cursor: input.cursor ?? null,
    limit: input.limit,
    statementTimeoutMs: UNRECOVERED_CASH_DEBT_STATEMENT_TIMEOUT_MS,
  });

  return {
    items: page.items.map((r) => ({
      payeeId: r.payeeId,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      orgName: r.orgName,
      orgSlug: r.orgSlug,
      currency: r.currency,
      unrecoveredCashDebtCents: r.unrecoveredCashDebtCents,
      overdueCashDebtCents: r.overdueCashDebtCents,
      oldestUnrecoveredAt: r.oldestUnrecoveredAt,
      hasStripeAccount: r.hasStripeAccount,
      payoutsEnabled: r.payoutsEnabled,
      payableCents: r.payableCents,
    })),
    nextCursor: page.pageInfo.nextCursor,
    total: page.total,
    overdueBefore,
  };
}
