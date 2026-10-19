"use client";

import { useTranslations } from "@th/ui";

import {
  preHoldHasRows,
  type PreHoldEstimate,
} from "@/app/events/checkout/[...slug]/_components/pre-hold-rows";

import type { EmbedOrderFees, EmbedOrderLineItem } from "./embed-types";
import { BORDER_SUBTLE, SUCCESS, TEXT, TEXT_CAPTION, TEXT_MUTED } from "./embed-theme";
import { formatCurrencyExact } from "./embed-helpers";

/**
 * The embed's order rows — the SAME rows as main checkout's step 1 and step 2:
 * each line at face × qty, then Subtotal, Platform fee, Processing fee and
 * Taxes ("$0.00" at zero — owner ruling 2026-10-01). Before the order exists
 * they come from ONE `estimateCartTotal` result (whose `totalCents` is the
 * total shown under them); after `createGuestCheckout`, from the stamped
 * order. Either way:
 *
 *   PASS_THROUGH: Subtotal + Platform + Processing + Taxes = Total
 *   ABSORB:       Subtotal + Taxes = Total (the fee rows read "Included")
 *
 * The lines used to show the all-in "$40.08" / "$51.09 each", which no row
 * below them could add up to.
 */

export type EmbedSummaryFigures = {
  /** Subtotal — PRE-discount (Σ face × qty). */
  grossCents: number;
  /**
   * The order's discount (promo / member), after `createGuestCheckout` only:
   * its stamped gross is POST-discount, so the rows add the discount back
   * onto the Subtotal and show it as its own row — main checkout's
   * post-checkout pattern. 0 before the order (the embed has no preview).
   */
  discountCents: number;
  /** PASS_THROUGH: what the buyer pays. ABSORB: the absorbed fee (dimmed). */
  platformFeeCents: number;
  processorFeeCents: number;
  taxCents: number;
  /**
   * ABSORB rows show their dimmed figure only once an order priced it: the
   * estimate prices what the BUYER pays, so there is no absorbed figure
   * before the order (main checkout does the same).
   */
  absorbedFigureKnown: boolean;
};

/** Step-1 rows from the estimate; null when it has none (unknown / free). */
export function embedFiguresFromEstimate(
  estimate: PreHoldEstimate | null | undefined,
): EmbedSummaryFigures | null {
  if (!preHoldHasRows(estimate)) return null;
  return {
    grossCents: estimate.grossCents,
    discountCents: 0,
    platformFeeCents: estimate.platformFeeCents,
    processorFeeCents: estimate.processorFeeCents,
    taxCents: estimate.taxCents,
    absorbedFigureKnown: false,
  };
}

/**
 * Rows from the stamped order (after `createGuestCheckout`). Its
 * `amountGrossCents` is the gross AFTER any promo / member discount, so the
 * discount is what the face lines (`linesCents`, Σ face × qty of the
 * order's persisted lines) exceed it by: shown as a Discount row, added back onto the Subtotal,
 * so Subtotal + fees + tax − discount = the charge.
 */
export function embedFiguresFromOrder(
  order: EmbedOrderFees,
  feeMode: "ABSORB" | "PASS_THROUGH" | null | undefined,
  linesCents: number,
): EmbedSummaryFigures {
  const discountCents = Math.max(0, linesCents - order.amountGrossCents);
  return {
    grossCents: order.amountGrossCents + discountCents,
    discountCents,
    // The buyer's platform fee is `buyerFeesCents` (what the charge adds);
    // in ABSORB it is 0 and the row shows the absorbed fee, dimmed.
    platformFeeCents:
      feeMode === "PASS_THROUGH" ? order.buyerFeesCents : order.feesPlatformCents,
    processorFeeCents: order.processorFeeCents,
    taxCents: order.taxAmountCents,
    absorbedFigureKnown: true,
  };
}

export type EmbedSummaryLine = {
  id: string;
  name: string;
  qty: number;
  /** face × qty — the buyer's amount on a pay-what-you-want tier. */
  lineCents: number;
};

/**
 * The order's lines as the SERVER priced them (`createGuestCheckout`'s
 * `lineItems`, one per ticket type and unit price), for the rows once the
 * order exists. The cart can disagree with the charge — a seat the buyer saw
 * plain may have been given an override before Continue, and is charged it
 * unquoted (seat-price-overrides FR-004) — so after the order every number,
 * lines included, is the server's. Pre-discount, so Σ lineCents −
 * amountGrossCents is the Discount row. `null` when there are none to show
 * (the read-back failed): callers keep their cart lines.
 */
export function embedLinesFromOrder(
  lineItems: readonly EmbedOrderLineItem[] | null | undefined,
): EmbedSummaryLine[] | null {
  if (!lineItems || lineItems.length === 0) return null;
  return lineItems.map((line) => ({
    id: `${line.ticketTypeId}:${line.unitPriceCents}`,
    name: line.name,
    qty: line.qty,
    lineCents: line.lineCents,
  }));
}

