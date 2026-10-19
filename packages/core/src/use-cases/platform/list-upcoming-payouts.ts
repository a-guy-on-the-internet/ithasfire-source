import { z } from "zod";

import { fail } from "@th/errors";
import type { AuthZPort, HumanRole } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
// THE debt walk, shared with the organiser-facing payouts view so the two are
// one implementation of the netting rather than two. See that module's header
// for why today's payable is the only netting a maturity forecast may apply.
import {
  addNullableCents,
  applyDebtNetting,
  payeeCurrencyCellKey,
  readDebtPositions,
} from "../payouts/_shared/maturity-netting";
import {
  ownerNamingFor,
  resolvePayeeIdentities,
} from "./_shared/payee-identity";

// ─────────────────────────────────────────────────────────────────────────────
// listUpcomingPayouts — the staff "WHEN does the rest go out" read model.
//
// /platform/settlements could already say what the platform OWES
// (`listPayablePositions`) and what it has PAID (`listPayoutHistory`). It
// could not say WHEN. This is that third question, and only that one.
//
// WHAT THE NUMBERS ARE: per (payee, currency, maturity date):
//
//   creditCents      — GROSS. The unblocked SETTLEMENT_CREDIT cents maturing
//                      on that date: exactly the credit rows the payable
//                      query EXCLUDES on maturity. Siblings over one ledger,
//                      never derived from each other.
//   debtAppliedCents — the part of this payee's NEGATIVE payable today
//                      (carried-forward debt) that this tranche is consumed
//                      by. Computed HERE from `listPayableBalances`,
//                      narrowed to the payees in the feed.
//   expectedCents    — max(0, creditCents − debtAppliedCents). What the batch
//                      would actually transfer for this tranche on that
//                      date, before the gates it only evaluates on the night.
//   heldCents        — ANNOTATION ONLY: how much of the tranche's credit is
//                      under an open dispute. Never subtracted (see below).
//
// THE DEBT WALK IS THE ONLY NETTING, AND WHY. Every non-credit entry —
// REFUND_DEBIT, PAYOUT, and a DISPUTE_HOLD too — is effective the moment it
// is written: debits and payouts reduce the payable directly, and a hold
// bumps the pending-hold rollup that the payable subtracts unconditionally
// every night. So all of them are ALREADY inside today's payable, and the
// one honest way to carry any of them into a future tranche is through that
// number: a payee whose payable is −10,000 today with +50,000 maturing
// receives 40,000, because the batch pays max(0, payable). Netting a debit
// or a hold against a tranche AS WELL counts it twice. The trace that made
// this a rule: credit 7,000 maturing 4 Oct under a 3,000 hold → payable
// today −3,000 → the batch pays 4,000; the walk says 7,000 − 3,000 = 4,000;
// "credit − hold − debt" said 1,000.
//
// The walk is per (payee, normalised currency), soonest tranche first,
// carrying any remainder forward — a debt larger than the first tranche eats
// into the second. Currencies never net against each other. `heldCents`
// rides along so the panel can say "X of this is under an open dispute —
// already counted in today's payable", attributed once per order.
//
// WHAT THEY STILL ARE NOT — and this remains the risk of the panel:
// `expectedCents` is NOT a promise. `runPayoutBatch` still applies the
// payout MINIMUM (§2), the per-run PAYEE CAP, the ELIGIBILITY checks (§3) and
// transfer-time WITHHOLDING, and a refund landing before the date shrinks
// the tranche. This forecasts MATURITY net of today's debt, not PAYMENT, and
// the copy must say so.
//
// One further gate IS applied, deliberately: blocked credits (open dispute
// with no hold / open resale claim) are excluded in SQL, so money that may
// end up with the network is never forecast as money going out to a payee.
// That is the opposite choice from `sumOutstandingLiability`, which keeps
// blocked credits because a liability figure must err HIGH while a payout
// forecast must not.
//
// UNKNOWN IS NEVER ZERO. If the payable read fails, the feed is still
// rendered (gross and the dispute annotation are known) but `debtResolved`
// is false and every debt-dependent figure — `debtAppliedCents`,
// `expectedCents`, `nextTrancheCents` — is NULL, so the UI shows "could not
// check debt" instead of a clean number that might be 10,000 too high.
// Identity is likewise best-effort and degrades to `identityResolved: false`
// WITHOUT dropping a row.
//
// Currencies never sum. Every figure is integer cents.
//
// Roles: ADMIN | SUPPORT — the same STAFF_ONLY read set as the sibling
// payout views, enforced HERE; the transport checks only that an actor
// exists.
// ─────────────────────────────────────────────────────────────────────────────

