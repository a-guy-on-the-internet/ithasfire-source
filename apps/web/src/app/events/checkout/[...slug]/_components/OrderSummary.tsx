"use client";

import React from "react";
import { Clock } from "lucide-react";
import { useTranslations } from "@th/ui";
import {
  FG as fg,
  BORDER_SUBTLE,
  DIVIDER_COLOR,
  SURFACE_OVERLAY,
  FS_BODY,
  FS_CAP,
  FS_SM,
} from "./checkout-tokens";
import { DANGER_TEXT } from "@/lib/design-tokens";
import { feeWaivedCentsFor } from "@/lib/pricing/fee-waiver";
import {
  estimateHeldTaxFallback,
  type FeeRatesForOrderEstimate,
} from "@/lib/pricing/order-estimate";
import { PromoCodeInput } from "./PromoCodeInput";
import {
  preHoldDiscountCents,
  preHoldHasRows,
  preHoldLineCents,
  preHoldRowsCharge,
  preHoldRowsOrder,
  type PreHoldEstimate,
} from "./pre-hold-rows";

export type OrderSummaryTicketType = {
  id: string;
  name: string;
  priceCents: number;
  buyerUnitTotalCents?: number | null;
  /**
   * The buyer-chosen amount on a pay-what-you-want tier (null/absent on FIXED
   * tiers). Before the hold its line reads chosen × qty — the face the buyer
   * named; fees and tax sit in the estimated total below it. After the hold
   * the server's line amounts take over, as for every tier.
   */
  chosenAmountCents?: number | null;
  /**
   * Pre-hold: the chosen amount is one the hold would refuse (over the cap,
   * under the minimum, empty). The line then asks for a valid amount rather
   * than quote it.
   */
  chosenAmountInvalid?: boolean;
  /**
   * Pre-hold: the line's amount at the prices shown, each picked seat at its
   * own (override) price (`useCheckoutState.shownLineCents`). Absent ⇒ face ×
   * qty. After the hold the server's line amounts take over.
   */
  shownLineCents?: number | null;
};

/**
 * The held step's charge as `createCheckout` will make it (see
 * `estimateHeldOrderCharge`): tax and the PASS_THROUGH processor gross-up on
 * the DISCOUNTED subtotal. Replaces the hold's pre-discount processor fee and
 * the flat-rate tax recompute while the order is held.
 */
export type OrderSummaryHeldCharge = {
  taxCents: number;
  processorFeeCents: number | null;
  totalCents: number;
};

export type OrderSummaryOrderItem = {
  kind: string;
  ticketTypeId: string | null;
  qty: number;
  unitPriceCents: number;
  amountCents: number;
  /** Server line meta — read for `platformFeeWaivedCents`. */
  meta?: unknown;
};

export type OrderSummaryOrder = {
  amountGrossCents: number;
  feesPlatformCents: number;
  buyerFeesCents: number;
  /** Estimated processor fee in cents — display only. */
  processorFeeCents: number;
  taxAmountCents: number;
  /**
   * Account credit applied to the charge — stamped by `createCheckout`.
   * Subtracted from the displayed Total so it matches the PaymentIntent
   * amount (gross + buyerFees + tax − credit). 0 / absent before checkout.
   */
  creditAppliedCents?: number | null;
  /**
   * Server-stamped per-line pricing from the held order. Present once
   * updateOrderItems has run; used so line amounts agree with the
   * server-derived Subtotal/Total instead of the pre-hold fee-inclusive
   * estimate.
   */
  items?: OrderSummaryOrderItem[];
  /** createCheckout's waiver figure — wins over the held lines once present. */
  feeWaivedCents?: number;
};

export type ProcessingMethodRate = {
  methodType: string;
  label: string;
  rateLabel: string;
};

/**
 * A discount granted by the buyer's MEMBERSHIP (auto-applied, no code typed),
 * as resolved by the server promo preview. Rendered as its own labelled line
 * ("Member discount — <tier>") so the member sees the benefit working.
 */
export type OrderSummaryMemberDiscount = {
  tierName: string | null;
  /** Owner override for this line's label; null uses the tier-qualified default. */
  label: string | null;
  discountCents: number;
};

