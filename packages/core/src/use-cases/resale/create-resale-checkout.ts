import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { ReporterPort } from "@th/ports/reporter";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { TaxRateLookupPort } from "@th/ports/tax-rate-lookup";
import { asKnownError } from "../../lib/errors";
import { isEventPast } from "../../lib/event-ended";
import { abandonClaim } from "../../lib/idempotency-claim";
import { callOrDependencyFailed, parseInput } from "../../lib/io";
import { recordAcceptance } from "../../lib/legal/acceptance";
import { CURRENT_BUYER_TERMS_VERSION } from "../../lib/legal/buyer-terms";
import { getCurrentRefundPolicySnapshot } from "../../lib/payments/refund-policy";
import { buildPaymentDescription } from "../../lib/payments/payment-description";
import { buildStatementDescriptorSuffix } from "../../lib/payments/statement-descriptor";
import { reportBestEffort } from "../../lib/payments/resolve-scoped-fee-policy";
import {
  computeResaleShare,
  resaleClauseFromRecord,
  type ResaleShare,
} from "../../lib/pricing/resale-pricing";
import {
  SALE_FEE_MODE,
  SALE_ORGANISER_CREDIT,
} from "../../lib/pricing/compute-ticket-price-for-agreement";
import { fail } from "@th/errors";
import type { OrderItemRecord } from "@th/types/repos/orders";
import { solveResaleCharge } from "../../lib/pricing/resale-charge";
import { toOrderTaxLineInputs } from "../orders/_shared/order-tax-lines";
import {
  applyCheckoutTaxSelfHeal,
  newCheckoutTaxAfterCommit,
  prepareCheckoutTax,
  resolveCheckoutTax,
} from "../orders/_shared/resolve-checkout-tax-rate";
import { resolvePurchasedUnitPriceCents } from "../orders/_shared/resolve-purchased-unit-price";
import { copyTicketResaleClause } from "../orders/_shared/resolve-ticket-resale-clause";

/**
 * How long `idempotency.begin` holds the client key while one attempt runs.
 * It must outlive the WORST-CASE attempt: once it lapses, a same-key request
 * runs a second attempt in parallel, and since the Stripe key is per order
 * nothing downstream would dedupe the two.
 *
 * The Stripe client is `timeout: 60_000, maxNetworkRetries: 1` (the
 * `StripeAdapter` constructor), so one Stripe call is up to 60 s × 2 = 120 s,
 * and a `repos.tx` is capped at `DEFAULT_TX_TIMEOUT_MS` = 30 s:
 *
 *   tax-provider lookup (prepareCheckoutTax)                    ~5 s
 *   checkout tx                                                 30 s
 *   createPaymentIntent                                        120 s
 *   link tx                                                     30 s
 *   tax self-heal write (one statement, no tx)             a few s
 *   unwind on failure (cancel PI + release tx)     120 + 30 = 150 s
 *                                                          ≈ 340 s
 *
 * Set to 900 s anyway, the same as `createCheckout` (orchestrator call,
 * 2026-10-04): one number for both checkout locks. A failed attempt releases
 * its claim (`abandonClaim`); only an attempt that died mid-flight (SIGTERM /
 * OOM mid-Stripe-call), or whose result could not be stored, leaves the lock
 * for the full 900 s.
 */
const IDEMPOTENCY_TTL_SECONDS = 900;
const HOLD_TTL_SECONDS = 900; // 15 minutes

// ── Schemas ────────────────────────────────────────────────────────────────

export const createResaleCheckoutInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  buyerHumanId: z.string().uuid(),
  listingId: z.string().uuid(),
  // Bounded: the Stripe idempotency key is built from it (plus ~90 chars of
  // prefix, actor and order id) and Stripe caps keys at 255 characters. An
  // over-long key would fail every retry as `dependency_failed`. Web and
  // mobile send a UUID.
  clientKey: z.string().min(8).max(128),
  /** Must be true — buyer must accept the platform ToS before an order is persisted. */
  termsAccepted: z.boolean().optional(),
  /** Must be true — buyer must explicitly acknowledge the refund policy. */
  refundPolicyAccepted: z.boolean().optional(),
  /** Server-observed client IP, supplied by trusted transports only. */
  requestIp: z.string().trim().min(1).max(128).nullable().optional(),
  /** Server-observed user agent, supplied by trusted transports only. */
  requestUserAgent: z.string().max(1024).nullable().optional(),
});

export const createResaleCheckoutOutputSchema = z.object({
  orderId: z.string().uuid(),
  clientSecret: z.string().min(1),
  amountGrossCents: z.number().int(),
  buyerFeesCents: z.number().int(),
  taxAmountCents: z.number().int(),
  holdExpiresAt: z.string().datetime(),
});

export type CreateResaleCheckoutInput = z.infer<
  typeof createResaleCheckoutInputSchema
>;
export type CreateResaleCheckoutOutput = z.infer<
  typeof createResaleCheckoutOutputSchema
>;

export type CreateResaleCheckoutDeps = {
  repos: Repos;
  payments: PaymentProcessorPort;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Tax provider port (ZipTax). Optional — used only for the last-chance
   * admission-tax lookup when the event was never stamped at publish time.
   */
  taxRateLookup?: TaxRateLookupPort | null;
  /** Forwarded so the tax resolver's deliberate swallows reach Sentry. */
  reportError?: ReporterPort;
};

interface StoredCheckoutRecord {
  payloadHash: string;
  response: CreateResaleCheckoutOutput;
}

// ── Use case ───────────────────────────────────────────────────────────────

