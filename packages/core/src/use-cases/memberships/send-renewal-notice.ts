import { randomUUID } from "node:crypto";

import { z } from "zod";

import { fail } from "@th/errors";
import type { ClockPort } from "@th/ports/clock";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { MembershipTierRecord } from "@th/types/repos/membership-tiers";

import { formatCents } from "../../lib/currency-utils";
import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import { abandonClaim } from "../../lib/idempotency-claim";
import { trimTrailingSlash } from "../../lib/url";
import { resolveTimeZone } from "../../lib/venue-local-time";

/**
 * Pre-renewal notice, driven by Stripe's `invoice.upcoming` webhook.
 *
 * Emails the member ahead of each membership charge with the tier name, the
 * amount, the charge date, the OWNER's name and a cancel link. This is
 * **load-bearing for dispute prevention, not a nicety** (recurring-memberships
 * spec, "Dispute policy"): the commonest recurring-billing chargeback is a
 * member who could not find how to cancel, and as merchant of record every one
 * of those disputes is structurally ours.
 *
 * Three deliberate choices:
 *
 *  1. **A mailer failure THROWS.** Sending is best-effort *delivery* of a
 *     REQUIRED notice — a swallow here silently converts "notice not sent"
 *     into "notice never retried". Throwing lands the webhook event in the
 *     DLQ, where an operator's replay retries the send (the webhook route
 *     acknowledges every verified event with 200, so Stripe itself never
 *     redelivers — the DLQ replay is the only retry path; see
 *     lib/idempotency-claim.ts). No `reportError` fallback exists for the
 *     send itself, on purpose. What happens AFTER a successful send is the
 *     opposite: the email is out, so a failing audit row is log + report,
 *     never a throw — a throw would release the claim and the replay would
 *     send the notice a second time.
 *  2. **The owner's name is in the email.** The statement descriptor on the
 *     charge is the OWNER's name (22-char Stripe cap — the tier does not fit),
 *     so the email must name the same party the member will see on their card
 *     statement, or the notice *causes* the "what is this charge?" dispute it
 *     exists to prevent.
 *  3. **The cancel link points at OUR page, not a Stripe portal session.**
 *     Portal session URLs are short-lived and cannot be minted into an email;
 *     `/account/memberships` creates one on demand instead.
 *
 * Idempotent on the Stripe event id: a redelivered webhook must not email the
 * member twice. Same 5-step get/begin/commit/fail shape as
 * `record-membership-invoice-paid.ts`. The mailer `idempotencyKey` adds a
 * second, channel-level line of defence under `…:email` — a DIFFERENT key from
 * the use-case one, because the mailer adapter claims its key on the same
 * store and a shared key deadlocks (see the inline note at the send site).
 */

const IDEMPOTENCY_KEY_TTL_SECONDS = 300;
const IDEMPOTENCY_KEEP_SECONDS = 86_400; // 24h retention

export const sendRenewalNoticeInputSchema = z
  .object({
    stripeSubscriptionId: z.string().trim().min(3).max(255),
    /** `invoice.amount_due` on the upcoming invoice — what will be charged. */
    amountDueCents: z.number().int().nonnegative(),
    currency: z
      .string()
      .trim()
      .length(3)
      .transform((value) => value.toLowerCase()),
    /** Stripe's `next_payment_attempt` — when the charge will happen. */
    nextPaymentAttempt: z.coerce.date(),
    periodStart: z.coerce.date(),
    periodEnd: z.coerce.date(),
    stripeEventId: z.string().trim().min(3).max(255),
  })
  .strict();

export const sendRenewalNoticeOutputSchema = z
  .object({
    ok: z.literal(true),
    sent: z.boolean(),
    /** Set when nothing was sent; `not_ours` mirrors the invoice handlers. */
    reason: z.enum(["not_ours"]).nullable(),
    membershipId: z.string().uuid().nullable(),
  })
  .strict();

export type SendRenewalNoticeInput = z.infer<typeof sendRenewalNoticeInputSchema>;
export type SendRenewalNoticeOutput = z.infer<
  typeof sendRenewalNoticeOutputSchema
>;

export type SendRenewalNoticeDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  mailer: MailerPort;
  clock: ClockPort;
  /** Public web origin the cancel link is built from (see notify-dispute-lifecycle). */
  publicAppUrl: string;
  logger?: LoggerPort;
  /**
   * Sentry hook for the post-send swallow (audit row) and the claim-cleanup
   * swallows (lib/idempotency-claim). Warn is not captured — CLAUDE.md.
   */
  reportError?: ReporterPort | null;
};

interface StoredNoticeRecord {
  response: SendRenewalNoticeOutput;
  stripeSubscriptionId: string;
}

