"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronUp, ShieldCheck } from "lucide-react";
import { Spinner, useTranslations } from "@th/ui";
import { ON_ACCENT_FILL } from "@/lib/design-tokens";
import { DURATION, STANDARD_EASE } from "@/lib/motion";
import { feeWaivedCentsFor } from "@/lib/pricing/fee-waiver";
import {
  preHoldDiscountCents,
  preHoldHasRows,
  preHoldLineCents,
  preHoldRowsCharge,
  preHoldRowsOrder,
  type PreHoldEstimate,
} from "./pre-hold-rows";
import type { MemberDiscountLine } from "./useCheckoutPromoPreview";
import {
  FG as fg,
  BG as bg,
  fgAlpha,
  primaryActionHoverProps,
  primaryActionStyle,
  FS_BODY,
  FS_CAP,
  FS_SM,
} from "./checkout-tokens";

/**
 * Live height of the docked bar, published on `<html>` so `.checkout-wrapper`
 * can reserve exactly that much bottom clearance (`checkout.css`). Measured
 * rather than assumed: the bar's own `paddingBottom` resolves through
 * `env(safe-area-inset-bottom)`, which differs between a browser tab and an
 * installed PWA on the same device — and a hard-coded reserve is how the shell
 * ended up holding 96px open for an 85px bar.
 */
const CTA_BAR_HEIGHT_VAR = "--checkout-cta-bar-height";

