import { z } from "zod";

import { fail } from "@th/errors";

import type { RateLimitPort } from "@th/ports/rate-limit";

import { parseInput } from "../../lib/io";
import { reportBestEffort } from "../../lib/payments/resolve-scoped-fee-policy";
import {
  confirmRetrievedPaymentIntent,
  metadataOrderIdSchema,
  type ConfirmPaymentDeps,
} from "../orders/confirm-payment";
import { assertEmbedOriginAllowed } from "./_shared/assert-embed-origin-allowed";
import {
  chargeGuestProofBudget,
  guestClientSecretSchema,
  guestProofRefusal,
  guestReceiptSecretMatches,
  guestReceiptSecretSchema,
  paymentIntentIdFromClientSecret,
  retrieveWhenSecretMatches,
} from "./_shared/guest-client-secret";
import { assertEventAllowedForEmbed } from "./_shared/is-event-allowed-for-embed";
import {
  embedGuestTicketsSchema,
  readEmbedGuestTicketsOrEmpty,
} from "./_shared/read-embed-guest-tickets";

export {
  EMBED_GUEST_TICKET_MAX,
  EMBED_GUEST_TICKET_WINDOW_MS,
} from "./_shared/read-embed-guest-tickets";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const confirmEmbedGuestPaymentInputSchema = z
  .object({
    embedId: z.uuid(),
    /**
     * Origin of the page hosting the widget iframe, computed client-side.
     * Enforced against the embed's domain allowlist — null fails closed.
     */
    hostOrigin: z.string().url().nullable(),
    /**
     * The client secret `embeds.createGuestCheckout` returned for the order.
     * It is the ONLY proof of ownership a guest has: there is no session, and
     * an order id proves nothing (it is not an input here for that reason).
     * Stripe treats the same string as the bearer credential for the
     * PaymentIntent. Shape and bounds: `_shared/guest-client-secret.ts`.
     */
    clientSecret: guestClientSecretSchema,
    /**
     * The receipt secret `embeds.createGuestCheckout` returned with the
     * client secret: the second factor on the ticket codes, and on nothing
     * else. Optional. Without it, or with a wrong one, the answer is the
     * same, minus the codes (`tickets: []`). The widget keeps it only in the
     * tab that started the payment, so a client secret read off a redirect
     * URL, a log line or browser history confirms the order and gets no
     * admission. Rules: `_shared/guest-client-secret.ts`.
     */
    receiptSecret: guestReceiptSecretSchema.optional(),
  })
  .strict();

/**
 * The three answers the widget has to tell apart. Anything else (an order
 * cancelled under a paid PaymentIntent, a Stripe outage) is thrown, and the
 * widget treats a failed call as "outcome unknown".
 *
 * `confirmed` carries the order's ticket codes (below). Nothing else about
 * the buyer is returned: whoever holds the secret already has the
 * confirmation figures from `createGuestCheckout`, and `processing` and
 * `not_paid` add only the state.
 */
export const confirmEmbedGuestPaymentOutputSchema = z.discriminatedUnion(
  "outcome",
  [
    /**
     * The order was finalized by this payment: by this call, or earlier by
     * the webhook or another confirm. It says what the payment did, not what
     * the order is now: a repeat call is answered from finalize's idempotency
     * record, which outlives a later refund.
     *
     * `tickets` is the opposite: read from the rows as they are NOW, so the
     * confirmation can show each ticket's scannable code when the email is
     * slow or mistyped (owner, 2026-10-12). A code IS admission. Always
     * present; EMPTY unless the call presented the order's receipt secret
     * (no secret, a wrong one, or an order made before receipt secrets
     * existed, whose PaymentIntent stores no hash), when the order is no
     * longer an active holder's (refunded,
     * cancelled), when more than `EMBED_GUEST_TICKET_WINDOW_MS` has passed
     * since the tickets were issued, or when the read failed (reported). A
     * ticket that is no longer VALID, or that the buyer has transferred or
     * resold, is left out. Rules: `_shared/read-embed-guest-tickets.ts`.
     */
    z
      .object({
        outcome: z.literal("confirmed"),
        orderId: z.uuid(),
        tickets: embedGuestTicketsSchema,
      })
      .strict(),
    /**
     * The PaymentIntent is `processing` (a bank payment that has not settled).
     * The order is PROCESSING and the Stripe webhook finishes it.
     */
    z.object({ outcome: z.literal("processing"), orderId: z.uuid() }).strict(),
    /**
     * The PaymentIntent is in any other status, given as Stripe names it:
     * `requires_payment_method` and `canceled` can no longer be charged as
     * they stand; `requires_action` / `requires_confirmation` still can.
     */
    z
      .object({
        outcome: z.literal("not_paid"),
        orderId: z.uuid(),
        paymentIntentStatus: z.string().min(1).max(64),
      })
      .strict(),
  ],
);

