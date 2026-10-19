import { describe, expect, it } from "vitest";

import enMessages from "@/i18n/messages/en";
import esMessages from "@/i18n/messages/es";

import { resolveSplitPercentField } from "../SplitsEditor";

/**
 * The pure half of what the splits editor does with a typed share. The
 * component wraps it with an inline error, a blocked Save, and a preserved
 * last-good `percentBps`, so pinning it here pins the settlement semantics:
 * what basis points get banked, what blank means, and what refuses.
 *
 * TWO defects live here, and the fix for one must not become the other:
 *
 *  1. `Number("12,5")` is `NaN`, and the old `NaN → 0` fallback wrote a 0-bps
 *     share — that payee received NOTHING at settlement, with no error shown.
 *     So `12,5` must still be READ.
 *  2. `PayoutTermsLine.percent` is an `Int` of whole percent and the write
 *     does `Math.round(percentBps / 100)`, so a share of 1250 persists as 13%.
 *     So `12,5`, once read, must be REFUSED — never rounded, never zeroed.
 */

const admin = (messages: { admin: unknown }) =>
  messages.admin as Record<string, string>;

const bps = (n: number) => ({ kind: "bps" as const, basisPoints: n });
const err = (messageKey: string) => ({ kind: "error" as const, messageKey });

describe("resolveSplitPercentField — what gets banked", () => {
  it.each([
    ["12", 1200],
    ["0", 0],
    ["100", 10000],
    ["50", 5000],
    ["50,00", 5000],
    ["50.00", 5000],
    ["50 %", 5000],
    ["50%", 5000],
    ["%50", 5000],
  ])("reads %p as %i bps", (raw, expected) => {
    expect(resolveSplitPercentField(raw)).toEqual(bps(expected));
  });

  it("reads an es-typed WHOLE percent that Number() would have zeroed", () => {
    // `Number("50,00")` is NaN, and the old `NaN → 0` fallback wrote a 0-bps
    // share — the payee got NOTHING at settlement, silently. The locale fix is
    // what this pins: a valid es-typed share must still commit.
    expect(Number("50,00")).toBeNaN();
    expect(resolveSplitPercentField("50,00")).toEqual(bps(5000));
  });
});

describe("resolveSplitPercentField — fractional shares are refused, not rounded", () => {
  it("still READS 12,5 — it just refuses it for the right reason", () => {
    // Two failure modes must not be confused. The ORIGINAL bug was
    // `Number("12,5") → NaN → 0 bps`: silently unpaid. The fix is NOT to go
    // back to zeroing it; it is to read it correctly and then say why a
    // fractional share can't be stored.
    expect(Number("12,5")).toBeNaN();
    expect(resolveSplitPercentField("12,5")).toEqual(
      err("admin.ebSplitsPercentWhole"),
    );
    // Emphatically NOT a silent zero.
    expect(resolveSplitPercentField("12,5")).not.toEqual(bps(0));
  });

  it.each([["12.5"], ["12,5"], ["33,33"], ["0,5"], ["99,99"], ["12,50"]])(
    "refuses %p as non-whole",
    (raw) => {
      // `PayoutTermsLine.percent` is an Int of WHOLE percent. The write path
      // does `Math.round(percentBps / 100)`, so 1250 would silently persist as
      // 13% — the payee is paid 13, not 12.5, and the audit log only ever sees
      // the rounded 1300. On a $10k net that is $50 an event moved off the
      // owner's remainder. Refuse at the keyboard instead.
      expect(resolveSplitPercentField(raw)).toEqual(
        err("admin.ebSplitsPercentWhole"),
      );
    },
  );

  it("does not mistake a whole percent written with decimals for fractional", () => {
    // NB: "7.000" is deliberately absent — a lone separator with exactly three
    // digits after it is the AMBIGUOUS shape, not a whole percent.
    for (const raw of ["50,00", "50.0", "100,00", "0,00", "7"]) {
      const field = resolveSplitPercentField(raw);
      expect(field.kind).toBe("bps");
      if (field.kind === "bps") expect(field.basisPoints % 100).toBe(0);
    }
  });
});

