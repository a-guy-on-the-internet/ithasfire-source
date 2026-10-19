import { describe, expect, it } from "vitest";

import { parseMoneyInputToCents } from "../parse-money-input";

/** Terse assertion helpers — these tests are a truth table, keep them readable. */
const cents = (raw: string) => parseMoneyInputToCents(raw);
const ok = (n: number) => ({ ok: true as const, cents: n });
const no = (reason: "empty" | "invalid" | "ambiguous" | "negative") => ({
  ok: false as const,
  reason,
});

describe("parseMoneyInputToCents — plain en-US input", () => {
  it.each([
    ["15.50", 1550],
    ["15.5", 1550],
    ["15", 1500],
    ["0", 0],
    ["0.00", 0],
    ["0.01", 1],
    [".50", 50],
    ["15.", 1500],
    ["1500", 150000],
  ])("reads %s as %i cents", (raw, expected) => {
    expect(cents(raw)).toEqual(ok(expected));
  });
});

describe("parseMoneyInputToCents — es comma decimals (the money-loss bug)", () => {
  it("reads 15,50 as $15.50, not the $15.00 parseFloat used to bank", () => {
    // parseFloat("15,50") === 15 → the organiser lost 50c on every sale.
    expect(parseFloat("15,50")).toBe(15);
    expect(cents("15,50")).toEqual(ok(1550));
  });

  it.each([
    ["15,5", 1550],
    ["0,99", 99],
    [",50", 50],
    ["15,", 1500],
    ["0,00", 0],
  ])("reads %s as %i cents", (raw, expected) => {
    expect(cents(raw)).toEqual(ok(expected));
  });
});

describe("parseMoneyInputToCents — thousands separators", () => {
  it("handles the en form (comma groups, dot decimal)", () => {
    expect(cents("1,234.56")).toEqual(ok(123456));
    expect(cents("1,234,567.89")).toEqual(ok(123456789));
    expect(cents("1,234,567")).toEqual(ok(123456700));
  });

  it("handles the es form (dot groups, comma decimal)", () => {
    expect(cents("1.234,56")).toEqual(ok(123456));
    expect(cents("1.234.567,89")).toEqual(ok(123456789));
    expect(cents("1.234.567")).toEqual(ok(123456700));
  });

  it("takes the LAST separator as the decimal one", () => {
    expect(cents("1,234.5")).toEqual(ok(123450));
    expect(cents("1.234,5")).toEqual(ok(123450));
  });

  it("reads a repeated single separator as grouping, never as decimals", () => {
    expect(cents("1.000.000")).toEqual(ok(100000000));
    expect(cents("1,000,000")).toEqual(ok(100000000));
  });
});

describe("parseMoneyInputToCents — ambiguity is refused, not guessed", () => {
  it("refuses a lone separator followed by exactly three digits", () => {
    // $1500 to an en typist, $1.50 to an es typist. Guessing loses money
    // 1000x in one direction or 1000x in the other.
    expect(cents("1,500")).toEqual(no("ambiguous"));
    expect(cents("1.500")).toEqual(no("ambiguous"));
    expect(cents("999,999")).toEqual(no("ambiguous"));
  });

  it("is NOT ambiguous when the shape cannot be grouping", () => {
    // A first group is at most 3 digits, so `1234,567` can only be a decimal.
    expect(cents("1234,567")).toEqual(ok(123457));
    // A `0` integer part is never written with a thousands separator.
    expect(cents("0,500")).toEqual(ok(50));
    expect(cents("0.500")).toEqual(ok(50));
  });

  it("rejects grouping in a position no locale produces", () => {
    expect(cents("1,23,456")).toEqual(no("invalid"));
    expect(cents("1.23.456")).toEqual(no("invalid"));
    expect(cents("1234,567,89")).toEqual(no("invalid"));
  });
});

