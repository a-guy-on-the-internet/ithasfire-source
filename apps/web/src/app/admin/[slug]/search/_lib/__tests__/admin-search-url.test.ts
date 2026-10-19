/**
 * admin-search-url — FR-011's URL model.
 *
 * The load-bearing test here is the FIRST one: it builds a hand-off URL with
 * the overlay's own writer (`appendAdminFacetParams`) and asserts this page's
 * parser reads every facet back. Rename a param on either side and it goes red
 * — which is the failure the spec calls out ("the hand-off silently drops
 * filters"), and one no amount of type-checking can catch, because both sides
 * are strings.
 */

import { describe, expect, it } from "vitest";

import {
  EMPTY_ADMIN_FACETS,
  appendAdminFacetParams,
  type AdminFacetState,
} from "@/components/search/spotlight-admin-facets";

import {
  adminSearchStateEquals,
  buildAdminSearchQueryString,
  normalizeAdminSearchQueryString,
  parseAdminSearchParams,
  type AdminSearchUrlState,
} from "../admin-search-url";

const CATEGORY_ID = "22222222-2222-4222-8222-222222222222";

const parse = (qs: string) => parseAdminSearchParams(new URLSearchParams(qs));

const build = (state: AdminSearchUrlState, preserved?: string) =>
  buildAdminSearchQueryString({ state, preserved });

const stateOf = (
  overrides: Partial<AdminSearchUrlState> = {},
): AdminSearchUrlState => ({
  query: "",
  group: null,
  facets: EMPTY_ADMIN_FACETS,
  ...overrides,
});

const facetsOf = (overrides: Partial<AdminFacetState>): AdminFacetState => ({
  ...EMPTY_ADMIN_FACETS,
  ...overrides,
});

// ── The contract with the overlay ────────────────────────────────────────────

describe("spotlight hand-off param names", () => {
  it("reads back every facet the overlay's writer emits", () => {
    const anchor = new Date("2026-08-04T14:32:11.123Z");
    const params = new URLSearchParams();
    params.set("search", "jazz");
    // Written by the SAME function `SpotlightSearch.handleFullSearch` calls.
    appendAdminFacetParams(
      params,
      facetsOf({
        status: "DRAFT",
        date: "UPCOMING",
        dateAnchorMs: anchor.getTime(),
        categoryId: CATEGORY_ID,
        includeUncategorised: true,
      }),
      "event",
    );

    // Pin the literal names too — a renamed param would otherwise only fail
    // once both sides had been renamed together, which is the bug.
    expect([...params.keys()].sort()).toEqual([
      "category",
      "date",
      "from",
      "search",
      "status",
      "type",
      "uncat",
    ]);
    expect(params.get("date")).toBe("UPCOMING");

    const parsed = parse(params.toString());
    expect(parsed.query).toBe("jazz");
    expect(parsed.group).toBe("event");
    expect(parsed.facets.status).toBe("DRAFT");
    expect(parsed.facets.categoryId).toBe(CATEGORY_ID);
    expect(parsed.facets.includeUncategorised).toBe(true);
    expect(parsed.facets.date).toBe("UPCOMING");
    expect(parsed.facets.dateAnchorMs).toBe(anchor.getTime());
  });

  it("reads a PAST hand-off back as PAST", () => {
    const anchor = new Date("2026-08-04T14:32:11.123Z");
    const params = new URLSearchParams();
    appendAdminFacetParams(
      params,
      facetsOf({ date: "PAST", dateAnchorMs: anchor.getTime() }),
      null,
    );
    expect(params.get("to")).toBe(anchor.toISOString());

    const parsed = parse(params.toString());
    expect(parsed.facets.date).toBe("PAST");
    expect(parsed.facets.dateAnchorMs).toBe(anchor.getTime());
    expect(parsed.group).toBeNull();
  });

  it("reads a custom range back as day-bounded CUSTOM", () => {
    const params = new URLSearchParams();
    appendAdminFacetParams(
      params,
      facetsOf({
        date: "CUSTOM",
        customFrom: "2026-08-01",
        customTo: "2026-08-10",
      }),
      null,
    );

    const parsed = parse(params.toString());
    expect(parsed.facets.date).toBe("CUSTOM");
    expect(parsed.facets.customFrom).toBe("2026-08-01");
    expect(parsed.facets.customTo).toBe("2026-08-10");
  });
});