export function EmbedSummaryRows({
  lines,
  figures,
  feeMode,
  platformFeeRateLabel,
  processorFeeRateLabel,
  taxRateBps = null,
  currency,
  testIdPrefix,
  fontSize = 12,
}: {
  lines: EmbedSummaryLine[];
  figures: EmbedSummaryFigures | null;
  feeMode: "ABSORB" | "PASS_THROUGH" | null | undefined;
  platformFeeRateLabel?: string | null;
  processorFeeRateLabel?: string | null;
  /** The buyer's tax rate (summed PLATFORM impositions, `buyerTaxRateBps`); the Taxes row shows it when > 0 (main checkout's label). */
  taxRateBps?: number | null;
  /** Every row is EXACT money ("$35.00", "$0.00") — see formatCurrencyExact. */
  currency: string;
  /** e.g. "embed-summary" → "embed-summary-subtotal-value". */
  testIdPrefix: string;
  fontSize?: number;
}) {
  const t = useTranslations();
  const formatPrice = (cents: number) => formatCurrencyExact(cents, currency);
  const passThrough = feeMode === "PASS_THROUGH";
  const row = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    fontSize,
  } as const;
  const rate = (label: string | null | undefined) =>
    label ? (
      <span style={{ marginLeft: 4, fontSize: fontSize - 2, color: TEXT_CAPTION }}>
        ({label})
      </span>
    ) : null;
  const included = (figureCents: number, testId: string) => (
    <span
      data-testid={testId}
      style={{ display: "flex", alignItems: "baseline", gap: 4 }}
    >
      {figures?.absorbedFigureKnown && (
        <span style={{ color: TEXT_CAPTION, fontVariantNumeric: "tabular-nums" }}>
          {formatPrice(figureCents)}
        </span>
      )}
      <span style={{ fontSize: fontSize - 2, color: TEXT_CAPTION, fontStyle: "italic" }}>
        {String(t("checkout.included"))}
      </span>
    </span>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {lines.map((line) => (
        <div key={line.id} style={row}>
          <span style={{ color: TEXT_MUTED, minWidth: 0, overflowWrap: "anywhere" }}>
            {line.name} &times; {line.qty}
          </span>
          <span
            data-testid={`${testIdPrefix}-line-value`}
            style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums", color: TEXT, flexShrink: 0 }}
          >
            {formatPrice(line.lineCents)}
          </span>
        </div>
      ))}
      {figures && (
        <>
          <div style={{ height: 1, background: BORDER_SUBTLE, margin: "2px 0" }} />
          <div style={row}>
            <span style={{ color: TEXT_MUTED }}>{String(t("checkout.subtotal"))}</span>
            <span
              data-testid={`${testIdPrefix}-subtotal-value`}
              style={{ fontVariantNumeric: "tabular-nums", color: TEXT }}
            >
              {formatPrice(figures.grossCents)}
            </span>
          </div>
          <div style={row}>
            <span style={{ color: TEXT_MUTED }}>
              {String(t("checkout.platformFee"))}
              {rate(platformFeeRateLabel)}
            </span>
            {passThrough ? (
              <span
                data-testid={`${testIdPrefix}-platform-fee-value`}
                style={{ fontVariantNumeric: "tabular-nums", color: TEXT }}
              >
                {formatPrice(figures.platformFeeCents)}
              </span>
            ) : (
              included(figures.platformFeeCents, `${testIdPrefix}-platform-fee-included`)
            )}
          </div>
          <div style={row}>
            <span style={{ color: TEXT_MUTED }}>
              {String(t("checkout.processingFee"))}
              {rate(processorFeeRateLabel)}
            </span>
            {passThrough ? (
              <span
                data-testid={`${testIdPrefix}-processing-fee-value`}
                style={{ fontVariantNumeric: "tabular-nums", color: TEXT }}
              >
                {formatPrice(figures.processorFeeCents)}
              </span>
            ) : (
              included(figures.processorFeeCents, `${testIdPrefix}-processing-fee-included`)
            )}
          </div>
          <div style={row}>
            <span style={{ color: TEXT_MUTED }}>
              {String(t("checkout.taxes"))}
              {taxRateBps != null && taxRateBps > 0 && rate(`${+(taxRateBps / 100).toFixed(2)}%`)}
            </span>
            {/* Always the figure — "$0.00" for a zero-tax event. */}
            <span
              data-testid={`${testIdPrefix}-tax-value`}
              style={{ fontVariantNumeric: "tabular-nums", color: TEXT }}
            >
              {formatPrice(figures.taxCents)}
            </span>
          </div>
          {figures.discountCents > 0 && (
            <div style={row}>
              <span style={{ color: TEXT_MUTED }}>{String(t("checkout.discount"))}</span>
              <span
                data-testid={`${testIdPrefix}-discount-value`}
                style={{ fontVariantNumeric: "tabular-nums", color: SUCCESS }}
              >
                −{formatPrice(figures.discountCents)}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