export type ConfirmEmbedGuestPaymentInput = z.infer<
  typeof confirmEmbedGuestPaymentInputSchema
>;
export type ConfirmEmbedGuestPaymentOutput = z.infer<
  typeof confirmEmbedGuestPaymentOutputSchema
>;

/**
 * `confirmPayment`'s deps (the finalize runs through it), plus the web app's
 * own origin for the embed allowlist.
 *
 * `reportError` (from `ConfirmPaymentDeps`) is also this use case's own
 * reporter: a PAID order this path refuses is reported through it before the
 * error is rethrown, because most of those refusals are 4xx AppErrors that
 * the thrown-error backstops drop. A confirmed order whose tickets could not
 * be read is reported through it too; that one is swallowed (`tickets: []`).
 */
export type ConfirmEmbedGuestPaymentDeps = ConfirmPaymentDeps & {
  /** Base URL of our own web app; its origin is always allowed to host embeds. */
  publicAppUrl?: string | null;
  /**
   * Charged once per ask against a budget keyed on the PaymentIntent id
   * (`chargeGuestProofBudget`). Optional and fail-open: with none wired, or
   * one that throws, the ask goes through, because a paid buyer's confirm
   * must not fail on an abuse cap.
   */
  rateLimit?: Pick<RateLimitPort, "consume"> | null;
};

/** Key prefix of the per-PaymentIntent confirm budget; the id is appended. */
export const EMBED_GUEST_CONFIRM_PI_BUDGET_KEY_PREFIX = "embed:guestConfirm:pi:";
/**
 * Asks about ONE PaymentIntent per minute. The widget legitimately asks
 * several times: once after Stripe confirms, once more on a failed call, a
 * "Check again" every 5 seconds while a bank payment settles (12 a minute),
 * and again when it re-asks about an earlier order. 12 would be the widget's
 * own ceiling with no headroom, so the budget is 20, the same as the per-IP
 * limit; it still bounds the Stripe retrieves one id can buy.
 */
export const EMBED_GUEST_CONFIRM_PI_BUDGET_MAX = 20;

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The embed widget's `orders.confirmPayment`: after Stripe confirms in the
 * browser, the widget asks the server before it shows "Order confirmed"
 * (owner ruling 2026-10-11). Without it an embed order was finalized only by
 * the Stripe webhook, so the widget could show a confirmation for an order
 * the server still held PENDING.
 *
 * A guest has no session, so `orders.confirmPayment` (which checks the order's
 * buyer against the signed-in human) is closed to them. Here the client
 * secret stands in for the session:
 *
 * - The id inside the secret must already be linked to one of our orders
 *   (`orders.findByPaymentIntent`), checked BEFORE any Stripe call: the
 *   endpoint is anonymous and its per-IP limiter can be dodged, so a made-up
 *   id must not buy a live Stripe retrieve under the platform key. Every
 *   secret `createCheckout` issues has a linked order, because the secret is
 *   returned only after its link compare-and-swap wins.
 * - The PaymentIntent is then retrieved server-side, and the presented secret
 *   is compared with the PaymentIntent's real one in constant time.
 * - An unlinked id, a wrong secret, an id Stripe does not know and a
 *   PaymentIntent whose `metadata.orderId` is missing or names another order
 *   than the linked one all give the SAME refusal: same status, same body.
 *   Response time is not equalised (an unlinked id is refused without the
 *   Stripe round trip).
 * - A linked id is charged against a per-PaymentIntent budget before the
 *   Stripe retrieve (`chargeGuestProofBudget`); over it the answer is
 *   RATE_LIMITED, which the widget reads as "ask again later".
 * - The order is the one the PaymentIntent's server-written
 *   `metadata.orderId` names, and its event must be one this embed may sell.
 *   That is the whole check: the secret is confirmable through ANY embed that
 *   may sell the order's event, not only the embed it was issued through.
 *   `releaseEmbedGuestOrder` binds to the embed the order was made through
 *   (`metadata.embedId`); confirm deliberately does not, so an order made
 *   before that key existed, and any paid order, stays confirmable.
 * - The finalize itself is `confirmPayment`'s, acting as the order's buyer.
 *   There is no second finalize path.
 * - A paid order (PaymentIntent `succeeded` or `processing`) that the
 *   finalize refuses is reported through `reportError` and the error is
 *   rethrown: the buyer has been charged and has no ticket.
 *
 * `linkOut` and the buy-tickets switch are deliberately NOT checked: a payment
 * already made must stay confirmable after buying is switched off.
 *
 * - A `confirmed` answer then carries the order's ticket codes, read at
 *   current state after the finalize returned (never inside it: the
 *   signed-in `orders.confirmPayment` answer has none), and only when the
 *   PaymentIntent was made through THIS embed (`metadata.embedId`) AND the
 *   call presents the order's receipt secret (`metadata.receiptSecretHash`;
 *   see `ticketsForConfirmedOrder`). The client secret is not enough for
 *   codes: a redirect payment method (Cash App Pay, Amazon Pay) returns the
 *   buyer on a URL carrying it, which reaches request logs and browser
 *   history (owner ruling 2026-10-12: codes only in the tab that started the
 *   payment). There is no other way to them here: every refusal above
 *   throws before the read, so an order id or a PaymentIntent id alone
 *   yields nothing. A failed read never fails the confirm; it answers
 *   `tickets: []` and is reported.
 *
 * The client secret and the receipt secret never leave this file: they are
 * not logged, not put in an error's `meta` or a report's `extra`, not handed
 * to `confirmPayment`, and not returned. Ticket codes go to the caller only:
 * never into a log line, an error's `meta` or a report's `extra`.
 */
