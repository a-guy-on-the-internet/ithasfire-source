import { z } from "zod";
import { donationAmountCentsSchema } from "../../lib/pricing/pay-what-you-want";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type { TaxRateLookupPort } from "@th/ports/tax-rate-lookup";
import type {
  PayeeRecord,
  GetPayeeBySubjectInput,
} from "@th/ports/repos/payees";
import { asKnownError } from "../../lib/errors";
import { abandonClaim } from "../../lib/idempotency-claim";
import { callOrDependencyFailed, parseInput } from "../../lib/io";
import {
  deriveChargebackTermsRiskOwner,
  requireAnyChargebackTermsForRiskOwner,
} from "../../lib/payments/chargeback-terms";
import { recordAcceptance } from "../../lib/legal/acceptance";
import { CURRENT_BUYER_TERMS_VERSION } from "../../lib/legal/buyer-terms";
import { getCurrentRefundPolicySnapshot } from "../../lib/payments/refund-policy";
import { buildPaymentDescription } from "../../lib/payments/payment-description";
import { buildStatementDescriptorSuffix } from "../../lib/payments/statement-descriptor";
import type { ReporterPort } from "@th/ports/reporter";

import {
  aggregateItems,
  computeOrderAmounts,
  ensureBuyerMayEnterEvent,
  ensureEventOnSale,
  extractSeatIdsFromMeta,
  heldSeatIdForItem,
  holdSeatsForCheckout,
  loadAgreementContext,
  readSeatPriceOverrides,
  STRIPE_MIN_CHARGE_CENTS,
  type OrderComputation,
  type TicketTypeSummary,
} from "./checkout-helpers";
import { reserveFeeWaiverForCheckout } from "./fee-waiver-checkout";
import { assertTicketTypeCapacity } from "../_helpers/assert-ticket-type-capacity";
import { releaseRetiredCartHolds } from "./_shared/retire-carried-over-cart";
import {
  applyCheckoutServerContextToMetadata,
  checkoutServerContextSchema,
  type CheckoutServerContext,
} from "./_shared/checkout-server-context";
import {
  retireSettledCarriedOverCart,
  settleCarriedOverCartBeforeTx,
  withSettledCarriedOverCart,
  type SettledCarriedOverCart,
} from "./_shared/settle-carried-over-cart-before-tx";
import {
  ORDER_HOLD_TTL_SECONDS,
  resolveSeatHoldFence,
} from "./_shared/cart-seat-release";
import {
  preparePromoCodes,
  evaluatePromoApplications,
  createPromoHolds,
  applicationLedgerCode,
  describeApplicationForAudit,
  type PromoCodeEntry,
} from "./checkout-promos";
import { resolveMemberBenefits } from "../memberships/resolve-member-benefits";
import { claimFreeTickets } from "./claim-free-tickets";
import { mintTicketsForOrder } from "../tickets/mint-tickets";
import { recordAttribution } from "./record-attribution";
import { notifyBuyer, type NotifyFn } from "./notify-buyer";
import {
  applyCheckoutTaxSelfHeal,
  newCheckoutTaxAfterCommit,
  prepareCheckoutTax,
  resolveCheckoutTax,
  type CheckoutTaxResolution,
} from "./_shared/resolve-checkout-tax-rate";
import { computeOrderSplits } from "../../lib/pricing/compute-order-splits";
import { reportBestEffort } from "../../lib/payments/resolve-scoped-fee-policy";
import { priceComputedCart } from "./_shared/price-cart";
import {
  resolveTicketResaleClause,
  stampTicketResaleClause,
} from "./_shared/resolve-ticket-resale-clause";
import {
  assertSeatQuotesMatch,
  collectSeatQuotes,
  MAX_SEATS_PER_CHECKOUT_ITEM,
  refineSeatQuotes,
  seatQuoteSchema,
} from "./_shared/seat-quotes";
import { feeModeSchema } from "../../lib/pricing/compute-ticket-price-for-agreement";
import { createCreditsFromOrder } from "../settlements/create-credits-from-order";
import {
  computeAgreementBasis,
  hasUnknownOrganiserCredit,
} from "./finalize-from-payment-intent";
import { fail } from "@th/errors";

/**
 * How long `idempotency.begin` holds the client key while one attempt runs.
 * It must outlive the WORST-CASE attempt: once it lapses, a same-key request
 * runs a second attempt in parallel, and since the Stripe key is per order
 * (see `pendingPayment`) nothing downstream would dedupe the two.
 *
 * The Stripe client is `timeout: 60_000, maxNetworkRetries: 1` (the
 * `StripeAdapter` constructor), so one Stripe call is up to 60 s × 2 = 120 s, and a
 * `repos.tx` is capped at `DEFAULT_TX_TIMEOUT_MS` = 30 s:
 *
 *   superseded-cart settle (cancel + retrieve),
 *     run up to twice (`withSettledCarriedOverCart`)  2 × 240 = 480 s
 *   tax-provider lookup + retries (prepareCheckoutTax,
 *     capped by TAX_LOOKUP_RETRY_BUDGET_MS)                       8 s
 *   routing-probe tx + checkout tx (twice)          3 × 30  =  90 s
 *   createPaymentIntent                                         120 s
 *   link tx                                                      30 s
 *   unwind on failure (cancel PI + release tx)     120 + 30 = 150 s
 *                                                          ≈ 878 s
 *
 * Rounded up to 900 s. The free route (`claimFreeTickets`) runs the same
 * settle loop around its own transaction and creates no PaymentIntent:
 * 30 + 2 × (240 + 30) = 570 s, inside the same lock.
 *
 * A failed attempt releases its claim (`abandonClaim`),
 * but a lock left behind by an attempt that died mid-flight (SIGTERM / OOM
 * mid-Stripe-call), or whose result could not be stored, lasts that long:
 * the web checkout and the embed keep the key after a failure with no server
 * code (the request may have committed, and the same key replays it), so the
 * buyer's retries answer IDEMPOTENCY_LOCK_IN_PROGRESS until it lapses or they
 * reload (apps/web/src/lib/checkout-client-key.ts). Server refusals rotate the
 * key. Mobile does not call createCheckout yet.
 */
const IDEMPOTENCY_TTL_SECONDS = 900;
const SEAT_HOLD_TTL_SECONDS = 900;

export const createCheckoutInputSchema = z.object({
  actorHumanId: z.uuid(),
  buyerHumanId: z.uuid(),
  eventId: z.uuid(),
  // Bounded: the Stripe idempotency key is built from it (plus ~90 chars of
  // prefix, actor and order id) and Stripe caps keys at 255 characters. An
  // over-long key would fail every retry as `dependency_failed`. Web and
  // mobile send a UUID. Embed keys arrive with the `embed:` prefix
  // (`embed:<uuid>`, or `embed:emb_<ms>_<base36>` from a widget loaded before
  // the UUID build), from `createEmbedGuestCheckout`.
  clientKey: z.string().min(8).max(128),
  /** ID of a pending order from updateOrderItems — used to release previously held seats. */
  pendingOrderId: z.uuid().optional(),
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
          // Capped at MAX_DONATION_AMOUNT_CENTS ($10,000.00 per ticket).
          donationAmountCents: donationAmountCentsSchema.optional(),
          /**
           * The unit price the buyer was shown for each picked seat. An
           * ASSERTION, never charged from: a mismatch with the price checkout
           * resolves refuses the order (`seat_price_changed`, see
           * `_shared/seat-quotes.ts`). Optional per seat.
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
  /** Must be true when the event has a waiver template assigned. */
  waiverAccepted: z.boolean().optional(),
  /** Must be true — buyer must accept the platform ToS before an order is persisted. */
  termsAccepted: z.boolean().optional(),
  /** Must be true — buyer must explicitly acknowledge the refund policy. */
  refundPolicyAccepted: z.boolean().optional(),
  /** Server-observed client IP, supplied by trusted transports only. */
  requestIp: z.string().trim().min(1).max(128).nullable().optional(),
  /** Server-observed user agent, supplied by trusted transports only. */
  requestUserAgent: z.string().max(1024).nullable().optional(),

  // Attribution fields (optional)
  ref: z.string().uuid().optional(),
  utmSource: z.string().max(100).optional(),
  utmMedium: z.string().max(100).optional(),
  utmCampaign: z.string().max(200).optional(),
  checkoutArtistSelection: z.string().max(100).optional(),
  /**
   * Internal surface policy. When false Stripe offers card only (wallets ride
   * on `card`). Every caller today leaves it on. The owner turned Amazon Pay
   * and Cash App Pay off in Stripe on 2026-10-13 (reversing the 2026-10-12
   * ruling that added them for the embed), so the processor no longer
   * requests any redirect wallet and this flag now gates only bank debit,
   * which `allowBankDebit` below also gates.
   */
  allowRedirectPaymentMethods: z.boolean().default(true),
  /**
   * Internal surface policy. When false the PaymentIntent leaves bank debits
   * (ACH Direct Debit) off. The embed guest checkout sets it false: the
   * owner never ruled ACH in for the embed, so the embed offers card only
   * (Link and wallets ride on card; Amazon Pay and Cash App are off in
   * Stripe since 2026-10-13).
   */
  allowBankDebit: z.boolean().default(true),
  /**
   * Internal surface policy. When false the buyer's account platform credit
   * is never read or redeemed: no `platform_credit` item, `creditAppliedCents`
   * 0, and the PaymentIntent is the full chargeable amount. The embed guest
   * checkout sets this false — an unauthenticated guest pays full price;
   * credit is spent only on the signed-in main checkout (owner ruling
   * 2026-10-03).
   */
  applyPlatformCredit: z.boolean().default(true),
});

export const createCheckoutOutputSchema = z.object({
  orderId: z.uuid(),
  clientSecret: z.string().min(1).nullable(),
  amountGrossCents: z.number().int(),
  feesPlatformCents: z.number().int(),
  buyerFeesCents: z.number().int(),
  /**
   * Processor fee in cents. For a PASS_THROUGH Stripe charge this is the
   * grossed-up fee actually added to the PaymentIntent and funded by the buyer;
   * for ABSORB it is the display-only estimate (NOT charged on top); for a
   * fully credit-covered order it is 0 (no Stripe charge).
   */
  processorFeeCents: z.number().int().nonnegative(),
  /**
   * Effective fee mode for this order. In PASS_THROUGH the displayed total
   * includes the platform + processor fee the buyer funds; in ABSORB it does
   * not. The web client reads this to render the buyer-facing total correctly.
   */
  feeMode: feeModeSchema,
  taxAmountCents: z.number().int(),
  /** Platform credit auto-applied to this order, in cents (>= 0). Reduces the buyer's charge. */
  creditAppliedCents: z.number().int().nonnegative().default(0),
  holdExpiresAt: z.string().datetime().nullable(),
  /**
   * Platform fee forgone to a fee waiver on THIS order, in cents — what the
   * reservation actually got. The held step priced a waiver from the
   * allowance it saw; another buyer can take the last allowance ticket
   * between hold and charge, so once this order exists the page reads this
   * figure, not the hold's lines. Optional: a replayed result stored before
   * the field existed has none.
   */
  feeWaivedCents: z.number().int().nonnegative().optional(),
});

export type CreateCheckoutInput = z.infer<typeof createCheckoutInputSchema>;
export type CreateCheckoutOutput = z.infer<typeof createCheckoutOutputSchema>;

