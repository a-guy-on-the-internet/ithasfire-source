import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

// The batch's OWN default, imported rather than retyped: a second literal
// anywhere would drift and make an organiser-facing page disagree with the
// job about whether tonight's run skips them.
import { DEFAULT_PAYOUT_MINIMUM_CENTS } from "../../settlements/run-batch";

// ─────────────────────────────────────────────────────────────────────────────
// PAYOUT MINIMUM — the GLOBAL fee policy's `payoutMinimumCents`, read the one
// honest way, shared by the payout read models.
//
// LIFTED VERBATIM (in behaviour and in reasoning) FROM `get-payee-statement.ts`,
// which took it from `platform/list-payable-positions.ts`. Those two files each
// inline this block; this module exists so the ORGANISER SPINE
// (`get-org-payout-overview.ts`) does not become the THIRD copy. Migrating the
// other two onto it is a mechanical follow-up and deliberately not done in the
// same change that introduces the module.
//
// WHY THE READ IS BEST-EFFORT. The minimum is ONE LINE on a page whose other
// figures are already known and already true. A fee-policy outage must not
// blank a money page — it must blank the VERDICT and keep the money.
//
// THE DISTINCTION THIS MODULE EXISTS TO PROTECT — three states that must never
// collapse into each other:
//
//   * a policy row EXISTS      → its `payoutMinimumCents`.
//   * NO policy row exists     → `DEFAULT_PAYOUT_MINIMUM_CENTS`. This is a
//     DEFINED ANSWER, not a guess: `run-batch.ts` §2 falls back to exactly
//     this literal, so a page that reports it is reporting what the batch will
//     actually do tonight.
//   * the READ FAILED         → `payoutMinimumCents: null`,
//     `minimumResolved: false`, and NEVER the default. "No policy" has an
//     answer; "we could not ask" does not, and measuring a payee against a
//     threshold nobody read is a false accusation dressed as a fact.
//
// The return type encodes it so a caller cannot get it wrong by accident: on
// the resolved branch the figure is a `number`, on the unresolved branch it is
// `null`, and there is no third shape.
//
// The swallow logs at ERROR *and* calls the guarded `deps.reportError?.()`
// (CLAUDE.md ReporterPort convention — `logger.warn` is NOT captured by
// Sentry). A throwing or missing reporter can never change the result.
// ─────────────────────────────────────────────────────────────────────────────

export type PayoutMinimumDeps = {
  repos: Pick<Repos, "feePolicies">;
  logger?: LoggerPort;
  /**
   * Reports the best-effort fee-policy read failure. Guarded at the call site
   * — a throwing or missing reporter never changes the result.
   */
  reportError?: ReporterPort;
};

/**
 * Caller-supplied naming for the swallow's telemetry, so each view's log line
 * and Sentry tags stay its own. Structurally the same contract as
 * `DebtNettingTelemetry` in `./maturity-netting`, kept separate so neither
 * module's name reads wrong at the other's call site.
 */
export type PayoutMinimumTelemetry = {
  /** `logger.error` event name. */
  logEvent: string;
  /** Sentry `tags.useCase`. */
  useCase: string;
  /** Sentry `tags.step`. */
  step: string;
};

/**
 * Resolved carries a REAL number (a policy row's, or the batch's documented
 * default). Unresolved carries null and nothing else — there is no shape in
 * which a caller can read a figure out of a failed read.
 */
export type PayoutMinimum =
  | { minimumResolved: true; payoutMinimumCents: number }
  | { minimumResolved: false; payoutMinimumCents: null };

/**
 * Reads the GLOBAL fee policy's payout minimum as at `asOf`.
 *
 * NEVER THROWS — including when `repos.feePolicies` is absent entirely, since
 * the call sits inside the `try`. A caller may therefore start the promise
 * early and await it later without risking an unhandled rejection.
 */
export async function readPayoutMinimum(
  deps: PayoutMinimumDeps,
  input: { asOf: Date; telemetry: PayoutMinimumTelemetry },
): Promise<PayoutMinimum> {
  try {
    const policy = await deps.repos.feePolicies.resolveEffective({
      scopeType: "GLOBAL",
      scopeId: null,
      at: input.asOf,
    });
    // No policy ROW is a defined answer (the batch falls back to its own
    // default, so the page must too). A failed READ is not — see below.
    return {
      minimumResolved: true,
      payoutMinimumCents:
        policy?.payoutMinimumCents ?? DEFAULT_PAYOUT_MINIMUM_CENTS,
    };
  } catch (err) {
    deps.logger?.error(input.telemetry.logEvent, { err });
    try {
      deps.reportError?.(err, {
        tags: { useCase: input.telemetry.useCase, step: input.telemetry.step },
      });
    } catch {
      // A broken reporter must never turn a degraded panel into a failed one.
    }
    // NOT `DEFAULT_PAYOUT_MINIMUM_CENTS`. The whole point of the flag.
    return { minimumResolved: false, payoutMinimumCents: null };
  }
}

/**
 * Does tonight's batch skip this payee for being under the threshold
 * (`run-batch.ts` §2)?
 *
 * NULL IS THE VERDICT GOING BLANK, NEVER A "NO". It is returned when EITHER
 * input is unknown — the policy read failed, or the payable read failed — and
 * a caller must render "could not check", never "clears the minimum".
 *
 * ONE CELL AT A TIME. The batch applies the minimum per (payee, currency)
 * cell, so `payableCents` must be ONE currency's payable and the answer is
 * about THAT cell only — never about the payee, who may hold another cell
 * that clears. Callers say so at their own field.
 *
 * A NEGATIVE payable (carried-forward debt) is below the minimum like any
 * other figure under it. The batch skips it for its own reason (it filters
 * `payableCents > 0` before the minimum even applies), but the answer to "does
 * anything go out tonight" is the same `true`, so the comparison is left
 * exactly as the statement writes it rather than special-cased into a second
 * rule that could drift.
 */
export function belowPayoutMinimum(
  payableCents: number | null,
  payoutMinimumCents: number | null,
): boolean | null {
  if (payableCents === null || payoutMinimumCents === null) return null;
  return payableCents < payoutMinimumCents;
}