export const UPCOMING_PAYOUTS_READ_ROLES: HumanRole[] = ["ADMIN", "SUPPORT"];

/**
 * Budget for each of the two ledger reads behind this view (the maturity
 * scan and the narrowed payable read). Past this the adapter surfaces
 * SERVICE_UNAVAILABLE and the UI renders an inline "timed out — try again"
 * instead of hanging the settlements page. Same 8s as
 * `PAYABLE_POSITIONS_STATEMENT_TIMEOUT_MS`, for the same reasons.
 */
export const UPCOMING_PAYOUTS_STATEMENT_TIMEOUT_MS = 8_000;

/**
 * Hard row cap on the VISIBLE tranche list. `listUpcomingMaturities` does not
 * page (the forecast wants the whole horizon in one read), so rather than
 * invent a cursor over a non-paging query this view truncates at a documented
 * limit and says so (`truncated`, `rowLimit`).
 *
 * The truncation cannot mislead: `byDate`, `nextByPayee` and
 * `currencyTotals` are all computed over EVERY row the ledger returned, not
 * over the visible page, so a truncated list still carries correct totals.
 * 200 matches `PAYABLE_POSITIONS_MAX_ROWS` so the page's sections cap alike.
 */
export const UPCOMING_PAYOUTS_MAX_ROWS = 200;

export type ListUpcomingPayoutsDeps = {
  repos: Pick<Repos, "payeeLedger" | "payees" | "organizations" | "humans">;
  authz: Pick<AuthZPort, "hasStaffRole">;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Reports the two best-effort swallows: the owner-identity lookup and the
   * debt (payable) read. Guarded — a throwing or missing reporter never
   * changes the result.
   */
  reportError?: ReporterPort;
};

async function requireStaff(
  deps: ListUpcomingPayoutsDeps,
  actorHumanId: string,
): Promise<void> {
  const staffCheck = await deps.authz.hasStaffRole({
    actorHumanId,
    requiredRoles: UPCOMING_PAYOUTS_READ_ROLES,
  });
  if (!staffCheck.allowed) {
    throw fail("STAFF_ONLY");
  }
}

export const listUpcomingPayoutsInputSchema = z
  .object({ actorHumanId: z.string().min(1) })
  .strict();

export type ListUpcomingPayoutsInput = z.infer<
  typeof listUpcomingPayoutsInputSchema
>;

const subjectTypeSchema = z.enum(["ORGANIZATION", "HUMAN"]);

// ── Null semantics, stated once ─────────────────────────────────────────────
// `debtAppliedCents`, `expectedCents` (rows, byDate, currencyTotals) and
// `nextTrancheCents` are NULL exactly when the output's `debtResolved` is
// false — the payable read failed, so the debt netting could not run and no
// expected figure is honest. They are never null otherwise. `creditCents`
// and `heldCents` are always numbers: both come from the maturity read, and
// if THAT fails the whole use case throws (there is nothing to render).
//
// Schemas are typed as plain signed integers rather than `.nonnegative()` on
// purpose: they are enforced at the transport, so a single pathological row
// would 500 the WHOLE panel instead of showing one odd number. Blanking a
// money view is the worse failure.

