import { z } from "zod";
import { donationAmountCentsSchema } from "../../lib/pricing/pay-what-you-want";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";
import type { PaymentProcessorPort } from "@th/ports/payment-processor-port";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { TaxRateLookupPort } from "@th/ports/tax-rate-lookup";
import { SCANNER_TERMS_VERSION } from "@th/types";

import { asKnownError } from "../../lib/errors";
import { resolveSeatHoldFence } from "../orders/_shared/cart-seat-release";
import { describeError, parseInput } from "../../lib/io";
import { buildPaymentDescription } from "../../lib/payments/payment-description";
import { ORG_SCAN_ROLES, requireScannerAccessOnOrg } from "../../lib/rbac";
import { assertTicketTypeOnSale } from "../../lib/orders/door-pricing";
import {
  aggregateItems,
  computeOrderAmounts,
  loadPayoutTermsContext,
  unseatedSeatPrices,
} from "../orders/checkout-helpers";
import {
  createPromoHolds,
  evaluatePromoApplications,
  preparePromoCodes,
} from "../orders/checkout-promos";
import { reserveFeeWaiverForCheckout } from "../orders/fee-waiver-checkout";
import { priceCart } from "../orders/_shared/price-cart";
import {
  resolveTicketResaleClause,
  stampTicketResaleClause,
} from "../orders/_shared/resolve-ticket-resale-clause";
import {
  applyCheckoutTaxSelfHeal,
  newCheckoutTaxAfterCommit,
  prepareCheckoutTax,
  resolveCheckoutTax,
  type PreparedCheckoutTax,
} from "../orders/_shared/resolve-checkout-tax-rate";
import {
  assertPosCapacity,
  POS_HELD_WINDOW_SECONDS,
} from "./assert-pos-capacity";
import { assertCanSellBeforeTaxLookup } from "./_shared/assert-can-sell-before-tax-lookup";
import { withManualTaxRateHint } from "./_shared/manual-tax-rate-hint";
import { toDoorTicketTypeSummaries } from "./_shared/door-ticket-types";
import { doorBuyerEmailSchema, resolveDoorBuyer } from "./_shared/door-buyer";
import {
  assertDoorSellsEvent,
  lockDoorEvent,
} from "./_shared/door-event-gate";
import { fail } from "@th/errors";

// ── Schema ───────────────────────────────────────────────────────────────────

export const startPosSaleInputSchema = z.object({
  actorHumanId: z.string().uuid(),
  eventId: z.string().uuid(),
  /** Stable client-supplied key for idempotency. */
  clientKey: z.string().min(8).max(128),
  items: z
    .array(
      z.object({
        ticketTypeId: z.string().uuid(),
        qty: z.number().int().positive().max(100),
        /**
         * Buyer-entered amount per ticket for ADJUSTABLE-pricing types.
         * Required when the resolved ticket type is ADJUSTABLE; ignored
         * when FIXED. Server validates `>= minimumCents`. Mirrors the
         * `donationAmountCents` field on the web checkout cart input.
         */
        // Capped at MAX_DONATION_AMOUNT_CENTS ($10,000.00 per ticket), the
        // same shared schema online checkout uses.
        donationAmountCents: donationAmountCentsSchema.optional(),
      }),
    )
    .nonempty(),
  /**
   * Operator-entered promo codes (FR: door discounts). Evaluated by the
   * same `evaluatePromoApplications` path as web checkout — one discount
   * computation, one PromoHold/PromoRedemption ledger.
   */
  promoCodes: z.array(z.string().min(1).max(64)).max(4).optional(),
  /**
   * Optional buyer email (spec 2026-10-07 door-sales FR-011, owner ruling
   * R7). Given, the order is recorded against that address the way guest
   * checkout records one (`resolveDoorBuyer`) and, once the payment webhook
   * finalises the order, the buyer is emailed the ticket and an itemised
   * receipt. No account is created and no marketing consent recorded.
   */
  buyerEmail: doorBuyerEmailSchema,
});

export type StartPosSaleInput = z.infer<typeof startPosSaleInputSchema>;

export const startPosSaleOutputSchema = z.object({
  orderId: z.string().uuid(),
  /** PaymentIntent client_secret for the Terminal SDK to confirm. */
  clientSecret: z.string().min(1),
  /**
   * Amount the card is charged, in cents: what online checkout charges for
   * the same cart (ticket prices minus promo discount, plus platform fee,
   * tax and processing fee). Equals the PaymentIntent amount.
   */
  amountCents: z.number().int().positive(),
  /** Total promo discount applied, in cents. 0 when no codes were given. */
  discountCents: z.number().int().nonnegative(),
  currency: z.string().min(3).max(3),
});

export type StartPosSaleOutput = z.infer<typeof startPosSaleOutputSchema>;

// ── Deps ─────────────────────────────────────────────────────────────────────

