import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import Stripe from "stripe";

import { finalizePaymentIntent } from "@th/core/use-cases/orders/finalize-from-payment-intent";
import {
  closeDispute,
  openDispute,
  recordFundsWithdrawn,
  refreshDispute,
  type StripeDisputeLifecycleInput,
} from "@th/core/use-cases/disputes";
import { reconcileStripeFullRefund } from "@th/core/use-cases/orders/reconcile-stripe-full-refund";
import { ensureEntityDefaultPayoutTermsForAccount } from "@th/core/use-cases/payout-terms/ensure-entity-default-payout-terms-for-account";
import { sendTicketIssuedEmail } from "@th/core/use-cases/orders/send-ticket-issued-email";
import { sendResalePurchaseEmail } from "@th/core/use-cases/resale/send-resale-purchase-email";
import { notifyResaleSellerSold } from "@th/core/use-cases/resale/notify-resale-seller-sold";
import { getMetaString } from "@th/core/lib/orders/meta";
import {
  AccountUpdatedZ,
  AccountDeauthorizedZ,
  ChargeRefundedZ,
  CustomerUpdatedZ,
  RefundUpdatedZ,
  MembershipInvoiceZ,
  MembershipSubscriptionZ,
  MembershipUpcomingInvoiceZ,
  customerBillingAddress,
  membershipInvoiceExclusiveTaxCents,
  membershipInvoicePaymentIntentId,
  membershipInvoiceSubscriptionId,
  membershipInvoiceSubscriptionMetadata,
  membershipSubscriptionPeriod,
} from "@th/adapters/payment-processors/stripe/events/guards";
import {
  recordMembershipInvoicePaid,
  recordMembershipPaymentFailed,
  sendRenewalNotice,
  syncMembershipFromStripe,
  updateMemberBillingAddress,
} from "@th/core/use-cases/memberships";
import { syncConnectAccount } from "@th/core/use-cases/stripe-connect/sync-connect-account";
import { onAccountDeauthorized } from "@th/adapters/payment-processors/stripe/events/handlers/account-deauthorized";
import { onChargeRefunded } from "@th/adapters/payment-processors/stripe/events/handlers/charge-refunded";
import { onRefundUpdated } from "@th/adapters/payment-processors/stripe/events/handlers/refund-updated";
import { logAndReport } from "@th/adapters/infra/discord-alerts";
import { env, forceConnectCapabilities } from "../../lib/env";
import { Sentry } from "../../instrument";
import { fireDiscordAlert } from "../../lib/dep";
import { WebhookDlq } from "../../lib/webhook-dlq";
import { buildSettlementFailureAlerter } from "../../lib/settlement-failure-alert";
import { resolveWebhookAppCode } from "../../lib/webhook-app-code";

/**
 * Stripe webhooks.
 *
 * Route: POST /webhooks/stripe
 *
 * Important:
 * - Stripe signature verification requires the *raw* request body.
 * - Our `raw-body` plugin parses unknown content-types as Buffer and JSON as string->object.
 *   For Stripe, we only proceed when we have a raw Buffer.
 *
 * ── Failure policy (do not weaken) ──────────────────────────────────────────
 * Every event that verifies but is not fully applied MUST end up in the Redis
 * DLQ *and* in Sentry. Previously only the outer catch-all pushed to the DLQ,
 * so three whole classes of failure were swallowed on a 200 and lost forever
 * (Stripe does not retry a 2xx):
 *
 *   - per-handler inner `catch`es (Sentry + Discord, then `break`);
 *   - Zod/shape parse failures (`logger.warn` + `break` — warn is NOT captured
 *     by Sentry, see CLAUDE.md);
 *   - handlers that found no `metadata.orderId` to act on.
 *
 * The structural fix: handlers no longer swallow. They throw
 * `WebhookStageError`, which carries the alert context the inner catch used to
 * own, and the single outer catch does Sentry + Discord + DLQ for all of them.
 * If you add a handler, you get DLQ coverage by default — and
 * `__tests__/webhook-failure-coverage.test.ts` fails if a `case` re-introduces
 * a swallowing `catch` or a bare `break` on a parse failure.
 *
 * The two log messages `stripe_webhook_unhandled_error_dlq` and
 * `stripe_webhook_dlq_store_failed` are load-bearing: infra/terraform's
 * `stripe_webhook_failures` log metric matches on them verbatim. Renaming them
 * silently disables the production alert.
 */

/** Alert/report context a failing handler stage attaches for the outer catch. */
export type WebhookStageContext = {
  /** Short machine-readable stage id, e.g. "account.updated:parse". */
  stage: string;
  /** Structured log message. */
  message: string;
  /** Discord alert title. */
  title: string;
  /** Discord alert description. */
  description: string;
  fields: Array<{ name: string; value: string; inline?: boolean }>;
  tags: Record<string, string | undefined>;
  extra: Record<string, unknown>;
};

/**
 * Thrown by a handler stage instead of swallowing. Carries the alert context
 * the old inner `catch` blocks used to consume locally, so the single outer
 * catch can report it identically *and* guarantee the DLQ push.
 */
export class WebhookStageError extends Error {
  readonly context: WebhookStageContext;

  constructor(context: WebhookStageContext, options?: { cause?: unknown }) {
    super(context.message, options as ErrorOptions);
    this.name = "WebhookStageError";
    this.context = context;
  }
}

/**
 * A verified event whose payload didn't match our guard.
 *
 * This used to `logger.warn` and `break` — invisible to Sentry, absent from the
 * DLQ, and answered 200 so Stripe never retried. A Stripe API-version change to
 * one field therefore black-holed that event type permanently. Now it lands in
 * the DLQ with the full raw payload, which is exactly what you need to widen
 * the guard and replay.
 */
function parseFailure(
  event: Stripe.Event,
  eventType: string,
  error: {
    issues?: Array<{ path: PropertyKey[]; message: string }>;
    flatten(): unknown;
  } | null,
): WebhookStageError {
  // The WHICH-FIELD summary rides in `cause`, because `cause` is what the
  // outer sink writes into the DLQ row's `error` field. Without it the sink
  // falls back to the wrapper, whose `.message` is the log key — so the
  // operator page rendered "stripe_webhook_payload_parse_failed:
  // stripe_webhook_payload_parse_failed" while the Zod detail (the one thing
  // you need to widen the guard and replay) went only to Sentry `extra`.
  return new WebhookStageError(
    {
      stage: `${eventType}:parse`,
      message: "stripe_webhook_payload_parse_failed",
      title: "Stripe: webhook payload did not match our guard",
      description:
        "A verified Stripe event failed shape validation and was NOT applied. It is in the webhook DLQ with the raw payload — usually this means Stripe changed a field and the Zod guard needs widening.",
      fields: [
        { name: "Event", value: event.id, inline: true },
        { name: "Type", value: eventType, inline: true },
      ],
      tags: { stripeEventId: event.id, stripeEventType: eventType },
      extra: {
        eventId: event.id,
        type: eventType,
        validationErrors: error ? error.flatten() : "unparseable_payload_shape",
      },
    },
    { cause: new Error(summarizeValidationIssues(error)) },
  );
}

/**
 * Compress a ZodError into one DLQ-row-sized line: the first few failing
 * paths with their messages. Structural (`issues` array), not `instanceof
 * ZodError`, so a zod major bump can't silently turn every summary generic.
 */
function summarizeValidationIssues(
  error: {
    issues?: Array<{ path: PropertyKey[]; message: string }>;
  } | null,
): string {
  const issues = error?.issues;
  if (!issues || issues.length === 0) return "payload shape not recognized";
  const shown = issues
    .slice(0, 3)
    .map(
      (issue) =>
        `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`,
    );
  const rest = issues.length - shown.length;
  return shown.join("; ") + (rest > 0 ? ` (+${rest} more)` : "");
}

