import { z } from "zod";

import { fail } from "@th/errors";
import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { callOrDependencyFailed, parseInput } from "../../lib/io";

// ─────────────────────────────────────────────────────────────────────────────
// getOwnerPayoutSummary — the ONE-NUMBER "pending payout" headline on the
// admin dashboard, the payments page and the org-deletion warning.
//
// IT USED TO BE THE WRONG NUMBER. Until this change it read
// `orders.getPayoutSummaryForOrg` — `Σ OrderItem.amountCents WHERE status =
// 'active' AND paidOutAt IS NULL` — which is ticket GROSS FACE VALUE with no
// platform fee, no processor fee, no per-payee split, no refund debit, no
// dispute hold and no maturity term in it. It OVERSTATED what an organiser
// was owed, on three surfaces, including the one that warns them before they
// delete their org.
//
// It now reads THE LEDGER, which is where the money actually lives after the
// 2026-08-10 cutover: `PayeeLedgerBalance.ledgerBalanceCents` for the org's
// (or human's) payee. That is the same headline `getPayeeStatement` calls
// `balanceCents` — EVERYTHING owed, matured or not — so the dashboard tile
// and the organiser's statement now agree by construction instead of by
// coincidence.
//
// WHY THE BALANCE AND NOT THE PAYABLE. The payable is maturity-filtered:
// credits for an event three weeks out are absent from it and present in the
// balance, and they are the organiser's money either way. A tile labelled
// "pending payout" that read the payable would drop to zero the moment a
// show sold out and climb back on maturity night, which reads as money
// vanishing. The payable/upcoming distinction belongs on the payouts page
// (`getOrgPayoutOverview`), which has the room to label both.
//
// UNKNOWN IS NEVER ZERO. Every figure is NULLABLE and `resolved` says which
// state you are in. The old shape could not express "we could not check", so
// `DashboardContent` rendered a confident $0.00 for a failed query and
// `OrgDangerSection` rendered "no pending payouts" — and ENABLED the delete
// button — for one. Both are now told.
//
// BOTH OWNER PATHS MOVED TOGETHER. Org and human differ only in which subject
// the payee hangs off; leaving the human path on the order-item aggregate
// would have left the same overstated number on the same three pages for a
// solo organiser. One read, two subjects.
//
// Roles: `canFinanceOrg` on the org path, enforced HERE. The human path needs
// no probe because the subject IS the actor — the input carries no human id,
// so there is no way to name someone else's payee.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ceiling on the "N items awaiting payout" count.
 *
 * The ledger exposes no COUNT over this filter set, so the count is measured
 * by reading the unconsumed SETTLEMENT_CREDIT rows with a bound. A payee with
 * more than this reports exactly this many with `itemCountExact: false` — the
 * count is then a FLOOR, and a consumer that renders it must say "N+". It is
 * never allowed to silently round a larger number down.
 *
 * Deliberately not a second ledger aggregate: this figure is a caption, and
 * adding a whole-ledger COUNT query to a dashboard tile to make a caption
 * exact is the wrong trade.
 */
export const OWNER_PAYOUT_SUMMARY_MAX_COUNTED_ITEMS = 200;

/** Currency reported when there is no Payee row to ask. Cosmetic: every
 * figure alongside it is a resolved zero. */
const FALLBACK_SUMMARY_CURRENCY = "usd";

/** Mirrors the adapter's `normalizeCurrency`, so cells always match. */
const normaliseCurrency = (currency: string) => currency.trim().toLowerCase();

export const getOwnerPayoutSummaryInputSchema = z
  .object({
    actorHumanId: z.string().uuid(),
    /** Provide orgId for org-owned events, omit for human-owned events. */
    orgId: z.string().uuid().optional(),
  })
  .strict();

export const getOwnerPayoutSummaryOutputSchema = z
  .object({
    /**
     * `PayeeLedgerBalance.ledgerBalanceCents` — everything owed to this owner,
     * matured or not, net of fees, splits, refunds, disputes and payouts
     * already sent.
     *
     * SIGNED. A NEGATIVE value is a real debt position (refunds or a lost
     * dispute exceeded the credits): the batch sends nothing and the debt is
     * recouped from the next credits to mature. Clamping it to 0 here would
     * hide that from the one person who needs to know, so the clamp stays
     * with the batch.
     *
     * NULL = COULD NOT CHECK. Never render it as 0.
     */
    pendingPayoutCents: z.number().int().nullable(),
    /**
     * Unconsumed SETTLEMENT_CREDIT rows behind that balance — "N items
     * awaiting payout". A FLOOR when `itemCountExact` is false. NULL = could
     * not check; never render it as 0, and never test `> 0` against it
     * without handling null, or "unknown" silently becomes "none".
     */
    pendingItemCount: z.number().int().nonnegative().nullable(),
    /**
     * False when the count hit `OWNER_PAYOUT_SUMMARY_MAX_COUNTED_ITEMS`, so
     * `pendingItemCount` is a floor and the copy must read "N+".
     */
    itemCountExact: z.boolean(),
    /** The payee's `defaultCurrency`; both figures above are in it. */
    currency: z.string().min(1),
    /**
     * False when a ledger read FAILED: both figures above are null and the UI
     * must say "could not check". TRUE with zeros is a different and
     * perfectly normal state — an owner who has never been owed anything.
     */
    resolved: z.boolean(),
    /**
     * False when this owner has NO Payee row at all: they have never
     * onboarded to Stripe, so there is nothing to pay out and nothing failed.
     * `resolved` is TRUE and both figures are 0.
     */
    hasPayee: z.boolean(),
  })
  .strict();