export type StartPosSaleDeps = {
  repos: Repos;
  authz: AuthZPort;
  payments: PaymentProcessorPort;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  metrics?: MetricsPort;
  /**
   * Sentry-style reporter for the best-effort unwind swallow branches and
   * the tax resolver's reports.
   */
  reportError?: ReporterPort;
  /**
   * Tax provider (ZipTax), for an event never stamped at publish time. The
   * same port online checkout gets; without it an unstamped event prices at
   * 0% exactly as checkout does in a deployment with no provider.
   */
  taxRateLookup?: TaxRateLookupPort | null;
};

const IDEMPOTENCY_TTL_SECONDS = 120;
const IDEMPOTENCY_KEEP_SECONDS = 86_400;

interface StoredStartPosSaleRecord {
  payloadHash: string;
  response: StartPosSaleOutput;
}

// ── Use case ─────────────────────────────────────────────────────────────────

/**
 * Begin a Tap-to-Pay sale (FR-003 card path, NFR-003).
 *
 * Per decision D-2026-04-26 (separate-charge-and-transfer):
 *   - The PaymentIntent is created on the platform account, NOT
 *     on_behalf_of the connected account. No `application_fee_amount`.
 *     Funds land on the platform balance; the payout batch
 *     (`settlements.run-batch`) moves them to the connected account on
 *     the event's payout schedule.
 *   - PaymentIntent is pinned to `payment_method_types=["card_present"]`
 *     and `capture_method=automatic`.
 *   - PI metadata carries `destinationAccountId`,
 *     `paymentChannel="POS"`, plus the standard orderId/eventId so the
 *     existing finalize-from-payment-intent webhook handler routes the
 *     order through the same pipeline as web checkout.
 *
 * The Order is created PENDING; finalisation (status SUCCEEDED, mint
 * tickets, write Settlement) is driven by the
 * `payment_intent.succeeded` webhook against the existing
 * `finalizePaymentIntent` use case. Auto-admit on POS sales is wired in
 * M6 inside that finaliser.
 *
 * Pricing (spec 2026-10-07 door-sales-same-price-and-tax, FR-002): the
 * cart is priced by `priceCart` (channel DOOR_CARD) from the same payout
 * terms, fee waiver, promo evaluation and tax resolution online checkout
 * uses, so the buyer pays what the event page charges: face net of
 * discount, plus platform fee, tax and processing fee (owner ruling R2).
 * The tax lookup runs before the transaction (`prepareCheckoutTax`, door
 * channel) and a failed lookup refuses with TAX_RATE_UNAVAILABLE (R5).
 *
 * Auth: ORG_SCAN_ROLES on event's org. Personal events are rejected.
 *
 * Idempotency: `pos:{actorHumanId}:{clientKey}`, 2-min TTL,
 * payload-hash collision check (matches the web checkout pattern).
 *
 * Gating:
 *   - Org Payee must exist and have chargesEnabled=true.
 *   - The connected account's `card_present` capability is enforced by
 *     Stripe at PI create time; failures propagate to the operator with
 *     the Stripe error code so the Sell screen can surface
 *     "POS not enabled — contact your org owner".
 */
