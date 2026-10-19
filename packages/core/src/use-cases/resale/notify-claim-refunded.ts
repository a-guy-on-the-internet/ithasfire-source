/**
 * Tells the buyer that the refund for their APPROVED claim has been issued
 * (owner ruling 2026-10-07: "it'll be nice for them to know that they have
 * been refunded").
 *
 * The approval notice (`notifyClaimResolved`) only says a refund "will be
 * processed": review-claim commits `approved` BEFORE it calls Stripe, and a
 * pending refund is finished later by the `charge.refunded` /
 * `charge.refund.updated` webhook. This notice is the second half: it goes out
 * once the order is refunded, from whichever path saw that happen:
 *   - review-claim, when Stripe answers `succeeded` (or a retry finds its own
 *     earlier refund committed);
 *   - reconcile-stripe-full-refund, when the webhook marks a RESALE order with
 *     an approved claim REFUNDED.
 * `charge.refunded` can arrive while Stripe still lists the refund as pending,
 * so the copy says "we've refunded you", not that the money has landed.
 *
 * ## Exactly once
 * Notification rows carry no dedupe key, and `notify`'s own dedupe is a 60s
 * best-effort window, so the guard is a durable "already told" record on the
 * idempotency port, the same shape as the lineup notices
 * (event-humans/notify-lineup-notices.ts):
 *   1. `begin(claimRefundedNoticeKey(claimId))` is an atomic claim. Only one
 *      caller wins it; the sync path and the webhook racing, a webhook
 *      redelivery and a staff retry all lose it and send nothing.
 *   2. a `{ writing: true }` record is committed with the long keep BEFORE the
 *      in-app write, so a crash between the write and the final commit leaves
 *      the notice missing, never duplicated.
 *   3. the in-app row, then the email.
 *   4. `commit` the sent record (ten-year keep).
 * A failure before the in-app row exists frees the record for a later try.
 * Once the row exists the record stays, even if the email or the final commit
 * fails: a second notice is worse than a missing ledger row.
 *
 * ## Never fails the refund
 * Every function here catches everything, reports it through `reportError`
 * (guarded, so a throwing reporter or logger changes nothing), and returns an
 * outcome. The webhook caller depends on that: a throw there would DLQ the
 * event.
 */
import { randomUUID } from "node:crypto";

import type { MailerPort } from "@th/ports/comms/mailer";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";

import { trimTrailingSlash } from "../../lib/url";
import { RESALE_CLAIM_REFUNDED_COPY } from "../comms/copy/resale-direct";
import { buildDirectInAppNotice } from "../comms/direct-in-app";
import {
  resaleClaimRefundedRenderer,
  type ResaleClaimRefundedPayload,
} from "../comms/direct-money-safety-renderers";
import { resolveNotificationLocale } from "../comms/locale";

/** How long the "already told" record is kept: longer than any retry. */
export const CLAIM_REFUNDED_NOTICE_KEEP_SEC = 10 * 365 * 24 * 60 * 60;
/** How long one sender holds the claim while it delivers. */
const SEND_CLAIM_TTL_SEC = 300;
/**
 * How long a `failed` record blocks a retry after a failed in-app write. One
 * second, not zero: Redis rejects `EX 0`.
 */
const WRITE_FAILED_KEEP_SEC = 1;

export function claimRefundedNoticeKey(claimId: string): string {
  return `resale-claim-refunded-notice:${claimId}`;
}

/** Stripe reads used to learn what THIS claim's refund returned. */
export type ClaimRefundPaymentsReader = Pick<
  PaymentProcessorPort,
  "getRefund" | "listRefundsForPaymentIntent"
>;

export type ClaimRefundedNotifyDeps = {
  repos: Repos;
  idempotency: IdempotencyPort;
  mailer: MailerPort;
  publicAppUrl: string;
  /** Optional: without it the notice shows `amount.fallbackCents`. */
  payments?: ClaimRefundPaymentsReader | null;
  logger?: LoggerPort;
  reportError?: ReporterPort | null;
};

/**
 * Where the amount comes from: the claim's own Stripe refund, looked up by
 * `refundId` when known, else among the PaymentIntent's refunds by the
 * `useCase: reviewClaim` + `orderId` metadata review-claim stamps on it.
 * `fallbackCents` is used only when Stripe cannot say (reported).
 */
export type ClaimRefundAmountSource = {
  refundId?: string | null;
  paymentIntentId?: string | null;
  fallbackCents: number;
};

export type ClaimRefundedNoticeOutcome =
  /** This call wrote the notice. */
  | "sent"
  /** Another call already sent it, or is sending it now. */
  | "already_sent"
  /** Nothing was delivered; reported. */
  | "failed";