export const upcomingPayoutTrancheSchema = z
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
    /** The credits' `availableAt`. Strictly after `asOf`. */
    maturesAt: z.date(),
    /**
     * GROSS: Σ unblocked SETTLEMENT_CREDIT cents maturing on that date for
     * that (payee, currency). Positive in practice — credits only.
     */
    creditCents: z.number().int(),
    /**
     * ANNOTATION ONLY. Σ ACTIVE DISPUTE_HOLD cents on the orders behind this
     * tranche, attributed once per order to the order's earliest tranche,
     * as written (unclamped). The hold is already inside today's payable and
     * reaches this row through `debtAppliedCents`; it is NEVER subtracted
     * here, and the UI must not invite a reader to subtract it either.
     */
    heldCents: z.number().int(),
    /**
     * The part of this payee's carried-forward debt (negative payable today)
     * that this tranche will be consumed by, soonest tranche first. Null iff
     * `debtResolved` is false.
     */
    debtAppliedCents: z.number().int().nullable(),
    /**
     * `max(0, creditCents − debtAppliedCents)`: what the batch would transfer
     * for this tranche before the gates it evaluates on the night (minimum,
     * cap, eligibility, withholding). Null iff `debtResolved` is false —
     * never a gross figure standing in for a net.
     */
    expectedCents: z.number().int().nullable(),
    /** How many credit rows make up the tranche. */
    creditCount: z.number().int().nonnegative(),
    /**
     * False when the best-effort payee/owner lookup failed, so `subjectType`
     * and the labels are unknown rather than absent. The money is unaffected.
     */
    identityResolved: z.boolean(),
  })
  .strict();

export type UpcomingPayoutTranche = z.infer<typeof upcomingPayoutTrancheSchema>;

export const upcomingPayoutsByDateSchema = z
  .object({
    maturesAt: z.date(),
    currency: z.string(),
    /** Σ gross over EVERY payee maturing on this date in this currency. */
    creditCents: z.number().int(),
    /** Null iff `debtResolved` is false. */
    debtAppliedCents: z.number().int().nullable(),
    /** Σ `expectedCents` over the bucket. Null iff `debtResolved` is false. */
    expectedCents: z.number().int().nullable(),
    /** Distinct payees in the (date, currency) bucket. */
    payeeCount: z.number().int().nonnegative(),
    creditCount: z.number().int().nonnegative(),
  })
  .strict();

export const upcomingPayoutNextByPayeeSchema = z
  .object({
    payeeId: z.string(),
    currency: z.string(),
    /** The EARLIEST upcoming maturity for this (payee, currency). */
    maturesAt: z.date(),
    /**
     * The FIRST tranche's `expectedCents` — NOT the payee's whole upcoming
     * total. Named `nextTrancheCents` rather than `amountCents` precisely so
     * it cannot be read as one: a payee with credits maturing on three dates
     * has three tranches, and only the soonest is here. For the full
     * upcoming figure, sum that payee's rows in `items` (or read
     * `currencyTotals` for the platform-wide number). Null iff
     * `debtResolved` is false.
     */
    nextTrancheCents: z.number().int().nullable(),
    /** The first tranche's gross, so the UI can say "of X credit". */
    creditCents: z.number().int(),
    /** The first tranche's dispute annotation (see the tranche schema). */
    heldCents: z.number().int(),
    /** Null iff `debtResolved` is false. */
    debtAppliedCents: z.number().int().nullable(),
  })
  .strict();

export const upcomingPayoutCurrencyTotalSchema = z
  .object({
    currency: z.string(),
    /** Σ gross over EVERY upcoming tranche in this currency, page cap ignored. */
    creditCents: z.number().int(),
    /** Null iff `debtResolved` is false. */
    debtAppliedCents: z.number().int().nullable(),
    /** Σ `expectedCents` over every tranche. Null iff `debtResolved` is false. */
    expectedCents: z.number().int().nullable(),
    /** (payee, currency, date) rows behind the total. */
    trancheCount: z.number().int().nonnegative(),
  })
  .strict();

export const listUpcomingPayoutsOutputSchema = z
  .object({
    /**
     * Upcoming tranches, soonest first (`maturesAt` ASC, then payeeId,
     * currency). Capped at `rowLimit`; see `truncated`. The aggregates below
     * are NOT capped.
     */
    items: z.array(upcomingPayoutTrancheSchema),
    /**
     * Per (date, currency) totals, ascending — what a "what goes out on
     * 4 Oct" reader needs. Computed over ALL rows. Carries no hold figure:
     * the annotation is per order and sums to nothing meaningful.
     */
    byDate: z.array(upcomingPayoutsByDateSchema),
    /**
     * Per (payeeId, currency), the EARLIEST upcoming maturity. The owed table
     * joins this by payeeId + currency to render an "Expected next" column.
     * Computed over ALL rows and deliberately NOT truncated — blanking the
     * column for a payee whose tranche fell off the visible page would read
     * as "nothing upcoming", which is the one thing it must never say.
     */
    nextByPayee: z.array(upcomingPayoutNextByPayeeSchema),
    /** Per-currency upcoming totals over ALL rows. Currencies never sum. */
    currencyTotals: z.array(upcomingPayoutCurrencyTotalSchema),
    /** Upcoming tranches the ledger returned, before the display cap. */
    total: z.number().int().nonnegative(),
    /** True when `items` was cut at `rowLimit`. Every total is still complete. */
    truncated: z.boolean(),
    rowLimit: z.number().int().positive(),
    /**
     * False when the payable read behind the debt netting FAILED. The feed
     * is still returned (gross and the dispute annotation are known), but
     * every debt-dependent figure is null and the UI must say "could not
     * check debt" rather than show a number.
     */
    debtResolved: z.boolean(),
    /** The clock the maturity cut was evaluated at. */
    asOf: z.date(),
  })
  .strict();