export type CreateCheckoutDeps = {
  repos: Repos;
  payments: PaymentProcessorPort;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Sentry reporter for deliberate swallows (splits, the sales-window guard,
   * …). NOT the fee-waiver reservation any more: it runs on the checkout
   * transaction, so its failures propagate instead of being swallowed there.
   */
  reportError?: ReporterPort;
  /**
   * Tax provider port (ZipTax). Optional — used only for the last-chance
   * admission-tax lookup when an event was never stamped at publish time.
   */
  taxRateLookup?: TaxRateLookupPort | null;
  /**
   * Multi-channel notification dispatcher. Optional — forwarded to the
   * inline-completion paths (free claim + fully credit-covered) so the buyer
   * gets a fire-and-forget in-app confirmation, matching the paid path.
   */
  notify?: NotifyFn;
  /** When true, settlements are scheduled for immediate payout (dev/test only). */
  devInstantPayouts?: boolean;
  /**
   * Best-effort hook invoked when settlement creation fails for a fully
   * credit-covered order (which has no PaymentIntent and therefore no
   * webhook retry). Errors thrown here are swallowed.
   */
  onSettlementFailure?: (ctx: { orderId: string; error: string }) => void;
};

interface StoredCheckoutRecord {
  payloadHash: string;
  response: CreateCheckoutOutput;
}

type PayeeSubject = GetPayeeBySubjectInput;

/**
 * `rawServerContext` is the server-only side channel
 * (`_shared/checkout-server-context.ts`): what a server caller knows about
 * this checkout that a client must never be able to say. It is a separate
 * argument, not an input field, so a transport that spreads a client's body
 * into `rawInput` cannot carry it.
 */
export async function createCheckout(
  deps: CreateCheckoutDeps,
  rawInput: unknown,
  rawServerContext: CheckoutServerContext = {},
): Promise<CreateCheckoutOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "createCheckout" });

  const execute = async () => {
    const input = parseInput(createCheckoutInputSchema, rawInput);
    const serverContext = parseInput(
      checkoutServerContextSchema,
      rawServerContext,
    );

    // Defense-in-depth: the transport layer already pins buyerHumanId to the
    // session actor, but we enforce it here too so no caller (webhook,
    // script, future transport) can attribute an order to someone else.
    if (input.buyerHumanId !== input.actorHumanId) {
      throw fail("BUYER_MUST_BE_ACTOR");
    }

    // ── Terms of Service gate (before idempotency.get) ──────────
    if (input.termsAccepted !== true) {
      throw fail("TERMS_REQUIRED");
    }

    // ── Refund policy gate (before idempotency.get) ──────────
    if (input.refundPolicyAccepted !== true) {
      throw fail("REFUND_POLICY_REQUIRED");
    }

    const promoCodes = preparePromoCodes(input.promoCodes);

    // Currency is derived from the event (stamped at publish time from the
    // organizer's Stripe Connect account). We resolve it inside the tx to
    // avoid a separate round-trip here.

    const payloadHash = buildPayloadHash(input, promoCodes);
    const idempotencyKey = buildIdempotencyKey(
      input.actorHumanId,
      input.clientKey,
    );

    const replay =
      await deps.idempotency.get<StoredCheckoutRecord>(idempotencyKey);
    if (replay) {
      if (replay.payloadHash !== payloadHash) {
        throw fail("IDEMPOTENCY_KEY_CONFLICT");
      }
      return replay.response;
    }

    const ownerToken = crypto.randomUUID();
    const claimed = await deps.idempotency.begin(
      idempotencyKey,
      IDEMPOTENCY_TTL_SECONDS,
      ownerToken,
    );
    if (!claimed) {
      const afterWait =
        await deps.idempotency.get<StoredCheckoutRecord>(idempotencyKey);
      if (afterWait) {
        if (afterWait.payloadHash !== payloadHash) {
          throw fail("IDEMPOTENCY_KEY_CONFLICT");
        }
        return afterWait.response;
      }
      throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
    }

    let result: CreateCheckoutOutput;
    try {
      result = await createCheckoutInternal(
        deps,
        scopedLogger,
        input,
        promoCodes,
        idempotencyKey,
        serverContext,
      );
    } catch (error) {
      // Release, not `fail`: the adapters keep a `failed` record for 15
      // minutes and refuse `begin` while it lives, which would lock the
      // buyer's retry out (idempotency-claim.ts). By here the order has been
      // unwound, so a retry under the same key starts clean.
      await abandonClaim(deps.idempotency, idempotencyKey, ownerToken, error, {
        useCase: "createCheckout",
        logger: scopedLogger,
        reportError: deps.reportError,
      });
      throw asKnownError("create_checkout", error);
    }

    // Outside the abandon path: the order is committed and linked, so a
    // `commit` that throws leaves the claim in place rather than freeing the
    // key for a retry that would price a second order beside this one.
    await deps.idempotency.commit<StoredCheckoutRecord>(idempotencyKey, {
      payloadHash,
      response: result,
    });

    return result;
  };

  if (scopedLogger) {
    return scopedLogger.withTime("createCheckout", execute);
  }

  return execute();
}

async function createCheckoutInternal(
  deps: CreateCheckoutDeps,
  logger: LoggerPort | undefined,
  input: CreateCheckoutInput,
  promoCodes: PromoCodeEntry[],
  checkoutIdempotencyKey: string,
  serverContext: CheckoutServerContext,
): Promise<CreateCheckoutOutput> {
  const now = deps.clock.now();

  // ── Shared preparation (single transaction) ───────────────────────
  // Compute the order total once and branch based on whether it's free.
  // For free orders we delegate to claimFreeTickets; for paid orders we
  // continue with seat holds + Stripe PI creation.
  const prep = await deps.repos.tx(async (tx) => {
    const event = await ensureEventOnSale(tx, input.eventId, now);

    // FR-003/FR-012 (community-managed-event-listings): RSVP events have no
    // ticket types, orders, or money paths — reject checkout outright.
    if (event.attendanceMode === "RSVP") {
      throw fail("EVENT_NOT_TICKETED");
    }

    await ensureBuyerMayEnterEvent(
      tx,
      event,
      input.buyerHumanId,
      serverContext,
    );

    // ── Waiver gate ─────────────────────────────────────────────
    if (event.waiverTemplateId && input.waiverAccepted !== true) {
      throw fail("WAIVER_REQUIRED");
    }

    // `listTicketTypes` returns EVERY status — admin surfaces need the
    // unpublished ones — so the sellable set is narrowed HERE, not in the
    // adapter. Sellable = `status === "ACTIVE"`: the same rule the public
    // page (`listEventTicketTypes`), the card tiers, the pricing estimate and
    // the POS listing display, so what can be bought is exactly what is
    // shown. A DRAFT (archived or unpublished) type named by id falls out of this list, so the map
    // below and the capacity gate both refuse it as `ticket_type_not_found`
    // (money audit 2026-09-08 #14).
    const ticketTypes = (await tx.events.listTicketTypes(event.id)).filter(
      (tt) => tt.status === "ACTIVE",
    );

    if (ticketTypes.length === 0) {
      throw fail("NO_TICKET_TYPES");
    }

    const ticketTypeMap = new Map<string, TicketTypeSummary>(
      ticketTypes.map((tt) => [
        tt.id,
        {
          id: tt.id,
          priceCents: tt.priceCents,
          pricingMode: tt.pricingMode ?? "FIXED",
          minimumCents: tt.minimumCents ?? null,
          seatSectionId: tt.seatSectionId ?? null,
          // Raw schedule, not a pre-resolved price — computeOrderAmounts
          // resolves it at the order's single `now` (FR-005/FR-003).
          scheduledPriceCents: tt.scheduledPriceCents,
          scheduledPriceAt: tt.scheduledPriceAt,
          // Raw window — enforced by computeOrderAmounts at the same `now`
          // (FR-014). Passed through rather than pre-checked here so the
          // refusal lives in exactly one place.
          salesOpenAt: tt.salesOpenAt,
          salesCloseAt: tt.salesCloseAt,
        },
      ]),
    );

    const aggregatedItems = aggregateItems(input.items);
    const agreementContext = await loadAgreementContext(tx, event.id, now, {
      logger: deps.logger,
      reportError: deps.reportError,
    });
    // Per-seat prices route too: a $0 tier with a $10 seat is a paid order.
    const seatPrices = await readSeatPriceOverrides(tx, {
      eventId: event.id,
      items: aggregatedItems,
    });
    const orderComputation = computeOrderAmounts(
      aggregatedItems,
      ticketTypeMap,
      agreementContext,
      { now, reportError: deps.reportError, seatPrices },
    );
    // A stale seat quote refuses here, before either path settles a carried
    // cart or looks up tax. Each path checks again on its own read.
    assertSeatQuotesMatch(
      orderComputation.items,
      collectSeatQuotes(input.items),
      ticketTypeMap,
    );

    // Membership benefits resolve here too, so a member's 100%-off benefit
    // routes to the free path the same way a typed 100% code does.
    const memberGrants = await resolveMemberBenefits(tx, {
      memberHumanId: input.buyerHumanId,
      event,
      now,
    });

    // The cart this checkout supersedes, when the buyer carries one (the web
    // client sends `pendingOrderId` on every Pay click after the first). Its
    // promo holds are still PENDING at this point — retirement happens inside
    // the path this probe selects — and the stats count live holds, so
    // without the exclusion a buyer's OWN hold on a 1-per-person code fills
    // the cap and every capped-code checkout refuses on Pay. Same ownership
    // predicate as `createPaidCheckout` / `claimFreeTickets` (buyer + event +
    // PENDING): an unvalidated id must not hide a stranger's hold. This is a
    // routing probe only; the selected path re-evaluates after retiring the
    // cart and `createHolds` re-checks under its lock with NO exclusion.
    const priorCart = input.pendingOrderId
      ? await tx.orders.getById(input.pendingOrderId)
      : null;
    const carriedOverCartId =
      priorCart &&
      priorCart.buyerHumanId === input.buyerHumanId &&
      priorCart.eventId === input.eventId &&
      priorCart.status === "PENDING"
        ? priorCart.id
        : undefined;

    const promoEvaluation = await evaluatePromoApplications({
      codes: promoCodes,
      tx,
      event,
      buyerHumanId: input.buyerHumanId,
      now,
      orderSubtotalCents: orderComputation.amountGrossCents,
      ticketLines: orderComputation.ticketLines,
      memberGrants,
      excludeOrderId: carriedOverCartId,
      ...(deps.logger ? { logger: deps.logger } : {}),
    });

    const amountGrossAfterDiscount =
      orderComputation.amountGrossCents - promoEvaluation.totalDiscountCents;

    // A scheduled price change (FR-005) is evaluated at read time, so in
    // principle a flip can land between this routing probe and the path it
    // selects — both of which read the clock independently. Both directions
    // fail SAFE with a named error and move no money: free→paid surfaces
    // ORDER_NOT_FREE from claimFreeTickets, paid→free surfaces
    // EXPECTED_PAID_ORDER from createPaidCheckout (before any credit is
    // debited). Same shape as the existing membership-lapse race documented
    // in claim-free-tickets; the buyer retries and gets the current price.
    return {
      isFree: amountGrossAfterDiscount <= 0,
      appliedDiscountCount: promoEvaluation.applications.length,
    };
  });

  if (prep.isFree) {
    // Observability, not a gate. Discounts stack across sources, so a typed
    // code the owner marked `stackable` plus a member benefit can land exactly
    // on zero — at which point the free path waives the PLATFORM fee too. That
    // is intended (it is how "members get in free" works), but it is also the
    // kind of thing an owner discovers from a payout rather than a decision,
    // and reconstructing it after the fact is impossible without a line here.
    // One discount reaching zero is ordinary; MORE than one is the case worth
    // being able to answer questions about.
    if (prep.appliedDiscountCount > 1) {
      logger?.info("checkout.free_order_via_combined_discounts", {
        eventId: input.eventId,
        buyerHumanId: input.buyerHumanId,
        appliedDiscountCount: prep.appliedDiscountCount,
      });
    }
    return claimFreeTickets(
      {
        repos: deps.repos,
        clock: deps.clock,
        logger,
        notify: deps.notify,
        reportError: deps.reportError,
        // Only for cancelling a superseded cart's PaymentIntent, which
        // claimFreeTickets settles itself before its transaction (this route
        // settles nothing, so the cart is settled exactly once). A free claim
        // never creates one.
        payments: deps.payments,
      },
      input,
      promoCodes,
      logger,
      serverContext,
    );
  }

  return createPaidCheckout(
    deps,
    logger,
    input,
    promoCodes,
    checkoutIdempotencyKey,
    serverContext,
  );
}

