import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { AppError, fail, isAppError } from "@th/errors";
import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { RateLimitPort, RateLimitResult } from "@th/ports/rate-limit";
import type { ReporterPort } from "@th/ports/reporter";

import { reportBestEffort } from "../../../lib/payments/resolve-scoped-fee-policy";
import type { RetrievedPaymentIntent } from "../../orders/confirm-payment";

/**
 * The guest's proof of ownership, shared by every embed procedure a guest
 * calls about an order they made (`confirmEmbedGuestPayment`,
 * `releaseEmbedGuestOrder`). There is ONE proof: a second procedure reuses
 * this module, it does not write its own. Ticket codes take a second factor
 * on top of it, also kept here: the receipt secret (end of this file).
 *
 * A guest has no session, so the PaymentIntent client secret that
 * `embeds.createGuestCheckout` returned stands in for it. Stripe treats the
 * same string as the bearer credential for the PaymentIntent.
 */

/**
 * A Stripe PaymentIntent client secret: `<PaymentIntent id>_secret_<tail>`.
 * The id part takes what `PAYMENT_INTENT_ID_PATTERN` takes (alphanumerics and
 * underscores after `pi_`) and the tail is alphanumerics only. The lookahead
 * refuses two SEPARATE `_secret_` separators; it does not refuse two that
 * share an underscore, so `pi_a_secret_secret_x` fits the pattern. That is
 * harmless: the id looked up is the part before the FIRST `_secret_` (`pi_a`)
 * and the whole presented string is compared with that PaymentIntent's real
 * secret, which it cannot equal. A string that does not fit is refused as bad
 * input, with no order lookup and no Stripe call.
 */
const CLIENT_SECRET_PATTERN =
  /^pi_(?!.*_secret_.*_secret_)[A-Za-z0-9_]+_secret_[A-Za-z0-9]+$/;
const CLIENT_SECRET_SEPARATOR = "_secret_";

/**
 * The client secret `embeds.createGuestCheckout` returned for the order.
 * It is the ONLY proof of ownership a guest has: there is no session, and
 * an order id proves nothing (it is not an input for that reason). Real ones
 * are about 60 characters; 200 is generous.
 */
export const guestClientSecretSchema = z
  .string()
  .max(200)
  .regex(CLIENT_SECRET_PATTERN, "Invalid client secret");

/**
 * The PaymentIntent id inside a client secret: the part before the first
 * `_secret_`. Only for a string `guestClientSecretSchema` accepted.
 */
export function paymentIntentIdFromClientSecret(clientSecret: string): string {
  return clientSecret.slice(0, clientSecret.indexOf(CLIENT_SECRET_SEPARATOR));
}

/**
 * Builds THE refusal for every way of not proving ownership. Each call logs
 * its `reason` at warn (the only place the ways differ) and returns the same
 * bare error: no `meta`, no message beyond the code, so the response body is
 * identical whatever went wrong. The client secret is never an argument.
 */
export function guestProofRefusal(context: {
  logger: LoggerPort | undefined;
  /** The use case refusing, e.g. `confirmEmbedGuestPayment`. */
  useCase: string;
  embedId: string;
  paymentIntentId: string;
}): (reason: string) => AppError {
  return (reason) => {
    context.logger?.warn(`${context.useCase}.refused`, {
      embedId: context.embedId,
      paymentIntentId: context.paymentIntentId,
      reason,
    });
    return new AppError("PAYMENT_INTENT_ORDER_MISMATCH");
  };
}

/** The window of every per-PaymentIntent budget below. */
export const GUEST_PROOF_BUDGET_WINDOW_SECONDS = 60;

