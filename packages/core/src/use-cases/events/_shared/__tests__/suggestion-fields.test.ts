import { describe, expect, it } from "vitest";

import { makeStubEventRecord } from "@th/test-utils/fakes/stub-records";
import {
  MATERIAL_SUGGESTION_FIELDS,
  computeConflicts,
  computeMaterial,
  isMaterialField,
  parseSuggestionFields,
  snapshotSuggestionBase,
  suggestionValuesEqual,
} from "../suggestion-fields";

const CATEGORY_ID = "11111111-1111-4111-8111-111111111111";

/** Run `fn`, return what it throws; fail the test if it does not throw. */
function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected function to throw");
}

// ── Whitelist parsing (FR-006/FR-007) ────────────────────────────────────────

describe("parseSuggestionFields", () => {
  it("rejects a non-whitelisted field with EDIT_SUGGESTION_INVALID_FIELDS", () => {
    const error = catchError(() =>
      parseSuggestionFields({
        title: "New title",
        admissionTaxRateBps: 975,
      }),
    );
    expect(error).toMatchObject({
      code: "EDIT_SUGGESTION_INVALID_FIELDS",
      meta: { reason: "unsupported_fields", fields: ["admissionTaxRateBps"] },
    });
  });

  it("rejects ownership/status smuggling (orgId, status)", () => {
    const error = catchError(() =>
      parseSuggestionFields({ orgId: CATEGORY_ID, status: "CANCELLED" }),
    );
    expect(error).toMatchObject({ code: "EDIT_SUGGESTION_INVALID_FIELDS" });
  });

  it("rejects an empty diff", () => {
    const error = catchError(() => parseSuggestionFields({}));
    expect(error).toMatchObject({
      code: "EDIT_SUGGESTION_INVALID_FIELDS",
      meta: { reason: "empty_diff" },
    });
  });

  it("rejects non-object payloads", () => {
    for (const raw of [null, "title", 42, ["title"]]) {
      const error = catchError(() => parseSuggestionFields(raw));
      expect(error).toMatchObject({ code: "EDIT_SUGGESTION_INVALID_FIELDS" });
    }
  });

  it("parses a valid diff (trims title, uppercases countryCode, coerces dates)", () => {
    const parsed = parseSuggestionFields({
      title: "  Open Mic Night  ",
      startsAt: "2026-08-01T19:00:00.000Z",
      endsAt: new Date("2026-08-01T22:00:00.000Z"),
      timezone: "America/Chicago",
      countryCode: "us",
      categoryId: CATEGORY_ID,
      ageLimit: 18,
    });

    expect(parsed.title).toBe("Open Mic Night");
    expect(parsed.startsAt).toEqual(new Date("2026-08-01T19:00:00.000Z"));
    expect(parsed.endsAt).toEqual(new Date("2026-08-01T22:00:00.000Z"));
    expect(parsed.countryCode).toBe("US");
    expect(parsed.ageLimit).toBe(18);
  });

  it("rejects endsAt <= startsAt when both are proposed", () => {
    const error = catchError(() =>
      parseSuggestionFields({
        startsAt: "2026-08-01T22:00:00.000Z",
        endsAt: "2026-08-01T19:00:00.000Z",
      }),
    );
    expect(error).toMatchObject({ code: "invalid_input" });
  });

  it("rejects an invalid IANA timezone", () => {
    const error = catchError(() =>
      parseSuggestionFields({ timezone: "America/Not_A_Zone" }),
    );
    expect(error).toMatchObject({ code: "invalid_input" });
  });

  it("rejects an unparseable datetime", () => {
    const error = catchError(() =>
      parseSuggestionFields({ startsAt: "not-a-date" }),
    );
    expect(error).toMatchObject({ code: "invalid_input" });
  });

  it("rejects out-of-range lat/lng", () => {
    const error = catchError(() => parseSuggestionFields({ lat: 91, lng: 0 }));
    expect(error).toMatchObject({ code: "invalid_input" });
  });

  // Pairing invariant: geohash6 is only re-derived from a FULL lat/lng pair,
  // so a lone or mixed-null pair must never reach the adapter.
  it("rejects a lone lat (lat/lng must travel together)", () => {
    const error = catchError(() => parseSuggestionFields({ lat: 30.26 }));
    expect(error).toMatchObject({
      code: "EDIT_SUGGESTION_INVALID_FIELDS",
      meta: { reason: "lat_lng_must_pair", fields: ["lat", "lng"] },
    });
  });

  it("rejects a mixed null/number lat/lng pair", () => {
    const error = catchError(() =>
      parseSuggestionFields({ lat: null, lng: -97.74 }),
    );
    expect(error).toMatchObject({
      code: "EDIT_SUGGESTION_INVALID_FIELDS",
      meta: { reason: "lat_lng_must_pair", fields: ["lat", "lng"] },
    });
  });

  it("accepts lat and lng null as a pair", () => {
    const parsed = parseSuggestionFields({ lat: null, lng: null });
    expect(parsed.lat).toBeNull();
    expect(parsed.lng).toBeNull();
  });

  it("accepts a full numeric lat/lng pair", () => {
    const parsed = parseSuggestionFields({ lat: 30.26, lng: -97.74 });
    expect(parsed.lat).toBe(30.26);
    expect(parsed.lng).toBe(-97.74);
  });
});

