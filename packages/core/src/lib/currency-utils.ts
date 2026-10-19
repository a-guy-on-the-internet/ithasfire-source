/**
 * Stripe zero-decimal currency + money display helpers.
 *
 * THE IMPLEMENTATION MOVED DOWN A LAYER. It now lives in `@th/types`
 * (`packages/types/src/money.ts`) because `@th/ui` cannot import `@th/core`
 * (its deps are `@th/locale` / `@th/schema` / `@th/types` only) — which is
 * exactly why a currency-blind duplicate grew there and rendered a ¥2,500 JPY
 * event as "$25". `@th/types` is the one module both `@th/core` and `@th/ui`
 * can reach.
 *
 * This file stays as the `@th/core/lib/currency-utils` entry point so the ~11
 * existing callers (use cases, `apps/web/src/lib/format.ts`) keep working
 * unchanged. Same names, same signatures, same behaviour — do not add logic
 * here; add it to `@th/types/money`.
 *
 * @see https://docs.stripe.com/currencies#zero-decimal
 */

export {
  ZERO_DECIMAL_CURRENCIES,
  isZeroDecimalCurrency,
  toMajorUnits,
  toMinorUnits,
  currencyFractionDigits,
  formatCents,
  formatMoneyCents,
  formatPriceCents,
  formatDollarsFromCents,
} from "@th/types/money";

export type {
  FormatMoneyCentsOptions,
  FormatPriceCentsOptions,
} from "@th/types/money";
