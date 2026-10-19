import { describe, expect, it } from "vitest";

import { buildPageSlug } from "../_shared/page-slug";

const PLACE_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

describe("buildPageSlug", () => {
  // ── Shape ───────────────────────────────────────────────────────────────
  it("produces {sanitized-name}-{first 8 hex chars of the id}", () => {
    expect(buildPageSlug("Backstage Nashville", PLACE_ID)).toBe(
      "backstage-nashville-a1b2c3d4",
    );
  });

  it("takes the 8-char suffix from the id with dashes stripped", () => {
    // The UUID's first group is 8 chars, so this only differs from a naive
    // `slice(0, 8)` when the id is formatted differently — pin the strip.
    expect(buildPageSlug("Venue", "ab-cdef-gh12345-6789")).toBe(
      "venue-abcdefgh",
    );
  });

  // ── Name sanitisation ───────────────────────────────────────────────────
  it("lower-cases, strips punctuation, and collapses separator runs", () => {
    expect(buildPageSlug("Stubb's  BBQ & Bar!!", PLACE_ID)).toBe(
      "stubb-s-bbq-bar-a1b2c3d4",
    );
  });

  it("folds accents to their base letters", () => {
    expect(buildPageSlug("Café Öst", PLACE_ID)).toBe("cafe-ost-a1b2c3d4");
  });

  it("trims leading and trailing separators rather than emitting them", () => {
    expect(buildPageSlug("  — The Fillmore —  ", PLACE_ID)).toBe(
      "the-fillmore-a1b2c3d4",
    );
  });

  // ── Empty-name fallback ─────────────────────────────────────────────────
  it("falls back to place-<suffix> when the name sanitises to nothing", () => {
    expect(buildPageSlug("!!!", PLACE_ID)).toBe("place-a1b2c3d4");
    expect(buildPageSlug("", PLACE_ID)).toBe("place-a1b2c3d4");
    expect(buildPageSlug("   ", PLACE_ID)).toBe("place-a1b2c3d4");
  });

  // ── Determinism ─────────────────────────────────────────────────────────
  it("is deterministic — the same (name, id) always yields the same slug", () => {
    const a = buildPageSlug("Red Rocks Amphitheatre", PLACE_ID);
    const b = buildPageSlug("Red Rocks Amphitheatre", PLACE_ID);
    expect(a).toBe(b);
    // This is what lets a repair pass recompute what a create path should
    // have written, without storing anything.
    expect(a).toBe("red-rocks-amphitheatre-a1b2c3d4");
  });

  it("distinguishes two venues that share a name", () => {
    const other = "ffffffff-0000-4000-8000-000000000000";
    expect(buildPageSlug("The Basement", PLACE_ID)).not.toBe(
      buildPageSlug("The Basement", other),
    );
  });

  // ── The distinction the whole module exists for ─────────────────────────
  // `/places/[slug]` and `/p/[slug]` are single non-catch-all segments: a `/`
  // in the value can never match them. The since-deprecated `Place.slug` was
  // multi-segment (`us/tn/backstage-nashville--lknkdsbay9`) and failed exactly
  // this assertion, which is why it routed nowhere.
  it("is FLAT — never multi-segment", () => {
    expect(buildPageSlug("Backstage Nashville", PLACE_ID)).not.toContain("/");
    expect(buildPageSlug("Red Rocks / Amphitheatre", PLACE_ID)).not.toContain(
      "/",
    );
  });
});
