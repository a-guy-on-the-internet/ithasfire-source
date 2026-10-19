import { describe, expect, it } from "vitest";

import enMessages from "@/i18n/messages/en";
import esMessages from "@/i18n/messages/es";

import { cashRefundError } from "../cash-refund-error";

/**
 * `orders.orgRefundCashSale` refusals, shared by the Orders panel and
 * Sell → Cash taken tonight: each resolves to catalog copy in both locales,
 * and the two that mean "what you see is stale" ask for a re-read.
 */

// ─── Error copy, resolved against the REAL catalogs ────────────────────────

function translator(messages: unknown) {
  return (key: string): string => {
    let node: unknown = messages;
    for (const part of key.split(".")) {
      if (node && typeof node === "object" && part in node) {
        node = (node as Record<string, unknown>)[part];
      } else {
        return key;
      }
    }
    return typeof node === "string" ? node : key;
  };
}

/** The shape a TRPCClientError reaches the panel in. */
function trpcError(message: string, appCode?: string) {
  return Object.assign(new Error(message), {
    data: appCode ? { appCode } : {},
  });
}

const GENERIC = "Something went wrong. Please try again.";

describe("cashRefundError", () => {
  const cases: Array<[string, Error, boolean]> = [
    [
      "window closed",
      trpcError("cash_refund_window_closed", "CASH_REFUND_WINDOW_CLOSED"),
      true,
    ],
    ["order no longer SUCCEEDED", trpcError("order_not_refundable"), true],
    ["role refused", trpcError("INSUFFICIENT_ROLE", "INSUFFICIENT_ROLE"), false],
    ["order not this org's", trpcError("ORDER_NOT_FOUND", "ORDER_NOT_FOUND"), false],
    ["event gone", trpcError("EVENT_NOT_FOUND", "EVENT_NOT_FOUND"), false],
    ["card order", trpcError("NOT_A_CASH_ORDER", "NOT_A_CASH_ORDER"), false],
  ];

  for (const [locale, messages] of [
    ["en", enMessages],
    ["es", esMessages],
  ] as const) {
    it.each(cases)(
      `${locale}: %s resolves to catalog copy`,
      (_label, error, refetch) => {
        const result = cashRefundError(error, translator(messages));
        expect(result.refetch).toBe(refetch);
        expect(result.message).not.toBe(GENERIC);
        expect(result.message).not.toMatch(/^errors\./);
        expect(result.message).not.toMatch(/^[a-z_]+$|^[A-Z_]+$/);
      },
    );
  }

  it("en: the closed window says support can still refund it", () => {
    const { message } = cashRefundError(
      trpcError("cash_refund_window_closed", "CASH_REFUND_WINDOW_CLOSED"),
      translator(enMessages),
    );
    expect(message).toMatch(/support/i);
  });
});
