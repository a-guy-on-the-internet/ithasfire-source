import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";

import { recordAcceptance } from "../../lib/legal/acceptance";
import { reportBestEffort } from "../../lib/payments/resolve-scoped-fee-policy";
import { CURRENT_BUYER_TERMS_VERSION } from "../../lib/legal/buyer-terms";
import { getCurrentRefundPolicySnapshot } from "../../lib/payments/refund-policy";
import { mintTicketsForOrder } from "../tickets/mint-tickets";
import { recordAttribution } from "./record-attribution";
import { notifyBuyer, type NotifyFn } from "./notify-buyer";
import { fail } from "@th/errors";
import {
  aggregateItems,
  buildFeePolicySnapshot,
  computeOrderAmounts,
  ensureBuyerMayEnterEvent,
  ensureEventOnSale,
  extractSeatIdsFromMeta,
  heldSeatIdForItem,
  holdSeatsForCheckout,
  loadAgreementContext,
  readSeatPriceOverrides,
  type OrderComputation,
  type TicketTypeSummary,
  zeroFeesForFreeOrder,
} from "./checkout-helpers";
import {
  evaluatePromoApplications,
  createPromoHolds,
  describeApplicationForAudit,
  type PromoCodeEntry,
} from "./checkout-promos";
import { resolveMemberBenefits } from "../memberships/resolve-member-benefits";
import { assertTicketTypeCapacity } from "../_helpers/assert-ticket-type-capacity";
import { resolveSeatHoldFence } from "./_shared/cart-seat-release";
import {
  resolveTicketResaleClause,
  stampTicketResaleClause,
} from "./_shared/resolve-ticket-resale-clause";
import {
  assertSeatQuotesMatch,
  collectSeatQuotes,
} from "./_shared/seat-quotes";
import {
  retireSettledCarriedOverCart,
  settleCarriedOverCartBeforeTx,
  withSettledCarriedOverCart,
  type SettledCarriedOverCart,
} from "./_shared/settle-carried-over-cart-before-tx";
import type {
  CreateCheckoutInput,
  CreateCheckoutOutput,
} from "./create-checkout";
import { isEditDelegateOfHumanOwner } from "../../lib/event-edit-rights";
import type { CheckoutServerContext } from "./_shared/checkout-server-context";

// ── Types ───────────────────────────────────────────────────────────────────

const SEAT_HOLD_TTL_SECONDS = 900;

export type ClaimFreeTicketsDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Multi-channel notification dispatcher. Optional — when present the buyer
   * receives a fire-and-forget in-app (+ push) confirmation after the free
   * order is durably committed. A notify outage never fails the claim.
   */
  notify?: NotifyFn;
  /**
   * Best-effort reporter. Forwarded to `computeOrderAmounts` so an unparseable
   * sales-window bound — the one input that makes the window guard fail OPEN —
   * is visible in Sentry rather than silently minting free tickets for a tier
   * whose window nobody can evaluate.
   */
  reportError?: ReporterPort;
  /**
   * Processor handle, used for exactly one thing here: cancelling the
   * PaymentIntent of a cart this claim supersedes. A free claim mints nothing
   * through Stripe, but it CAN follow a paid attempt (buyer applies a 100%-off
   * promo after a decline), and that superseded order's PI is still
   * confirmable. Without this the cart is left holding stock rather than
   * de-held unsafely — see `settleCarriedOverCartPaymentIntent`.
   * `retrievePaymentIntent` is part of the pair because a no-op cancel does
   * not prove the PI is dead. Called with no transaction open.
   */
  payments?: Pick<
    PaymentProcessorPort,
    "cancelPaymentIntent" | "retrievePaymentIntent"
  > | null;
};

// ── Use case ────────────────────────────────────────────────────────────────

/**
 * Fast path for free orders (ticket price is zero, or promo discount covers
 * the full amount).
 *
 * Unlike the paid checkout path this:
 *  - Holds assigned seats only long enough to validate and mint them
 *  - Creates the order as SUCCEEDED in a single transaction
 *  - Mints tickets immediately within the same transaction
 *  - Confirms promo redemptions inline (no pending promo holds)
 *  - Returns `holdExpiresAt: null` and `clientSecret: null`
 */
