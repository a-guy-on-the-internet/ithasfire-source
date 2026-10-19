import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { PayoutTermsRecord } from "@th/ports/repos/payout-terms";

import {
  ensureEntityDefaultPrimaryTerms,
  type EntityPayoutSubject,
} from "../agreements/_shared/ensure-entity-default-primary-terms";

export type EnsureEntityDefaultPayoutTermsForAccountDeps = {
  repos: Pick<
    Repos,
    "tx" | "payees" | "organizations" | "humans" | "payoutTerms" | "audit"
  >;
  clock: ClockPort;
  logger?: LoggerPort;
};

export type EnsureEntityDefaultPayoutTermsForAccountInput = {
  stripeAccountId: string;
};

export type EnsureEntityDefaultPayoutTermsForAccountResult = {
  /** Whether a usable (ACTIVE + payoutsEnabled) payee was found for the account. */
  payeeUsable: boolean;
  /** The entity default terms id (existing or newly provisioned), if any. */
  payoutTermsId: string | null;
};

/**
 * Eager-provision an entity's reusable DEFAULT PRIMARY payout terms when its
 * Stripe Connect account becomes usable (ACTIVE + payoutsEnabled).
 *
 * Triggered from the `account.updated` webhook AFTER `onAccountUpdated` has
 * synced the payee's capabilities. Resolves the payee by Stripe account id,
 * derives its subject (org / human), and — when the payee is usable — opens a
 * transaction and calls `ensureEntityDefaultPrimaryTerms`. That row is NEVER
 * linked to an event; it's the entity's reusable default.
 *
 * Idempotent: a no-op when the entity already has a default, or when the payee
 * is missing / not ACTIVE / payouts disabled.
 *
 * Defensive: this use case NEVER throws. The webhook route processes sibling
 * events in the same delivery, so a failure here must not break those — errors
 * are caught and logged, and a benign result is returned.
 */
export async function ensureEntityDefaultPayoutTermsForAccount(
  deps: EnsureEntityDefaultPayoutTermsForAccountDeps,
  input: EnsureEntityDefaultPayoutTermsForAccountInput,
): Promise<EnsureEntityDefaultPayoutTermsForAccountResult> {
  const { stripeAccountId } = input;
  try {
    const payee = await deps.repos.payees.getByStripeAccountId(stripeAccountId);
    if (!payee) {
      deps.logger?.info(
        "ensure_entity_default_payout_terms.payee_not_found",
        { stripeAccountId },
      );
      return { payeeUsable: false, payoutTermsId: null };
    }

    if (payee.status !== "ACTIVE" || !payee.payoutsEnabled) {
      // Not usable yet — capabilities may flip ACTIVE on a later webhook.
      return { payeeUsable: false, payoutTermsId: null };
    }

    if (!payee.subjectId) {
      // Placeholder payee created from a webhook before onboarding linked a
      // real subject (see payees adapter `syncCapabilities` create branch).
      deps.logger?.warn(
        "ensure_entity_default_payout_terms.payee_missing_subject",
        { stripeAccountId, payeeId: payee.id },
      );
      return { payeeUsable: true, payoutTermsId: null };
    }

    const subject: EntityPayoutSubject = {
      type: payee.subjectType,
      id: payee.subjectId,
    };

    const now = deps.clock.now();
    const terms: PayoutTermsRecord | null = await deps.repos.tx((tx) =>
      ensureEntityDefaultPrimaryTerms(tx, subject, now, deps.logger),
    );

    return {
      payeeUsable: true,
      payoutTermsId: terms?.id ?? null,
    };
  } catch (err) {
    deps.logger?.error(
      "ensure_entity_default_payout_terms.failed",
      {
        stripeAccountId,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return { payeeUsable: false, payoutTermsId: null };
  }
}
