import { z } from "zod";

import { fail } from "@th/errors";
import type { AuthZPort, HumanRole } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import {
  ownerNamingFor,
  resolvePayeeIdentities,
} from "./_shared/payee-identity";
// The batch's OWN default, imported rather than retyped: a second literal
// here could drift and make the page disagree with the job about which rows
// get skipped tonight.
import { DEFAULT_PAYOUT_MINIMUM_CENTS } from "../settlements/run-batch";

// ─────────────────────────────────────────────────────────────────────────────
// listPayablePositions — the staff "what we OWE" read model.
//
// TWO NUMBERS, NEVER ONE. This is the single thing the whole file exists to
// protect:
//
//   * PAYABLE — `payeeLedger.listPayableBalances(now)`. "What can tonight's
//     batch actually send?" Maturity-filtered, dispute-aware, claim-aware.
//   * LIABILITY — `payeeLedger.sumOutstandingLiability()`. "What do we owe,
//     ever?" No maturity filter at all, and no blocked-credit exclusion.
//
// A SETTLEMENT_CREDIT for an event three weeks out is absent from the first
// and present in the second, and it is the organiser's money either way.
// Reporting the payable AS the liability would show the platform solvent
// while it was insolvent — the port comment on `sumOutstandingLiability`
// says so in as many words — so the two ride SEPARATE fields on this output
// and the UI labels them so a reader cannot mistake one for the other. They
// are never summed, never merged, never derived from one another.
//
// AGREEMENT WITH THE BATCH is structural, not a convention: the rows here
// come from `listPayableBalances(now)`, the very method
// `settlements/run-batch.ts` plans from, with the very same
// `payableCents > 0` filter it applies (`positivePayables`). This view and
// the batch read the same number from the same function.
//
// BUT THE PAYABLE IS THE BATCH'S INPUT, NOT ITS OUTPUT, and saying otherwise
// is the easiest lie this page can tell. Between this number and money
// leaving the platform, `runPayoutBatch` applies four more gates:
//
//   1. the payout MINIMUM (`payoutMinimumCents` on the GLOBAL fee policy,
//      default `DEFAULT_PAYOUT_MINIMUM_CENTS`) — run-batch.ts §2;
//   2. the per-run PAYEE CAP (`input.limit`) — a deferred payee is paid the
//      next night, and this view has no way to know tonight's cap;
//   3. ELIGIBILITY — `payee_not_found` / `payee_missing_stripe_account` /
//      `payee_payouts_disabled` — run-batch.ts §3;
//   4. transfer-time WITHHOLDING — what reaches Stripe is the item's
//      `plannedNetCents`, not the payable.
//
// So this view reports the LEDGER BALANCE and, per row, flags the two gates
// it can evaluate without guessing (1 and 3). The cap is deliberately NOT
// modelled — it depends on a batch argument, and a flag that is wrong on
// some nights is worse than no flag. The copy says "before the batch's
// minimum, eligibility checks and withholding" rather than "what will be
// sent".
//
// Roles: ADMIN | SUPPORT — the same STAFF_ONLY read set as the sibling
// "Payees in debt" view (`list-payee-debt-positions.ts`), enforced HERE; the
// transport checks only that an actor exists.
// ─────────────────────────────────────────────────────────────────────────────

export const PAYABLE_POSITIONS_READ_ROLES: HumanRole[] = ["ADMIN", "SUPPORT"];

/**
 * Budget for the two whole-ledger aggregates behind this view. Past this the
 * adapter surfaces SERVICE_UNAVAILABLE and the UI renders an inline
 * "timed out — try again" instead of hanging the settlements page. Same 8s
 * as the debt view, for the same reasons.
 */
export const PAYABLE_POSITIONS_STATEMENT_TIMEOUT_MS = 8_000;

/**
 * Hard row cap. `listPayableBalances` takes `asOf` and an optional
 * `payeeIds` — it does NOT page, because the payout batch wants the whole
 * feed in one read — so rather than invent a cursor over a non-paging
 * query, this view truncates at a documented limit and SAYS SO
 * (`truncated`, `rowLimit` on the output; a banner in the UI).
 *
 * The truncation is display-only and cannot mislead: the per-currency
 * `payableTotals` and the liability totals are computed over EVERY cell the
 * ledger returned, not over the visible page. A reader looking at a
 * truncated list still sees the correct grand totals.
 *
 * 200 matches the adapter's own `DEBT_MAX_LIMIT` ceiling, so the two
 * sections of the page cap at the same size.
 */
export const PAYABLE_POSITIONS_MAX_ROWS = 200;