// ── Paid checkout (existing flow) ───────────────────────────────────────────

async function createPaidCheckout(
  deps: CreateCheckoutDeps,
  logger: LoggerPort | undefined,
  input: CreateCheckoutInput,
  promoCodes: PromoCodeEntry[],
  checkoutIdempotencyKey: string,
  serverContext: CheckoutServerContext,
): Promise<CreateCheckoutOutput> {
  const now = deps.clock.now();
  // The tax self-heal stamp is recorded inside the transaction and written
  // after it commits (a swallowed failed write inside would condemn it).
  const taxAfterCommit = newCheckoutTaxAfterCommit();
  // The tax-provider lookup (a live HTTP call on a cache miss) runs HERE,
  // before the transaction, never while it holds row locks. Inside, only the
  // prepared result is used.
  const preparedTax = await prepareCheckoutTax(
    {
      repos: deps.repos,
      taxRateLookup: deps.taxRateLookup,
      clock: deps.clock,
      reportError: deps.reportError,
    },
    input.eventId,
    logger,
  );

  // ── Superseded cart: settle its PaymentIntent BEFORE the transaction ──
  // Cancelling (and, if needed, reading back) the carried-over cart's PI is
  // up to two Stripe round-trips. They run with no transaction open; the
  // transaction only does the database half of the retirement, and only if
  // the cart still carries exactly the PI settled. If it gained a different
  // PI in between (the buyer's other tab linking its checkout), the
  // transaction rolls back and the new PI is settled before one rerun — see
  // `withSettledCarriedOverCart`.
  const runCheckoutTx = <T>(
    fn: Parameters<typeof withSettledCarriedOverCart<T>>[2],
  ): Promise<T> =>
    withSettledCarriedOverCart(
      { repos: deps.repos, logger, caller: "createCheckout" },
      () =>
        settleCarriedOverCartForCheckout(
          deps,
          logger,
          input,
          now,
          serverContext,
        ),
      fn,
    );

  const {
    order,
    promoEvaluation,
    holdExpiresAt,
    buyerFeesCents,
    processorFeeCents,
    feeMode,
    taxAmountCents,
    creditAppliedCents,
    ticketsIssued,
    eventTitle,
    feeWaivedCents,
    pendingPayment,
    organiserCreditUnknown,
  } = await runCheckoutTx(async (tx, carriedOverSettle, mayRetry) => {
    const event = await ensureEventOnSale(tx, input.eventId, now);
    const currency = event.currency ?? "usd";
    const statementDescriptorSuffix = buildStatementDescriptorSuffix(
      event.title,
      event.id,
    );
    const refundPolicySnapshot = getCurrentRefundPolicySnapshot();
    await ensureBuyerMayEnterEvent(
      tx,
      event,
      input.buyerHumanId,
      serverContext,
    );

    // ── Waiver gate ─────────────────────────────────────────────
    if (event.waiverTemplateId && input.waiverAccepted !== true) {
      throw fail("WAIVER_REQUIRED");
    }

    const agreementContext = await loadAgreementContext(tx, event.id, now, {
      logger: deps.logger,
      reportError: deps.reportError,
    });
    // `listTicketTypes` returns EVERY status — admin surfaces need the
    // unpublished ones — so the sellable set is narrowed HERE, not in the
    // adapter. Sellable = `status === "ACTIVE"`: the same rule the public
    // page (`listEventTicketTypes`), the card tiers, the pricing estimate and
    // the POS listing display, so what can be bought is exactly what is
    // shown. A DRAFT (archived or unpublished) type named by id falls out of this list, so the map
    // below and the capacity gate both refuse it as `ticket_type_not_found`
    // (money audit 2026-09-08 #14).
    const ticketTypes = (await tx.events.listTicketTypes(event.id)).filter(
      (tt) => tt.status === "ACTIVE",
    );

    if (ticketTypes.length === 0) {
      throw fail("NO_TICKET_TYPES");
    }

    const ticketTypeMap = new Map<string, TicketTypeSummary>(
      ticketTypes.map((tt) => [
        tt.id,
        {
          id: tt.id,
          priceCents: tt.priceCents,
          pricingMode: tt.pricingMode ?? "FIXED",
          minimumCents: tt.minimumCents ?? null,
          seatSectionId: tt.seatSectionId ?? null,
          // Raw schedule, not a pre-resolved price — computeOrderAmounts
          // resolves it at the order's single `now` (FR-005/FR-003).
          scheduledPriceCents: tt.scheduledPriceCents,
          scheduledPriceAt: tt.scheduledPriceAt,
          // Raw window — enforced by computeOrderAmounts at the same `now`
          // (FR-014). Passed through rather than pre-checked here so the
          // refusal lives in exactly one place.
          salesOpenAt: tt.salesOpenAt,
          salesCloseAt: tt.salesCloseAt,
        },
      ]),
    );

    const aggregatedItems = aggregateItems(input.items);
    // Each requested seat's override, read unlocked so the cart can be priced
    // before the capacity lock. Used by BOTH waiver passes below (R-001: the
    // ladder the reservation is handed must carry the same per-seat prices
    // the charge does) and made binding by `holdSeatsForCheckout`, which
    // re-reads the seats FOR UPDATE and refuses `seat_price_changed`.
    const seatPrices = await readSeatPriceOverrides(tx, {
      eventId: event.id,
      items: aggregatedItems,
    });
    let orderComputation = computeOrderAmounts(
      aggregatedItems,
      ticketTypeMap,
      agreementContext,
      { now, reportError: deps.reportError, seatPrices },
    );
    // The buyer's quoted seat prices must be the priced ones (D-007), checked
    // before any hold, reservation or PaymentIntent so a refusal rolls back
    // with nothing left behind. Never charged from.
    assertSeatQuotesMatch(
      orderComputation.items,
      collectSeatQuotes(input.items),
      ticketTypeMap,
    );

    // ── Prior cart carry-over ──────────────────────────────────────────
    // Resolved ONCE, because three things below need the same answer: the
    // capacity gate must not count this cart's hold against the buyer who
    // owns it, its seats must be released before the re-hold, and its
    // fee-waiver allowance must be back BEFORE this order looks one up.
    // Ownership is checked here (buyer + event + PENDING) — an unvalidated
    // id would let a buyer discount a stranger's hold and oversell past it.
    const priorCart = input.pendingOrderId
      ? await tx.orders.getById(input.pendingOrderId)
      : null;
    const carriedOverCart =
      priorCart &&
      priorCart.buyerHumanId === input.buyerHumanId &&
      priorCart.eventId === input.eventId &&
      priorCart.status === "PENDING"
        ? priorCart
        : null;

    // ── Retire the superseded cart ─────────────────────────────────────
    // Excluding it from the capacity gate below only stops it blocking THIS
    // buyer; the row keeps its `meta.holdExpiresAt` and goes on consuming a
    // unit for every OTHER buyer until the 15-minute TTL. Since the web client
    // sends `pendingOrderId` on every cart-based checkout, leaving it PENDING
    // makes small tiers look half-sold-out under ordinary traffic.
    //
    // The superseded PaymentIntent was cancelled BEFORE this transaction
    // (`settleCarriedOverCartForCheckout`); this de-holds only if that worked —
    // a still-confirmable PI on de-held inventory is the charge-with-no-ticket
    // bug again. See `retire-carried-over-cart.ts` for the full reasoning. The
    // cancel CAS also requires the cart to still carry the PI that was
    // settled: a cart read with no PI can gain one in the meantime (checkout
    // links its PaymentIntent after commit), and that one was never cancelled.
    //
    // ORDERING: this runs BEFORE the fee-waiver reservation on purpose. The
    // superseded cart holds the buyer's waiver allowance (`ticketsUsed` was
    // bumped when it was quoted). If it were retired after this order's
    // `resolveApplicable`, a decline-then-retry with a 1-ticket allowance
    // would see an exhausted waiver, bake the full fee into the new
    // PaymentIntent, and only then hand the allowance back — for some later
    // order.
    //
    // The same argument holds for platform CREDIT, which checkout SPENDS
    // (`redeemConditional` debits the balance) rather than holds: the
    // superseded cart's `UserCreditRedemption` rows are released inside
    // retirement, and that has to land BEFORE the `listActiveForHuman`
    // snapshot below or the retry cannot apply the credit it just got back.
    //
    // LOCKS. Retirement takes row locks on Order, PromoHold, FeeWaiver /
    // FeeWaiverRedemption, and UserCredit / UserCreditRedemption (the credit
    // release is `FOR UPDATE`). None of that disturbs the capacity-before-
    // seats order below, and it MATCHES a plain checkout by the same buyer on
    // another device: that path also locks FeeWaiver (`reserve`) and
    // UserCredit (`redeemConditional`, via `applyAvailableCredits`) ahead of
    // `assertTicketTypeCapacity`. Do not move the credit release after the
    // capacity gate — that would put UserCredit AFTER capacity on this path
    // and BEFORE it on the plain path, which is a deadlock, and it would also
    // land after the snapshot. Within UserCredit, the release locks credits
    // in `listActiveForHuman` order for the same reason (see the adapter).
    //
    // The cost of settling first: `cancelPaymentIntent` is a network call
    // and does not roll back with the transaction. Any throw from here on
    // (promo_not_found / promo_max_redeemed / promo_min_order_not_met,
    // CREDIT_BALANCE_CHANGED, EXPECTED_PAID_ORDER, STRIPE_NOT_CONNECTED, the
    // chargeback-terms refusal, capacity, seats) rolls back `cancelPendingOrder` and leaves the
    // prior cart PENDING with a cancelled PI until the next attempt or the
    // reaper retires it. That is the safe direction: a cancelled PI cannot
    // charge, and the next attempt re-retires it via the
    // `retrievePaymentIntent` → "canceled" path in the helper.
    //
    // `now` is deliberately NOT forwarded (the credit release uses the
    // adapter's clock), matching what the in-transaction helper did before
    // the settle moved out.
    //
    // `retireSettledCarriedOverCart` also re-reads the cart when it was not
    // retired: if it now carries a PaymentIntent other than the one settled
    // (the other tab's checkout linked one after the settle read the cart),
    // that PI was never cancelled, so it throws to roll back and re-settle
    // (`withSettledCarriedOverCart`); on the last attempt it leaves the cart
    // live and reports it.
    const retiredCarriedOverCart = await retireSettledCarriedOverCart(
      tx,
      carriedOverCart,
      carriedOverSettle,
      mayRetry,
      { caller: "createCheckout", logger, reportError: deps.reportError },
    );

    // ── Promo codes and membership benefits ────────────────────────────
    // Membership-granted promos join the same evaluation as typed codes —
    // one pipeline, one PromoHold/PromoRedemption ledger. Resolution runs
    // inside this tx so entitlement and application see the same snapshot.
    //
    // ORDERING: evaluated BEFORE the fee waiver, from the first pass above. A
    // discount is computed on ticket prices alone (never on a fee), so it does
    // not need the waiver; the waiver does need the discount, because a ticket
    // a discount brings down to $0 pays no platform fee (owner ruling
    // 2026-10-10) and so must be off the ladder the reservation is priced
    // against. These are reads: no lock is taken here, so the waiver →
    // capacity → seats lock order below is unchanged. Still AFTER the retired
    // cart above, whose promo holds must be released before its codes are
    // counted again.
    const memberGrants = await resolveMemberBenefits(tx, {
      memberHumanId: input.buyerHumanId,
      event,
      now,
    });

    const promoEvaluation = await evaluatePromoApplications({
      codes: promoCodes,
      tx,
      event,
      buyerHumanId: input.buyerHumanId,
      now,
      orderSubtotalCents: orderComputation.amountGrossCents,
      ticketLines: orderComputation.ticketLines,
      memberGrants,
      ...(deps.logger ? { logger: deps.logger } : {}),
    });

    // Re-price with the discounts, so a ticket they bring down to $0 carries
    // no platform fee. Same `now`, same seat prices: only fees can differ
    // from the first pass, never a price (which is what the discounts and the
    // seat quotes above were checked against).
    const { ticketDiscounts } = promoEvaluation;
    if (ticketDiscounts.length > 0) {
      orderComputation = computeOrderAmounts(
        aggregatedItems,
        ticketTypeMap,
        agreementContext,
        {
          now,
          reportError: deps.reportError,
          seatPrices,
          discounts: ticketDiscounts,
        },
      );
    }

    // ── Fee waiver ──────────────────────────────────────────────────────
    // The order id is minted HERE rather than just before `createPending` so a
    // waiver reservation can be keyed to this order before the row exists.
    // `FeeWaiverRedemption.orderId` is deliberately not a foreign key for
    // exactly this reason.
    //
    // Two-pass by necessity: the pass above prices the tickets so we know what
    // each waived ticket is worth; the reservation tells us how much allowance
    // we actually got; the next pass re-prices with the waiver applied so the
    // processor gross-up below is solved against the real, reduced base.
    const orderId = crypto.randomUUID();
    const feeWaiver = await reserveFeeWaiverForCheckout({
      tx,
      event,
      orderId,
      buyerHumanId: input.buyerHumanId,
      computation: orderComputation,
      now,
      logger,
    });

    if (feeWaiver.waivedTickets > 0) {
      // Same `now` as the first pass — a flip landing between the passes
      // must not reprice the order underneath the waiver reservation.
      orderComputation = computeOrderAmounts(
        aggregatedItems,
        ticketTypeMap,
        agreementContext,
        {
          now,
          waivedTickets: feeWaiver.waivedTickets,
          reportError: deps.reportError,
          seatPrices,
          ...(ticketDiscounts.length > 0 ? { discounts: ticketDiscounts } : {}),
        },
      );
    }

    // ── Tax calculation ────────────────────────────────────────────────
    // Tax is venue-based: the rate is normally stamped on the Event at publish
    // time from the location's cached Ziptax lookup. If that stamp is missing
    // (publish-time lookup silently failed), use the best-effort last-chance
    // lookup prepared before this transaction; the self-heal stamp is
    // written after this transaction commits. A provider miss yields 0; a repo fault is reported and
    // rethrown (it would otherwise price the order at $0 tax).
    const stripeTaxCalculationId: string | null = null;

    const taxResolution: CheckoutTaxResolution = await resolveCheckoutTax(
      {
        taxRateLookup: deps.taxRateLookup,
        clock: deps.clock,
        reportError: deps.reportError,
      },
      tx,
      event,
      logger,
      taxAfterCommit,
      preparedTax,
    );
    // Point-in-time situs snapshot (§5.2): freeze the VENUE jurisdiction that
    // determined this order's tax so historical rollups stay stable even if
    // the venue is later edited. Stamped on the order below.
    const taxSitus = taxResolution.situs;
    const taxRateSource = taxResolution.rateSource;

    // This path should only be reached for paid orders. The routing layer
    // delegates free orders to claimFreeTickets before we get here. Guard
    // BEFORE pricing (so a misrouted free order surfaces as this, not as
    // whatever the tax solve would say about it) and before touching credits
    // (so it never debits one).
    if (
      orderComputation.amountGrossCents - promoEvaluation.totalDiscountCents <=
      0
    ) {
      throw fail("EXPECTED_PAID_ORDER");
    }

    // ── Price the cart (face, platform fee, tax lines, processor fee) ──
    // THE shared pipeline (`_shared/price-cart.ts`); the door prices through
    // the same function. Pure: every input was resolved above. In
    // PASS_THROUGH the buyer funds the processor's fee, solved jointly with
    // the tax (circular under a `BUYER_TOTAL` base such as TN). The
    // grossed-up fee is added BEFORE credit is applied so credit is
    // subtracted last. `buyerFeesCents` is the platform fee only.
    const priced = priceComputedCart({
      channel: "ONLINE",
      computation: orderComputation,
      payoutTerms: agreementContext,
      now,
      promo: promoEvaluation,
      taxImpositions: taxResolution.impositions,
    });
    const amountGrossAfterDiscount = priced.amountGrossCents;
    const finalBuyerFeesCents = priced.buyerFeesCents;

    // ── Platform credit auto-apply ─────────────────────────────────────
    // Apply the buyer's active platform-funded credits against the
    // post-promo ticket subtotal. Credits reduce ONLY the buyer's charge
    // (the Stripe PaymentIntent) — they do NOT change order.amountGrossCents,
    // so organiser settlement / entitlement (amountGrossCents in full, via
    // computeAgreementBasis) is unaffected. The platform absorbs the
    // cost out of its margin. Credits are consumed soonest-expiry-first.
    //
    // Before applying, cap the credit so the buyer's remaining charge is
    // either exactly 0 (completed via the zero-charge path below, no
    // PaymentIntent) or at least the processor minimum. This prevents a
    // credit from leaving a tiny positive charge (e.g. 20¢) that Stripe would
    // reject and hard-fail an otherwise legitimate checkout. Any un-applied
    // remainder stays on the buyer's credit balance for next time.
    const taxAmountCents = priced.taxAmountCents;
    const grossedUpProcessorFeeCents = priced.processorFeeCents;
    const chargeableBeforeCreditCents = priced.chargeTotalCents;

    // `applyPlatformCredit: false` (the embed guest checkout) skips the whole
    // block: no snapshot, no redemption, so the charge below is the full
    // chargeable amount and the order can never be credit-covered.
    let creditApplications: CreditApplication[] = [];
    // Set when the Ready gate already ran ahead of the credit debit (the
    // credit-covered case below); the gate's usual site reuses it.
    let payeeReadiness: PayeeReadiness | null = null;
    if (input.applyPlatformCredit) {
      const creditSnapshot = await tx.credits.listActiveForHuman({
        humanId: input.buyerHumanId,
        currency,
      });
      const totalAvailableCreditCents = creditSnapshot.reduce(
        (sum, credit) => sum + credit.balanceCents,
        0,
      );
      // Credits offset only the ticket subtotal, never fees or tax.
      const desiredCreditCents = Math.min(
        totalAvailableCreditCents,
        amountGrossAfterDiscount,
      );
      const prospectiveChargeCents =
        chargeableBeforeCreditCents - desiredCreditCents;

      // ── Ready gate, ahead of the debit, for a credit-covered order ─────
      // Credit about to cover the whole charge means this order completes in
      // this transaction with no PaymentIntent, so the organiser's payee must
      // be Ready exactly as for a card payment (owner ruling 2026-10-11).
      // This is the first point where "credit covers it" is known, and it is
      // BEFORE `applyAvailableCredits`, so a refusal debits nothing and takes
      // no UserCredit lock. The database writes above (the retired cart's
      // rows, the fee-waiver reservation) are undone by the rollback, as on
      // every other refusal in this transaction; the superseded cart's
      // PaymentIntent cancel is NOT (see "The cost of settling first" above).
      // Reads only: the lock order is unchanged.
      // A card or part-credit order does NOT take this branch — its gate
      // stays at its old place below, so its error precedence is unchanged.
      if (prospectiveChargeCents === 0) {
        payeeReadiness = await ensureStripeConnectedForPaidCheckout(tx, event);
      }

      let creditCapCents: number;
      if (
        prospectiveChargeCents === 0 ||
        prospectiveChargeCents >= STRIPE_MIN_CHARGE_CENTS
      ) {
        creditCapCents = desiredCreditCents;
      } else {
        // Applying the full credit would leave a sub-minimum positive charge.
        // Cap so the remaining charge is exactly the processor minimum.
        creditCapCents = Math.max(
          0,
          chargeableBeforeCreditCents - STRIPE_MIN_CHARGE_CENTS,
        );
      }

      creditApplications = await applyAvailableCredits({
        tx,
        buyerHumanId: input.buyerHumanId,
        currency,
        maxRedeemableCents: creditCapCents,
      });
    }
    const totalCreditAppliedCents = creditApplications.reduce(
      (sum, application) => sum + application.amountUsedCents,
      0,
    );

    const paymentIntentAmountCents =
      chargeableBeforeCreditCents - totalCreditAppliedCents;

    if (paymentIntentAmountCents < 0) {
      // Unreachable: applied credit is capped at the chargeable amount.
      // Defensive guard against a future regression in the cap math.
      throw fail("NON_POSITIVE_AMOUNT");
    }

    if (
      paymentIntentAmountCents > 0 &&
      paymentIntentAmountCents < STRIPE_MIN_CHARGE_CENTS
    ) {
      // A concurrent drain of the buyer's own credit (between the snapshot
      // read and the atomic debit) left the charge in the sub-minimum band.
      // Throwing rolls the transaction back — including the credit debit — so
      // the buyer can retry cleanly instead of hitting a Stripe rejection.
      throw fail("CREDIT_BALANCE_CHANGED");
    }

    // Version-agnostic backstop: the strict current-version gate lives at
    // Stripe Connect onboarding (see lib/payments/chargeback-terms.ts). A
    // terms version bump must never hard-fail checkout on live paid events;
    // only an owner with NO acceptance at all is refused here.
    await requireAnyChargebackTermsForRiskOwner({
      repos: tx,
      owner: deriveChargebackTermsRiskOwner(event),
    });

    // Each consumed credit becomes a negative `platform_credit` line. These
    // are excluded from settlement (settlement only sums `ticket` items and
    // is basis'd on amountGrossCents), so they reduce the buyer's charge
    // without touching organiser payout.
    const creditItems: OrderComputation["items"] = creditApplications.map(
      (application) => ({
        kind: "platform_credit",
        ticketTypeId: undefined,
        qty: 1,
        unitPriceCents: -application.amountUsedCents,
        amountCents: -application.amountUsedCents,
        meta: {
          creditId: application.creditId,
          sourceType: application.sourceType,
          reason: application.reason,
          appliedCreditCents: application.amountUsedCents,
        },
      }),
    );

    // `priced.items` = ticket items (each `meta.buyerTotalCents` already
    // carries its share of the grossed-up processor fee, so
    // computeExpectedPaymentAmount(order) — the finalize AMOUNT_MISMATCH guard
    // — sums to the PI amount) followed by the promo discount items. Credit
    // lines go last.
    const orderItems: OrderComputation["items"] = [
      ...priced.items,
      ...creditItems,
    ];

    // A fully credit-covered order never touches Stripe, so it must carry no
    // processor fee in its buyer totals. Unreachable: credit offsets only the
    // ticket subtotal (`desiredCreditCents` <= amountGrossAfterDiscount), so a
    // positive processor fee always leaves at least that much to charge.
    // Refused rather than committed if the cap math ever regresses.
    if (paymentIntentAmountCents === 0 && grossedUpProcessorFeeCents > 0) {
      throw fail("INTERNAL", {
        message: `credit_covered_order_with_processor_fee: ${grossedUpProcessorFeeCents}`,
      });
    }

    // Stamped from the SAME `now` that `holdSeatsForCheckout` writes the seat
    // `updatedAt` with, a few statements below and in this transaction.
    // `resolveSeatHoldFence` inverts this (`holdExpiresAt − TTL`) to recover
    // when this cart took its seats, so the two must stay in step — see the
    // "KEEP THE TWO IN STEP" note in `_shared/cart-seat-release.ts`.
    const holdExpiresAt = new Date(
      now.getTime() + ORDER_HOLD_TTL_SECONDS * 1000,
    );
    for (const item of orderItems) {
      if (item.kind !== "ticket") {
        continue;
      }
      const meta = (item.meta ?? {}) as Record<string, unknown>;
      meta.holdExpiresAt = holdExpiresAt.toISOString();
      item.meta = meta;
    }

    // ── Capacity gate (PRE-CHARGE) ─────────────────────────────────────
    // The PaymentIntent is created right after this transaction commits,
    // from the amount priced here. Until this gate existed the only
    // inventory check on this path was `mintTickets`, which runs in the
    // payment_intent.succeeded webhook — i.e. after the buyer's card is
    // charged. A tier that filled up mid checkout therefore produced a real
    // charge and no ticket.
    //
    // Placed BEFORE the seat release/hold below so the capacity lock is
    // always acquired ahead of any Seat lock, matching startPosSale. The two
    // paths locking these in opposite orders is a deadlock.
    //
    // The exclusion is gated on the RETIREMENT VERDICT, exactly as the seat
    // release below is. Excluding the carried-over cart is only sound once
    // that cart is dead: retirement declines when its PaymentIntent SUCCEEDED
    // or is still processing (and on a Stripe blip, or with no processor at
    // all), and a declined cart still owns its reservation — it will mint
    // tickets against its own lines. Discounting its qty here would let this
    // order take the very stock that order is about to claim: on a GA tier
    // (no `seatSectionId`, so the seat gate below is a no-op for it) that is a
    // second live PaymentIntent for the last ticket — the buyer charged twice
    // and the tier oversold.
    await assertTicketTypeCapacity(tx, {
      requests: aggregatedItems.map((item) => ({
        ticketTypeId: item.ticketTypeId,
        qty: item.qty,
      })),
      ticketTypesById: new Map(ticketTypes.map((tt) => [tt.id, tt] as const)),
      now,
      excludeOrderId:
        carriedOverCart && retiredCarriedOverCart ? carriedOverCart.id : null,
    });

    // ── Release seats held by a prior updateOrderItems call ────────────
    // The buyer's pending cart order may have already held seats; release
    // them so the re-hold below doesn't reject HELD seats as unavailable.
    //
    // ONLY when that order was actually retired. If retirement declined — its
    // PaymentIntent succeeded or is still processing — the order is live and
    // will mint tickets against these exact seats (`mintTicketsForOrder` reads
    // `meta.seatIds`). Handing them to the new order would double-assign them.
    // The new checkout then fails on `seat_unavailable`, which is the correct
    // outcome: the buyer has already paid for these seats.
    if (carriedOverCart && retiredCarriedOverCart) {
      const previousSeatIds = carriedOverCart.items
        .filter((item) => item.kind === "ticket")
        .flatMap((item) => extractSeatIdsFromMeta(item.meta));
      if (previousSeatIds.length > 0) {
        // Fenced to the carried-over cart's OWN hold. Retirement proves its
        // ORDER is dead; it proves nothing about who holds its seats. That
        // cart can be up to the cart TTL (1200s) old while the seat-hold TTL
        // is 900s, so the seat reaper may already have freed these seats and
        // another buyer may be holding — or have PAID for — one. Releasing
        // that seat under their live PaymentIntent sells it twice.
        // See `resolveSeatHoldFence` for why the fence is derived from
        // `meta.holdExpiresAt` rather than `occurredAt`.
        const heldBefore = resolveSeatHoldFence(carriedOverCart);

        if (heldBefore) {
          await tx.seats.releaseSeats({
            seatIds: previousSeatIds,
            releasedAt: now,
            heldBefore,
          });
        } else {
          // Unreachable through the Prisma repo (`occurredAt` is NOT NULL and
          // always mapped). Reported rather than released unfenced: an
          // ownership-blind release is the double-sell above, and the seat
          // reaper frees these seats anyway. The re-hold below then refuses
          // with `seat_unavailable`, which is the honest answer.
          logger?.error("create_checkout_seat_fence_missing", {
            orderId: carriedOverCart.id,
            seatCount: previousSeatIds.length,
          });
          reportBestEffort(
            deps.reportError,
            new Error("create_checkout_seat_fence_missing"),
            {
              tags: {
                area: "checkout",
                step: "releaseCarriedOverSeats",
                useCase: "createCheckout",
              },
              extra: {
                orderId: carriedOverCart.id,
                seatCount: previousSeatIds.length,
              },
            },
          );
        }
      }
    }

    const seatHolds = await holdSeatsForCheckout(tx, {
      eventId: event.id,
      items: aggregatedItems,
      ticketTypeMap,
      now,
      ttlSeconds: SEAT_HOLD_TTL_SECONDS,
      seatPrices,
    });

    if (seatHolds.size > 0) {
      // Track per-ticketType seat index so each per-ticket OrderItem
      // (qty=1) receives only its own seat, not the full hold list.
      const seatIndexByType = new Map<string, number>();

      for (const item of orderItems) {
        if (item.kind !== "ticket") {
          continue;
        }
        const ticketTypeId = item.ticketTypeId ?? null;
        if (!ticketTypeId) {
          continue;
        }
        const hold = seatHolds.get(ticketTypeId);
        if (!hold || hold.seatIds.length === 0) {
          continue;
        }
        const idx = seatIndexByType.get(ticketTypeId) ?? 0;
        seatIndexByType.set(ticketTypeId, idx + 1);

        const meta = (item.meta ?? {}) as Record<string, unknown>;
        const seatId = heldSeatIdForItem(meta, hold, idx);
        if (!seatId) {
          continue;
        }

        meta.seatIds = [seatId];
        meta.seatHoldExpiresAt = hold.expiresAt.toISOString();
        item.meta = meta;
      }
    }

    // FR-003 (organiser-resale-share): each ticket records the event's resale
    // clause in force at this sale, read in this transaction beside the
    // primary terms `loadAgreementContext` read above.
    const resaleClause = await resolveTicketResaleClause(tx, event);
    const order = await tx.orders.createPending({
      id: orderId,
      eventId: event.id,
      buyerHumanId: input.buyerHumanId,
      amountGrossCents: amountGrossAfterDiscount,
      feesPlatformCents: priced.feesPlatformCents,
      taxAmountCents,
      currency,
      feePolicySnapshot: priced.feePolicySnapshot,
      source: "PRIMARY",
      nonRefundable: priced.nonRefundable,
      items: stampTicketResaleClause(orderItems, resaleClause),
      billingAddressLine1: input.billingAddress?.line1 ?? null,
      billingAddressLine2: input.billingAddress?.line2 ?? null,
      billingCity: input.billingAddress?.city ?? null,
      billingState: input.billingAddress?.state ?? null,
      billingPostalCode: input.billingAddress?.postalCode ?? null,
      billingCountry: input.billingAddress?.country ?? null,
      stripeTaxCalculationId,
      taxSitusCountry: taxSitus?.countryCode ?? null,
      taxSitusState: taxSitus?.region ?? null,
      taxSitusPostal: taxSitus?.postalCode ?? null,
      taxRateSource,
      termsVersion: CURRENT_BUYER_TERMS_VERSION,
      termsAcceptedAt: now,
      billingDescriptor: statementDescriptorSuffix,
      refundPolicyAckAt: now,
      refundPolicyAckIp: input.requestIp ?? null,
      checkoutIp: input.requestIp ?? null,
      refundPolicyVersion: refundPolicySnapshot.version,
      refundPolicyText: refundPolicySnapshot.text,
    });

    // ── Per-imposition tax breakdown (OrderTaxLine) ────────────────────
    // Same transaction as the order row, from the SAME solve that produced
    // `taxAmountCents` above, so Σ PLATFORM lines === taxAmountCents by
    // construction (asserted by `priceComputedCart`). The situs rules
    // are derived live and cannot be re-derived later — these rows are the
    // only record of what this order was charged, line by line.
    const taxLines = priced.orderTaxLines;
    if (taxLines.length > 0) {
      await tx.orders.createTaxLines({ orderId: order.id, lines: taxLines });
    }

    // ── Human-keyed acceptance ledger (idempotent per human + version) ─
    // The Order stamps above remain the per-purchase source of truth; these
    // GLOBAL-scope rows answer "has this human accepted the current ToS /
    // refund policy?" without scanning orders. recordAcceptance is a no-op
    // when a current-version row already exists.
    for (const documentType of ["BUYER_TERMS", "REFUND_POLICY"] as const) {
      await recordAcceptance({
        repos: tx,
        humanId: input.buyerHumanId,
        documentType,
        scopeType: "GLOBAL",
        scopeId: null,
        acceptedAt: now,
        ipAddress: input.requestIp ?? null,
        userAgent: input.requestUserAgent ?? null,
      });
    }

    await createPromoHolds(tx.promos, promoEvaluation.applications, {
      orderId: order.id,
      buyerHumanId: input.buyerHumanId,
      now,
    });

    // ── Platform credit redemptions ───────────────────────────────────
    // Record one redemption row per consumed credit. The balance debit was
    // already performed atomically by applyAvailableCredits (via the
    // conditional redeemConditional UPDATE); this only writes the audit-trail
    // link, which the FK requires the order to exist first. recordRedemption
    // is idempotent on (creditId, orderId) so retries that re-enter this
    // transaction (same order) do not write duplicate rows.
    for (const application of creditApplications) {
      await tx.credits.recordRedemption({
        creditId: application.creditId,
        orderId: order.id,
        amountCents: application.amountUsedCents,
      });
    }

    if (totalCreditAppliedCents > 0) {
      await tx.audit.log({
        entity: "order",
        entityId: order.id,
        action: "platform_credit_applied",
        data: {
          totalCreditAppliedCents,
          creditIds: creditApplications.map(
            (application) => application.creditId,
          ),
        },
        at: now,
      });
    }

    // ── Ready gate (organiser's payee) ─────────────────────────────────
    // ONE gate for every order that reaches this function, and it sits ABOVE
    // the zero-charge completion: a credit-covered order owes the organiser
    // its full face value, so it needs a payee that can be paid just as a
    // card payment does (owner ruling 2026-10-11). Until then the zero-charge
    // block returned before this ran, spending the buyer's credit and minting
    // tickets for an organiser a card payment would have been refused for.
    //
    // A credit-covered order normally arrives with the gate already passed
    // (`payeeReadiness`, checked before its credit was debited); this call is
    // then skipped. For a card or part-credit order it runs here, which is
    // where it always ran — nothing sits between here and its old line but
    // the zero-charge block those orders skip. A throw rolls the whole
    // transaction back: the pending order, promo holds, credit debit and
    // redemption rows, fee-waiver reservation and seat holds.
    const { destinationAccountId } =
      payeeReadiness ?? (await ensureStripeConnectedForPaidCheckout(tx, event));

    // ── Zero-charge completion (fully credit-covered order) ────────────
    // When applied credit covers the entire chargeable amount, there is
    // nothing left to charge — Stripe must NOT receive a 0¢ (or rejected
    // sub-minimum) PaymentIntent. Complete the order as SUCCEEDED in this
    // same transaction, mirroring claimFreeTickets: mark succeeded, mint
    // tickets, confirm promo holds, record attribution. The credit
    // redemptions above are preserved and the organiser's entitlement
    // (amountGrossCents) is unchanged — the platform funds the difference.
    // Only reached with a Ready payee (the gate above).
    if (paymentIntentAmountCents === 0) {
      await tx.orders.markSucceeded(order.id);

      const fullOrder = await tx.orders.getById(order.id);
      if (!fullOrder) {
        throw fail("ORDER_NOT_FOUND");
      }
      fullOrder.status = "SUCCEEDED";

      const mintResult = await mintTicketsForOrder(tx, {
        order: fullOrder,
        issuedAt: now,
        actor: { kind: "system", reason: "credit_covered_order" },
      });

      // Promo holds were created above (createPromoHolds). Confirm them now
      // since the order is settling immediately rather than awaiting payment.
      if (promoEvaluation.applications.length > 0) {
        await tx.promos.confirmHoldsForOrder({
          orderId: order.id,
          confirmedAt: now,
        });
      }

      await tx.audit.log({
        entity: "order",
        entityId: order.id,
        action: "credit_covered_order_claimed",
        data: {
          eventId: event.id,
          buyerHumanId: input.buyerHumanId,
          amountGrossCents: amountGrossAfterDiscount,
          feesPlatformCents: priced.feesPlatformCents,
          currency,
          creditAppliedCents: totalCreditAppliedCents,
          ticketsIssued: mintResult.count,
          items: orderItems,
        },
        at: now,
      });

      await tx.audit.log({
        entity: "order",
        entityId: order.id,
        action: "order.terms_accepted",
        data: {
          actorHumanId: input.actorHumanId,
          termsVersion: CURRENT_BUYER_TERMS_VERSION,
        },
        at: now,
      });

      if (mintResult.count > 0) {
        await tx.audit.log({
          entity: "ticket",
          entityId: null,
          action: "issued",
          data: { orderId: order.id, count: mintResult.count },
          at: now,
        });
      }

      // ── Organiser settlement splits (full agreement basis) ──────────
      // A fully credit-covered order still owes the organiser its full
      // ticket money (`amountGrossCents`, read through the order's own
      // snapshot like any other order) — the platform funds the buyer's
      // credit out of its own balance. Because there is no PaymentIntent, the
      // payment_intent.succeeded webhook never fires, so the OrderSplits
      // that finalizePaymentIntent would normally write must be created
      // here. Settlements are created after this tx commits (below).
      const basisCents = computeAgreementBasis(fullOrder);
      const splitsResult = computeOrderSplits({
        amountCents: basisCents,
        lines: agreementContext.lines,
      });

      // Same guard as `finalizePaymentIntent`: an all-capped line set whose
      // caps fall short of 100% writes split rows that do not add up to the
      // basis, and every downstream check (credits, ledger invariants) reads
      // those same short rows, so nothing else can ever notice. Report and
      // continue — the buyer's credits are already spent by this point.
      if (splitsResult.unallocatedCents !== 0) {
        const splitsErr = new Error(
          `order splits do not sum to the basis: ${splitsResult.unallocatedCents}c unallocated`,
        );
        logger?.error("createCheckout.splits_short_of_basis", {
          orderId: order.id,
          eventId: event.id,
          basisCents,
          splitsTotalCents: splitsResult.totalCents,
          unallocatedCents: splitsResult.unallocatedCents,
          err: splitsErr,
        });
        reportBestEffort(deps.reportError, splitsErr, {
          tags: {
            useCase: "createCheckout",
            reason: "splits_short_of_basis",
          },
          extra: {
            orderId: order.id,
            eventId: event.id,
            basisCents,
            splitsTotalCents: splitsResult.totalCents,
            unallocatedCents: splitsResult.unallocatedCents,
          },
        });
      }

      await tx.splits.upsertForOrder(order.id, splitsResult.splits);

      await tx.audit.log({
        entity: "order_split",
        entityId: order.id,
        action: "created",
        data: {
          count: splitsResult.splits.length,
          totalCents: splitsResult.totalCents,
        },
        at: now,
      });

      await recordAttribution(
        tx,
        {
          eventId: event.id,
          orderId: order.id,
          buyerHumanId: input.buyerHumanId,
          ref: input.ref,
          utmSource: input.utmSource,
          utmMedium: input.utmMedium,
          utmCampaign: input.utmCampaign,
          checkoutArtistSelection: input.checkoutArtistSelection,
          billingCity: input.billingAddress?.city,
          billingState: input.billingAddress?.state,
          billingCountry: input.billingAddress?.country,
        },
        logger,
      );

      return {
        order,
        pendingPayment: null,
        promoEvaluation,
        holdExpiresAt,
        buyerFeesCents: finalBuyerFeesCents,
        // Fully credit-covered orders never touch Stripe — no processor fee.
        processorFeeCents: 0,
        feeMode: priced.effectiveFeeMode,
        taxAmountCents,
        creditAppliedCents: totalCreditAppliedCents,
        ticketsIssued: mintResult.count,
        eventTitle: event.title,
        feeWaivedCents: priced.feesWaivedCents,
        organiserCreditUnknown: hasUnknownOrganiserCredit(
          fullOrder.feePolicySnapshot,
        ),
      };
    }

    // ── Stripe PaymentIntent ──────────────────────────────────────────
    // `destinationAccountId` comes from the Ready gate above the zero-charge
    // block.
    const paymentMetadata: Record<string, string> = {
      orderId: order.id,
      eventId: event.id,
      buyerHumanId: input.buyerHumanId,
      source: "primary",
      currency,
    };
    // Server-only keys (the embed an embed order was made through). Never
    // from `input`: see `_shared/checkout-server-context.ts`.
    applyCheckoutServerContextToMetadata(paymentMetadata, serverContext);

    // Dashboard/exports summary. TICKET lines only — the negative `discount`
    // and `platform_credit` lines ride the same `orderItems` array and must
    // not inflate the count. (Donations are NOT a line kind; they ride ON a
    // ticket line as `donationAmountCents`, so they are already counted
    // correctly by counting tickets.) Zero — which a paid Stripe path should
    // never reach — drops the quantity segment rather than rendering
    // "0 tickets".
    const ticketQuantity = orderItems.reduce(
      (sum, item) => (item.kind === "ticket" ? sum + item.qty : sum),
      0,
    );
    const paymentDescription = buildPaymentDescription({
      eventTitle: event.title,
      orderId: order.id,
      ticketQuantity,
      kind: "primary",
    });

    if (taxAmountCents > 0) {
      paymentMetadata.taxAmountCents = `${taxAmountCents}`;
      if (stripeTaxCalculationId) {
        paymentMetadata.stripeTaxCalculationId = stripeTaxCalculationId;
      }
    }

    if (promoEvaluation.applications.length > 0) {
      // Derived from the APPLIED discounts, not the typed input: membership
      // grants apply with no typed code and must still be visible here, so
      // they carry the same `benefit:{id}` marker the ledger records.
      paymentMetadata.promoCodes = promoEvaluation.applications
        .map(applicationLedgerCode)
        .join(",");
      paymentMetadata.discountTotalCents = `${promoEvaluation.totalDiscountCents}`;
    }

    // Donation / non-refundable metadata
    if (priced.nonRefundable) {
      paymentMetadata.nonRefundable = "true";
    }
    const donationItems = input.items.filter(
      (i) => i.donationAmountCents && i.donationAmountCents > 0,
    );
    if (donationItems.length > 0) {
      paymentMetadata.donationTotalCents = `${donationItems.reduce((s, i) => s + (i.donationAmountCents ?? 0) * i.qty, 0)}`;
    }

    // Attribution metadata — forwarded to finalizePaymentIntent via PI metadata
    if (input.ref) paymentMetadata.ref = input.ref;
    if (input.utmSource) paymentMetadata.utmSource = input.utmSource;
    if (input.utmMedium) paymentMetadata.utmMedium = input.utmMedium;
    if (input.utmCampaign) paymentMetadata.utmCampaign = input.utmCampaign;
    if (input.checkoutArtistSelection)
      paymentMetadata.checkoutArtistSelection = input.checkoutArtistSelection;

    // ── The PaymentIntent is created AFTER this transaction commits ────
    // Never inside it: the Stripe call can take tens of seconds, and this
    // transaction holds the capacity lock, seat holds, credit and fee-waiver
    // row locks and a pooled connection under a 30s budget (a slow Stripe
    // used to expire the transaction at `linkPaymentIntent`). Everything the
    // request needs is fixed here, from the same snapshot that priced the
    // order. See `createAndLinkPaymentIntent`.
    //
    // The Stripe idempotency key is PER ORDER, not per client key. Every
    // attempt mints a fresh order id, and that id rides in the metadata, so
    // a client-key-only key made a same-key retry after Stripe had created
    // the PI (lost response, timeout, lost link CAS) send the same key with
    // different parameters: Stripe answers `idempotency_error` and the tab is
    // stuck until reload. Keyed per order, the retry gets a fresh PI; the
    // earlier attempt's PI never had its client secret issued, so nobody can
    // confirm it, and the unwind cancels it when its id is known.
    const pendingPayment: PendingCheckoutPayment = {
      request: {
        amountCents: paymentIntentAmountCents,
        currency,
        metadata: paymentMetadata,
        idempotencyKey: `pi:${checkoutIdempotencyKey}:${order.id}`,
        destinationAccountId,
        allowRedirectPaymentMethods: input.allowRedirectPaymentMethods,
        allowBankDebit: input.allowBankDebit,
        statementDescriptorSuffix,
        description: paymentDescription,
      },
      eventId: event.id,
      now,
      // `paymentIntentId` is added once the PaymentIntent exists; every
      // other field is what this transaction priced and wrote.
      pendingCreatedAuditData: {
        eventId: event.id,
        buyerHumanId: input.buyerHumanId,
        amountGrossCents: amountGrossAfterDiscount,
        feesPlatformCents: priced.feesPlatformCents,
        taxAmountCents,
        currency,
        items: orderItems,
        promos: promoEvaluation.applications.map(describeApplicationForAudit),
        discountTotalCents: promoEvaluation.totalDiscountCents,
        billingAddress: input.billingAddress ?? null,
        stripeTaxCalculationId,
      },
    };

    return {
      order,
      pendingPayment,
      promoEvaluation,
      holdExpiresAt,
      buyerFeesCents: finalBuyerFeesCents,
      // PASS_THROUGH: the grossed-up fee actually charged to the buyer.
      // ABSORB: the display-only estimate (not added to the PaymentIntent).
      processorFeeCents: priced.processorFeeDisplayCents,
      feeMode: priced.effectiveFeeMode,
      taxAmountCents,
      creditAppliedCents: totalCreditAppliedCents,
      // Paid orders mint tickets later via finalizePaymentIntent (webhook /
      // client-confirm), so no in-app confirmation fires from here.
      ticketsIssued: 0,
      eventTitle: event.title,
      feeWaivedCents: priced.feesWaivedCents,
      // Splits are written at finalize on this path, which does its own check.
      organiserCreditUnknown: false,
    };
  });

  // ── PaymentIntent: created and linked with no transaction open ─────
  // The order (and every hold it took) is committed above. On any failure
  // from here to the link, `createAndLinkPaymentIntent` cancels the PI and
  // hands all of it back before rethrowing.
  const paymentIntent = pendingPayment
    ? await createAndLinkPaymentIntent(deps, logger, {
        orderId: order.id,
        actorHumanId: input.actorHumanId,
        pending: pendingPayment,
      })
    : null;

  await applyCheckoutTaxSelfHeal(
    { repos: deps.repos, reportError: deps.reportError },
    taxAfterCommit,
    logger,
  );

  const isCreditCovered = paymentIntent === null;

  // A snapshot with an `organiserCredit` value we do not know is a new sale
  // mis-stamped, credited price minus fee. Reported after the commit so a
  // rolled-back checkout never reports splits that were not written.
  if (organiserCreditUnknown) {
    const creditErr = new Error(
      "order carries an unknown organiserCredit marker; credited price minus fee",
    );
    logger?.error("createCheckout.organiser_credit_unknown", {
      orderId: order.id,
      eventId: input.eventId,
      err: creditErr,
    });
    reportBestEffort(deps.reportError, creditErr, {
      tags: {
        useCase: "createCheckout",
        reason: "organiser_credit_unknown",
      },
      extra: { orderId: order.id, eventId: input.eventId },
    });
  }

  logger?.info("createPaidCheckout.succeeded", {
    orderId: order.id,
    paymentIntentId: paymentIntent?.id ?? null,
    creditCovered: isCreditCovered,
    amountGrossCents: order.amountGrossCents,
    currency: order.currency,
    promoDiscountCents: promoEvaluation.totalDiscountCents,
    promoCount: promoEvaluation.applications.length,
  });

  // ── Ledger credits for fully credit-covered orders ─────────────────
  // A credit-covered order has no PaymentIntent and therefore no
  // payment_intent.succeeded webhook to drive ledger-credit creation. The
  // OrderSplits were written inside the tx above; write the SETTLEMENT_CREDIT
  // entries here, after the tx commits (createCreditsFromOrder reads the
  // committed splits in its own transaction). Mirrors finalizePaymentIntent
  // so the organiser is paid the same way a charged order pays them.
  if (isCreditCovered) {
    try {
      const creditResult = await createCreditsFromOrder(
        {
          repos: deps.repos,
          clock: deps.clock,
          instantPayouts: deps.devInstantPayouts,
        },
        { orderId: order.id },
      );
      logger?.info("createPaidCheckout.ledger_credits_created", {
        orderId: order.id,
        creditEntryIds: creditResult.credits.map((c) => c.entryId),
        skippedZeroAmount: creditResult.skippedZeroAmount,
      });
    } catch (err) {
      // Do NOT silently lose the organiser's money: log loudly, report to
      // Sentry, and surface via the failure hook. Credits can be re-driven
      // later via the settlements.createFromOrder mutation (idempotent keys).
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger?.error("createPaidCheckout.ledger_credits_failed", {
        orderId: order.id,
        error: errorMsg,
      });
      try {
        // Deliberate swallow → must reach Sentry (CLAUDE.md error-reporting
        // convention), guarded so a throwing reporter never changes behaviour.
        deps.reportError?.(err, {
          tags: { useCase: "createCheckout", step: "createLedgerCredits" },
          extra: { orderId: order.id },
        });
      } catch {
        /* swallow */
      }
      try {
        deps.onSettlementFailure?.({ orderId: order.id, error: errorMsg });
      } catch {
        /* swallow */
      }
    }

    // ── Buyer in-app confirmation (fire-and-forget) ───────────────────
    // A fully credit-covered order mints tickets inline (no PaymentIntent →
    // no finalizePaymentIntent / webhook), so the buyer would otherwise get
    // tickets but no in-app confirmation — inconsistent with paid orders.
    // Uses the SAME idempotency key (order-confirmed:${orderId}) as the
    // finalize path so a later finalize/webhook for this order can't
    // double-fire. The buyer paid 0 out of pocket (credit covered the full
    // chargeable amount). Guest / POS_WALKUP buyers are skipped inside
    // notifyBuyer; failures never propagate.
    if (ticketsIssued > 0) {
      await notifyBuyer(
        {
          repos: deps.repos,
          notify: deps.notify,
          logger,
          reportError: deps.reportError,
        },
        {
          buyerHumanId: input.buyerHumanId,
          variant: "order.confirmed",
          payload: {
            orderId: order.id,
            eventId: input.eventId,
            eventTitle,
            ticketCount: ticketsIssued,
            amountCents: 0,
            currency: order.currency,
          },
          idempotencyKey: `order-confirmed:${order.id}`,
        },
      );
    }
  }

  return createCheckoutOutputSchema.parse({
    orderId: order.id,
    clientSecret: paymentIntent?.clientSecret ?? null,
    amountGrossCents: order.amountGrossCents,
    feesPlatformCents: order.feesPlatformCents,
    buyerFeesCents,
    // A fully credit-covered order never touches Stripe, so there is no
    // processor fee and no pending hold to expire.
    processorFeeCents: isCreditCovered ? 0 : processorFeeCents,
    feeMode,
    taxAmountCents,
    creditAppliedCents,
    holdExpiresAt: isCreditCovered ? null : holdExpiresAt.toISOString(),
    feeWaivedCents,
  });
}

