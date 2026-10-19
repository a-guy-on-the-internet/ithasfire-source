import { describe, expect, it } from "vitest";

import {
  MAX_BASIS_POINTS,
  parsePercentInputToBasisPoints,
} from "../parse-percent-input";

/** Terse assertion helpers — these tests are a truth table, keep them readable. */
const bps = (raw: string) => parsePercentInputToBasisPoints(raw);
const ok = (n: number) => ({ ok: true as const, basisPoints: n });
const no = (
  reason: "empty" | "invalid" | "ambiguous" | "negative" | "out_of_range",
) => ({ ok: false as const, reason });

describe("parsePercentInputToBasisPoints — plain en-US input", () => {
  it.each([
    ["12.5", 1250],
    ["12", 1200],
    ["0", 0],
    ["100", 10000],
    ["0.01", 1],
    ["99.99", 9999],
    [".5", 50],
    ["12.", 1200],
  ])("reads %s as %i bps", (raw, expected) => {
    expect(bps(raw)).toEqual(ok(expected));
  });
});

describe("parsePercentInputToBasisPoints — es comma decimals (the 0-bps bug)", () => {
  it("reads 12,5 as 1250 bps, not the 0 that Number() used to bank", () => {
    // `Number("12,5")` is NaN, and the splits editor's `NaN → 0` fallback wrote
    // a 0-bps share: that payee received NOTHING at settlement, silently.
    expect(Number("12,5")).toBeNaN();
    expect(bps("12,5")).toEqual(ok(1250));
  });

  it.each([
    ["12,5", 1250],
    ["0,99", 99],
    [",5", 50],
    ["12,", 1200],
    ["0,00", 0],
    ["33,33", 3333],
  ])("reads %s as %i bps", (raw, expected) => {
    expect(bps(raw)).toEqual(ok(expected));
  });
});

describe("parsePercentInputToBasisPoints — the percent marker", () => {
  it.each([
    ["50%", 5000],
    ["%50", 5000],
    ["50 %", 5000], // the fr form, with a real space before the marker
    ["12,5%", 1250],
    ["12.5 %", 1250],
  ])("strips the marker on %s", (raw, expected) => {
    expect(bps(raw)).toEqual(ok(expected));
  });

  it("handles the NBSP that Intl.NumberFormat actually emits", () => {
    // `new Intl.NumberFormat("fr", { style: "percent" }).format(0.5)` is
    // "50 %" with U+202F (narrow NBSP), not a plain space. A pasted percent
    // therefore arrives with a character both `trim()` and `\s` must cover.
    expect(bps("50\u00A0%")).toEqual(ok(5000)); // NBSP
    expect(bps("50\u202F%")).toEqual(ok(5000)); // narrow NBSP — the fr form
    expect(bps("50\u2009%")).toEqual(ok(5000)); // thin space
    expect(bps("\u00A050\u202F%\u00A0")).toEqual(ok(5000));
    // The grouping rule still applies to an NBSP sitting between digits.
    expect(bps("1\u00A0234")).toEqual(no("out_of_range"));
    expect(bps("1\u202F5")).toEqual(no("invalid"));
  });

  it("treats a bare marker as empty, not as zero", () => {
    expect(bps("%")).toEqual(no("empty"));
    expect(bps(" % ")).toEqual(no("empty"));
    expect(bps("\u00A0%\u202F")).toEqual(no("empty"));
  });

  it("refuses a marker anywhere but the ends — that is a typo, not a unit", () => {
    expect(bps("5%0")).toEqual(no("invalid"));
    expect(bps("50%%")).toEqual(no("invalid"));
    expect(bps("%50%")).toEqual(no("invalid"));
  });
});

describe("parsePercentInputToBasisPoints — currency decoration is NOT stripped", () => {
  it("refuses currency symbols: $12 is nonsense as a percent, not 12%", () => {
    // The money parser forgives these on purpose. A percent field must not:
    // silently reading "$12" as 12% would bank a share the organiser never
    // meant to express in that unit.
    expect(bps("$12")).toEqual(no("invalid"));
    expect(bps("12$")).toEqual(no("invalid"));
    expect(bps("€12,5")).toEqual(no("invalid"));
    expect(bps("US$12")).toEqual(no("invalid"));
  });

  it("refuses currency words the money parser allowlists", () => {
    expect(bps("12 USD")).toEqual(no("invalid"));
    expect(bps("USD 12")).toEqual(no("invalid"));
  });

  it("refuses any other letters", () => {
    expect(bps("twelve")).toEqual(no("invalid"));
    expect(bps("12abc")).toEqual(no("invalid"));
    expect(bps("12pct")).toEqual(no("invalid"));
    expect(bps("1e2")).toEqual(no("invalid"));
    expect(bps("NaN")).toEqual(no("invalid"));
  });
});