export async function startPosSale(
  deps: StartPosSaleDeps,
  rawInput: unknown,
): Promise<StartPosSaleOutput> {
  const input = parseInput(startPosSaleInputSchema, rawInput);
  const idempKey = `pos:${input.actorHumanId}:${input.clientKey}`;
  deps.metrics?.increment("pos.start_sale.attempt", { eventId: input.eventId });
  // Normalize codes BEFORE hashing so "save10" and "SAVE10 " replay as the
  // same request. preparePromoCodes also rejects duplicate codes up front.
  const promoCodes = preparePromoCodes(input.promoCodes);
  const payloadHash = JSON.stringify({
    actor: input.actorHumanId,
    event: input.eventId,
    // `d` is load-bearing on PRICE for an ADJUSTABLE tier, so it belongs in
    // the hash for the same reason the promo codes below do: without it a
    // replayed clientKey carrying a different pay-what-you-can amount would
    // silently return the cached, differently-priced sale instead of
    // conflicting.
    items: input.items.map((i) => ({
      tt: i.ticketTypeId,
      q: i.qty,
      d: i.donationAmountCents ?? null,
    })),
    // Included so a replayed clientKey with different codes conflicts
    // instead of silently returning the cached (differently-priced) sale.
    promos: promoCodes.map((c) => c.normalized),
    // Whose ticket it is: a replay naming a different buyer conflicts.
    // Omitted when absent, so a sale without one hashes as it always did.
    ...(input.buyerEmail ? { email: input.buyerEmail } : {}),
  });

  const replay = await deps.idempotency.get<StoredStartPosSaleRecord>(idempKey);
  if (replay) {
    if (replay.payloadHash !== payloadHash) {
      throw fail("IDEMPOTENCY_KEY_CONFLICT");
    }
    return startPosSaleOutputSchema.parse(replay.response);
  }

  const claimed = await deps.idempotency.begin(
    idempKey,
    IDEMPOTENCY_TTL_SECONDS,
  );
  if (!claimed) {
    const after =
      await deps.idempotency.get<StoredStartPosSaleRecord>(idempKey);
    if (after) {
      if (after.payloadHash !== payloadHash) {
        throw fail("IDEMPOTENCY_KEY_CONFLICT");
      }
      return startPosSaleOutputSchema.parse(after.response);
    }
    throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
  }

  // Hoisted so the OUTER catch can unwind whatever actually got committed.
  // Inner per-phase catches used to do this, which left every failure AFTER
  // the last inner catch — idempotency.commit, the output parse — silently
  // leaking a PENDING order and a confirmable PaymentIntent.
  let orderPlan: Awaited<ReturnType<typeof planOrder>> | null = null;
  let pi: { paymentIntentId: string; clientSecret: string } | null = null;
  let settled = false;

  // The tax self-heal stamp and location cache a fresh lookup produced are
  // recorded inside the transaction and written after it commits, exactly as
  // checkout does.
  const taxAfterCommit = newCheckoutTaxAfterCommit();

  const planOrder = async (preparedTax: PreparedCheckoutTax) =>
    await deps.repos.tx(async (tx) => {
      // First in the transaction: serializes this sale with a cancellation
      // of the event (see `lockDoorEvent`).
      await lockDoorEvent(tx, input.eventId);
      const event = await tx.events.getById(input.eventId);
      if (!event) {
        throw fail("EVENT_NOT_FOUND");
      }
      if (!event.orgId) {
        throw fail("EVENT_NOT_ORG_OWNED");
      }

      const access = await requireScannerAccessOnOrg({
        repos: tx,
        authz: deps.authz,
        orgId: event.orgId,
        actorHumanId: input.actorHumanId,
        roles: ORG_SCAN_ROLES,
        errorCode: "INSUFFICIENT_ROLE",
      });

      // The door sells published events only (owner ruling 2026-10-07).
      assertDoorSellsEvent(event);

      const operator = await tx.humans.getById(input.actorHumanId);
      if (
        !operator?.scannerTermsAckAt ||
        operator.scannerTermsAckVersion !== SCANNER_TERMS_VERSION
      ) {
        throw fail("SCANNER_TERMS_REQUIRED");
      }

      if (access.via === "platform_admin") {
        await tx.audit.log({
          entity: "pos_sale",
          entityId: input.eventId,
          action: "pos.start_sale.platform_admin_override",
          at: deps.clock.now(),
          data: {
            actorHumanId: input.actorHumanId,
            eventId: input.eventId,
            orgId: event.orgId,
            clientKey: input.clientKey,
            itemCount: input.items.length,
          },
        });
      }

      const payeeRef = await tx.payees.getBySubject({
        type: "ORGANIZATION",
        id: event.orgId,
      });
      if (!payeeRef) {
        throw fail("PAYEE_NOT_CONNECTED");
      }
      const payee = await tx.payees.getById(payeeRef.id);
      if (!payee?.stripeAccountId) {
        throw fail("PAYEE_MISSING_STRIPE_ACCOUNT");
      }
      if (!payee.chargesEnabled) {
        throw fail("PAYEE_CHARGES_DISABLED");
      }

      // `listTicketTypes` returns EVERY status — admin surfaces need the
      // unpublished ones — so the sellable set is narrowed HERE. Sellable =
      // `status === "ACTIVE"`, the same rule `listSellableItems` uses to
      // build the till screen (and the public page uses to display), so what
      // the till can sell is exactly what it shows. A DRAFT (archived or
      // unpublished) type named by id falls out of `ttById` and is refused as
      // TICKET_TYPE_NOT_FOUND below, before any lock is taken or any order
      // exists (money audit 2026-09-08 #14).
      const ticketTypes = (await tx.events.listTicketTypes(event.id)).filter(
        (tt) => tt.status === "ACTIVE",
      );
      const ttById = new Map(ticketTypes.map((tt) => [tt.id, tt]));
      const now = deps.clock.now();

      // One line per ticket type, merged the way checkout merges a cart (and
      // refused the way checkout refuses two different pay-what-you-want
      // amounts for one type). Seats are assigned by the till below, never
      // named by the operator.
      const aggregatedItems = aggregateItems(
        input.items.map((it) => ({
          ticketTypeId: it.ticketTypeId,
          qty: it.qty,
          ...(it.donationAmountCents !== undefined
            ? { donationAmountCents: it.donationAmountCents }
            : {}),
        })),
      );

      for (const it of aggregatedItems) {
        const tt = ttById.get(it.ticketTypeId);
        if (!tt) {
          // The code the capacity gate used to give this, when it ran first.
          throw fail("TICKET_TYPE_NOT_FOUND");
        }
        // Sales window (FR-014) — refuse BEFORE pricing, locking or holding
        // seats, at the sale's single `now`. The POS deliberately has NO
        // event-level sales close (door sales happen after the event starts),
        // so a per-type window is the ONLY window gate here; that is exactly
        // what makes "Advance closes 14 days out, Door opens at doors" work at
        // the till. Throwing here aborts the whole transaction, so no seat
        // hold, order or line survives a refusal.
        assertTicketTypeOnSale(tt, now, {
          meta: { ticketTypeId: it.ticketTypeId, eventId: event.id },
          onUnparseableBound: deps.reportError
            ? ({ field, meta }) =>
                deps.reportError?.(
                  new Error(`ticket_type_sales_window_unparseable:${field}`),
                  {
                    tags: { area: "pos", field },
                    // The POS has NO event-level sales close, so this window is
                    // the ONLY gate at a till — an unevaluatable bound here
                    // sells forever with no other backstop.
                    extra: { ...meta, surface: "startPosSale" },
                  },
                )
            : undefined,
        });
      }

      // ── Price the cart: THE checkout pipeline ─────────────────────────
      // Spec 2026-10-07 FR-001/FR-002, owner ruling R2: card at the door =
      // online. The same payout terms + fee policy, the same fee waiver, the
      // same promo evaluation and the same tax resolution feed the same
      // `priceCart` checkout prices through, so the door charges exactly what
      // the event page charges for the same cart. Nothing below computes a
      // price, fee or tax of its own.
      //
      // LOCK ORDER matches online checkout: fee-waiver allowance first, then
      // ticket-type capacity, then seats (create-checkout.ts takes them in
      // that order, and two paths taking them in opposite orders deadlock).
      const ticketTypeMap = toDoorTicketTypeSummaries(ticketTypes);
      const payoutTerms = await loadPayoutTermsContext(tx, event.id, now, {
        logger: deps.logger,
        reportError: deps.reportError,
      });

      // First pass, waiver-free and pure: prices every line (pay-what-you-
      // want amounts validated, scheduled prices resolved at this sale's
      // `now`) before any lock or seat hold, for the promo evaluation and
      // (when no discount applies) the fee-waiver reservation's ladder. The
      // window gate above already reported an
      // unparseable bound, so no reporter here (it would report it twice).
      // The door names no seats (seats are auto-picked below, at the tier
      // price): a cart that does is refused rather than priced without its
      // seat overrides (seat-price-overrides spec R-004).
      const seatPrices = unseatedSeatPrices(aggregatedItems);
      const faceComputation = computeOrderAmounts(
        aggregatedItems,
        ticketTypeMap,
        payoutTerms,
        { now, seatPrices },
      );

      if (faceComputation.amountGrossCents <= 0) {
        // POS card path requires a non-zero amount. $0 sales are the
        // cash/comp path (FR-015) — not Stripe Terminal.
        throw fail("AMOUNT_MUST_BE_POSITIVE");
      }

      // ── Promo evaluation ──────────────────────────────────────────
      // Same computation path and same ledger as web checkout. The
      // buyer is a per-sale phantom Human (created below), so the
      // per-human redemption cap cannot meaningfully bind at the door —
      // pass null (the anonymous-preview convention) and rely on the
      // global maxRedemptions cap, which getRedemptionStats enforces
      // regardless of buyer identity. A waiver never changes the face, so
      // the waiver-free lines are the lines checkout evaluates too.
      //
      // BEFORE the fee waiver, as checkout does it: a ticket a discount
      // brings down to $0 pays no platform fee (owner ruling 2026-10-10), so
      // it must be off the ladder the reservation is priced against. Reads
      // only, no lock: the waiver is still the first lock taken.
      const promoEvaluation = await evaluatePromoApplications({
        codes: promoCodes,
        tx,
        event,
        buyerHumanId: null,
        now,
        orderSubtotalCents: faceComputation.amountGrossCents,
        ticketLines: faceComputation.ticketLines,
        ...(deps.logger ? { logger: deps.logger } : {}),
      });

      if (
        faceComputation.amountGrossCents - promoEvaluation.totalDiscountCents <=
        0
      ) {
        // A discount that zeroes the charge can't ride Stripe Terminal.
        // The operator should record it as a cash/comp sale instead.
        throw fail("AMOUNT_MUST_BE_POSITIVE");
      }

      // ── Fee waiver (lock 1) ───────────────────────────────────────
      // An ORGANIZER-side allowance covers every buyer at the org's events,
      // the door included (the phantom buyer can hold no BUYER-side one).
      // Keyed to an order id minted here, as checkout does; released by the
      // unwind, `cancelPosSale`, the expired-cart reaper and refunds.
      //
      // The ladder comes from the cart priced WITH the discounts, which is
      // what `priceCart` charges below: same items, same `now`, so the two
      // agree on which tickets carry a fee.
      const orderId = crypto.randomUUID();
      const feeWaiver = await reserveFeeWaiverForCheckout({
        tx,
        event,
        orderId,
        buyerHumanId: null,
        computation:
          promoEvaluation.ticketDiscounts.length > 0
            ? computeOrderAmounts(aggregatedItems, ticketTypeMap, payoutTerms, {
                now,
                seatPrices,
                discounts: promoEvaluation.ticketDiscounts,
              })
            : faceComputation,
        now,
        logger: deps.logger,
      });

      // ── Tax ───────────────────────────────────────────────────────
      // The read half of checkout's resolution, on this transaction, from
      // the lookup `prepareCheckoutTax` ran BEFORE it (NFR-002). A failed
      // lookup was already refused there with TAX_RATE_UNAVAILABLE.
      const taxResolution = await resolveCheckoutTax(
        {
          taxRateLookup: deps.taxRateLookup,
          clock: deps.clock,
          reportError: deps.reportError,
        },
        tx,
        event,
        deps.logger,
        taxAfterCommit,
        preparedTax,
      );
      const taxSitus = taxResolution.situs;

      // ── Capacity (lock 2) ─────────────────────────────────────────
      // Refuse an overselling cart BEFORE the PaymentIntent exists. Minting
      // happens in the payment_intent.succeeded webhook, so a capacity failure
      // discovered there means the buyer has already been charged for a ticket
      // that no longer exists. This takes a row lock per ticket type, held for
      // the rest of this transaction.
      await assertPosCapacity(tx, {
        requests: input.items.map((it) => ({
          ticketTypeId: it.ticketTypeId,
          qty: it.qty,
        })),
        ticketTypesById: ttById,
        now,
      });

      // ── Seats (lock 3) ────────────────────────────────────────────
      // Auto-assign seats for RESERVED-section ticket types. Picks are
      // flipped to HELD below so the section can't be double-sold while
      // the PaymentIntent is in flight. The PI-succeeded webhook mints
      // tickets, which transitions the seats to SOLD; PI failures fall
      // back on the expired-holds reaper.
      const seatIdsByType = new Map<string, string[]>();
      const heldSeatIds: string[] = [];
      for (const it of aggregatedItems) {
        const tt = ttById.get(it.ticketTypeId);
        if (!tt?.seatSectionId) continue;
        const section = await tx.seats.getSectionById(tt.seatSectionId);
        if (section?.type !== "RESERVED") continue;
        const picked = await tx.seats.pickContiguousAvailable({
          seatSectionId: tt.seatSectionId,
          eventId: event.id,
          qty: it.qty,
        });
        if (picked.length !== it.qty) {
          throw {
            code: "conflict",
            message: "seat_unavailable",
            ticketTypeId: it.ticketTypeId,
          } as const;
        }
        const seatIds = picked.map((s) => s.id);
        seatIdsByType.set(it.ticketTypeId, seatIds);
        heldSeatIds.push(...seatIds);
      }

      // Read ONCE and carried out on the plan. `abandonFailedSale` fences its
      // release on this exact instant, and a second `clock.now()` there would
      // fence on a stamp the seats never carried.
      let seatsHeldAt: Date | null = null;
      if (heldSeatIds.length > 0) {
        seatsHeldAt = deps.clock.now();
        await tx.seats.updateStatuses({
          seatIds: heldSeatIds,
          status: "HELD",
          updatedAt: seatsHeldAt,
        });
      }

      const priced = priceCart({
        channel: "DOOR_CARD",
        items: aggregatedItems,
        ticketTypes: ticketTypeMap,
        seatPrices,
        payoutTerms,
        now,
        ...(feeWaiver.waivedTickets > 0
          ? { waivedTickets: feeWaiver.waivedTickets }
          : {}),
        promo: promoEvaluation,
        taxImpositions: taxResolution.impositions,
      });

      // One seat per ticket item, in the order the seats were picked.
      const seatIndexByType = new Map<string, number>();
      for (const item of priced.items) {
        if (item.kind !== "ticket" || !item.ticketTypeId) continue;
        const seatIds = seatIdsByType.get(item.ticketTypeId);
        if (!seatIds) continue;
        const idx = seatIndexByType.get(item.ticketTypeId) ?? 0;
        seatIndexByType.set(item.ticketTypeId, idx + 1);
        const seatId = seatIds[idx];
        if (!seatId) continue;
        // No hold stamp: the PENDING order's own age IS the reservation
        // (see `assertPosCapacity`). A second expiry clock here would drift
        // against the reaper that cancels the PaymentIntent.
        item.meta = {
          ...((item.meta ?? {}) as Record<string, unknown>),
          seatIds: [seatId],
        };
      }

      // The buyer: a per-sale phantom (FR-004), or the guest Human for the
      // email the buyer gave (FR-011).
      const buyerHumanId = await resolveDoorBuyer(tx, input.buyerEmail);

      // FR-003 (organiser-resale-share): each ticket records the event's
      // resale clause in force at this sale, read in this transaction.
      const resaleClause = await resolveTicketResaleClause(tx, event);

      // What checkout writes for the same cart (FR-002): face net of
      // discount, platform fee, tax + situs + tax lines, fee policy snapshot,
      // and per-item `buyerTotalCents` carrying the processor-fee share, so
      // the finalize AMOUNT_MISMATCH guard (Σ buyer totals + discounts + tax)
      // sums to the PaymentIntent amount.
      const created = await tx.orders.createPending({
        id: orderId,
        eventId: event.id,
        buyerHumanId,
        amountGrossCents: priced.amountGrossCents,
        feesPlatformCents: priced.feesPlatformCents,
        taxAmountCents: priced.taxAmountCents,
        currency: event.currency ?? "usd",
        feePolicySnapshot: priced.feePolicySnapshot,
        source: "PRIMARY",
        nonRefundable: priced.nonRefundable,
        items: stampTicketResaleClause(priced.items, resaleClause),
        paymentChannel: "POS",
        taxSitusCountry: taxSitus?.countryCode ?? null,
        taxSitusState: taxSitus?.region ?? null,
        taxSitusPostal: taxSitus?.postalCode ?? null,
        taxRateSource: taxResolution.rateSource,
      });

      // Per-imposition breakdown, same transaction and same solve as
      // `taxAmountCents` above (Σ PLATFORM lines === taxAmountCents).
      if (priced.orderTaxLines.length > 0) {
        await tx.orders.createTaxLines({
          orderId: created.id,
          lines: priced.orderTaxLines,
        });
      }

      // Holds use the POS capacity-hold window (`POS_HELD_WINDOW_SECONDS`,
      // cart TTL + 2 reaper periods = 80 min), not the web 15-min TTL, so a
      // slow tap can't lose its promo before the cart reaper would release
      // the whole order anyway. The finalize webhook
      // confirms holds for every order; the expired-cart reaper and
      // abandonFailedSale release them on the failure paths.
      await createPromoHolds(tx.promos, promoEvaluation.applications, {
        orderId: created.id,
        buyerHumanId,
        now,
        ttlSeconds: POS_HELD_WINDOW_SECONDS,
      });

      return {
        orderId: created.id,
        amountCents: priced.chargeTotalCents,
        discountCents: priced.discountCents,
        taxAmountCents: priced.taxAmountCents,
        currency: created.currency,
        destinationAccountId: payee.stripeAccountId,
        eventId: event.id,
        eventTitle: event.title,
        // TICKET lines only: discount items must never be counted as tickets.
        ticketQuantity: priced.items.reduce(
          (sum, item) => (item.kind === "ticket" ? sum + item.qty : sum),
          0,
        ),
        heldSeatIds: heldSeatIds.slice(),
        /** The instant the seats above were stamped HELD. Null when none were. */
        seatsHeldAt,
      };
    });

  try {
    // ── Phase 0: tax lookup, BEFORE any transaction (NFR-002) ────────
    // The same prepare checkout runs: a live provider call on a cache miss,
    // retried, and refused with TAX_RATE_UNAVAILABLE when every attempt
    // failed (owner ruling R5: never 0% because a lookup failed). `door`
    // skips the event-ended shortcut (door sales happen after the start) and
    // the unpublished one (the door refuses an unpublished event itself, in
    // `assertCanSellBeforeTaxLookup` below and again under the transaction's
    // lock). The till's own gate (the per-type window) runs in the
    // transaction.
    //
    // RBAC first, on plain reads: the lookup can be a PAID provider call,
    // and nothing may spend it for a caller the transaction would refuse.
    // The transaction re-checks it on its own snapshot below.
    const sellerAccess = await assertCanSellBeforeTaxLookup(deps, input);
    // A refusal says whether this seller may enter the rate by hand (R5).
    const preparedTax = await withManualTaxRateHint(sellerAccess, () =>
      prepareCheckoutTax(
        {
          repos: deps.repos,
          taxRateLookup: deps.taxRateLookup,
          clock: deps.clock,
          reportError: deps.reportError,
        },
        input.eventId,
        deps.logger,
        { channel: "door" },
      ),
    );

    // ── Phase 1: create PENDING order in a tx ───────────────────────
    // The rare in-transaction refusal (the venue moved since the prepare)
    // carries the same hint.
    orderPlan = await withManualTaxRateHint(sellerAccess, () =>
      planOrder(preparedTax),
    );

    // The event's self-heal stamp and the location's rate cache, after the
    // commit. Never throws (failures are reported inside).
    await applyCheckoutTaxSelfHeal(
      { repos: deps.repos, reportError: deps.reportError },
      taxAfterCommit,
      deps.logger,
    );

    // ── Phase 2: create PI on the platform account (no stripeAccount
    //    request option, no application_fee_amount — see D-2026-04-26).
    //    Amount = the priced charge total (FR-002).
    pi = await deps.payments.createCardPresentPaymentIntent({
      amountCents: orderPlan.amountCents,
      currency: orderPlan.currency,
      destinationAccountId: orderPlan.destinationAccountId,
      metadata: {
        orderId: orderPlan.orderId,
        eventId: orderPlan.eventId,
        paymentChannel: "POS",
        actorHumanId: input.actorHumanId,
        // Same marker checkout stamps on a taxed PaymentIntent.
        ...(orderPlan.taxAmountCents > 0
          ? { taxAmountCents: `${orderPlan.taxAmountCents}` }
          : {}),
      },
      idempotencyKey: `pos-pi:${orderPlan.orderId}`,
      // Dashboard/exports summary only. NOT a statement descriptor — the POS
      // path deliberately still sets none (see the adapter).
      description: buildPaymentDescription({
        eventTitle: orderPlan.eventTitle,
        orderId: orderPlan.orderId,
        ticketQuantity: orderPlan.ticketQuantity,
        kind: "pos",
      }),
    });

    // ── Phase 3: link PI back to the order so the webhook can finalise.
    await deps.repos.orders.linkPaymentIntent(
      orderPlan.orderId,
      pi.paymentIntentId,
    );

    const result: StartPosSaleOutput = {
      orderId: orderPlan.orderId,
      clientSecret: pi.clientSecret,
      amountCents: orderPlan.amountCents,
      discountCents: orderPlan.discountCents,
      currency: orderPlan.currency,
    };

    await deps.idempotency.commit<StoredStartPosSaleRecord>(
      idempKey,
      { payloadHash, response: result },
      IDEMPOTENCY_KEEP_SECONDS,
    );

    deps.logger?.info("pos.start_sale.success", {
      actorHumanId: input.actorHumanId,
      eventId: orderPlan.eventId,
      orderId: orderPlan.orderId,
      amountCents: orderPlan.amountCents,
      currency: orderPlan.currency,
      // intentionally NOT logging clientSecret
    });
    deps.metrics?.increment("pos.start_sale.success", {
      eventId: orderPlan.eventId,
    });

    const parsed = startPosSaleOutputSchema.parse(result);
    // Only now is the sale the caller's to own: the order exists, the PI is
    // linked, and the idempotency record will replay this exact response.
    // Anything that throws before this line gets unwound below.
    settled = true;
    return parsed;
  } catch (err) {
    if (!settled && orderPlan) {
      if (pi) {
        await cancelOrphanPaymentIntent(deps, pi.paymentIntentId, orderPlan);
      } else {
        // Stripe may have created the PI and we lost the response. It is
        // unlinked, so `releaseExpiredCarts` — which finds PIs via
        // Order.stripePaymentIntentId — can never reach it. Surface it for
        // reconciliation; the idempotency key below identifies it in Stripe.
        try {
          deps.reportError?.(err, {
            tags: { useCase: "startPosSale", step: "possibleOrphanPi" },
            extra: {
              orderId: orderPlan.orderId,
              stripeIdempotencyKey: `pos-pi:${orderPlan.orderId}`,
            },
          });
        } catch {
          // A throwing reporter must never change unwind behaviour.
        }
      }
      await abandonFailedSale(deps, orderPlan);
    }

    deps.logger?.warn("pos.start_sale.failed", {
      actorHumanId: input.actorHumanId,
      eventId: input.eventId,
      error: describeError(err),
    });
    const reason =
      err && typeof err === "object" && "message" in err
        ? String((err as { message: unknown }).message).slice(0, 64)
        : "unknown";
    deps.metrics?.increment("pos.start_sale.failed", {
      eventId: input.eventId,
      reason,
    });
    await deps.idempotency.fail(idempKey, describeError(err));
    throw asKnownError("start_pos_sale", err);
  }
}

