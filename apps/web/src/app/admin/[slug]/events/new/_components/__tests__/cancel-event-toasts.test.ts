import { describe, expect, it } from "vitest";
import {
  createTranslator,
  type MessageCatalog,
  type TranslationValues,
} from "@th/locale";

import enMessages from "@/i18n/messages/en";
import esMessages from "@/i18n/messages/es";

import { cancelEventResultToasts } from "../cancel-event-toasts";

/**
 * After `events.cancel`, one toast for the cancellation, then one per thing
 * that still needs a person (cancel-event.ts output). The door fields are
 * optional for cross-deploy replay; `undefined` says nothing.
 */

const echo = (key: string, values?: TranslationValues) =>
  values ? `${key} ${JSON.stringify(values)}` : key;

const clean = { refundedOrderCount: 3, failedRefundCount: 0 };

describe("cancelEventResultToasts", () => {
  it("a clean card-only cancellation is one success toast", () => {
    expect(cancelEventResultToasts(clean, echo)).toEqual([
      {
        tone: "success",
        id: "event-cancelled",
        title: "admin.ebEventCancelledTitle",
        message: 'admin.ebEventCancelledRefunds {"count":3}',
      },
    ]);
  });

  it("a cancellation from before the door phases (fields undefined) adds nothing", () => {
    expect(
      cancelEventResultToasts(
        { refundedOrderCount: 0, failedRefundCount: 0 },
        echo,
      ).map((toast) => toast.id),
    ).toEqual(["event-cancelled"]);
  });

  it("zeros and false add nothing", () => {
    expect(
      cancelEventResultToasts(
        {
          ...clean,
          refundedCashOrderCount: 0,
          failedCashRefundCount: 0,
          cashRefundScanFailed: false,
          failedPendingPosVoidCount: 0,
          pendingPosScanFailed: false,
        },
        echo,
      ).map((toast) => toast.id),
    ).toEqual(["event-cancelled"]);
  });

  it("surfaces every count that needs a person, with its number", () => {
    const toasts = cancelEventResultToasts(
      {
        refundedOrderCount: 0,
        failedRefundCount: 2,
        refundedCashOrderCount: 5,
        failedCashRefundCount: 1,
        cashRefundScanFailed: true,
        failedPendingPosVoidCount: 4,
        pendingPosScanFailed: true,
      },
      echo,
    );
    expect(toasts.map(({ tone, id, message }) => [tone, id, message])).toEqual([
      ["success", "event-cancelled", "admin.ebEventCancelledNoRefunds"],
      [
        "warning",
        "event-cancel-refund-failures",
        'admin.ebRefundsFailedMessage {"count":2}',
      ],
      [
        "info",
        "event-cancel-cash-refunded",
        'admin.ebCashRefundedMessage {"count":5}',
      ],
      [
        "warning",
        "event-cancel-cash-refund-failures",
        'admin.ebCashRefundsFailedMessage {"count":1}',
      ],
      [
        "warning",
        "event-cancel-cash-scan-failed",
        "admin.ebCashRefundScanFailedMessage",
      ],
      [
        "warning",
        "event-cancel-pos-void-failures",
        'admin.ebPosVoidsFailedMessage {"count":4}',
      ],
      [
        "warning",
        "event-cancel-pos-scan-failed",
        "admin.ebPosScanFailedMessage",
      ],
    ]);
  });

  it("a failed door card-sale scan is said even when the void count is zero", () => {
    const ids = cancelEventResultToasts(
      { ...clean, failedPendingPosVoidCount: 0, pendingPosScanFailed: true },
      echo,
    ).map((toast) => toast.id);
    expect(ids).toEqual(["event-cancelled", "event-cancel-pos-scan-failed"]);
  });

  it("a failed cash scan is said even when the cash counts are zero", () => {
    const ids = cancelEventResultToasts(
      {
        ...clean,
        refundedCashOrderCount: 0,
        failedCashRefundCount: 0,
        cashRefundScanFailed: true,
      },
      echo,
    ).map((toast) => toast.id);
    expect(ids).toContain("event-cancel-cash-scan-failed");
  });

  // Every key the helper can emit exists, as an ICU string that formats,
  // in BOTH catalogs.
  for (const [locale, messages] of [
    ["en", enMessages],
    ["es", esMessages],
  ] as const) {
    it(`${locale}: every key resolves and formats`, () => {
      const missing: string[] = [];
      const translator = createTranslator(
        locale,
        messages as unknown as MessageCatalog,
        { onMissingMessage: (key) => missing.push(key) },
      );
      const t = (key: string, values?: TranslationValues) =>
        translator.t(key, values);
      const toasts = cancelEventResultToasts(
        {
          refundedOrderCount: 1,
          failedRefundCount: 1,
          refundedCashOrderCount: 2,
          failedCashRefundCount: 1,
          cashRefundScanFailed: true,
          failedPendingPosVoidCount: 3,
          pendingPosScanFailed: true,
        },
        t,
      );
      expect(toasts).toHaveLength(7);
      for (const toast of toasts) {
        expect(toast.message).not.toMatch(/\{|admin\./);
      }
      expect(toasts[2]!.message).toMatch(/^2 /);
      expect(missing).toEqual([]);
    });

    // Sell lists only PUBLISHED events, so a cancelled event's cash sales
    // are refunded from Orders, which the Owner/Admin who cancelled can use.
    it(`${locale}: the cash failure toasts send the organiser to Orders, not Sell`, () => {
      const translator = createTranslator(
        locale,
        messages as unknown as MessageCatalog,
      );
      const t = (key: string, values?: TranslationValues) =>
        translator.t(key, values);
      const toasts = cancelEventResultToasts(
        {
          refundedOrderCount: 0,
          failedRefundCount: 0,
          failedCashRefundCount: 2,
          cashRefundScanFailed: true,
        },
        t,
      );
      const orders = locale === "en" ? "Orders" : "Pedidos";
      const button =
        locale === "en" ? "Refund cash sale" : "Reembolsar venta en efectivo";
      for (const id of [
        "event-cancel-cash-refund-failures",
        "event-cancel-cash-scan-failed",
      ]) {
        const message = toasts.find((toast) => toast.id === id)!.message;
        expect(message).toContain(orders);
        expect(message).toContain(button);
        expect(message).not.toMatch(/Sell|Vender|Cash taken tonight/);
      }
    });
  }
});