const plugin: FastifyPluginAsync = async (app) => {
  const logger = app.deps.logger.child({ route: "stripe/webhook" });
  const toErrorMessage = (error: unknown): string => {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    // Prisma driver-adapter errors (and other non-Error throwables) are plain
    // objects, and String() renders them "[object Object]" — which is exactly
    // what the DLQ page showed an operator for a real DB outage
    // ("stripe_webhook_account_updated_failed: [object Object]"). Prefer a
    // message-shaped property, then JSON, then give up honestly.
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.length > 0) return message;
      try {
        const json = JSON.stringify(error);
        if (json && json !== "{}") return json.slice(0, 500);
      } catch {
        // Circular or hostile object — fall through to String().
      }
    }
    return String(error);
  };
  const reportStripeWebhookFailure = ({
    error,
    message,
    title,
    description,
    fields,
    tags,
    extra,
  }: {
    error: unknown;
    message: string;
    title: string;
    description: string;
    fields: Array<{ name: string; value: string; inline?: boolean }>;
    tags: Record<string, string | undefined>;
    extra: Record<string, unknown>;
  }) => {
    // Stamp the canonical AppErrorCode (FR-011) onto the structured log + Sentry
    // tags so webhook failures are grepable by the same code the rest of the
    // stack uses. Logging-only — the provider-facing response is untouched.
    const appCode = resolveWebhookAppCode(error) ?? undefined;
    // RETURNED, not `void`ed, so the sink can await it. Cloud Run throttles
    // this instance's CPU the moment the response is written (no `cpu_idle`
    // override in cloud-run-service/main.tf), so a fire-and-forget Discord
    // POST can simply never complete — on exactly the failure that most needs
    // to page someone. apps/jobs awaits its alerts for the same reason.
    // Bounded and rejection-free by construction: `logAndReport` try/catches
    // every stage and the Discord fetch carries AbortSignal.timeout(2000).
    return logAndReport({
      logger,
      level: "error",
      message,
      extra: {
        ...extra,
        error: toErrorMessage(error),
        appCode,
      },
      report: {
        captureException: Sentry.captureException,
        error,
        context: {
          tags: { ...tags, appCode },
          extra,
        },
      },
      alert: {
        send: fireDiscordAlert,
        payload: {
          title,
          colour: "error",
          description,
          fields,
        },
      },
    });
  };

  /**
   * True when no local order references this PaymentIntent — i.e. it wasn't
   * created by our checkout. Distinguishes "foreign PI, safely ignorable" from
   * "our PI whose metadata lost the orderId", which is a real failure worth
   * DLQ-ing. Without this split, every Dashboard-created payment and Stripe
   * Billing invoice would take a slot in a 500-item queue that trims the
   * oldest, evicting genuine failures — and replay could never drain them.
   *
   * KNOWN RESIDUAL: `findByPaymentIntent` matches on `stripePaymentIntentId`,
   * so an order created by us but not yet linked reads as foreign. That needs
   * `metadata.orderId` to ALSO be missing (this helper is only consulted on
   * that branch), and our checkout always stamps it at PI creation — so the
   * combination means the event carries no association to anything on either
   * side. Neither a DLQ entry nor a replay could recover it; the info log is
   * the honest ceiling.
   *
   * A lookup FAILURE returns false, so a transient DB error escalates to the
   * DLQ rather than silently discarding a possibly-ours event.
   */
  const isOrphanPaymentIntent = async (
    paymentIntentId: string,
  ): Promise<boolean> => {
    try {
      const order =
        await app.deps.trpc.repos.orders.findByPaymentIntent(paymentIntentId);
      return order == null;
      // dlq-exempt: a lookup failure falls through to the DLQ path below, which
      // is the conservative choice — we escalate rather than drop.
    } catch {
      return false;
    }
  };

  /**
   * The Membership row behind a Stripe subscription id, or `null` if we do not
   * track it.
   *
   * Stripe Billing invoice events fire for EVERY subscription on the platform
   * account, not just ours — Dashboard-created ones, and anything a future
   * product line bills there. Handing those to the membership use case would
   * throw `MEMBERSHIP_NOT_FOUND` and DLQ ordinary traffic, which is worse than
   * useless: the DLQ is a 500-item queue that trims the oldest, so routine noise
   * evicts the real failures it exists to preserve. This is the same guard
   * `isOrphanPaymentIntent` provides for PaymentIntents.
   *
   * Deliberately NOT wrapped in a try/catch. A lookup failure is a DB problem,
   * not evidence the subscription is foreign, so it propagates to the one sink
   * and the event is preserved for replay.
   */
  const trackedMembership = (subscriptionId: string) =>
    app.deps.trpc.repos.memberships.findByStripeSubscriptionId(subscriptionId);

  /**
   * Runs a VERIFIED Stripe event through the handlers and funnels every
   * failure into Sentry + Discord + the DLQ.
   *
   * Extracted from the route so the admin DLQ page can re-drive a stored event
   * through the exact same code path (see `replayStripeEvent` below). Replaying
   * through a second, drifting copy of this dispatch would be worse than no
   * replay at all.
   */
  const dispatchStripeEvent = async (
    event: Stripe.Event,
    stripe: Stripe,
    options: { replay?: boolean } = {},
  ): Promise<{ ok: boolean; error?: string }> => {
    const webhookDlq = new WebhookDlq(app.deps.redis);

    // We only handle the event(s) we support; everything else is acknowledged.
    // The entire switch is wrapped in a catch-all: if any handler throws an
    // unhandled error, the raw Stripe event is stored in a Redis DLQ for
    // investigation/replay, a Discord alert fires, and we return 200 so
    // Stripe stops retrying into a broken handler.
    try {
      switch (event.type) {
        case "payment_intent.succeeded": {
          const pi = event.data.object as {
            id: string;
            metadata?: Record<string, string>;
          };

          // Guard BEFORE finalize, mirroring the sibling `processing` /
          // `payment_failed` cases. Stripe Billing PIs (membership invoice
          // payments) carry no `metadata.orderId`; handing them to
          // `finalizePaymentIntent` throws on parse — one Sentry + Discord +
          // DLQ entry per member per month, and the 500-cap DLQ trims the
          // oldest, evicting REAL failures.
          if (!pi.metadata?.orderId) {
            if (await isOrphanPaymentIntent(pi.id)) {
              // No order anywhere references this PI: a Dashboard-created
              // payment, or a Billing PI whose invoice handler has not run
              // yet — `invoice.payment_succeeded` owns recording that money.
              app.log.info(
                { eventId: event.id, paymentIntentId: pi.id },
                "stripe_webhook_orphan_payment_intent",
              );
              break;
            }
            // An order EXISTS for this PI. `recordMembershipInvoicePaid`
            // stores `stripePaymentIntentId` on MEMBERSHIP orders, so a
            // membership PI resolves here once the invoice handler has run —
            // and finalize must not touch it: the invoice handler owns
            // membership orders (splits, settlement, idempotency).
            const linkedRef =
              await app.deps.trpc.repos.orders.findByPaymentIntent(pi.id);
            const linkedOrder = linkedRef
              ? await app.deps.trpc.repos.orders.getById(linkedRef.id)
              : null;
            if (linkedOrder?.kind === "MEMBERSHIP") {
              app.log.info(
                {
                  eventId: event.id,
                  paymentIntentId: pi.id,
                  orderId: linkedOrder.id,
                },
                "stripe_webhook_membership_payment_intent_skipped",
              );
              break;
            }
            // Ours (ticketing) but the metadata lost its orderId — fall
            // through to finalize, whose parse failure escalates to the DLQ.
            // That matches the siblings' "ours but unlinked" posture.
          }

          const result = await finalizePaymentIntent(
            {
              ...app.deps.trpc,
              onSettlementFailure: buildSettlementFailureAlerter({
                logger,
                sendAlert: fireDiscordAlert,
                captureException: Sentry.captureException,
                message: "stripe_webhook_settlement_creation_failed",
              }),
            },
            {
              stripeEvent: {
                id: event.id,
                type: "payment_intent.succeeded",
                data: { object: event.data.object },
              },
            },
          );

          // Best-effort: persist the payment method type (card, us_bank_account, etc.)
          try {
            const { methodType } =
              await app.deps.trpc.payments.getPaymentMethodType({
                paymentIntentId: pi.id,
              });
            if (methodType) {
              await app.deps.trpc.repos.orders.setPaymentMethodType(
                result.orderId,
                methodType,
              );
            }
            // dlq-exempt: cosmetic order metadata, not the event's outcome.
            // The payment is already finalized and the ticket already issued;
            // failing the whole event over a missing payment-method label would
            // trade a real delivery for a label.
          } catch (err) {
            app.log.warn(
              {
                orderId: result.orderId,
                error: err instanceof Error ? err.message : String(err),
                appCode: resolveWebhookAppCode(err) ?? undefined,
              },
              "stripe_webhook_set_payment_method_type_failed",
            );
          }

          if (app.deps.mailer) {
            const publicAppUrl = env.PUBLIC_WEB_URL ?? "http://127.0.0.1:3000";
            const supportUrl = env.SUPPORT_URL ?? `${publicAppUrl}/support`;

            // For resale orders the ticket already exists (it was
            // reassigned, not minted) so `sendTicketIssuedEmail` would
            // throw because `tickets.listByOrderId(resaleOrderId)`
            // returns 0 rows. Send a resale-specific receipt instead,
            // and notify the seller their ticket has been sold.
            const order = await app.deps.trpc.repos.orders.getById(
              result.orderId,
            );
            if (order && order.source === "RESALE") {
              const notifyDeps = {
                repos: app.deps.trpc.repos,
                mailer: app.deps.mailer,
                logger: app.deps.logger,
              };

              // Buyer receipt (fire-and-forget, never throws)
              await sendResalePurchaseEmail(notifyDeps, {
                orderId: result.orderId,
                publicAppUrl,
                supportUrl,
                tileServerUrl: env.TILESERVER_URL || undefined,
              });

              // Seller "your ticket sold" notification (fire-and-forget, never throws)
              const ticketItem = order.items.find((i) => i.kind === "ticket");
              const listingId = ticketItem
                ? getMetaString(ticketItem.meta, "resaleListingId")
                : undefined;

              if (listingId) {
                await notifyResaleSellerSold(notifyDeps, {
                  orderId: result.orderId,
                  listingId,
                  publicAppUrl,
                });
              }
            } else {
              await sendTicketIssuedEmail(
                {
                  repos: app.deps.trpc.repos,
                  mailer: app.deps.mailer,
                  logger: app.deps.logger,
                },
                {
                  orderId: result.orderId,
                  publicAppUrl,
                  supportUrl,
                  tileServerUrl: env.TILESERVER_URL || undefined,
                },
              );
            }
          } else if (!app.deps.trpc.isProduction) {
            // Mail is genuinely unconfigured here (bare local API, CI, a
            // preview revision). DLQ-ing would push an entry for EVERY
            // successful payment, and replay could never drain them: the
            // finalize short-circuits on `status === "SUCCEEDED"` and then
            // throws the same no-mailer error. Stay loud via `logger.error`
            // (Sentry-captured) without poisoning a 500-item queue.
            app.log.error(
              {
                eventId: event.id,
                orderId: result.orderId,
                hasHost: Boolean(env.SMTP_HOST),
                hasFrom: Boolean(env.SMTP_DEFAULT_FROM_EMAIL),
              },
              "stripe_webhook_missing_smtp_config",
            );
          } else {
            // In production a missing mailer means the buyer paid and never
            // received their ticket. This was a warn + 200: invisible to
            // Sentry, absent from the DLQ, and never retried. The order is
            // already finalized (and `finalizePaymentIntent` is idempotent), so
            // DLQ-ing costs a no-op finalize on replay and buys back the email.
            throw new WebhookStageError({
              stage: "payment_intent.succeeded:no_mailer",
              message: "stripe_webhook_missing_smtp_config",
              title: "Stripe: ticket email not sent (no mailer configured)",
              description:
                "A payment succeeded and the order was finalized, but no mailer is configured so the buyer received no ticket email. Fix the SMTP config and replay from the webhook DLQ.",
              fields: [
                { name: "Event", value: event.id, inline: true },
                { name: "Order", value: result.orderId, inline: true },
              ],
              tags: { stripeEventId: event.id, orderId: result.orderId },
              extra: {
                eventId: event.id,
                orderId: result.orderId,
                hasHost: Boolean(env.SMTP_HOST),
                hasPort: Boolean(env.SMTP_PORT),
                hasFrom: Boolean(env.SMTP_DEFAULT_FROM_EMAIL),
              },
            });
          }
          app.log.info(
            {
              eventId: event.id,
              orderId: result.orderId,
            },
            "stripe_webhook_payment_intent_succeeded",
          );
          break;
        }

        // ── Delayed notification payments (ACH, bank transfer) ──────
        // The PI moves to "processing" when the buyer confirms the debit
        // but funds haven't settled yet (up to 4 business days for ACH).
        // Mark the order PROCESSING so the UI shows a "payment pending"
        // confirmation. The funds will settle later and trigger
        // payment_intent.succeeded (handled above) which issues tickets.
        case "payment_intent.processing": {
          const pi = event.data.object as {
            id: string;
            metadata?: Record<string, string>;
          };
          const orderId = pi.metadata?.orderId;
          if (orderId) {
            try {
              const order = await app.deps.trpc.repos.orders.getById(orderId);
              if (order && order.status === "PENDING") {
                // Link the PI if it hasn't been linked yet (covers race with client confirm)
                if (!order.stripePaymentIntentId) {
                  await app.deps.trpc.repos.orders.linkPaymentIntent(
                    orderId,
                    pi.id,
                  );
                }
                await app.deps.trpc.repos.orders.markProcessing(orderId);

                // Best-effort: persist the payment method type early
                try {
                  const { methodType } =
                    await app.deps.trpc.payments.getPaymentMethodType({
                      paymentIntentId: pi.id,
                    });
                  if (methodType) {
                    await app.deps.trpc.repos.orders.setPaymentMethodType(
                      orderId,
                      methodType,
                    );
                  }
                  // dlq-exempt: cosmetic order metadata (see above).
                } catch (pmErr) {
                  app.log.warn(
                    {
                      orderId,
                      error:
                        pmErr instanceof Error ? pmErr.message : String(pmErr),
                      appCode: resolveWebhookAppCode(pmErr) ?? undefined,
                    },
                    "stripe_webhook_processing_set_payment_method_type_failed",
                  );
                }
              }
              // If already PROCESSING or SUCCEEDED, this is a replay — no-op.
            } catch (err) {
              throw new WebhookStageError(
                {
                  stage: "payment_intent.processing:apply",
                  message: "stripe_webhook_processing_failed",
                  title: "Stripe: payment processing failed",
                  description:
                    "Stripe marked a payment as processing, but the order update failed. The event is in the webhook DLQ for replay.",
                  fields: [
                    { name: "Event", value: event.id, inline: true },
                    {
                      name: "Order",
                      value: orderId ?? "unknown",
                      inline: true,
                    },
                  ],
                  tags: {
                    stripeEventId: event.id,
                    orderId: orderId ?? "unknown",
                  },
                  extra: { eventId: event.id, orderId },
                },
                { cause: err },
              );
            }
          } else if (await isOrphanPaymentIntent(pi.id)) {
            // Not one of ours (a Dashboard-created PI, a Stripe Billing
            // invoice payment, an out-of-band test charge). Ignore it the same
            // way we ignore unhandled event types. DLQ-ing these would be a
            // slow leak: the queue is capped at 500 and trims the oldest, so a
            // steady trickle of foreign PIs would evict genuinely failed
            // events — and they could never be drained, since a replay still
            // has no orderId.
            app.log.info(
              { eventId: event.id, paymentIntentId: pi.id },
              "stripe_webhook_processing_foreign_payment_intent",
            );
          } else {
            // We DO have an order for this PI but the metadata is missing, so
            // the order silently never showed "payment pending". This used to
            // be a warn (invisible) + 200 (no retry).
            throw new WebhookStageError({
              stage: "payment_intent.processing:no_order_id",
              message: "stripe_webhook_processing_no_order_id",
              title: "Stripe: processing PI carried no orderId",
              description:
                "A payment_intent.processing event had no metadata.orderId, so no order could be marked PROCESSING. Event captured in the webhook DLQ.",
              fields: [
                { name: "Event", value: event.id, inline: true },
                { name: "PaymentIntent", value: pi.id, inline: true },
              ],
              tags: { stripeEventId: event.id, paymentIntentId: pi.id },
              extra: { eventId: event.id, paymentIntentId: pi.id },
            });
          }
          app.log.info(
            { eventId: event.id, paymentIntentId: pi.id, orderId },
            "stripe_webhook_payment_intent_processing",
          );
          break;
        }

        // ── Failed delayed payment (ACH returns, bank transfer failures) ──
        // If an ACH debit or bank transfer fails after entering "processing",
        // Stripe sends payment_intent.payment_failed. Cancel the order so
        // inventory is released. The buyer will need to start a new checkout.
        case "payment_intent.payment_failed": {
          const pi = event.data.object as {
            id: string;
            metadata?: Record<string, string>;
            last_payment_error?: { message?: string };
          };
          const orderId = pi.metadata?.orderId;
          if (orderId) {
            try {
              const order = await app.deps.trpc.repos.orders.getById(orderId);
              if (order && order.status === "PROCESSING") {
                await app.deps.trpc.repos.orders.cancelProcessingOrder(orderId);
                app.log.info(
                  { orderId },
                  "stripe_webhook_processing_order_cancelled",
                );
              } else if (order && order.status === "PENDING") {
                // A payment can fail while still PENDING (e.g. card decline
                // before the processing webhook arrives, or microdeposit failure).
                await app.deps.trpc.repos.orders.cancelPendingOrder(orderId);
                app.log.info(
                  { orderId },
                  "stripe_webhook_pending_order_cancelled",
                );
              }
              // Already CANCELLED, SUCCEEDED, etc. — no-op.
            } catch (err) {
              throw new WebhookStageError(
                {
                  stage: "payment_intent.payment_failed:apply",
                  message: "stripe_webhook_payment_failed_handler_error",
                  title: "Stripe: payment_failed handler error",
                  description:
                    "Stripe reported a payment failure, but the order cancellation flow did not complete — inventory may still be held. The event is in the webhook DLQ for replay.",
                  fields: [
                    { name: "Event", value: event.id, inline: true },
                    {
                      name: "Order",
                      value: orderId ?? "unknown",
                      inline: true,
                    },
                  ],
                  tags: {
                    stripeEventId: event.id,
                    orderId: orderId ?? "unknown",
                  },
                  extra: { eventId: event.id, orderId },
                },
                { cause: err },
              );
            }
          } else if (await isOrphanPaymentIntent(pi.id)) {
            // Not one of ours — see the equivalent branch on
            // `payment_intent.processing` for why this must not reach the DLQ.
            app.log.info(
              { eventId: event.id, paymentIntentId: pi.id },
              "stripe_webhook_payment_failed_foreign_payment_intent",
            );
          } else {
            // We DO have an order for this PI but the metadata is missing, so
            // it was never cancelled and its inventory is still held.
            // Previously a warn + 200: invisible and final.
            throw new WebhookStageError({
              stage: "payment_intent.payment_failed:no_order_id",
              message: "stripe_webhook_payment_failed_no_order_id",
              title: "Stripe: failed PI carried no orderId",
              description:
                "A payment_intent.payment_failed event had no metadata.orderId, so no order was cancelled and its inventory was not released. Event captured in the webhook DLQ.",
              fields: [
                { name: "Event", value: event.id, inline: true },
                { name: "PaymentIntent", value: pi.id, inline: true },
              ],
              tags: { stripeEventId: event.id, paymentIntentId: pi.id },
              extra: { eventId: event.id, paymentIntentId: pi.id },
            });
          }
          app.log.info(
            {
              eventId: event.id,
              paymentIntentId: pi.id,
              orderId,
              failureMessage: pi.last_payment_error?.message,
            },
            "stripe_webhook_payment_intent_failed",
          );
          break;
        }

        // ── Connect account capability changes ───────────────────────────
        // Fired whenever a connected account's status changes (onboarding
        // completed, capabilities verified/restricted, payouts enabled, etc.).
        // We sync `chargesEnabled` / `payoutsEnabled` on the Payee record so
        // the payout batch and checkout guards stay accurate.
        case "account.updated": {
          const parsed = AccountUpdatedZ.safeParse(event.data.object);
          if (!parsed.success) {
            throw parseFailure(event, "account.updated", parsed.error);
          }
          try {
            // Capability derivation lives in core so this webhook and the
            // live-Stripe read on the Payments page cannot disagree — the
            // divergence between them is what silently blocked orgs from
            // publishing paid events. `observedAt` is the Stripe event time,
            // which the repo uses as an ordering guard against late retries.
            await syncConnectAccount(
              {
                repos: app.deps.trpc.repos,
                logger: app.deps.logger,
                reportError: Sentry.captureException,
              },
              {
                account: {
                  stripeAccountId: parsed.data.id,
                  chargesEnabled: parsed.data.charges_enabled ?? null,
                  payoutsEnabled: parsed.data.payouts_enabled ?? null,
                  capabilities: parsed.data.capabilities ?? null,
                  defaultCurrency: parsed.data.default_currency ?? null,
                  requirements: parsed.data.requirements ?? null,
                },
                observedAt: stripeEventCreatedAt(event),
                source: "webhook",
                forceEnabled: forceConnectCapabilities,
              },
            );
            app.log.info(
              { eventId: event.id, accountId: parsed.data.id },
              "stripe_webhook_account_updated",
            );

            // Eager auto-provision: once the account is synced (and possibly
            // promoted to ACTIVE), ensure the owning entity has a reusable
            // default PRIMARY payout-terms agreement. This use case is
            // idempotent and NEVER throws, so it can't break sibling event
            // processing or the surrounding handler.
            const provisionResult =
              await ensureEntityDefaultPayoutTermsForAccount(
                {
                  repos: app.deps.trpc.repos,
                  clock: app.deps.trpc.clock,
                  logger: app.deps.logger,
                },
                { stripeAccountId: parsed.data.id },
              );
            if (provisionResult.payoutTermsId) {
              app.log.info(
                {
                  eventId: event.id,
                  accountId: parsed.data.id,
                  payoutTermsId: provisionResult.payoutTermsId,
                },
                "stripe_webhook_account_updated_default_terms_ensured",
              );
            }
          } catch (err) {
            throw new WebhookStageError(
              {
                stage: "account.updated:apply",
                message: "stripe_webhook_account_updated_failed",
                title: "Stripe: account_updated handler error",
                description:
                  "A connected account update could not be applied locally. This is the ONLY webhook that promotes a Payee to payouts-enabled, so losing it blocks the org from publishing paid events. The event is in the webhook DLQ for replay.",
                fields: [
                  { name: "Event", value: event.id, inline: true },
                  { name: "Account", value: parsed.data.id, inline: true },
                ],
                tags: { stripeEventId: event.id, accountId: parsed.data.id },
                extra: { eventId: event.id, accountId: parsed.data.id },
              },
              { cause: err },
            );
          }
          break;
        }

        // ── Connect account deauthorization ─────────────────────────────
        // Fired when an org revokes our platform's access to their Connect
        // account. We immediately restrict the payee and cancel pending
        // settlements since transfers will never succeed.
        case "account.application.deauthorized": {
          const parsed = AccountDeauthorizedZ.safeParse(event.data.object);
          if (!parsed.success) {
            throw parseFailure(
              event,
              "account.application.deauthorized",
              parsed.error,
            );
          }
          try {
            const result = await onAccountDeauthorized(
              { repos: app.deps.trpc.repos, logger: app.deps.logger },
              parsed.data,
            );
            app.log.warn(
              {
                eventId: event.id,
                accountId: parsed.data.id,
                payeeId: result.payeeId,
              },
              "stripe_webhook_account_deauthorized",
            );

            // Always alert — this is a critical event that needs human attention.
            const fields = [
              { name: "Stripe Account", value: parsed.data.id, inline: true },
              {
                name: "Payee ID",
                value: result.payeeId ?? "unknown",
                inline: true,
              },
            ];
            // Awaited for the same CPU-throttle reason as the failure sink:
            // a `void`ed POST after the response is written may never run.
            // This is THE alert for a revoked Connect account — the one event
            // where a human must act. Never rejects (see logAndReport).
            await logAndReport({
              logger,
              level: "error",
              message: "stripe_webhook_account_deauthorized",
              extra: {
                eventId: event.id,
                accountId: parsed.data.id,
                payeeId: result.payeeId ?? null,
              },
              alert: {
                send: fireDiscordAlert,
                payload: {
                  title: "Connect Account Deauthorized",
                  colour: "error",
                  description:
                    "A connected account revoked platform access. Payee marked RESTRICTED; ledger credits stay (payouts blocked by the eligibility guard).",
                  fields,
                },
              },
            });
          } catch (err) {
            throw new WebhookStageError(
              {
                stage: "account.application.deauthorized:apply",
                message: "stripe_webhook_account_deauthorized_handler_error",
                title: "Stripe: account deauthorized handler failed",
                description:
                  "A connected account was deauthorized, but the local restriction flow did not complete — the payee may still be payable. Manual intervention may be required; the event is in the webhook DLQ for replay.",
                fields: [
                  { name: "Event", value: event.id, inline: true },
                  { name: "Account", value: parsed.data.id, inline: true },
                ],
                tags: { stripeEventId: event.id, accountId: parsed.data.id },
                extra: { eventId: event.id, accountId: parsed.data.id },
              },
              { cause: err },
            );
          }
          break;
        }

        // ── Refund confirmation from Stripe ─────────────────────────────
        // Fired when a refund on a charge succeeds (including refunds
        // initiated from the Stripe Dashboard). We log for audit trail;
        // our own refund flows already update order status synchronously,
        // but this catches out-of-band refunds.
        case "charge.refunded": {
          const parsed = ChargeRefundedZ.safeParse(event.data.object);
          if (!parsed.success) {
            throw parseFailure(event, "charge.refunded", parsed.error);
          }
          await onChargeRefunded(
            {
              logger: app.deps.logger,
              // Partial refunds need the Stripe refund id for their ledger
              // idempotency key; newer API versions omit `charge.refunds`
              // from the event payload, so fetch candidates and pick the one
              // whose `created` sits closest to this event's `created` —
              // BEST-EFFORT: a delayed event racing a newer refund can still
              // resolve the wrong id, which is why the partial debit key is
              // additionally namespaced with the cumulative amount (a stale
              // id recomputes instead of key-replaying).
              getLatestRefundId: async ({ chargeId }) => {
                const refunds = await stripe.refunds.list({
                  charge: chargeId,
                  limit: 10,
                });
                let best: { id: string; distance: number } | undefined;
                for (const refund of refunds.data) {
                  const distance = Math.abs(refund.created - event.created);
                  // Strict `<`: ties keep the earlier hit, and Stripe lists
                  // most-recent-first, so ties resolve to the newest refund.
                  if (!best || distance < best.distance) {
                    best = { id: refund.id, distance };
                  }
                }
                return best?.id;
              },
              reconcileStripeFullRefund: (input) =>
                reconcileStripeFullRefund(
                  {
                    repos: app.deps.trpc.repos,
                    clock: app.deps.trpc.clock,
                    // Per-order refund mutex: a conflict throws, the outer
                    // catch DLQs the event, replay redelivers (W1).
                    idempotency: app.deps.trpc.idempotency,
                    logger: app.deps.logger,
                    // Refund-debit swallows must reach Sentry (Step C review).
                    reportError: app.deps.trpc.reportError ?? undefined,
                  },
                  input,
                ),
            },
            parsed.data,
          );
          break;
        }

        // ── Dispute lifecycle ───────────────────────────────────────────
        case "charge.dispute.created": {
          const input = buildDisputeLifecycleInput(event);
          if (!input) {
            throw parseFailure(event, event.type, null);
          }
          const result = await openDispute(app.deps.trpc, input);
          app.log.warn(
            { eventId: event.id, ...result },
            "stripe_webhook_dispute_created",
          );
          break;
        }

        case "charge.dispute.updated": {
          const input = buildDisputeLifecycleInput(event);
          if (!input) {
            throw parseFailure(event, event.type, null);
          }
          const result = await refreshDispute(app.deps.trpc, input);
          app.log.info(
            { eventId: event.id, ...result },
            "stripe_webhook_dispute_updated",
          );
          break;
        }

        case "charge.dispute.funds_withdrawn": {
          const input = buildDisputeLifecycleInput(event, {
            fundsWithdrawnAt: stripeEventCreatedAt(event),
          });
          if (!input) {
            throw parseFailure(event, event.type, null);
          }
          const result = await recordFundsWithdrawn(app.deps.trpc, input);
          app.log.warn(
            { eventId: event.id, ...result },
            "stripe_webhook_dispute_funds_withdrawn",
          );
          break;
        }

        case "charge.dispute.closed": {
          const input = buildDisputeLifecycleInput(event, {
            closedAt: stripeEventCreatedAt(event),
          });
          if (!input) {
            throw parseFailure(event, event.type, null);
          }
          const result = await closeDispute(app.deps.trpc, input);
          app.log.info(
            { eventId: event.id, ...result },
            "stripe_webhook_dispute_closed",
          );
          break;
        }

        // ── Async refund status change (ACH, bank transfer, Cash App) ───
        // Stripe fires `charge.refund.updated` when an async refund
        // transitions out of "pending". If it lands on "failed", the buyer
        // never received the funds even though our DB marked the order as
        // refunded — this is a money anomaly that needs manual reconciliation.
        case "charge.refund.updated": {
          const parsed = RefundUpdatedZ.safeParse(event.data.object);
          if (!parsed.success) {
            throw parseFailure(event, "charge.refund.updated", parsed.error);
          }
          try {
            await onRefundUpdated(
              {
                logger: app.deps.logger,
                audit: app.deps.trpc.repos.audit,
                getChargeRefundState: async ({ chargeId }) => {
                  const charge = await stripe.charges.retrieve(chargeId);
                  return {
                    amountRefundedCents: charge.amount_refunded,
                    fullyRefunded: charge.refunded,
                  };
                },
                reconcileStripeFullRefund: (input) =>
                  reconcileStripeFullRefund(
                    {
                      repos: app.deps.trpc.repos,
                      clock: app.deps.trpc.clock,
                      // Per-order refund mutex: a conflict throws, the outer
                      // catch DLQs the event, replay redelivers (W1).
                      idempotency: app.deps.trpc.idempotency,
                      logger: app.deps.logger,
                      // Refund-debit swallows must reach Sentry (Step C review).
                      reportError: app.deps.trpc.reportError ?? undefined,
                    },
                    input,
                  ),
              },
              parsed.data,
            );

            // For failed refunds, also look up the associated order so the
            // log entry is actionable without needing to cross-reference Stripe.
            if (parsed.data.status === "failed" && parsed.data.payment_intent) {
              const order =
                await app.deps.trpc.repos.orders.findByPaymentIntent(
                  parsed.data.payment_intent,
                );
              app.log.error(
                {
                  eventId: event.id,
                  refundId: parsed.data.id,
                  paymentIntentId: parsed.data.payment_intent,
                  orderId: order?.id ?? "unknown",
                  orderStatus: order?.status ?? "unknown",
                  amountCents: parsed.data.amount,
                  currency: parsed.data.currency,
                  failureReason: parsed.data.failure_reason ?? "unknown",
                },
                "stripe_webhook_async_refund_failed",
              );
            } else {
              app.log.info(
                {
                  eventId: event.id,
                  refundId: parsed.data.id,
                  status: parsed.data.status,
                },
                "stripe_webhook_refund_updated",
              );
            }
          } catch (err) {
            throw new WebhookStageError(
              {
                stage: "charge.refund.updated:apply",
                message: "stripe_webhook_refund_updated_handler_error",
                title: "Stripe: refund_updated handler error",
                description:
                  "A Stripe refund update could not be reconciled locally. The event is in the webhook DLQ for replay.",
                fields: [
                  { name: "Event", value: event.id, inline: true },
                  { name: "Refund", value: parsed.data.id, inline: true },
                ],
                tags: { stripeEventId: event.id, refundId: parsed.data.id },
                extra: { eventId: event.id, refundId: parsed.data.id },
              },
              { cause: err },
            );
          }
          break;
        }

        // ── Recurring memberships (Stripe Billing) ──────────────────────
        // A membership invoice becomes an ordinary Order (kind = MEMBERSHIP),
        // so settlement, refunds, the ledger and dispute holds work unchanged.
        case "invoice.payment_succeeded": {
          const parsed = MembershipInvoiceZ.safeParse(event.data.object);
          if (!parsed.success) {
            throw parseFailure(event, event.type, parsed.error);
          }
          const invoice = parsed.data;

          const subscriptionId = membershipInvoiceSubscriptionId(invoice);
          const membership = subscriptionId
            ? await trackedMembership(subscriptionId)
            : null;
          if (!membership) {
            // First-invoice race: for a no-trial subscription Stripe pays the
            // first invoice INSIDE `subscriptions.create`, so this event can
            // arrive before our own `memberships.create` commits. The
            // subscription's metadata (stamped by `startMembership`) is the
            // tell: if it carries our tierId/memberHumanId stamp, this IS ours
            // — a terminal "not ours" 200 here would silently drop paid money
            // with no retry. Throw so the event DLQs; a replay after the row
            // lands succeeds.
            const subscriptionMetadata =
              membershipInvoiceSubscriptionMetadata(invoice);
            if (
              subscriptionMetadata?.tierId &&
              subscriptionMetadata?.memberHumanId
            ) {
              throw new WebhookStageError({
                stage: "invoice.payment_succeeded:membership_row_pending",
                message: "stripe_webhook_membership_row_pending",
                title: "Stripe: paid membership invoice beat its Membership row",
                description:
                  "An invoice.payment_succeeded event carries our membership metadata stamp, but no Membership row exists yet for its subscription (the first-invoice race, or a failed startMembership persist). The event is in the webhook DLQ — replay once the row exists, or investigate why it never landed.",
                fields: [
                  { name: "Event", value: event.id, inline: true },
                  {
                    name: "Subscription",
                    value: subscriptionId ?? "unknown",
                    inline: true,
                  },
                ],
                tags: {
                  stripeEventId: event.id,
                  stripeSubscriptionId: subscriptionId ?? undefined,
                },
                extra: {
                  eventId: event.id,
                  invoiceId: invoice.id,
                  subscriptionId: subscriptionId ?? null,
                  tierId: subscriptionMetadata.tierId,
                  memberHumanId: subscriptionMetadata.memberHumanId,
                },
              });
            }
            // Genuinely not ours — no association at all. The platform
            // account carries invoices from the Dashboard and from anything
            // else billed on it, and DLQ-ing those would evict genuine
            // failures from a 500-item queue (the same argument as
            // `isOrphanPaymentIntent`). A LOOKUP failure throws rather than
            // landing here, so a transient DB error still escalates.
            app.log.info(
              {
                eventId: event.id,
                invoiceId: invoice.id,
                subscriptionId: subscriptionId ?? null,
              },
              "stripe_webhook_membership_invoice_not_ours",
            );
            break;
          }

          const paymentIntentId = membershipInvoicePaymentIntentId(invoice);
          const result = await recordMembershipInvoicePaid(
            {
              repos: app.deps.trpc.repos,
              idempotency: app.deps.trpc.idempotency,
              clock: app.deps.trpc.clock,
              logger: app.deps.logger,
              // Dev/e2e seam (same env flag the checkout settlement path
              // uses): schedule the settlement for immediate payout so the
              // batch runner can be exercised without a month boundary.
              // `DEV_INSTANT_PAYOUTS` is force-false in production.
              instantPayouts: env.DEV_INSTANT_PAYOUTS,
            },
            {
              stripeInvoiceId: invoice.id,
              stripeSubscriptionId: membership.stripeSubscriptionId,
              stripeCustomerId: invoice.customer ?? membership.stripeCustomerId,
              stripePaymentIntentId: paymentIntentId,
              amountPaidCents: invoice.amount_paid,
              subtotalCents: invoice.subtotal,
              taxAmountCents: membershipInvoiceExclusiveTaxCents(invoice),
              currency: invoice.currency,
              invoiceCreatedAt: new Date(invoice.created * 1000),
              periodStart: new Date(invoice.period_start * 1000),
              periodEnd: new Date(invoice.period_end * 1000),
              stripeEventId: event.id,
            },
          );
          app.log.info(
            { eventId: event.id, ...result },
            "stripe_webhook_membership_invoice_paid",
          );
          break;
        }

        case "invoice.payment_failed": {
          const parsed = MembershipInvoiceZ.safeParse(event.data.object);
          if (!parsed.success) {
            throw parseFailure(event, event.type, parsed.error);
          }
          const invoice = parsed.data;

          const subscriptionId = membershipInvoiceSubscriptionId(invoice);
          const membership = subscriptionId
            ? await trackedMembership(subscriptionId)
            : null;
          if (!membership) {
            // Deliberately NOT widened with the metadata-stamp detection the
            // paid case uses: only the paid case moves money. A failed
            // invoice that races the row records nothing irrecoverable —
            // Stripe Billing owns the retry schedule and re-emits, and the
            // subscription lifecycle events keep the status mirrored once the
            // row lands. DLQ-ing these would re-open the queue-eviction
            // problem for zero recovered value.
            app.log.info(
              {
                eventId: event.id,
                invoiceId: invoice.id,
                subscriptionId: subscriptionId ?? null,
              },
              "stripe_webhook_membership_invoice_not_ours",
            );
            break;
          }

          const result = await recordMembershipPaymentFailed(
            {
              repos: app.deps.trpc.repos,
              idempotency: app.deps.trpc.idempotency,
              clock: app.deps.trpc.clock,
              logger: app.deps.logger,
            },
            {
              stripeInvoiceId: invoice.id,
              stripeSubscriptionId: membership.stripeSubscriptionId,
              amountDueCents: invoice.amount_due,
              currency: invoice.currency,
              attemptCount: invoice.attempt_count ?? null,
              nextPaymentAttemptAt: invoice.next_payment_attempt
                ? new Date(invoice.next_payment_attempt * 1000)
                : null,
              stripeEventId: event.id,
            },
          );
          // WARN, not info: a member's card just failed. Stripe Billing owns the
          // retry, but this is the leading indicator of involuntary churn.
          app.log.warn(
            { eventId: event.id, invoiceId: invoice.id, ...result },
            "stripe_webhook_membership_payment_failed",
          );
          break;
        }

        // Pre-renewal notice — load-bearing for dispute prevention
        // (recurring-memberships spec, "Dispute policy"): the commonest
        // recurring-billing chargeback is a member who couldn't find how to
        // cancel. NOTE the guard: an upcoming invoice does not exist yet, so
        // the payload has NO invoice id (`MembershipUpcomingInvoiceZ`).
        case "invoice.upcoming": {
          const parsed = MembershipUpcomingInvoiceZ.safeParse(event.data.object);
          if (!parsed.success) {
            throw parseFailure(event, event.type, parsed.error);
          }
          const invoice = parsed.data;

          const subscriptionId = membershipInvoiceSubscriptionId(invoice);
          const membership = subscriptionId
            ? await trackedMembership(subscriptionId)
            : null;
          if (!membership) {
            // NOT widened with the paid case's metadata-stamp detection: an
            // upcoming-invoice notice moves no money, and the race window
            // (seconds around subscription creation) cannot overlap a renewal
            // notice that fires days before the NEXT invoice.
            app.log.info(
              {
                eventId: event.id,
                subscriptionId: subscriptionId ?? null,
              },
              "stripe_webhook_membership_invoice_not_ours",
            );
            break;
          }

          if (!app.deps.mailer) {
            if (app.deps.trpc.isProduction) {
              // Same posture as payment_intent.succeeded's no-mailer branch:
              // in production a missing mailer means a REQUIRED notice was not
              // sent. DLQ it so a replay after the SMTP fix still sends it.
              throw new WebhookStageError({
                stage: "invoice.upcoming:no_mailer",
                message: "stripe_webhook_missing_smtp_config",
                title:
                  "Stripe: membership renewal notice not sent (no mailer configured)",
                description:
                  "A membership renewal is upcoming but no mailer is configured, so the member received no pre-renewal notice. This notice is load-bearing for dispute prevention. Fix the SMTP config and replay from the webhook DLQ.",
                fields: [
                  { name: "Event", value: event.id, inline: true },
                  { name: "Membership", value: membership.id, inline: true },
                ],
                tags: { stripeEventId: event.id, membershipId: membership.id },
                extra: {
                  eventId: event.id,
                  membershipId: membership.id,
                  hasHost: Boolean(env.SMTP_HOST),
                  hasPort: Boolean(env.SMTP_PORT),
                  hasFrom: Boolean(env.SMTP_DEFAULT_FROM_EMAIL),
                },
              });
            }
            // Bare local API / CI / preview: loud (Sentry-captured), not DLQ'd.
            app.log.error(
              { eventId: event.id, membershipId: membership.id },
              "stripe_webhook_missing_smtp_config",
            );
            break;
          }

          const result = await sendRenewalNotice(
            {
              repos: app.deps.trpc.repos,
              idempotency: app.deps.trpc.idempotency,
              mailer: app.deps.mailer,
              clock: app.deps.trpc.clock,
              logger: app.deps.logger,
              publicAppUrl: env.PUBLIC_WEB_URL ?? "http://127.0.0.1:3000",
            },
            {
              stripeSubscriptionId: membership.stripeSubscriptionId,
              amountDueCents: invoice.amount_due,
              currency: invoice.currency,
              // `next_payment_attempt` is when Stripe will charge. For an
              // upcoming invoice it is normally set; `period_end` (the end of
              // the current period = the renewal moment) is the honest
              // fallback when it is not.
              nextPaymentAttempt: invoice.next_payment_attempt
                ? new Date(invoice.next_payment_attempt * 1000)
                : new Date(invoice.period_end * 1000),
              periodStart: new Date(invoice.period_start * 1000),
              periodEnd: new Date(invoice.period_end * 1000),
              stripeEventId: event.id,
            },
          );
          app.log.info(
            { eventId: event.id, ...result },
            "stripe_webhook_membership_renewal_notice",
          );
          break;
        }

        case "customer.subscription.updated":
        case "customer.subscription.deleted": {
          const parsed = MembershipSubscriptionZ.safeParse(event.data.object);
          if (!parsed.success) {
            throw parseFailure(event, event.type, parsed.error);
          }
          const subscription = parsed.data;
          const period = membershipSubscriptionPeriod(subscription);

          // No pre-check here, unlike the invoice cases: the use case itself
          // treats an untracked subscription as a normal no-op, so a second
          // lookup would buy nothing.
          const result = await syncMembershipFromStripe(
            {
              repos: app.deps.trpc.repos,
              clock: app.deps.trpc.clock,
              logger: app.deps.logger,
            },
            {
              stripeSubscriptionId: subscription.id,
              status: subscription.status,
              currentPeriodStart: period.start,
              currentPeriodEnd: period.end,
              cancelAtPeriodEnd: subscription.cancel_at_period_end ?? null,
              canceledAt: subscription.canceled_at
                ? new Date(subscription.canceled_at * 1000)
                : null,
              stripeEventId: event.id,
            },
          );
          app.log.info(
            { eventId: event.id, type: event.type, ...result },
            "stripe_webhook_membership_subscription_synced",
          );
          break;
        }

        // Billing-address change → re-resolve the member's tax jurisdiction
        // and migrate the live subscription's rates. Without this a member who
        // moves keeps billing the OLD jurisdiction's rate forever; as merchant
        // of record the shortfall is ours (recurring-memberships spec AC:
        // "Changing a member's billing address re-resolves their
        // jurisdiction").
        case "customer.updated": {
          const parsed = CustomerUpdatedZ.safeParse(event.data.object);
          if (!parsed.success) {
            throw parseFailure(event, event.type, parsed.error);
          }
          const customer = parsed.data;

          // Only customers we track. This event fires for MANY reasons
          // (payment-method attach, email edit, ...) and for every customer
          // on the platform account — DLQ-ing foreign ones would evict
          // genuine failures from a 500-item queue (the same argument as
          // `isOrphanPaymentIntent`). A LOOKUP failure throws rather than
          // landing here, so a transient DB error still escalates.
          const customerMemberships =
            await app.deps.trpc.repos.memberships.listByStripeCustomerId(
              customer.id,
            );
          if (customerMemberships.length === 0) {
            // `logger`, not `app.log`: the server boots `Fastify({ logger:
            // false })`, so `app.log.*` is a no-op at runtime. These guard
            // breadcrumbs are the only trace a not-ours/unchanged event
            // leaves, so they must actually land in the log.
            logger.info("stripe_webhook_customer_not_ours", {
              eventId: event.id,
              customerId: customer.id,
            });
            break;
          }

          const address = customerBillingAddress(customer);
          if (!address) {
            // No usable billing address (cleared, partial, or malformed —
            // portal-typed data a replay could never fix). The rows keep
            // their last known-good jurisdiction; nothing to re-resolve.
            logger.info("stripe_webhook_customer_no_billing_address", {
              eventId: event.id,
              customerId: customer.id,
            });
            break;
          }

          // HOT PATH: `customer.updated` mostly fires for reasons that do not
          // move the address (card updates, email edits). An unchanged postal
          // code must cost nothing — no use case, no idempotency write, and
          // above all no ZipTax call.
          const addressUnchanged = customerMemberships.every(
            (membership) =>
              (membership.billingPostalCode ?? "").toUpperCase() ===
                address.postalCode &&
              (membership.billingCountryCode ?? "").toUpperCase() ===
                address.countryCode,
          );
          if (addressUnchanged) {
            logger.info("stripe_webhook_customer_address_unchanged", {
              eventId: event.id,
              customerId: customer.id,
              memberships: customerMemberships.length,
            });
            break;
          }

          const membershipBilling = app.deps.trpc.membershipBilling;
          const taxRateLookup = app.deps.trpc.taxRateLookup;
          if (!membershipBilling || !taxRateLookup) {
            // A TRACKED member changed address and we cannot re-resolve —
            // config problem, not a business outcome. DLQ so a replay after
            // the config fix still migrates the rate.
            throw new WebhookStageError({
              stage: "customer.updated:not_configured",
              message: "stripe_webhook_membership_billing_not_configured",
              title:
                "Stripe: member billing-address change could not be applied",
              description:
                "A tracked member's billing address changed but membership billing or the tax-rate lookup is not configured, so their tax jurisdiction was NOT re-resolved. The event is in the webhook DLQ — fix the config (STRIPE_SECRET_KEY / ZIPTAX_API_KEY) and replay.",
              fields: [
                { name: "Event", value: event.id, inline: true },
                { name: "Customer", value: customer.id, inline: true },
              ],
              tags: { stripeEventId: event.id, stripeCustomerId: customer.id },
              extra: {
                eventId: event.id,
                customerId: customer.id,
                hasMembershipBilling: Boolean(membershipBilling),
                hasTaxRateLookup: Boolean(taxRateLookup),
              },
            });
          }

          const result = await updateMemberBillingAddress(
            {
              repos: app.deps.trpc.repos,
              membershipBilling,
              taxRateLookup,
              idempotency: app.deps.trpc.idempotency,
              clock: app.deps.trpc.clock,
              logger: app.deps.logger,
              ...(app.deps.trpc.reportError
                ? { reportError: app.deps.trpc.reportError }
                : {}),
            },
            {
              stripeCustomerId: customer.id,
              billingCountryCode: address.countryCode,
              billingPostalCode: address.postalCode,
              stripeEventId: event.id,
            },
          );
          logger.info("stripe_webhook_membership_billing_address_updated", {
            eventId: event.id,
            customerId: customer.id,
            ...result,
          });
          break;
        }

        default:
          app.log.info(
            { type: event.type, eventId: event.id },
            "stripe_webhook_ignored_event",
          );
      }
      return { ok: true as const };
      // dlq-exempt: this IS the sink.
    } catch (unhandledErr) {
      // ── The ONE failure sink ────────────────────────────────────────────
      // Every non-applied event reaches here: unhandled throws, parse
      // failures, and the handler stages that used to swallow their own
      // errors. Sentry + Discord + DLQ happen for all of them, exactly once.
      //
      // `stripe_webhook_unhandled_error_dlq` and `stripe_webhook_dlq_store_failed`
      // are matched verbatim by infra/terraform's `stripe_webhook_failures`
      // log metric. Do not rename them without updating monitoring.tf.
      const staged =
        unhandledErr instanceof WebhookStageError ? unhandledErr : null;
      // Report the ROOT error, not the wrapper. `WebhookStageError.message` is
      // the stage's log key (e.g. "stripe_webhook_account_updated_failed"),
      // which tells an operator nothing about why it failed — the cause carries
      // "db_unavailable". Both go into the DLQ record.
      const rootError = staged?.cause ?? unhandledErr;
      const errorMsg = staged
        ? `${staged.context.message}: ${toErrorMessage(rootError)}`
        : toErrorMessage(unhandledErr);

      await reportStripeWebhookFailure({
        error: rootError,
        message: "stripe_webhook_unhandled_error_dlq",
        title:
          staged?.context.title ?? "Stripe webhook failed — event captured",
        description:
          staged?.context.description ??
          "A Stripe webhook handler threw an unhandled error. The event was stored in the webhook DLQ for replay.",
        fields: staged?.context.fields ?? [
          { name: "Event ID", value: event.id, inline: true },
          { name: "Type", value: event.type, inline: true },
        ],
        tags: {
          stripeEventId: event.id,
          stripeEventType: event.type,
          stage: staged?.context.stage,
          ...(staged?.context.tags ?? {}),
        },
        extra: {
          eventId: event.id,
          type: event.type,
          stage: staged?.context.stage,
          stageMessage: staged?.context.message,
          ...(staged?.context.extra ?? {}),
        },
      });

      // A replay must NOT re-push. `push` writes the SAME hash key, so it
      // would overwrite the original `error` and `receivedAt` with this
      // attempt's, re-`zadd` the item to "now" (reshuffling a queue that is
      // meant to be ordered by delivery time), and refresh the 30-day TTL so a
      // repeatedly-retried item never ages out. The operator loses exactly the
      // timestamp they correlate against the incident window. The row stays as
      // it was and the router surfaces this attempt's error instead.
      //
      // `logger.error`, not info: an operator-initiated replay that failed is
      // precisely what should reach Sentry (warn/info are not captured).
      if (options.replay) {
        logger.error("stripe_webhook_replay_failed", {
          eventId: event.id,
          type: event.type,
          stage: staged?.context.stage,
          error: errorMsg,
        });
        return { ok: false as const, error: errorMsg };
      }

      try {
        await webhookDlq.push({
          stripeEventId: event.id,
          eventType: event.type,
          payload: JSON.stringify(event),
          // Prefix with the stage so the admin DLQ page says *where* it broke,
          // not just that it broke. Replay needs that to be actionable.
          error:
            `${staged ? `[${staged.context.stage}] ` : ""}${errorMsg}`.slice(
              0,
              1000,
            ),
          receivedAt: new Date().toISOString(),
        });
        // dlq-exempt: the DLQ write itself failed. Nothing left to fall back
        // to — this is the one genuinely unrecoverable path, which is why the
        // production alert policy matches this log message too.
      } catch (dlqErr) {
        app.log.error(
          {
            eventId: event.id,
            error: dlqErr instanceof Error ? dlqErr.message : String(dlqErr),
          },
          "stripe_webhook_dlq_store_failed",
        );
      }
      return { ok: false as const, error: errorMsg };
    }
  };

  /**
   * Replay a DLQ'd event. Wired onto the shared tRPC deps object (read per
   * request by `createContextFactory`) so `platform.replayWebhookDlqItem` can
   * reach it without the transport layer depending on fastify.
   *
   * Idempotency note: every handler is replay-safe for money (order status
   * preconditions, unique ledger keys, the `stripe_evt:` idempotency cache),
   * but notification emails are only deduped for 120s, so a replay minutes
   * later CAN re-send a receipt. That is the right trade against a permanently
   * unapplied event, and the admin UI says so.
   */
  app.deps.trpc.replayStripeEvent = async (rawPayload: string) => {
    let event: Stripe.Event;
    try {
      event = JSON.parse(rawPayload) as Stripe.Event;
      // dlq-exempt: replay input, not a live delivery. A corrupt stored
      // payload is surfaced to the operator as a failed replay; the DLQ row
      // deliberately stays put.
    } catch (err) {
      return {
        ok: false,
        error: `unparseable_dlq_payload: ${toErrorMessage(err)}`,
      };
    }
    if (
      !event ||
      typeof event.id !== "string" ||
      typeof event.type !== "string"
    ) {
      return { ok: false, error: "dlq_payload_missing_event_fields" };
    }
    const stripe = new Stripe(env.STRIPE_SECRET_KEY ?? "", {
      apiVersion: (env.STRIPE_API_VERSION ??
        "2025-08-27.basil") as Stripe.LatestApiVersion,
    });
    logger.info("stripe_webhook_replay_started", {
      eventId: event.id,
      type: event.type,
    });
    return dispatchStripeEvent(event, stripe, { replay: true });
  };

  app.post("/webhooks/stripe", async (request, reply) => {
    // Two distinct Stripe webhook endpoints deliver here, each signed with its
    // own secret: the platform/account endpoint (STRIPE_WEBHOOK_SECRET) and the
    // Connect endpoint that carries connected-account events like
    // `account.updated` (STRIPE_CONNECT_WEBHOOK_SECRET). We accept either.
    const webhookSecrets = [
      env.STRIPE_WEBHOOK_SECRET,
      env.STRIPE_CONNECT_WEBHOOK_SECRET,
    ].filter((s): s is string => Boolean(s));

    if (webhookSecrets.length === 0) {
      // In dev/test environments we may not configure Stripe. Don't 500-loop.
      app.log.warn({ hasWebhookSecret: false }, "stripe_webhook_unconfigured");
      return reply.status(404).send({ ok: false });
    }

    const sig = request.headers["stripe-signature"];
    const sigHeader =
      typeof sig === "string" ? sig : Array.isArray(sig) ? sig[0] : undefined;

    // Our raw-body plugin uses Buffer for non-JSON. Stripe sends application/json.
    // For webhook verification, we need the raw payload. If the body isn't a Buffer,
    // reject with an actionable error.
    if (!Buffer.isBuffer(request.body)) {
      app.log.warn(
        { bodyType: typeof request.body },
        "stripe_webhook_missing_raw_body",
      );
      return reply.status(400).send({ ok: false, error: "missing_raw_body" });
    }

    const stripe = new Stripe(env.STRIPE_SECRET_KEY ?? "", {
      apiVersion: (env.STRIPE_API_VERSION ??
        "2025-08-27.basil") as Stripe.LatestApiVersion,
    });

    let event: Stripe.Event | undefined;
    let lastSignatureError: unknown;
    for (const secret of webhookSecrets) {
      try {
        event = stripe.webhooks.constructEvent(
          request.body,
          sigHeader ?? "",
          secret,
        );
        break;
        // dlq-exempt: signature probing. We try each configured secret in
        // turn; a miss here is expected. The final unverified case is handled
        // below with an error-level log and a 400 (Stripe retries).
      } catch (err) {
        lastSignatureError = err;
      }
    }
    if (!event) {
      const message =
        lastSignatureError instanceof Error
          ? lastSignatureError.message
          : JSON.stringify(lastSignatureError);
      // `logger.error`, NOT warn: warn is not captured by Sentry (CLAUDE.md),
      // and this is the exact signal a missing/stale STRIPE_CONNECT_WEBHOOK_SECRET
      // produces — every connected-account event 400s, `Payee.payoutsEnabled`
      // never flips true, and orgs silently cannot publish paid events. That
      // outage previously produced no Sentry issue and no alert at all.
      //
      // Deliberately NOT pushed to the DLQ: the payload is unauthenticated, so
      // anyone who can reach this endpoint could flood the 500-item DLQ and
      // evict genuinely-failed events. Visibility is the goal here, not replay
      // — an unverified payload must never be replayable.
      app.log.error(
        {
          message,
          hasConnectSecret: Boolean(env.STRIPE_CONNECT_WEBHOOK_SECRET),
          secretsTried: webhookSecrets.length,
        },
        "stripe_webhook_bad_signature",
      );
      return reply.status(400).send({ ok: false, error: "bad_signature" });
    }

    await dispatchStripeEvent(event, stripe);

    // Always return 200 — failed events are in the DLQ, not lost.
    // Returning 500 would cause Stripe to retry into the same broken state.
    return reply.send({ received: true });
  });
};

