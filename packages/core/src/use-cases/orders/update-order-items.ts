import { z } from "zod";
import { donationAmountCentsSchema } from "../../lib/pricing/pay-what-you-want";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { OrderRecord } from "@th/ports/repos/orders";
import type { TaxRateLookupPort } from "@th/ports/tax-rate-lookup";
import type { ReporterPort } from "@th/ports/reporter";
import { orderItemKindSchema, orderStatusSchema } from "@th/schema";
import { parseInput } from "../../lib/io";
import { reportBestEffort } from "../../lib/payments/resolve-scoped-fee-policy";
import { fail } from "@th/errors";
import {
  ORDER_HOLD_TTL_SECONDS,
  resolveSeatHoldFence,
} from "./_shared/cart-seat-release";
import {
  aggregateItems,
  assertOneDonationAmountPerTier,
  buildFeePolicySnapshot,
  computeOrderAmounts,
  ensureEventAccessible,
  ensureEventOnSale,
  extractSeatIdsFromMeta,
  heldSeatIdForItem,
  holdSeatsForCheckout,
  loadAgreementContext,
  readSeatPriceOverrides,
  type TicketTypeSummary,
} from "./checkout-helpers";
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
import {
  applyCheckoutTaxSelfHeal,
  newCheckoutTaxAfterCommit,
  prepareCheckoutTax,
  resolveCheckoutTax,
} from "./_shared/resolve-checkout-tax-rate";
import {
  lookupFeeWaiverHeadroomForHold,
  waivedTicketsForHold,
} from "./fee-waiver-checkout";
import { requireTicketingEventId } from "./_shared/require-ticketing-order";
import { assertTicketTypeCapacity } from "../_helpers/assert-ticket-type-capacity";

const SEAT_HOLD_TTL_SECONDS = 900;

const orderItemSchema = z
  .object({
    id: z.uuid(),
    kind: orderItemKindSchema,
    ticketTypeId: z.uuid().nullable(),
    qty: z.number().int(),
    unitPriceCents: z.number().int(),
    amountCents: z.number().int(),
    meta: z.unknown(),
  })
  .strict();

const orderSchema = z
  .object({
    id: z.uuid(),
    eventId: z.uuid(),
    buyerHumanId: z.uuid(),
    amountGrossCents: z.number().int(),
    feesPlatformCents: z.number().int(),
    buyerFeesCents: z.number().int(),
    /** Estimated processor fee in cents — display only, NOT added to PaymentIntent. */
    processorFeeCents: z.number().int().nonnegative(),
    currency: z.string(),
    status: orderStatusSchema,
    items: z.array(orderItemSchema),
  })
  .strict();

export const updateOrderItemsInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
    orderId: z.uuid().optional(),
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
            /** Required when ticket type pricingMode is ADJUSTABLE. Buyer's chosen amount in cents. */
            // Capped at MAX_DONATION_AMOUNT_CENTS ($10,000.00 per ticket).
            donationAmountCents: donationAmountCentsSchema.optional(),
            /**
             * The unit price the buyer was shown for each picked seat: an
             * ASSERTION, never charged from (`_shared/seat-quotes.ts`). A
             * mismatch refuses the hold with `seat_price_changed`.
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
  })
  .strict();

export const updateOrderItemsOutputSchema = z
  .object({
    order: orderSchema,
    holdExpiresAt: z.string().datetime(),
  })
  .strict();

export type UpdateOrderItemsInput = z.infer<typeof updateOrderItemsInputSchema>;
export type UpdateOrderItemsOutput = z.infer<
  typeof updateOrderItemsOutputSchema
>;

export type UpdateOrderItemsDeps = {
  repos: Repos;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Tax provider port (ZipTax). Optional — used only for the last-chance
   * admission-tax lookup when the event was never stamped at publish time.
   */
  taxRateLookup?: TaxRateLookupPort | null;
  /**
   * Best-effort reporter. Forwarded to `computeOrderAmounts` so an unparseable
   * sales-window bound — the one input that makes the window guard fail OPEN —
   * is visible in Sentry rather than silently permitting a cart hold.
   */
  reportError?: ReporterPort | null;
};

