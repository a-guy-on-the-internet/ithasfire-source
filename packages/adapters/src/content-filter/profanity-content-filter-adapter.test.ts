import { describe, expect, it } from "vitest";

import { createProfanityContentFilterAdapter } from "./profanity-content-filter-adapter";

const adapter = createProfanityContentFilterAdapter();

describe("createProfanityContentFilterAdapter", () => {
  it("allows the common contraction \"it's\" (regression: apostrophe false positive)", async () => {
    expect(await adapter.hasBlockedContent({ text: "it's an experience" })).toBe(
      false,
    );
  });

  it.each([
    "it's",
    "it’s", // curly apostrophe
    "that's",
    "he's",
    "let's",
    "what's",
    "craft cocktails",
    "class",
    "assassin",
    "passage",
    "grass",
    "Scunthorpe",
    "welcome to the concert",
  ])("does not block clean text: %s", async (text) => {
    expect(await adapter.hasBlockedContent({ text })).toBe(false);
  });

  it.each([
    "shit",
    "fuck",
    "tits",
    "sh1t", // leetspeak variant
    "fück", // diacritic obfuscation
  ])("still blocks profanity: %s", async (text) => {
    expect(await adapter.hasBlockedContent({ text })).toBe(true);
  });

  // ── Whitelist gap regressions ──────────────────────────────────────────
  // obscenity ships a whitelist, but it has holes. These exact strings are
  // real Nashville listings that the filter rejected (3 of 18 open mics):
  // "Dickerson Pike" is a major thoroughfare, "Grown and Sexy" is the actual
  // name of a weekly open mic at Carol Ann's.
  it.each([
    "Dickerson Pike",
    "1200 Dickerson Pike, Nashville, TN",
    "Grown and Sexy",
    "Grown and Sexy Open Mic",
    "Charles Dickens Tribute Night",
    "Emily Dickinson Reading",
    "Essex Lounge",
    "Penistone",
    "Sussex",
    "Middlesex County",
    "sexual health workshop",
  ])("does not block the legitimate name/address: %s", async (text) => {
    expect(await adapter.hasBlockedContent({ text })).toBe(false);
  });

  it.each(["what a dick", "sex party", "fuck this"])(
    "still blocks genuine profanity after the whitelist additions: %s",
    async (text) => {
      expect(await adapter.hasBlockedContent({ text })).toBe(true);
    },
  );

  // The whitelist is applied by capturing the SHIPPED PhraseContainer and
  // re-adding it with its `patterns` array intact. Re-adding with only the
  // bare word (e.g. pattern`dick`) would silently drop these obfuscation
  // variants, which is the main regression risk in the whitelist change.
  //
  // Asserting the resolved WORD as well as the boolean covers the second half:
  // re-adding patched phrases shifts every pattern ID, so a match resolved
  // against the raw `englishDataset` names the wrong word.
  it.each([
    ["dck", "dick"],
    ["d1ck", "dick"],
    ["s3x", "sex"],
    ["pnis", "penis"],
    ["p3nis", "penis"],
  ])(
    "preserves the shipped obfuscation pattern %s and resolves it to %s",
    async (text, word) => {
      expect(await adapter.hasBlockedContent({ text })).toBe(true);
      const result = await adapter.findBlocked!({ text });
      expect(result.matches).toContain(word);
    },
  );

  // [WARNING 2] The "sexy" whitelist is a GLOBAL suppression, not one scoped to
  // venue names: it also relaxes the category-request and moderator-application
  // surfaces, which share this singleton adapter. Pinned here so the trade is
  // visible in the tests and not only in a comment — if this ever needs to
  // revert, this is the assertion that should fail first.
  it.each(["sexy", "Sexy", "sexy party"])(
    "accepts bare %s as the deliberate cost of the Grown-and-Sexy whitelist",
    async (text) => {
      expect(await adapter.hasBlockedContent({ text })).toBe(false);
    },
  );

  it("returns false for empty and whitespace-only input", async () => {
    expect(await adapter.hasBlockedContent({ text: "" })).toBe(false);
    expect(await adapter.hasBlockedContent({ text: "   " })).toBe(false);
  });

  describe("findBlocked (reports the matched term)", () => {
    it("reports blocked:false with no matches on clean text", async () => {
      expect(await adapter.findBlocked!({ text: "welcome to the show" })).toEqual(
        { blocked: false },
      );
    });

    it("reports blocked:true with the matched dictionary word", async () => {
      const result = await adapter.findBlocked!({ text: "you fuck" });
      expect(result.blocked).toBe(true);
      expect(result.matches).toContain("fuck");
    });

    it("dedupes repeated matches and preserves first-match order", async () => {
      const result = await adapter.findBlocked!({
        text: "fuck this shit, what the fuck",
      });
      expect(result.blocked).toBe(true);
      // Earliest term first, deduped.
      expect(result.matches).toEqual(["fuck", "shit"]);
    });

    // Re-adding the patched phrases moves them to the END of the dataset, so
    // pattern IDs shift. Resolving the payload against the raw `englishDataset`
    // instead of the derived one reports a neighbouring word ("vagina") here.
    it.each([
      ["what a dick", "dick"],
      ["sex party", "sex"],
    ])(
      "reports the correct term for a whitelist-patched word: %s",
      async (text, word) => {
        const result = await adapter.findBlocked!({ text });
        expect(result.blocked).toBe(true);
        expect(result.matches).toContain(word);
      },
    );

    it("returns blocked:false for empty input", async () => {
      expect(await adapter.findBlocked!({ text: "  " })).toEqual({
        blocked: false,
      });
    });
  });
});