// ── Parsing ──────────────────────────────────────────────────────────────────

describe("parseAdminSearchParams", () => {
  it("returns the empty state for an empty querystring", () => {
    expect(parse("")).toEqual(stateOf());
  });

  it("trims the query", () => {
    expect(parse("search=%20jazz%20").query).toBe("jazz");
  });

  it("whitelists the type param", () => {
    expect(parse("type=attendee").group).toBe("attendee");
    expect(parse("type=organization").group).toBeNull();
    expect(parse("type=order").group).toBeNull();
  });

  it("whitelists the status param", () => {
    expect(parse("status=DRAFT").facets.status).toBe("DRAFT");
    expect(parse("status=draft").facets.status).toBe("ALL");
    expect(parse("status=NONSENSE").facets.status).toBe("ALL");
  });

  /**
   * `categoryIds` is `z.string().uuid()` on the wire. A hand-typed
   * `?category=music` would 400 the whole search rather than simply not
   * filtering — so it is dropped at the boundary, not forwarded.
   */
  it("drops a non-UUID category instead of forwarding it", () => {
    expect(parse(`category=${CATEGORY_ID}`).facets.categoryId).toBe(
      CATEGORY_ID,
    );
    expect(parse("category=music").facets.categoryId).toBeNull();
  });

  /**
   * `uncat` is the `categoryId IS NULL` arm — a filter in its own right, and
   * NOT expressible as a `category` id (SQL `IN` never matches NULL). Only the
   * literal "1" the builder writes turns it on; anything else reads as off, so
   * a hand-edited URL degrades to "no filter" rather than round-tripping to a
   * value the builder would immediately rewrite (which is the ping-pong).
   */
  it("reads uncat=1 as the uncategorised arm and rejects other spellings", () => {
    expect(parse("uncat=1").facets.includeUncategorised).toBe(true);
    for (const qs of ["uncat=true", "uncat=0", "uncat=", "uncat=yes", ""]) {
      expect(parse(qs).facets.includeUncategorised, qs).toBe(false);
    }
  });

  it("reads the uncategorised arm alone, with no category id", () => {
    const parsed = parse("uncat=1");
    expect(parsed.facets.categoryId).toBeNull();
    expect(parsed.facets.includeUncategorised).toBe(true);
  });

  it("ignores unparseable dates", () => {
    expect(parse("from=yesterday").facets.date).toBe("ANY");
  });

  it("whitelists the date mode param", () => {
    expect(parse("date=CUSTOM").facets.date).toBe("CUSTOM");
    expect(parse("date=custom").facets.date).toBe("ANY");
    expect(parse("date=SOMEDAY").facets.date).toBe("ANY");
  });

  /**
   * An explicit mode with no bound is still that mode — this is the blank
   * "Custom range" the pill produces on its first click, and the reason the
   * mode is serialised at all.
   */
  it("keeps a bound-less CUSTOM mode", () => {
    const parsed = parse("date=CUSTOM");
    expect(parsed.facets.date).toBe("CUSTOM");
    expect(parsed.facets.customFrom).toBe("");
    expect(parsed.facets.customTo).toBe("");
  });

  it("lets the explicit mode override what the bounds would imply", () => {
    // A midnight lower bound alone would INFER "CUSTOM"; the mode says
    // otherwise, and the mode is what the user actually picked.
    const midnight = new Date(2026, 7, 1, 0, 0, 0, 0);
    const parsed = parse(
      `date=UPCOMING&from=${encodeURIComponent(midnight.toISOString())}`,
    );
    expect(parsed.facets.date).toBe("UPCOMING");
    expect(parsed.facets.dateAnchorMs).toBe(midnight.getTime());
  });
});

/**
 * Links shared before `?date=` existed must keep working, so the bounds-only
 * inference stays as the fallback path.
 */
