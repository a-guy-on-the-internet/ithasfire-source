/**
 * spotlight-admin-facets — the PURE facet model shared by the ⌘K overlay and
 * `/admin/[slug]/search`.
 *
 * The focus here is the CATEGORY facet's two arms. `Event.categoryId` is
 * nullable and SQL `IN` never matches NULL, so "uncategorised" is not a value
 * the `categoryIds` list can hold — it is a separate boolean that composes with
 * it. Both surfaces read this one definition, so a regression here is a
 * regression in both.
 */

import { describe, expect, it } from "vitest";

import {
  ADMIN_UNCATEGORISED_LABEL_KEY,
  EMPTY_ADMIN_FACETS,
  appendAdminFacetParams,
  buildAdminFacetInput,
  hasActiveAdminFacets,
  type AdminFacetState,
} from "../spotlight-admin-facets";

const CATEGORY_ID = "22222222-2222-4222-8222-222222222222";

const facetsOf = (overrides: Partial<AdminFacetState> = {}): AdminFacetState => ({
  ...EMPTY_ADMIN_FACETS,
  ...overrides,
});

describe("EMPTY_ADMIN_FACETS", () => {
  it("starts with the uncategorised arm OFF", () => {
    expect(EMPTY_ADMIN_FACETS.includeUncategorised).toBe(false);
    expect(buildAdminFacetInput(EMPTY_ADMIN_FACETS)).toEqual({});
  });
});

describe("buildAdminFacetInput — the category facet's two arms", () => {
  it("row 1: emits neither key when nothing is selected", () => {
    const input = buildAdminFacetInput(facetsOf());
    expect(input.categoryIds).toBeUndefined();
    expect(input.includeUncategorised).toBeUndefined();
  });

  it("row 2: a category alone emits only categoryIds", () => {
    const input = buildAdminFacetInput(facetsOf({ categoryId: CATEGORY_ID }));
    expect(input.categoryIds).toEqual([CATEGORY_ID]);
    expect(Object.keys(input)).not.toContain("includeUncategorised");
  });

  it("row 3: the two COMPOSE — a category plus uncategorised emits both", () => {
    const input = buildAdminFacetInput(
      facetsOf({ categoryId: CATEGORY_ID, includeUncategorised: true }),
    );
    expect(input.categoryIds).toEqual([CATEGORY_ID]);
    expect(input.includeUncategorised).toBe(true);
  });

  /**
   * The row this feature exists for: alone it is "ONLY uncategorised", so the
   * key must be SENT. Dropping it here would make the option a silent no-op.
   */
  it("row 4: uncategorised alone emits the flag and NO categoryIds", () => {
    const input = buildAdminFacetInput(facetsOf({ includeUncategorised: true }));
    expect(input.includeUncategorised).toBe(true);
    expect(Object.keys(input)).not.toContain("categoryIds");
  });

  it("never emits the flag as false — absent is the off state on the wire", () => {
    const input = buildAdminFacetInput(
      facetsOf({ includeUncategorised: false, categoryId: CATEGORY_ID }),
    );
    expect(Object.keys(input)).not.toContain("includeUncategorised");
  });
});

describe("hasActiveAdminFacets", () => {
  it("counts uncategorised on its own (the mobile FILTERS badge depends on it)", () => {
    expect(hasActiveAdminFacets(facetsOf())).toBe(false);
    expect(hasActiveAdminFacets(facetsOf({ includeUncategorised: true }))).toBe(
      true,
    );
  });

  it("still counts it alongside another facet", () => {
    expect(
      hasActiveAdminFacets(
        facetsOf({ categoryId: CATEGORY_ID, includeUncategorised: true }),
      ),
    ).toBe(true);
  });
});

describe("appendAdminFacetParams", () => {
  it("writes ?uncat=1 only when the arm is on", () => {
    const on = new URLSearchParams();
    appendAdminFacetParams(on, facetsOf({ includeUncategorised: true }), null);
    expect(on.get("uncat")).toBe("1");

    const off = new URLSearchParams();
    appendAdminFacetParams(off, facetsOf({ includeUncategorised: false }), null);
    expect(off.has("uncat")).toBe(false);
  });

  it("writes both params when both arms are on", () => {
    const params = new URLSearchParams();
    appendAdminFacetParams(
      params,
      facetsOf({ categoryId: CATEGORY_ID, includeUncategorised: true }),
      "event",
    );
    expect([...params.keys()].sort()).toEqual(["category", "type", "uncat"]);
  });
});

describe("ADMIN_UNCATEGORISED_LABEL_KEY", () => {
  /**
   * One definition for both surfaces — the overlay and the results page render
   * the SAME option because they read the same key.
   */
  it("is the spotlight-namespaced key both surfaces render", () => {
    expect(ADMIN_UNCATEGORISED_LABEL_KEY).toBe(
      "spotlight.categoryUncategorised",
    );
  });
});
