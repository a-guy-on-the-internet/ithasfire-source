import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";

import { parseInput } from "../../lib/io";
import {
  evaluatePromoApplications,
  preparePromoCodes,
  type PromoEvaluationResult,
} from "../orders/checkout-promos";
import type { TicketLineComputation } from "../orders/checkout-helpers";
import {
  resolveMemberBenefits,
  type MemberBenefitGrant,
} from "../memberships/resolve-member-benefits";
import { ticketsDiscountedToZero } from "../../lib/orders/discounted-to-zero";
import {
  resolveSeatUnitPriceCents,
  seatOverrideCents,
} from "../../lib/orders/seat-pricing";
import { estimatePlatformFeeReductionForEvent } from "../events/_shared/estimate-buyer-ticket-pricing";
import { quoteHeldCartFees } from "../orders/_shared/held-cart-fees";
import { donationAmountCentsSchema } from "../../lib/pricing/pay-what-you-want";
import { fail } from "@th/errors";

// ─────────────────────────────────────────────────────────────────────────────
// Preview promos
//
// Public-by-default validator: takes a list of promo codes, a cart shape, and
// the event, and returns "what would happen if you applied these right now."
// No order is created, no hold is taken. The real source of truth still
// re-runs at hold/checkout time.
//
// Two contexts:
//   • `source: "manual"` — buyer typed the code into the input. All ACTIVE
//      codes resolve, public or private. Per-human caps are skipped here
//      (we don't have the buyer's UUID yet, and the real cap fires later).
//   • `source: "url"` — buyer landed on a shareable link with ?p=CODE.
//      Only `isPublic = true` codes resolve. Private codes look like
//      "not_found" so URL crafters can't enumerate them.
//
// Signed-in buyers (`includeMemberBenefits` + server-injected `buyerHumanId`)
// additionally get their MEMBERSHIP BENEFITS previewed via the exact
// resolver + evaluation pipeline checkout uses — see the schema docs below.
// ─────────────────────────────────────────────────────────────────────────────

