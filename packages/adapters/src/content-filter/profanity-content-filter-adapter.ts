import {
  DataSet,
  RegExpMatcher,
  englishDataset,
  englishRecommendedTransformers,
} from "obscenity";
import type { EnglishProfaneWord, PhraseContainer } from "obscenity";

import type {
  ContentFilterMatch,
  ContentFilterPort,
} from "@th/ports/content-filter";

// We rely solely on `obscenity` for profanity detection. Its recommended
// transformers catch leetspeak and diacritic obfuscation ("sh1t", "fück"), its
// patterns carry word-boundary anchors, and it ships a whitelist of innocent
// words that contain a profane substring.
//
// That shipped whitelist is INCOMPLETE, and the gaps are not theoretical: they
// rejected 3 of 18 genuine Nashville open-mic listings. "Dickerson Pike" is a
// major Nashville thoroughfare and "Grown and Sexy" is the real name of a
// weekly open mic. So we extend the whitelist below — do not assume a word is
// safe just because obscenity is boundary-aware; check it against a test.
//
// The previous `glin-profanity` matcher (with `allLanguages` + `detectLeetspeak`)
// was removed because its multilingual dictionaries false-positive on extremely
// common English apostrophe contractions — "it's" / "it’s" were flagged as
// profane, which blocked legitimate text across every content-filtered surface.

type ProfanityMetadata = { originalWord: EnglishProfaneWord };

/**
 * Whitelist entries we add ON TOP OF the ones obscenity already ships, keyed by
 * the dictionary word whose patterns produce the false positive.
 *
 * Whitelisted terms suppress a match anywhere they occur, so each entry is a
 * deliberate trade: we accept that the profane word goes undetected inside this
 * exact string. Only add a term when the innocent reading dominates.
 *
 * The trade is NOT scoped to event listings. This adapter is a process-wide
 * singleton (wired once in `apps/api/src/lib/dep.ts`), and obscenity's
 * whitelist is global — `DataSet.build()` flattens every phrase's terms into
 * one list — so these entries also relax:
 *   - `requestCategoryOption` (category name + note), and
 *   - `applyToBeModerator` (the application statement).
 * A category called "Sexy Nights", or an application statement using "sexy",
 * was rejected before and is accepted now. That is accepted, not overlooked.
 *
 * Deliberately NOT listed, because the shipped patterns are already anchored
 * and these never matched: "essex" / "sussex" / "middlesex" (the `sex` patterns
 * are `|s[s]e[e]x|` and `|s[s]e[e]xy|` — both word-boundary anchored on each
 * side), "sexual" (same trailing anchor), "scunthorpe", "assassin", and
 * "dickens" (obscenity whitelists that one itself). Adding redundant terms just
 * widens the suppressed regions for no benefit.
 *
 * Known REMAINING false positives we are choosing not to fix: "Moby Dick",
 * "Dick Clark" and "sex education" still block. Clearing those needs the bare
 * word whitelisted, which would gut detection entirely — not worth it.
 *
 * The key type is `EnglishProfaneWord`, which catches a typo here. It is NOT a
 * drift guard: that union is hand-maintained in obscenity's own `english.d.ts`
 * rather than derived from the dataset, so an upgrade that drops a word from
 * the DATASET while leaving it in the UNION compiles fine — `word in
 * ADDITIONAL_WHITELISTED_TERMS` simply never matches and the whitelist
 * silently no-ops. The behavioural tests in
 * `profanity-content-filter-adapter.test.ts` are the real guard; keep them.
 */
const ADDITIONAL_WHITELISTED_TERMS: Partial<
  Record<EnglishProfaneWord, readonly string[]>
> = {
  // Dickerson Pike (Nashville), Emily Dickinson. ("dickens" ships already.)
  dick: ["dickerson", "dickinson"],
  // Penistone, a real town in South Yorkshire.
  penis: ["penistone"],
  // "Grown and Sexy" — a recurring open-mic night name.
  sex: ["sexy"],
};

