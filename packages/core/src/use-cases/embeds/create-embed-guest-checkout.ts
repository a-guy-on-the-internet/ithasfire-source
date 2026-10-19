import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { TaxRateLookupPort } from "@th/ports/tax-rate-lookup";
import type { TurnstilePort } from "@th/ports/turnstile";

import { parseInput } from "../../lib/io";
import { donationAmountCentsSchema } from "../../lib/pricing/pay-what-you-want";
import { createCheckout } from "../orders/create-checkout";
import { assertOneDonationAmountPerTier } from "../orders/checkout-helpers";
import {
  MAX_SEATS_PER_CHECKOUT_ITEM,
  refineSeatQuotes,
  seatQuoteSchema,
} from "../orders/_shared/seat-quotes";
import { feeModeSchema } from "../../lib/pricing/compute-ticket-price-for-agreement";
import { assertEmbedOriginAllowed } from "./_shared/assert-embed-origin-allowed";
import { newGuestReceiptSecret } from "./_shared/guest-client-secret";
import { assertEventAllowedForEmbed } from "./_shared/is-event-allowed-for-embed";
import { assertEventUngatedForEmbed } from "./_shared/assert-event-ungated-for-embed";
import {
  embedGuestTicketsSchema,
  readEmbedGuestTicketsOrEmpty,
  type EmbedGuestTicket,
} from "./_shared/read-embed-guest-tickets";
import { fail } from "@th/errors";
import { plainTextRequired } from "../../lib/sanitize-plain-text";
import { ensureGuestHumanKeepingName } from "../../lib/ensure-guest-human";

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A v4 UUID, the shape `crypto.randomUUID()` gives: the only `clientKey` a
 * free claim's answer carries ticket codes for.
 */
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** See `clientKey` below for why 19, and when it becomes 36. */
export const EMBED_GUEST_CLIENT_KEY_MIN_LENGTH = 19;

/**
 * The embed checkout's idempotency namespace: every embed `clientKey` reaches
 * `createCheckout` as `embed:<key>`. Reserved: the main-site
 * `orders.createCheckout` refuses a client key that starts with it, so only
 * this use case can mint a key in the namespace.
 */
export const EMBED_CHECKOUT_CLIENT_KEY_PREFIX = "embed:";