describe("resolveSplitPercentField — blank keeps meaning 0%", () => {
  it.each(["", " "])("reads %p as 0 bps, as it always has", (raw) => {
    // Clearing the box has always zeroed the row, and the placeholder is "0".
    // That behaviour is deliberate and unchanged — what changed is that a
    // TYPO no longer takes the same path.
    expect(resolveSplitPercentField(raw)).toEqual(bps(0));
  });
});

describe("resolveSplitPercentField — refuses rather than silently zeroing", () => {
  it.each([["nonsense"], ["12abc"], ["1.2.3"], ["12 5"], ["-12,5"], ["$12"]])(
    "refuses %p",
    (raw) => {
      expect(resolveSplitPercentField(raw)).toEqual(
        err("admin.ebSplitsPercentInvalid"),
      );
    },
  );

  it("separates out-of-range from unreadable", () => {
    expect(resolveSplitPercentField("101")).toEqual(
      err("admin.ebSplitsPercentRange"),
    );
    expect(resolveSplitPercentField("250")).toEqual(
      err("admin.ebSplitsPercentRange"),
    );
  });

  it("separates ambiguous from unreadable", () => {
    expect(resolveSplitPercentField("1,500")).toEqual(
      err("admin.ebSplitsPercentAmbiguous"),
    );
  });

  it("only ever returns a whole percent inside 0–10000", () => {
    // The invariant the write path depends on: anything this returns can be
    // divided by 100 exactly, so `Math.round(bps / 100)` is never a rounding.
    for (const raw of [
      "",
      "0",
      "100",
      "100,01",
      "-1",
      "999999",
      "nonsense",
      "12,5",
      "33,33",
      "0,01",
      "1,000",
      "50 %",
    ]) {
      const field = resolveSplitPercentField(raw);
      if (field.kind !== "bps") continue;
      expect(field.basisPoints).toBeGreaterThanOrEqual(0);
      expect(field.basisPoints).toBeLessThanOrEqual(10000);
      expect(field.basisPoints % 100).toBe(0);
    }
  });
});

describe("resolveSplitPercentField — i18n keys resolve", () => {
  it.each([
    ["en", enMessages],
    ["es", esMessages],
  ])("every key it can emit exists in the %s catalog", (_locale, messages) => {
    const catalog = admin(messages as { admin: unknown });
    const emitted = new Set<string>();
    for (const raw of ["nonsense", "101", "1,500", "12,5"]) {
      const field = resolveSplitPercentField(raw);
      if (field.kind === "error") emitted.add(field.messageKey);
    }
    expect(emitted).toEqual(
      new Set([
        "admin.ebSplitsPercentInvalid",
        "admin.ebSplitsPercentRange",
        "admin.ebSplitsPercentAmbiguous",
        "admin.ebSplitsPercentWhole",
      ]),
    );
    for (const key of emitted) {
      const value = catalog[key.replace(/^admin\./, "")];
      expect(typeof value).toBe("string");
      expect(value!.length).toBeGreaterThan(0);
    }
    // The save-blocked copy the component pairs with these.
    expect(typeof catalog.ebSplitsPercentBlocker).toBe("string");
    expect(typeof catalog.ebSplitsSaveBlockedTitle).toBe("string");
  });

  it.each([
    ["en", enMessages],
    ["es", esMessages],
  ])(
    "the %s copy never offers a fractional share as a worked example",
    (_locale, messages) => {
      // A regression guard on the COPY, not just the logic. The first cut of
      // this feature told organisers "for example 12.5 or 12,5" in the very
      // message that rejects their input — actively teaching the one value the
      // store cannot hold. `ebSplitsPercentWhole` is exempt: it names 12,5
      // precisely to explain why it was rejected.
      const catalog = admin(messages as { admin: unknown });
      for (const key of [
        "ebSplitsPercentInvalid",
        "ebSplitsPercentAmbiguous",
        "ebSplitsPercentRange",
      ]) {
        expect(catalog[key]).not.toMatch(/\d+[.,]\d/);
      }
    },
  );
});