/**
 * Cancels a PaymentIntent whose sale never completed.
 *
 * This must not fail quietly. The PI is either unlinked or attached to an
 * order we are about to cancel, so `releaseExpiredCarts` — which finds PIs via
 * `Order.stripePaymentIntentId` — cannot clean it up. If this call fails, a
 * confirmable PaymentIntent for real money is left with no owner and no
 * backstop, and nobody finds out until a chargeback. Hence the report.
 */
async function cancelOrphanPaymentIntent(
  deps: StartPosSaleDeps,
  paymentIntentId: string,
  orderPlan: { orderId: string },
): Promise<void> {
  try {
    await deps.payments.cancelPaymentIntent({ paymentIntentId });
  } catch (err) {
    deps.logger?.error("pos.start_sale.cancel_orphan_pi_failed", {
      orderId: orderPlan.orderId,
      paymentIntentId,
      err,
    });
    try {
      deps.reportError?.(err, {
        tags: { useCase: "startPosSale", step: "cancelOrphanPaymentIntent" },
        extra: { orderId: orderPlan.orderId, paymentIntentId },
      });
    } catch {
      // A throwing reporter must never change unwind behaviour.
    }
  }
}

/**
 * Unwinds a sale that died after its PENDING order was committed.
 *
 * Cancelling the ORDER is the load-bearing part, not just releasing seats: a
 * PENDING order reserves capacity against every other seller purely by being
 * young (see `assertTicketTypeCapacity`). Leaving it PENDING means the
 * operator's own failed attempt blocks their immediate retry for the whole
 * reservation window — at a door with a queue, the worst possible moment to
 * make the last ticket unsellable. Cancelling drops the row out of the PENDING
 * filter the capacity count uses, so the reservation dies with the sale.
 *
 * Every step is best-effort and swallows its own error: the caller is already
 * throwing the failure that actually explains what went wrong, and the
 * expired-cart reaper is the backstop for anything missed here.
 */
