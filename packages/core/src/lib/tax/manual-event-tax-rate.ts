/**
 * A rate an Owner, Admin or Editor of the event's org entered by hand, because
 * the tax provider could not answer at the door (owner ruling R5, spec
 * docs/specs/2026-10-07/door-sales-same-price-and-tax.spec.yaml FR-007).
 *
 * Stored as an ordinary event stamp (`Event.admissionTaxRateBps`, basis
 * points) with this `Event.taxRateSource`, so every surface that reads the
 * stamp — online checkout, the door, the event page's all-in price — charges
 * and shows the same rate. Who entered it and when is an audit row
 * (`action: "event_manual_tax_rate_set"`).
 *
 * Unlike every other stamp it is PROVISIONAL: `prepareCheckoutTax` still asks
 * the provider on each sale, and the first successful answer replaces it
 * (reported when the rates differ). A failed answer keeps it: the sale is
 * charged the manual rate, never 0%.
 *
 * `"manual:event"`, not the bare `"manual"` some Place / SavedLocation cache
 * rows are documented to carry: an event stamped from such a venue cache
 * copies that label, and it must not be mistaken for a rate typed at the door
 * (it would be re-looked-up, and "replaced" by itself, on every sale).
 */
export const MANUAL_EVENT_TAX_RATE_SOURCE = "manual:event";

/**
 * Highest rate a person may enter: 25.00%, in basis points.
 *
 * The highest combined US sales-tax rate is under 12%; admission and
 * amusement taxes are separate lines (`tax-impositions.ts`), never folded into
 * this rate. 25% leaves room for any real jurisdiction and still refuses the
 * slips that charge a whole event wrong: a rate typed in basis points where a
 * percent was meant (925 for 9.25% → 92,500 bps), or a misplaced decimal
 * (92.5%).
 */
export const MANUAL_EVENT_TAX_RATE_MAX_BPS = 2_500;

/** The rate of a hand-entered stamp, or `null` when the event carries none. */
export function manualEventTaxRateBps(event: {
  admissionTaxRateBps?: number | null;
  taxRateSource?: string | null;
}): number | null {
  return event.taxRateSource === MANUAL_EVENT_TAX_RATE_SOURCE &&
    event.admissionTaxRateBps != null
    ? event.admissionTaxRateBps
    : null;
}