type CreatePaymentIntentRequest = Parameters<
  PaymentProcessorPort["createPaymentIntent"]
>[0];
type CreatedPaymentIntent = Awaited<
  ReturnType<PaymentProcessorPort["createPaymentIntent"]>
>;

/**
 * Everything the checkout transaction fixed for the PaymentIntent that is
 * created after it commits: the exact request, and the `pending_created`
 * audit payload minus the PI id.
 */
interface PendingCheckoutPayment {
  request: CreatePaymentIntentRequest;
  eventId: string;
  /** The checkout's bound clock instant (audit `at`, unwind clock). */
  now: Date;
  pendingCreatedAuditData: {
    eventId: string;
    buyerHumanId: string;
    amountGrossCents: number;
    feesPlatformCents: number;
    taxAmountCents: number;
    currency: string;
    items: OrderComputation["items"];
    promos: ReturnType<typeof describeApplicationForAudit>[];
    discountTotalCents: number;
    billingAddress: CreateCheckoutInput["billingAddress"] | null;
    stripeTaxCalculationId: string | null;
  };
}

/**
 * The pre-transaction settle for createCheckout: the shared one
 * (`_shared/settle-carried-over-cart-before-tx.ts`) with createCheckout's
 * event-level refusals run before it.
 */
function settleCarriedOverCartForCheckout(
  deps: CreateCheckoutDeps,
  logger: LoggerPort | undefined,
  input: CreateCheckoutInput,
  now: Date,
  serverContext: CheckoutServerContext,
): Promise<SettledCarriedOverCart | null> {
  return settleCarriedOverCartBeforeTx(
    {
      repos: deps.repos,
      payments: deps.payments,
      logger,
      reportError: deps.reportError,
      caller: "createCheckout",
      // Refuse BEFORE cancelling the other tab's PaymentIntent, not after.
      // The shared-prep transaction already ran these, but the tax lookup
      // sits between it and here; if sales closed or the event was
      // unpublished in that gap, the main transaction would refuse AFTER
      // this settle had killed a live PI. Same checks, same `now` as the
      // transaction (which re-runs them), read without one. What remains is
      // the gap between here and the transaction's own check — the settle
      // itself (docs/decisions/create-checkout-payment-intent-outside-tx.md).
      beforeSettle: async () => {
        const event = await ensureEventOnSale(deps.repos, input.eventId, now);
        await ensureBuyerMayEnterEvent(
          deps.repos,
          event,
          input.buyerHumanId,
          serverContext,
        );
        if (event.waiverTemplateId && input.waiverAccepted !== true) {
          throw fail("WAIVER_REQUIRED");
        }
      },
    },
    input,
  );
}

