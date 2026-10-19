import type { LoggerPort } from "@th/ports/logger";
import type {
  FeePolicyRecord,
  FeePolicyScopeType,
} from "@th/ports/repos/fee-policies";
import type { ReporterPort } from "@th/ports/reporter";
import type { TxRepos } from "@th/ports/repos";

import { describeError } from "../io";

/**
 * THE scope walk for "which fee policy applies to this event?".
 *
 * Precedence is EVENT → ORG → GLOBAL: the most specific policy in force at
 * `at` wins, and a GLOBAL row is the platform-wide default.
 *
 * Extracted from `publishEvent`, which used to own a private copy, because the
 * MONEY-AUTHORITATIVE sites must not be able to disagree about which policy an
 * event runs on. Those sites are:
 *
 *   - `publishEvent` — resolves once and PINS the result onto the event's
 *     primary payout terms, so the whole sale runs on one policy version.
 *   - `ensureFeePolicyResolvableForPaidTicketing` (`upsertTicketType` /
 *     `updateTicketType`) — refuses a money-taking tier when nothing resolves,
 *     so the organizer learns at edit time instead of the buyer learning at
 *     checkout.
 *   - `loadPayoutTermsContext` — lazily re-resolves when terms carry NO pin,
 *     which is only reachable for terms published before any policy existed.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS IS NOT YET THE ONLY COPY — three more survive, deliberately
 * ─────────────────────────────────────────────────────────────────────────
 * The same EVENT → ORG → GLOBAL loop is still hand-rolled in three BUYER-FACING
 * PRICE PREVIEW paths, none of which was migrated here:
 *
 *   - `use-cases/events/get-checkout-fee-rates.ts` (~line 261)
 *   - `use-cases/events/get-event-fee-preview.ts` (~line 284)
 *   - `use-cases/events/_shared/estimate-buyer-ticket-pricing.ts` (~line 252)
 *
 * They are NOT equivalent to this function: none of them wraps
 * `resolveEffective` at all, so they have no per-scope diagnostics, and two of
 * them tolerate a null policy by design. Migrating them is a follow-up with its
 * own blast radius (they read `deps.repos` rather than a `TxRepos`). Named here
 * so the next reader does not believe a "single source of truth" claim that is
 * not yet true.
 *
 * A REPO FAILURE at any scope ENDS the walk: it is logged, reported and
 * RETHROWN. It used to be swallowed so the walk could "fall through to ORG or
 * GLOBAL", and that promise was unkeepable — every caller runs this inside
 * `repos.tx`, and Postgres aborts the session on the first failed statement,
 * so the ORG and GLOBAL reads that followed failed with 25P02 (each swallowed
 * in turn) and the function returned `null` deterministically. The caller then
 * threw a TYPED business error — `AGREEMENT_MISSING_FEE_POLICY`,
 * `FEE_POLICY_NOT_FOUND`, `PAID_TICKETING_REQUIRES_FEE_POLICY` — telling the
 * buyer or organiser the event was MISCONFIGURED when the truth was a transient
 * database fault, and typed codes are mapped as known client errors rather than
 * captured as exceptions. Rethrowing gives the caller the real fault; nothing
 * that was going to commit now fails, because the transaction was already
 * condemned (docs/engineering-standards, "Swallowing an error inside a
 * transaction").
 *
 * A clean MISS at one scope (no row in force) is NOT an error and DOES fall
 * through to the next scope — that is the precedence walk itself.
 *
 * The failure is still reported at the site: `logger.error` (captured via
 * Sentry's pinoIntegration) AND `reportError`, both tagged with the scope that
 * failed, so the incident is attributed to the read that actually broke rather
 * than to whatever the caller does with the rethrown error. Never demote the
 * log back to `warn`, which Sentry does NOT capture.
 *
 * CALLERS SHOULD PASS BOTH `logger` AND `reportError` where they have them so
 * the failing scope is named in the report.
 *
 * A clean MISS at EVERY scope (no policy anywhere) is NOT reported here: it is
 * a platform misconfiguration whose severity depends on what the caller does
 * about it, so the caller owns that report.
 */

export type ScopedFeePolicySubject = {
  eventId: string;
  /** `null` for a human-owned event — the ORG scope is simply skipped. */
  orgId: string | null;
};

export type ResolveScopedFeePolicyOptions = {
  logger?: LoggerPort;
  /**
   * Best-effort Sentry reporter for a per-scope repo failure (which is then
   * rethrown). Guarded internally: a throwing reporter can never replace the
   * real error.
   *
   * `null` is accepted alongside `undefined` because the tRPC context carries
   * `ReporterPort | null` and several use-case deps mirror that shape — same
   * reasoning as `computeOrderAmounts`. Both are falsy and take the no-op path.
   */
  reportError?: ReporterPort | null;
  /** Merged into the log/report context so the call site is identifiable. */
  source?: string;
};

export async function resolveScopedFeePolicy(
  tx: TxRepos,
  subject: ScopedFeePolicySubject,
  at: Date,
  options: ResolveScopedFeePolicyOptions = {},
): Promise<FeePolicyRecord | null> {
  const scopes: Array<{
    scopeType: FeePolicyScopeType;
    scopeId: string | null;
  }> = [{ scopeType: "EVENT", scopeId: subject.eventId }];

  if (subject.orgId) {
    scopes.push({ scopeType: "ORG", scopeId: subject.orgId });
  }

  scopes.push({ scopeType: "GLOBAL", scopeId: null });

  for (const scope of scopes) {
    try {
      const policy = await tx.feePolicies.resolveEffective({ ...scope, at });
      if (policy) {
        return policy;
      }
    } catch (error) {
      // Report at the failing scope, then rethrow. Do NOT continue the walk —
      // see the doc comment: inside a transaction the remaining reads cannot
      // succeed, and a fabricated `null` becomes a misleading typed error.
      options.logger?.error("fee_policy_resolution_failed", {
        scope,
        source: options.source,
        eventId: subject.eventId,
        err: error,
        error: describeError(error),
      });
      reportBestEffort(options.reportError, error, {
        tags: {
          resolver: "resolveScopedFeePolicy",
          scopeType: scope.scopeType,
          source: options.source,
        },
        extra: {
          eventId: subject.eventId,
          orgId: subject.orgId,
          scopeId: scope.scopeId,
          at: at.toISOString(),
        },
      });
      throw error;
    }
  }

  return null;
}

/**
 * Invoke a {@link ReporterPort} without letting it change caller behaviour.
 * Reporting is best-effort by contract; a Sentry outage must never turn a
 * degraded-but-working path into a failed one.
 */
export function reportBestEffort(
  reportError: ReporterPort | null | undefined,
  error: unknown,
  context?: {
    tags?: Record<string, string | undefined>;
    extra?: Record<string, unknown>;
  },
): void {
  if (!reportError) return;
  try {
    reportError(error, context);
  } catch {
    // Intentionally empty — see the doc comment.
  }
}