export async function confirmEmbedGuestPayment(
  deps: ConfirmEmbedGuestPaymentDeps,
  rawInput: unknown,
): Promise<ConfirmEmbedGuestPaymentOutput> {
  const logger = deps.logger?.child({ useCase: "confirmEmbedGuestPayment" });
  const input = parseInput(confirmEmbedGuestPaymentInputSchema, rawInput);

  // ── Validate embed + host origin ───────────────────────────────────
  // First, before the Stripe call, as in `createEmbedGuestCheckout`: a site
  // that is not allowed to host this embed costs us one read and nothing else.
  const embed = await deps.repos.embeds.getById(input.embedId);
  if (!embed || embed.status !== "ACTIVE") {
    throw fail("EMBED_NOT_FOUND");
  }

  assertEmbedOriginAllowed({
    embed,
    hostOrigin: input.hostOrigin,
    publicAppUrl: deps.publicAppUrl,
    logger,
  });

  // ── The id must already be one of our orders' PaymentIntents ───────
  // Before any Stripe call. The only thing this read can tell a caller is
  // what the refusal below tells them anyway, and it writes nothing.
  const paymentIntentId = paymentIntentIdFromClientSecret(input.clientSecret);
  // ONE refusal for every way of not proving ownership: no `meta`, no
  // message beyond the code, so the response body is the same for all.
  const refusal = guestProofRefusal({
    logger,
    useCase: "confirmEmbedGuestPayment",
    embedId: input.embedId,
    paymentIntentId,
  });

  const linkedOrder = await deps.repos.orders.findByPaymentIntent(
    paymentIntentId,
  );
  if (!linkedOrder) {
    throw refusal("payment_intent_not_linked");
  }

  // ── One budget per PaymentIntent, before the Stripe call ───────────
  // After the link lookup (a made-up id spends nothing) and before the
  // retrieve (an ask over budget costs no Stripe call). Fails open.
  await chargeGuestProofBudget(deps, {
    logger,
    useCase: "confirmEmbedGuestPayment",
    keyPrefix: EMBED_GUEST_CONFIRM_PI_BUDGET_KEY_PREFIX,
    maxRequests: EMBED_GUEST_CONFIRM_PI_BUDGET_MAX,
    embedId: input.embedId,
    paymentIntentId,
  });

  // ── Prove the caller holds this PaymentIntent's secret ─────────────
  const paymentIntent = await retrieveWhenSecretMatches(
    deps,
    paymentIntentId,
    input.clientSecret,
  );
  if (!paymentIntent) {
    throw refusal("secret_mismatch_or_unknown_payment_intent");
  }

  // A PaymentIntent without a parseable order id is not one of our checkout
  // PaymentIntents, and one that names a different order than the one it is
  // linked to is not this order's payment. Refused exactly like a wrong
  // secret, although the secret matched. (The webhook's finalize can still
  // move a PaymentIntent to the order its metadata names; a guest cannot.)
  const metadataOrderId = metadataOrderIdSchema.safeParse(
    paymentIntent.metadata?.orderId,
  );
  const metadataRefusalReason = !metadataOrderId.success
    ? "metadata_order_id_missing"
    : metadataOrderId.data !== linkedOrder.id
      ? "metadata_order_id_not_linked_order"
      : null;
  if (!metadataOrderId.success || metadataRefusalReason !== null) {
    const err = refusal(metadataRefusalReason ?? "metadata_order_id_missing");
    // The secret matched, so when the PaymentIntent is paid this is a buyer
    // who was charged and is being turned away: report it. The caller still
    // sees the same bare refusal as for a wrong secret.
    reportPaidOrderRefused(deps, logger, err, {
      embedId: input.embedId,
      orderId: linkedOrder.id,
      paymentIntentId,
      paymentIntentStatus: paymentIntent.status,
    });
    throw err;
  }
  const orderId = metadataOrderId.data;

  // ── The order must be one this embed may sell ──────────────────────
  // From here on the caller has proven the secret, so these refusals may be
  // told apart. One event read: without it, a secret issued by the main
  // checkout, or through an embed of another organizer, could be confirmed
  // through any embed whose domain the caller can name.
  const order = await deps.repos.orders.getById(orderId);
  if (!order) {
    throw fail("ORDER_NOT_FOUND");
  }
  // An embed sells event tickets only; a membership order has no event.
  const event = order.eventId
    ? await deps.repos.events.getById(order.eventId)
    : null;
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }
  // The event's own status is not checked here, unlike checkout: an
  // organization embed, and an event embed's pinned event, stay confirmable
  // after the event is unpublished or cancelled, and finalize decides what a
  // paid order on it becomes. The exception is an event embed selling a
  // SERIES SIBLING date: `assertEventAllowedForEmbed` allows a sibling only
  // while it is a published date of the series, so a buyer whose sibling
  // date was unpublished after they paid gets EVENT_NOT_FOUND here, and the
  // Stripe webhook still finalizes their order. Fails closed on any subject
  // type but organization and event.
  await assertEventAllowedForEmbed(deps, embed, event);

  // ── Confirm through the one finalize path ──────────────────────────
  // The guest is the order's buyer: the secret was issued to whoever made the
  // order, and that is the only actor `confirmPayment` accepts.
  let result: Awaited<ReturnType<typeof confirmRetrievedPaymentIntent>>;
  try {
    result = await confirmRetrievedPaymentIntent(deps, {
      actorHumanId: order.buyerHumanId,
      paymentIntentId,
      paymentIntent,
    });
  } catch (err) {
    reportPaidOrderRefused(deps, logger, err, {
      embedId: input.embedId,
      orderId,
      paymentIntentId,
      paymentIntentStatus: paymentIntent.status,
    });
    throw err;
  }

  // ── The payer's ticket codes, on `confirmed` only ──────────────────
  // After every check above and after the finalize, from the rows as they
  // stand now. Never throws: the buyer has paid, and `confirmed` matters
  // more than the codes. The receipt secret is decided here, as a boolean,
  // so the secret itself goes no further.
  const receiptSecretMatched = guestReceiptSecretMatches(
    input.receiptSecret,
    paymentIntent.metadata?.receiptSecretHash,
  );
  const tickets =
    result.outcome === "confirmed"
      ? await ticketsForConfirmedOrder(deps, logger, {
          embedId: embed.id,
          provenOrderId: orderId,
          confirmedOrderId: result.orderId,
          paymentIntentId,
          metadataEmbedId: paymentIntent.metadata?.embedId,
          receiptSecretMatched,
        })
      : null;

  // A count, never the codes; whether the receipt secret matched, never it.
  logger?.info("confirmEmbedGuestPayment.answered", {
    embedId: input.embedId,
    orderId: result.orderId,
    paymentIntentId,
    outcome: result.outcome,
    ...(tickets ? { ticketCount: tickets.length, receiptSecretMatched } : {}),
  });

  if (result.outcome === "confirmed") {
    return {
      outcome: "confirmed",
      orderId: result.orderId,
      tickets: tickets ?? [],
    };
  }
  return result;
}