export const previewPromosInputSchema = z.object({
  eventId: z.string().uuid(),
  /**
   * Typed / URL-supplied promo codes. May be EMPTY when the caller only wants
   * membership benefits previewed (`includeMemberBenefits: true` for a
   * signed-in buyer) — a member should see their discount before typing
   * anything.
   */
  codes: z.array(z.string().min(1).max(64)).max(10),
  /**
   * The signed-in buyer, resolved from the SESSION by the transport
   * (`ctx.actorHumanId`) — NEVER client-supplied; the tRPC router omits this
   * field from its public input schema and injects it. `null` = anonymous.
   *
   * Only consulted when `includeMemberBenefits` is true (i.e. the caller
   * asserts the authenticated session IS the buyer). The POS/scanner door
   * preview must NOT set that flag: there the operator's session is not the
   * buyer, so neither their membership benefits nor their per-human
   * redemption history may leak into the quote.
   */
  buyerHumanId: z.string().uuid().nullable().default(null),
  /**
   * When true AND `buyerHumanId` is present, resolve the buyer's membership
   * benefits (`resolveMemberBenefits`) and include them in the evaluation —
   * the same `memberPromos` pipeline checkout runs — so a signed-in member
   * sees their discount BEFORE the order is created. Also threads
   * `buyerHumanId` into per-human redemption-cap checks, making the preview
   * match what checkout will actually charge. Defaults to false: anonymous
   * URL previews and the door/POS preview keep today's semantics exactly.
   */
  includeMemberBenefits: z.boolean().default(false),
  /** Cart line items used to compute eligibility + discount math. */
  ticketSelections: z
    .array(
      z
        .object({
          ticketTypeId: z.string().uuid(),
          qty: z.number().int().min(1).max(50),
          /**
           * The buyer-chosen amount on a pay-what-you-want (ADJUSTABLE) tier —
           * the same field checkout charges from. It IS the line's unit price
           * for discount math. Omitted ⇒ the tier's floor (`minimumCents`).
           */
          donationAmountCents: donationAmountCentsSchema.optional(),
          /**
           * The seats the buyer picked for this line, so a FIXED tier's seat
           * with a price override is discounted at that override, as checkout
           * charges it (seat-price-overrides spec FR-001). At most `qty`, no
           * repeats; the rest of the quantity is priced at the tier. Ignored
           * on an ADJUSTABLE tier (D-004). Optional: the door/POS preview and
           * older clients send none and are priced at the tier as before.
           */
          seatIds: z.array(z.string().uuid()).max(50).optional(),
        })
        .superRefine((sel, ctx) => {
          if (!sel.seatIds) return;
          if (sel.seatIds.length > sel.qty) {
            ctx.addIssue({
              code: "custom",
              message: "seat_ids_exceed_qty",
              path: ["seatIds"],
            });
          }
          if (new Set(sel.seatIds).size !== sel.seatIds.length) {
            ctx.addIssue({
              code: "custom",
              message: "seat_ids_duplicate",
              path: ["seatIds"],
            });
          }
        }),
    )
    .min(1)
    .max(50)
    // A seat belongs to one line: checkout refuses a seat named twice in one
    // request, so the preview does too.
    .superRefine((selections, ctx) => {
      const seen = new Set<string>();
      selections.forEach((sel, index) => {
        for (const seatId of new Set(sel.seatIds ?? [])) {
          if (seen.has(seatId)) {
            ctx.addIssue({
              code: "custom",
              message: "seat_ids_duplicate",
              path: [index, "seatIds"],
            });
          }
          seen.add(seatId);
        }
      });
    }),
  source: z.enum(["manual", "url"]).default("manual"),
  // There is no `pricing` mode: online checkout and the door (POS) resolve
  // the same unit price (door-sales-same-price-and-tax spec FR-012). Scanner
  // builds that still send the old `pricing` field keep working — this
  // object is not `.strict()`, so the unknown key is stripped.
  /**
   * The buyer's OWN pending order, when they already have one — they reached
   * the payment step (holds taken) and came back to edit the cart. Redemption
   * stats count live holds, so without this their own hold on a 1-per-person
   * code would refuse them the slot they hold. Honoured only when
   * `includeMemberBenefits` asserts the session is the buyer AND the order is
   * that buyer's own PENDING cart on this event (the cart checkout will
   * retire); otherwise silently dropped — never an oracle over someone
   * else's cart. Checkout applies the same exclusion to its own routing
   * probe and to the free-claim path, so preview and checkout agree.
   */
  excludeOrderId: z.string().uuid().optional(),
});

const applicationSchema = z.object({
  /**
   * The code the buyer typed / carried on the URL, echoed back. ABSENT for
   * membership-sourced applications — and now STRUCTURALLY so: a benefit has
   * no code at all, in the DB or anywhere else. This used to be a deliberate
   * omission guarding a real leak (the backing promo's private code would
   * otherwise be readable from the network tab and shareable as a public
   * discount code, since the typed-code path checks no entitlement). That leak
   * class is dead with the Promo reference. Consumers label member lines via
   * `source.tierName` / `source.label`.
   */
  code: z.string().optional(),
  normalizedCode: z.string().optional(),
  /** Present only for typed/URL applications. */
  promoId: z.string().uuid().optional(),
  kind: z.enum(["AMOUNT", "PERCENT"]),
  value: z.number().int(),
  scope: z.enum(["GLOBAL", "ORG", "EVENT", "TICKET_TYPE", "HUMAN"]),
  discountCents: z.number().int(),
  /** Campaign knobs — promo-only; a benefit has neither. */
  stackable: z.boolean().optional(),
  isPublic: z.boolean().optional(),
  /**
   * Present when the discount auto-applied via a membership benefit (nothing
   * was typed). `tierName` lets the checkout label the line
   * ("Member discount — <tier>"), `label` is the owner's override.
   */
  source: z
    .object({
      kind: z.literal("membership"),
      tierId: z.string().uuid(),
      tierName: z.string(),
      label: z.string().nullable(),
    })
    .optional(),
});