async function abandonFailedSale(
  deps: StartPosSaleDeps,
  orderPlan: {
    orderId: string;
    heldSeatIds: readonly string[];
    seatsHeldAt: Date | null;
  },
): Promise<void> {
  await deps.repos.orders.cancelPendingOrder(orderPlan.orderId).catch((err) => {
    deps.logger?.error("pos.start_sale.cancel_failed_order_failed", {
      orderId: orderPlan.orderId,
      err,
    });
    try {
      deps.reportError?.(err, {
        tags: { useCase: "startPosSale", step: "cancelPendingOrder" },
        extra: { orderId: orderPlan.orderId },
      });
    } catch {
      // A throwing reporter must never change unwind behaviour.
    }
  });

  // Free the promo holds so the codes are immediately reusable on the
  // operator's retry. PENDING-only release — mirrors refund-full-order.
  await deps.repos.promos
    .releaseHoldsForOrder(orderPlan.orderId)
    .catch((err) => {
      deps.logger?.error("pos.start_sale.release_promo_holds_failed", {
        orderId: orderPlan.orderId,
        err,
      });
      try {
        deps.reportError?.(err, {
          tags: { useCase: "startPosSale", step: "releasePromoHolds" },
          extra: { orderId: orderPlan.orderId },
        });
      } catch {
        // A throwing reporter must never change unwind behaviour.
      }
    });

  // Same for fee-waiver allowance reserved against this order: a CANCELLED
  // order is invisible to the expiry reaper, so it is returned here or never.
  // `release` is idempotent.
  await deps.repos.feeWaivers.release(orderPlan.orderId).catch((err) => {
    deps.logger?.error("pos.start_sale.release_fee_waiver_failed", {
      orderId: orderPlan.orderId,
      err,
    });
    try {
      deps.reportError?.(err, {
        tags: { useCase: "startPosSale", step: "releaseFeeWaiver" },
        extra: { orderId: orderPlan.orderId },
      });
    } catch {
      // A throwing reporter must never change unwind behaviour.
    }
  });

  if (orderPlan.heldSeatIds.length > 0) {
    // ── Fenced, for consistency rather than for a live exposure ──────────
    // Every other `releaseSeats` caller works from an order's stale
    // `meta.seatIds`; this one releases seats IT stamped HELD moments ago in
    // the same request, and nothing can re-let a HELD seat until the 900s
    // seat reaper frees it. So the fence is a no-op here in practice. It is
    // passed anyway because the invariant "no `releaseSeats` without an
    // ownership fence" is cheaper to keep total than to keep with an
    // exception, and because the thing that makes it a no-op — the unwind
    // running promptly — is not enforced anywhere.
    //
    // Note the fence is compared against the SEAT's `updatedAt`, not against
    // the wall clock, so a slow unwind (the Stripe client is 60s x 2 retries
    // on PI creation) does not narrow it: what matters is only whether
    // somebody else re-stamped the seat after we did.
    const heldBefore = resolveSeatHoldFence({
      // POS order items deliberately carry no `meta.holdExpiresAt` (the
      // PENDING order's own age IS the reservation — see `assertPosCapacity`),
      // and no POS path ever re-holds an existing order's seats. So the single
      // hold instant recorded by `planOrder` is the whole fence input.
      occurredAt: orderPlan.seatsHeldAt,
      items: [],
    });

    if (heldBefore) {
      await deps.repos.seats
        .releaseSeats({
          seatIds: [...orderPlan.heldSeatIds],
          releasedAt: deps.clock.now(),
          heldBefore,
        })
        .catch((err) => {
          // Was a bare `.catch(() => {})`. The reaper IS the backstop, but a
          // silent swallow made "the unwind never frees seats" a defect that
          // could only be found by noticing a section stayed unsellable for
          // fifteen minutes. `logger.warn` is not captured by Sentry
          // (CLAUDE.md), so this is error + report, matching the promo
          // release directly above.
          deps.logger?.error("pos.start_sale.release_seats_failed", {
            orderId: orderPlan.orderId,
            seatCount: orderPlan.heldSeatIds.length,
            err,
          });
          try {
            deps.reportError?.(err, {
              tags: { useCase: "startPosSale", step: "releaseSeats" },
              extra: {
                orderId: orderPlan.orderId,
                seatCount: orderPlan.heldSeatIds.length,
              },
            });
          } catch {
            // A throwing reporter must never change unwind behaviour.
          }
        });
    } else {
      // Unreachable: `planOrder` sets `seatsHeldAt` in the same statement that
      // fills `heldSeatIds`, so a non-empty list always carries an instant.
      // Reported rather than released unfenced — the seat reaper frees these
      // within the hold TTL either way.
      deps.logger?.error("pos.start_sale.seat_fence_missing", {
        orderId: orderPlan.orderId,
        seatCount: orderPlan.heldSeatIds.length,
      });
      try {
        deps.reportError?.(new Error("pos_start_sale_seat_fence_missing"), {
          tags: { useCase: "startPosSale", step: "releaseSeats" },
          extra: {
            orderId: orderPlan.orderId,
            seatCount: orderPlan.heldSeatIds.length,
          },
        });
      } catch {
        // A throwing reporter must never change unwind behaviour.
      }
    }
  }
}
