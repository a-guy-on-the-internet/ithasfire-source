import { describe, expect, it } from "vitest";

import enMessages from "@/i18n/messages/en";
import esMessages from "@/i18n/messages/es";

import {
  resolvePromoMoneyField,
  resolvePromoValueField,
} from "../PromoFormDialog";

/**
 * The pure half of what `handleSubmit` does with every numeric field in the
 * promo dialog. The component wraps these with an inline error and a disabled
 * Save, so pinning them here pins the submit semantics: what gets banked, what
 * blank means, and what refuses.
 *
 * The headline regression: `sanitizeDecimalInput` stripped `,` AT KEYSTROKE
 * TIME, so an `es` organiser typing `15,50` for a fixed-amount promo watched
 * the field turn into `1550` and saved a $1,550 discount.
 */

const admin = (messages: { admin: unknown }) =>
  messages.admin as Record<string, string>;

describe("resolvePromoValueField — AMOUNT (dollars → cents)", () => {
  it("reads a plain en amount", () => {
    expect(resolvePromoValueField("15.50", "AMOUNT")).toEqual({
      kind: "value",
      value: 1550,
    });
  });

  it("reads an es comma decimal as $15.50, not $1,550.00", () => {
    // Before: the keystroke filter deleted the comma, `15,50` became `1550`,
    // and `Number.parseFloat("1550") * 100` banked 155000 cents — a 100x
    // overcharge, silently, on every redemption of that code.
    expect(resolvePromoValueField("15,50", "AMOUNT")).toEqual({
      kind: "value",
      value: 1550,
    });
    expect(resolvePromoValueField("1550", "AMOUNT")).toEqual({
      kind: "value",
      value: 155000,
    });
  });

  it("reads both thousands-separator conventions", () => {
    expect(resolvePromoValueField("1,234.56", "AMOUNT")).toEqual({
      kind: "value",
      value: 123456,
    });
    expect(resolvePromoValueField("1.234,56", "AMOUNT")).toEqual({
      kind: "value",
      value: 123456,
    });
  });

  it.each([["nonsense"], ["15abc"], ["1.2.3"], ["15 50"], ["-5"], ["1e5"]])(
    "refuses %p instead of banking a number",
    (raw) => {
      const field = resolvePromoValueField(raw, "AMOUNT");
      expect(field).toEqual({
        kind: "error",
        messageKey: "admin.cpAmountInvalid",
      });
    },
  );

  it("explains an ambiguous amount rather than guessing", () => {
    expect(resolvePromoValueField("1,500", "AMOUNT")).toEqual({
      kind: "error",
      messageKey: "admin.cpAmountAmbiguous",
    });
  });

  it("requires a value, and refuses a $0 discount", () => {
    expect(resolvePromoValueField("", "AMOUNT")).toEqual({
      kind: "error",
      messageKey: "admin.cpValueRequired",
    });
    expect(resolvePromoValueField("0", "AMOUNT")).toEqual({
      kind: "error",
      messageKey: "admin.cpValuePositive",
    });
    expect(resolvePromoValueField("0,00", "AMOUNT")).toEqual({
      kind: "error",
      messageKey: "admin.cpValuePositive",
    });
  });
});

