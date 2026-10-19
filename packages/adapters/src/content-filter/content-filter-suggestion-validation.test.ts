/**
 * COMPOSITION test: the REAL profanity adapter wired into the REAL
 * `ensureSuggestionTextAllowed` from core.
 *
 * It lives in `@th/adapters` rather than next to the core use case because core
 * must not import `@th/adapters` — so this seam is only observable from this
 * side. Everything here uses production code; there is no fake content filter,
 * which is the point: the core-side tests use a substring-matching fake that
 * cannot tell you whether the SHIPPED obscenity whitelist covers a real street
 * name.
 *
 * Pins both halves of the Sep 2026 false-positive fix:
 *   A. the adapter whitelists "dickerson" / "dickinson" / "sexy" / "penistone";
 *   B. `ensureSuggestionTextAllowed` no longer filters addressText / region /
 *      locality at all.
 *
 * Between them, all 3 of the 18 genuine Nashville open-mic listings that the
 * filter rejected now go through.
 */
import { describe, expect, it } from "vitest";

import { ensureSuggestionTextAllowed } from "@th/core/use-cases/community/_shared/suggestion-validation";

import { createProfanityContentFilterAdapter } from "./profanity-content-filter-adapter";

const contentFilter = createProfanityContentFilterAdapter();

describe("ensureSuggestionTextAllowed + the real profanity filter", () => {
  it.each([
    "Grown and Sexy Open Mic",
    "Open Mic on Dickerson Pike",
    "Charles Dickens Tribute Night",
    "Emily Dickinson Reading",
  ])("accepts the legitimate title: %s", async (title) => {
    await expect(
      ensureSuggestionTextAllowed({ contentFilter, title }),
    ).resolves.toBeUndefined();
  });

  it("accepts a note and body carrying a real venue name", async () => {
    await expect(
      ensureSuggestionTextAllowed({
        contentFilter,
        title: "Weekly Open Mic",
        note: "Moved to the Essex Lounge, just off Dickerson Pike.",
      }),
    ).resolves.toBeUndefined();
  });

  it("still rejects profanity in the title, naming the field and the term", async () => {
    await expect(
      ensureSuggestionTextAllowed({
        contentFilter,
        title: "fucking great night",
      }),
    ).rejects.toMatchObject({
      code: "EDIT_SUGGESTION_INVALID_FIELDS",
      meta: { reason: "blocked_content", fields: ["title"], term: "fuck" },
    });
  });

  it("still rejects profanity in the note", async () => {
    await expect(
      ensureSuggestionTextAllowed({
        contentFilter,
        title: "Weekly Open Mic",
        note: "what a dick",
      }),
    ).rejects.toMatchObject({
      code: "EDIT_SUGGESTION_INVALID_FIELDS",
      meta: { reason: "blocked_content", fields: ["note"], term: "dick" },
    });
  });
});