export type ListPayablePositionsDeps = {
  repos: Pick<
    Repos,
    "payeeLedger" | "payees" | "organizations" | "humans" | "feePolicies"
  >;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Reports the best-effort owner-identity lookup failure. */
  reportError?: ReporterPort;
};

async function requireStaff(
  deps: ListPayablePositionsDeps,
  actorHumanId: string,
): Promise<void> {
  const staffCheck = await deps.authz.hasStaffRole({
    actorHumanId,
    requiredRoles: PAYABLE_POSITIONS_READ_ROLES,
  });
  if (!staffCheck.allowed) {
    throw fail("STAFF_ONLY");
  }
}

export const listPayablePositionsInputSchema = z
  .object({ actorHumanId: z.string().min(1) })
  .strict();

export type ListPayablePositionsInput = z.infer<
  typeof listPayablePositionsInputSchema
>;

const subjectTypeSchema = z.enum(["ORGANIZATION", "HUMAN"]);

export const payablePositionSchema = z
  .object({
    payeeId: z.string(),
    /** Null when the Payee row is missing or the identity lookup failed. */
    subjectType: subjectTypeSchema.nullable(),
    subjectId: z.string().nullable(),
    /** Best-effort display name; null when the human/org lookup misses. */
    ownerLabel: z.string().nullable(),
    /** Organisation slug for the `/admin/<slug>` link; null for humans. */
    ownerSlug: z.string().nullable(),
    currency: z.string(),
    /** POSITIVE — exactly what the batch would send this cell tonight. */
    payableCents: z.number().int().positive(),
    /**
     * Maturity date of the OLDEST matured, unblocked credit in the cell —
     * "how long has this payee been waiting?". Null when the positive
     * balance comes from non-credit entries only.
     */
    oldestMaturedAt: z.date().nullable(),
    /**
     * The cell is below the batch's payout minimum, so tonight's run skips it
     * and carries it forward (`run-batch.ts` §2, `itemsSkippedBelowMinimum`).
     * Without this, a $4.00 row sits under a headline about money going out
     * and is the most misleading line on the page.
     *
     * NULL = UNKNOWN, not "no". The fee-policy read is best-effort (a policy
     * outage must not hide money the ledger returned), and a boolean with no
     * unknown state would silently fall through to `false` — or worse, mark
     * rows "below minimum" against a threshold nobody actually read. The UI
     * renders null as "Could not check".
     */
    belowMinimum: z.boolean().nullable(),
    /**
     * Why the batch's eligibility gate (§3) would skip this cell, or null if
     * it would pass. The three reasons are the batch's own, verbatim, so the
     * page and the job name the same condition.
     *
     * Null when the identity lookup degraded — unknown is reported as
     * `ineligibleReason: null` with `identityResolved: false`, never as
     * "eligible". Claiming a payee is payable when we could not check is the
     * dangerous direction.
     */
    ineligibleReason: z
      .enum([
        "payee_not_found",
        "payee_missing_stripe_account",
        "payee_payouts_disabled",
      ])
      .nullable(),
    /**
     * False when the best-effort payee/owner lookup failed, so `subjectType`,
     * the labels AND `ineligibleReason` are all unknown rather than absent.
     */
    identityResolved: z.boolean(),
  })
  .strict();

export type PayablePosition = z.infer<typeof payablePositionSchema>;

export const payableCurrencyTotalSchema = z
  .object({
    currency: z.string(),
    /** Σ payable over EVERY positive cell, not just the visible page. */
    payableCents: z.number().int().nonnegative(),
    cellCount: z.number().int().nonnegative(),
  })
  .strict();

export const outstandingLiabilityTotalSchema = z
  .object({
    currency: z.string(),
    /**
     * Σ over payees of `max(0, signed entry sum)` at ANY maturity. The
     * per-payee clamp is load-bearing — one payee's debt does not fund
     * another payee's credit.
     */
    unpaidCreditsCents: z.number().int(),
    /** Rolling reserve withheld from past payouts. Deferred payout, still owed. */
    reserveHeldCents: z.number().int(),
    /** Cents held against open disputes. Owed to the payee or to the network. */
    pendingHoldCents: z.number().int(),
    /**
     * `unpaidCredits + reserveHeld + pendingHold`. Summed HERE rather than in
     * the adapter so the three components stay separately visible: they carry
     * different certainty, and a human triaging a thin balance needs to see
     * which one moved.
     */
    totalOwedCents: z.number().int(),
  })
  .strict();