export async function claimFreeTickets(
  deps: ClaimFreeTicketsDeps,
  input: CreateCheckoutInput,
  promoCodes: PromoCodeEntry[],
  logger: LoggerPort | undefined,
  /** Server-only; see checkout-server-context.ts. Never from input. */
  serverContext: CheckoutServerContext = {},
): Promise<CreateCheckoutOutput> {
  // ── ToS + refund-policy gates (defense-in-depth) ─────────────────────
  // createCheckout gates these before delegating here, but claimFreeTickets
  // is an exported use case — free claims still bind the claimer to the
  // ToS and refund policy, so enforce the same gates locally.
  if (input.termsAccepted !== true) {
    throw fail("TERMS_REQUIRED");
  }

  if (input.refundPolicyAccepted !== true) {
    throw fail("REFUND_POLICY_REQUIRED");
  }

  const now = deps.clock.now();

  // The event-level refusals. Run inside the transaction, and also before
  // the carried-over cart's PaymentIntent is settled (below), so a claim that
  // will be refused here never cancels the buyer's other tab's live PI.
  const loadClaimableEvent = async (r: TxRepos) => {
    const event = await ensureEventOnSale(r, input.eventId, now);

    // FR-003/FR-012 (community-managed-event-listings): RSVP events have no
    // ticket types or orders — free claims are still orders, so reject.
    // createCheckout guards this too, but claimFreeTickets is an exported
    // use case (defense-in-depth, same as the ToS gates above).
    if (event.attendanceMode === "RSVP") {
      throw fail("EVENT_NOT_TICKETED");
    }

    // An embed claim never takes a gated event, unlock or not (see
    // `ensureBuyerMayEnterEvent`). This runs in the claim transaction AND in
    // the pre-transaction settle, so the race where the event is gated after
    // createCheckout's shared-prep read is closed here too.
    await ensureBuyerMayEnterEvent(
      r,
      event,
      input.buyerHumanId,
      serverContext,
    );
    // A DELEGATE may not give themselves tickets (owner ruling 2026-09-28):
    // an edit-role delegate of the event's human owner cannot claim the
    // principal's $0 tier for themselves. Owners, org members and everyone
    // else claim as before. Checked before any order is written.
    if (
      !event.orgId &&
      event.humanId &&
      (await isEditDelegateOfHumanOwner(
        r.authz,
        { ownerType: "HUMAN", ownerId: event.humanId },
        input.buyerHumanId,
      ))
    ) {
      throw fail("DELEGATE_SELF_BENEFIT_FORBIDDEN");
    }
    return event;
  };

  // The claim transaction. Run by `withSettledCarriedOverCart` below, after
  // the carried-over cart's PaymentIntent is settled.
  const claimInTx = async (
    tx: TxRepos,
    carriedOverSettle: SettledCarriedOverCart | null,
    mayRetry: boolean,
  ) => {
    const event = await loadClaimableEvent(tx);
    const currency = event.currency ?? "usd";
    const refundPolicySnapshot = getCurrentRefundPolicySnapshot();
    // `logger` / `reportError` are forwarded so the cold-path fee-policy walk
    // this free event WILL take (its terms carry no pin) reports a swallowed
    // repo failure instead of degrading to AGREEMENT_MISSING_FEE_POLICY with
    // the real exception discarded.
    const agreementContext = await loadAgreementContext(tx, event.id, now, {
      logger,
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
          // Raw schedule — resolved by computeOrderAmounts at `now`. A tier
          // that flips to 0 at T is genuinely free from T, and a tier that
          // flips OFF 0 stops being claimable here (ORDER_NOT_FREE).
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
    // A seat override is a price: a $10 seat on a $0 tier is not free, and
    // ORDER_NOT_FREE below refuses it. Re-checked under the seat lock.
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
    // The buyer's quoted seat prices must be the priced ones (D-007): a seat
    // shown free that now costs money refuses here, before anything is held.
    assertSeatQuotesMatch(
      orderComputation.items,
      collectSeatQuotes(input.items),
      ticketTypeMap,
    );

    // Re-resolve member benefits inside THIS tx rather than trusting the
    // caller's routing probe: claimFreeTickets is an exported use case, and
    // the ORDER_NOT_FREE guard below must hold against the same snapshot the
    // discount was computed from. A membership lapsing between probe and
    // claim fails safe (ORDER_NOT_FREE) instead of minting unpaid tickets.
    const memberGrants = await resolveMemberBenefits(tx, {
      memberHumanId: input.buyerHumanId,
      event,
      now,
    });

    // ── Prior cart carry-over ──────────────────────────────────────────
    // Resolved once and shared by the promo evaluation, the capacity gate and
    // the seat release, exactly as in createPaidCheckout. Ownership is
    // validated here; passing an unowned id to the gate would discount a
    // stranger's hold.
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

    // Redemption stats count LIVE holds, and the cart being superseded still
    // holds this buyer's codes (retirement runs below). Excluding it here is
    // what keeps a 1-per-person code usable on the retry that carries it.
    // Safe even if retirement then declines: `createHolds` re-checks under
    // its lock with NO exclusion, so an un-retired cart's hold still refuses
    // the capped code there — after the mint, but inside the same
    // transaction, so the throw rolls the mint back and nothing commits.
    const promoEvaluation = await evaluatePromoApplications({
      codes: promoCodes,
      tx,
      event,
      buyerHumanId: input.buyerHumanId,
      now,
      orderSubtotalCents: orderComputation.amountGrossCents,
      ticketLines: orderComputation.ticketLines,
      memberGrants,
      excludeOrderId: carriedOverCart?.id,
      ...(deps.logger ? { logger: deps.logger } : {}),
    });

    const amountGrossAfterDiscount =
      orderComputation.amountGrossCents - promoEvaluation.totalDiscountCents;

    // Sanity: this path should only be reached for truly free orders.
    if (amountGrossAfterDiscount > 0) {
      throw fail("ORDER_NOT_FREE");
    }

    // Two routes reach this path: items priced at $0 (already fee-free, since
    // computeOrderAmounts zeroes those inline) and a promo that cancels the
    // whole subtotal. The second arrives carrying REAL fees computed from the
    // undiscounted ticket prices — zero them so a 100%-off order doesn't show
    // a fee line to the buyer or book platform fees it never earned. Must run
    // before discount items are merged in below, so only ticket items are hit.
    zeroFeesForFreeOrder(orderComputation);

    const orderItems: OrderComputation["items"] = [
      ...orderComputation.items,
      ...promoEvaluation.discountItems,
    ];

    // ── Retire the superseded cart ─────────────────────────────────────
    // Same reasoning as the paid path: gate exclusion protects only THIS
    // claimer, so an un-retired cart keeps consuming a unit for everyone else
    // until its hold expires. A free claim can still be superseding a cart
    // that carries a live PaymentIntent (a promo applied after a paid attempt
    // routes here), so the PI-first rule applies unchanged: the PI was
    // settled BEFORE this transaction, and this de-holds only if that proved
    // it dead, through a cancel CAS on the PI the settle observed. A `false`
    // (settle refused, CAS lost, cart changed on the last attempt) leaves the
    // cart live with its reservation; everything below honours that.
    //
    // ORDERING: this runs BEFORE the capacity gate below because the gate's
    // `excludeOrderId` is only sound once this cart is proven dead, and the
    // verdict has to exist before the gate reads it. That gives the same
    // retire → capacity → seats sequence as `createPaidCheckout`.
    //
    // It does NOT make the whole path match: `createPaidCheckout` retires
    // ahead of its fee-waiver reserve, promo evaluation and credit snapshot,
    // while this path still evaluates promos above. The promo evaluation
    // compensates by EXCLUDING the superseded cart's holds (see there), so a
    // single-use code held by that cart no longer refuses its own retry.
    //
    // LOCKS. Retirement takes row locks on Order, PromoHold, FeeWaiver /
    // FeeWaiverRedemption, UserCredit / UserCreditRedemption and, for a
    // resale cart, the pass's Ticket / ResaleListing / ListingHold rows (the
    // listing release, in this transaction with the cancel CAS) — never a
    // Seat and never a TicketType. So the sequence is Order → TicketType
    // (capacity) → Seat, which is the order `createPaidCheckout` and
    // `startPosSale` already take. It does NOT disturb the
    // capacity-before-seats rule the gate below depends on. No Stripe call
    // runs while these locks are held.
    //
    // ROLLBACK. The settle is a network call made before this transaction
    // and does not roll back with it. Any throw from the transaction
    // (ORDER_NOT_FREE, a promo, sales-window or capacity refusal, seats,
    // ORDER_NOT_FOUND, a mint refusal) rolls back the cancel CAS and the
    // releases together and leaves the prior cart PENDING, holding its
    // reservation, with a cancelled PI, until the next attempt or the reaper
    // retires it. That end state is the one the in-transaction cancel left
    // too, and it is the safe direction: a cancelled PI cannot charge, and
    // the next attempt re-retires the cart through the
    // `retrievePaymentIntent` → "canceled" path. What changed is which
    // refusals can reach it: the event-level ones (on sale, RSVP, access,
    // delegate) run again before the settle, so they still cancel nothing,
    // but the rest now run after the PI is cancelled, where before several
    // of them (ORDER_NOT_FREE, promo, sales window, NO_TICKET_TYPES) threw
    // ahead of it. A transaction timeout no longer strands a cancel half-way
    // through, because nothing in the transaction waits on Stripe.
    const retiredCarriedOverCart = await retireSettledCarriedOverCart(
      tx,
      carriedOverCart,
      carriedOverSettle,
      mayRetry,
      {
        caller: "claimFreeTickets",
        // A fresh read, not the claim's bound `now`: the settle before this
        // transaction can take minutes, and this instant decides the credit
        // release's expiry and a resale listing's `expiresAt` outcome. The
        // sales window and the order keep the bound `now`.
        now: deps.clock.now(),
        logger,
        reportError: deps.reportError,
      },
    );

    // ── Capacity gate ──────────────────────────────────────────────────
    // Free does not mean unlimited. This path mints REAL tickets inline
    // (mintTicketsForOrder below), so without a gate a $0 tier would hand
    // out more admissions than the room holds — the same oversell as the
    // paid path, minus only the charge. `mintTickets` would eventually
    // refuse, but by then the order row exists and the buyer sees a failure
    // instead of a clean refusal.
    //
    // Before the seat release/hold, so capacity locks precede Seat locks on
    // every path.
    //
    // The exclusion is gated on the RETIREMENT VERDICT, exactly as the seat
    // release below is. Excluding the carried-over cart is only sound once
    // that cart is dead: retirement declines when its PaymentIntent SUCCEEDED
    // or is still processing (and on a Stripe blip, or with no processor at
    // all), and a declined cart still owns its reservation — it mints tickets
    // against its own lines. Discounting its qty here would hand this claim
    // the very stock that order is about to take, and on a GA tier (no
    // `seatSectionId`, so the seat gate below is a no-op for it) nothing
    // downstream would catch it: the tier oversells.
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

    // Seats come back ONLY if the superseded order actually died. A live
    // order (PI succeeded / processing) still mints against these seat ids,
    // so releasing them here would double-assign them to this free claim.
    if (carriedOverCart && retiredCarriedOverCart) {
      const previousSeatIds = carriedOverCart.items
        .filter((item) => item.kind === "ticket")
        .flatMap((item) => extractSeatIdsFromMeta(item.meta));
      if (previousSeatIds.length > 0) {
        // Fenced to the carried-over cart's OWN hold, exactly as the paid
        // path is. Retirement proves that cart's ORDER is dead; it proves
        // nothing about who holds its SEATS. The cart can be up to the cart
        // TTL (1200s) old while the seat-hold TTL is 900s, so the seat reaper
        // may already have freed these seats and another buyer may be holding
        // — or have PAID for — one. Releasing that seat under their live
        // PaymentIntent sells it twice.
        //
        // The fence is the cart's last hold instant, NOT `occurredAt`:
        // `updateOrderItems` re-holds on every edit without rewriting
        // `occurredAt`, so an `occurredAt` fence would decline a legitimately
        // re-held seat, leave it HELD, and make `holdSeatsForCheckout` below
        // refuse this claim with `seat_unavailable` for the buyer's own
        // seats. See `resolveSeatHoldFence`.
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
          logger?.error("claim_free_tickets_seat_fence_missing", {
            orderId: carriedOverCart.id,
            seatCount: previousSeatIds.length,
          });
          reportBestEffort(
            deps.reportError,
            new Error("claim_free_tickets_seat_fence_missing"),
            {
              tags: {
                area: "checkout",
                step: "releaseCarriedOverSeats",
                useCase: "claimFreeTickets",
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

    // ── Create order as SUCCEEDED (no hold, no pending state) ─────────
    const orderId = crypto.randomUUID();

    // FR-003 (organiser-resale-share): each ticket records the event's resale
    // clause in force at this sale, read in this transaction.
    const resaleClause = await resolveTicketResaleClause(tx, event);
    const order = await tx.orders.createPending({
      id: orderId,
      eventId: event.id,
      buyerHumanId: input.buyerHumanId,
      amountGrossCents: amountGrossAfterDiscount,
      feesPlatformCents: orderComputation.feesPlatformCents,
      taxAmountCents: 0,
      currency,
      feePolicySnapshot: buildFeePolicySnapshot(agreementContext, now),
      source: "PRIMARY",
      nonRefundable: orderComputation.nonRefundable,
      items: stampTicketResaleClause(orderItems, resaleClause),
      billingAddressLine1: input.billingAddress?.line1 ?? null,
      billingAddressLine2: input.billingAddress?.line2 ?? null,
      billingCity: input.billingAddress?.city ?? null,
      billingState: input.billingAddress?.state ?? null,
      billingPostalCode: input.billingAddress?.postalCode ?? null,
      billingCountry: input.billingAddress?.country ?? null,
      stripeTaxCalculationId: null,
      termsVersion: CURRENT_BUYER_TERMS_VERSION,
      termsAcceptedAt: now,
      refundPolicyAckAt: now,
      refundPolicyAckIp: input.requestIp ?? null,
      checkoutIp: input.requestIp ?? null,
      refundPolicyVersion: refundPolicySnapshot.version,
      refundPolicyText: refundPolicySnapshot.text,
    });

    // ── Human-keyed acceptance ledger (idempotent per human + version) ─
    // Same dual-write as the paid checkout path: the Order keeps its
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

    // Immediately mark as succeeded — no payment to wait for.
    await tx.orders.markSucceeded(order.id);

    // ── Mint tickets immediately ────────────────────────────────────
    // Re-read the order with items so mintTicketsForOrder has the full
    // record including the generated item IDs.
    const fullOrder = await tx.orders.getById(order.id);
    if (!fullOrder) {
      throw fail("ORDER_NOT_FOUND");
    }
    fullOrder.status = "SUCCEEDED";

    const mintResult = await mintTicketsForOrder(tx, {
      order: fullOrder,
      issuedAt: now,
      actor: { kind: "system", reason: "free_order_claim" },
    });

    // ── Confirm promo redemptions immediately ──────────────────────
    if (promoEvaluation.applications.length > 0) {
      // Create holds then immediately confirm so the promo redemption
      // counts are correct.  The hold TTL doesn't matter since we
      // confirm in the same transaction.
      await createPromoHolds(tx.promos, promoEvaluation.applications, {
        orderId: order.id,
        buyerHumanId: input.buyerHumanId,
        now,
      });
      await tx.promos.confirmHoldsForOrder({
        orderId: order.id,
        confirmedAt: now,
      });
    }

    // ── Audit ───────────────────────────────────────────────────────
    await tx.audit.log({
      entity: "order",
      entityId: order.id,
      action: "free_order_claimed",
      data: {
        eventId: event.id,
        buyerHumanId: input.buyerHumanId,
        amountGrossCents: amountGrossAfterDiscount,
        feesPlatformCents: orderComputation.feesPlatformCents,
        currency,
        ticketsIssued: mintResult.count,
        items: orderItems,
        promos: promoEvaluation.applications.map(describeApplicationForAudit),
        discountTotalCents: promoEvaluation.totalDiscountCents,
        billingAddress: input.billingAddress ?? null,
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

    // ── Attribution ─────────────────────────────────────────────────
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
      orderId: order.id,
      amountGrossCents: amountGrossAfterDiscount,
      feesPlatformCents: orderComputation.feesPlatformCents,
      buyerFeesCents: orderComputation.buyerFeesCents,
      taxAmountCents: 0,
      ticketsIssued: mintResult.count,
      feeMode: orderComputation.effectiveFeeMode,
      eventTitle: event.title,
      currency,
    };
  };

  // ── Superseded cart: settle its PaymentIntent BEFORE the transaction ──
  // Cancelling (and, if needed, reading back) the carried-over cart's PI is
  // up to two Stripe round-trips, 240 s worst case against a 30 s transaction
  // budget and a pool of 10. They run with no transaction open, the same way
  // createCheckout's paid path does
  // (docs/decisions/create-checkout-payment-intent-outside-tx.md, step 1).
  // The transaction only does the database half of the retirement, and only
  // if the cart still carries exactly the PI settled. If it gained a
  // different PI in between (the buyer's other tab linking its checkout), the
  // transaction rolls back and the new PI is settled before one rerun.
  const {
    orderId,
    amountGrossCents,
    feesPlatformCents,
    buyerFeesCents,
    taxAmountCents,
    ticketsIssued,
    feeMode,
    eventTitle,
    currency: orderCurrency,
  } = await withSettledCarriedOverCart(
    { repos: deps.repos, logger, caller: "claimFreeTickets" },
    () =>
      settleCarriedOverCartBeforeTx(
        {
          repos: deps.repos,
          payments: deps.payments,
          logger,
          reportError: deps.reportError,
          caller: "claimFreeTickets",
          beforeSettle: async () => {
            await loadClaimableEvent(deps.repos);
          },
        },
        input,
      ),
    claimInTx,
  );

  logger?.info("claimFreeTickets.succeeded", {
    orderId,
    amountGrossCents,
    ticketsIssued,
  });

  // ── Buyer in-app confirmation (fire-and-forget) ─────────────────────
  // Free claims mint real tickets inline (no PaymentIntent → no
  // finalizePaymentIntent / webhook), so the buyer would otherwise get
  // tickets but no in-app confirmation — inconsistent with paid orders.
  // Uses the SAME idempotency key (order-confirmed:${orderId}) as the
  // finalize path so a later finalize/webhook for this order can't
  // double-fire. The buyer paid 0 for a free order. Guest / POS_WALKUP
  // buyers are skipped inside notifyBuyer; failures never propagate.
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
          orderId,
          eventId: input.eventId,
          eventTitle,
          ticketCount: ticketsIssued,
          amountCents: 0,
          currency: orderCurrency,
        },
        idempotencyKey: `order-confirmed:${orderId}`,
      },
    );
  }

  return {
    orderId,
    clientSecret: null,
    amountGrossCents,
    feesPlatformCents,
    buyerFeesCents,
    processorFeeCents: 0, // Free orders have no processor fee
    feeMode,
    taxAmountCents,
    creditAppliedCents: 0, // Free orders never redeem platform credit
    holdExpiresAt: null,
  };
}