export async function createResaleCheckout(
  deps: CreateResaleCheckoutDeps,
  rawInput: unknown,
): Promise<CreateResaleCheckoutOutput> {
  const input = parseInput(createResaleCheckoutInputSchema, rawInput);
  const logger = deps.logger?.child({ useCase: "createResaleCheckout" });

  if (input.buyerHumanId !== input.actorHumanId) {
    throw fail("BUYER_MUST_BE_ACTOR");
  }

  // ── Terms of Service gate ──────────────────────────────────────────────
  if (input.termsAccepted !== true) {
    throw fail("TERMS_REQUIRED");
  }

  // ── Refund policy gate (before idempotency.get) ───────────────────────
  if (input.refundPolicyAccepted !== true) {
    throw fail("REFUND_POLICY_REQUIRED");
  }

  const idempotencyKey = `resale-checkout:${input.actorHumanId}:${input.clientKey}`;
  const payloadHash = JSON.stringify({
    listingId: input.listingId,
    buyerHumanId: input.buyerHumanId,
  });

  // ── Idempotency ──────────────────────────────────────────────────────
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

  let result: CreateResaleCheckoutOutput;
  try {
    result = await createResaleCheckoutInternal(
      deps,
      logger,
      input,
      idempotencyKey,
    );
  } catch (error) {
    // Release, not `fail`: the adapters keep a `failed` record for 15
    // minutes and refuse `begin` while it lives, which would lock the
    // buyer's retry out (idempotency-claim.ts). By here the order has been
    // unwound and the listing handed back, so a same-key retry starts clean.
    await abandonClaim(deps.idempotency, idempotencyKey, ownerToken, error, {
      useCase: "createResaleCheckout",
      logger,
      reportError: deps.reportError,
    });
    throw asKnownError("create_resale_checkout", error);
  }

  // Outside the abandon path: the order is committed and linked, so a
  // `commit` that throws leaves the claim in place rather than freeing the
  // key for a retry that would price a second order beside this one.
  await deps.idempotency.commit<StoredCheckoutRecord>(idempotencyKey, {
    payloadHash,
    response: result,
  });

  return result;
}

// ── Internal implementation ────────────────────────────────────────────────