// ── Material fields (FR-013) ─────────────────────────────────────────────────

describe("material fields", () => {
  it("tags schedule + address/geo as material, everything else not", () => {
    expect([...MATERIAL_SUGGESTION_FIELDS].sort()).toEqual(
      [
        "startsAt",
        "endsAt",
        "addressText",
        "countryCode",
        "region",
        "locality",
        "postalCode",
        "lat",
        "lng",
      ].sort(),
    );
    expect(isMaterialField("startsAt")).toBe(true);
    expect(isMaterialField("postalCode")).toBe(true);
    expect(isMaterialField("title")).toBe(false);
    expect(isMaterialField("timezone")).toBe(false);
    expect(isMaterialField("heroImageId")).toBe(false);
  });

  it("computeMaterial is true iff any changed field is material", () => {
    expect(computeMaterial(["title", "lat"])).toBe(true);
    expect(computeMaterial(["title", "timezone", "categoryId"])).toBe(false);
    expect(computeMaterial([])).toBe(false);
  });
});

// ── Base snapshot (FR-009) ───────────────────────────────────────────────────

describe("snapshotSuggestionBase", () => {
  it("captures exactly the whitelisted fields, dates as ISO strings", () => {
    const event = makeStubEventRecord({
      title: "Weekly Jam",
      timezone: "America/Chicago",
      startsAt: new Date("2026-08-01T19:00:00.000Z"),
      endsAt: new Date("2026-08-01T22:00:00.000Z"),
      addressText: "123 Main St",
      countryCode: "US",
      region: "TX",
      locality: "Austin",
      postalCode: "78701",
      lat: 30.26,
      lng: -97.74,
      categoryId: CATEGORY_ID,
      ageLimit: null,
    });

    const content = { version: 1, sections: [] };
    const snapshot = snapshotSuggestionBase({
      event,
      content,
      heroImageId: null,
    });

    expect(snapshot).toEqual({
      title: "Weekly Jam",
      content,
      startsAt: "2026-08-01T19:00:00.000Z",
      endsAt: "2026-08-01T22:00:00.000Z",
      timezone: "America/Chicago",
      addressText: "123 Main St",
      countryCode: "US",
      region: "TX",
      locality: "Austin",
      postalCode: "78701",
      lat: 30.26,
      lng: -97.74,
      categoryId: CATEGORY_ID,
      heroImageId: null,
      ageLimit: null,
    });
  });

  it("normalizes absent optionals to null", () => {
    const event = makeStubEventRecord({
      timezone: "UTC",
      endsAt: null,
      addressText: null,
      countryCode: null,
    });
    const snapshot = snapshotSuggestionBase({ event, content: null });
    expect(snapshot.endsAt).toBeNull();
    expect(snapshot.content).toBeNull();
    expect(snapshot.heroImageId).toBeNull();
    expect(snapshot.addressText).toBeNull();
  });
});