/**
 * The codes a `confirmed` answer carries, or `[]`. Never throws.
 *
 * Bound to the embed, unlike the confirm itself: codes come back only when
 * the PaymentIntent's server-written `metadata.embedId` is exactly THIS
 * embed's id, and only when the call presented the receipt secret whose hash
 * the PaymentIntent's metadata stores (`receiptSecretMatched`). A secret on a
 * redirect-return URL, in a log line or in another tab's history is the
 * client secret only. The confirm stays open to any embed that may sell the event
 * (a paid order must stay confirmable everywhere), but a genuine secret
 * reaches more places than the widget: a signed-in main-site checkout's
 * secret rides its redirect-return URL into browser history and request
 * logs, and an order made before `embedId` was written has none. Such a
 * secret confirms its order here and is handed no admission. No ticket is
 * read for it at all.
 *
 * The tickets are read by the PROVEN order id (the one the PaymentIntent's
 * metadata names and the link lookup agreed with), never by the finalize's
 * answer alone. The two cannot differ today; if they ever do, the answer
 * carries no codes and the mismatch is reported.
 */
async function ticketsForConfirmedOrder(
  deps: ConfirmEmbedGuestPaymentDeps,
  logger: ConfirmEmbedGuestPaymentDeps["logger"],
  params: {
    embedId: string;
    provenOrderId: string;
    confirmedOrderId: string;
    paymentIntentId: string;
    metadataEmbedId: unknown;
    /** The presented receipt secret matched `metadata.receiptSecretHash`. */
    receiptSecretMatched: boolean;
  },
) {
  if (params.confirmedOrderId !== params.provenOrderId) {
    const context = {
      embedId: params.embedId,
      provenOrderId: params.provenOrderId,
      confirmedOrderId: params.confirmedOrderId,
      paymentIntentId: params.paymentIntentId,
    };
    try {
      logger?.error("confirmEmbedGuestPayment.confirmedOrderMismatch", context);
    } catch {
      // Intentionally empty: a throwing logger must not fail the confirm.
    }
    reportBestEffort(
      deps.reportError,
      new Error("embed_guest_confirm_confirmed_order_mismatch"),
      {
        tags: {
          useCase: "confirmEmbedGuestPayment",
          stage: "confirmedOrderMismatch",
        },
        extra: context,
      },
    );
    return [];
  }
  if (
    typeof params.metadataEmbedId !== "string" ||
    params.metadataEmbedId !== params.embedId
  ) {
    return [];
  }
  // No receipt secret, a wrong one, or an order made before receipt secrets
  // existed (no stored hash): confirmed, no codes, and no ticket read.
  if (!params.receiptSecretMatched) {
    return [];
  }
  return readEmbedGuestTicketsOrEmpty(deps, {
    orderId: params.provenOrderId,
    useCase: "confirmEmbedGuestPayment",
    logger,
  });
}

