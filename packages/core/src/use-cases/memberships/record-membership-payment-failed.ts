import { randomUUID } from "node:crypto";

import { z } from "zod";

import { fail } from "@th/errors";
import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { asKnownError } from "../../lib/errors";
import { parseInput } from "../../lib/io";
import { abandonClaim } from "../../lib/idempotency-claim";
import { MEMBERSHIP_STATUS_PAST_DUE } from "./membership-status";

/**
 * A membership invoice failed to collect.
 *
 * Scope is deliberately tiny: mark the membership past due and write the audit
 * row. **Stripe Billing owns the retry schedule** (smart retries, the dunning
 * emails, and the eventual transition to `unpaid`/`canceled`), so there is no
 * retry state here to drift out of sync with theirs. The subsequent
 * `customer.subscription.updated` events carry the real outcome and land in
 * `syncMembershipFromStripe`.
 *
 * NO Order is created. A failed invoice collected nothing, so there is nothing
 * to settle, split or pay out — inventing a zero/failed order would put a row in
 * front of every settlement query for money that never moved.
 */

const IDEMPOTENCY_KEY_TTL_SECONDS = 300;
const IDEMPOTENCY_KEEP_SECONDS = 86_400; // 24h retention

export const recordMembershipPaymentFailedInputSchema = z
  .object({
    stripeInvoiceId: z.string().trim().min(3).max(255),
    stripeSubscriptionId: z.string().trim().min(3).max(255),
    /** `invoice.amount_due` — recorded for the audit trail, never charged here. */
    amountDueCents: z.number().int().nonnegative(),
    currency: z
      .string()
      .trim()
      .length(3)
      .transform((value) => value.toLowerCase()),
    /**
     * `invoice.attempt_count`. Carried into the audit row so the dunning story
     * is readable from our side without opening Stripe. We do NOT branch on it —
     * that would be a second retry policy competing with Billing's.
     */
    attemptCount: z.number().int().nonnegative().nullable().optional(),
    /** `invoice.next_payment_attempt`, Stripe's schedule. Informational. */
    nextPaymentAttemptAt: z.coerce.date().nullable().optional(),
    stripeEventId: z.string().trim().min(3).max(255),
  })
  .strict();

export const recordMembershipPaymentFailedOutputSchema = z
  .object({
    ok: z.literal(true),
    membershipId: z.string().uuid(),
    status: z.string().min(1),
  })
  .strict();

export type RecordMembershipPaymentFailedInput = z.infer<
  typeof recordMembershipPaymentFailedInputSchema
>;
export type RecordMembershipPaymentFailedOutput = z.infer<
  typeof recordMembershipPaymentFailedOutputSchema
>;

export type RecordMembershipPaymentFailedDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Sentry hook for the claim-cleanup swallows (lib/idempotency-claim). */
  reportError?: ReporterPort | null;
};

interface StoredFailureRecord {
  response: RecordMembershipPaymentFailedOutput;
  stripeInvoiceId: string;
}

export async function recordMembershipPaymentFailed(
  deps: RecordMembershipPaymentFailedDeps,
  rawInput: unknown,
): Promise<RecordMembershipPaymentFailedOutput> {
  const input = parseInput(recordMembershipPaymentFailedInputSchema, rawInput);
  const logger = deps.logger;

  // Keyed on the EVENT, not the invoice: Stripe emits one
  // `invoice.payment_failed` per failed attempt and each is a distinct thing
  // that happened. Keying on the invoice would silently drop attempts 2..n from
  // the audit trail.
  const idempotencyKey = `membership_payment_failed:${input.stripeEventId}`;

  const cached = await deps.idempotency.get<StoredFailureRecord>(idempotencyKey);
  if (cached) {
    if (cached.stripeInvoiceId !== input.stripeInvoiceId) {
      throw fail("STRIPE_EVENT_CONFLICT");
    }
    return cached.response;
  }

  // Owner token for `abandonClaim` (lib/idempotency-claim.ts explains why).
  const claimOwnerToken = randomUUID();
  const claimed = await deps.idempotency.begin(
    idempotencyKey,
    IDEMPOTENCY_KEY_TTL_SECONDS,
    claimOwnerToken,
  );
  if (!claimed) {
    const replay =
      await deps.idempotency.get<StoredFailureRecord>(idempotencyKey);
    if (replay) {
      if (replay.stripeInvoiceId !== input.stripeInvoiceId) {
        throw fail("STRIPE_EVENT_CONFLICT");
      }
      return replay.response;
    }
    throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
  }

  try {
    const result = await deps.repos.tx(async (tx) => {
      const membership = await tx.memberships.findByStripeSubscriptionId(
        input.stripeSubscriptionId,
      );
      if (!membership) {
        throw fail("MEMBERSHIP_NOT_FOUND", {
          meta: { stripeSubscriptionId: input.stripeSubscriptionId },
        });
      }

      const updated = await tx.memberships.updateFromStripe({
        id: membership.id,
        status: MEMBERSHIP_STATUS_PAST_DUE,
      });

      // Intentionally UNKEYED: one audit row per attempt is the record we
      // want. Stripe emits a fresh `invoice.payment_failed` per retry, and a
      // DLQ replay of the same event is deduped by the use-case claim above,
      // so no key is needed here to keep the history honest.
      await tx.audit.log({
        entity: "membership",
        entityId: membership.id,
        action: "payment_failed",
        data: {
          stripeEventId: input.stripeEventId,
          stripeInvoiceId: input.stripeInvoiceId,
          stripeSubscriptionId: input.stripeSubscriptionId,
          amountDueCents: input.amountDueCents,
          currency: input.currency,
          attemptCount: input.attemptCount ?? null,
          nextPaymentAttemptAt:
            input.nextPaymentAttemptAt?.toISOString() ?? null,
          previousStatus: membership.status,
          status: updated.status,
        },
        at: deps.clock.now(),
      });

      logger?.info("membership.payment_failed", {
        membershipId: membership.id,
        stripeInvoiceId: input.stripeInvoiceId,
        attemptCount: input.attemptCount ?? null,
        status: updated.status,
      });

      return recordMembershipPaymentFailedOutputSchema.parse({
        ok: true,
        membershipId: membership.id,
        status: updated.status,
      });
    });

    await deps.idempotency.commit<StoredFailureRecord>(
      idempotencyKey,
      { response: result, stripeInvoiceId: input.stripeInvoiceId },
      IDEMPOTENCY_KEEP_SECONDS,
    );

    return result;
  } catch (error) {
    await abandonClaim(deps.idempotency, idempotencyKey, claimOwnerToken, error, {
      useCase: "recordMembershipPaymentFailed",
      logger: deps.logger ?? null,
      reportError: deps.reportError ?? null,
    });
    throw asKnownError("record_membership_payment_failed", error);
  }
}