/**
 * True when the cart named by `input.orderId` is one the transaction will
 * refuse (missing, someone else's, not PENDING, another event's, or already
 * holding a PaymentIntent). A fresh hold (no `orderId`) is never refused here.
 * A read fault is not swallowed: it propagates like any other repo fault.
 */
async function orderWillBeRefused(
  deps: Pick<UpdateOrderItemsDeps, "repos">,
  input: { orderId?: string | null; actorHumanId: string; eventId: string },
): Promise<boolean> {
  if (!input.orderId) return false;
  const existing = await deps.repos.orders.getById(input.orderId);
  return (
    !existing ||
    existing.buyerHumanId !== input.actorHumanId ||
    existing.status !== "PENDING" ||
    existing.eventId !== input.eventId ||
    orderHasEnteredCheckout(existing)
  );
}

/**
 * True once `createCheckout` owns the order, so its lines are priced into a
 * PaymentIntent and must not be re-priced here.
 *
 * The PaymentIntent link alone is not enough: `createCheckout` commits the
 * order FIRST and links its PaymentIntent in a second, short write (so no
 * Stripe call runs inside its transaction). In between, the order is PENDING
 * with no PI, which is exactly what a cart looks like. `termsAcceptedAt` closes
 * that gap: checkout writes it in the same INSERT that creates the row, and
 * the carts this use case creates never set it, so no checkout order is ever
 * visible without it.
 *
 * The adapter's `updatePendingItems` guard encodes the same rule; change both together.
 */
function orderHasEnteredCheckout(order: {
  stripePaymentIntentId: string | null;
  termsAcceptedAt?: Date | null;
}): boolean {
  return Boolean(order.stripePaymentIntentId) || order.termsAcceptedAt != null;
}

/**
 * The error code for a cart whose guarded re-price write matched no row:
 * re-read it and name the refusal the up-front check would have given.
 * ORDER_HAS_PAYMENT_INTENT when checkout claimed it, ORDER_NOT_PENDING
 * otherwise (finalized, cancelled, expired, or gone).
 */
async function refusalForLostCart(
  tx: TxRepos,
  orderId: string,
): Promise<"ORDER_NOT_PENDING" | "ORDER_HAS_PAYMENT_INTENT"> {
  const current = await tx.orders.getById(orderId);
  if (
    current &&
    current.status === "PENDING" &&
    orderHasEnteredCheckout(current)
  ) {
    return "ORDER_HAS_PAYMENT_INTENT";
  }
  return "ORDER_NOT_PENDING";
}