type StripeDisputePayload = Record<string, unknown>;

/**
 * Stripe's per-dispute fee, summed across the dispute's balance transactions.
 *
 * Summing rather than reading the first entry is deliberate. A dispute that is
 * later WON receives a second, reversing balance transaction whose `fee` is the
 * negative of the original, so the sum returns to 0 on its own — no
 * special-casing of the won path, and no stale $15 left sitting against a
 * dispute we didn't actually pay for.
 *
 * Returns `null` when Stripe reports no balance transactions at all, which is
 * the normal shape at `charge.dispute.created`. Null means "not reported",
 * distinct from a genuine 0, so the persistence step can tell them apart and
 * avoid overwriting a fee it already knows.
 */
function readDisputeFeeCents(dispute: StripeDisputePayload): number | null {
  const transactions = dispute.balance_transactions;
  if (!Array.isArray(transactions) || transactions.length === 0) return null;

  let total = 0;
  let sawFee = false;
  for (const entry of transactions) {
    const fee = readNumber(toRecord(entry)?.fee);
    if (fee === null) continue;
    total += fee;
    sawFee = true;
  }

  return sawFee ? total : null;
}

function buildDisputeLifecycleInput(
  event: Stripe.Event,
  overrides: Partial<
    Pick<StripeDisputeLifecycleInput, "fundsWithdrawnAt" | "closedAt">
  > = {},
): StripeDisputeLifecycleInput | null {
  const dispute = toRecord(event.data.object);
  if (!dispute) return null;

  const stripeDisputeId = readString(dispute.id);
  const amountCents = readNumber(dispute.amount);
  const currency = readString(dispute.currency);
  if (!stripeDisputeId || amountCents === null || !currency) return null;

  const charge = toRecord(dispute.charge);
  const paymentIntentValue = dispute.payment_intent ?? charge?.payment_intent;
  const disputeMetadata = readStringMap(dispute.metadata);
  const chargeMetadata = readStringMap(charge?.metadata);
  const paymentIntentMetadata = readStringMap(
    toRecord(paymentIntentValue)?.metadata,
  );
  const stripeStatus = readString(dispute.status);
  const isWarning = stripeStatus?.startsWith("warning_") ?? false;
  const isClosedEvent = event.type === "charge.dispute.closed";

  return {
    stripeEventId: event.id,
    stripeDisputeId,
    stripeChargeId: readExpandableId(dispute.charge),
    paymentIntentId: readExpandableId(paymentIntentValue),
    metadataOrderId:
      disputeMetadata.orderId ??
      paymentIntentMetadata.orderId ??
      chargeMetadata.orderId ??
      null,
    metadataEventId:
      disputeMetadata.eventId ??
      paymentIntentMetadata.eventId ??
      chargeMetadata.eventId ??
      null,
    amountCents,
    feeCents: readDisputeFeeCents(dispute),
    currency,
    reason: readString(dispute.reason) ?? "unknown",
    stripeStatus,
    isWarning,
    evidenceDueBy: readUnixSeconds(toRecord(dispute.evidence_details)?.due_by),
    fundsWithdrawnAt: overrides.fundsWithdrawnAt ?? null,
    closedAt: overrides.closedAt ?? null,
    outcome: isClosedEvent ? (stripeStatus ?? null) : null,
    metadata: {
      stripeEventType: event.type,
      disputeMetadata,
      chargeMetadata,
      paymentIntentMetadata,
    },
  };
}

function toRecord(value: unknown): StripeDisputePayload | null {
  return typeof value === "object" && value !== null
    ? (value as StripeDisputePayload)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readExpandableId(value: unknown): string | null {
  const direct = readString(value);
  if (direct) return direct;
  return readString(toRecord(value)?.id);
}

function readStringMap(value: unknown): Record<string, string> {
  const record = toRecord(value);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function readUnixSeconds(value: unknown): Date | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return new Date(value * 1000);
}

function stripeEventCreatedAt(event: Stripe.Event): Date {
  return new Date(event.created * 1000);
}

export default fp(plugin as unknown as never) as unknown as never;