/**
 * Build a dataset that is `englishDataset` plus the extra whitelist terms above.
 *
 * The obvious implementation — `removePhrasesIf(...)` then re-`addPhrase` with
 * ``pattern`dick` `` — is a TRAP: it silently DROPS the other patterns the
 * shipped phrase carried (obfuscation variants like `|dck|` and `|pnis`), so
 * "dck" and "pnis" would stop being caught. Instead we CAPTURE the shipped
 * `PhraseContainer` in the predicate and re-add it with its `patterns` array
 * intact, appending only whitelist terms. That also means an obscenity upgrade
 * that adds new patterns for these words is picked up automatically.
 *
 * ASSUMES `removePhrasesIf` invokes the predicate EXACTLY ONCE per container
 * (true at 0.4.6: it splices the container list once and loops it). The
 * documented contract only promises "return true to remove", so if a future
 * version called it twice, `captured` would hold duplicates and each patched
 * phrase would be re-added N times. The `^0.4.6` range cannot reach 0.5.0, so
 * re-check this when widening it.
 */
function buildWhitelistedEnglishDataset(): DataSet<ProfanityMetadata> {
  const captured: Array<{
    word: EnglishProfaneWord;
    phrase: PhraseContainer<ProfanityMetadata>;
  }> = [];

  const dataset = new DataSet<ProfanityMetadata>()
    .addAll(englishDataset)
    .removePhrasesIf((phrase) => {
      const word = phrase.metadata?.originalWord;
      if (!word || !(word in ADDITIONAL_WHITELISTED_TERMS)) return false;
      captured.push({ word, phrase });
      return true; // re-added below, patterns intact + extra whitelist terms
    });

  for (const { word, phrase } of captured) {
    const extraTerms = ADDITIONAL_WHITELISTED_TERMS[word] ?? [];
    dataset.addPhrase((builder) => {
      builder.setMetadata(phrase.metadata);
      for (const shippedPattern of phrase.patterns) {
        builder.addPattern(shippedPattern);
      }
      for (const term of [...phrase.whitelistedTerms, ...extraTerms]) {
        builder.addWhitelistedTerm(term);
      }
      return builder;
    });
  }

  return dataset;
}

const profanityDataset = buildWhitelistedEnglishDataset();

const englishProfanityMatcher = new RegExpMatcher({
  ...profanityDataset.build(),
  ...englishRecommendedTransformers,
});

export function createProfanityContentFilterAdapter(): ContentFilterPort {
  return {
    async hasBlockedContent({ text }) {
      const normalized = text.trim();
      if (!normalized) return false;

      return englishProfanityMatcher.hasMatch(normalized);
    },

    async findBlocked({ text }): Promise<ContentFilterMatch> {
      const normalized = text.trim();
      if (!normalized) return { blocked: false };

      // `getAllMatches(text, true)` returns matches sorted by position, so the
      // first entry is the earliest offending term. Resolve each match back to
      // its dictionary word via the dataset's phrase metadata.
      //
      // This MUST resolve against `profanityDataset`, not `englishDataset`:
      // `build()` assigns pattern IDs by position, and re-adding the patched
      // phrases moves them to the end, so the two datasets disagree on every ID
      // after the first patched word. Resolving a "dick" match against
      // `englishDataset` reports "vagina".
      const matchPayloads = englishProfanityMatcher.getAllMatches(
        normalized,
        true,
      );
      if (matchPayloads.length === 0) return { blocked: false };

      const matches: string[] = [];
      for (const payload of matchPayloads) {
        const word =
          profanityDataset.getPayloadWithPhraseMetadata(payload).phraseMetadata
            ?.originalWord;
        if (word && !matches.includes(word)) matches.push(word);
      }
      return { blocked: true, ...(matches.length > 0 ? { matches } : {}) };
    },
  };
}