export type OrderSummaryProps = {
  ticketTypes: OrderSummaryTicketType[];
  quantities: Record<string, number>;
  selectedQty: number;
  subtotalCents: number;
  /**
   * Pre-hold: the `estimateCartTotal` result the estimated total comes from.
   * Step 1 renders the SAME rows as step 2 from it — Subtotal, platform fee,
   * processing fee, tax, discount(s), Estimated total — so they add up to the
   * total (see `pre-hold-rows.ts`). REQUIRED: a caller that leaves it out
   * gets a compile error, not a face-value sum labelled "Estimated total".
   * Null ⇒ no rows and the total reads "Calculating…". Ignored once an
   * order exists.
   */
  preHoldEstimate: PreHoldEstimate | null;
  /**
   * The total the page shows and announces (`useCheckoutDisplayTotal`). When
   * passed, the total row prints THIS number, so the summary, the mobile
   * button and the live region can never disagree — whatever query failed.
   * Omitted (stories, unit tests) ⇒ the summary derives it from its rows.
   */
  displayTotalCents?: number | null;
  /**
   * The tax inside `displayTotalCents` (`useCheckoutDisplayTotal`'s
   * `displayTaxCents`) — the ONE figure the Taxes row prints once an order
   * exists, the same one the mobile tray prints. Omitted (stories, unit
   * tests) ⇒ the row derives it from the order and the held charge.
   */
  displayTaxCents?: number | null;
  /** Held-step charge (null/absent ⇒ the order's own rows are shown). */
  heldCharge?: OrderSummaryHeldCharge | null;
  /**
   * Pre-hold: a selected PWYW amount is invalid, so there is no honest
   * estimate — the row reads "—" instead of pricing the invalid amount.
   */
  estimateUnavailable?: boolean;
  order: OrderSummaryOrder | null;
  orderId: string | null;
  countdown: string | null;
  isExpired: boolean;
  formatPrice: (cents: number) => string;
  /** Labels for selected seats, keyed by ticket type ID. */
  selectedSeatLabels?: Record<string, string[]>;
  /** Human-readable rate label for the platform fee, e.g. "5%". Null if unknown. */
  platformFeeRateLabel?: string | null;
  /** Human-readable rate label for the processing fee, e.g. "2.9% + $0.30". Null if unknown. */
  processorFeeRateLabel?: string | null;
  /** Per-payment-method processing cost breakdown (from PROCESSING_COST_SCHEDULE). */
  processingMethodRates?: ProcessingMethodRate[] | null;
  /**
   * The rate the Taxes row prints beside its amount, in basis points (825 ⇒
   * "(8.25%)"). Pass `taxRateLabelBps(impositions)`: null whenever no single
   * percentage produces the amount (two PLATFORM lines on two bases), and the
   * row then shows the amount alone. Never used for money.
   */
  taxRateBps?: number | null;
  /**
   * Every quoted tax line (`estimateCheckoutTax.taxImpositions`). Standalone
   * only (no `displayTaxCents`): prices the held tax on a discounted subtotal,
   * each line on its own base.
   */
  taxImpositions?: FeeRatesForOrderEstimate["taxImpositions"];
  /** Currently applied promo codes. */
  promoCodes?: string[];
  /** Called when the user applies a promo code. Returns error key or null. */
  onApplyPromoCode?: (code: string) => string | null;
  /** Called when the user removes a promo code. */
  onRemovePromoCode?: (code: string) => void;
  /** Whether the promo input should be disabled (e.g. during payment). */
  promoInputDisabled?: boolean;
  /**
   * Total discount in cents from currently-queued promo codes, as resolved
   * by the server preview. Drives both the "Discount" line item and the
   * displayed total. The promo isn't truly applied to the Order yet during
   * `held` — `createCheckout` recomputes it — but the preview is server-
   * authoritative for the live cart, so what the buyer sees matches what
   * they'll be charged.
   */
  promoDiscountCents?: number;
  /**
   * Codes kept but not applying to the cart right now (normalized code → the
   * i18n key of the reason), shown beside each code. See
   * `useCheckoutPromoPreview`'s eligibility rejections.
   */
  promoCodeRejections?: Record<string, string>;
  /**
   * The promo preview failed for a reason that is not a promo rejection (a
   * 5xx, the API unreachable): said beside the codes, which stay applied.
   */
  promoPreviewUnavailable?: boolean;
  /** The code from the buyer's link couldn't be checked, so it wasn't applied. */
  urlPromoCheckUnavailable?: boolean;
  /**
   * Membership-granted portion of `promoDiscountCents`, one entry per
   * benefit. Each renders as its own labelled line; the remainder
   * (`promoDiscountCents` minus these) stays on the generic "Discount" line
   * for typed codes. Absent/empty → rendering is identical to before.
   */
  memberDiscounts?: OrderSummaryMemberDiscount[] | null;
  /**
   * True after `createCheckout` has run (phase ∈ paying/confirming).
   * In that state `order.amountGrossCents` is the post-discount amount and
   * `order.taxAmountCents` is the final stamped tax — the OrderSummary
   * should trust them and NOT re-subtract the discount. In `held` it has
   * to do its own estimating (parent merges the tax estimate into the
   * passed `order`, but that's a preview, not authoritative).
   */
  isPostCheckout?: boolean;
  /**
   * Effective fee mode. PASS_THROUGH renders the processor fee as a charged
   * line and adds it to the Total (the buyer funds it). ABSORB / null keeps
   * the processor fee as an "Included" estimate excluded from the Total.
   * Comes from `order.feeMode` once `createCheckout` runs, falling back to the
   * fee-rates query for the held/selecting phases.
   */
  feeMode?: "ABSORB" | "PASS_THROUGH" | null;
};