export async function sendRenewalNotice(
  deps: SendRenewalNoticeDeps,
  rawInput: unknown,
): Promise<SendRenewalNoticeOutput> {
  const input = parseInput(sendRenewalNoticeInputSchema, rawInput);
  const logger = deps.logger;

  const idempotencyKey = `renewal_notice:${input.stripeEventId}`;

  const cached = await deps.idempotency.get<StoredNoticeRecord>(idempotencyKey);
  if (cached) {
    if (cached.stripeSubscriptionId !== input.stripeSubscriptionId) {
      throw fail("STRIPE_EVENT_CONFLICT");
    }
    logger?.info("sendRenewalNotice.replay_cached", {
      stripeSubscriptionId: input.stripeSubscriptionId,
      membershipId: cached.response.membershipId,
    });
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
      await deps.idempotency.get<StoredNoticeRecord>(idempotencyKey);
    if (replay) {
      if (replay.stripeSubscriptionId !== input.stripeSubscriptionId) {
        throw fail("STRIPE_EVENT_CONFLICT");
      }
      return replay.response;
    }
    throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
  }

  try {
    const result = await sendNoticeInternal(deps, logger, input);

    await deps.idempotency.commit<StoredNoticeRecord>(
      idempotencyKey,
      { response: result, stripeSubscriptionId: input.stripeSubscriptionId },
      IDEMPOTENCY_KEEP_SECONDS,
    );

    return result;
  } catch (error) {
    await abandonClaim(deps.idempotency, idempotencyKey, claimOwnerToken, error, {
      useCase: "sendRenewalNotice",
      logger: deps.logger ?? null,
      reportError: deps.reportError ?? null,
    });
    throw asKnownError("send_renewal_notice", error);
  }
}

async function sendNoticeInternal(
  deps: SendRenewalNoticeDeps,
  logger: LoggerPort | undefined,
  input: SendRenewalNoticeInput,
): Promise<SendRenewalNoticeOutput> {
  const membership = await deps.repos.memberships.findByStripeSubscriptionId(
    input.stripeSubscriptionId,
  );
  if (!membership) {
    // Not ours. The platform account carries subscriptions we did not create
    // (Dashboard-made, future product lines), and `invoice.upcoming` fires for
    // all of them — same reasoning as the `invoice.payment_succeeded`
    // handler's not-ours guard. A no-op, not an error.
    logger?.info("sendRenewalNotice.skipped_untracked_subscription", {
      stripeSubscriptionId: input.stripeSubscriptionId,
      stripeEventId: input.stripeEventId,
    });
    return sendRenewalNoticeOutputSchema.parse({
      ok: true,
      sent: false,
      reason: "not_ours",
      membershipId: null,
    });
  }

  const tier = await deps.repos.membershipTiers.findById(membership.tierId);
  if (!tier) {
    throw fail("MEMBERSHIP_TIER_NOT_FOUND", {
      meta: { membershipId: membership.id, tierId: membership.tierId },
    });
  }

  const member = await deps.repos.humans.getByIdWithIdentity(
    membership.memberHumanId,
  );
  if (!member) {
    throw fail("HUMAN_NOT_FOUND", {
      meta: { role: "member", membershipId: membership.id },
    });
  }

  const ownerName = await resolveOwnerName(deps, tier);

  // The self-serve management page; it mints the (short-lived) Stripe portal
  // session on demand, which is why the email cannot link the portal directly.
  const cancelUrl = `${trimTrailingSlash(deps.publicAppUrl)}/account/memberships`;

  // NOT caught: a throwing mailer must propagate so the webhook DLQs and the
  // notice is retried. See the header — this notice is required, and a
  // swallowed failure here is an unsent-and-never-retried notice.
  const sendResult = await deps.mailer.send({
    to: { to: member.identity.email, name: member.human.name ?? undefined },
    template: {
      key: "membership.renewal_notice",
      variables: {
        tierName: tier.name,
        ownerName,
        amountFormatted: formatCents(input.amountDueCents, input.currency),
        renewalDateISO: input.nextPaymentAttempt.toISOString(),
        // Neither owner kind (org or human) carries a zone, so the charge day
        // reads in the platform default, as every other date does without a
        // zone. Left to the template it was the server's zone: UTC on Cloud
        // Run, a day late for an evening charge.
        timezone: resolveTimeZone(null),
        cancelUrl,
      },
    },
    // NOT the use-case key: the mailer adapter runs its own get/begin/commit
    // on the SAME idempotency store, so sharing the key the use case has
    // already claimed deadlocks into `idempotency_conflict` (verified against
    // the live dev stack). The `:email` suffix is the established per-channel
    // convention (see comms utils / notify wiring).
    idempotencyKey: `renewal_notice:${input.stripeEventId}:email`,
    metadata: {
      membershipId: membership.id,
      tierId: tier.id,
      stripeSubscriptionId: input.stripeSubscriptionId,
      stripeEventId: input.stripeEventId,
    },
    tags: ["membership", "renewal-notice"],
  });

  // Some adapters report failure as a result rather than a throw. Either way
  // the outcome must be the same: no successful send, no committed key.
  if (!sendResult.result.success) {
    throw fail("EMAIL_DELIVERY_FAILED", {
      meta: {
        membershipId: membership.id,
        errorCode: sendResult.result.errorCode ?? null,
        errorMessage: sendResult.result.errorMessage ?? null,
      },
    });
  }

  // Dispute evidence: "the member was notified ahead of the charge, with a
  // working cancel link" is exactly what a subscription-cancelled chargeback
  // response needs to show.
  //
  // Post-send failures MUST NOT throw. The email has left; a throw here
  // releases the idempotency claim (lib/idempotency-claim.ts) and the DLQ
  // replay minutes later would re-send — the mailer's own `:email` key only
  // lives 120 s. The claim is committed on the sent outcome regardless, and
  // the missing audit row is reported to Sentry rather than retried.
  await recordSentAuditBestEffort(deps, input, membership.id, tier.id, cancelUrl);

  logger?.info("sendRenewalNotice.sent", {
    membershipId: membership.id,
    tierId: tier.id,
    amountDueCents: input.amountDueCents,
    nextPaymentAttempt: input.nextPaymentAttempt.toISOString(),
  });

  return sendRenewalNoticeOutputSchema.parse({
    ok: true,
    sent: true,
    reason: null,
    membershipId: membership.id,
  });
}