// ── Conflict detection (FR-009) ──────────────────────────────────────────────

function makeSnapshots() {
  const base: Record<string, unknown> = {
    title: "Weekly Jam",
    content: { version: 1, sections: [] },
    startsAt: "2026-08-01T19:00:00.000Z",
    endsAt: "2026-08-01T22:00:00.000Z",
    timezone: "America/Chicago",
    addressText: "123 Main St",
    countryCode: "US",
    region: "TX",
    locality: "Austin",
    postalCode: "78701",
    lat: 30.26,
    lng: -97.74,
    categoryId: null,
    heroImageId: null,
    ageLimit: null,
  };
  return { base, current: { ...base } };
}

describe("computeConflicts", () => {
  it("applies everything when the event has not drifted", () => {
    const { base, current } = makeSnapshots();
    const result = computeConflicts({
      proposed: { title: "New Title", ageLimit: 21 },
      base,
      current,
    });
    expect(result.conflicted).toEqual([]);
    expect(result.applicable).toEqual({ title: "New Title", ageLimit: 21 });
  });

  it("flags a per-field conflict and still applies the rest", () => {
    const { base, current } = makeSnapshots();
    current.title = "Someone Renamed It";
    const result = computeConflicts({
      proposed: { title: "New Title", ageLimit: 21 },
      base,
      current,
    });
    expect(result.conflicted).toEqual(["title"]);
    expect(result.applicable).toEqual({ ageLimit: 21 });
  });

  it("conflicts the WHOLE geo group when any geo field drifted", () => {
    const { base, current } = makeSnapshots();
    // Someone moved the venue's postal code after the suggestion was drafted.
    current.postalCode = "78702";
    const result = computeConflicts({
      proposed: { title: "New Title", lat: 31.0, lng: -98.0 },
      base,
      current,
    });
    // lat+lng are proposed geo fields — both conflict as a group even though
    // lat/lng themselves did not drift; title applies independently.
    expect(result.conflicted.sort()).toEqual(["lat", "lng"]);
    expect(result.applicable).toEqual({ title: "New Title" });
  });

  it("does not group-conflict when no geo field is proposed", () => {
    const { base, current } = makeSnapshots();
    current.postalCode = "78702";
    const result = computeConflicts({
      proposed: { title: "New Title" },
      base,
      current,
    });
    expect(result.conflicted).toEqual([]);
    expect(result.applicable).toEqual({ title: "New Title" });
  });

  it("schedule group — drift-straddle: a moved startsAt conflicts BOTH proposed bounds (never a split pair)", () => {
    // Reviewer scenario: base start=05:00 end=12:00; the owner moved
    // start→10:00 after the suggestion was drafted; the suggestion proposes
    // start=06:00 end=08:00 (a valid pair against each other). Per-field
    // filtering would conflict startsAt but APPLY endsAt=08:00 against the
    // current start=10:00 → committed start 10:00 > end 08:00. The schedule
    // group must conflict both bounds instead.
    const { base, current } = makeSnapshots();
    base.startsAt = "2026-08-01T05:00:00.000Z";
    base.endsAt = "2026-08-01T12:00:00.000Z";
    current.startsAt = "2026-08-01T10:00:00.000Z";
    current.endsAt = "2026-08-01T12:00:00.000Z";
    const result = computeConflicts({
      proposed: {
        startsAt: "2026-08-01T06:00:00.000Z",
        endsAt: "2026-08-01T08:00:00.000Z",
        title: "Kept Title",
      },
      base,
      current,
    });
    expect(result.conflicted.sort()).toEqual(["endsAt", "startsAt"]);
    // Non-schedule fields still apply independently.
    expect(result.applicable).toEqual({ title: "Kept Title" });
  });

  it("schedule group — mirror: a moved endsAt conflicts BOTH proposed bounds", () => {
    // Mirror of the straddle: base start=05:00 end=12:00; the owner moved
    // end→07:00; the suggestion proposes start=09:00 end=11:00. Per-field
    // filtering would apply the lone startsAt=09:00 against the current
    // end=07:00 → inverted schedule. The group conflicts both bounds.
    const { base, current } = makeSnapshots();
    base.startsAt = "2026-08-01T05:00:00.000Z";
    base.endsAt = "2026-08-01T12:00:00.000Z";
    current.startsAt = "2026-08-01T05:00:00.000Z";
    current.endsAt = "2026-08-01T07:00:00.000Z";
    const result = computeConflicts({
      proposed: {
        startsAt: "2026-08-01T09:00:00.000Z",
        endsAt: "2026-08-01T11:00:00.000Z",
      },
      base,
      current,
    });
    expect(result.conflicted.sort()).toEqual(["endsAt", "startsAt"]);
    expect(result.applicable).toEqual({});
  });

  it("schedule group — a lone proposed bound applies when neither bound drifted", () => {
    const { base, current } = makeSnapshots();
    const result = computeConflicts({
      proposed: { endsAt: "2026-08-01T23:30:00.000Z" },
      base,
      current,
    });
    expect(result.conflicted).toEqual([]);
    expect(result.applicable).toEqual({ endsAt: "2026-08-01T23:30:00.000Z" });
  });

  it("schedule group — schedule drift does not conflict when no schedule field is proposed", () => {
    const { base, current } = makeSnapshots();
    current.startsAt = "2026-08-02T19:00:00.000Z";
    const result = computeConflicts({
      proposed: { title: "New Title" },
      base,
      current,
    });
    expect(result.conflicted).toEqual([]);
    expect(result.applicable).toEqual({ title: "New Title" });
  });

  it("compares body content by structural deep-equal, not identity", () => {
    const { base, current } = makeSnapshots();
    // Same structure, different object identity + key order.
    base.content = { version: 1, sections: [{ id: "s1", kind: "section" }] };
    current.content = { sections: [{ kind: "section", id: "s1" }], version: 1 };
    const proposedBody = { version: 1, sections: [] };
    const result = computeConflicts({
      proposed: { content: proposedBody },
      base,
      current,
    });
    expect(result.conflicted).toEqual([]);
    expect(result.applicable).toEqual({ content: proposedBody });
  });

  it("flags a body conflict when the stored body drifted", () => {
    const { base, current } = makeSnapshots();
    current.content = {
      version: 1,
      sections: [{ id: "someone-elses-edit", kind: "section" }],
    };
    const result = computeConflicts({
      proposed: { content: { version: 1, sections: [] } },
      base,
      current,
    });
    expect(result.conflicted).toEqual(["content"]);
  });

  it("compares dates by instant across Date/ISO-string representations", () => {
    const { base, current } = makeSnapshots();
    // A freshly built snapshot could carry Date instances.
    current.startsAt = new Date("2026-08-01T19:00:00.000Z");
    const result = computeConflicts({
      proposed: { startsAt: new Date("2026-09-01T19:00:00.000Z") },
      base,
      current,
    });
    expect(result.conflicted).toEqual([]);
    expect(result.applicable).toEqual({
      startsAt: new Date("2026-09-01T19:00:00.000Z"),
    });
  });

  it("flags a date conflict when the instant actually moved", () => {
    const { base, current } = makeSnapshots();
    current.startsAt = "2026-08-02T19:00:00.000Z";
    const result = computeConflicts({
      proposed: { startsAt: "2026-09-01T19:00:00.000Z" },
      base,
      current,
    });
    expect(result.conflicted).toEqual(["startsAt"]);
  });
});

describe("suggestionValuesEqual", () => {
  it("treats null and undefined uniformly", () => {
    expect(suggestionValuesEqual(null, undefined)).toBe(true);
    expect(suggestionValuesEqual(undefined, undefined)).toBe(true);
    expect(suggestionValuesEqual(null, "x")).toBe(false);
  });

  it("compares primitives strictly", () => {
    expect(suggestionValuesEqual("a", "a")).toBe(true);
    expect(suggestionValuesEqual(1, "1")).toBe(false);
  });
});