export type MobileCTATicketType = {
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

export type MobileCTAOrderItem = {
  kind: string;
  ticketTypeId: string | null;
  qty: number;
  unitPriceCents: number;
  amountCents: number;
  /** Server line meta — read for `platformFeeWaivedCents`. */
  meta?: unknown;
};

export type MobileCTAOrder = {
  amountGrossCents: number;
  feesPlatformCents: number;
  buyerFeesCents: number;
  /** Estimated processor fee in cents — display only. */
  processorFeeCents: number;
  taxAmountCents: number;
  /** Account credit applied to the charge (see OrderSummary). */
  creditAppliedCents?: number | null;
  /** Server-stamped per-line pricing from the held order (see OrderSummary). */
  items?: MobileCTAOrderItem[];
  /** createCheckout's waiver figure — wins over the held lines once present. */
  feeWaivedCents?: number;
};

export type MobileCTABarProps = {
  totalLabel: string;
  /** Data for the expandable order tray */
  ticketTypes: MobileCTATicketType[];
  quantities: Record<string, number>;
  formatPrice: (cents: number) => string;
  subtotalCents: number;
  order: MobileCTAOrder | null;
  /**
   * Pre-hold: the `estimateCartTotal` result behind the button's total. The
   * tray renders the SAME rows as after the hold from it, so they add up to
   * the button (see `pre-hold-rows.ts`). Null ⇒ no fee, tax or discount
   * rows (calculating, or an invalid amount — the button reads "—").
   * REQUIRED, like OrderSummary's.
   */
  preHoldEstimate: PreHoldEstimate | null;
  /** Tax rate in basis points — the "Taxes (8.88%)" label, as in the summary. */
  taxRateBps?: number | null;
  /**
   * After `createCheckout` the order's gross is POST-discount; the Subtotal
   * row adds the discount back, exactly as OrderSummary does.
   */
  isPostCheckout?: boolean;
  /** Seat labels keyed by ticket-type id (assigned-seating only) */
  selectedSeatLabels?: Record<string, string[]>;
  /** Handler to trigger checkout / payment. */
  onCheckout?: () => void;
  /** Label for the pay button (e.g. "Pay $35.00"). */
  payButtonLabel?: string;
  /** Whether a checkout/payment action is in progress. */
  isPending?: boolean;
  /** Human-readable rate label for the platform fee, e.g. "5%". */
  platformFeeRateLabel?: string | null;
  /** Human-readable rate label for the processing fee, e.g. "2.9% + $0.30". */
  processorFeeRateLabel?: string | null;
  /**
   * Effective fee mode. In PASS_THROUGH the buyer funds the processor fee, so
   * it is a charged line that sums into the Total; in ABSORB it is a display-
   * only estimate (annotated "Included") that is NOT part of the Total.
   */
  feeMode?: "ABSORB" | "PASS_THROUGH" | null;
  /**
   * The live promo discount (the total on the button already has it priced
   * in). Shown as rows — member benefits labelled, the typed-code remainder
   * on "Discount" — exactly as OrderSummary does, so the tray's rows sum to
   * the button instead of standing $X above it.
   */
  promoDiscountCents?: number;
  memberDiscounts?: MemberDiscountLine[] | null;
};

/**
 * Fixed bottom bar for mobile (< 960px) — the step's ONE primary action, in
 * the same position on every step, with the running total beside it.
 *
 * Checkout suppresses the shell's `ConsumerBottomNav` (see its
 * `HIDDEN_PREFIXES`), so on a phone this is the only dock on screen and the
 * only thing competing for the bottom of the viewport. Tap the total to expand
 * a tray with the line items, fees and tax.
 */
export const MobileCTABar = ({
  totalLabel,
  ticketTypes,
  quantities,
  formatPrice,
  subtotalCents: _subtotalCents,
  order,
  preHoldEstimate,
  taxRateBps = null,
  isPostCheckout = false,
  selectedSeatLabels,
  onCheckout,
  payButtonLabel,
  isPending,
  platformFeeRateLabel,
  processorFeeRateLabel,
  feeMode,
  promoDiscountCents = 0,
  memberDiscounts,
}: MobileCTABarProps) => {
  const t = useTranslations();
  // A fee waiver the hold priced — explains a platform fee under step 1's.
  const feeWaivedCents = feeWaivedCentsFor(order);
  // Step 1 renders the held rows from its estimate (owner ruling 2026-10-01),
  // exactly as OrderSummary does. A free cart keeps no fee rows.
  const preHoldRows =
    !order && preHoldHasRows(preHoldEstimate) ? preHoldEstimate : null;
  const rowsOrder: MobileCTAOrder | null =
    order ??
    (preHoldRows
      ? {
          ...preHoldRowsOrder(preHoldRows, feeMode),
          // The tray reads the charge's processor fee and tax off the order.
          processorFeeCents: preHoldRowsCharge(preHoldRows, feeMode)
            .processorFeeCents ?? 0,
        }
      : null);
  // ABSORB before the hold: no absorbed fee figure exists (the estimate
  // prices what the buyer pays) — "Included" alone.
  const absorbedFeeFigureKnown = order != null;
  // Discounts are rows only beside a priced cart: after the hold, or before
  // it once the estimate is known (never beside "—" or "Calculating…").
  const showDiscountRows = order != null || preHoldEstimate != null;
  const discountForRows = order
    ? promoDiscountCents
    : preHoldDiscountCents(promoDiscountCents, preHoldEstimate);
  // Same split as OrderSummary: labelled member lines, the rest on "Discount".
  const memberDiscountLines = (memberDiscounts ?? []).filter(
    (line) => line.discountCents > 0,
  );
  const memberDiscountTotalCents = Math.min(
    memberDiscountLines.reduce((sum, line) => sum + line.discountCents, 0),
    discountForRows,
  );
  const codeDiscountCents = Math.max(
    0,
    discountForRows - memberDiscountTotalCents,
  );
  const [expanded, setExpanded] = useState(false);
  const barRef = useRef<HTMLDivElement | null>(null);

  // Publish the docked height so the page can clear it. `display: none` above
  // 959px measures 0, which is the desktop truth — no bar, no reserve. The
  // tray is excluded: it opens over the page rather than pushing it, so
  // reserving its height would leave a hole when it closes.
  useEffect(() => {
    const root = document.documentElement;
    const el = barRef.current;
    if (!el) return;
    const apply = () => {
      const row = el.lastElementChild as HTMLElement | null;
      const height = row ? row.getBoundingClientRect().height : 0;
      if (height > 0) {
        root.style.setProperty(CTA_BAR_HEIGHT_VAR, `${Math.round(height)}px`);
      } else {
        root.style.removeProperty(CTA_BAR_HEIGHT_VAR);
      }
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty(CTA_BAR_HEIGHT_VAR);
    };
  }, []);

  if (typeof document === "undefined") return null;

  const selectedTickets = ticketTypes
    .map((tt) => ({ ...tt, qty: quantities[tt.id] ?? 0 }))
    .filter((tt) => tt.qty > 0);

  // Once an order exists, line amounts come from its server-stamped items
  // (base pricing — consistent with the fee/tax rows below). The pre-hold
  // fee-inclusive estimate would contradict the server-derived total in the
  // bar. Mirrors the same switch in OrderSummary.
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

  return createPortal(
    <>
      <style>{`
        .mobile-cta-bar { display: none !important; }
        .mobile-cta-backdrop { display: none !important; }
        @media (max-width: 959px) {
          .mobile-cta-backdrop {
            display: block !important;
            position: fixed;
            inset: 0;
            /* zIndexTokens.overlay. Inlined because that module is not
               re-exported from @th/ui — same as MobileNavMenu. NOT the DS
               folder's --z-drawer: 300; our z-scale diverges from it on
               purpose (see tokens/z-index.ts) and 300 would put this dock
               under every dropdown. */
            z-index: 1300;
            /* The design system's one sanctioned scrim (guidelines/elevation,
               MobileNavSheet). It was a bare black 45% here, which is off the
               palette — the ink is warm, and a neutral black over cream reads
               grey. */
            background: rgba(33,28,22,0.72);
            opacity: 0;
            transition: opacity ${DURATION.fast}ms ${STANDARD_EASE};
            pointer-events: none;
          }
          .mobile-cta-backdrop.open {
            opacity: 1;
            pointer-events: auto;
          }
          .mobile-cta-bar {
            display: flex !important;
            flex-direction: column;
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            /* zIndexTokens.drawer — above its own scrim, below modal (1400) so
               the hold-release dialog still covers it. Replaces an invented
               1000, which tied with the dropdown layer. */
            z-index: 1350;
            background: ${bg};
            border-top: 2px solid var(--borderColorSoft, rgba(33,28,22,0.3));
          }
        }
      `}</style>
      {/* Backdrop overlay — tapping it minimizes the tray */}
      <div
        className={`mobile-cta-backdrop${expanded ? " open" : ""}`}
        onClick={() => setExpanded(false)}
        aria-hidden
      />
      <div className="mobile-cta-bar" ref={barRef}>
        {/* Expandable order tray */}
        {expanded && (
          <div
            style={{
              maxHeight: "50vh",
              overflowY: "auto",
              padding: "16px 20px 8px",
              borderBottom: "1px solid var(--borderColorSoft, rgba(33,28,22,0.3))",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {/* Minimize handle */}
            <button
              type="button"
              onClick={() => setExpanded(false)}
              style={{
                all: "unset",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "2px 0 6px",
              }}
              aria-label={String(t("cart.minimize"))}
            >
              <div
                style={{
                  width: 36,
                  height: 4,
                  borderRadius: 0,
                  background: fgAlpha(25),
                }}
              />
            </button>
            {selectedTickets.map((tt) => (
              <div
                key={tt.id}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: FS_BODY,
                    color: fgAlpha(90),
                  }}
                >
                  <span>
                    <span style={{ fontWeight: 500, color: fg }}>
                      {tt.qty}&times;
                    </span>{" "}
                    {tt.name}
                  </span>
                  <span
                    data-testid="mobile-cta-line-value"
                    style={{
                      fontVariantNumeric: "tabular-nums",
                      flexShrink: 0,
                    }}
                  >
                    {(() => {
                      // Face × qty on both steps — fees and tax have their
                      // own rows below, so the rows sum to the button.
                      // Mirrors OrderSummary.
                      const priceCell = order
                        ? (orderLineCentsByTicketType.get(tt.id) ??
                          tt.priceCents * tt.qty)
                        : preHoldLineCents(tt, tt.qty);
                      // An invalid amount is said under the name instead.
                      if (!order && tt.chosenAmountInvalid) return null;
                      if (priceCell === 0) return String(t("common.free"));
                      return formatPrice(priceCell);
                    })()}
                  </span>
                </div>
                {!order && tt.chosenAmountInvalid && (
                  <span
                    data-testid="mobile-cta-line-invalid"
                    style={{ fontSize: FS_SM, color: fgAlpha(90), paddingLeft: 2 }}
                  >
                    {String(t("checkout.pwywEnterValidAmount"))}
                  </span>
                )}
                {selectedSeatLabels?.[tt.id]?.length ? (
                  <span
                    style={{ fontSize: FS_SM, color: fgAlpha(90), paddingLeft: 2 }}
                  >
                    {selectedSeatLabels[tt.id].join(", ")}
                  </span>
                ) : null}
              </div>
            ))}

            {/* Fees + tax — the held order's, or step 1's estimate. */}
            {rowsOrder && (
              <>
                <div
                  style={{
                    height: 1,
                    background: "var(--borderColorSoft, rgba(33,28,22,0.3))",
                    margin: "4px 0",
                  }}
                />
                {/* Subtotal — the summary's row, so the tray reads the same. */}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: FS_SM,
                    color: fg,
                  }}
                >
                  <span>{String(t("checkout.subtotal"))}</span>
                  <span
                    data-testid="mobile-cta-subtotal-value"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {formatPrice(
                      isPostCheckout && order
                        ? rowsOrder.amountGrossCents + promoDiscountCents
                        : rowsOrder.amountGrossCents,
                    )}
                  </span>
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: FS_SM,
                    color: fg,
                  }}
                >
                  <span>
                    {String(t("checkout.platformFee"))}
                    {platformFeeRateLabel && (
                      <span
                        style={{ marginLeft: 4, fontSize: FS_CAP, opacity: 0.55 }}
                      >
                        {String(
                          t("checkout.feeRateLabel", { rate: platformFeeRateLabel }),
                        )}
                      </span>
                    )}
                  </span>
                  {feeMode === "PASS_THROUGH" ? (
                    <span
                      data-testid="mobile-cta-platform-fee-value"
                      style={{ fontVariantNumeric: "tabular-nums" }}
                    >
                      {formatPrice(rowsOrder.feesPlatformCents)}
                    </span>
                  ) : (
                    // ABSORB: the organiser absorbs it — not part of the
                    // Total, so shown like the absorbed processing fee below
                    // (it used to read as a charged row, and the rows summed
                    // above the Total).
                    <span
                      data-testid="mobile-cta-platform-fee-included"
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        gap: 6,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {absorbedFeeFigureKnown && (
                        <span style={{ opacity: 0.55 }}>
                          {formatPrice(rowsOrder.feesPlatformCents)}
                        </span>
                      )}
                      <span
                        style={{ fontSize: FS_CAP, opacity: 0.55, fontStyle: "italic" }}
                      >
                        {String(t("checkout.included"))}
                      </span>
                    </span>
                  )}
                </div>
                {feeMode === "PASS_THROUGH" && feeWaivedCents > 0 && (
                  <div
                    data-testid="mobile-cta-fee-waived"
                    style={{ fontSize: FS_CAP, color: fg, opacity: 0.7 }}
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
                    fontSize: FS_SM,
                    color: fg,
                  }}
                >
                  <span>
                    {String(t("checkout.processingFee"))}
                    {processorFeeRateLabel && (
                      <span
                        style={{ marginLeft: 4, fontSize: FS_CAP, opacity: 0.55 }}
                      >
                        {String(
                          t("checkout.feeRateLabel", { rate: processorFeeRateLabel }),
                        )}
                      </span>
                    )}
                  </span>
                  {feeMode === "PASS_THROUGH" ? (
                    <span
                      data-testid="mobile-cta-processing-fee-value"
                      style={{ fontVariantNumeric: "tabular-nums" }}
                    >
                      {formatPrice(rowsOrder.processorFeeCents)}
                    </span>
                  ) : (
                    // ABSORB: the buyer never pays this, nor does the organiser
                    // (the platform pays it, out of its own balance). Annotated
                    // so the breakdown doesn't appear to sum higher than the Total.
                    <span
                      data-testid="mobile-cta-processing-fee-included"
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        gap: 6,
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {absorbedFeeFigureKnown && (
                        <span style={{ opacity: 0.55 }}>
                          {formatPrice(rowsOrder.processorFeeCents)}
                        </span>
                      )}
                      <span
                        style={{ fontSize: FS_CAP, opacity: 0.55, fontStyle: "italic" }}
                      >
                        {String(t("checkout.included"))}
                      </span>
                    </span>
                  )}
                </div>
                {/* Taxes — always a row, with its rate, exactly as in the
                    summary ("Included" when nothing is owed). */}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: FS_SM,
                    color: fg,
                  }}
                >
                  <span>
                    {String(t("checkout.taxes"))}
                    {taxRateBps != null && taxRateBps > 0 && (
                      <span
                        style={{ marginLeft: 4, fontSize: FS_CAP, opacity: 0.55 }}
                      >
                        ({+(taxRateBps / 100).toFixed(2)}%)
                      </span>
                    )}
                  </span>
                  {/* "$0.00" at zero tax, as the summary (owner ruling
                      2026-10-01) — never "Included". */}
                  <span
                    data-testid="mobile-cta-tax-value"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {formatPrice(rowsOrder.taxAmountCents)}
                  </span>
                </div>
                {(order?.creditAppliedCents ?? 0) > 0 && (
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: FS_SM,
                      color: fg,
                    }}
                  >
                    <span>{String(t("checkout.creditApplied"))}</span>
                    <span
                      style={{
                        fontVariantNumeric: "tabular-nums",
                        color: "var(--success, #166534)",
                      }}
                    >
                      −{formatPrice(order?.creditAppliedCents ?? 0)}
                    </span>
                  </div>
                )}
              </>
            )}

            {/* Discounts — before AND after the hold, since the button's
                total has them priced in either way. */}
            {showDiscountRows &&
              memberDiscountTotalCents > 0 &&
              memberDiscountLines.map((line, index) => (
                <div
                  key={`member-discount-${index}`}
                  data-testid="mobile-cta-member-discount-row"
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: FS_SM,
                    color: fg,
                  }}
                >
                  <span>
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
            {showDiscountRows && codeDiscountCents > 0 && (
              <div
                data-testid="mobile-cta-discount-row"
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: FS_SM,
                  color: fg,
                }}
              >
                <span>{String(t("checkout.discount"))}</span>
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
          </div>
        )}

        {/* Main bar row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "12px 20px",
            paddingBottom: "max(12px, env(safe-area-inset-bottom))",
          }}
        >
          {/* Total — tap to expand/collapse tray */}
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            aria-expanded={expanded}
            style={{
              all: "unset",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
              // ≥44px tap target on touch surfaces
              minHeight: 44,
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span
                style={{
                  fontSize: FS_SM,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  color: fgAlpha(90),
                }}
              >
                {String(t("checkout.total"))}
              </span>
              <span
                data-testid="mobile-cta-total-value"
                style={{
                  fontSize: 20,
                  fontWeight: 700,
                  fontVariantNumeric: "tabular-nums",
                  color: fg,
                }}
              >
                {totalLabel}
              </span>
            </div>
            <ChevronUp
              size={16}
              style={{
                color: fgAlpha(50),
                transition: "transform 0.2s",
                transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
              }}
            />
          </button>

          {/* Pay / Continue CTA — the step's ONE primary on mobile, so it
              wears the same treatment as the other two ("Hold tickets" in the
              sidebar, "Continue to payment" inline). It used to carry the
              muted ink wash `checkout-tokens` describes as reading disabled;
              it was the last of the three still doing so, because it had been
              stood down while the bottom nav owned this slot. */}
          {onCheckout ? (
            <button
              type="button"
              className="checkout-primary-action"
              onClick={onCheckout}
              disabled={isPending}
              style={primaryActionStyle(Boolean(isPending), {
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                padding: "12px 24px",
                // ≥44px tap target on touch surfaces
                minHeight: 44,
                boxSizing: "border-box",
                fontSize: FS_BODY,
                // The bar row is `space-between`: the total keeps its
                // intrinsic width and the CTA takes the rest, rather than
                // `primaryActionStyle`'s full-bleed 100%.
                width: "auto",
                flex: "1 1 auto",
                whiteSpace: "nowrap",
              })}
              {...primaryActionHoverProps(Boolean(isPending))}
            >
              {isPending && <Spinner size="sm" indicatorColor={ON_ACCENT_FILL} />}
              {payButtonLabel ?? String(t("checkout.continue"))}
            </button>
          ) : (
            /* Secure badge (fallback if no checkout handler) */
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: FS_SM,
                color: fgAlpha(65),
              }}
            >
              <ShieldCheck size={14} />
            </span>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
};
