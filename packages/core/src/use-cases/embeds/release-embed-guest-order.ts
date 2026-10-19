import { z } from "zod";

import { fail } from "@th/errors";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { RateLimitPort } from "@th/ports/rate-limit";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import { metadataOrderIdSchema } from "../orders/confirm-payment";
import { releaseCartHold } from "../orders/release-cart-hold";
import { assertEmbedOriginAllowed } from "./_shared/assert-embed-origin-allowed";
import {
  chargeGuestProofBudget,
  guestClientSecretSchema,
  guestProofRefusal,
  paymentIntentIdFromClientSecret,
  retrieveWhenSecretMatches,
} from "./_shared/guest-client-secret";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

export const releaseEmbedGuestOrderInputSchema = z
  .object({
    embedId: z.uuid(),
    /**
     * Origin of the page hosting the widget iframe, computed client-side.
     * Enforced against the embed's domain allowlist — null fails closed.
     */
    hostOrigin: z.string().url().nullable(),
    /**
     * The client secret `embeds.createGuestCheckout` returned for the order:
     * the guest's only proof of ownership, exactly as for
     * `confirmEmbedGuestPayment`. An order id is not an input, because it
     * proves nothing. Shape and bounds: `_shared/guest-client-secret.ts`.
     */
    clientSecret: guestClientSecretSchema,
  })
  .strict();

/**
 * What became of the order. Never thrown: the widget reads `kept` as "wait
 * for the hold to run out", which is what it showed before this existed.
 *
 * No buyer data: whoever holds the secret already has the order id from
 * `createGuestCheckout`, and this answer adds only the state.
 */
export const releaseEmbedGuestOrderOutputSchema = z
  .object({
    outcome: z.enum([
      /** This call cancelled the order and freed what it held. */
      "released",
      /**
       * The order was already CANCELLED (reaped on expiry, released earlier,
       * retired by a later checkout). It holds nothing.
       */
      "gone",
      /**
       * The order still stands: it is paid or being paid, Stripe would not
       * prove the PaymentIntent dead, or a compare-and-swap lost a race.
       */
      "kept",
    ]),
    orderId: z.uuid(),
  })
  .strict();

export type ReleaseEmbedGuestOrderInput = z.infer<
  typeof releaseEmbedGuestOrderInputSchema
>;
export type ReleaseEmbedGuestOrderOutput = z.infer<
  typeof releaseEmbedGuestOrderOutputSchema
>;

export type ReleaseEmbedGuestOrderDeps = {
  /**
   * Narrow on purpose, like `releaseCartHold`'s: this use case reads the
   * embed and the order and writes nothing itself. Every write is
   * `releaseCartHold`'s, inside its one transaction.
   */
  repos: {
    tx: Repos["tx"];
    orders: Pick<Repos["orders"], "getById" | "findByPaymentIntent">;
    embeds: Pick<Repos["embeds"], "getById">;
  };
  /**
   * `retrievePaymentIntentWithClientSecret` proves the secret;
   * `cancelPaymentIntent` and `retrievePaymentIntent` are `releaseCartHold`'s.
   */
  payments: PaymentProcessorPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Handed to `releaseCartHold`, which reports every refusal to release (a
   * PaymentIntent Stripe would not prove dead, a Stripe failure). This use
   * case swallows nothing of its own, so it makes no report of its own.
   */
  reportError?: ReporterPort | null;
  /** Base URL of our own web app; its origin is always allowed to host embeds. */
  publicAppUrl?: string | null;
  /**
   * Charged once per ask against a budget keyed on the PaymentIntent id
   * (`chargeGuestProofBudget`). Optional and fail-open: with none wired, or
   * one that throws, the ask goes through.
   */
  rateLimit?: Pick<RateLimitPort, "consume"> | null;
};

/** Key prefix of the per-PaymentIntent release budget; the id is appended. */
export const EMBED_GUEST_RELEASE_PI_BUDGET_KEY_PREFIX = "embed:guestRelease:pi:";
/**
 * Asks about ONE PaymentIntent per minute. One order needs one release, plus
 * a retry or two (a failed call, a tab closing while another asks).
 */