const USE_CASE = "resale.notifyClaimRefunded";

/** Logs and reports; neither a throwing logger nor reporter escapes. */
function report(
  deps: Pick<ClaimRefundedNotifyDeps, "logger" | "reportError">,
  err: unknown,
  reason: string,
  extra: Record<string, unknown>,
): void {
  try {
    deps.logger?.error(`notify.claim_refunded.${reason}`, { ...extra, err });
  } catch {
    // A throwing logger must not stop the report below.
  }
  try {
    deps.reportError?.(err, {
      tags: { useCase: USE_CASE, reason },
      extra,
    });
  } catch {
    // A throwing reporter must never change the (swallowed) outcome.
  }
}

function safeChild(logger: LoggerPort | undefined): LoggerPort | undefined {
  try {
    return logger?.child({ notify: "claim_refunded" });
  } catch {
    return undefined;
  }
}

const CLAIM_REFUND_USE_CASE = "reviewClaim";

function isClaimRefundFor(
  refund: { status: string; metadata: Record<string, string> },
  orderId: string,
): boolean {
  return (
    refund.metadata.useCase === CLAIM_REFUND_USE_CASE &&
    refund.metadata.orderId === orderId &&
    refund.status !== "failed" &&
    refund.status !== "canceled"
  );
}

/**
 * What this claim's refund returned to the buyer, per Stripe. On an order
 * that was already part-refunded this is the remainder, not the whole charge.
 * Never throws: a Stripe read failure is reported and the fallback used.
 */
async function resolveClaimRefundAmountCents(
  deps: Pick<ClaimRefundedNotifyDeps, "payments" | "logger" | "reportError">,
  orderId: string,
  source: ClaimRefundAmountSource,
): Promise<number> {
  const payments = deps.payments;
  const extra = { orderId, refundId: source.refundId ?? null };
  try {
    if (source.refundId && payments?.getRefund) {
      const refund = await payments.getRefund({ refundId: source.refundId });
      if (isClaimRefundFor(refund, orderId)) {
        return refund.amountCents;
      }
    }
    if (source.paymentIntentId && payments?.listRefundsForPaymentIntent) {
      const refunds = await payments.listRefundsForPaymentIntent({
        paymentIntentId: source.paymentIntentId,
      });
      const claimRefunds = refunds.filter((r) => isClaimRefundFor(r, orderId));
      if (claimRefunds.length > 0) {
        return claimRefunds.reduce((sum, r) => sum + r.amountCents, 0);
      }
    }
  } catch (err) {
    report(deps, err, "amount_lookup_failed", extra);
    return source.fallbackCents;
  }
  if (payments?.getRefund || payments?.listRefundsForPaymentIntent) {
    // Stripe answered but no refund carried the claim's metadata.
    report(
      deps,
      new Error("claim_refund_not_found_on_payment_intent"),
      "amount_fallback",
      extra,
    );
  }
  return source.fallbackCents;
}

/**
 * Sends the "we've refunded you" notice for `claimId` at most once. Never
 * throws.
 */
