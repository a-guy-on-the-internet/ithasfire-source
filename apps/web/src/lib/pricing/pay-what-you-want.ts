import { MAX_DONATION_AMOUNT_CENTS } from "@th/core/lib/pricing/pay-what-you-want";

import { getBuyerAllInDisplayCents } from "./buyer-display";

export { MAX_DONATION_AMOUNT_CENTS };

/**
 * Pay-what-you-want (ADJUSTABLE) tiers.
 *
 * The buyer's chosen amount IS the ticket price. Platform fee, processing and
 * tax go on top of it exactly as for a fixed-price ticket of that amount
 * (`computeOrderAmounts` charges the donation as the unit price). The tier's
 * stored `priceCents` is always 0 and means nothing — never price or label a
 * PWYW tier from it.
 */

export type PayWhatYouWantTier = {
  pricingMode?: "FIXED" | "ADJUSTABLE" | null;
  minimumCents?: number | null;
  suggestedCents?: number | null;
};

export const isPayWhatYouWant = (tier: PayWhatYouWantTier): boolean =>
  tier.pricingMode === "ADJUSTABLE";

/** The least a buyer can pay: `minimumCents`, 0 when unset. */
export const payWhatYouWantFloorCents = (tier: PayWhatYouWantTier): number =>
  Math.max(0, tier.minimumCents ?? 0);

/**
 * The per-ticket estimate row a listing already holds for a tier
 * (`getCheckoutFeeRates.perTicketEstimates`, or the event page's fee map).
 */
export type PayWhatYouWantFloorEstimate = {
  buyerUnitTotalCents?: number | null;
  /** The face the server priced the row at. For a PWYW tier, its floor. */
  unitPriceCents?: number | null;
};

/**
 * The "From" figure of a pay-what-you-want tier, ALL-IN: the floor plus the
 * fees and tax a ticket at the floor is charged. It is what a buyer who picks
 * the minimum pays (owner ruling 2026-10-02: buyers see the total, as they do
 * for fixed tiers). A $5 floor at 8.88% tax, fees on top, reads $6.09.
 *
 * The figure is the server's own per-ticket row for the tier: the estimator
 * prices a PWYW row at its floor with fees and tax on top
 * (`estimate-buyer-ticket-pricing.ts`), the same math the charge runs. It is
 * read through `getBuyerAllInDisplayCents`, the helper every fixed tier's
 * figure comes from, so the event page, the embed and checkout print one
 * number.
 *
 *  - Floor 0 → 0. Callers word it "Pay what you want" (plus the suggestion),
 *    never "Free" and never "From".
 *  - No row yet, or a row priced at a face other than this floor (the minimum
 *    changed after the rates were cached) → null, which callers show as
 *    "Calculating total…". Never the bare floor: that undercuts the charge.
 */
export const payWhatYouWantFromCents = (
  tier: PayWhatYouWantTier,
  estimate: PayWhatYouWantFloorEstimate | null | undefined,
): number | null => {
  const floorCents = payWhatYouWantFloorCents(tier);
  if (floorCents === 0) return 0;
  if (
    typeof estimate?.unitPriceCents === "number" &&
    estimate.unitPriceCents !== floorCents
  ) {
    return null;
  }
  return getBuyerAllInDisplayCents(
    { priceCents: floorCents, buyerUnitTotalCents: estimate?.buyerUnitTotalCents },
    floorCents,
  );
};

/**
 * Slider ceiling for a pay-what-you-want amount: four times the suggestion
 * (20× the floor when there is none), so the suggestion sits about a quarter
 * of the way along with room above it. At least $50, and at least $10 above
 * the floor, so a small tier still gets a usable track. The box office's rule
 * (`adjustableSliderMaxCents` in the sell screen delegates here).
 */
export const amountSliderMaxCents = (tier: PayWhatYouWantTier): number => {
  const floor = tier.minimumCents ?? 0;
  const standard = tier.suggestedCents ?? 0;
  const fromStandard = standard > 0 ? standard * 4 : floor * 20;
  return Math.max(5000, floor + 1000, fromStandard);
};

/**
 * The buyer's slider ceiling: the box-office rule, stretched to reach the
 * largest preset chip, never above the $10,000 cap. A chip past the track end
 * pinned the handle under a lower "max" label, which read as a broken control
 * (the buyer's chips go to 5× the suggestion; the box office's stop at 2×, so
 * its own ceiling already covers them). The amount field still takes anything
 * up to the cap; above the track the handle pins at the end.
 */
export const payWhatYouWantSliderMaxCents = (tier: PayWhatYouWantTier): number =>
  Math.min(
    MAX_DONATION_AMOUNT_CENTS,
    Math.max(amountSliderMaxCents(tier), ...presetAmountsCents(tier)),
  );

/**
 * Pull a DRAGGED amount to a number people say out loud.
 *
 * Within 40¢ of an anchor (the floor, the suggestion) it lands on the anchor;
 * otherwise within 40¢ of a $5 multiple it snaps there; otherwise within 20¢
 * of a whole dollar. A fast drag lands on $20, not $19.85, and on a $12.50
 * suggestion rather than $12.45. You can still stop at $17.35; you have to mean
 * it.
 *
 * Typed amounts and keyboard steps never come through here: they are
 * deliberate.
 */