/**
 * Charges one ask against a budget keyed on the PAYMENT INTENT ID, and throws
 * RATE_LIMITED (TOO_MANY_REQUESTS at the tRPC boundary) when it is spent.
 *
 * Why it exists beside the transport's per-IP limiter: every call whose id is
 * linked to one of our orders costs a live Stripe retrieve under the platform
 * key, whatever the rest of the secret says. Someone who makes ONE embed
 * order holds such an id and could loop on it, and the per-IP limiter keys on
 * a header a caller can forge. This budget cannot be dodged that way: it is
 * per id, and minting more ids means making more orders, which the checkout
 * limiter and Turnstile cap.
 *
 * Call it AFTER the link lookup and BEFORE the Stripe retrieve. After, so a
 * made-up id (refused with no Stripe call anyway) cannot create a counter
 * per guess; before, so an ask over budget costs no Stripe call.
 *
 * The refusal is RATE_LIMITED, not the bare ownership refusal: the guest who
 * owns the order can hit it too (a widget asking again too fast) and has to
 * be told to ask later. It does tell a caller without the secret that the id
 * is one of ours; an id alone opens nothing.
 *
 * ACCEPTED RISK: the budget is charged before the secret is proven (the
 * retrieve that proves it is the cost being capped), so a caller who knows
 * only the id can spend it and keep the real guest at RATE_LIMITED. The id is
 * not public (it travels inside the secret), the Stripe webhook finalizes a
 * paid order whatever this endpoint answers, and a blocked release leaves the
 * hold to the reaper, as before release existed.
 *
 * FAILS OPEN. No limiter wired, or a limiter that throws (Redis down), lets
 * the ask through, exactly like the transport's limiters: an abuse cap must
 * not turn a paid buyer's confirm into a 500. The throw is a deliberate
 * swallow, so it is logged at error and reported.
 */
export async function chargeGuestProofBudget(
  deps: {
    rateLimit?: Pick<RateLimitPort, "consume"> | null;
    reportError?: ReporterPort | null;
  },
  context: {
    logger: LoggerPort | undefined;
    /** The use case asking, e.g. `confirmEmbedGuestPayment`. */
    useCase: string;
    /** Bucket prefix; the PaymentIntent id is appended. */
    keyPrefix: string;
    maxRequests: number;
    embedId: string;
    paymentIntentId: string;
  },
): Promise<void> {
  if (!deps.rateLimit) return;

  let result: RateLimitResult;
  try {
    result = await deps.rateLimit.consume(
      `${context.keyPrefix}${context.paymentIntentId}`,
      context.maxRequests,
      GUEST_PROOF_BUDGET_WINDOW_SECONDS,
    );
  } catch (err) {
    context.logger?.error(`${context.useCase}.proof_budget_consume_failed`, {
      embedId: context.embedId,
      paymentIntentId: context.paymentIntentId,
      err,
    });
    reportBestEffort(deps.reportError, err, {
      tags: { useCase: context.useCase, stage: "guestProofBudget" },
      extra: {
        embedId: context.embedId,
        paymentIntentId: context.paymentIntentId,
      },
    });
    return;
  }

  if (!result.allowed) {
    context.logger?.warn(`${context.useCase}.proof_budget_exceeded`, {
      embedId: context.embedId,
      paymentIntentId: context.paymentIntentId,
      retryAfterSeconds: result.retryAfterSeconds,
    });
    throw fail("RATE_LIMITED", {
      message: `Too many requests about this order. Try again in ${result.retryAfterSeconds}s.`,
      meta: {
        scope: "embed_guest_proof",
        retryAfterSeconds: result.retryAfterSeconds,
      },
    });
  }
}

/**
 * Retrieves the PaymentIntent and answers it only when `presentedSecret` is
 * its client secret; null for a wrong secret and for an id the processor does
 * not know. The answer is `retrievePaymentIntent`'s shape, so the real secret
 * stops in this function and nothing downstream can log or return it.
 */
export async function retrieveWhenSecretMatches(
  deps: { payments: PaymentProcessorPort },
  paymentIntentId: string,
  presentedSecret: string,
): Promise<RetrievedPaymentIntent | null> {
  const retrieve = deps.payments.retrievePaymentIntentWithClientSecret;
  if (!retrieve) {
    // The processor cannot show us the secret, so nothing can be proven.
    // Never fall back to `retrievePaymentIntent`: that would act on the
    // strength of an id alone. INTERNAL (a 500) because this is our wiring,
    // not the guest's request, and only a 500 is kept by the Sentry filter.
    throw fail("INTERNAL", {
      message:
        "payment processor cannot verify a client secret (retrievePaymentIntentWithClientSecret)",
    });
  }

  let retrieved: Awaited<ReturnType<typeof retrieve>>;
  try {
    retrieved = await retrieve.call(deps.payments, { paymentIntentId });
  } catch (err) {
    // The Stripe adapter turns "no such PaymentIntent" into a typed NOT_FOUND
    // (`rethrowPaymentIntentError`). Reachable only for an id linked to an
    // order here that Stripe does not know (another Stripe account or mode).
    // Not a swallow: the caller throws the same refusal it throws for a
    // wrong secret. Every other failure (auth,
    // rate limit, network) is rethrown for the backstops.
    if (isAppError(err) && err.code === "NOT_FOUND") return null;
    throw err;
  }

  if (
    retrieved.clientSecret === null ||
    !secretsMatch(presentedSecret, retrieved.clientSecret)
  ) {
    return null;
  }

  return {
    id: retrieved.id,
    status: retrieved.status,
    amountReceived: retrieved.amountReceived,
    currency: retrieved.currency,
    metadata: retrieved.metadata,
  };
}