async function createResaleCheckoutInternal(
  deps: CreateResaleCheckoutDeps,
  logger: LoggerPort | undefined,
  input: CreateResaleCheckoutInput,
  checkoutIdempotencyKey: string,
): Promise<CreateResaleCheckoutOutput> {
  const now = deps.clock.now();
  // The tax self-heal stamp is written after the transaction commits.
  const taxAfterCommit = newCheckoutTaxAfterCommit();
  // The tax-provider lookup (live HTTP on a cache miss) runs before the
  // transaction, never while it holds the listing lock. The listing is read
  // here only for its event; the transaction re-reads it authoritatively,
  // and a missing one is refused there.
  const preTxListing = await deps.repos.resaleListings.getById(input.listingId);
  // A listing the transaction will refuse (not ACTIVE, the buyer's own, past
  // its cutoff) must not reach the paid lookup either: nothing is cached for a
  // refused attempt, so each retry would pay again. `prepareCheckoutTax` skips
  // an ended event; the transaction re-checks all of it authoritatively.
  const listingMayBeBought =
    preTxListing != null &&
    preTxListing.status === "ACTIVE" &&
    preTxListing.sellerHumanId !== input.buyerHumanId &&
    !(preTxListing.saleCutoffAt && now >= preTxListing.saleCutoffAt);
  const preparedTax =
    preTxListing && listingMayBeBought
      ? await prepareCheckoutTax(
          {
            repos: deps.repos,
            taxRateLookup: deps.taxRateLookup,
            clock: deps.clock,
            reportError: deps.reportError,
          },
          preTxListing.eventId,
          logger,
          // Resale does not refuse on event status, so the primary-sale
          // unpublished skip must not apply to it.
          { sale: "resale" },
        )
      : undefined;

  // The checkout transaction holds the listing and commits the PENDING order
  // with NO PaymentIntent; Stripe runs after it commits
  // (`createAndLinkResalePaymentIntent`). See
  // docs/decisions/create-checkout-payment-intent-outside-tx.md.
  const pending = await deps.repos.tx(async (tx): Promise<PendingResalePayment> => {
    // ── Load listing ─────────────────────────────────────────────────
    const listing = await tx.resaleListings.getById(input.listingId);
    if (!listing) {
      throw fail("LISTING_NOT_FOUND");
    }

    if (listing.status !== "ACTIVE") {
      if (listing.status === "HELD") {
        throw fail("LISTING_ALREADY_HELD");
      }
      throw fail("LISTING_NOT_ACTIVE");
    }

    // Cannot buy your own listing
    if (listing.sellerHumanId === input.buyerHumanId) {
      throw fail("CANNOT_BUY_OWN_LISTING");
    }

    // ── Point-of-sale defence: is this listing still sellable? ───────
    // An ACTIVE listing can still be unsellable: one whose `expiresAt`
    // passed but which the hourly expiry has not reached yet, one over an
    // event cancelled before `cancelOpenForEvent` closed listings with it,
    // or one whose ticket a refund voided after the listing's release read
    // it (`releaseHold` closes those it sees, under the ticket lock). Selling
    // any of them charges the buyer for a ticket finalize then refuses to
    // move (`RESALE_ORIGINAL_ITEM_REFUNDED` / `resale_listing_not_sellable`,
    // to the DLQ). All three refuse as LISTING_NOT_ACTIVE, the code the
    // resale checkout already shows "no longer available" for; `reason`
    // tells them apart. Only CANCELLED events refuse: resale deliberately
    // does not refuse on the publish state (see the tax prep above).
    if (listing.expiresAt && listing.expiresAt.getTime() <= now.getTime()) {
      throw fail("LISTING_NOT_ACTIVE", {
        meta: { listingId: listing.id, reason: "listing_expired" },
      });
    }

    // ── Load event ───────────────────────────────────────────────────
    // Deliberately NOT refused when the owner is banned (ban-that-sticks,
    // 2026-09-29): the owner ruled that existing ticket holders keep their
    // tickets, and resale is holder-to-holder, so it stays open. The
    // primary sale, RSVP, waitlist, applications, volunteer signups and saves
    // are refused (`ensureEventOnSale`, `ensureEventOpenToPublic`).
    const event = await tx.events.getById(listing.eventId);
    if (!event) {
      throw fail("EVENT_NOT_FOUND");
    }
    if (event.status === "CANCELLED") {
      throw fail("LISTING_NOT_ACTIVE", {
        meta: { listingId: listing.id, reason: "event_cancelled" },
      });
    }

    // FR-003/FR-012 (community-managed-event-listings): RSVP events have no
    // tickets, so no resale either. Unreachable in practice (no ticket → no
    // listing), but the guard keeps the money-path boundary explicit.
    if (event.attendanceMode === "RSVP") {
      throw fail("EVENT_NOT_TICKETED");
    }

    const currency = event.currency ?? "usd";
    const statementDescriptorSuffix = buildStatementDescriptorSuffix(
      event.title,
      event.id,
    );
    const refundPolicySnapshot = getCurrentRefundPolicySnapshot();

    // ── Load ticket + ticket type for price-cap, seat, and type info ─
    const ticket = listing.ticketId
      ? await tx.tickets.getById(listing.ticketId)
      : null;
    // A listed pass is LISTED from `create` until it sells or the listing
    // closes; anything else (REFUNDED by a reconcile, VALID after a close
    // the listing missed) means there is nothing to sell.
    if (!ticket || ticket.status !== "LISTED") {
      throw fail("LISTING_NOT_ACTIVE", {
        meta: {
          listingId: listing.id,
          reason: "ticket_not_listed",
          ticketStatus: ticket?.status ?? null,
        },
      });
    }
    const originalOrderId = ticket?.orderId ?? null;
    const originalOrderItemId = ticket?.orderItemId ?? null;

    let resolvedTicketTypeId: string | null = null;
    let resolvedSeatId: string | null = null;
    // Face VALUE (what the seller paid), historical only — never the live
    // type: the listing's own snapshot, else the seller's OrderItem. Kept on
    // the buyer's item for display; it prices nothing (the share does).
    let faceValueCents = listing.faceValueCents ?? null;

    if (ticket) {
      resolvedSeatId = ticket.seatId ?? null;

      if (ticket.ticketTypeId) {
        const ticketType = await tx.tickets.getTicketTypeById(
          ticket.ticketTypeId,
        );
        if (ticketType) {
          resolvedTicketTypeId = ticketType.id;
        }
      }

      if (faceValueCents == null) {
        faceValueCents = await resolvePurchasedUnitPriceCents(tx, ticket);
      }
    }

    // The item the seller holds the ticket by. Its FR-003 record prices the
    // share and is copied onto the buyer's item below.
    const sellerPurchaseItem = originalOrderItemId
      ? await tx.orderItems.getById(originalOrderItemId)
      : null;

    const price = await priceResaleCheckout(tx, {
      listing,
      event,
      sellerPurchaseItem,
      faceValueCents,
      now,
    });

    // The cutoff was snapshotted onto the listing when it was created; an
    // event moved earlier since then can end before it. A past event's
    // ticket is never sold on, whatever the snapshot says.
    if (now >= price.saleCutoffAt || isEventPast(event, now)) {
      throw fail("SALE_CUTOFF_PASSED");
    }

    // ── Hold the listing (15-min TTL) ────────────────────────────────
    const holdUntil = new Date(
      Math.min(
        now.getTime() + HOLD_TTL_SECONDS * 1000,
        price.saleCutoffAt.getTime(),
      ),
    );
    const holdResult = await tx.resaleListings.hold(
      listing.id,
      input.buyerHumanId,
      holdUntil,
    );
    if (!holdResult.ok) {
      throw fail("LISTING_ALREADY_HELD");
    }

    // ── Tax ──────────────────────────────────────────────────────────
    // Normally stamped on the Event at publish time; if that stamp is missing
    // use the best-effort last-chance lookup prepared before this
    // transaction (self-heal written after the commit). A provider miss yields 0; a repo fault is reported and
    // rethrown rather than pricing the resale at $0 tax.
    const checkoutTax = await resolveCheckoutTax(
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
      // Local impositions that do not apply to resale (Minneapolis
      // entertainment tax, owner ruling 2026-10-05) are left off.
      { sale: "RESALE" },
    );
    // A resale buyer pays the BASIS (the ask, plus the event's share when the
    // clause makes the buyer pay it), the tax, and a processing pass-through
    // (platform fee is 0 on this path — see `feesPlatformCents: 0` on the
    // order below). A buyer-paid share is taxed as part of the ticket price
    // (organiser-resale-share spec, risk 2; owner 2026-10-12, open with
    // counsel in docs/legal-and-tax-questions.md).
    //
    // THE joint solve a primary PASS_THROUGH sale uses (`solveResaleCharge`):
    // processing is grossed up over the FULL charge, tax included, so the
    // platform absorbs none of it (owner 2026-10-14, "WE DO NOT ABSORB THE
    // 2.9% PROCESSING FEE"). A BUYER_TOTAL line taxes basis + processing and
    // the two are solved to a fixed point; a TICKET_FACE line taxes the basis.
    // The rate is the fee policy the listing froze (`processingFeeConfigRef`),
    // so the listing's pre-tax figure and this charge use one rate. This
    // figure, not the listing's pre-tax `processingPassThroughCents`, is what
    // the order records (`resaleProcessingPassThroughCents`, `buyerFeesCents`)
    // and what finalize's amount check sums (`buyerTotalCents`).
    const charge = solveResaleCharge({
      basisCents: price.basisCents,
      taxLines: checkoutTax.impositions,
      processorPct: price.processorPct,
      processorFixedCents: price.processorFixedCents,
    });
    const taxSolve = charge.taxSolve;
    const taxAmountCents = charge.taxCents;
    const processingPassThroughCents = charge.processingPassThroughCents;

    const paymentIntentAmountCents = charge.totalCents;

    if (paymentIntentAmountCents <= 0) {
      throw fail("NON_POSITIVE_AMOUNT");
    }

    // ── Create order ─────────────────────────────────────────────────
    const orderId = crypto.randomUUID();

    const buyerUnitTotalCents = price.basisCents + processingPassThroughCents;

    // FR-003 (organiser-resale-share): the buyer's item carries the record of
    // the ticket's FIRST sale, copied from the item the seller holds it by
    // (`Ticket.orderItemId`), never the event's live clause, so the clause
    // and the original price hold on every hop (R2, R10, R15). A ticket
    // listed under the share always has one (the listing filled it, FR-004);
    // one with no record (or no reachable item) copies nulls.
    const resaleClauseRecord = sellerPurchaseItem
      ? copyTicketResaleClause(sellerPurchaseItem)
      : copyTicketResaleClause({});

    const items = [
      {
        kind: "ticket" as const,
        ticketTypeId: resolvedTicketTypeId,
        qty: 1,
        // The basis: what the buyer pays for the ticket before processing
        // and tax. A buyer-paid share is part of it, so a refund of this
        // item returns it to the buyer (FR-010).
        unitPriceCents: price.basisCents,
        amountCents: price.basisCents,
        meta: {
          holdExpiresAt: holdUntil.toISOString(),
          resaleListingId: listing.id,
          ...(originalOrderId
            ? { resaleOriginalOrderId: originalOrderId }
            : {}),
          ...(originalOrderItemId
            ? { resaleOriginalOrderItemId: originalOrderItemId }
            : {}),
          resaleAskPriceCents: listing.askPriceCents,
          buyerUnitTotalCents,
          buyerTotalCents: buyerUnitTotalCents,
          platformFeePerTicketCents: 0,
          effectiveFeeMode: price.effectiveFeeMode,
          processorFeeShareCents: processingPassThroughCents,
          ticketIndex: 0,
          ...(resolvedSeatId ? { seatId: resolvedSeatId } : {}),
        },
        resaleListingId: listing.id,
        resaleFaceValueCents: price.faceValueCents,
        resaleProcessingPassThroughCents: processingPassThroughCents,
        resaleProcessingFeeConfigRef: price.processingFeeConfigRef,
        resaleSaleCutoffAt: price.saleCutoffAt,
        resalePayoutReleaseAt: price.payoutReleaseAt,
        // The share this sale pays the event side, and who pays it (FR-005).
        // `resolveResaleSellerSplit` splits the order from these at finalize.
        eventShareCents: price.share.shareCents,
        sharePayer: price.share.payer,
        ...resaleClauseRecord,
      },
    ];

    const order = await tx.orders.createPending({
      id: orderId,
      eventId: event.id,
      buyerHumanId: input.buyerHumanId,
      // The agreement basis finalize splits: seller + share (FR-005). The
      // platform takes nothing on a resale order (R11).
      amountGrossCents: price.basisCents,
      feesPlatformCents: 0,
      taxAmountCents,
      currency,
      feePolicySnapshot: price.feePolicySnapshot,
      source: "RESALE",
      parentOrderId: originalOrderId,
      items,
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
    // Same transaction and same solve as `taxAmountCents` on the order row —
    // see the matching block in create-checkout.
    const taxLines = toOrderTaxLineInputs(taxSolve, taxAmountCents);
    if (taxLines.length > 0) {
      await tx.orders.createTaxLines({ orderId: order.id, lines: taxLines });
    }

    // ── Human-keyed acceptance ledger (idempotent per human + version) ─
    // Same dual-write as the primary checkout path: the Order keeps its
    // point-in-time stamps; these GLOBAL rows are the cross-time record.
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

    // ── Stripe PaymentIntent request (sent after the commit) ──────────
    // Resale uses the same platform-collects model. Funds stay on our
    // platform account; settlement transfers them later.
    const paymentMetadata: Record<string, string> = {
      orderId: order.id,
      eventId: event.id,
      buyerHumanId: input.buyerHumanId,
      source: "resale",
      resaleListingId: listing.id,
      sellerHumanId: listing.sellerHumanId,
      currency,
    };

    if (taxAmountCents > 0) {
      paymentMetadata.taxAmountCents = `${taxAmountCents}`;
    }

    // Dashboard/exports summary. TICKET lines only, and derived from the
    // items actually built above rather than hardcoded 1, so it stays honest
    // if a resale order ever carries more than the single listed ticket it
    // carries today.
    const ticketQuantity = items.reduce(
      (sum, item) => (item.kind === "ticket" ? sum + item.qty : sum),
      0,
    );
    const paymentDescription = buildPaymentDescription({
      eventTitle: event.title,
      orderId: order.id,
      ticketQuantity,
      kind: "resale",
    });

    return {
      orderId: order.id,
      eventId: event.id,
      listingId: listing.id,
      ticketId: ticket.id,
      buyerHumanId: input.buyerHumanId,
      holdUntil,
      now,
      request: {
        amountCents: paymentIntentAmountCents,
        currency,
        metadata: paymentMetadata,
        // Per order: Stripe binds an idempotency key to its request
        // parameters, and a retry under the same client key writes a NEW
        // order (new id in the metadata) once this one is unwound. The old
        // per-client key answered that retry with `idempotency_error`.
        idempotencyKey: `pi:${checkoutIdempotencyKey}:${order.id}`,
        statementDescriptorSuffix,
        description: paymentDescription,
      },
      checkoutCreatedAuditData: {
        listingId: listing.id,
        eventId: event.id,
        buyerHumanId: input.buyerHumanId,
        sellerHumanId: listing.sellerHumanId,
        askPriceCents: listing.askPriceCents,
        resaleFaceValueCents: price.faceValueCents,
        eventShareCents: price.share.shareCents,
        sharePayer: price.share.payer,
        sellerReceivesCents: price.share.sellerReceivesCents,
        resaleProcessingPassThroughCents: processingPassThroughCents,
        resaleSaleCutoffAt: price.saleCutoffAt.toISOString(),
        resalePayoutReleaseAt: price.payoutReleaseAt.toISOString(),
        amountGrossCents: price.basisCents,
        feesPlatformCents: 0,
        buyerFeesCents: processingPassThroughCents,
        taxAmountCents,
        paymentIntentAmountCents,
        currency,
      },
      response: {
        orderId: order.id,
        amountGrossCents: price.basisCents,
        buyerFeesCents: processingPassThroughCents,
        taxAmountCents,
        holdExpiresAt: holdUntil.toISOString(),
      },
    };
  });

  // No transaction is open from here to the link. Any failure before the
  // link wins cancels the PI, cancels the order and puts the listing back to
  // ACTIVE (`unwindUnlinkedResaleOrder`), then rethrows.
  const paymentIntent = await createAndLinkResalePaymentIntent(deps, logger, {
    pending,
    actorHumanId: input.actorHumanId,
  });

  // Only once the link has won, as in createCheckout: a checkout that was
  // unwound must not stamp the event's tax rate.
  await applyCheckoutTaxSelfHeal(
    { repos: deps.repos, reportError: deps.reportError },
    taxAfterCommit,
    logger,
  );

  logger?.info("createResaleCheckout.succeeded", {
    orderId: pending.orderId,
    listingId: input.listingId,
  });

  return {
    ...pending.response,
    clientSecret: paymentIntent.clientSecret!,
  };
}

// ── PaymentIntent create + link, outside the checkout transaction ──────────

type CreatedPaymentIntent = Awaited<
  ReturnType<PaymentProcessorPort["createPaymentIntent"]>
>;

/** What the checkout transaction hands to the post-commit Stripe step. */
interface PendingResalePayment {
  orderId: string;
  eventId: string;
  listingId: string;
  /** The listed pass. The link re-reads it (and its seller's item) under lock. */
  ticketId: string;
  buyerHumanId: string;
  /** The hold's `heldUntil`, exactly as written: the fence for assert/release. */
  holdUntil: Date;
  now: Date;
  request: Parameters<PaymentProcessorPort["createPaymentIntent"]>[0];
  /** `resale_checkout_created` data, less the PI id (known after creation). */
  checkoutCreatedAuditData: Record<string, unknown>;
  response: Omit<CreateResaleCheckoutOutput, "clientSecret">;
}

type LinkLostTo =
  | "order_not_pending"
  | "listing_hold_lost"
  | "listing_hold_expired"
  | "ticket_not_listed"
  | "original_item_refunded";

/**
 * Creates the resale PaymentIntent and links it to the committed PENDING
 * order, with no transaction open across the Stripe call.
 *
 * The link transaction runs these checks, in this lock order (order row,
 * then ticket row, then listing row — the order finalize and every PENDING
 * cancel take them in):
 *  1. `linkPaymentIntentIfPending`, a CAS on PENDING ∧ (PI null ∨ PI = p).
 *     Between the commit and here the order is a PENDING row with no PI, and
 *     the cart reaper or `releaseCartHold` can cancel it.
 *  2. `resaleListings.lockHold` on this attempt's hold (ticket row, then
 *     listing row). `cancelEvent`'s `cancelOpenForEvent` can cancel the
 *     listing (and drop the hold) in the same gap. A false here throws
 *     inside the transaction so the link rolls back: a PI linked to an order
 *     whose listing is gone is a charge with no ticket.
 *  2b. Under those locks, the pass is still LISTED and the seller's original
 *     item is not refunded. The checkout transaction read both with no lock,
 *     so a refund reconcile (which writes the ticket first, then the item)
 *     can land between that read and here. Selling then would DLQ the
 *     finalize (`RESALE_ORIGINAL_ITEM_REFUNDED`) over a charged buyer. The
 *     reconcile's partial-refund arm (ticket first) either committed before
 *     the ticket lock (seen here) or waits for this transaction. Its
 *     full-refund arm never touches a LISTED ticket, so it is caught only if
 *     it committed before the item read below; otherwise it lands after the
 *     link, where finalize's own guard is the backstop. On a refusal the
 *     unwind's `releaseHold` closes the listing CANCELLED.
 *  3. The hold's `heldUntil` has not passed. The hold is clamped to the sale
 *     cutoff, so a Stripe call that outlasts it would otherwise hand out a
 *     payable client secret after sales closed, for an order the reaper is
 *     about to cancel. This is not what keeps the stale-hold sweep
 *     (`expireResaleListings`) off a linking order: the sweep releases only
 *     when every order for the hold is CANCELLED, and this order is PENDING
 *     throughout. The check takes no lock.
 * Any check losing is a lost link: the PI is cancelled, the order unwound
 * and the checkout fails ORDER_NOT_PENDING. The client secret leaves the
 * server only after all of them pass.
 */
async function createAndLinkResalePaymentIntent(
  deps: CreateResaleCheckoutDeps,
  logger: LoggerPort | undefined,
  ctx: { pending: PendingResalePayment; actorHumanId: string },
): Promise<CreatedPaymentIntent> {
  const { pending } = ctx;
  const { orderId, listingId } = pending;
  let created: CreatedPaymentIntent | null = null;
  let lostTo: LinkLostTo | null = null;

  try {
    const paymentIntent = await callOrDependencyFailed(
      () => deps.payments.createPaymentIntent(pending.request),
      logger,
      { action: "create_payment_intent", orderId, listingId },
    );
    created = paymentIntent;

    let holdLost: LinkLostTo | null = null;
    let linked: boolean;
    try {
      linked = await deps.repos.tx(async (tx) => {
        holdLost = null;
        const didLink = await tx.orders.linkPaymentIntentIfPending(
          orderId,
          paymentIntent.id,
        );
        if (!didLink) return false;

        const stillHeld = await tx.resaleListings.lockHold(listingId, {
          buyerHumanId: pending.buyerHumanId,
          heldUntil: pending.holdUntil,
        });
        if (!stillHeld) {
          // Throw, not return: returning would COMMIT the link above.
          holdLost = "listing_hold_lost";
          throw new Error("resale_listing_hold_lost");
        }
        // Under the ticket lock `lockHold` took: the same two facts
        // `finalizeResalePurchase` guards, read fresh.
        const ticket = await tx.tickets.getById(pending.ticketId);
        if (!ticket || ticket.status !== "LISTED") {
          holdLost = "ticket_not_listed";
          throw new Error("resale_listing_ticket_not_listed");
        }
        if (ticket.orderItemId) {
          const originalItem = await tx.orderItems.getById(ticket.orderItemId);
          if (
            originalItem &&
            (originalItem.status === "refunded" || originalItem.refundedAt)
          ) {
            holdLost = "original_item_refunded";
            throw new Error("resale_listing_original_item_refunded");
          }
        }
        if (deps.clock.now().getTime() >= pending.holdUntil.getTime()) {
          holdLost = "listing_hold_expired";
          throw new Error("resale_listing_hold_expired");
        }

        await tx.audit.log({
          entity: "order",
          entityId: orderId,
          action: "resale_checkout_created",
          data: {
            ...pending.checkoutCreatedAuditData,
            paymentIntentId: paymentIntent.id,
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
    } catch (err) {
      if (!holdLost) throw err;
      linked = false;
      lostTo = holdLost;
    }

    if (!linked) {
      // Cancelled (reaper, releaseCartHold), its listing cancelled with the
      // event, or its pass refunded, between the commit and the link. The unwind below cancels the
      // PI and records the abandonment (`link_lost`).
      lostTo ??= "order_not_pending";
      throw fail("ORDER_NOT_PENDING", { meta: { orderId, reason: lostTo } });
    }

    return paymentIntent;
  } catch (err) {
    await unwindUnlinkedResaleOrder(deps, logger, {
      pending,
      paymentIntentId: created?.id ?? null,
      reason: lostTo ? "link_lost" : "payment_intent_not_linked",
      lostTo,
    });
    throw err;
  }
}

/**
 * Unwinds a resale checkout whose order committed but whose PaymentIntent
 * may not be linked. Every step is best-effort and swallows its own error:
 * the caller is already rethrowing the failure that explains what went wrong.
 * Every swallow is logged and reported.
 *
 *  1. Settle the PaymentIntent, if one was created: cancel it, and when the
 *     cancel answers "already terminal" read it back. It counts as dead only
 *     on a confirmed cancel or a read-back status of `canceled`; a throw, or
 *     any other status, leaves it UNCONFIRMED. When creation itself failed
 *     there may be a PI at Stripe whose response was lost: unlinked and its
 *     secret never issued, so it cannot charge.
 *  2. One transaction, which never trusts "the secret never left the server"
 *     on its own:
 *     - PI dead (or none created): cancel the order if it still carries
 *       either state this attempt can have left it in, our PI (the link
 *       committed but its answer was lost) or none (the link never
 *       committed).
 *     - PI unconfirmed: cancel the order ONLY if it provably carries no PI
 *       (`expectedPaymentIntentId: null`). An order that holds the live PI
 *       stays PENDING and keeps its listing hold; the expired-cart reaper
 *       settles that PI against the order and cancels it.
 *     - Release the listing hold (fenced on buyer + heldUntil, so a newer
 *       hold is never freed) only when the order ended up CANCELLED (by this
 *       cancel, or by someone else, read back here) AND the PI is dead or the
 *       order carries none. Every other canceller releases the hold in its
 *       own cancel transaction (`releaseRetiredCartHolds`), so after someone
 *       else's cancel this release normally finds nothing left (it is
 *       fenced and idempotent); it stays as the belt to their braces.
 *     - Write `pending_abandoned` in every case.
 *
 * If the transaction fails, or the PI could not be confirmed dead while the
 * order holds it, the listing stays HELD for now. Both are reported. In the
 * second case the reaper cancels the order and its cancel releases the
 * listing; in the first, the stale-hold sweep in `expireResaleListings` does
 * once the order is CANCELLED.
 */
async function unwindUnlinkedResaleOrder(
  deps: CreateResaleCheckoutDeps,
  logger: LoggerPort | undefined,
  ctx: {
    pending: PendingResalePayment;
    paymentIntentId: string | null;
    reason: "link_lost" | "payment_intent_not_linked";
    lostTo: LinkLostTo | null;
  },
): Promise<void> {
  const { pending, paymentIntentId } = ctx;
  const { orderId, listingId, now } = pending;

  const piSettle = paymentIntentId
    ? await confirmPaymentIntentCanceled(deps, paymentIntentId)
    : ({ dead: true } as const);
  const piDead = piSettle.dead;

  let outcome: { cancelledHere: boolean; listingReleased: boolean } | null =
    null;
  try {
    outcome = await deps.repos.tx(async (tx) => {
      let cancelledHere: boolean;
      if (piDead && paymentIntentId) {
        cancelledHere =
          (await tx.orders.cancelPendingOrder(orderId, {
            expectedPaymentIntentId: paymentIntentId,
          })) ||
          (await tx.orders.cancelPendingOrder(orderId, {
            expectedPaymentIntentId: null,
          }));
      } else {
        // No PI created, or a live one: only an order with no PI on it.
        cancelledHere = await tx.orders.cancelPendingOrder(orderId, {
          expectedPaymentIntentId: null,
        });
      }

      let mayRelease = cancelledHere;
      if (!cancelledHere) {
        // Someone else's cancel (reaper, releaseCartHold). CANCELLED is
        // terminal and nothing writes a PI onto it, so this read is stable.
        const current = await tx.orders.getById(orderId);
        mayRelease =
          current?.status === "CANCELLED" &&
          (piDead || (current.stripePaymentIntentId ?? null) === null);
      }

      const release = mayRelease
        ? await tx.resaleListings.releaseHold(
            listingId,
            {
              buyerHumanId: pending.buyerHumanId,
              heldUntil: pending.holdUntil,
            },
            { now: deps.clock.now() },
          )
        : ({ released: false } as const);
      const listingReleased = release.released;

      await tx.audit.log({
        entity: "order",
        entityId: orderId,
        action: "pending_abandoned",
        data: {
          eventId: pending.eventId,
          listingId,
          reason: ctx.reason,
          ...(ctx.lostTo ? { lostTo: ctx.lostTo } : {}),
          paymentIntentId,
          paymentIntentCancelConfirmed: piDead,
          cancelledHere,
          listingReleased,
          // ACTIVE = back on sale; CANCELLED / EXPIRED = closed instead
          // (refunded ticket, cancelled event, past its expiry).
          ...(release.released
            ? {
                listingReleasedTo: release.listingStatus,
                ...("reason" in release
                  ? { listingCloseReason: release.reason }
                  : {}),
              }
            : {}),
        },
        at: now,
      });

      return { cancelledHere, listingReleased };
    });
  } catch (err) {
    logger?.error("createResaleCheckout.unwind_release_failed", {
      orderId,
      listingId,
      paymentIntentId,
      err,
    });
    reportBestEffort(deps.reportError, err, {
      tags: {
        area: "checkout",
        useCase: "createResaleCheckout",
        step: "unwindReleaseListingHold",
      },
      extra: { orderId, listingId, paymentIntentId },
    });
  }

  if (!piSettle.dead) {
    // The PaymentIntent may be live. Reported whatever the transaction did,
    // with what it left behind: `leftForReaper` = order PENDING with the PI
    // and the listing still HELD.
    const leftForReaper = outcome != null && !outcome.cancelledHere;
    logger?.error("createResaleCheckout.unwind_pi_cancel_unconfirmed", {
      orderId,
      listingId,
      paymentIntentId,
      status: piSettle.status,
      leftForReaper,
      err: piSettle.error,
    });
    reportBestEffort(
      deps.reportError,
      piSettle.error ??
        new Error(
          `create_resale_checkout_unwind_pi_cancel_unconfirmed:${piSettle.status}`,
        ),
      {
        tags: {
          area: "checkout",
          useCase: "createResaleCheckout",
          step: "unwind_pi_cancel_unconfirmed",
        },
        extra: {
          orderId,
          listingId,
          paymentIntentId,
          status: piSettle.status,
          leftForReaper,
          listingReleased: outcome?.listingReleased ?? false,
        },
      },
    );
  }
}

/**
 * Cancel a PaymentIntent and say whether it is PROVABLY dead. The port's
 * `{ canceled: false }` means "already terminal", which covers both
 * `canceled` and `succeeded`, so that answer is read back. Never throws.
 */
async function confirmPaymentIntentCanceled(
  deps: CreateResaleCheckoutDeps,
  paymentIntentId: string,
): Promise<
  | { dead: true }
  | { dead: false; status: string; error?: unknown }
> {
  try {
    const { canceled } = await deps.payments.cancelPaymentIntent({
      paymentIntentId,
    });
    if (canceled) return { dead: true };
    const pi = await deps.payments.retrievePaymentIntent({ paymentIntentId });
    return pi.status === "canceled"
      ? { dead: true }
      : { dead: false, status: pi.status };
  } catch (error) {
    return { dead: false, status: "unknown", error };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** What a resale checkout charges, and what the buyer's item records. */
type CheckoutResalePrice = {
  /**
   * What the buyer pays for the ticket before processing and tax, and the
   * agreement basis finalize splits (seller + share): the ask, plus the
   * share when the buyer pays it.
   */
  basisCents: number;
  /** The share (FR-005). */
  share: ResaleShare;
  /**
   * The processor rate and fixed fee of the fee policy the listing froze
   * (`processingFeeConfigRef`). Checkout solves processing from these over
   * the full charge; the listing's stored `processingPassThroughCents` is the
   * pre-tax display figure and is not charged.
   */
  processorPct: number;
  processorFixedCents: number;
  processingFeeConfigRef: string | null;
  saleCutoffAt: Date;
  payoutReleaseAt: Date;
  /** What the seller paid (display only). */
  faceValueCents: number | null;
  feePolicySnapshot: Record<string, unknown>;
  effectiveFeeMode: string;
};

type CheckoutListing = NonNullable<
  Awaited<ReturnType<TxRepos["resaleListings"]["getById"]>>
>;

/**
 * Prices a resale checkout from what the LISTING froze when it was created,
 * never from live terms:
 *
 *  1. A listing priced under the share (`eventShareCents` + `sharePayer`,
 *     every listing since organiser-resale-share B4): the share is recomputed
 *     from the ticket's FR-003 record with `computeResaleShare`, the function
 *     the listing priced it with, and must equal what the listing froze (and
 *     showed). Cutoff and release come from the listing; so does the fee
 *     policy it priced processing with (the one a primary sale uses,
 *     FR-013), whose rate the caller solves over the full charge. The
 *     RESALE terms must still carry payout lines: finalize splits the share
 *     over them, so a charge without them would strand in the DLQ.
 *  2. A listing without a share was priced under the markup split, which
 *     is gone (FR-014): refused before any hold or charge
 *     (RESALE_TERMS_MISSING). `cancelLegacyResaleListings` cancels such
 *     listings with a notice to list again (FR-015), and the migration that
 *     dropped the markup columns refuses to run while one is live.
 *
 * Never reads the RESALE terms' fee policy: AGREEMENT_MISSING_FEE_POLICY no
 * longer refuses a resale (FR-013).
 */
async function priceResaleCheckout(
  tx: TxRepos,
  ctx: {
    listing: CheckoutListing;
    event: { id: string; resalePayoutTermsId: string | null };
    sellerPurchaseItem: OrderItemRecord | null;
    faceValueCents: number | null;
    now: Date;
  },
): Promise<CheckoutResalePrice> {
  const { listing, event, sellerPurchaseItem, now } = ctx;

  if (listing.eventShareCents != null && listing.sharePayer != null) {
    if (
      listing.saleCutoffAt == null ||
      listing.payoutReleaseAt == null ||
      listing.processingFeeConfigRef == null
    ) {
      // `createResaleListing` writes all three with the share.
      throw fail("INTERNAL", {
        message: `resale_listing_share_snapshot_incomplete: listing ${listing.id}`,
        meta: { listingId: listing.id },
      });
    }

    const clause = sellerPurchaseItem
      ? resaleClauseFromRecord(sellerPurchaseItem)
      : null;
    const share = clause
      ? computeResaleShare({ askCents: listing.askPriceCents, clause })
      : null;
    if (
      !share ||
      share.shareCents !== listing.eventShareCents ||
      share.payer !== listing.sharePayer
    ) {
      // The listing filled the ticket's record in its own transaction and the
      // record is never rewritten, so the two cannot disagree unless one was
      // written by something else. Charging either figure would move money
      // on a guess; this is our bug, so it surfaces as one.
      throw fail("INTERNAL", {
        message: `resale_listing_share_drift: listing ${listing.id}`,
        meta: {
          listingId: listing.id,
          listingShareCents: listing.eventShareCents,
          listingSharePayer: listing.sharePayer,
          recordShareCents: share?.shareCents ?? null,
          recordSharePayer: share?.payer ?? null,
        },
      });
    }

    const resalePayoutTermsId =
      listing.resalePayoutTermsId ?? event.resalePayoutTermsId;
    if (!resalePayoutTermsId) {
      throw fail("RESALE_NOT_ENABLED");
    }
    const lines = await tx.payoutTerms.listLines(resalePayoutTermsId);
    if (lines.length === 0) {
      throw fail("AGREEMENT_MISSING_LINES", { meta: { scope: "resale" } });
    }

    // The processor rate: the fee policy the listing priced processing with
    // (`resolveResaleFeePolicy`, the one a primary sale of the event uses).
    // Read by the frozen id, so a later policy change does not reprice a
    // live listing. Gone = no rate to charge with; refused, never guessed.
    const feePolicy = await tx.feePolicies.getById(
      listing.processingFeeConfigRef,
    );
    if (!feePolicy) {
      throw fail("FEE_POLICY_NOT_FOUND", {
        meta: {
          scope: "resale",
          listingId: listing.id,
          feePolicyId: listing.processingFeeConfigRef,
        },
      });
    }

    return {
      basisCents: share.basisCents,
      share,
      processorPct: feePolicy.processsorFeePct,
      processorFixedCents: feePolicy.processorFixedCents,
      processingFeeConfigRef: listing.processingFeeConfigRef,
      saleCutoffAt: listing.saleCutoffAt,
      payoutReleaseAt: listing.payoutReleaseAt,
      faceValueCents: ctx.faceValueCents,
      feePolicySnapshot: {
        payoutTermsId: resalePayoutTermsId,
        payoutTermsVersion: null,
        agreementId: resalePayoutTermsId,
        agreementVersion: null,
        feePolicyId: listing.processingFeeConfigRef,
        feePolicyVersion: feePolicy.version,
        feeMode: SALE_FEE_MODE,
        organiserCredit: SALE_ORGANISER_CREDIT,
        source: "resale_listing_share",
        computedAt: now.toISOString(),
      },
      effectiveFeeMode: SALE_FEE_MODE,
    };
  }

  throw fail("RESALE_TERMS_MISSING", {
    meta: { listingId: listing.id, reason: "listing_predates_resale_share" },
  });
}