describe("resolvePromoValueField — PERCENT (whole percent on the wire)", () => {
  it.each([
    ["20", 20],
    ["100", 100],
    ["1", 1],
    ["20.00", 20],
    ["20,00", 20],
    ["20 %", 20],
  ])("reads %p as %i percent", (raw, expected) => {
    expect(resolvePromoValueField(raw, "PERCENT")).toEqual({
      kind: "value",
      value: expected,
    });
  });

  it("refuses a fractional percent rather than rounding money silently", () => {
    // The wire contract is `z.number().int().min(1)` and settlement computes
    // `subtotal * value / 100`, so 20.5 cannot be expressed. Rounding it to 20
    // or 21 changes what every buyer pays.
    for (const raw of ["20.5", "20,5", "12,5"]) {
      expect(resolvePromoValueField(raw, "PERCENT")).toEqual({
        kind: "error",
        messageKey: "admin.cpValuePercentWhole",
      });
    }
  });

  it("refuses the old digits-only mangling of a comma decimal", () => {
    // The previous keystroke filter turned `12,5` into `125`, which then
    // tripped the 1–100 check with a message about a number nobody typed.
    expect(resolvePromoValueField("125", "PERCENT")).toEqual({
      kind: "error",
      messageKey: "admin.cpValuePercentRange",
    });
  });

  it("range-checks against 0–100", () => {
    expect(resolvePromoValueField("101", "PERCENT")).toEqual({
      kind: "error",
      messageKey: "admin.cpValuePercentRange",
    });
    expect(resolvePromoValueField("0", "PERCENT")).toEqual({
      kind: "error",
      messageKey: "admin.cpValuePositive",
    });
  });

  it.each([["nonsense"], ["-20"], ["$20"], ["20 USD"], ["12..5"], ["20 5"]])(
    "refuses %p as unreadable, NOT as a whole-number formatting problem",
    (raw) => {
      // A negative or an unreadable string has nothing to do with
      // whole-vs-fractional. Labelling it `cpValuePercentWhole` sends the
      // organiser hunting for the wrong mistake.
      expect(resolvePromoValueField(raw, "PERCENT")).toEqual({
        kind: "error",
        messageKey: "admin.cpAmountInvalid",
      });
    },
  );

  it("reserves the whole-percent message for genuinely fractional input", () => {
    for (const raw of ["20.5", "20,5", "0,5"]) {
      expect(resolvePromoValueField(raw, "PERCENT")).toEqual({
        kind: "error",
        messageKey: "admin.cpValuePercentWhole",
      });
    }
  });

  it("requires a value", () => {
    expect(resolvePromoValueField("  ", "PERCENT")).toEqual({
      kind: "error",
      messageKey: "admin.cpValueRequired",
    });
  });
});

describe("resolvePromoMoneyField — the optional min-order / max-discount fields", () => {
  it("keeps blank meaning 'not set'", () => {
    // Blank is a legitimate "no minimum" / "no cap" and must stay that way.
    for (const raw of ["", " ", "   "]) {
      expect(resolvePromoMoneyField(raw)).toEqual({ kind: "blank" });
    }
  });

  it("reads an explicit 0 as 0, distinct from blank", () => {
    expect(resolvePromoMoneyField("0")).toEqual({ kind: "value", value: 0 });
  });

  it("reads both locales", () => {
    expect(resolvePromoMoneyField("15,50")).toEqual({
      kind: "value",
      value: 1550,
    });
    expect(resolvePromoMoneyField("15.50")).toEqual({
      kind: "value",
      value: 1550,
    });
  });

  it("ERRORS on unreadable input instead of collapsing it into null", () => {
    // This is its own silent-failure bug: `dollarsInputToCents` returned null
    // for anything unparseable, and null means "no minimum" / "no cap". A typo
    // in the min-order box silently removed the minimum from the promo.
    for (const raw of ["nonsense", "15abc", "-5", "15 50"]) {
      expect(resolvePromoMoneyField(raw)).toEqual({
        kind: "error",
        messageKey: "admin.cpAmountInvalid",
      });
    }
    expect(resolvePromoMoneyField("1,500")).toEqual({
      kind: "error",
      messageKey: "admin.cpAmountAmbiguous",
    });
  });
});

describe("promo numeric fields — i18n keys resolve", () => {
  it.each([
    ["en", enMessages],
    ["es", esMessages],
  ])(
    "every key these can emit exists in the %s catalog",
    (_locale, messages) => {
      const catalog = admin(messages as { admin: unknown });
      const emitted = new Set<string>();
      const push = (field: { kind: string; messageKey?: string }) => {
        if (field.kind === "error" && field.messageKey)
          emitted.add(field.messageKey);
      };
      for (const raw of ["", "0", "nonsense", "1,500", "20.5", "101", "-5"]) {
        push(resolvePromoValueField(raw, "AMOUNT"));
        push(resolvePromoValueField(raw, "PERCENT"));
        push(resolvePromoMoneyField(raw));
      }
      // Every branch the resolvers can take must be represented.
      expect(emitted).toEqual(
        new Set([
          "admin.cpValueRequired",
          "admin.cpValuePositive",
          "admin.cpAmountInvalid",
          "admin.cpAmountAmbiguous",
          "admin.cpValuePercentWhole",
          "admin.cpValuePercentRange",
        ]),
      );
      for (const key of emitted) {
        const value = catalog[key.replace(/^admin\./, "")];
        expect(typeof value).toBe("string");
        expect(value!.length).toBeGreaterThan(0);
      }
      // Emitted by the dialog's maxDiscount memo rather than a resolver, so it
      // can't be discovered by the loop above.
      expect(typeof catalog.cpMaxDiscountPositive).toBe("string");
      expect(catalog.cpMaxDiscountPositive!.length).toBeGreaterThan(0);
    },
  );
});