export const EMBED_GUEST_RELEASE_PI_BUDGET_MAX = 6;

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The embed widget's `releaseCartHold`: a guest gives back an order they
 * abandoned (owner ruling 2026-10-11, "A guest can release it"). Without it
 * an abandoned embed order kept its tickets until the server's own clean-up
 * reached it: picked seats stayed HELD until the cart reaper cancelled the
 * order (eligible 20 minutes after it was made, cancelled on the reaper's
 * next pass, every 30 minutes, so usually within 50), and unseated tickets
 * counted against capacity for 80 minutes from creation. Those are the
 * figures the widget's notice gives (`LEFT_ORDER_USUALLY_RESERVED_MINUTES`,
 * `LEFT_ORDER_RESERVED_MINUTES` in the embed's `embed-payment-order.ts`).
 *
 * A guest has no session, so `releaseCartHold`'s own caller (which checks the
 * order's buyer against the signed-in human) is closed to them. The client
 * secret stands in for the session, by the same proof as
 * `confirmEmbedGuestPayment` (`_shared/guest-client-secret.ts`). Each check
 * refuses before the next one costs more, because the endpoint is anonymous
 * and its per-IP limiter keys on a header a caller can forge:
 *
 * - The embed is ACTIVE and the request's origin may host it: one read.
 * - The id inside the secret is already linked to one of our orders, checked
 *   BEFORE any Stripe call, so a made-up id does not buy a Stripe retrieve.
 * - A linked id is charged against a per-PaymentIntent budget
 *   (`chargeGuestProofBudget`), so one real id cannot buy unlimited
 *   retrieves either. Over it the answer is RATE_LIMITED.
 * - The PaymentIntent is retrieved and the presented secret compared with its
 *   real one in constant time.
 * - The PaymentIntent's server-written `metadata.orderId` is the linked order.
 * - The PaymentIntent's server-written `metadata.embedId` is THIS embed.
 *   Confirm does not ask this; release does, because release destroys
 *   something. Without it, the secret of an order made on the main checkout
 *   or through another embed would cancel that order here, outside the
 *   signed-in path that owns it. An order with no `embedId` (made before the
 *   key existed, a main-checkout or resale order) is refused and runs out
 *   through the reapers as before.
 * - Every one of those failures is the SAME refusal: same status, same body.
 *   Response time is not equalised.
 *
 * Then, with ownership proven and nothing written yet:
 *
 * - A PaymentIntent that is `succeeded` or `processing` is answered `kept`
 *   with no cancel attempt: the buyer paid (in another tab, perhaps), and
 *   that order is finalize's.
 * - A CANCELLED order is `gone`; any other order that is not PENDING is
 *   `kept`.
 * - Otherwise the release is `releaseCartHold`'s, acting as the order's
 *   buyer. There is no second release path: it cancels the PaymentIntent at
 *   Stripe first and proves it dead, then compare-and-swaps the order from
 *   PENDING and frees its seat, promo, fee-waiver and credit holds in one
 *   transaction. Whatever it will not release is `kept`, except when the
 *   compare-and-swap lost to another cancel (a second release, the cart
 *   reaper): the order is read again and, CANCELLED, answered `gone`.
 *
 * An embed REVOKED after the order was made answers EMBED_NOT_FOUND, like
 * every other embed procedure: its guests' holds run out through the reapers.
 * That is intended. A revoked embed serves nothing.
 *
 * Deliberately NOT checked:
 * - the buy-tickets switch and `linkOut`: giving a hold back must keep
 *   working after buying is switched off.
 * - `assertEventAllowedForEmbed`: `metadata.embedId` is written only by
 *   `createEmbedGuestCheckout`, after that same check passed for this embed
 *   and this order's event, so the binding already says more than the check
 *   would. Run again here it could only refuse an order whose event has
 *   since moved organization or whose series date was unpublished, and
 *   keeping that hold helps nobody. Dropping it also saves an anonymous
 *   caller up to three reads.
 *
 * The client secret never leaves this file and the proof module: it is not
 * logged, not put in an error's `meta`, not reported, not handed to
 * `releaseCartHold`, and not returned.
 */
