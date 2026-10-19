import { describe, expect, it } from "vitest";

import enMessages from "@/i18n/messages/en";
import esMessages from "@/i18n/messages/es";

import { resolveTicketAmountField } from "../TicketTypeEditor";

/**
 * `resolveTicketAmountField` is the pure half of what `handleAdd` /
 * `handleSaveEdit` do with every money field. The component wraps it with a
 * toast and an early return, so pinning it here pins the submit semantics:
 * what gets banked, what counts as blank, and what refuses the submit.
 */

const admin = (messages: { admin: unknown }) =>
  messages.admin as Record<string, string>;

describe("resolveTicketAmountField — what gets banked", () => {
  it("reads a plain en amount", () => {
    expect(resolveTicketAmountField("15.50", "price")).toEqual({
      kind: "cents",
      cents: 1550,
    });
  });

  it("reads an es comma decimal — the money-loss bug this exists to kill", () => {
    // The old converter was Math.round(parseFloat("15,50") * 100) = 1500:
    // a $15.50 ticket silently saved at $15.00, on every sale, with no error.
    expect(parseFloat("15,50")).toBe(15);
    expect(resolveTicketAmountField("15,50", "price")).toEqual({
      kind: "cents",
      cents: 1550,
    });
  });

  it("reads both thousands-separator conventions", () => {
    expect(resolveTicketAmountField("1,234.56", "amount")).toEqual({
      kind: "cents",
      cents: 123456,
    });
    expect(resolveTicketAmountField("1.234,56", "amount")).toEqual({
      kind: "cents",
      cents: 123456,
    });
  });

  it("still reads a zero-dollar (comp / industry) ticket", () => {
    expect(resolveTicketAmountField("0", "price")).toEqual({
      kind: "cents",
      cents: 0,
    });
    expect(resolveTicketAmountField("0.00", "price")).toEqual({
      kind: "cents",
      cents: 0,
    });
  });
});

describe("resolveTicketAmountField — blank is the caller's decision", () => {
  it.each(["", "   ", " "])("reports %p as blank, never as 0", (raw) => {
    // Blank must NOT resolve to a number here. handleAdd maps blank to 0 for
    // the price (a blank price is a free ticket) and to null for the optional
    // minimum / suggested / resale-cap fields ("not set"). Collapsing that
    // decision into the reader would silently zero an optional field.
    expect(resolveTicketAmountField(raw, "price")).toEqual({ kind: "blank" });
    expect(resolveTicketAmountField(raw, "amount")).toEqual({ kind: "blank" });
  });
});

describe("resolveTicketAmountField — refuses rather than coercing", () => {
  it.each([
    ["nonsense"],
    ["15abc"],
    ["1e5"],
    ["1.2.3"],
    ["1,23,456"],
    ["-15.50"],
    ["1,500"],
  ])("refuses %p instead of banking a number", (raw) => {
    const field = resolveTicketAmountField(raw, "price");
    expect(field.kind).toBe("error");
    // The regression that matters: a typo must never become a $0 ticket.
    expect(field).not.toHaveProperty("cents");
  });

  it("keeps the long-standing 'Invalid price' copy for the price field", () => {
    expect(resolveTicketAmountField("nonsense", "price")).toEqual({
      kind: "error",
      titleKey: "admin.ttInvalidPriceTitle",
      messageKey: "admin.ttInvalidPriceMessage",
    });
  });

  it("uses the generic 'Invalid amount' copy for the optional fields", () => {
    expect(resolveTicketAmountField("nonsense", "amount")).toEqual({
      kind: "error",
      titleKey: "admin.ttInvalidAmountTitle",
      messageKey: "admin.ttInvalidAmountMessage",
    });
  });

  it("explains the thousands separator when input reads two ways", () => {
    // "1,500" is $1500 to an en typist and $1.50 to an es one. Guessing is
    // the whole bug class, so the organiser is asked to disambiguate.
    for (const copy of ["price", "amount"] as const) {
      expect(resolveTicketAmountField("1,500", copy)).toMatchObject({
        kind: "error",
        messageKey: "admin.ttAmbiguousAmountMessage",
      });
      expect(resolveTicketAmountField("1.500", copy)).toMatchObject({
        kind: "error",
        messageKey: "admin.ttAmbiguousAmountMessage",
      });
    }
  });

  it("refuses a negative instead of flooring it to zero", () => {
    expect(resolveTicketAmountField("-1", "price")).toMatchObject({
      kind: "error",
      messageKey: "admin.ttInvalidPriceMessage",
    });
  });
});

describe("resolveTicketAmountField — i18n keys resolve", () => {
  it.each([
    ["en", enMessages],
    ["es", esMessages],
  ])("every key it can emit exists in the %s catalog", (_locale, messages) => {
    const catalog = admin(messages as { admin: unknown });
    const emitted = new Set<string>();
    for (const raw of ["nonsense", "-1", "1,500"]) {
      for (const copy of ["price", "amount"] as const) {
        const field = resolveTicketAmountField(raw, copy);
        if (field.kind !== "error") continue;
        emitted.add(field.titleKey);
        emitted.add(field.messageKey);
      }
    }
    expect(emitted.size).toBeGreaterThan(0);
    for (const key of emitted) {
      const value = catalog[key.replace(/^admin\./, "")];
      expect(typeof value).toBe("string");
      expect(value!.length).toBeGreaterThan(0);
    }
  });
});
