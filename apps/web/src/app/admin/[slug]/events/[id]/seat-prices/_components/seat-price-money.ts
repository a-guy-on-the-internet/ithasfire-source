import {
  parseMoneyInputToCents,
  type ParseMoneyInputFailure,
} from "@/lib/money/parse-money-input";

/**
 * Dollars in the custom price field, integer cents on the wire.
 *
 * Reading goes through the app's one money parser (`parseMoneyInputToCents`:
 * integer arithmetic on the digit string, `15,50` and `15.50` both read,
 * negatives refused). That parser refuses exactly three digits after a lone
 * separator ("19.999", "1,500") as ambiguous, since either could be thousands,
 * and ROUNDS any longer fraction, which is right for a pasted amount and wrong
 * here: "19.9999" would be saved and shown to buyers as $20.00, a price the
 * organizer never typed. So this field also refuses anything finer than a
 * cent, and anything the write's integer column cannot hold.
 */

/**
 * The largest price the write accepts, in cents: Postgres INT4. Restated from
 * core's `MAX_SEAT_PRICE_OVERRIDE_CENTS` because the web app does not import
 * core; above it the organizer would read the write's raw validation text.
 */
export const MAX_CUSTOM_PRICE_CENTS = 2_147_483_647;

export type CustomPriceInputFailure =
  | ParseMoneyInputFailure
  /** More than two decimal places. */
  | "tooPrecise"
  /** Above {@link MAX_CUSTOM_PRICE_CENTS}. */
  | "tooLarge";

export type CustomPriceInputResult =
  | { ok: true; cents: number }
  | { ok: false; reason: CustomPriceInputFailure };

const countOf = (text: string, char: string) => text.split(char).length - 1;

/**
 * How many digits follow the decimal separator, by the shared parser's own
 * reading of `.` and `,`: with both present the last one is the decimal; one
 * kind repeated is grouping (no decimals); one kind once is the decimal. Only
 * called on input the shared parser accepted, so the ambiguous `1,500` shape
 * never reaches here.
 */
function decimalPlaces(raw: string): number {
  const dots = countOf(raw, ".");
  const commas = countOf(raw, ",");
  if (dots === 0 && commas === 0) return 0;
  const oneKindRepeated = (dots === 0 || commas === 0) && dots + commas > 1;
  if (oneKindRepeated) return 0;
  const afterLastSeparator = /[.,](\d*)\D*$/.exec(raw);
  return afterLastSeparator?.[1]?.length ?? 0;
}

export function parseCustomPriceInput(raw: string): CustomPriceInputResult {
  const parsed = parseMoneyInputToCents(raw);
  if (!parsed.ok) return parsed;
  if (decimalPlaces(raw) > 2) return { ok: false, reason: "tooPrecise" };
  if (parsed.cents > MAX_CUSTOM_PRICE_CENTS) {
    return { ok: false, reason: "tooLarge" };
  }
  return parsed;
}

/**
 * Cents as the text the field shows when it is prefilled: `1999` → `"19.99"`.
 * Integer arithmetic, so no float can creep in, and no grouping, so the
 * parser reads it back to the same cents.
 */
export function centsToInputValue(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) return "";
  const whole = Math.trunc(cents / 100);
  const fraction = String(cents % 100).padStart(2, "0");
  return `${whole}.${fraction}`;
}

/**
 * The currency's short symbol for the field label: "$" for USD. Falls back
 * to the code itself for a currency `Intl` does not know.
 */
export function currencySymbolFor(currency: string): string {
  const code = currency.toUpperCase();
  try {
    const parts = new Intl.NumberFormat("en", {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol",
    }).formatToParts(0);
    return parts.find((part) => part.type === "currency")?.value ?? code;
  } catch {
    return code;
  }
}