export const createEmbedGuestCheckoutInputSchema = z
  .object({
    embedId: z.uuid(),
    eventId: z.uuid(),
    /**
     * Origin of the page hosting the widget iframe, computed client-side.
     * Enforced against the embed's domain allowlist — null fails closed.
     */
    hostOrigin: z.string().url().nullable(),
    guestName: plainTextRequired(200),
    guestEmail: z.string().trim().email().max(320),
    /**
     * The widget's per-attempt idempotency key. Whoever knows it (and the
     * guest's email) can replay the checkout and be handed the order's client
     * secret, which is the guest's whole proof of ownership, so it must not
     * be guessable.
     *
     * Minimum 19: `emb_` + a 13-digit millisecond timestamp + `_` + at
     * least one character. That is the shortest key the shipped widget can
     * send: its tail is `Math.random().toString(36).slice(2, 10)`, which is
     * usually 8 characters but prints the shortest form of the number, so it
     * can be shorter. Tabs loaded before the deploy that moves the widget to
     * `crypto.randomUUID()` (36 characters) still send that format, and web
     * and API deploy separately, so 19 is the highest floor that refuses no
     * live tab. Raise it to 36 once the UUID widget build is live everywhere.
     *
     * The floor checks LENGTH, not randomness: a client that sends a long
     * guessable key gets a guessable key. Unguessability is the widget's
     * job (the UUID build); the floor only stops a short one.
     *
     * Maximum 122: createCheckout caps at 128 after the "embed:" prefix.
     */
    clientKey: z
      .string()
      .min(EMBED_GUEST_CLIENT_KEY_MIN_LENGTH)
      .max(122),
    /** Cloudflare Turnstile token for bot protection. Required when Turnstile is enabled. */
    turnstileToken: z.string().min(1).max(4096).optional(),
    items: z
      .array(
        z
          .object({
            ticketTypeId: z.uuid(),
            qty: z.number().int().positive(),
            seatIds: z
              .array(z.string().uuid())
              .min(1)
              .max(MAX_SEATS_PER_CHECKOUT_ITEM)
              .optional(),
            /**
             * Pay-what-you-want amount for ONE ticket of an ADJUSTABLE tier, in
             * cents — the same field, cap and meaning as `createCheckout`. The
             * amount IS the ticket price; the platform fee, processing and tax
             * go on top. Minimum enforced by `computeOrderAmounts`.
             */
            donationAmountCents: donationAmountCentsSchema.optional(),
            /**
             * The unit price the guest was shown per picked seat: the same
             * field and meaning as `createCheckout`'s, an assertion that is
             * never charged from (`orders/_shared/seat-quotes.ts`).
             */
            seatQuotes: z
              .array(seatQuoteSchema)
              .min(1)
              .max(MAX_SEATS_PER_CHECKOUT_ITEM)
              .optional(),
          })
          .superRefine(refineSeatQuotes),
      )
      .nonempty(),
    promoCodes: z.array(z.string().trim().min(3).max(64)).max(5).optional(),
    billingAddress: z
      .object({
        line1: z.string().min(1).max(200),
        line2: z.string().max(200).optional(),
        city: z.string().min(1).max(100),
        state: z.string().min(1).max(100),
        postalCode: z.string().min(1).max(20),
        country: z.string().length(2),
      })
      .optional(),
    waiverAccepted: z.boolean().optional(),
    /** Must be true — buyer must accept the platform ToS before an order is persisted. */
    termsAccepted: z.boolean().optional(),
    /** Must be true — guest buyer must explicitly acknowledge the refund policy. */
    refundPolicyAccepted: z.boolean(),
    /** Server-observed client IP, supplied by trusted transports only. */
    requestIp: z.string().trim().min(1).max(128).nullable().optional(),
    /** Server-observed user agent, supplied by trusted transports only. */
    requestUserAgent: z.string().max(1024).nullable().optional(),
  })
  .strict();

export const createEmbedGuestCheckoutOutputSchema = z.object({
  orderId: z.uuid(),
  clientSecret: z.string().min(1).nullable(),
  /**
   * The order's receipt secret: the second factor `confirmGuestPayment`
   * wants before it hands over ticket codes (`_shared/guest-client-secret.ts`).
   * Made by this call, returned here once and never stored: the
   * PaymentIntent's metadata keeps only its hash. Null for an order with no
   * PaymentIntent (a free claim's codes ride `tickets` below).
   *
   * An idempotent replay of the `clientKey` makes a NEW secret, which the
   * stored hash does not match: that answer's tab gets no codes from
   * `confirmGuestPayment` (the email carries them).
   */
  receiptSecret: z.string().min(1).nullable(),
  amountGrossCents: z.number().int(),
  feesPlatformCents: z.number().int(),
  buyerFeesCents: z.number().int(),
  /**
   * Processor fee in cents. For a PASS_THROUGH Stripe charge this is the
   * grossed-up fee the buyer funds (createCheckout adds it to the
   * PaymentIntent); for ABSORB it is the display-only estimate.
   */
  processorFeeCents: z.number().int().nonnegative(),
  /**
   * Effective fee mode for this order. The embed UI reads this to decide
   * whether the processor fee is part of the buyer-facing total (PASS_THROUGH)
   * or excluded as an absorbed estimate (ABSORB).
   */
  feeMode: feeModeSchema,
  taxAmountCents: z.number().int(),
  holdExpiresAt: z.string().datetime().nullable(),
  /**
   * The order's ticket lines as PERSISTED for this order — what the
   * confirmation prints, instead of rebuilding them from the client cart.
   * One entry per ticket type and unit price (a seated order's per-seat items
   * collapse into one line). `unitPriceCents` is the pre-discount face price
   * charged per ticket (a pay-what-you-want line at the buyer's amount);
   * `lineCents = unitPriceCents × qty`. Σ lineCents − the order's discounts
   * = `amountGrossCents`, so Σ lineCents ≥ `amountGrossCents` and the
   * difference is the promo / member discount.
   *
   * EMPTY only for an order already completed without a PaymentIntent (a
   * free claim; embed orders never redeem credit) whose lines could not be
   * read back — the
   * failure is reported and the confirmation still renders from the order
   * figures. With a PaymentIntent, a failed read throws instead.
   */
  lineItems: z.array(
    z.object({
      ticketTypeId: z.uuid(),
      name: z.string(),
      qty: z.number().int().positive(),
      unitPriceCents: z.number().int().nonnegative(),
      lineCents: z.number().int().nonnegative(),
    }),
  ),
  /**
   * The ticket codes of an order this call COMPLETED: a free claim, whose
   * tickets `createCheckout` mints in the claim's own transaction, so they
   * exist when this returns. Same shape and rules as
   * `embeds.confirmGuestPayment`'s `tickets`
   * (`_shared/read-embed-guest-tickets.ts`): read at current state, the
   * buyer's VALID tickets only, within `EMBED_GUEST_TICKET_WINDOW_MS` of
   * their issue (which also bounds what an idempotent replay of the
   * `clientKey` is handed), and `[]` on a failed read (reported).
   *
   * Also EMPTY unless `clientKey` is a v4 UUID (the current widget's
   * `crypto.randomUUID()`): a replay of the key is handed this answer
   * again, and the older `emb_<ms>_<base36>` key is guessable.
   *
   * Always present. ALWAYS EMPTY for an order with a PaymentIntent
   * (`clientSecret` set): nothing is minted until the payment is confirmed,
   * and a code IS admission, so a paid order's codes come only from
   * `confirmGuestPayment`, after the secret is proven.
   */
  tickets: embedGuestTicketsSchema,
});

