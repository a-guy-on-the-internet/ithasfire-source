import { describe, expect, it } from "vitest";

import { createTranslator } from "@th/locale";

import enMessages from "@/i18n/messages/en";
import esMessages from "@/i18n/messages/es";

import { formatErrorMessage } from "../format-error-message";

/**
 * `seat_price_changed`: checkout refuses an order when a seat's price
 * override changed between the buyer's quote and the charge
 * (docs/specs/2026-08-12/seat-price-overrides.spec.yaml D-007). It is thrown
 * in the same `{ code: "conflict", message }` shape as `seat_unavailable`, so
 * the buyer must get a sentence, never the generic fallback or the raw code.
 *
 * `errors.seatPriceChanged` is in the en + es catalogs; the inline copy is
 * the fallback for call sites that pass no translator.
 */
const COPY =
  "The price of one of your seats changed. Check the new price and try again.";

describe("formatErrorMessage — seat_price_changed", () => {
  it("has buyer copy without a translator", () => {
    expect(formatErrorMessage(new Error("seat_price_changed"))).toBe(COPY);
  });

  it("pins the en catalog entry and the inline fallback to the same sentence", () => {
    expect(
      (enMessages.errors as Record<string, string>).seatPriceChanged,
    ).toBe(COPY);
    const t = createTranslator("en", enMessages as never).t;
    expect(formatErrorMessage(new Error("seat_price_changed"), t)).toBe(COPY);
  });

  it("resolves the es catalog entry when a translator is passed", () => {
    const t = createTranslator("es", esMessages as never).t;
    expect(formatErrorMessage(new Error("seat_price_changed"), t)).toBe(
      "El precio de uno de tus asientos cambió. Revisa el nuevo precio e inténtalo de nuevo.",
    );
  });
});

describe("formatErrorMessage — SEAT_PRICE_OVERRIDE_* codes", () => {
  const cases = [
    ["SEAT_PRICE_OVERRIDE_ADJUSTABLE_TIER", "seatPriceOverrideAdjustableTier"],
    ["SEAT_PRICE_OVERRIDE_NO_FIXED_TIER", "seatPriceOverrideNoFixedTier"],
  ] as const;

  it.each(cases)("%s resolves the en catalog copy", (code, key) => {
    const t = createTranslator("en", enMessages as never).t;
    const expected = (enMessages.errors as Record<string, string>)[key];
    expect(expected).toMatch(/^No prices were saved\./);
    expect(formatErrorMessage(new Error(code), t)).toBe(expected);
  });

  it.each(cases)("%s resolves the es catalog copy", (code, key) => {
    const t = createTranslator("es", esMessages as never).t;
    const expected = (esMessages.errors as Record<string, string>)[key];
    expect(expected).toMatch(/^No se guardó ningún precio\./);
    expect(formatErrorMessage(new Error(code), t)).toBe(expected);
  });
});