describe("parseMoneyInputToCents — whitespace is a grouping separator", () => {
  it("accepts the fr/es/ru space-grouped form", () => {
    expect(cents("1 234,56")).toEqual(ok(123456));
    expect(cents("15 000")).toEqual(ok(1500000));
    expect(cents("1 234 567,89")).toEqual(ok(123456789));
    expect(cents("1 234 567")).toEqual(ok(123456700));
  });

  it("REFUSES internal whitespace that isn't valid grouping", () => {
    // Regression guard. Stripping whitespace unconditionally read "15 50" as
    // "1550" and banked $1550.00 for a $15.50 ticket — wrong by $1,535, and
    // wholly reachable: the add form's price input offers a space bar.
    // A space can be a separator or a typo; nothing in the string says which,
    // so the only safe answer is to refuse.
    expect(cents("15 50")).toEqual(no("invalid"));
    expect(cents("1 5")).toEqual(no("invalid"));
    expect(cents("15 5")).toEqual(no("invalid"));
    expect(cents("1 5 5 0")).toEqual(no("invalid"));
    expect(cents("12 34,5")).toEqual(no("invalid"));
    expect(cents("1 23 456")).toEqual(no("invalid"));
    expect(cents("1234 567")).toEqual(no("invalid"));
  });

  it("refuses whitespace inside the fraction", () => {
    expect(cents("15.5 0")).toEqual(no("invalid"));
    expect(cents("1 234,5 6")).toEqual(no("invalid"));
  });

  it("applies the same rule to NBSP, which is what Intl actually emits", () => {
    // U+00A0 non-breaking space and U+202F narrow NBSP — the characters
    // Intl.NumberFormat really puts in a grouped amount.
    expect(cents(`1\u00A0234,56`)).toEqual(ok(123456));
    expect(cents(`1\u202F234,56`)).toEqual(ok(123456));
    expect(cents(`15\u00A050`)).toEqual(no("invalid"));
    expect(cents(`15\u202F50`)).toEqual(no("invalid"));
  });

  it("still strips whitespace that is merely decoration", () => {
    // Leading/trailing, and whatever removing a symbol or code leaves behind.
    expect(cents("  15.50  ")).toEqual(ok(1550));
    expect(cents("$ 15.50")).toEqual(ok(1550));
    expect(cents("US$ 15.50")).toEqual(ok(1550));
    expect(cents("15.50 USD")).toEqual(ok(1550));
    expect(cents("- 15.50")).toEqual(no("negative"));
  });
});

describe("parseMoneyInputToCents — pasted / formatted amounts", () => {
  it.each([
    ["$15.50", 1550],
    ["US$15.50", 1550],
    ["15.50 USD", 1550],
    ["€15,50", 1550],
    ["  15.50  ", 1550],
    ["£1,234.56", 123456],
  ])("strips the decoration on %s", (raw, expected) => {
    expect(cents(raw)).toEqual(ok(expected));
  });

  it("strips the non-breaking spaces Intl.NumberFormat emits", () => {
    // es-MX renders as "15,50 US$" with a NBSP before the symbol.
    expect(cents("15,50 US$")).toEqual(ok(1550));
    expect(cents("1 234,56 €")).toEqual(ok(123456));
    expect(cents("15 000")).toEqual(ok(1500000));
  });

  it("treats a bare currency symbol as empty, not as zero", () => {
    expect(cents("$")).toEqual(no("empty"));
    expect(cents(" € ")).toEqual(no("empty"));
  });
});

describe("parseMoneyInputToCents — refusals", () => {
  it("returns empty for blank input so the caller decides what blank means", () => {
    expect(cents("")).toEqual(no("empty"));
    expect(cents("   ")).toEqual(no("empty"));
    expect(cents(" ")).toEqual(no("empty"));
  });

  it("rejects letters instead of silently truncating at them", () => {
    // The exact failure mode of the old converter.
    expect(parseFloat("15abc")).toBe(15);
    expect(cents("15abc")).toEqual(no("invalid"));
    expect(cents("nonsense")).toEqual(no("invalid"));
    expect(cents("abc")).toEqual(no("invalid"));
    expect(cents("1a2")).toEqual(no("invalid"));
    expect(cents("free")).toEqual(no("invalid"));
    // Only an allowlisted currency word is strippable — not any short run.
    expect(cents("15 dollars")).toEqual(no("invalid"));
    expect(cents("15xyz")).toEqual(no("invalid"));
  });

  it("rejects exponent notation rather than reading it as a huge number", () => {
    expect(parseFloat("1e5")).toBe(100000);
    expect(cents("1e5")).toEqual(no("invalid"));
  });

  it("rejects the cent sign — it is a SUBUNIT marker, not a prefix", () => {
    // Stripping `¢` would read "15¢" as $15.00: 100x what was typed, the exact
    // class of misread this module refuses everywhere else.
    expect(cents("15¢")).toEqual(no("invalid"));
    expect(cents("¢15")).toEqual(no("invalid"));
    expect(cents("50¢")).toEqual(no("invalid"));
  });

  it("rejects non-ASCII digits rather than mangling them", () => {
    expect(cents("١٥")).toEqual(no("invalid")); // Arabic-Indic 15
    expect(cents("１５")).toEqual(no("invalid")); // fullwidth 15
    expect(cents("15.٥٠")).toEqual(no("invalid"));
  });

  it("rejects negatives rather than flooring them to zero", () => {
    expect(cents("-15.50")).toEqual(no("negative"));
    expect(cents("-15,50")).toEqual(no("negative"));
    expect(cents("−15.50")).toEqual(no("negative"));
    expect(cents("$-15.50")).toEqual(no("negative"));
    expect(cents("15.50-")).toEqual(no("negative"));
    expect(cents("-0")).toEqual(no("negative"));
    // Negative zero is still signed input; refuse rather than quietly reading
    // it as the free ticket it superficially resembles.
    expect(cents("-0.00")).toEqual(no("negative"));
    expect(cents("-0,00")).toEqual(no("negative"));
  });

  it("rejects a lone sign or lone separator", () => {
    expect(cents("-")).toEqual(no("invalid"));
    expect(cents("+")).toEqual(no("invalid"));
    expect(cents(".")).toEqual(no("invalid"));
    expect(cents(",")).toEqual(no("invalid"));
  });

  it("rejects multiple decimal separators", () => {
    expect(cents("1.2.3")).toEqual(no("invalid"));
    expect(cents("1,2,3")).toEqual(no("invalid"));
    expect(cents("1.234,56.78")).toEqual(no("invalid"));
    expect(cents("15,50.25")).toEqual(no("invalid"));
  });

  it("rejects stray punctuation", () => {
    expect(cents("15;50")).toEqual(no("invalid"));
    expect(cents("15/50")).toEqual(no("invalid"));
    expect(cents("(15.50)")).toEqual(no("invalid"));
  });

  it("accepts an explicit plus sign", () => {
    expect(cents("+15.50")).toEqual(ok(1550));
  });
});

