import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import { parseInput } from "../../lib/io";
import { finalizePaymentIntent } from "./finalize-from-payment-intent";
import type { NotifyFn } from "./notify-buyer";
import { fail } from "@th/errors";

// ── Schemas ─────────────────────────────────────────────────────────────────

// The lookahead refuses a CLIENT SECRET (`pi_xxx_secret_yyy`), which also
// fits `pi_[A-Za-z0-9_]+`: it would go to Stripe and into this use case's
// log lines. Ids may contain underscores; only `_secret_` is excluded.
export const PAYMENT_INTENT_ID_PATTERN = /^pi_(?!.*_secret_)[A-Za-z0-9_]+$/;

export const confirmPaymentInputSchema = z.object({
  actorHumanId: z.string().min(1),
  /**
   * OPTIONAL hint, not the authority. The order a PaymentIntent pays for is
   * the one its server-written `metadata.orderId` names: a buyer returning
   * from a redirect payment method (Amazon Pay, Cash App) lands on a freshly
   * mounted page with no order id, or a stale `resumeOrderId` for a cart
   * `createCheckout` already retired. When given, it must not belong to
   * someone else; when it disagrees with the metadata, the metadata wins.
   */
  orderId: z.uuid().optional(),
  /**
   * A Stripe PaymentIntent id: `pi_` plus alphanumerics and underscores,
   * nothing else (Stripe treats ids as opaque, so the set stays loose). The id
   * is a lookup key at the processor, so a malformed one is refused here —
   * BAD_REQUEST, no Stripe call — instead of costing a round trip and
   * surfacing as a processor error. (The router derives its input from this
   * schema, so the transport enforces the same pattern.)
   */
  paymentIntentId: z
    .string()
    .max(255)
    .regex(PAYMENT_INTENT_ID_PATTERN, "Invalid PaymentIntent id"),
});

export const confirmPaymentOutputSchema = z.object({
  ok: z.literal(true),
  /** The order that was confirmed — the PaymentIntent's, not the hint. */
  orderId: z.uuid(),
  /**
   * What the payment is now. `confirmed`: paid, tickets issued. `processing`:
   * Stripe accepted a delayed method (US bank debit) whose money has not
   * moved; the order is PROCESSING, no tickets yet, and the debit can still
   * fail days later (the webhook then cancels it). A client must not show a
   * `processing` order as paid (owner, 2026-10-14).
   */
  outcome: z.enum(["confirmed", "processing"]),
});

/** Stripe metadata is free-form strings; only a real order id counts. */
export const metadataOrderIdSchema = z.uuid();

export type ConfirmPaymentInput = z.infer<typeof confirmPaymentInputSchema>;
export type ConfirmPaymentOutput = z.infer<typeof confirmPaymentOutputSchema>;

export type ConfirmPaymentDeps = {
  repos: Repos;
  payments: PaymentProcessorPort;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Multi-channel notification dispatcher. Forwarded to finalizePaymentIntent
   * so the buyer receives a fire-and-forget in-app confirmation on the
   * client-confirm finalize path too. Optional and fail-safe.
   */
  notify?: NotifyFn;
  /** When true, ledger credits mature immediately (dev/test only). */
  devInstantPayouts?: boolean;
  /**
   * Forwarded to finalizePaymentIntent so its swallowed ledger-credit failure
   * reaches Sentry on the client-confirm path too. Best-effort.
   */
  reportError?: ReporterPort;
};

// ── Use case ────────────────────────────────────────────────────────────────

/**
 * Client-side confirmation path: after the browser calls
 * `stripe.confirmCardPayment()` and the PaymentIntent transitions to
 * `succeeded`, the client calls this endpoint so the server can verify the
 * payment state and finalize the order immediately (instead of waiting for the
 * async Stripe webhook).
 *
 * Safety:
 * - The server fetches the PaymentIntent from Stripe directly to verify status.
 *   We never trust the client's claim that the payment succeeded.
 * - The order is the one the PI's server-written `metadata.orderId` names,
 *   and it must belong to the caller. The client's `orderId` is a hint that
 *   can only narrow access (a foreign hint is refused), never widen it.
 * - Delegates to the existing `finalizePaymentIntent` use case, so all
 *   idempotency, auditing, and ticket-minting logic is reused.
 * - The Stripe webhook remains active as a belt-and-suspenders fallback.
 */