export type GetOwnerPayoutSummaryInput = z.infer<
  typeof getOwnerPayoutSummaryInputSchema
>;
export type GetOwnerPayoutSummaryOutput = z.infer<
  typeof getOwnerPayoutSummaryOutputSchema
>;

export type GetOwnerPayoutSummaryDeps = {
  repos: Pick<Repos, "payees" | "payeeLedger">;
  authz: Pick<AuthZPort, "canFinanceOrg">;
  logger?: LoggerPort;
  /**
   * Reports the best-effort ledger swallow. Guarded — a throwing or missing
   * reporter never changes the result.
   */
  reportError?: ReporterPort;
};

/** The resolved-and-empty summary for an owner with no Payee row. */
const noPayeeSummary = (): GetOwnerPayoutSummaryOutput => ({
  pendingPayoutCents: 0,
  pendingItemCount: 0,
  itemCountExact: true,
  currency: FALLBACK_SUMMARY_CURRENCY,
  resolved: true,
  hasPayee: false,
});

export async function getOwnerPayoutSummary(
  deps: GetOwnerPayoutSummaryDeps,
  rawInput: unknown,
): Promise<GetOwnerPayoutSummaryOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "getOwnerPayoutSummary" });

  const execute = async (): Promise<GetOwnerPayoutSummaryOutput> => {
    const input = parseInput(getOwnerPayoutSummaryInputSchema, rawInput);

    if (input.orgId) {
      // Org path: verify the actor can view org finances.
      const permission = await callOrDependencyFailed(
        () =>
          deps.authz.canFinanceOrg({
            actorHumanId: input.actorHumanId,
            orgId: input.orgId!,
          }),
        scopedLogger,
        {
          action: "authz.canFinanceOrg",
          orgId: input.orgId,
          actorHumanId: input.actorHumanId,
        },
      );
      if (!permission.allowed) {
        throw fail("FORBIDDEN");
      }
    }
    // Human path: the actor IS the owner — no org-level authz needed, and no
    // way to name another human's payee.

    const subject = input.orgId
      ? ({ type: "ORGANIZATION", id: input.orgId } as const)
      : ({ type: "HUMAN", id: input.actorHumanId } as const);

    const payeeRef = await callOrDependencyFailed(
      () => deps.repos.payees.getBySubject(subject),
      scopedLogger,
      { action: "repos.payees.getBySubject", subjectType: subject.type },
    );
    // NOT an error, and NOT "unknown": an owner with no Payee row has never
    // onboarded to Stripe, which is the common state for a new org.
    if (!payeeRef) return noPayeeSummary();

    const payee = await callOrDependencyFailed(
      () => deps.repos.payees.getById(payeeRef.id),
      scopedLogger,
      { action: "repos.payees.getById", payeeId: payeeRef.id },
    );
    if (!payee) {
      // The row vanished between the two reads. Treated as "no payee": the
      // summary is still true, and a race must not 500 a dashboard.
      scopedLogger?.error("owner_payout_summary_payee_row_missing", {
        payeeId: payeeRef.id,
      });
      return noPayeeSummary();
    }

    const currency = normaliseCurrency(payee.defaultCurrency);

    // ── The ledger reads: BEST-EFFORT, degrading to UNKNOWN ────────────────
    // This is a supporting tile on three pages that all render other things.
    // Failing the whole query would blank a dashboard; reporting unknown
    // costs one tile and tells the truth. Both reads share one flag: there is
    // no useful state where the balance is known and the count is not.
    try {
      const [balance, creditRows] = await Promise.all([
        deps.repos.payeeLedger.getBalance(payeeRef.id, currency),
        // One row OVER the cap, purely to MEASURE whether the count is exact.
        deps.repos.payeeLedger.listEntries(payeeRef.id, {
          currency,
          types: ["SETTLEMENT_CREDIT"],
          unconsumedOnly: true,
          limit: OWNER_PAYOUT_SUMMARY_MAX_COUNTED_ITEMS + 1,
        }),
      ]);
      const itemCountExact =
        creditRows.length <= OWNER_PAYOUT_SUMMARY_MAX_COUNTED_ITEMS;
      return {
        pendingPayoutCents: balance.ledgerBalanceCents,
        pendingItemCount: itemCountExact
          ? creditRows.length
          : OWNER_PAYOUT_SUMMARY_MAX_COUNTED_ITEMS,
        itemCountExact,
        currency,
        resolved: true,
        hasPayee: true,
      };
    } catch (err) {
      scopedLogger?.error("owner_payout_summary_ledger_read_failed", {
        err,
        payeeId: payeeRef.id,
      });
      // GUARDED: a MISSING or THROWING reporter must never change behaviour
      // (ReporterPort convention, CLAUDE.md).
      try {
        deps.reportError?.(err, {
          tags: { useCase: "getOwnerPayoutSummary", step: "readLedger" },
          extra: { payeeId: payeeRef.id },
        });
      } catch {
        // Reporting is fire-and-forget.
      }
      return {
        pendingPayoutCents: null,
        pendingItemCount: null,
        itemCountExact: false,
        currency,
        resolved: false,
        hasPayee: true,
      };
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("getOwnerPayoutSummary", execute);
  }
  return execute();
}