export const OrderSummary = ({
  ticketTypes,
  quantities,
  selectedQty,
  subtotalCents,
  preHoldEstimate,
  displayTotalCents,
  displayTaxCents,
  heldCharge = null,
  estimateUnavailable = false,
  order,
  orderId,
  countdown,
  isExpired,
  formatPrice,
  selectedSeatLabels,
  platformFeeRateLabel,
  processorFeeRateLabel,
  processingMethodRates,
  taxRateBps,
  taxImpositions,
  promoCodes,
  onApplyPromoCode,
  onRemovePromoCode,
  promoInputDisabled,
  promoDiscountCents = 0,
  promoCodeRejections,
  promoPreviewUnavailable = false,
  urlPromoCheckUnavailable = false,
  memberDiscounts,
  isPostCheckout = false,
  feeMode = null,
}: OrderSummaryProps) => {
  const t = useTranslations();
  const hasSelection = selectedQty > 0;
  // Split the total discount into labelled membership lines and the generic
  // typed-code remainder. Both preview and checkout run the same evaluation,
  // so the member portion is always ≤ the total — the clamp is belt-and-braces
  // against a transiently stale preview.
  const memberDiscountLines = (memberDiscounts ?? []).filter(
    (line) => line.discountCents > 0,
  );
  // Before the hold the discount rows never exceed the subtotal: the
  // estimate's total stops at 0 there, and the rows must add up to it.
  const discountForRows = order
    ? promoDiscountCents
    : preHoldDiscountCents(promoDiscountCents, preHoldEstimate);
  const memberDiscountTotalCents = Math.min(
    memberDiscountLines.reduce((sum, line) => sum + line.discountCents, 0),
    discountForRows,
  );
  const codeDiscountCents = Math.max(
    0,
    discountForRows - memberDiscountTotalCents,
  );
  // In PASS_THROUGH the buyer funds the processor fee, so it's a real charged
  // line included in the Total. In ABSORB it's a display-only estimate.
  const isPassThrough = feeMode === "PASS_THROUGH";
  // A fee waiver the hold priced (step 1 can't know one): explains why the
  // platform fee here is under the pre-hold estimate.
  const feeWaivedCents = feeWaivedCentsFor(order);
  // Two distinct order shapes flow through here:
  //   • `held` — `updateOrderItems` populated `amountGrossCents` with the
  //     PRE-discount subtotal. Tax may be a parent-merged estimate but is
  //     NOT authoritative. We estimate the post-discount total ourselves.
  //   • `paying` / `confirming` — `createCheckout` stamped server-
  //     authoritative values: `amountGrossCents` is POST-discount and
  //     `taxAmountCents` is the final stamped tax.
  // The parent passes `isPostCheckout` explicitly (phase-derived) because
  // we can't infer it from `order.taxAmountCents > 0` — the parent merges
  // a non-authoritative tax estimate in for the held-state preview.
  const isServerAuthoritative = isPostCheckout && order != null;
  // Step 1 renders step 2's rows from its estimate (owner ruling 2026-10-01):
  // the estimate becomes the order + held charge those rows read. Not for an
  // invalid amount ("—", no figures), a free cart (the single "Free" row),
  // or while the estimate is unknown ("Calculating…").
  const preHoldRows =
    !order && !estimateUnavailable && preHoldHasRows(preHoldEstimate)
      ? preHoldEstimate
      : null;
  const rowsOrder: OrderSummaryOrder | null =
    order ?? (preHoldRows ? preHoldRowsOrder(preHoldRows, feeMode) : null);
  // ABSORB before the hold: the estimate prices only what the BUYER pays, so
  // there is no absorbed fee figure to show — the rows say "Included" alone.
  const absorbedFeeFigureKnown = order != null;
  // The solved held charge applies only while held — never once the server
  // has stamped the real numbers.
  const held = order
    ? !isServerAuthoritative
      ? heldCharge
      : null
    : preHoldRows
      ? preHoldRowsCharge(preHoldRows, feeMode)
      : null;
  // Once an order exists, line amounts come from its server-stamped items
  // (base pricing: they sum to `amountGrossCents`, the Subtotal row). The
  // pre-hold fee-inclusive estimate (`buyerUnitTotalCents`) would contradict
  // the server Subtotal/Total shown right below it — e.g. "2× GA $90.86"
  // above "Subtotal $80.00 … Total $87.90". Fees stay visible in their own
  // rows; this only changes which basis the lines display.
  const orderLineCentsByTicketType = new Map<string, number>();
  if (order?.items) {
    for (const item of order.items) {
      if (item.kind !== "ticket" || !item.ticketTypeId) continue;
      orderLineCentsByTicketType.set(
        item.ticketTypeId,
        (orderLineCentsByTicketType.get(item.ticketTypeId) ?? 0) +
          item.amountCents,
      );
    }
  }
  const displayLineItems = ticketTypes.map((tt) => {
    const qty = quantities[tt.id] ?? 0;
    return {
      ticketType: tt,
      qty,
      // Face × qty on both steps: fees and tax have their own rows, so the
      // lines sum to the Subtotal and the rows to the total. (Step 1 used to
      // show each FIXED line at its all-in unit price — "$40.08", "$51.09
      // each" — which no row below could add up to.)
      lineTotalCents: order
        ? (orderLineCentsByTicketType.get(tt.id) ?? tt.priceCents * qty)
        : preHoldLineCents(tt, qty),
    };
  });
  // Pre-order the bottom row is the ESTIMATED TOTAL from the estimate — the
  // same object the rows (and Checkout's live region) read. No estimate ⇒
  // "Calculating…": never a sum of the lines, which leaves out fees and tax.
  const preOrderEstimateCents =
    displayTotalCents !== undefined
      ? displayTotalCents
      : (preHoldEstimate?.totalCents ?? null);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Summary card */}
      <div
        role="region"
        aria-label="Order summary"
        style={{
          overflow: "hidden",
          borderRadius: 0,
          // Swiss structural lines: top and bottom rules, not boxed in
          borderTop: `2px solid ${DIVIDER_COLOR}`,
          borderBottom: BORDER_SUBTLE,
        }}
      >
        {/* Header */}
        <div
          style={{
            borderBottom: `1px solid ${DIVIDER_COLOR}`,
            background: SURFACE_OVERLAY,
            padding: "14px 20px",
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: FS_SM,
              fontWeight: 700,
              color: fg,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            {String(t("checkout.orderSummary"))}
          </h2>
        </div>

        {/* Line items */}
        <div style={{ padding: 20 }}>
          {!hasSelection ? (
            <p
              style={{
                padding: "16px 0",
                textAlign: "center",
                fontSize: FS_BODY,
                color: fg,
                margin: 0,
              }}
            >
              {String(t("checkout.selectTicketsPrompt"))}
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Individual items */}
              <div
                style={{ display: "flex", flexDirection: "column", gap: 10 }}
              >
                {displayLineItems.map(
                  ({ ticketType: tt, qty, lineTotalCents }) => {
                    if (qty === 0) return null;
                    const seatLabels = selectedSeatLabels?.[tt.id];
                    const priceCell = lineTotalCents;
                    return (
                      <div key={tt.id}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "baseline",
                            justifyContent: "space-between",
                            gap: 12,
                            fontSize: FS_BODY,
                          }}
                        >
                          {/* The tier name WRAPS rather than truncating: "1× Pay
                              What Y…" beside a long message was unreadable at
                              1440, and a name is never worth hiding. */}
                          <span
                            style={{
                              minWidth: 0,
                              overflowWrap: "anywhere",
                              color: fg,
                            }}
                          >
                            <span
                              style={{
                                fontWeight: 500,
                                color: fg,
                              }}
                            >
                              {qty}&times;
                            </span>{" "}
                            {tt.name}
                          </span>
                          <span
                            data-testid="order-summary-line-value"
                            style={{
                              flexShrink: 0,
                              fontVariantNumeric: "tabular-nums",
                              color: fg,
                            }}
                          >
                            {!order && tt.chosenAmountInvalid
                              ? null
                              : priceCell === null
                              ? String(t("checkout.calculatingTotal"))
                              : priceCell === 0
                                ? String(t("common.free"))
                                : formatPrice(priceCell)}
                          </span>
                        </div>
                        {/* An invalid amount is said UNDER the name, so the
                            name keeps the row's width. */}
                        {!order && tt.chosenAmountInvalid && (
                          <p
                            data-testid="order-summary-line-invalid"
                            style={{
                              margin: "3px 0 0",
                              fontSize: FS_SM,
                              color: fg,
                              lineHeight: 1.4,
                            }}
                          >
                            {String(t("checkout.pwywEnterValidAmount"))}
                          </p>
                        )}
                        {/* Seat labels for assigned seating */}
                        {seatLabels && seatLabels.length > 0 && (
                          <p
                            style={{
                              margin: "3px 0 0",
                              fontSize: FS_SM,
                              color: fg,
                              lineHeight: 1.4,
                            }}
                          >
                            {seatLabels.join(", ")}
                          </p>
                        )}
                      </div>
                    );
                  },
                )}
              </div>

              {/* Subtotal / fees */}
              <div
                style={{
                  borderTop: "1px dashed var(--borderColorSoft, rgba(33,28,22,0.3))",
                  paddingTop: 14,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                {/* Pre-hold: the previewed discount, already priced into the
                    estimated total below (tax and processing on the
                    discounted subtotal) — shown so that total is explained. */}
                {/* Member benefits get their own labelled lines here too —
                    the same split the held step shows below. */}
                {!rowsOrder &&
                  preHoldEstimate != null &&
                  !estimateUnavailable &&
                  memberDiscountTotalCents > 0 &&
                  memberDiscountLines.map((line, index) => (
                    <div
                      key={`preorder-member-discount-${index}`}
                      data-testid="order-summary-preorder-member-discount-row"
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: FS_BODY,
                      }}
                    >
                      <span style={{ color: fg }}>
                        {line.label
                          ? line.label
                          : String(
                              line.tierName
                                ? t("checkout.memberDiscountTier", {
                                    tier: line.tierName,
                                  })
                                : t("checkout.memberDiscount"),
                            )}
                      </span>
                      <span
                        style={{
                          fontVariantNumeric: "tabular-nums",
                          color: "var(--success, #166534)",
                        }}
                      >
                        −{formatPrice(line.discountCents)}
                      </span>
                    </div>
                  ))}
                {!rowsOrder &&
                  preHoldEstimate != null &&
                  !estimateUnavailable &&
                  codeDiscountCents > 0 && (
                  <div
                    data-testid="order-summary-preorder-discount-row"
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: FS_BODY,
                    }}
                  >
                    <span style={{ color: fg }}>
                      {String(t("checkout.discount"))}
                    </span>
                    <span
                      style={{
                        fontVariantNumeric: "tabular-nums",
                        color: "var(--success, #166534)",
                      }}
                    >
                      −{formatPrice(codeDiscountCents)}
                    </span>
                  </div>
                )}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: FS_BODY,
                  }}
                >
                  <span style={{ color: fg }}>
                    {/* With rows (step 2, and step 1 once its estimate is
                        known) this is the face-value Subtotal and the total
                        has its own row below. Without them (calculating, an
                        invalid amount, a free cart) step 1 shows only the
                        estimated total here. */}
                    {String(
                      t(rowsOrder ? "checkout.subtotal" : "checkout.estimatedTotal"),
                    )}
                  </span>
                  <span
                    data-testid={
                      rowsOrder ? "order-summary-subtotal-value" : undefined
                    }
                    style={{
                      fontVariantNumeric: "tabular-nums",
                      fontWeight: 500,
                      color: fg,
                    }}
                  >
                    {rowsOrder
                      ? // When the server-authoritative order is in hand
                        // (post-createCheckout), `amountGrossCents` is the
                        // POST-discount value — reconstruct the original
                        // pre-discount subtotal so the buyer sees the full
                        // price alongside the discount line.
                        formatPrice(
                          isServerAuthoritative
                            ? rowsOrder.amountGrossCents + promoDiscountCents
                            : rowsOrder.amountGrossCents,
                        )
                      : estimateUnavailable
                        ? "—"
                        : preOrderEstimateCents === null
                        ? String(t("checkout.calculatingTotal"))
                        : preOrderEstimateCents === 0
                          ? String(t("common.free"))
                          : formatPrice(preOrderEstimateCents)}
                  </span>
                </div>

                {/* Fee + tax rows: step 2's order, or step 1's estimate. */}
                {rowsOrder && (
                  <>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: FS_BODY,
                      }}
                    >
                      <span style={{ color: fg }}>
                        {String(t("checkout.platformFee"))}
                        {platformFeeRateLabel && (
                          <span
                            style={{
                              marginLeft: 4,
                              fontSize: FS_SM,
                              color: fg,
                              opacity: 0.55,
                            }}
                            title={String(t("checkout.platformFeeTooltip"))}
                          >
                            {String(
                              t("checkout.feeRateLabel", {
                                rate: platformFeeRateLabel,
                              }),
                            )}
                          </span>
                        )}
                      </span>
                      {isPassThrough ? (
                        <span
                          data-testid="order-summary-platform-fee-value"
                          style={{
                            fontVariantNumeric: "tabular-nums",
                            color: fg,
                          }}
                        >
                          {formatPrice(rowsOrder.feesPlatformCents)}
                        </span>
                      ) : (
                        // ABSORB: the organiser absorbs the platform fee — it
                        // is not part of the Total, so it is shown like the
                        // absorbed processing fee below. As a plain charged
                        // row it made the breakdown sum above the Total.
                        <span
                          data-testid="order-summary-platform-fee-included"
                          style={{
                            display: "flex",
                            alignItems: "baseline",
                            gap: 6,
                            fontVariantNumeric: "tabular-nums",
                            color: fg,
                          }}
                        >
                          {absorbedFeeFigureKnown && (
                            <span style={{ color: fg, opacity: 0.55 }}>
                              {formatPrice(rowsOrder.feesPlatformCents)}
                            </span>
                          )}
                          <span
                            style={{
                              fontSize: FS_CAP,
                              color: fg,
                              opacity: 0.55,
                              fontStyle: "italic",
                            }}
                          >
                            {String(t("checkout.included"))}
                          </span>
                        </span>
                      )}
                    </div>
                    {isPassThrough && feeWaivedCents > 0 && (
                      <div
                        data-testid="order-summary-fee-waived"
                        style={{
                          fontSize: FS_CAP,
                          color: fg,
                          opacity: 0.7,
                          marginTop: -4,
                        }}
                      >
                        {String(
                          t("checkout.platformFeeWaived", {
                            amount: formatPrice(feeWaivedCents),
                          }),
                        )}
                      </div>
                    )}
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: FS_BODY,
                      }}
                    >
                      <span style={{ color: fg }}>
                        {String(t("checkout.processingFee"))}
                        {processorFeeRateLabel && (
                          <span
                            style={{
                              marginLeft: 4,
                              fontSize: FS_SM,
                              color: fg,
                              opacity: 0.55,
                            }}
                            title={String(t("checkout.processingFeeTooltip"))}
                          >
                            {String(
                              t("checkout.feeRateLabel", {
                                rate: processorFeeRateLabel,
                              }),
                            )}
                          </span>
                        )}
                      </span>
                      {isPassThrough ? (
                        // PASS_THROUGH: the buyer funds this fee, so render it
                        // like any other charged line (matches platform fee).
                        <span
                          data-testid="order-summary-processing-fee-value"
                          style={{
                            fontVariantNumeric: "tabular-nums",
                            color: fg,
                          }}
                        >
                          {formatPrice(
                            held?.processorFeeCents ??
                              rowsOrder.processorFeeCents,
                          )}
                        </span>
                      ) : (
                        <span
                          data-testid="order-summary-processing-fee-included"
                          style={{
                            display: "flex",
                            alignItems: "baseline",
                            gap: 6,
                            fontVariantNumeric: "tabular-nums",
                            color: fg,
                          }}
                        >
                          {absorbedFeeFigureKnown && (
                            <span style={{ color: fg, opacity: 0.55 }}>
                              {formatPrice(rowsOrder.processorFeeCents)}
                            </span>
                          )}
                          {/* ABSORB: the buyer never pays this. Nor does the
                              organiser: with separate charges and transfers
                              Stripe's fee comes out of the platform's balance
                              (settlement credits gross − platform fee, no
                              processor term). Annotated inline so the buyer
                              doesn't sum the breakdown and wonder why Total
                              doesn't match. */}
                          <span
                            style={{
                              fontSize: FS_CAP,
                              color: fg,
                              opacity: 0.55,
                              fontStyle: "italic",
                            }}
                          >
                            {String(t("checkout.included"))}
                          </span>
                        </span>
                      )}
                    </div>
                    {(() => {
                      // In `paying` state the server has stamped the
                      // authoritative tax — trust it. In `held` we
                      // recompute on the post-discount subtotal so the
                      // preview matches what the server will charge.
                      // Checkout passes the page's ONE tax figure (the
                      // tray's too); standalone, derive it as before.
                      const recomputedTaxCents =
                        order && displayTaxCents != null
                          ? displayTaxCents
                          : isServerAuthoritative
                            ? rowsOrder.taxAmountCents
                            : held
                              ? held.taxCents
                              : estimateHeldTaxFallback(rowsOrder, {
                                  discountCents: promoDiscountCents,
                                  feeMode,
                                  taxImpositions,
                                });
                      return (
                        <div
                          data-testid="order-summary-tax-row"
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            fontSize: FS_BODY,
                          }}
                        >
                          <span style={{ color: fg }}>
                            {String(t("checkout.taxes"))}
                            {taxRateBps != null && taxRateBps > 0 && (
                              <span
                                style={{
                                  marginLeft: 4,
                                  fontSize: FS_SM,
                                  color: fg,
                                  opacity: 0.55,
                                }}
                              >
                                ({+(taxRateBps / 100).toFixed(2)}%)
                              </span>
                            )}
                          </span>
                          {/* Always the figure — "$0.00" for a zero-tax
                              event, never "Included" (owner ruling
                              2026-10-01): nothing is included, nothing is
                              owed. */}
                          <span
                            data-testid="order-summary-tax-value"
                            style={{
                              fontVariantNumeric: "tabular-nums",
                              color: fg,
                            }}
                          >
                            {formatPrice(recomputedTaxCents)}
                          </span>
                        </div>
                      );
                    })()}
                    {/* Transparency note */}
                    {(platformFeeRateLabel || processorFeeRateLabel) && (
                      <p
                        style={{
                          margin: "6px 0 0",
                          fontSize: FS_CAP,
                          lineHeight: 1.5,
                          color: fg,
                          opacity: 0.4,
                        }}
                      >
                        {String(t("checkout.feeTransparencyNote"))}
                      </p>
                    )}
                    {/* Per-method processing fee breakdown */}
                    {processingMethodRates &&
                      processingMethodRates.length > 0 && (
                        <details style={{ marginTop: 8 }}>
                          <summary
                            style={{
                              fontSize: FS_CAP,
                              color: fg,
                              opacity: 0.5,
                              cursor: "pointer",
                              userSelect: "none",
                            }}
                          >
                            {String(t("checkout.processingFeesByMethod"))}
                          </summary>
                          <div
                            style={{
                              marginTop: 6,
                              display: "flex",
                              flexDirection: "column",
                              gap: 3,
                            }}
                          >
                            {processingMethodRates.map((r) => (
                              <div
                                key={r.methodType}
                                style={{
                                  display: "flex",
                                  justifyContent: "space-between",
                                  fontSize: FS_CAP,
                                  color: fg,
                                  opacity: 0.5,
                                }}
                              >
                                <span>{r.label}</span>
                                <span
                                  style={{ fontVariantNumeric: "tabular-nums" }}
                                >
                                  {r.rateLabel}
                                </span>
                              </div>
                            ))}
                          </div>
                        </details>
                      )}
                  </>
                )}
              </div>

              {/* Promo code input */}
              {onApplyPromoCode && onRemovePromoCode && (
                <div
                  style={{
                    borderTop: "1px dashed var(--borderColorSoft, rgba(33,28,22,0.3))",
                    paddingTop: 14,
                  }}
                >
                  <PromoCodeInput
                    appliedCodes={promoCodes ?? []}
                    rejections={promoCodeRejections}
                    checkUnavailable={promoPreviewUnavailable}
                    urlCheckUnavailable={urlPromoCheckUnavailable}
                    onApply={onApplyPromoCode}
                    onRemove={onRemovePromoCode}
                    disabled={promoInputDisabled}
                  />
                </div>
              )}

              {/* Total — only shown once order exists with real numbers.
                  When a promo is queued (server-previewed), show the
                  discount as its own line and subtract it from the
                  displayed total so the buyer sees what they'll actually
                  pay. */}
              {rowsOrder && (
                <div
                  style={{
                    borderTop: "1px solid var(--borderColorSoft, rgba(33,28,22,0.3))",
                    paddingTop: 14,
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  {(order?.creditAppliedCents ?? 0) > 0 && (
                    <div
                      data-testid="order-summary-credit-row"
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: FS_BODY,
                      }}
                    >
                      <span style={{ color: fg }}>
                        {String(t("checkout.creditApplied"))}
                      </span>
                      <span
                        data-testid="order-summary-credit-value"
                        style={{
                          fontVariantNumeric: "tabular-nums",
                          color: "var(--success, #166534)",
                        }}
                      >
                        −{formatPrice(order?.creditAppliedCents ?? 0)}
                      </span>
                    </div>
                  )}
                  {/* Membership benefits get their own LABELLED lines so the
                      member sees the benefit working — the generic Discount
                      row below keeps only the typed-code remainder. */}
                  {memberDiscountTotalCents > 0 &&
                    memberDiscountLines.map((line, index) => (
                      <div
                        key={`member-discount-${index}`}
                        data-testid="order-summary-member-discount-row"
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          fontSize: FS_BODY,
                        }}
                      >
                        <span style={{ color: fg }}>
                          {/* The owner's own words win when they set a
                              label; otherwise the tier-qualified default,
                              falling back to a bare "Member discount". */}
                          {line.label
                            ? line.label
                            : String(
                                line.tierName
                                  ? t("checkout.memberDiscountTier", {
                                      tier: line.tierName,
                                    })
                                  : t("checkout.memberDiscount"),
                              )}
                        </span>
                        <span
                          data-testid="order-summary-member-discount-value"
                          style={{
                            fontVariantNumeric: "tabular-nums",
                            color: "var(--success, #166534)",
                          }}
                        >
                          −{formatPrice(line.discountCents)}
                        </span>
                      </div>
                    ))}
                  {codeDiscountCents > 0 && (
                    <div
                      data-testid="order-summary-discount-row"
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        fontSize: FS_BODY,
                      }}
                    >
                      <span style={{ color: fg }}>
                        {String(t("checkout.discount"))}
                      </span>
                      <span
                        data-testid="order-summary-discount-value"
                        style={{
                          fontVariantNumeric: "tabular-nums",
                          color: "var(--success, #166534)",
                        }}
                      >
                        −{formatPrice(codeDiscountCents)}
                      </span>
                    </div>
                  )}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      justifyContent: "space-between",
                    }}
                  >
                    <span style={{ fontSize: 16, fontWeight: 700, color: fg }}>
                      {String(
                        t(order ? "checkout.total" : "checkout.estimatedTotal"),
                      )}
                    </span>
                    <span
                      data-testid="order-summary-total-value"
                      style={{
                        fontSize: 22,
                        fontWeight: 700,
                        fontVariantNumeric: "tabular-nums",
                        color: fg,
                      }}
                    >
                      {(() => {
                        // Mirror the server's `paymentIntentAmount`:
                        //   PASS_THROUGH: gross + buyerFees + processorFee
                        //                   + tax − creditApplied
                        //   ABSORB:       gross + buyerFees + tax
                        //                   − creditApplied
                        // For PASS_THROUGH the buyer funds the processor fee,
                        // so it's added to the Total; for ABSORB it's
                        // informational only (the platform pays it, out of
                        // its own balance). `paying` state: trust server's
                        // amountGrossCents (already post-discount) + stamped
                        // tax. `held`: recompute on the discount-applied base.
                        const processorCents = isPassThrough
                          ? rowsOrder.processorFeeCents
                          : 0;
                        // Step 1 lands here too: its `held` is the estimate,
                        // so this is the same `totalCents` as the visible
                        // total everywhere else and the live region.
                        // Checkout passes the page's ONE total (the same
                        // number the mobile button and the live region use).
                        // A $0 total reads "Free" — the label the mobile
                        // button (`displayTotalLabel`) shows for it.
                        const totalLabel = (cents: number) =>
                          cents === 0
                            ? String(t("common.free"))
                            : formatPrice(cents);
                        if (displayTotalCents !== undefined) {
                          return displayTotalCents == null
                            ? String(t("checkout.calculatingTotal"))
                            : totalLabel(displayTotalCents);
                        }
                        if (held) return totalLabel(held.totalCents);
                        if (isServerAuthoritative) {
                          return totalLabel(
                            Math.max(
                              0,
                              rowsOrder.amountGrossCents +
                                rowsOrder.buyerFeesCents +
                                processorCents +
                                rowsOrder.taxAmountCents -
                                (order?.creditAppliedCents ?? 0),
                            ),
                          );
                        }
                        const taxable = Math.max(
                          0,
                          rowsOrder.amountGrossCents - promoDiscountCents,
                        );
                        const taxCents = estimateHeldTaxFallback(rowsOrder, {
                          discountCents: promoDiscountCents,
                          feeMode,
                          taxImpositions,
                        });
                        return totalLabel(
                          Math.max(
                            0,
                            taxable +
                              rowsOrder.buyerFeesCents +
                              processorCents +
                              taxCents,
                          ),
                        );
                      })()}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Hold countdown bar */}
        {countdown && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              borderTop: isExpired
                ? "1px solid rgba(127,29,29,0.4)"
                : `1px solid ${DIVIDER_COLOR}`,
              background: isExpired ? "rgba(69,10,10,0.3)" : SURFACE_OVERLAY,
              padding: "10px 20px",
              fontSize: FS_BODY,
            }}
          >
            <Clock
              size={14}
              style={{ color: isExpired ? DANGER_TEXT : fg }}
            />
            {isExpired ? (
              <span style={{ fontWeight: 500, color: DANGER_TEXT }}>
                {String(t("checkout.holdExpired"))}
              </span>
            ) : (
              <span style={{ color: fg }} aria-live="polite">
                {String(t("checkout.reservedFor"))}{" "}
                <span
                  style={{
                    fontWeight: 700,
                    fontVariantNumeric: "tabular-nums",
                    color: fg,
                  }}
                >
                  {countdown}
                </span>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