export async function confirmPayment(
  deps: ConfirmPaymentDeps,
  rawInput: unknown,
): Promise<ConfirmPaymentOutput> {
  const input = parseInput(confirmPaymentInputSchema, rawInput);

  // ── 1. Server-side PI retrieval ─────────────────────────────────────
  // The PaymentIntent comes first because it, not the client, names the
  // order: `createCheckout` / `createResaleCheckout` write `metadata.orderId`
  // when they mint it, and a client cannot edit PI metadata.
  const pi = await deps.payments.retrievePaymentIntent({
    paymentIntentId: input.paymentIntentId,
  });

  const result = await confirmRetrievedPaymentIntent(deps, {
    actorHumanId: input.actorHumanId,
    orderId: input.orderId,
    paymentIntentId: input.paymentIntentId,
    paymentIntent: pi,
  });

  if (result.outcome === "not_paid") {
    // The status rides to the client: only `requires_payment_method` /
    // `canceled` are a payment that can no longer complete. A redirect return
    // reopens buying on those alone; `requires_action` (a Cash App approval
    // still pending) can still be charged, so the page stays closed.
    throw fail("PAYMENT_NOT_SUCCEEDED", {
      meta: { status: result.paymentIntentStatus },
    });
  }

  return { ok: true, orderId: result.orderId, outcome: result.outcome };
}

/** What `PaymentProcessorPort.retrievePaymentIntent` answers. */
export type RetrievedPaymentIntent = Awaited<
  ReturnType<PaymentProcessorPort["retrievePaymentIntent"]>
>;

/**
 * The three answers a confirm can give without throwing. `confirmPayment`
 * turns `not_paid` into PAYMENT_NOT_SUCCEEDED; `confirmEmbedGuestPayment`
 * hands all three to the embed widget, which has to tell them apart.
 */
export type ConfirmRetrievedPaymentIntentResult =
  | { outcome: "confirmed"; orderId: string }
  | { outcome: "processing"; orderId: string }
  | { outcome: "not_paid"; orderId: string; paymentIntentStatus: string };

/**
 * Everything `confirmPayment` does after it has the PaymentIntent, for a
 * caller that already retrieved it: `confirmEmbedGuestPayment` has to read the
 * PaymentIntent first to check the guest's client secret, and a second Stripe
 * retrieve of the same id would buy nothing. There is still one finalize
 * path; this is it.
 *
 * `paymentIntent` MUST come from the processor, never from a client: its
 * status and `metadata.orderId` are trusted here. `actorHumanId` must be the
 * order's buyer, exactly as for `confirmPayment`.
 */