export const previewPromosOutputSchema = z.object({
  applications: z.array(applicationSchema),
  totalDiscountCents: z.number().int(),
  /** Cart subtotal we computed eligibility against — handy for the UI. */
  orderSubtotalCents: z.number().int(),
  /**
   * How many cents the buyer's PLATFORM FEE falls by because these discounts
   * bring one or more tickets down to $0: such a ticket pays no platform fee
   * (owner ruling 2026-10-10, "yes a promo brought down to $0 should have no
   * fee too"; `lib/orders/discounted-to-zero.ts` says which tickets those
   * are). 0 when no ticket reaches $0, and 0 when the whole order does (a
   * free order has no fee for anything to come off).
   *
   * For the total a client estimates BEFORE THE HOLD, from the public fee
   * rates: subtract it from that estimate's platform fee, next to
   * `totalDiscountCents` coming off the subtotal
   * (`estimateOrderTotal({ platformFeeReductionCents })`). Already net of the
   * order-level fee cap. Measured against the fee those rates give, which
   * knows no fee waiver; so is this. The charge itself never reads this:
   * `createCheckout` re-evaluates and prices the cart itself.
   *
   * NOT for a held order: never subtract this from the fee an order carries.
   * That fee may already be net of it (a cart `createCheckout` priced), and a
   * fee waiver can move when a ticket is freed. Use `heldCartFees`.
   */
  platformFeeReductionCents: z.number().int().min(0),
  /**
   * For the HELD step: the platform fee `createCheckout` will charge for
   * this cart with these discounts, stated as the fee itself (and the fee
   * waiver inside it), not as a change to anything the page holds. Computed
   * the way the charge computes it; see `orders/_shared/held-cart-fees.ts`
   * for the steps, what it cannot know, and what the page shows without it.
   *
   * Present only when the preview prices the buyer's own pending cart: the
   * session is the buyer (`includeMemberBenefits`) and `excludeOrderId` is
   * their PENDING order on this event. `null` otherwise, and `null` when the
   * cart cannot be priced as the charge would price it (the charge refuses
   * it too). On `null` the page keeps the fee its order carries.
   *
   * `withoutDiscounts` is the same pair for this cart with no discount at
   * all. The page shows it beside "no discount" while it has no statement
   * for a changed set of codes (it depends on the tickets and the allowance,
   * not on the codes, so the last statement for this cart still holds).
   */
  heldCartFees: z
    .object({
      buyerPlatformFeeCents: z.number().int().min(0),
      platformFeeWaivedCents: z.number().int().min(0),
      withoutDiscounts: z.object({
        buyerPlatformFeeCents: z.number().int().min(0),
        platformFeeWaivedCents: z.number().int().min(0),
      }),
    })
    .nullable(),
});

export type PreviewPromosInput = z.infer<typeof previewPromosInputSchema>;
export type PreviewPromosOutput = z.infer<typeof previewPromosOutputSchema>;

export type PreviewPromosDeps = {
  repos: Repos;
  /**
   * REQUIRED. This preview quotes the price + discount that checkout will
   * CHARGE, and with scheduled pricing (FR-005) those only agree if both
   * resolve against the same real clock. FR-003: all clock reads come from the
   * injected ClockPort — a `?? new Date()` fallback here would make the one
   * migrated site that silently reads wall time the one that quotes wrong.
   */
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Reports a picked seat whose stored override is corrupt. The preview
   * prices that seat at its tier and carries on (checkout refuses the seat
   * with `seat_price_override_invalid`, so it is never charged at either
   * number); the report is what makes the bad row visible.
   */
  reportError?: ReporterPort;
};

/**
 * Each picked seat's override in cents, `null` for none, for the FIXED-tier
 * lines of the preview. Read with the same unlocked query checkout prices
 * from (`readSeatPriceOverrides`), but tolerant where checkout refuses: the
 * preview must never fail on a stale cart, so a seat that is gone, belongs to
 * another event, or sits outside the tier's section is simply absent (priced
 * at the tier), and a corrupt override is reported and priced at the tier.
 * Checkout re-reads and is the authority.
 */