/**
 * Creates the checkout's PaymentIntent and links it to the committed PENDING
 * order, with no transaction open across the Stripe call.
 *
 * The link is a CAS (`linkPaymentIntentIfPending`): between the commit and
 * here the order is visible as a PENDING row with no PI, and the buyer's other
 * tab can retire it (Resume → `pendingOrderId`) or release it. A PI linked to
 * an order that has already handed its holds back would be a charge with no
 * ticket, so a lost CAS cancels the PI and fails the checkout instead.
 *
 * On ANY failure before the link lands, the order is unwound
 * (`unwindUnlinkedCheckoutOrder`) and the original error rethrown, so the
 * caller's `abandonClaim` frees the client key for a retry that finds its
 * seats, promo codes, fee waiver and credit back where they were.
 */
async function createAndLinkPaymentIntent(
  deps: CreateCheckoutDeps,
  logger: LoggerPort | undefined,
  ctx: {
    orderId: string;
    actorHumanId: string;
    pending: PendingCheckoutPayment;
  },
): Promise<CreatedPaymentIntent> {
  const { orderId, pending } = ctx;
  let created: CreatedPaymentIntent | null = null;
  let linkLost = false;

  try {
    const paymentIntent = await callOrDependencyFailed(
      () => deps.payments.createPaymentIntent(pending.request),
      logger,
      { action: "create_payment_intent", orderId, eventId: pending.eventId },
    );
    created = paymentIntent;

    const linked = await deps.repos.tx(async (tx) => {
      const didLink = await tx.orders.linkPaymentIntentIfPending(
        orderId,
        paymentIntent.id,
      );
      if (!didLink) return false;

      const audit = pending.pendingCreatedAuditData;
      await tx.audit.log({
        entity: "order",
        entityId: orderId,
        action: "pending_created",
        data: {
          eventId: audit.eventId,
          buyerHumanId: audit.buyerHumanId,
          amountGrossCents: audit.amountGrossCents,
          feesPlatformCents: audit.feesPlatformCents,
          taxAmountCents: audit.taxAmountCents,
          currency: audit.currency,
          paymentIntentId: paymentIntent.id,
          items: audit.items,
          promos: audit.promos,
          discountTotalCents: audit.discountTotalCents,
          billingAddress: audit.billingAddress,
          stripeTaxCalculationId: audit.stripeTaxCalculationId,
        },
        at: pending.now,
      });

      await tx.audit.log({
        entity: "order",
        entityId: orderId,
        action: "order.terms_accepted",
        data: {
          actorHumanId: ctx.actorHumanId,
          termsVersion: CURRENT_BUYER_TERMS_VERSION,
        },
        at: pending.now,
      });

      return true;
    });

    if (!linked) {
      // Retired, released or reaped between the commit and the link. Whoever
      // cancelled it handed its holds back; the unwind below cancels the PI
      // and records the abandonment (`link_lost`).
      linkLost = true;
      throw fail("ORDER_NOT_PENDING");
    }

    return paymentIntent;
  } catch (err) {
    await unwindUnlinkedCheckoutOrder(deps, logger, {
      orderId,
      eventId: pending.eventId,
      paymentIntentId: created?.id ?? null,
      now: pending.now,
      reason: linkLost ? "link_lost" : "payment_intent_not_linked",
    });
    throw err;
  }
}