/**
 * Reports a confirm that failed although the buyer's money has moved (the
 * PaymentIntent is `succeeded` or `processing`). The caller rethrows the
 * original error whatever happens here; nothing is swallowed.
 *
 * Why this cannot ride the backstops: ORDER_NOT_PROCESSABLE and
 * PAYMENT_INTENT_MISMATCH map to CONFLICT and AMOUNT_MISMATCH to BAD_REQUEST;
 * the tRPC `onError` hook reports only a 500, and Sentry's `beforeSend` drops
 * an AppError whose code maps to anything else. So the report is a FRESH
 * Error (the AppError rides as its `cause`), which that filter keeps.
 *
 * IDEMPOTENCY_LOCK_IN_PROGRESS is not reported: it is a second confirm (or
 * the webhook) finalizing the same payment right now, not a refusal.
 */
function reportPaidOrderRefused(
  deps: Pick<ConfirmEmbedGuestPaymentDeps, "reportError">,
  logger: ConfirmEmbedGuestPaymentDeps["logger"],
  err: unknown,
  context: {
    embedId: string;
    orderId: string;
    paymentIntentId: string;
    paymentIntentStatus: string;
  },
): void {
  if (
    context.paymentIntentStatus !== "succeeded" &&
    context.paymentIntentStatus !== "processing"
  ) {
    return;
  }
  const rawCode = (err as { code?: unknown } | null | undefined)?.code;
  const code = typeof rawCode === "string" && rawCode ? rawCode : "unknown";
  if (code === "IDEMPOTENCY_LOCK_IN_PROGRESS") return;

  // Guarded like the reporter: a logger that throws must not replace the
  // error the caller is about to rethrow.
  try {
    logger?.error("confirmEmbedGuestPayment.paid_order_refused", {
      ...context,
      code,
    });
  } catch {
    // Intentionally empty.
  }
  reportBestEffort(
    deps.reportError,
    new Error(`embed_guest_confirm_paid_order_refused:${code}`, { cause: err }),
    {
      tags: { useCase: "confirmEmbedGuestPayment", reason: code },
      extra: context,
    },
  );
}