async function readPreviewSeatOverrides(
  deps: Pick<PreviewPromosDeps, "repos" | "reportError">,
  eventId: string,
  seatSectionByTicketType: ReadonlyMap<string, string | null>,
  selections: ReadonlyArray<{ ticketTypeId: string; seatIds?: string[] }>,
): Promise<Map<string, number | null>> {
  const overrides = new Map<string, number | null>();
  const sectionOfSeat = new Map<string, string | null>();
  for (const sel of selections) {
    for (const seatId of sel.seatIds ?? []) {
      sectionOfSeat.set(
        seatId,
        seatSectionByTicketType.get(sel.ticketTypeId) ?? null,
      );
    }
  }
  if (sectionOfSeat.size === 0) {
    return overrides;
  }
  const rows = await deps.repos.seats.findPriceOverridesByIds({
    seatIds: [...sectionOfSeat.keys()],
    eventId,
  });
  for (const row of rows) {
    const tierSection = sectionOfSeat.get(row.id);
    if (!tierSection || row.seatSectionId !== tierSection) {
      continue;
    }
    try {
      overrides.set(row.id, seatOverrideCents(row.priceOverride, row.id));
    } catch (err) {
      try {
        deps.reportError?.(err, {
          tags: { area: "promos", surface: "previewPromos" },
          extra: { eventId, seatId: row.id },
        });
      } catch {
        // A throwing reporter must not change the preview.
      }
    }
  }
  return overrides;
}

/**
 * Checkout's promo lines for one item (`computeOrderAmounts`): one entry per
 * distinct unit price, in first-seen order of the item's tickets (picked
 * seats first, in request order, then the unseated rest).
 */
function ticketLinesByUnitPrice(
  ticketTypeId: string,
  unitPrices: readonly number[],
): TicketLineComputation[] {
  const qtyByUnit = new Map<number, number>();
  for (const unit of unitPrices) {
    qtyByUnit.set(unit, (qtyByUnit.get(unit) ?? 0) + 1);
  }
  return [...qtyByUnit].map(([unitPriceCents, qty]) => ({
    ticketTypeId,
    qty,
    unitPriceCents,
    lineGrossCents: unitPriceCents * qty,
  }));
}

/**
 * `excludeOrderId` as the buyer may use it, or `undefined`. The exclusion is
 * honoured for EXACTLY the cart checkout will retire — the same predicate as
 * `createCheckout` / `claimFreeTickets`: the buyer's own order, on THIS
 * event, still PENDING. Anything else (a stranger's order, one of the
 * buyer's carts on another event, a paid or cancelled order) is dropped, so
 * the preview can never quote a code that checkout will then refuse. An
 * anonymous or door/POS preview (no asserted buyer) never reads the order.
 */
async function resolveOwnPendingOrderId(
  repos: Repos,
  buyerHumanId: string | null,
  eventId: string,
  excludeOrderId: string | undefined,
): Promise<string | undefined> {
  if (!buyerHumanId || !excludeOrderId) {
    return undefined;
  }
  const order = await repos.orders.getById(excludeOrderId);
  return order &&
    order.buyerHumanId === buyerHumanId &&
    order.eventId === eventId &&
    order.status === "PENDING"
    ? excludeOrderId
    : undefined;
}