export async function updateOrderItems(
  deps: UpdateOrderItemsDeps,
  rawInput: unknown,
): Promise<UpdateOrderItemsOutput> {
  const logger = deps.logger?.child({ useCase: "updateOrderItems" });

  const execute = async () => {
    const input = parseInput(updateOrderItemsInputSchema, rawInput);
    // Pure and cheap: refuse a two-amount tier before the tax provider call
    // below, not only inside the transaction.
    assertOneDonationAmountPerTier(input.items);
    const now = deps.clock.now();

    // ── Fee waiver headroom (read-only, BEFORE the transaction) ─────────────
    // Best-effort, so it must not run on the transaction: a failed lookup
    // swallowed there aborts it, and the hold's next statement fails with
    // 25P02 blamed on the wrong line. Inside, only the pure cap is computed.
    const waiverHeadroom = await lookupFeeWaiverHeadroomForHold({
      repos: deps.repos,
      eventId: input.eventId,
      buyerHumanId: input.actorHumanId,
      now,
      logger,
      reportError: deps.reportError ?? undefined,
    });

    // The tax self-heal stamp is recorded inside the transaction and written
    // after it commits (a swallowed failed write inside would condemn it).
    const taxAfterCommit = newCheckoutTaxAfterCommit();
    // The tax-provider lookup (live HTTP on a cache miss) runs before the
    // hold's transaction, never while it holds the seat / order locks.
    //
    // It is paid for per attempt (nothing is cached for a refused one), so a
    // request the transaction will refuse must not reach it. `prepareCheckoutTax`
    // covers the event-side refusals (unpublished, RSVP, sales closed); the
    // order-side ones are one cheap read here, the same checks the transaction
    // opens with. The transaction re-checks them authoritatively.
    const preparedTax = (await orderWillBeRefused(deps, input))
      ? undefined
      : await prepareCheckoutTax(
          {
            repos: deps.repos,
            taxRateLookup: deps.taxRateLookup,
            clock: deps.clock,
            reportError: deps.reportError ?? undefined,
          },
          input.eventId,
          logger,
          // A hand-entered rate is quoted as is: the hold is display-only and
          // runs on every cart edit; `createCheckout` asks the provider again
          // at the charge (owner ruling R5).
          { manualStamp: "keep" },
        );

    const { order, holdExpiresAt, buyerFeesCents, processorFeeCents } =
      await deps.repos.tx(async (tx) => {
        const existing = input.orderId
          ? await tx.orders.getById(input.orderId)
          : null;
        if (input.orderId && !existing) {
          throw fail("ORDER_NOT_FOUND");
        }

        if (existing) {
          if (existing.buyerHumanId !== input.actorHumanId) {
            throw fail("ORDER_NOT_OWNED");
          }

          if (existing.status !== "PENDING") {
            throw fail("ORDER_NOT_PENDING");
          }

          if (existing.eventId !== input.eventId) {
            throw fail("ORDER_EVENT_MISMATCH");
          }

          // Once `createCheckout` has minted a PaymentIntent for this cart,
          // the PI's amount is fixed at the order's amount AT THAT MOMENT.
          // Re-pricing the lines here would leave PI amount != order amount,
          // and `finalizePaymentIntent` refuses that with AMOUNT_MISMATCH
          // into the DLQ — buyer charged the old amount, no tickets minted.
          // The client must re-run `createCheckout` with `pendingOrderId`
          // (which retires this cart and mints a fresh PI) instead. The web
          // client already does; this is the API-level guard (money audit
          // 2026-09-08 #11). Checked BEFORE any further read so a refusal
          // touches nothing.
          //
          // Also refused while that PI is still being created: see
          // `orderHasEnteredCheckout`.
          if (orderHasEnteredCheckout(existing)) {
            throw fail("ORDER_HAS_PAYMENT_INTENT");
          }
        }

        const event = await ensureEventOnSale(tx, input.eventId, now);

        // FR-003/FR-012 (community-managed-event-listings): RSVP events have
        // no ticket types or orders — defensively reject cart holds too.
        if (event.attendanceMode === "RSVP") {
          throw fail("EVENT_NOT_TICKETED");
        }

        await ensureEventAccessible(tx, event, input.actorHumanId);
        const currency = (
          existing?.currency ??
          event.currency ??
          "usd"
        ).toLowerCase();
        const agreementContext = await loadAgreementContext(tx, event.id, now, {
          logger: deps.logger,
          reportError: deps.reportError,
        });
        const ticketTypes = await tx.events.listTicketTypes(event.id);

        const activeTicketTypes = ticketTypes.filter(
          (ticketType) => ticketType.status === "ACTIVE",
        );
        if (activeTicketTypes.length === 0) {
          throw fail("NO_TICKET_TYPES");
        }

        const ticketTypeMap = new Map<string, TicketTypeSummary>(
          activeTicketTypes.map((tt) => [
            tt.id,
            {
              id: tt.id,
              priceCents: tt.priceCents,
              pricingMode: tt.pricingMode,
              minimumCents: tt.minimumCents,
              seatSectionId: tt.seatSectionId ?? null,
              // Raw schedule — resolved by computeOrderAmounts at `now`, so a
              // cart re-priced after the flip quotes the post-flip price.
              scheduledPriceCents: tt.scheduledPriceCents,
              scheduledPriceAt: tt.scheduledPriceAt,
              // Raw window — enforced by computeOrderAmounts at the same `now`
              // (FR-014).
              salesOpenAt: tt.salesOpenAt,
              salesCloseAt: tt.salesCloseAt,
            },
          ]),
        );

        const aggregatedItems = aggregateItems(input.items);
        // Per-seat overrides, read unlocked to price the hold; both passes
        // use them, and `holdSeatsForCheckout` re-checks them under the lock.
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
        // The buyer's quoted seat prices must be the priced ones (D-007),
        // checked before the hold so a refusal leaves no seat held.
        assertSeatQuotesMatch(
          orderComputation.items,
          collectSeatQuotes(input.items),
          ticketTypeMap,
        );

        // ── Fee waiver (estimate) ──────────────────────────────────────────
        // Price the hold the way `createCheckout` will charge: its two-pass
        // waiver (price → allowance → re-price with `waivedTickets`), minus
        // the reservation — the charge reserves; the hold only estimates.
        // Without this, step 2 quoted the full platform fee and the total
        // dropped at payment. The allowance was looked up before the
        // transaction; this is the pure cap.
        const waivedTickets = waivedTicketsForHold(
          orderComputation,
          waiverHeadroom.headroomTickets,
        );
        if (waivedTickets > 0) {
          orderComputation = computeOrderAmounts(
            aggregatedItems,
            ticketTypeMap,
            agreementContext,
            {
              now,
              waivedTickets,
              reportError: deps.reportError,
              seatPrices,
            },
          );
        }

        // ── Held processor-fee estimate (display only) ──────────────────────
        // Align the held order's processor fee with what create-checkout will
        // actually charge (absent promo/credit, which aren't known at hold time).
        // For PASS_THROUGH the buyer funds the processor fee via an EXACT
        // gross-up over the post-tax base (ticket gross + platform fee + tax),
        // mirroring create-checkout. For ABSORB nothing extra is charged, so the
        // simple markup from computeOrderAmounts stands. Tax is computed here the
        // same way create-checkout does, but is NOT persisted on the order.
        // If the event was never stamped at publish time, a best-effort
        // last-chance lookup self-heals it here too (non-blocking, 0 on failure).
        const checkoutTax = await resolveCheckoutTax(
          {
            taxRateLookup: deps.taxRateLookup,
            clock: deps.clock,
            // This use case types its reporter as `| null`; the tax deps take
            // `| undefined`. Normalise rather than widen the shared deps type.
            reportError: deps.reportError ?? undefined,
          },
          tx,
          event,
          logger,
          taxAfterCommit,
          preparedTax,
        );
        // THE pricing pipeline create-checkout charges with (`priceComputedCart`,
        // channel ONLINE; spec 2026-10-07 door-sales FR-001: the pipeline
        // lives nowhere else), including the jurisdictional taxable base and
        // every imposition — a hold that quoted tax on the face while the
        // charge taxed the buyer total would move the total under the buyer
        // between the two steps. No promo: the hold carries none (the charge
        // evaluates codes).
        //
        // Only the processor-fee figure is kept: the held order does not
        // persist tax (the charge re-resolves it), and its lines and amounts
        // stay the face computation's — the per-item processor-fee spread is
        // the charge's to write. The fee has to be solved WITH the tax or the
        // held estimate drifts from what create-checkout charges.
        const estimatedProcessorFeeCents = priceComputedCart({
          channel: "ONLINE",
          computation: orderComputation,
          payoutTerms: agreementContext,
          now,
          taxImpositions: checkoutTax.impositions,
        }).processorFeeDisplayCents;

        // Stamped from the SAME `now` that `holdSeatsForCheckout` writes the
        // seat `updatedAt` with, below and in this transaction.
        // `resolveSeatHoldFence` inverts this (`holdExpiresAt − TTL`) to
        // recover when this cart last took its seats — which is the ONLY
        // record of that instant, since this use case re-holds without
        // rewriting `occurredAt`. See the "KEEP THE TWO IN STEP" note in
        // `_shared/cart-seat-release.ts`.
        const holdExpiresAt = new Date(
          now.getTime() + ORDER_HOLD_TTL_SECONDS * 1000,
        );
        const holdIso = holdExpiresAt.toISOString();

        // ── Capacity gate ───────────────────────────────────────────────────
        // A cart hold is a reservation, so it has to be refused for the same
        // reason a charge is: stamping `holdExpiresAt` on lines that exceed
        // what's left would let the buyer walk to the payment step believing
        // the stock is theirs, and only discover otherwise post-charge in the
        // mint webhook.
        //
        // Runs BEFORE the seat release/hold below so the capacity lock is
        // always taken ahead of any Seat lock — the ordering POS uses. Two
        // paths locking these in opposite orders can deadlock.
        //
        // `existing` is excluded: it was validated above as this actor's own
        // PENDING order for this event, and its current lines are exactly the
        // stock being re-priced. Counting them would refuse the buyer their
        // own cart.
        await assertTicketTypeCapacity(tx, {
          requests: aggregatedItems.map((item) => ({
            ticketTypeId: item.ticketTypeId,
            qty: item.qty,
          })),
          ticketTypesById: new Map(
            activeTicketTypes.map((tt) => [tt.id, tt] as const),
          ),
          now,
          excludeOrderId: existing?.id ?? null,
        });

        if (existing) {
          const previousSeatIds = existing.items
            .filter((item) => item.kind === "ticket")
            .flatMap((item) => extractSeatIdsFromMeta(item.meta));

          if (previousSeatIds.length > 0) {
            // ── Fenced, because these seats may no longer be ours ─────────
            // `existing` is a PENDING cart that can be up to the cart TTL
            // (1200s) old, and the seat-hold TTL is only 900s. So the seat
            // reaper may already have freed these seats and another buyer may
            // be holding — or have PAID for — one of them. An unfenced
            // release here hands that seat back to the pool under a live
            // PaymentIntent: sold twice, minted once.
            //
            // The fence is this cart's OWN last hold instant plus a small
            // slack (see `resolveSeatHoldFence`), which is why it is derived
            // from `meta.holdExpiresAt` and not from `occurredAt`: THIS use
            // case re-holds on every edit without rewriting `occurredAt`, and
            // an `occurredAt` fence would decline the buyer's own second edit
            // and then fail their re-hold with `seat_unavailable`.
            //
            // A declined seat stays HELD, so if the buyer re-requests it
            // `holdSeatsForCheckout` refuses with `seat_unavailable` — which
            // is the correct answer, because somebody else holds it.
            const heldBefore = resolveSeatHoldFence(existing);

            if (heldBefore) {
              await tx.seats.releaseSeats({
                seatIds: previousSeatIds,
                releasedAt: now,
                heldBefore,
              });
            } else {
              // Unreachable through the Prisma repo (`occurredAt` is NOT NULL
              // and always mapped). Reported rather than released unfenced:
              // an ownership-blind release is the double-sell above, and the
              // seat reaper frees these seats anyway.
              logger?.error("update_order_items_seat_fence_missing", {
                orderId: existing.id,
                seatCount: previousSeatIds.length,
              });
              reportBestEffort(
                deps.reportError,
                new Error("update_order_items_seat_fence_missing"),
                {
                  tags: {
                    area: "checkout",
                    step: "releasePreviousSeats",
                    useCase: "updateOrderItems",
                  },
                  extra: {
                    orderId: existing.id,
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

        // Track per-ticketType seat index so each per-ticket OrderItem
        // (qty=1) receives only its own seat, not the full hold list.
        const seatIndexByType = new Map<string, number>();

        const heldItems = orderComputation.items.map((item) => {
          if (item.kind !== "ticket") {
            return item;
          }
          const meta = (item.meta ?? {}) as Record<string, unknown>;
          meta.holdExpiresAt = holdIso;
          const hold = item.ticketTypeId
            ? seatHolds.get(item.ticketTypeId)
            : undefined;
          if (hold && hold.seatIds.length > 0) {
            const idx = seatIndexByType.get(item.ticketTypeId!) ?? 0;
            seatIndexByType.set(item.ticketTypeId!, idx + 1);

            const seatId = heldSeatIdForItem(meta, hold, idx);
            if (seatId) {
              meta.seatIds = [seatId];
              meta.seatHoldExpiresAt = hold.expiresAt.toISOString();
            }
          }
          return { ...item, meta };
        });

        // FR-003 (organiser-resale-share): each ticket records the event's
        // resale clause in force now, read in this transaction. A cart edit
        // re-prices every line at today's prices and REPLACES the cart's
        // items, so it re-stamps the record from the same read (nothing is
        // sold until the cart is paid; the clause and the price move
        // together).
        const resaleClause = await resolveTicketResaleClause(tx, event);
        const updatedItems = stampTicketResaleClause(heldItems, resaleClause);

        const feePolicySnapshot = buildFeePolicySnapshot(agreementContext, now);

        if (!existing) {
          const created = await tx.orders.createPending({
            eventId: event.id,
            buyerHumanId: input.actorHumanId,
            amountGrossCents: orderComputation.amountGrossCents,
            feesPlatformCents: orderComputation.feesPlatformCents,
            currency,
            feePolicySnapshot,
            source: "PRIMARY",
            items: updatedItems,
          });

          const order = await tx.orders.getById(created.id);
          if (!order) {
            throw fail("ORDER_NOT_FOUND");
          }

          await tx.audit.log({
            entity: "order",
            entityId: order.id,
            action: "pending_created",
            data: {
              eventId: event.id,
              buyerHumanId: input.actorHumanId,
              amountGrossCents: order.amountGrossCents,
              feesPlatformCents: order.feesPlatformCents,
              currency,
              holdExpiresAt: holdIso,
              items: updatedItems,
            },
            at: now,
          });

          return {
            order,
            holdExpiresAt: holdIso,
            buyerFeesCents: orderComputation.buyerFeesCents,
            processorFeeCents: estimatedProcessorFeeCents,
          };
        }

        const updated = await tx.orders.updatePendingItems({
          orderId: existing.id,
          amountGrossCents: orderComputation.amountGrossCents,
          feesPlatformCents: orderComputation.feesPlatformCents,
          currency,
          feePolicySnapshot,
          items: updatedItems,
        });
        if (!updated) {
          // The order left the cart state between the check at the top of
          // this transaction and the guarded write (finalize, checkout or
          // expiry won the race). Same refusals as the up-front check; the
          // throw rolls back the seat and capacity work done above.
          throw fail(await refusalForLostCart(tx, existing.id));
        }

        await tx.audit.log({
          entity: "order",
          entityId: updated.id,
          action: "pending_updated",
          data: {
            eventId: updated.eventId,
            buyerHumanId: updated.buyerHumanId,
            amountGrossCents: updated.amountGrossCents,
            feesPlatformCents: updated.feesPlatformCents,
            currency: updated.currency,
            holdExpiresAt: holdIso,
            items: updatedItems,
          },
          at: now,
        });

        return {
          order: updated,
          holdExpiresAt: holdIso,
          buyerFeesCents: orderComputation.buyerFeesCents,
          processorFeeCents: estimatedProcessorFeeCents,
        };
      });

    await applyCheckoutTaxSelfHeal(
      { repos: deps.repos, reportError: deps.reportError ?? undefined },
      taxAfterCommit,
      logger,
    );

    return updateOrderItemsOutputSchema.parse({
      order: serializeOrder(order, buyerFeesCents, processorFeeCents),
      holdExpiresAt,
    });
  };

  if (logger) {
    return logger.withTime("updateOrderItems", execute);
  }

  return execute();
}

function serializeOrder(
  order: OrderRecord,
  buyerFeesCents: number,
  processorFeeCents: number,
): UpdateOrderItemsOutput["order"] {
  return {
    id: order.id,
    eventId: requireTicketingEventId(order),
    buyerHumanId: order.buyerHumanId,
    amountGrossCents: order.amountGrossCents,
    feesPlatformCents: order.feesPlatformCents,
    buyerFeesCents,
    processorFeeCents,
    currency: order.currency,
    status: order.status,
    items: order.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      ticketTypeId: item.ticketTypeId,
      qty: item.qty,
      unitPriceCents: item.unitPriceCents,
      amountCents: item.amountCents,
      meta: item.meta ?? {},
    })),
  };
}
