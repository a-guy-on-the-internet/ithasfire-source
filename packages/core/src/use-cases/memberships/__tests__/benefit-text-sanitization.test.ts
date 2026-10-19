import { describe, expect, it } from "vitest";

import { createMembershipTierInputSchemaBase } from "../create-membership-tier";
import { benefitTermsSchema } from "../schemas";
import { updateMembershipTierInputSchema } from "../update-membership-tier";

/**
 * Owner-authored free text that lands on PUBLIC, unauthenticated surfaces — the
 * entity-page tier card, the third-party embed, and the buyer's checkout line —
 * goes through the repo's plain-text cleaner, not a bare `.trim()`.
 *
 * Why this is worth its own file rather than an assertion tucked into the CRUD
 * tests: the helpers are `z.string().transform().pipe()` pipelines, and the
 * chaining (`.nullable().optional()` on a ZodPipeline) is exactly the kind of
 * thing that silently degrades to "accepts anything" if someone reorders it.
 * These tests fail loudly if the sanitizer is ever dropped or bypassed.
 *
 * React escapes at the render sink, so this is not the XSS defence. What it
 * defends is subtler: a bidi override (U+202E) renders text differently than it
 * is stored, on a page that is asking someone for money.
 */

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const TIER_ID = "33333333-3333-4333-8333-333333333333";

const baseTerms = { discountKind: "AMOUNT" as const, discountValue: 500 };
const baseTier = {
  actorHumanId: ACTOR_ID,
  ownerOrgId: ORG_ID,
  name: "Sustaining Member",
  priceCents: 1000,
  currency: "usd",
};

describe("benefit label sanitization", () => {
  it("strips markup and bidi overrides rather than trimming", () => {
    const parsed = benefitTermsSchema.parse({
      ...baseTerms,
      label: "  <b>Locals</b>‮rate  ",
    });

    expect(parsed.label).toBe("Localsrate");
    expect(parsed.label).not.toContain("<b>");
    expect(parsed.label).not.toContain("‮");
  });

  it("applies the 80-char cap to the CLEANED value, not the raw input", () => {
    // 80 real characters wrapped in markup is 87 raw. A naive `.max(80)` on the
    // raw string would refuse a label the owner is entitled to.
    const parsed = benefitTermsSchema.parse({
      ...baseTerms,
      label: `<b>${"x".repeat(80)}</b>`,
    });

    expect(parsed.label).toBe("x".repeat(80));
  });

  it("collapses a label that sanitizes to EMPTY into null", () => {
    // "<b></b>" is not a label, it is markup. Left as "", the checkout line's
    // `label ?? generated` fallback would render a BLANK label where the tier
    // name belongs — worse than having no override at all.
    expect(
      benefitTermsSchema.parse({ ...baseTerms, label: "<b></b>" }).label,
    ).toBeNull();
  });

  it("passes null and omitted through without entering the transform", () => {
    // The chaining question: `.nullable().optional()` on a ZodPipeline must
    // short-circuit BEFORE the string transform, or a null tier label would
    // throw inside the sanitizer instead of being stored as "no override".
    expect(benefitTermsSchema.parse({ ...baseTerms, label: null }).label).toBeNull();
    expect(benefitTermsSchema.parse(baseTerms).label).toBeUndefined();
  });
});

describe("benefitsDescription sanitization", () => {
  it("strips markup on create while KEEPING newlines", () => {
    // Multiline, unlike `label`: this is a paragraph an owner writes about what
    // members get, and collapsing their line breaks would mangle it.
    const parsed = createMembershipTierInputSchemaBase.parse({
      ...baseTier,
      benefitsDescription: "<script>x</script>Two free drinks\nName on the wall",
    });

    expect(parsed.benefitsDescription).not.toContain("<script>");
    expect(parsed.benefitsDescription).toContain("\n");
  });

  it("sanitizes on UPDATE too — both write paths, not just create", () => {
    const parsed = updateMembershipTierInputSchema.parse({
      actorHumanId: ACTOR_ID,
      tierId: TIER_ID,
      benefitsDescription: "  <em>First dibs</em>‮  ",
    });

    expect(parsed.benefitsDescription).toBe("First dibs");
  });

  it("passes null and omitted through on both write paths", () => {
    expect(
      createMembershipTierInputSchemaBase.parse({
        ...baseTier,
        benefitsDescription: null,
      }).benefitsDescription,
    ).toBeNull();
    expect(
      createMembershipTierInputSchemaBase.parse(baseTier).benefitsDescription,
    ).toBeUndefined();
    expect(
      updateMembershipTierInputSchema.parse({
        actorHumanId: ACTOR_ID,
        tierId: TIER_ID,
        benefitsDescription: null,
      }).benefitsDescription,
    ).toBeNull();
  });
});