/**
 * Unwinds a checkout whose order committed but whose PaymentIntent never got
 * linked. Every step is best-effort and swallows its own error — the caller is
 * already rethrowing the failure that explains what went wrong — and every
 * swallow is reported.
 *
 *  1. Cancel the PaymentIntent, if one was created. Its client secret never
 *     left the server, so nobody can confirm it; cancelling is hygiene, and
 *     also stops `finalizePaymentIntent` ever relinking it via metadata. When
 *     creation itself failed there may still be a PI at Stripe whose response
 *     was lost — unlinked, secret never issued, so it cannot charge; the
 *     `dependency_failed` error log carries the order id to reconcile by.
 *  2. Cancel the order (CAS on PENDING) and hand back what the checkout
 *     transaction took: promo holds, fee-waiver allowance, SPENT platform
 *     credit (`releaseRetiredCartHolds`), and the seats it stamped HELD
 *     (fenced, like every other `releaseSeats`). Status-only CAS on purpose:
 *     the only PaymentIntent this order can ever carry is the one this request
 *     created, which step 1 just cancelled or which was never issued.
 *
 * If the unwind fails, the backstops return everything: the cart reaper
 * (`releaseExpiredCarts`) retires the PENDING order after its hold TTL and,
 * with no PI to settle, releases promo, fee-waiver and credit; the seat
 * reaper frees the seats. That is up to ~15 minutes of a buyer's own credit
 * and seats tied up, which is why the failure is reported.
 */