/**
 * Constant-time equality. Both sides are hashed first so the buffers are the
 * same length whatever was presented (`timingSafeEqual` throws on a length
 * mismatch, and an early length check would leak the real secret's length).
 */
export function secretsMatch(
  presentedSecret: string,
  realSecret: string,
): boolean {
  const a = createHash("sha256").update(presentedSecret).digest();
  const b = createHash("sha256").update(realSecret).digest();
  return timingSafeEqual(a, b);
}

/**
 * THE RECEIPT SECRET: the second factor on a paid embed order's ticket codes.
 *
 * The client secret alone proves a caller may confirm (and release) an order,
 * but it is not kept only in the widget: a redirect payment method (Cash App
 * Pay, Amazon Pay) brings the buyer back on a URL carrying it, and that first
 * GET lands in request logs and browser history. A code IS door admission,
 * so codes need a proof that never travels in a URL.
 *
 * `createEmbedGuestCheckout` makes one per paid order with
 * {@link newGuestReceiptSecret}, returns it to the widget once, and writes
 * only its hash to the PaymentIntent's metadata (`receiptSecretHash`, through
 * the server-only checkout context; Stripe lets only the secret key write
 * metadata, so no client can plant one). The widget keeps it in the tab that
 * started the payment (memory and sessionStorage, never a URL) and sends it
 * with every `confirmGuestPayment`. `confirmEmbedGuestPayment` returns codes
 * only when it matches ({@link guestReceiptSecretMatches}); otherwise the
 * answer is the same `confirmed` with no codes, and the email carries them.
 *
 * It gates the CODES only. The confirm itself and the release stay on the
 * client secret alone: a buyer who comes back in another tab (a phone's Cash
 * App) must still see their order confirmed.
 *
 * 32 random bytes, base64url: 43 characters, 256 bits. Named `*Secret` on
 * purpose: the API's Sentry scrubbers redact `*secret` keys in request
 * bodies, URLs and frame locals (apps/api/src/instrument.ts).
 */
const GUEST_RECEIPT_SECRET_BYTES = 32;

/** The hash as stored in PaymentIntent metadata: SHA-256, lowercase hex. */
const RECEIPT_SECRET_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * A receipt secret as the widget presents it. Real ones are 43 base64url
 * characters; the bounds only keep junk out.
 */
export const guestReceiptSecretSchema = z
  .string()
  .min(20)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "Invalid receipt secret");

/** SHA-256 of a receipt secret, lowercase hex: what metadata stores. */
export function hashGuestReceiptSecret(receiptSecret: string): string {
  return createHash("sha256").update(receiptSecret).digest("hex");
}

/** A fresh receipt secret and the hash to store for it. */
export function newGuestReceiptSecret(): {
  receiptSecret: string;
  receiptSecretHash: string;
} {
  const receiptSecret = randomBytes(GUEST_RECEIPT_SECRET_BYTES).toString(
    "base64url",
  );
  return {
    receiptSecret,
    receiptSecretHash: hashGuestReceiptSecret(receiptSecret),
  };
}

/**
 * Whether `presentedSecret` is the receipt secret whose hash is
 * `storedHash` (the PaymentIntent's `metadata.receiptSecretHash`). False
 * when either is missing, and when the stored value is not a hash at all (an
 * order made before receipt secrets existed has none). Constant time over
 * the hashes (`secretsMatch`). The parameter name ends in `Secret` so the
 * API's Sentry frame-local scrubber redacts it.
 */
export function guestReceiptSecretMatches(
  presentedSecret: string | undefined,
  storedHash: unknown,
): boolean {
  if (presentedSecret === undefined) return false;
  if (typeof storedHash !== "string") return false;
  if (!RECEIPT_SECRET_HASH_PATTERN.test(storedHash)) return false;
  return secretsMatch(hashGuestReceiptSecret(presentedSecret), storedHash);
}