describe("parsePercentInputToBasisPoints — range", () => {
  it("holds both boundaries inclusively", () => {
    expect(bps("0")).toEqual(ok(0));
    expect(bps("0,0")).toEqual(ok(0));
    expect(bps("100")).toEqual(ok(MAX_BASIS_POINTS));
    expect(bps("100.00")).toEqual(ok(MAX_BASIS_POINTS));
    expect(bps("100,00")).toEqual(ok(MAX_BASIS_POINTS));
    expect(bps("100 %")).toEqual(ok(MAX_BASIS_POINTS));
  });

  it("refuses one hundredth of a percent over the top", () => {
    expect(bps("100.01")).toEqual(no("out_of_range"));
    expect(bps("100,01")).toEqual(no("out_of_range"));
  });

  it("refuses anything above 100 with its own reason, not a vague 'invalid'", () => {
    // Callers need to distinguish "unreadable" from "read fine, but 250% of the
    // pool is not a share" so they can say something useful.
    expect(bps("101")).toEqual(no("out_of_range"));
    expect(bps("250")).toEqual(no("out_of_range"));
    expect(bps("99999")).toEqual(no("out_of_range"));
  });

  it("refuses negatives rather than flooring them to zero", () => {
    expect(bps("-12,5")).toEqual(no("negative"));
    expect(bps("-12.5")).toEqual(no("negative"));
    expect(bps("−5")).toEqual(no("negative")); // U+2212
    expect(bps("-0")).toEqual(no("negative"));
    expect(bps("-5%")).toEqual(no("negative"));
  });

  it("accepts an explicit plus sign", () => {
    expect(bps("+12,5")).toEqual(ok(1250));
  });
});

describe("parsePercentInputToBasisPoints — inherited separator rules", () => {
  it("refuses the ambiguous lone-separator-plus-three-digits shape", () => {
    // "1,500" is 1500 to an en typist and 1.5 to an es one. Out of range either
    // way here, but the REASON matters: it is unreadable, not merely too big.
    expect(bps("1,500")).toEqual(no("ambiguous"));
    expect(bps("1.500")).toEqual(no("ambiguous"));
  });

  it("is not ambiguous when the shape cannot be grouping", () => {
    expect(bps("0,500")).toEqual(ok(50));
    expect(bps("0.500")).toEqual(ok(50));
  });

  it("refuses internal whitespace that is not valid grouping", () => {
    // "12 5" reaching for the space bar must never become 125.
    expect(bps("12 5")).toEqual(no("invalid"));
    expect(bps("1 2")).toEqual(no("invalid"));
    expect(bps("12.5 0")).toEqual(no("invalid"));
  });

  it("still trims decorative whitespace", () => {
    expect(bps("  12,5  ")).toEqual(ok(1250));
    expect(bps(" 12.5 ")).toEqual(ok(1250));
  });

  it("refuses multiple decimal separators and stray punctuation", () => {
    expect(bps("1.2.3")).toEqual(no("invalid"));
    expect(bps("1,2,3")).toEqual(no("invalid"));
    expect(bps("12;5")).toEqual(no("invalid"));
    expect(bps("(12)")).toEqual(no("invalid"));
    expect(bps("12/5")).toEqual(no("invalid"));
  });

  it("refuses a lone sign or lone separator", () => {
    expect(bps("-")).toEqual(no("invalid"));
    expect(bps(".")).toEqual(no("invalid"));
    expect(bps(",")).toEqual(no("invalid"));
  });

  it("rounds half-up past two decimals rather than truncating", () => {
    expect(bps("12,3456")).toEqual(ok(1235));
    expect(bps("12.3444")).toEqual(ok(1234));
    expect(bps("0.005")).toEqual(ok(1));
    expect(bps("0.004")).toEqual(ok(0));
  });

  it("rejects non-ASCII digits rather than mangling them", () => {
    expect(bps("١٥")).toEqual(no("invalid"));
    expect(bps("１５")).toEqual(no("invalid"));
  });
});

describe("parsePercentInputToBasisPoints — blank is the caller's decision", () => {
  it.each(["", " ", "   "])("reports %p as empty, never as 0 bps", (raw) => {
    // A 0-bps share pays the payee nothing. Whether a blank field means "0%"
    // or "leave it alone" is the call site's call, so it gets its own reason.
    expect(bps(raw)).toEqual(no("empty"));
  });
});

describe("parsePercentInputToBasisPoints — purity", () => {
  it("never throws and never returns a non-integer or out-of-range bps", () => {
    const inputs = [
      "",
      " ",
      "0",
      "100",
      "-1",
      "abc",
      "1,500",
      "1.2.3",
      "$$$",
      "%%%",
      "1e999",
      "999999999999999999999999",
      ".",
      "12.345",
      "12,5",
    ];
    for (const input of inputs) {
      const result = parsePercentInputToBasisPoints(input);
      if (result.ok) {
        expect(Number.isSafeInteger(result.basisPoints)).toBe(true);
        expect(result.basisPoints).toBeGreaterThanOrEqual(0);
        expect(result.basisPoints).toBeLessThanOrEqual(MAX_BASIS_POINTS);
      } else {
        expect([
          "empty",
          "invalid",
          "ambiguous",
          "negative",
          "out_of_range",
        ]).toContain(result.reason);
      }
    }
  });
});