export async function previewPromos(
  deps: PreviewPromosDeps,
  rawInput: unknown,
): Promise<PreviewPromosOutput> {
  const input = parseInput(previewPromosInputSchema, rawInput);
  const now = deps.clock.now();

  // ── Look up event + ticket types ──────────────────────────────────────
  const event = await deps.repos.events.getById(input.eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }

  const ticketTypes = await deps.repos.events.listTicketTypes(input.eventId);
  const ticketTypeById = new Map(ticketTypes.map((tt) => [tt.id, tt]));

  // Picked seats on FIXED tiers only: an ADJUSTABLE tier ignores overrides.
  // And only on a PUBLISHED event, the public seat map's own gate: this is
  // an unauthenticated read, and it must not quote a seat price the map
  // would not show (a draft's seats price at the tier here).
  const seatOverrides =
    event.status === "PUBLISHED"
      ? await readPreviewSeatOverrides(
          deps,
          input.eventId,
          new Map(ticketTypes.map((tt) => [tt.id, tt.seatSectionId ?? null])),
          input.ticketSelections.filter(
            (sel) =>
              ticketTypeById.get(sel.ticketTypeId)?.pricingMode === "FIXED",
          ),
        )
      : new Map<string, number | null>();

  // ── Build TicketLineComputation[] from the cart ────────────────────────
  const ticketLines: TicketLineComputation[] = [];
  // One entry per ticket, in the order the charge builds its order items
  // (`computeOrderAmounts`: each line's tickets in request order, a seated
  // line's in seat order). Which tickets a discount brings to $0 is decided
  // over THIS list, so a rounding cent lands on the same ticket here as on
  // the charge.
  const ticketsInChargeOrder: Array<{
    ticketTypeId: string;
    unitPriceCents: number;
  }> = [];
  let orderSubtotalCents = 0;
  for (const sel of input.ticketSelections) {
    const tt = ticketTypeById.get(sel.ticketTypeId);
    if (!tt) {
      throw {
        code: "invalid_input",
        message: "ticket_type_not_found",
        ticketTypeId: sel.ticketTypeId,
      } as const;
    }
    // Same resolver, same instant checkout will use. A promo previewed off a
    // pre-flip base and applied against a post-flip charge would quote one
    // discount and take another.
    //
    // ADJUSTABLE: the buyer's amount is the unit price, exactly as
    // `computeOrderAmounts` charges it — no schedule applies to a buyer-named
    // price, and no seat override either (D-004). Quoting the stored $0 made
    // every promo on a PWYW line preview as a $0 discount.
    if (tt.pricingMode === "ADJUSTABLE") {
      const unitPriceCents =
        sel.donationAmountCents ?? Math.max(0, tt.minimumCents ?? 0);
      const lineGrossCents = unitPriceCents * sel.qty;
      ticketLines.push({
        ticketTypeId: tt.id,
        qty: sel.qty,
        unitPriceCents,
        lineGrossCents,
      });
      orderSubtotalCents += lineGrossCents;
      for (let ticketIndex = 0; ticketIndex < sel.qty; ticketIndex++) {
        ticketsInChargeOrder.push({ ticketTypeId: tt.id, unitPriceCents });
      }
      continue;
    }
    // FIXED: each ticket priced as checkout prices it — a picked seat at its
    // override, the rest at the tier's resolved price — and grouped into
    // lines per distinct unit price, as `computeOrderAmounts` hands them to
    // promo evaluation. A % code on a $50 seat in a $30 tier discounts $50.
    const unitPrices: number[] = [];
    for (let ticketIndex = 0; ticketIndex < sel.qty; ticketIndex++) {
      const seatId = sel.seatIds?.[ticketIndex];
      const overrideCents =
        seatId === undefined ? null : (seatOverrides.get(seatId) ?? null);
      unitPrices.push(resolveSeatUnitPriceCents(tt, overrideCents, { now }));
    }
    for (const line of ticketLinesByUnitPrice(tt.id, unitPrices)) {
      ticketLines.push(line);
      orderSubtotalCents += line.lineGrossCents;
    }
    for (const unitPriceCents of unitPrices) {
      ticketsInChargeOrder.push({ ticketTypeId: tt.id, unitPriceCents });
    }
  }

  // ── Validate codes via the same path that runs at checkout ─────────────
  const codeEntries = preparePromoCodes(input.codes);

  // Pass a read-only TxRepos shape — the underlying repo is identical, we
  // just don't open a transaction. The promos lookup is a single SELECT.
  // NOTHING here writes: no order, no PromoHold (`createPromoHolds` is never
  // called from this use case) — checkout remains the source of truth.
  const tx = deps.repos as unknown as TxRepos;

  // The buyer identity is only honoured when the caller asserted the session
  // IS the buyer (see the input schema docs). Otherwise stay anonymous, which
  // also keeps the documented "per-human caps are skipped in preview"
  // behaviour for the URL / door paths.
  const buyerHumanId = input.includeMemberBenefits ? input.buyerHumanId : null;

  // The exclusion is client-supplied. It only ever widens what the buyer is
  // shown as eligible (the locked re-check at checkout is the authority), but
  // it is still not honoured for anyone but the order's own buyer.
  const excludeOrderId = await resolveOwnPendingOrderId(
    deps.repos,
    buyerHumanId,
    input.eventId,
    input.excludeOrderId,
  );

  // Membership benefits — the same resolver + `memberGrants` pipeline that
  // checkout runs, so the previewed discount is exactly what `createCheckout`
  // will apply. Skipped entirely for anonymous buyers.
  const memberGrants: MemberBenefitGrant[] = buyerHumanId
    ? await resolveMemberBenefits(tx, {
        memberHumanId: buyerHumanId,
        event,
        now,
      })
    : [];

  // Errors propagate untouched — the tRPC adapter maps them to typed client
  // errors, so there is nothing useful to do with them here.
  const evaluation: PromoEvaluationResult = await evaluatePromoApplications({
    codes: codeEntries,
    tx,
    event,
    buyerHumanId,
    now,
    orderSubtotalCents,
    ticketLines,
    excludeOrderId,
    publicOnly: input.source === "url",
    memberGrants,
    ...(deps.logger ? { logger: deps.logger } : {}),
  });

  // ── The fee that comes off with a ticket discounted to $0 ──────────────
  // The same marks the charge computes, from the same discounts over the
  // same tickets in the same order. The fee policy is read only when a
  // ticket is actually brought to $0 on an order that stays paid; a fault in
  // that read throws like any other read here (no fallback figure).
  const discountedToZero = ticketsDiscountedToZero(
    ticketsInChargeOrder,
    evaluation.ticketDiscounts,
  );
  const orderStaysPaid = evaluation.totalDiscountCents < orderSubtotalCents;
  const platformFeeReductionCents = orderStaysPaid
    ? await estimatePlatformFeeReductionForEvent(
        { repos: deps.repos, clock: deps.clock, logger: deps.logger },
        event,
        ticketsInChargeOrder.map((ticket, index) => ({
          unitPriceCents: ticket.unitPriceCents,
          feeFree: discountedToZero[index] === true,
        })),
        now,
      )
    : 0;

  // ── The held cart's fee, as the charge will take it ────────────────────
  // Only for the buyer's own pending cart (`excludeOrderId` was verified
  // above to be exactly that). Never throws: see `quoteHeldCartFees`.
  const heldCartFees = excludeOrderId
    ? await quoteHeldCartFees(
        {
          repos: deps.repos,
          logger: deps.logger,
          reportError: deps.reportError,
        },
        {
          event,
          buyerHumanId,
          heldOrderId: excludeOrderId,
          selections: input.ticketSelections,
          ticketTypes,
          seatOverrides,
          discounts: evaluation.ticketDiscounts,
          totalDiscountCents: evaluation.totalDiscountCents,
          now,
          useCase: "previewPromos",
        },
      )
    : null;

  // The tier name rides ON the grant now (resolveMemberBenefits reads the tier
  // to derive owner scope anyway), so the per-application tier lookup this
  // used to do — and its "vanished tier → null name" degradation — is gone.
  return previewPromosOutputSchema.parse({
    applications: evaluation.applications.map((app) =>
      app.kind === "code"
        ? {
            code: app.code.original,
            normalizedCode: app.code.normalized,
            promoId: app.promo.id,
            kind: app.promo.kind,
            value: app.promo.value,
            scope: app.promo.scope,
            discountCents: app.discountCents,
            stackable: app.promo.stackable,
            isPublic: app.promo.isPublic,
          }
        : {
            // No code, no promoId, no campaign knobs — a grant has none of
            // them to leak.
            kind: app.grant.discountKind,
            value: app.grant.discountValue,
            scope: app.terms.scope,
            discountCents: app.discountCents,
            source: {
              kind: "membership" as const,
              // No benefitId: nothing client-side needs it, and the smallest
              // response is the easiest "no material reaches the buyer" claim
              // to keep true.
              tierId: app.grant.tierId,
              tierName: app.grant.tierName,
              label: app.grant.label,
            },
          },
    ),
    totalDiscountCents: evaluation.totalDiscountCents,
    orderSubtotalCents,
    platformFeeReductionCents,
    heldCartFees,
  });
}