export type ListUpcomingPayoutsOutput = z.infer<
  typeof listUpcomingPayoutsOutputSchema
>;

/** Map key for a (date, currency) bucket. */
const dateKeyOf = (maturesAt: Date, currency: string) =>
  `${maturesAt.getTime()}|${currency}`;

export async function listUpcomingPayouts(
  deps: ListUpcomingPayoutsDeps,
  rawInput: unknown,
): Promise<ListUpcomingPayoutsOutput> {
  const input = parseInput(listUpcomingPayoutsInputSchema, rawInput);
  await requireStaff(deps, input.actorHumanId);

  const asOf = deps.clock.now();
  // `undefined` in the payee slot = EVERY payee. This is the staff read; the
  // organiser-facing view is the same call with its own payee ids.
  const rows = await deps.repos.payeeLedger.listUpcomingMaturities(
    asOf,
    undefined,
    { statementTimeoutMs: UPCOMING_PAYOUTS_STATEMENT_TIMEOUT_MS },
  );

  // ── Debt netting: consume each cell's negative payable, soonest first ─────
  // THE ONLY NETTING, and it lives in `payouts/_shared/maturity-netting.ts`
  // so the organiser view nets identically. Capacity is the GROSS;
  // `heldCents` is never an operand (the hold is already inside the payable
  // this debt came from).
  const debt = await readDebtPositions(deps, {
    asOf,
    payeeIds: rows.map((r) => r.payeeId),
    budget: { statementTimeoutMs: UPCOMING_PAYOUTS_STATEMENT_TIMEOUT_MS },
    telemetry: {
      logEvent: "upcoming_payouts_debt_lookup_failed",
      useCase: "listUpcomingPayouts",
      step: "applyDebt",
    },
  });

  const netted = applyDebtNetting(rows, debt);

  // ── Aggregates over EVERY row, computed BEFORE the display cap ───────────
  // Mirroring the sibling payable view: truncating first would make a long
  // horizon silently understate what is coming, which is the same class of
  // lie as reporting the payable as the liability.
  //
  // Null propagation is total, not per-bucket: `debtResolved` is one flag for
  // the whole read, so a bucket's debt/expected is null iff every row's is.
  const byDate = new Map<
    string,
    {
      maturesAt: Date;
      currency: string;
      creditCents: number;
      debtAppliedCents: number | null;
      expectedCents: number | null;
      creditCount: number;
      payees: Set<string>;
    }
  >();
  const nextByPayee = new Map<
    string,
    {
      payeeId: string;
      currency: string;
      maturesAt: Date;
      nextTrancheCents: number | null;
      creditCents: number;
      heldCents: number;
      debtAppliedCents: number | null;
    }
  >();
  const currencyTotals = new Map<
    string,
    {
      currency: string;
      creditCents: number;
      debtAppliedCents: number | null;
      expectedCents: number | null;
      trancheCount: number;
    }
  >();

  for (const row of netted) {
    const dateKey = dateKeyOf(row.maturesAt, row.currency);
    const bucket = byDate.get(dateKey) ?? {
      maturesAt: row.maturesAt,
      currency: row.currency,
      creditCents: 0,
      debtAppliedCents: 0,
      expectedCents: 0,
      creditCount: 0,
      payees: new Set<string>(),
    };
    // Integer cents; the bucket is per-currency so nothing sums across them.
    bucket.creditCents += row.creditCents;
    bucket.debtAppliedCents = addNullableCents(
      bucket.debtAppliedCents,
      row.debtAppliedCents,
    );
    bucket.expectedCents = addNullableCents(
      bucket.expectedCents,
      row.expectedCents,
    );
    bucket.creditCount += row.creditCount;
    bucket.payees.add(row.payeeId);
    byDate.set(dateKey, bucket);

    // EARLIEST only. The adapter returns `maturesAt` ASC, so the first row
    // seen for a cell already wins — the explicit comparison keeps that true
    // even if the ordering contract ever changes underneath.
    const cellKey = payeeCurrencyCellKey(row.payeeId, row.currency);
    const existing = nextByPayee.get(cellKey);
    if (!existing || row.maturesAt.getTime() < existing.maturesAt.getTime()) {
      nextByPayee.set(cellKey, {
        payeeId: row.payeeId,
        currency: row.currency,
        maturesAt: row.maturesAt,
        // The FIRST tranche's NET, never the payee's running total.
        nextTrancheCents: row.expectedCents,
        creditCents: row.creditCents,
        heldCents: row.heldCents,
        debtAppliedCents: row.debtAppliedCents,
      });
    }

    const total = currencyTotals.get(row.currency) ?? {
      currency: row.currency,
      creditCents: 0,
      debtAppliedCents: 0,
      expectedCents: 0,
      trancheCount: 0,
    };
    total.creditCents += row.creditCents;
    total.debtAppliedCents = addNullableCents(
      total.debtAppliedCents,
      row.debtAppliedCents,
    );
    total.expectedCents = addNullableCents(
      total.expectedCents,
      row.expectedCents,
    );
    total.trancheCount += 1;
    currencyTotals.set(row.currency, total);
  }

  const truncated = netted.length > UPCOMING_PAYOUTS_MAX_ROWS;
  const pageRows = truncated
    ? netted.slice(0, UPCOMING_PAYOUTS_MAX_ROWS)
    : netted;

  // Identity is BEST-EFFORT: a naming or lookup outage must never hide money
  // the platform is going to owe. Swallow + guarded report, shared with
  // `list-payable-positions.ts` so both panels degrade identically.
  const identities = await resolvePayeeIdentities(
    deps,
    pageRows.map((r) => r.payeeId),
    {
      logEvent: "upcoming_payouts_owner_lookup_failed",
      useCase: "listUpcomingPayouts",
      step: "attachOwners",
    },
  );

  const items: UpcomingPayoutTranche[] = pageRows.map((row) => {
    const subject = identities.subjects.get(row.payeeId) ?? null;
    const naming = ownerNamingFor(identities, row.payeeId);
    return {
      payeeId: row.payeeId,
      subjectType: subject?.subjectType ?? null,
      subjectId: subject?.subjectId ?? null,
      ownerLabel: naming?.label ?? null,
      ownerSlug: naming?.slug ?? null,
      currency: row.currency,
      maturesAt: row.maturesAt,
      creditCents: row.creditCents,
      heldCents: row.heldCents,
      debtAppliedCents: row.debtAppliedCents,
      expectedCents: row.expectedCents,
      creditCount: row.creditCount,
      identityResolved: identities.identityResolved,
    };
  });

  return {
    items,
    byDate: [...byDate.values()]
      .map((b) => ({
        maturesAt: b.maturesAt,
        currency: b.currency,
        creditCents: b.creditCents,
        debtAppliedCents: b.debtAppliedCents,
        expectedCents: b.expectedCents,
        payeeCount: b.payees.size,
        creditCount: b.creditCount,
      }))
      .sort(
        (a, b) =>
          a.maturesAt.getTime() - b.maturesAt.getTime() ||
          a.currency.localeCompare(b.currency),
      ),
    nextByPayee: [...nextByPayee.values()].sort(
      (a, b) =>
        a.maturesAt.getTime() - b.maturesAt.getTime() ||
        a.payeeId.localeCompare(b.payeeId) ||
        a.currency.localeCompare(b.currency),
    ),
    currencyTotals: [...currencyTotals.values()].sort((a, b) =>
      a.currency.localeCompare(b.currency),
    ),
    total: rows.length,
    truncated,
    rowLimit: UPCOMING_PAYOUTS_MAX_ROWS,
    debtResolved: debt.resolved,
    asOf,
  };
}