export const listPayablePositionsOutputSchema = z
  .object({
    /** Positive payable cells, oldest-waiting money first. Capped; see `truncated`. */
    items: z.array(payablePositionSchema),
    /** Positive cells the ledger returned, before the display cap. */
    total: z.number().int().nonnegative(),
    /** True when `items` was cut at `rowLimit`. Totals are still complete. */
    truncated: z.boolean(),
    rowLimit: z.number().int().positive(),
    /** PAYABLE NOW, per currency. What tonight's batch would send. */
    payableTotals: z.array(payableCurrencyTotalSchema),
    /**
     * TOTAL OWED, per currency. NEVER derived from `payableTotals` — a
     * separate ledger query with no maturity filter. See the file header.
     */
    liabilityTotals: z.array(outstandingLiabilityTotalSchema),
    /**
     * The payout minimum the `belowMinimum` flags were evaluated against —
     * the GLOBAL fee policy's `payoutMinimumCents`, or the batch's own
     * default when the policy read returns no row. Returned so the UI can
     * NAME the threshold instead of asserting one.
     *
     * NULL when the policy read FAILED, which is a different thing from
     * "no policy exists": the latter has a defined answer (the batch's
     * default), the former has none.
     */
    payoutMinimumCents: z.number().int().nonnegative().nullable(),
    /**
     * False when the fee-policy read failed. Every `belowMinimum` is then
     * null and the UI says so, rather than measuring rows against a
     * threshold nobody read.
     */
    minimumResolved: z.boolean(),
    /** The payable clock these numbers were evaluated at. */
    asOf: z.date(),
  })
  .strict();

export type ListPayablePositionsOutput = z.infer<
  typeof listPayablePositionsOutputSchema
>;

type IneligibleReason =
  | "payee_not_found"
  | "payee_missing_stripe_account"
  | "payee_payouts_disabled";