export type EmbedOrderLineItem = z.infer<
  typeof createEmbedGuestCheckoutOutputSchema
>["lineItems"][number];

export type CreateEmbedGuestCheckoutInput = z.infer<
  typeof createEmbedGuestCheckoutInputSchema
>;
export type CreateEmbedGuestCheckoutOutput = z.infer<
  typeof createEmbedGuestCheckoutOutputSchema
>;

export type CreateEmbedGuestCheckoutDeps = {
  repos: Repos;
  payments: PaymentProcessorPort;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Turnstile adapter for bot protection. When enabled, a valid token is required. */
  turnstile?: TurnstilePort | null;
  /** Base URL of our own web app; its origin is always allowed to host embeds. */
  publicAppUrl?: string | null;
  /**
   * Last-chance admission-tax lookup for an event never stamped at publish
   * time. `deps` is handed whole to `createCheckout`, so leaving this out does
   * not "skip a feature": the embed buyer is charged $0 tax where the main
   * checkout charges the provider's rate for the same cart. Wire it exactly
   * as `orders.createCheckout` does.
   */
  taxRateLookup?: TaxRateLookupPort | null;
  /**
   * Forwarded to `createCheckout`: the tax resolver's deliberate swallows
   * (provider miss, unruled jurisdiction, failed write-back) report through it.
   * Also reports this use case's own swallows: a completed (free) order
   * whose lines, or whose tickets, could not be read back.
   */
  reportError?: ReporterPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

export async function createEmbedGuestCheckout(
  deps: CreateEmbedGuestCheckoutDeps,
  rawInput: unknown,
): Promise<CreateEmbedGuestCheckoutOutput> {
  const logger = deps.logger?.child({ useCase: "createEmbedGuestCheckout" });

  const execute = async () => {
    const input = parseInput(createEmbedGuestCheckoutInputSchema, rawInput);

    if (input.refundPolicyAccepted !== true) {
      throw fail("REFUND_POLICY_REQUIRED");
    }

    // createCheckout refuses this cart too, but only after the guest-human
    // upsert below has written; refuse it before any write.
    assertOneDonationAmountPerTier(input.items);

    // ── Validate embed + host origin ─────────────────────────────────
    // The origin allowlist is checked FIRST — before Turnstile (a network
    // round-trip) and long before any guest-account or Stripe work — so an
    // unauthorized embedding site can't cause side effects.
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

    // Link-out embeds render only "get tickets on the canonical page" CTAs —
    // the organizer opted out of in-iframe checkout, so the server refuses it
    // too rather than honoring the flag client-side only.
    if (embed.linkOut) {
      throw fail("EMBED_LINK_OUT_ONLY");
    }

    // ── Verify Turnstile token (bot protection) ──────────────────────
    if (deps.turnstile?.enabled) {
      if (!input.turnstileToken) {
        throw fail("TURNSTILE_TOKEN_REQUIRED");
      }
      const valid = await deps.turnstile.verify(
        input.turnstileToken,
        input.requestIp ?? undefined,
      );
      if (!valid) {
        logger?.warn("createEmbedGuestCheckout.turnstileFailed", {
          embedId: input.embedId,
        });
        throw fail("TURNSTILE_VERIFICATION_FAILED");
      }
      logger?.info("createEmbedGuestCheckout.turnstilePassed", {
        embedId: input.embedId,
      });
    }

    // ── Validate event belongs to embed subject ──────────────────────
    const event = await deps.repos.events.getById(input.eventId, {
      withOwnerStanding: true,
    });
    // A banned owner's event is withheld (ban-that-sticks).
    if (
      !event ||
      event.status !== "PUBLISHED" ||
      event.ownerBanned === true
    ) {
      throw fail("EVENT_NOT_FOUND");
    }

    if (embed.subjectType === "organization" || embed.subjectType === "event") {
      await assertEventAllowedForEmbed(deps, embed, event);
    } else {
      throw fail("UNSUPPORTED_SUBJECT_TYPE");
    }
    // A gated event is never sold through the widget (owner ruling
    // 2026-10-12). Checked HERE, before the guest Human is resolved: the
    // buyer is named by a TYPED email, so `createCheckout`'s unlock check
    // would pass for anyone who types an approved person's address.
    assertEventUngatedForEmbed(event);

    // ── Resolve or create a guest Human record ─────────────────────
    // Uses ensureGuestHuman which creates a shadow AuthUser linked to
    // the Human so the guest's email is persisted and discoverable.
    // If they later sign up with the same email, their purchase
    // history is already attached.
    // Never renames an existing account: guestName is typed by an
    // unauthenticated buyer, and the email may be someone else's.
    const { humanId: buyerHumanId, created } =
      await ensureGuestHumanKeepingName(deps.repos.humans, {
        email: input.guestEmail,
        name: input.guestName,
      });

    if (created) {
      logger?.info("createEmbedGuestCheckout.guestHumanCreated", {
        email: maskEmail(input.guestEmail),
        humanId: buyerHumanId,
      });
    } else {
      logger?.info("createEmbedGuestCheckout.existingHumanFound", {
        email: maskEmail(input.guestEmail),
        humanId: buyerHumanId,
      });
    }

    // ── The receipt secret: codes are handed only to whoever holds it ─
    // Made before the checkout so its hash rides the PaymentIntent's
    // server-written metadata. Never logged, never in an error or a report.
    const { receiptSecret, receiptSecretHash } = newGuestReceiptSecret();

    // ── Delegate to the canonical createCheckout use case ────────────
    // The guest acts as both actor and buyer.
    const result = await createCheckout(
      deps,
      {
        actorHumanId: buyerHumanId,
        buyerHumanId,
        eventId: input.eventId,
        // Namespaced: the guest is resolved by EMAIL, so without the prefix an
        // embed request carrying a key the account owner used on the main
        // checkout would replay the owner's stored result (their PaymentIntent
        // secret and applied credit).
        clientKey: `${EMBED_CHECKOUT_CLIENT_KEY_PREFIX}${input.clientKey}`,
        items: input.items.map((i) => ({
          ticketTypeId: i.ticketTypeId,
          qty: i.qty,
          ...(i.seatIds ? { seatIds: i.seatIds } : {}),
          // Forwarded untouched: `createCheckout` compares, never charges it.
          ...(i.seatQuotes ? { seatQuotes: i.seatQuotes } : {}),
          // Forwarded untouched: `createCheckout` prices it, so an embed PWYW
          // charge cannot drift from the main checkout's.
          ...(i.donationAmountCents !== undefined
            ? { donationAmountCents: i.donationAmountCents }
            : {}),
        })),
        ...(input.promoCodes?.length ? { promoCodes: input.promoCodes } : {}),
        ...(input.billingAddress ? { billingAddress: input.billingAddress } : {}),
        ...(typeof input.waiverAccepted === "boolean"
          ? { waiverAccepted: input.waiverAccepted }
          : {}),
        ...(typeof input.termsAccepted === "boolean"
          ? { termsAccepted: input.termsAccepted }
          : {}),
        refundPolicyAccepted: input.refundPolicyAccepted,
        requestIp: input.requestIp ?? null,
        requestUserAgent: input.requestUserAgent ?? null,
        // The owner added Amazon Pay and Cash App on 2026-10-12, then turned
        // both off in Stripe on 2026-10-13, so the processor no longer
        // requests them and this flag keeps only its default meaning. Bank
        // debit (ACH) stays off: the owner never ruled it in for the embed.
        // Net: the embed offers card (Link and wallets ride on card).
        allowRedirectPaymentMethods: true,
        allowBankDebit: false,
        // Owner ruling 2026-10-03: an unauthenticated embed guest never spends
        // the account's platform credit (the email may be someone else's); it
        // is spent only on the signed-in main checkout.
        applyPlatformCredit: false,
      },
      // Server-only, and deliberately NOT part of the input above: the embed
      // this order is made through, written to the PaymentIntent's metadata.
      // `releaseEmbedGuestOrder` lets a guest release an order only through
      // the embed that made it. `embed.id` is the row read and checked above
      // (ACTIVE, origin allowed, may sell this event), not the request's id.
      // Beside it, the receipt secret's hash (never the secret):
      // `confirmEmbedGuestPayment` hands codes only to a caller presenting
      // the secret it hashes from.
      { embedId: embed.id, receiptSecretHash },
    );

    // Read AFTER createCheckout returns, from the persisted order — not from
    // createCheckout's result, which an idempotent replay serves from a
    // stored response that may predate this field. The confirmation must not
    // print lines the charge does not add up to, so a read failure or an
    // inconsistency never yields guessed lines.
    let lineItems: EmbedOrderLineItem[];
    try {
      lineItems = await readOrderLineItems(deps.repos, {
        orderId: result.orderId,
        eventId: input.eventId,
        buyerHumanId,
        amountGrossCents: result.amountGrossCents,
      });
    } catch (err) {
      // A PaymentIntent exists (clientSecret set): nothing is charged yet,
      // so refusing is safe — the buyer retries.
      if (result.clientSecret !== null) throw err;
      // No PaymentIntent: a free claim (an embed order is never
      // credit-covered — it passes `applyPlatformCredit: false`), which
      // createCheckout already COMPLETED (tickets minted). Throwing here would
      // show an error for a finished purchase, so degrade to no lines (the
      // confirmation's Total comes from the order figures) and report it.
      logger?.error("createEmbedGuestCheckout.lineItemsReadFailed", {
        orderId: result.orderId,
        eventId: input.eventId,
        err,
      });
      try {
        deps.reportError?.(err, {
          tags: {
            useCase: "createEmbedGuestCheckout",
            stage: "readOrderLineItems",
          },
          extra: { orderId: result.orderId, eventId: input.eventId },
        });
      } catch {
        // A throwing reporter must never change the outcome.
      }
      lineItems = [];
    }

    // A free claim is complete and its tickets are minted: hand the codes to
    // the confirmation. Gated on the missing PaymentIntent, not on what the
    // read finds, so an order still awaiting payment never yields a code
    // here. Also gated on the key's shape: replaying the `clientKey` (with
    // the email and cart) replays this answer, so codes go only to a key
    // the current widget makes (`crypto.randomUUID()`). An older widget's
    // `emb_<ms>_<base36>` key is guessable enough to refuse admission to,
    // though it still makes a valid checkout. Never throws (a failed read is
    // reported and answers `[]`).
    const tickets: EmbedGuestTicket[] =
      result.clientSecret === null && UUID_V4_RE.test(input.clientKey)
        ? await readEmbedGuestTicketsOrEmpty(deps, {
            orderId: result.orderId,
            useCase: "createEmbedGuestCheckout",
            logger,
          })
        : [];

    // A count, never the codes.
    logger?.info("createEmbedGuestCheckout.succeeded", {
      orderId: result.orderId,
      buyerHumanId,
      embedId: input.embedId,
      eventId: input.eventId,
      ticketCount: tickets.length,
    });

    return {
      ...result,
      // Paid orders only: a free claim has no confirm to present it to.
      receiptSecret: result.clientSecret !== null ? receiptSecret : null,
      lineItems,
      tickets,
    };
  };

  if (logger) {
    return logger.withTime("createEmbedGuestCheckout", execute);
  }
  return execute();
}

/**
 * The order's ticket lines as persisted. `createCheckout` writes one `ticket`
 * item per ticket (qty 1, `unitPriceCents` = the face price it charged — the
 * buyer's amount on a pay-what-you-want tier) plus one negative `discount`
 * item per promo / member application, and stamps
 * `amountGrossCents = Σ ticket − Σ discount`. Items are grouped by ticket type
 * and unit price and ordered as the event lists its ticket types.
 *
 * Throws `INTERNAL` when the order is missing, is not this checkout's, names
 * a ticket type the event does not have, or its items do not reproduce
 * `amountGrossCents` — never a guessed line.
 */
async function readOrderLineItems(
  repos: Repos,
  params: {
    orderId: string;
    eventId: string;
    buyerHumanId: string;
    amountGrossCents: number;
  },
): Promise<EmbedOrderLineItem[]> {
  const [order, ticketTypes] = await Promise.all([
    repos.orders.getById(params.orderId),
    repos.events.listTicketTypes(params.eventId),
  ]);
  if (
    !order ||
    order.eventId !== params.eventId ||
    order.buyerHumanId !== params.buyerHumanId
  ) {
    throw fail("INTERNAL", {
      message: `embed_order_lines: order ${params.orderId} not found for this checkout`,
    });
  }

  const typeIndex = new Map(ticketTypes.map((tt, i) => [tt.id, i] as const));
  const lines = new Map<string, EmbedOrderLineItem>();
  let discountCents = 0;
  for (const item of order.items) {
    if (item.kind === "discount") {
      discountCents += -item.amountCents;
      continue;
    }
    if (item.kind !== "ticket") continue;
    const ticketTypeId = item.ticketTypeId;
    const ticketType =
      ticketTypeId !== null
        ? ticketTypes[typeIndex.get(ticketTypeId) ?? -1]
        : undefined;
    if (!ticketTypeId || !ticketType) {
      throw fail("INTERNAL", {
        message: `embed_order_lines: order ${params.orderId} item ${item.id} has no ticket type on event ${params.eventId}`,
      });
    }
    const key = `${ticketTypeId}:${item.unitPriceCents}`;
    const line = lines.get(key);
    if (line) {
      line.qty += item.qty;
      line.lineCents = line.unitPriceCents * line.qty;
    } else {
      lines.set(key, {
        ticketTypeId,
        name: ticketType.name,
        qty: item.qty,
        unitPriceCents: item.unitPriceCents,
        lineCents: item.unitPriceCents * item.qty,
      });
    }
  }

  const result = [...lines.values()].sort(
    (a, b) =>
      (typeIndex.get(a.ticketTypeId) ?? 0) -
        (typeIndex.get(b.ticketTypeId) ?? 0) ||
      a.unitPriceCents - b.unitPriceCents,
  );

  const linesCents = result.reduce((sum, line) => sum + line.lineCents, 0);
  if (linesCents - discountCents !== params.amountGrossCents) {
    throw fail("INTERNAL", {
      message: `embed_order_lines: order ${params.orderId} lines ${linesCents} - discounts ${discountCents} !== amountGrossCents ${params.amountGrossCents}`,
    });
  }
  return result;
}

/**
 * PII hygiene: guest emails must not land in log sinks in plaintext. Mirrors
 * the masking shape used by volunteer-scan-tokens.ts (`g***@example.com`) —
 * enough to correlate a support report, not enough to harvest.
 */
function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  const safeLocal = local && local.length > 1 ? `${local[0]}***` : "***";
  return `${safeLocal}@${domain}`;
}