/**
 * The name the member's card statement will show — the OWNER, never the tier.
 *
 * A missing owner row is a broken tier (same condition
 * `record-membership-invoice-paid` maps to PAYEE_NOT_READY): the notice cannot
 * truthfully name who is charging, so it refuses and lands in the DLQ for a
 * human rather than sending a notice that reads like the fraud it is meant to
 * prevent.
 */
async function resolveOwnerName(
  deps: SendRenewalNoticeDeps,
  tier: MembershipTierRecord,
): Promise<string> {
  if (tier.ownerOrgId) {
    const org = await deps.repos.organizations.getById(tier.ownerOrgId);
    if (!org) {
      throw fail("ORGANIZATION_NOT_FOUND", {
        meta: { tierId: tier.id, ownerOrgId: tier.ownerOrgId },
      });
    }
    return org.name;
  }

  if (tier.ownerHumanId) {
    const owner = await deps.repos.humans.getByIdWithIdentity(
      tier.ownerHumanId,
    );
    if (!owner) {
      throw fail("HUMAN_NOT_FOUND", {
        meta: { role: "owner", tierId: tier.id },
      });
    }
    // Same fallback chain the dispute notifier uses for a human's display
    // name; the email is a last resort that is at least always present.
    return (
      owner.human.name ??
      owner.identity.displayUsername ??
      owner.identity.email
    );
  }

  throw fail("PAYEE_NOT_READY", {
    meta: { tierId: tier.id, reason: "tier_has_no_owner" },
  });
}

async function recordSentAuditBestEffort(
  deps: SendRenewalNoticeDeps,
  input: SendRenewalNoticeInput,
  membershipId: string,
  tierId: string,
  cancelUrl: string,
): Promise<void> {
  try {
    await deps.repos.audit.log({
      entity: "membership",
      entityId: membershipId,
      action: "membership_renewal_notice_sent",
      data: {
        stripeEventId: input.stripeEventId,
        stripeSubscriptionId: input.stripeSubscriptionId,
        tierId,
        amountDueCents: input.amountDueCents,
        currency: input.currency,
        nextPaymentAttempt: input.nextPaymentAttempt.toISOString(),
        periodStart: input.periodStart.toISOString(),
        periodEnd: input.periodEnd.toISOString(),
        cancelUrl,
      },
      at: deps.clock.now(),
    });
  } catch (error) {
    try {
      deps.logger?.error("sendRenewalNotice.audit_failed_after_send", {
        membershipId,
        stripeEventId: input.stripeEventId,
        error: describeError(error),
      });
    } catch {
      // Reporting must never throw past a sent notice.
    }
    try {
      deps.reportError?.(error, {
        tags: { useCase: "sendRenewalNotice", stage: "audit_after_send" },
        extra: { membershipId, stripeEventId: input.stripeEventId },
      });
    } catch {
      // Reporting must never throw past a sent notice.
    }
  }
}