export async function listPayablePositions(
  deps: ListPayablePositionsDeps,
  rawInput: unknown,
): Promise<ListPayablePositionsOutput> {
  const input = parseInput(listPayablePositionsInputSchema, rawInput);
  await requireStaff(deps, input.actorHumanId);

  const asOf = deps.clock.now();
  const budget = {
    statementTimeoutMs: PAYABLE_POSITIONS_STATEMENT_TIMEOUT_MS,
  };

  // The two ledger reads are issued together but stay two answers. Neither is
  // derived from the other; see the file header. The fee policy rides along
  // for the payout minimum — the same read `run-batch.ts` §2 makes, so the
  // threshold this page names is the threshold the batch applies.
  //
  // The fee-policy read is BEST-EFFORT and the two ledger reads are not. A
  // policy outage must not blank a panel whose whole job is to show what the
  // platform owes — the money is right there in both ledger answers. But it
  // degrades HONESTLY: swallowing to the batch's default would mark rows
  // "Below minimum" against a threshold nobody read, which is a false
  // accusation dressed as a fact. Unresolved ⇒ `payoutMinimumCents: null`,
  // every `belowMinimum: null`, and the UI says "Could not check".
  const [payables, liability, policyResult] = await Promise.all([
    deps.repos.payeeLedger.listPayableBalances(asOf, undefined, budget),
    deps.repos.payeeLedger.sumOutstandingLiability(budget),
    deps.repos.feePolicies
      .resolveEffective({ scopeType: "GLOBAL", scopeId: null, at: asOf })
      .then(
        (policy) => ({ ok: true as const, policy }),
        (err: unknown) => ({ ok: false as const, err }),
      ),
  ]);

  const minimumResolved = policyResult.ok;
  if (!policyResult.ok) {
    deps.logger?.error("payable_positions_fee_policy_lookup_failed", {
      err: policyResult.err,
    });
    // GUARDED, same as the identity swallow below: a throwing reporter must
    // never turn a degraded panel into a failed one.
    try {
      deps.reportError?.(policyResult.err, {
        tags: { useCase: "listPayablePositions", step: "resolveFeePolicy" },
      });
    } catch {
      // Reporting is fire-and-forget.
    }
  }
  // No policy ROW is a defined answer (the batch falls back to its own
  // default, so the page must too). A failed READ is not.
  const payoutMinimumCents = policyResult.ok
    ? (policyResult.policy?.payoutMinimumCents ?? DEFAULT_PAYOUT_MINIMUM_CENTS)
    : null;

  // EXACTLY the batch's filter (`run-batch.ts`: `payableCents > 0`). Negative
  // cells are debt positions and belong to the sibling "Payees in debt"
  // section, which explains them properly; listing them here as a negative
  // "owed" would double-report the same cell in two sections with opposite
  // meanings. Order is preserved as the adapter returned it —
  // `oldestMaturedAt` ASC, nulls last — because that IS the batch's payment
  // order, and it is what makes the cap fair rather than a fixed prefix.
  const positive = payables.filter((cell) => cell.payableCents > 0);

  const payableTotals = new Map<
    string,
    { currency: string; payableCents: number; cellCount: number }
  >();
  for (const cell of positive) {
    const row = payableTotals.get(cell.currency) ?? {
      currency: cell.currency,
      payableCents: 0,
      cellCount: 0,
    };
    // Integer cents only; currencies never sum together.
    row.payableCents += cell.payableCents;
    row.cellCount += 1;
    payableTotals.set(cell.currency, row);
  }

  const truncated = positive.length > PAYABLE_POSITIONS_MAX_ROWS;
  const pageCells = truncated
    ? positive.slice(0, PAYABLE_POSITIONS_MAX_ROWS)
    : positive;

  // Identity is BEST-EFFORT, all of it — the Payee subject join as well as
  // the org/human display name. A naming or lookup outage must never hide
  // money the platform owes: the amounts and the totals are what a solvency
  // read is for, and the payee id is still on every row. Swallow + report
  // (ReporterPort convention, CLAUDE.md) — the posture, and the partial-
  // success ordering that keeps `identityResolved` true when only the LABEL
  // read failed, live in `_shared/payee-identity.ts` so the sibling
  // "Upcoming payouts" view degrades identically.
  const identities = await resolvePayeeIdentities(
    deps,
    pageCells.map((c) => c.payeeId),
    {
      logEvent: "payable_positions_owner_lookup_failed",
      useCase: "listPayablePositions",
      step: "attachOwners",
    },
  );
  const { identityResolved, subjects } = identities;

  // The batch's §3 verdict per payee, computed from the SAME `PayeeRecord`
  // fields and in the SAME order the batch checks them. Deliberately NOT in
  // the shared helper: it is payout-batch policy, not naming, and this is
  // its only caller. Computed from the resolved subjects, so a lookup
  // failure leaves the map empty and every verdict reads as unknown below.
  const ineligibility = new Map<string, IneligibleReason>();
  if (identityResolved) {
    for (const [payeeId, subject] of subjects) {
      const reason = !subject.stripeAccountId
        ? "payee_missing_stripe_account"
        : !subject.payoutsEnabled
          ? "payee_payouts_disabled"
          : null;
      if (reason) ineligibility.set(payeeId, reason);
    }
    // A payable cell whose Payee row does not exist is the batch's
    // `payee_not_found` — an orphaned ledger cell that can never be paid.
    // It must SHOW, flagged, not silently read as payable.
    for (const cell of pageCells) {
      if (!subjects.has(cell.payeeId)) {
        ineligibility.set(cell.payeeId, "payee_not_found");
      }
    }
  }

  const items: PayablePosition[] = pageCells.map((cell) => {
    const subject = subjects.get(cell.payeeId) ?? null;
    const naming = ownerNamingFor(identities, cell.payeeId);
    return {
      payeeId: cell.payeeId,
      subjectType: subject?.subjectType ?? null,
      subjectId: subject?.subjectId ?? null,
      ownerLabel: naming?.label ?? null,
      ownerSlug: naming?.slug ?? null,
      currency: cell.currency,
      payableCents: cell.payableCents,
      oldestMaturedAt: cell.oldestMaturedAt,
      belowMinimum:
        payoutMinimumCents === null
          ? null
          : cell.payableCents < payoutMinimumCents,
      // Unknown identity ⇒ unknown eligibility. Reported as null WITH
      // `identityResolved: false`, never as "eligible".
      ineligibleReason: identityResolved
        ? (ineligibility.get(cell.payeeId) ?? null)
        : null,
      identityResolved,
    };
  });

  return {
    items,
    total: positive.length,
    truncated,
    rowLimit: PAYABLE_POSITIONS_MAX_ROWS,
    payableTotals: [...payableTotals.values()].sort((a, b) =>
      a.currency.localeCompare(b.currency),
    ),
    payoutMinimumCents,
    minimumResolved,
    liabilityTotals: liability.map((row) => ({
      currency: row.currency,
      unpaidCreditsCents: row.unpaidCreditsCents,
      reserveHeldCents: row.reserveHeldCents,
      pendingHoldCents: row.pendingHoldCents,
      totalOwedCents:
        row.unpaidCreditsCents + row.reserveHeldCents + row.pendingHoldCents,
    })),
    asOf,
  };
}
