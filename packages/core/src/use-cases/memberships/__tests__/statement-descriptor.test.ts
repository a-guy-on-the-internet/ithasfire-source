import { describe, expect, it } from "vitest";

import { buildStatementDescriptor } from "../statement-descriptor";

/**
 * Stripe's rules for a Product statement descriptor, enforced end-to-end:
 * ≤22 chars, none of `<>\'"*`, at least one letter, uppercase. The descriptor
 * is dispute prevention (the member must recognise the charge), so every case
 * here is a name shape a real owner could plausibly have.
 */
describe("buildStatementDescriptor", () => {
  const cases: Array<{
    name: string;
    input: string | null | undefined;
    expected: string;
  }> = [
    // Plain names uppercase and pass through.
    { name: "simple name", input: "Drkmttr", expected: "DRKMTTR" },
    {
      name: "multi-word name under the cap",
      input: "DRKMTTR Collective",
      expected: "DRKMTTR COLLECTIVE",
    },
    // Exactly 22 chars survives whole.
    {
      name: "exactly 22 characters",
      input: "ABCDEFGHIJKLMNOPQRSTUV",
      expected: "ABCDEFGHIJKLMNOPQRSTUV",
    },
    // Longer than 22: truncate at the last complete word.
    {
      name: "long name truncates at a word boundary",
      input: "The East Nashville Community Arts Collective",
      expected: "THE EAST NASHVILLE",
    },
    {
      name: "cut landing exactly at a word end keeps the word",
      // "SPRINGWATER SUPPER CLU|B" — char 23 is inside "CLUB", so back up.
      input: "Springwater Supper Club and Lounge",
      expected: "SPRINGWATER SUPPER",
    },
    // A single unbroken >22 run has no boundary to respect: hard cut.
    {
      name: "single 30-char word hard-truncates to 22",
      input: "Supercalifragilisticexpialidocious",
      expected: "SUPERCALIFRAGILISTICEX",
    },
    // Stripe-disallowed characters are stripped, not escaped.
    {
      name: "disallowed characters stripped",
      input: `D"R'K<M>T\\T*R`,
      expected: "DRKMTTR",
    },
    // Emoji and other non-ASCII are dropped (Stripe strips them anyway;
    // doing it ourselves keeps the 22-char budget honest).
    {
      name: "emoji stripped",
      input: "🔥 Ithas Fire 🔥",
      expected: "ITHAS FIRE",
    },
    {
      name: "accented characters dropped, not transliterated",
      input: "Café Münchën",
      expected: "CAF MNCHN",
    },
    // Whitespace runs collapse before the length budget is spent.
    {
      name: "whitespace collapsed and trimmed",
      input: "  The   Basement\tEast  ",
      expected: "THE BASEMENT EAST",
    },
    // Below Stripe's 5-char minimum → same suffix path as the letterless
    // fallback, keeping the recognisable short name in front.
    {
      name: "two-letter name appends MEMBERSHIP to clear the 5-char minimum",
      input: "AB",
      expected: "AB MEMBERSHIP",
    },
    {
      name: "single-letter name appends MEMBERSHIP",
      input: "Q",
      expected: "Q MEMBERSHIP",
    },
    {
      name: "four-char name appends MEMBERSHIP",
      input: "Kilo",
      expected: "KILO MEMBERSHIP",
    },
    {
      name: "exactly five chars passes through untouched",
      input: "Basem",
      expected: "BASEM",
    },
    // No letter → keep the recognisable fragment, brand the rest.
    {
      name: "all-digits name keeps the digits and appends MEMBERSHIP",
      input: "615",
      expected: "615 MEMBERSHIP",
    },
    {
      name: "punctuation-only band name keeps its fragment",
      input: "!!!",
      expected: "!!! MEMBERSHIP",
    },
    // Long digit run: the fragment is pre-truncated so the suffix fits in 22.
    {
      name: "long all-digits name truncates the fragment to fit the suffix",
      input: "123456789012345678901234567890",
      expected: "12345678901 MEMBERSHIP",
    },
    // Truncation that eats the only lettered word still ends with a letter.
    {
      name: "letters only beyond the cap fall back with the digit fragment",
      input: "12345678901234567890123 Bar",
      expected: "12345678901 MEMBERSHIP",
    },
    // Nothing at all → plain fallback.
    { name: "empty string", input: "", expected: "MEMBERSHIP" },
    { name: "whitespace only", input: "   ", expected: "MEMBERSHIP" },
    { name: "null", input: null, expected: "MEMBERSHIP" },
    { name: "undefined", input: undefined, expected: "MEMBERSHIP" },
    {
      name: "emoji-only name",
      input: "🔥🔥🔥",
      expected: "MEMBERSHIP",
    },
  ];

  it.each(cases)("$name", ({ input, expected }) => {
    expect(buildStatementDescriptor(input)).toBe(expected);
  });

  it("INVARIANT: every output is 5–22 chars, has a letter, and no banned char", () => {
    const inputs = [
      ...cases.map((c) => c.input),
      "a".repeat(200),
      `${"9".repeat(50)} x`,
      "<<<>>>",
      "ñ".repeat(30),
      "The Springwater Supper Club & Lounge *est. 1896*",
      // Short-name shapes: Stripe rejects descriptors under 5 chars too.
      "AB",
      "A",
      "x",
      "12",
      "a b",
    ];
    for (const input of inputs) {
      const out = buildStatementDescriptor(input);
      expect(out.length).toBeLessThanOrEqual(22);
      expect(out.length).toBeGreaterThanOrEqual(5);
      expect(out).toMatch(/[A-Z]/);
      expect(out).not.toMatch(/[<>\\'"*]/);
      expect(out).toBe(out.toUpperCase());
      expect(out).toBe(out.trim());
    }
  });
});