export async function releaseEmbedGuestOrder(
  deps: ReleaseEmbedGuestOrderDeps,
  rawInput: unknown,
): Promise<ReleaseEmbedGuestOrderOutput> {
  const logger = deps.logger?.child({ useCase: "releaseEmbedGuestOrder" });
  const input = parseInput(releaseEmbedGuestOrderInputSchema, rawInput);

  // ── Validate embed + host origin ───────────────────────────────────
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
  // Before any Stripe call, and it writes nothing.
  const paymentIntentId = paymentIntentIdFromClientSecret(input.clientSecret);
  const refusal = guestProofRefusal({
    logger,
    useCase: "releaseEmbedGuestOrder",
    embedId: input.embedId,
    paymentIntentId,
  });

  const linkedOrder =
    await deps.repos.orders.findByPaymentIntent(paymentIntentId);
  if (!linkedOrder) {
    throw refusal("payment_intent_not_linked");
  }

  // ── One budget per PaymentIntent, before the Stripe call ───────────
  // After the link lookup (a made-up id spends nothing) and before the
  // retrieve (an ask over budget costs no Stripe call). Fails open.
  await chargeGuestProofBudget(deps, {
    logger,
    useCase: "releaseEmbedGuestOrder",
    keyPrefix: EMBED_GUEST_RELEASE_PI_BUDGET_KEY_PREFIX,
    maxRequests: EMBED_GUEST_RELEASE_PI_BUDGET_MAX,
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

  // ── The PaymentIntent must be this order's, made through this embed ─
  const metadataOrderId = metadataOrderIdSchema.safeParse(
    paymentIntent.metadata?.orderId,
  );
  if (!metadataOrderId.success) {
    throw refusal("metadata_order_id_missing");
  }
  if (metadataOrderId.data !== linkedOrder.id) {
    throw refusal("metadata_order_id_not_linked_order");
  }
  const orderId = metadataOrderId.data;

  // Refused exactly like a wrong secret, although the secret matched: the
  // caller learns nothing about which orders exist outside this embed.
  const metadataEmbedId = paymentIntent.metadata?.embedId;
  if (!metadataEmbedId) {
    throw refusal("metadata_embed_id_missing");
  }
  if (metadataEmbedId !== embed.id) {
    throw refusal("metadata_embed_id_other_embed");
  }

  const answer = (
    outcome: ReleaseEmbedGuestOrderOutput["outcome"],
    reason: string,
  ): ReleaseEmbedGuestOrderOutput => {
    logger?.info("releaseEmbedGuestOrder.answered", {
      embedId: input.embedId,
      orderId,
      paymentIntentId,
      outcome,
      reason,
    });
    return { outcome, orderId };
  };

  // ── A paid order is never touched ──────────────────────────────────
  // No cancel attempt and no write. Not reported: paying in another tab and
  // then closing this one is ordinary, and finalize owns the order.
  if (
    paymentIntent.status === "succeeded" ||
    paymentIntent.status === "processing"
  ) {
    return answer("kept", `payment_intent_${paymentIntent.status}`);
  }

  // ── The order itself ───────────────────────────────────────────────
  // Read only now, after proof: the buyer is needed to act as, and the link
  // lookup above answers id and status only.
  const order = await deps.repos.orders.getById(orderId);
  if (!order || order.status === "CANCELLED") {
    return answer("gone", order ? "order_cancelled" : "order_missing");
  }
  if (order.status !== "PENDING") {
    return answer("kept", `order_${order.status.toLowerCase()}`);
  }

  // ── Release through the one release path ───────────────────────────
  // The guest is the order's buyer: the secret was issued to whoever made
  // the order, and that is the only actor `releaseCartHold` accepts. It
  // reads the order again and decides on that copy, so a payment or a reap
  // that lands between the read above and here is answered, not overridden.
  const result = await releaseCartHold(
    {
      repos: deps.repos,
      payments: deps.payments,
      clock: deps.clock,
      logger: deps.logger,
      reportError: deps.reportError,
    },
    { actorHumanId: order.buyerHumanId, orderId },
  );

  if (result.released) return answer("released", "released");
  if (result.gone) return answer("gone", "release_found_nothing");

  // Not released, and not known gone. Either `releaseCartHold` kept the order
  // (Stripe would not prove the PaymentIntent dead; it logged and reported
  // why), or its compare-and-swap lost a race. Who won decides the answer, so
  // read the order once more: a second release, or the cart reaper, leaves it
  // CANCELLED, and then it holds nothing and the honest answer is `gone`.
  // Finalize leaves it paid, and that one is `kept`. No report either way:
  // the winner owns the order.
  const after = await deps.repos.orders.getById(orderId);
  if (!after || after.status === "CANCELLED") {
    return answer("gone", "release_lost_to_another_cancel");
  }
  return answer("kept", "release_kept");
}