describe("legacy bounds-only URLs (no ?date=)", () => {
  it("still infers UPCOMING from a lone arbitrary-time lower bound", () => {
    const anchor = new Date("2026-08-04T14:32:11.123Z");
    const parsed = parse(`from=${encodeURIComponent(anchor.toISOString())}`);
    expect(parsed.facets.date).toBe("UPCOMING");
    expect(parsed.facets.dateAnchorMs).toBe(anchor.getTime());
  });

  it("still infers PAST from a lone arbitrary-time upper bound", () => {
    const anchor = new Date("2026-08-04T14:32:11.123Z");
    const parsed = parse(`to=${encodeURIComponent(anchor.toISOString())}`);
    expect(parsed.facets.date).toBe("PAST");
  });

  /**
   * The DST-at-midnight case. `localStartOfDay` round-trips through the Date
   * constructor, so a day whose 00:00 does not exist still compares equal to
   * "the start of its day" — a literal `getHours() === 0` check would call
   * that bound arbitrary and misread the range as UPCOMING.
   */
  it("classifies a day's own start bound as CUSTOM even when 00:00 does not exist", () => {
    for (const day of [
      [2026, 7, 1],
      [2026, 8, 6], // Southern-hemisphere DST forward, Santiago-style
      [2026, 2, 8],
      [2026, 9, 25],
    ] as const) {
      const start = new Date(day[0], day[1], day[2], 0, 0, 0, 0);
      const parsed = parse(`from=${encodeURIComponent(start.toISOString())}`);
      expect(parsed.facets.date, start.toISOString()).toBe("CUSTOM");
    }
  });

  it("still infers CUSTOM from a day-bounded pair", () => {
    const from = new Date(2026, 7, 1, 0, 0, 0, 0);
    const to = new Date(2026, 7, 10, 23, 59, 59, 999);
    const parsed = parse(
      `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`,
    );
    expect(parsed.facets.date).toBe("CUSTOM");
    expect(parsed.facets.customFrom).toBe("2026-08-01");
    expect(parsed.facets.customTo).toBe("2026-08-10");
  });
});

// ── Round-trip stability (the loop guard) ────────────────────────────────────

describe("build ∘ parse is stable", () => {
  const cases: [string, AdminSearchUrlState][] = [
    ["empty", stateOf()],
    ["query only", stateOf({ query: "jazz" })],
    ["group only", stateOf({ group: "venue" })],
    ["status", stateOf({ facets: facetsOf({ status: "DRAFT" }) })],
    ["category", stateOf({ facets: facetsOf({ categoryId: CATEGORY_ID }) })],
    /**
     * "Only uncategorised" — no `category` param at all. If this did not
     * round-trip, the single-writer effect would parse the URL back as
     * "no filter", disagree with the state, and push it straight back.
     */
    [
      "uncategorised only",
      stateOf({ facets: facetsOf({ includeUncategorised: true }) }),
    ],
    [
      "category + uncategorised",
      stateOf({
        facets: facetsOf({ categoryId: CATEGORY_ID, includeUncategorised: true }),
      }),
    ],
    [
      "upcoming",
      stateOf({
        facets: facetsOf({
          date: "UPCOMING",
          dateAnchorMs: new Date("2026-08-04T14:32:11.123Z").getTime(),
        }),
      }),
    ],
    [
      "past",
      stateOf({
        facets: facetsOf({
          date: "PAST",
          dateAnchorMs: new Date("2026-08-04T09:05:00.500Z").getTime(),
        }),
      }),
    ],
    [
      "custom both bounds",
      stateOf({
        facets: facetsOf({
          date: "CUSTOM",
          customFrom: "2026-08-01",
          customTo: "2026-08-10",
        }),
      }),
    ],
    /**
     * The state the UI produces on the FIRST click of the Custom range pill:
     * mode selected, both bounds still blank. It carries no `from`/`to`, so
     * without an explicit `?date=` the mode is unrepresentable — and the next
     * commit re-parses it as ANY, collapsing the facet under the user.
     */
    ["custom blank (mode picked, no bounds yet)", stateOf({
      facets: facetsOf({ date: "CUSTOM" }),
    })],
    [
      "custom from only",
      stateOf({
        facets: facetsOf({ date: "CUSTOM", customFrom: "2026-08-01" }),
      }),
    ],
    [
      "custom to only",
      stateOf({ facets: facetsOf({ date: "CUSTOM", customTo: "2026-08-10" }) }),
    ],
    [
      "everything",
      stateOf({
        query: "jazz",
        group: "event",
        facets: facetsOf({
          status: "PUBLISHED",
          categoryId: CATEGORY_ID,
          includeUncategorised: true,
          date: "CUSTOM",
          customFrom: "2026-08-01",
          customTo: "2026-08-10",
        }),
      }),
    ],
  ];

  it.each(cases)("parse(build(%s)) === the state", (_name, state) => {
    expect(adminSearchStateEquals(parse(build(state)), state)).toBe(true);
  });

  it.each(cases)("build(parse(build(%s))) === build(state)", (_name, state) => {
    const once = build(state);
    expect(build(parse(once), once)).toBe(once);
  });

  /**
   * The heart of the loop guard: writing the URL and then re-parsing it must
   * produce a state the page already has, so the URL → state effect no-ops
   * instead of re-rendering and re-writing forever.
   */
  it("normalising an already-canonical querystring is a no-op", () => {
    const qs = build(
      stateOf({ query: "jazz", facets: facetsOf({ status: "DRAFT" }) }),
    );
    expect(normalizeAdminSearchQueryString(qs)).toBe(qs);
  });
});