async function unwindUnlinkedCheckoutOrder(
  deps: CreateCheckoutDeps,
  logger: LoggerPort | undefined,
  ctx: {
    orderId: string;
    eventId: string;
    paymentIntentId: string | null;
    now: Date;
    /**
     * `link_lost`: the order was already cancelled by someone else (retire /
     * release / reaper) when the link ran, so the release CAS below matches
     * nothing — the row is still written so the order's history shows why
     * its PaymentIntent was cancelled. `payment_intent_not_linked`: creation
     * or the link write itself failed.
     */
    reason: "link_lost" | "payment_intent_not_linked";
  },
): Promise<void> {
  const { orderId, paymentIntentId, now } = ctx;

  if (paymentIntentId) {
    try {
      await deps.payments.cancelPaymentIntent({ paymentIntentId });
    } catch (err) {
      logger?.error("createCheckout.unwind_cancel_payment_intent_failed", {
        orderId,
        paymentIntentId,
        err,
      });
      reportBestEffort(deps.reportError, err, {
        tags: {
          area: "checkout",
          useCase: "createCheckout",
          step: "unwindCancelPaymentIntent",
        },
        extra: { orderId, paymentIntentId },
      });
    }
  }

  try {
    await deps.repos.tx(async (tx) => {
      const cancelled = await releaseRetiredCartHolds(tx, orderId, { now });
      if (!cancelled) {
        // Someone else cancelled it and released its holds. Nothing to hand
        // back; record why its PaymentIntent was cancelled.
        await tx.audit.log({
          entity: "order",
          entityId: orderId,
          action: "pending_abandoned",
          data: {
            eventId: ctx.eventId,
            reason: ctx.reason,
            paymentIntentId,
            cancelledHere: false,
            seatCount: 0,
          },
          at: now,
        });
        return;
      }

      const fresh = await tx.orders.getById(orderId);
      const seatIds = (fresh?.items ?? [])
        .filter((item) => item.kind === "ticket")
        .flatMap((item) => extractSeatIdsFromMeta(item.meta));

      if (fresh && seatIds.length > 0) {
        const heldBefore = resolveSeatHoldFence(fresh);
        if (heldBefore) {
          await tx.seats.releaseSeats({
            seatIds,
            releasedAt: now,
            heldBefore,
          });
        } else {
          // Unreachable through the Prisma repo (`occurredAt` is NOT NULL and
          // checkout stamps `meta.holdExpiresAt`). Reported rather than
          // released unfenced; the seat reaper frees these anyway.
          logger?.error("createCheckout.unwind_seat_fence_missing", {
            orderId,
            seatCount: seatIds.length,
          });
          reportBestEffort(
            deps.reportError,
            new Error("create_checkout_unwind_seat_fence_missing"),
            {
              tags: {
                area: "checkout",
                useCase: "createCheckout",
                step: "unwindReleaseSeats",
              },
              extra: { orderId, seatCount: seatIds.length },
            },
          );
        }
      }

      await tx.audit.log({
        entity: "order",
        entityId: orderId,
        action: "pending_abandoned",
        data: {
          eventId: ctx.eventId,
          reason: ctx.reason,
          paymentIntentId,
          cancelledHere: true,
          seatCount: seatIds.length,
        },
        at: now,
      });
    });
  } catch (err) {
    logger?.error("createCheckout.unwind_release_failed", {
      orderId,
      paymentIntentId,
      err,
    });
    reportBestEffort(deps.reportError, err, {
      tags: {
        area: "checkout",
        useCase: "createCheckout",
        step: "unwindReleaseHolds",
      },
      extra: { orderId, paymentIntentId },
    });
  }
}