export async function confirmRetrievedPaymentIntent(
  deps: ConfirmPaymentDeps,
  input: {
    actorHumanId: string;
    /** The same optional hint `confirmPayment` takes. */
    orderId?: string;
    /** The id the PaymentIntent was retrieved by. */
    paymentIntentId: string;
    paymentIntent: RetrievedPaymentIntent;
  },
): Promise<ConfirmRetrievedPaymentIntentResult> {
  const scopedLogger = deps.logger?.child({ useCase: "confirmPayment" });
  const pi = input.paymentIntent;

  // A PI without a parseable order id is not one of our checkout PIs, so it
  // cannot confirm any order. Same refusal as a PI that names another order.
  const metadataOrderId = metadataOrderIdSchema.safeParse(pi.metadata?.orderId);
  if (!metadataOrderId.success) {
    scopedLogger?.warn("confirmPayment.pi_missing_order_metadata", {
      hintOrderId: input.orderId ?? null,
      paymentIntentId: input.paymentIntentId,
    });
    throw fail("PAYMENT_INTENT_ORDER_MISMATCH");
  }
  const orderId = metadataOrderId.data;

  // ── 2. Verify the orders belong to the caller ───────────────────────
  // The hint, when given, must not be someone else's — the same refusal
  // this endpoint always gave for a foreign order id. A hint that no longer
  // exists is just stale and is ignored.
  if (input.orderId && input.orderId !== orderId) {
    const hinted = await deps.repos.orders.getById(input.orderId);
    if (hinted && hinted.buyerHumanId !== input.actorHumanId) {
      throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "order" } });
    }
    scopedLogger?.info("confirmPayment.order_resolved_from_metadata", {
      hintOrderId: input.orderId,
      orderId,
      paymentIntentId: input.paymentIntentId,
    });
  }

  // The order the PI pays for is the one authorized — never confirm another
  // buyer's order, whatever PI id the caller holds.
  const order = await deps.repos.orders.getById(orderId);
  if (!order) {
    throw fail("ORDER_NOT_FOUND");
  }
  if (order.buyerHumanId !== input.actorHumanId) {
    throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "order" } });
  }

  // Same cross-check `finalizePaymentIntent` makes: an order already tied to
  // a PaymentIntent is confirmed only by THAT one. It runs before the status
  // branches so the "processing" path below cannot flip an order to PROCESSING
  // on the strength of a different PI whose metadata merely names it.
  if (
    order.stripePaymentIntentId &&
    order.stripePaymentIntentId !== pi.id
  ) {
    throw fail("PAYMENT_INTENT_MISMATCH");
  }

  // ── 3. Verify the payment state ─────────────────────────────────────
  if (pi.status !== "succeeded" && pi.status !== "processing") {
    scopedLogger?.warn("confirmPayment.pi_not_succeeded", {
      orderId,
      paymentIntentId: input.paymentIntentId,
      actualStatus: pi.status,
    });
    return { outcome: "not_paid", orderId, paymentIntentStatus: pi.status };
  }

  // ── Delayed notification methods (ACH, bank transfer) ───────────────
  // When the PI is still in "processing", the funds haven't settled yet.
  // We mark the order as PROCESSING so the buyer sees a confirmation
  // (the webhook will finalize when Stripe settles the payment).
  if (pi.status === "processing") {
    if (order.status === "PENDING") {
      // CAS (PENDING → PROCESSING): `order` was read above without a lock,
      // and a retire / release / reaper may have cancelled it since. A lost
      // CAS is an idempotent no-op when another path for THIS payment (the
      // webhook, a second confirm) already advanced the order to PROCESSING
      // or SUCCEEDED. Anything else — CANCELLED, or now tied to a different
      // PI — is a paid-but-not-payable order, refused like finalize refuses
      // one (ORDER_NOT_PROCESSABLE) rather than flipped back to PROCESSING.
      // A null PI counts as this payment: this path never links, and the
      // mismatch check above already passed on the same null.
      // Unreachable today for createCheckout orders (the client secret is
      // only issued after checkout's link CAS wins); belt-and-braces.
      const advanced = await deps.repos.orders.markProcessingIfPending(orderId);
      if (!advanced) {
        const fresh = await deps.repos.orders.getById(orderId);
        const advancedForThisPayment =
          (fresh?.status === "PROCESSING" || fresh?.status === "SUCCEEDED") &&
          (!fresh.stripePaymentIntentId ||
            fresh.stripePaymentIntentId === pi.id);
        if (!advancedForThisPayment) {
          scopedLogger?.error("confirmPayment.processing_order_not_pending", {
            orderId,
            paymentIntentId: input.paymentIntentId,
            status: fresh?.status ?? null,
            linkedPaymentIntentId: fresh?.stripePaymentIntentId ?? null,
          });
          throw fail("ORDER_NOT_PROCESSABLE");
        }
      }
    } else if (order.status !== "PROCESSING" && order.status !== "SUCCEEDED") {
      // Not PENDING on the first read either: CANCELLED, refunded, disputed.
      // The same refusal the lost CAS above gives, instead of answering
      // "processing" for an order this payment can no longer complete. The
      // mismatch check above already tied the order to this PaymentIntent.
      scopedLogger?.error("confirmPayment.processing_order_not_pending", {
        orderId,
        paymentIntentId: input.paymentIntentId,
        status: order.status,
        linkedPaymentIntentId: order.stripePaymentIntentId ?? null,
      });
      throw fail("ORDER_NOT_PROCESSABLE");
    }
    scopedLogger?.info("confirmPayment.processing", {
      orderId,
      paymentIntentId: input.paymentIntentId,
    });
    return { outcome: "processing", orderId };
  }

  // ── 4. Delegate to finalizePaymentIntent ────────────────────────────
  // Construct a synthetic stripe-event-shaped input so the existing use
  // case can run its full idempotent flow. We use a deterministic
  // synthetic event ID derived from the PI ID so repeated calls with the
  // same PI produce the same idempotency key.
  const syntheticEventId = `client_confirm_${input.paymentIntentId}`;

  scopedLogger?.info("confirmPayment.delegating", {
    orderId,
    paymentIntentId: input.paymentIntentId,
    syntheticEventId,
  });

  const result = await finalizePaymentIntent(
    {
      repos: deps.repos,
      idempotency: deps.idempotency,
      clock: deps.clock,
      logger: scopedLogger,
      notify: deps.notify,
      devInstantPayouts: deps.devInstantPayouts,
      reportError: deps.reportError,
      // Lets finalize settle a stale sibling cart's PaymentIntent instead of
      // leaving it confirmable under a CANCELLED order.
      payments: deps.payments,
    },
    {
      stripeEvent: {
        id: syntheticEventId,
        type: "payment_intent.succeeded" as const,
        data: {
          object: {
            id: pi.id,
            status: "succeeded" as const,
            amount_received: pi.amountReceived,
            currency: pi.currency,
            metadata: pi.metadata,
          },
        },
      },
    },
  );

  return { outcome: "confirmed", orderId: result.orderId };
}