// ── Building ─────────────────────────────────────────────────────────────────

describe("buildAdminSearchQueryString", () => {
  it("omits every owned key for the empty state", () => {
    expect(build(stateOf())).toBe("");
  });

  it("clears a facet that was dropped rather than leaving it in `preserved`", () => {
    const withStatus = build(
      stateOf({ query: "jazz", facets: facetsOf({ status: "DRAFT" }) }),
    );
    expect(withStatus).toContain("status=DRAFT");

    const cleared = build(stateOf({ query: "jazz" }), withStatus);
    expect(cleared).toBe("search=jazz");
  });

  it("preserves foreign keys it does not own", () => {
    const qs = build(stateOf({ query: "jazz" }), "tab=settlements&p=3");
    const params = new URLSearchParams(qs);
    expect(params.get("tab")).toBe("settlements");
    expect(params.get("p")).toBe("3");
    expect(params.get("search")).toBe("jazz");
  });

  /**
   * Facet STATE outlives an inapplicable group on purpose: the page hides the
   * rows and strips the keys off the wire, but keeps them in the URL so
   * switching back to All restores what the admin had set. Dropping them here
   * would make the URL → state effect wipe the facet on the next render.
   */
  it("keeps facets on the URL even when the active group ignores them", () => {
    const qs = build(
      stateOf({ group: "attendee", facets: facetsOf({ status: "DRAFT" }) }),
    );
    expect(new URLSearchParams(qs).get("status")).toBe("DRAFT");
    expect(new URLSearchParams(qs).get("type")).toBe("attendee");
  });
});

describe("adminSearchStateEquals", () => {
  it("compares the facet block, not just the identity", () => {
    expect(adminSearchStateEquals(stateOf(), stateOf())).toBe(true);
    expect(
      adminSearchStateEquals(
        stateOf({ facets: facetsOf({ status: "DRAFT" }) }),
        stateOf({ facets: facetsOf({ status: "PUBLISHED" }) }),
      ),
    ).toBe(false);
    expect(
      adminSearchStateEquals(
        stateOf({ facets: facetsOf({ dateAnchorMs: 1 }) }),
        stateOf({ facets: facetsOf({ dateAnchorMs: 2 }) }),
      ),
    ).toBe(false);
  });

  /**
   * The loop guard for the new arm. If this comparison ignored
   * `includeUncategorised`, a restored URL would compare EQUAL to a state that
   * differs, and the effect would silently drop the filter on the next commit
   * — the mirror image of the ping-pong the comparison exists to prevent.
   */
  it("distinguishes the uncategorised arm", () => {
    expect(
      adminSearchStateEquals(
        stateOf({ facets: facetsOf({ includeUncategorised: true }) }),
        stateOf({ facets: facetsOf({ includeUncategorised: false }) }),
      ),
    ).toBe(false);

    // …and a URL round-trip of that state is still EQUAL, so the effect no-ops.
    const state = stateOf({ facets: facetsOf({ includeUncategorised: true }) });
    expect(adminSearchStateEquals(parse(build(state)), state)).toBe(true);
  });
});