interface CreditApplication {
  creditId: string;
  amountUsedCents: number;
  balanceAfterCents: number;
  sourceType: string;
  reason: string;
}

/**
 * Allocate the buyer's active platform credits against a redeemable amount
 * (capped so the remaining charge is 0 or >= the processor minimum),
 * consuming soonest-expiry-first. The repo already filters to ACTIVE,
 * unexpired, positive-balance, currency-matched credits and orders them by
 * expiry then creation.
 *
 * Each debit is performed via the atomic, conditional `redeemConditional`
 * UPDATE. The applied amount is re-derived from the row the UPDATE actually
 * touched — never the snapshot read — so two concurrent checkouts racing on
 * the same credit can never double-spend it or drive it negative: the loser
 * sees `appliedCents === 0` and moves to the next credit. The caller writes
 * the redemption rows (after the order exists) and the negative
 * `platform_credit` order lines from the returned allocations.
 */
async function applyAvailableCredits(params: {
  tx: TxRepos;
  buyerHumanId: string;
  currency: string;
  maxRedeemableCents: number;
}): Promise<CreditApplication[]> {
  const { tx, buyerHumanId, currency, maxRedeemableCents } = params;
  if (maxRedeemableCents <= 0) return [];

  const activeCredits = await tx.credits.listActiveForHuman({
    humanId: buyerHumanId,
    currency,
  });

  const applications: CreditApplication[] = [];
  let remaining = maxRedeemableCents;
  for (const credit of activeCredits) {
    if (remaining <= 0) break;
    const requestedCents = Math.min(credit.balanceCents, remaining);
    if (requestedCents <= 0) continue;

    // Atomic conditional debit. `appliedCents` reflects the actual balance
    // available at UPDATE time, not the snapshot — so a concurrent drain
    // yields 0 here and we skip this credit rather than over-applying.
    const { appliedCents, balanceAfterCents } =
      await tx.credits.redeemConditional({
        creditId: credit.id,
        requestedCents,
      });
    if (appliedCents <= 0) continue;

    applications.push({
      creditId: credit.id,
      amountUsedCents: appliedCents,
      balanceAfterCents,
      sourceType: credit.sourceType,
      reason: credit.reason,
    });
    remaining -= appliedCents;
  }
  return applications;
}

function derivePayeeSubject(event: EventRecord): PayeeSubject | null {
  if (event.orgId) {
    return { type: "ORGANIZATION", id: event.orgId } satisfies PayeeSubject;
  }
  if (event.humanId) {
    return { type: "HUMAN", id: event.humanId } satisfies PayeeSubject;
  }
  return null;
}

type PayeeReadiness = { destinationAccountId: string | undefined };

/**
 * The Ready gate: the event's payee must exist, be ACTIVE with charges and
 * payouts enabled, and carry a Connect account id, else
 * `STRIPE_NOT_CONNECTED`.
 *
 * "Paid" means the order has a price, not that a card is charged: every order
 * `createPaidCheckout` completes passes this, including one platform credit
 * covers in full (owner ruling 2026-10-11) — the organiser is owed its face
 * value either way. Only a FREE order (total $0 with no credit spent, routed
 * to `claimFreeTickets` before `createPaidCheckout`) needs no payee.
 */
async function ensureStripeConnectedForPaidCheckout(
  tx: TxRepos,
  event: EventRecord,
): Promise<PayeeReadiness> {
  const subject = derivePayeeSubject(event);
  if (!subject) {
    throw fail("STRIPE_NOT_CONNECTED");
  }

  const payeeId = await tx.payees.getBySubject(subject);
  if (!payeeId) {
    throw fail("STRIPE_NOT_CONNECTED");
  }

  const payee: PayeeRecord | null = await tx.payees.getById(payeeId.id);
  if (!payee) {
    throw fail("STRIPE_NOT_CONNECTED");
  }

  if (
    payee.status !== "ACTIVE" ||
    !payee.chargesEnabled ||
    !payee.payoutsEnabled
  ) {
    throw fail("STRIPE_NOT_CONNECTED");
  }

  const destinationAccountId =
    payee.stripeAccountId ??
    (payee.id.startsWith("acct_") ? payee.id : undefined);
  if (!destinationAccountId) {
    throw fail("STRIPE_NOT_CONNECTED");
  }

  return { destinationAccountId };
}

function buildPayloadHash(
  input: CreateCheckoutInput,
  promoCodes: PromoCodeEntry[],
): string {
  const payload = {
    actorHumanId: input.actorHumanId,
    buyerHumanId: input.buyerHumanId,
    eventId: input.eventId,
    items: input.items.map((i) => ({
      ticketTypeId: i.ticketTypeId,
      qty: i.qty,
      donationAmountCents: i.donationAmountCents,
    })),
    promoCodes: promoCodes.map((code) => code.normalized),
  };
  return JSON.stringify(payload);
}

function buildIdempotencyKey(actorHumanId: string, clientKey: string): string {
  return `checkout:${actorHumanId}:${clientKey}`;
}