export const magnetizeAmountCents = (
  amountCents: number,
  anchorsCents: readonly number[] = [],
): number => {
  let nearestAnchor: number | null = null;
  for (const anchor of anchorsCents) {
    const distance = Math.abs(amountCents - anchor);
    if (
      distance <= 40 &&
      (nearestAnchor === null || distance < Math.abs(amountCents - nearestAnchor))
    ) {
      nearestAnchor = anchor;
    }
  }
  if (nearestAnchor !== null) return nearestAnchor;

  const FIVE = 500;
  const DOLLAR = 100;

  const nearestFive = Math.round(amountCents / FIVE) * FIVE;
  if (Math.abs(amountCents - nearestFive) <= 40) return nearestFive;

  const nearestDollar = Math.round(amountCents / DOLLAR) * DOLLAR;
  if (Math.abs(amountCents - nearestDollar) <= 20) return nearestDollar;

  return Math.round(amountCents);
};

/** The amount checkout starts at: the suggestion, never below the minimum. */
export const defaultChosenAmountCents = (tier: PayWhatYouWantTier): number => {
  const minimum = payWhatYouWantFloorCents(tier);
  return Math.min(
    MAX_DONATION_AMOUNT_CENTS,
    Math.max(minimum, tier.suggestedCents ?? minimum),
  );
};

/** Whether the server will accept `amountCents` for this tier. */
export const isChosenAmountValid = (
  tier: PayWhatYouWantTier,
  amountCents: number,
): boolean =>
  Number.isInteger(amountCents) &&
  amountCents >= payWhatYouWantFloorCents(tier) &&
  amountCents <= MAX_DONATION_AMOUNT_CENTS;

/**
 * The preset chips: half, one, two and five times the suggestion (or $10 when
 * there is none), each clamped into [minimum, cap] and de-duplicated. Clamping
 * every chip — not just the first — means no chip can offer an amount the
 * minimum or the cap would then refuse.
 */
export const presetAmountsCents = (tier: PayWhatYouWantTier): number[] => {
  const floor = payWhatYouWantFloorCents(tier);
  const base = tier.suggestedCents ?? Math.max(floor, 1000);
  const clamp = (cents: number) =>
    Math.min(MAX_DONATION_AMOUNT_CENTS, Math.max(floor, cents));
  return [Math.round(base * 0.5), base, base * 2, base * 5]
    .map(clamp)
    .filter((v, i, all) => v > 0 && all.indexOf(v) === i);
};

/**
 * The canonical "1234.56" form of what the buyer typed.
 *
 * A comma is a DECIMAL point only when it is the last separator and is
 * followed by one or two digits at the end ("12,50", "1,5" — the es habit);
 * every other comma is a thousands separator and is dropped ("1,000" is one
 * thousand, not $1.00; "1,000.50" is one thousand and fifty cents).
 */
export const normalizeAmountText = (text: string): string => {
  const trimmed = text.replace(/[\s$]/g, "");
  const commaDecimal = !trimmed.includes(".") && /,\d{1,2}$/.test(trimmed);
  if (commaDecimal) {
    const at = trimmed.lastIndexOf(",");
    return `${trimmed.slice(0, at).replace(/,/g, "")}.${trimmed.slice(at + 1)}`;
  }
  return trimmed.replace(/,/g, "");
};

/**
 * Parse the donation text field. Returns cents, or null when the field holds
 * no amount yet ("" or a lone "."). Callers only ever pass a draft that
 * `sanitizeAmountDraft` accepted, so anything else cannot occur.
 */
export const parseAmountDraft = (draft: string): number | null => {
  const canonical = normalizeAmountText(draft);
  if (canonical === "" || canonical === ".") return null;
  const value = Number(canonical);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
};

/**
 * Whole-dollar digits the field accepts: 5, enough for the $10,000.00 cap and
 * for a buyer to type one digit past it (and be told so), but never an amount
 * that could overflow anything downstream.
 */
const MAX_WHOLE_DIGITS = 5;
const CANONICAL_AMOUNT = new RegExp(`^\\d{0,${MAX_WHOLE_DIGITS}}(\\.\\d{0,2})?$`);

/**
 * Keystroke filter for the donation field. Returns the text to KEEP (what the
 * buyer typed, commas and all, so "1,0" can still become "1,000"), or null to
 * REJECT the keystroke. Accepted: digits, commas, at most one point, and a
 * canonical form (see `normalizeAmountText`) with at most five whole digits
 * and two decimals.
 */
export const sanitizeAmountDraft = (raw: string): string | null => {
  const trimmed = raw.replace(/[\s$]/g, "");
  if (!/^[\d,]*(\.\d*)?$/.test(trimmed)) return null;
  return CANONICAL_AMOUNT.test(normalizeAmountText(trimmed)) ? trimmed : null;
};

export const formatAmountDraft = (cents: number): string =>
  (cents / 100).toFixed(2);