describe("parseMoneyInputToCents — rounding", () => {
  it("rounds more than two decimals half-up to cents", () => {
    // NB: a 3-digit fraction after a lone separator is `ambiguous` (see above),
    // so the unambiguous shapes here are 4+ decimals or a `0` integer part.
    expect(cents("12.3456")).toEqual(ok(1235));
    expect(cents("12.3444")).toEqual(ok(1234));
    expect(cents("12,3456")).toEqual(ok(1235));
    expect(cents("0.005")).toEqual(ok(1));
    expect(cents("0.004")).toEqual(ok(0));
    expect(cents("0.999")).toEqual(ok(100));
  });

  it("rounds exactly, without the float artefact Math.round(x * 100) has", () => {
    // The decimal value 1.0050 is 100.5 cents, which rounds half-up to 101.
    // `Math.round(1.005 * 100)` yields 100 instead, because 1.005 * 100
    // evaluates to 100.49999999999999 in binary floating point.
    expect(Math.round(1.005 * 100)).toBe(100);
    expect(cents("1.0050")).toEqual(ok(101));
  });

  it("keeps long fractions from leaking beyond the third decimal", () => {
    expect(cents("1.999999")).toEqual(ok(200));
    expect(cents("1.9949999")).toEqual(ok(199));
  });
});

describe("parseMoneyInputToCents — magnitude", () => {
  it("handles large but sane amounts", () => {
    expect(cents("1000000.00")).toEqual(ok(100000000));
    expect(cents("1,000,000.00")).toEqual(ok(100000000));
    expect(cents("99999999.99")).toEqual(ok(9999999999));
  });

  it("rejects anything that cannot be an exact integer cent count", () => {
    expect(cents("99999999999999999999")).toEqual(no("invalid"));
    expect(cents("1234567890123456789.99")).toEqual(no("invalid"));
  });

  it("holds the exact safe-integer boundary", () => {
    // MAX_SAFE_INTEGER is 9007199254740991 cents. One cent either side of it
    // is the difference between an exact amount and a silently rounded float.
    expect(cents("90071992547409.91")).toEqual(ok(Number.MAX_SAFE_INTEGER));
    expect(cents("90071992547409.92")).toEqual(no("invalid"));
  });
});

describe("parseMoneyInputToCents — purity", () => {
  it("never throws and never returns NaN cents", () => {
    const inputs = [
      "",
      " ",
      "0",
      "-1",
      "abc",
      "1,500",
      "1.2.3",
      "$$$",
      "1e999",
      "999999999999999999999999",
      ".",
      "12.345",
    ];
    for (const input of inputs) {
      const result = parseMoneyInputToCents(input);
      if (result.ok) {
        expect(Number.isSafeInteger(result.cents)).toBe(true);
        expect(result.cents).toBeGreaterThanOrEqual(0);
      } else {
        expect(["empty", "invalid", "ambiguous", "negative"]).toContain(
          result.reason,
        );
      }
    }
  });
});