export async function notifyClaimRefunded(
  deps: ClaimRefundedNotifyDeps,
  params: {
    claimId: string;
    claimantId: string;
    orderId: string;
    eventId: string;
    currency: string;
    amount: ClaimRefundAmountSource;
  },
): Promise<ClaimRefundedNoticeOutcome> {
  const logger = safeChild(deps.logger);
  const reportDeps = { logger, reportError: deps.reportError };
  const extra = { claimId: params.claimId, orderId: params.orderId };
  const key = claimRefundedNoticeKey(params.claimId);

  let token: string;
  let claimed: boolean;
  try {
    token = randomUUID();
    claimed = await deps.idempotency.begin(key, SEND_CLAIM_TTL_SEC, token);
  } catch (err) {
    report(reportDeps, err, "claim_failed", extra);
    return "failed";
  }
  if (!claimed) {
    try {
      logger?.info("notify.claim_refunded.already_sent", extra);
    } catch {
      // Logging is not the outcome.
    }
    return "already_sent";
  }

  let markerWritten = false;
  let delivered = false;
  try {
    const [buyer, event, amountCents] = await Promise.all([
      deps.repos.humans.getByIdWithIdentity(params.claimantId),
      deps.repos.events.getById(params.eventId),
      resolveClaimRefundAmountCents(
        { payments: deps.payments, logger, reportError: deps.reportError },
        params.orderId,
        params.amount,
      ),
    ]);
    if (!buyer) {
      throw new Error("claim_refunded_buyer_not_found");
    }

    const orderUrl = `${trimTrailingSlash(deps.publicAppUrl)}/my-tickets/${params.orderId}`;
    const eventTitle = event?.title ?? null;
    const payload: ResaleClaimRefundedPayload = {
      claimId: params.claimId,
      orderId: params.orderId,
      eventTitle,
      amountCents,
      currency: params.currency,
      orderUrl,
    };

    // In-app (English text + template for the reader's language).
    const row = buildDirectInAppNotice(
      { logger, reportError: deps.reportError },
      resaleClaimRefundedRenderer,
      payload,
      { useCase: USE_CASE },
    );

    // From here a crash leaves the notice missing, never duplicated.
    await deps.idempotency.commit(
      key,
      { writing: true },
      CLAIM_REFUNDED_NOTICE_KEEP_SEC,
    );
    markerWritten = true;

    await deps.repos.notifications?.create({
      humanId: params.claimantId,
      title: row.title,
      body: row.body,
      kind: row.kind,
      metadata: { variant: row.variant },
      tags: ["resale", "claim", "refund"],
      ...(row.action ? { action: row.action } : {}),
      template: row.template ?? null,
    });
    delivered = true;

    // Email, in the buyer's stored language.
    try {
      const locale = resolveNotificationLocale(buyer.human.locale);
      const copy = RESALE_CLAIM_REFUNDED_COPY[locale];
      const body = resaleClaimRefundedRenderer.render(payload, {
        now: new Date(),
        locale,
      }).inApp?.body;
      await deps.mailer.send({
        to: { to: buyer.identity.email },
        subject: copy.emailSubject({ eventTitle }),
        text: [
          body ?? row.body,
          "",
          copy.emailLink(orderUrl),
          "",
          copy.emailSignoff,
        ].join("\n"),
        idempotencyKey: `resale-claim-refunded:${params.claimId}`,
      });
    } catch (err) {
      // The in-app row is out; the record stays so no retry writes another.
      report(reportDeps, err, "email_failed", extra);
    }

    await deps.idempotency.commit(
      key,
      { sentAt: new Date().toISOString() },
      CLAIM_REFUNDED_NOTICE_KEEP_SEC,
    );
    try {
      logger?.info("notify.claim_refunded.sent", extra);
    } catch {
      // Logging is not the outcome.
    }
    return "sent";
  } catch (err) {
    if (delivered) {
      // Told already: only the final ledger write failed. The `writing`
      // record from before the in-app write still blocks a second notice.
      report(reportDeps, err, "settle_failed", extra);
      return "sent";
    }
    try {
      if (markerWritten) {
        // The in-app write itself failed: replace the `writing` record so a
        // later trigger may try again.
        await deps.idempotency.fail(
          key,
          "in_app_write_failed",
          WRITE_FAILED_KEEP_SEC,
        );
      } else {
        await deps.idempotency.release(key, token);
      }
    } catch {
      // The claim then lapses on its own TTL (or the `writing` record stays,
      // which leaves the notice missing rather than doubled).
    }
    report(reportDeps, err, "failed", extra);
    return "failed";
  }
}

/**
 * Webhook entry point: if `orderId` is a REFUNDED resale order with an
 * APPROVED claim, sends that claim's refund notice (at most once, see
 * {@link notifyClaimRefunded}). Any other refund (a primary order, a resale
 * order with no claim or an undecided one) gets nothing from here. Never
 * throws.
 */
export async function notifyClaimRefundedForOrder(
  deps: ClaimRefundedNotifyDeps,
  params: {
    orderId: string;
    /** The Stripe refund the webhook is reconciling, when it carries one. */
    refundId?: string | null;
    /** Cumulative refunded on the charge; used only if Stripe can't say. */
    amountRefundedCents: number;
  },
): Promise<ClaimRefundedNoticeOutcome | "not_a_claim_refund"> {
  try {
    const order = await deps.repos.orders.getById(params.orderId);
    if (!order || order.source !== "RESALE" || order.status !== "REFUNDED") {
      return "not_a_claim_refund";
    }
    for (const item of order.items) {
      if (item.kind !== "ticket") continue;
      const claim = await deps.repos.claims.getByOrderItemId(item.id);
      if (claim?.status !== "approved") continue;
      return await notifyClaimRefunded(deps, {
        claimId: claim.id,
        claimantId: claim.claimantId,
        orderId: order.id,
        eventId: claim.eventId,
        currency: order.currency,
        amount: {
          refundId: params.refundId ?? null,
          paymentIntentId: order.stripePaymentIntentId ?? null,
          fallbackCents: params.amountRefundedCents,
        },
      });
    }
    return "not_a_claim_refund";
  } catch (err) {
    report(
      { logger: safeChild(deps.logger), reportError: deps.reportError },
      err,
      "lookup_failed",
      { orderId: params.orderId },
    );
    return "failed";
  }
}
