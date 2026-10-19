import { describe, expect, it } from "vitest";

import { readDomainMeta, toTrpcError } from "./utils";

/**
 * The checkout prunes the promo code a rejection NAMES. That name travels in
 * the legacy use-case error's `meta` bag, which `toTrpcError` forwards and the
 * router's errorFormatter puts on the wire as `data.meta` (via
 * `readDomainMeta`). Pins the hop from core to the wire.
 */
describe("promo rejection meta reaches the wire", () => {
  it.each([
    ["invalid_input", "promo_min_order_not_met", "BAD_REQUEST"],
    ["invalid_input", "promo_not_applicable", "BAD_REQUEST"],
    ["conflict", "promo_max_redeemed", "CONFLICT"],
  ] as const)("%s / %s → data.meta.promoCode", (code, message, trpcCode) => {
    const error = toTrpcError({
      code,
      message,
      promoCode: "EARLYBIRD",
      meta: { promoCode: "EARLYBIRD" },
    });
    expect(error.code).toBe(trpcCode);
    expect(error.message).toBe(message);
    expect(readDomainMeta(error)).toMatchObject({ promoCode: "EARLYBIRD" });
  });
});
