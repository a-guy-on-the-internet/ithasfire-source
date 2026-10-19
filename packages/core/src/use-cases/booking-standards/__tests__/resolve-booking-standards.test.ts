import { describe, expect, it } from "vitest";

import {
  BOOKING_STANDARDS_PLATFORM_DEFAULTS,
  type PlatformBookingStandards,
} from "../platform-defaults";
import {
  resolveBookingStandards,
  unmetRequiredStandards,
  type EffectiveBookingStandard,
  type OwnerBookingStandardRows,
} from "../resolve-booking-standards";
import type { BookingStandardField } from "@th/types/repos/booking-standards";

type ItemRow = OwnerBookingStandardRows["items"][number];
type ExampleRow = OwnerBookingStandardRows["examples"][number];

const item = (over: Partial<ItemRow> & Pick<ItemRow, "field" | "label">): ItemRow => ({
  intent: "PERFORM",
  hint: null,
  requirement: "SUGGESTED",
  sortOrder: 0,
  ...over,
});

const example = (over: Partial<ExampleRow> & Pick<ExampleRow, "title">): ExampleRow => ({
  intent: "PERFORM",
  body: `${over.title} body`,
  sortOrder: 0,
  ...over,
});

/** A small, recognisable platform table so assertions don't track copy. */
const PLATFORM: PlatformBookingStandards = {
  PERFORM: {
    items: [
      { field: "LINK_MUSIC", labelKey: "k.perform.music", hintKey: "k.perform.music.hint", requirement: "SUGGESTED" },
    ],
    examples: [
      { titleKey: "k.perform.ex1.title", bodyKey: "k.perform.ex1.body" },
      { titleKey: "k.perform.ex2.title", bodyKey: "k.perform.ex2.body" },
    ],
  },
  RENT: {
    items: [{ field: "PURPOSE", labelKey: "k.rent.purpose", hintKey: null, requirement: "SUGGESTED" }],
    examples: [{ titleKey: "k.rent.ex1.title", bodyKey: "k.rent.ex1.body" }],
  },
  USE: {
    items: [{ field: "PURPOSE", labelKey: "k.use.purpose", hintKey: null, requirement: "SUGGESTED" }],
    examples: [],
  },
};

const PLACE_ROWS: OwnerBookingStandardRows = {
  items: [
    item({ field: "EXPECTED_DRAW", label: "Your usual draw", requirement: "REQUIRED", sortOrder: 1 }),
    item({ field: "LINK_MUSIC", label: "A music link", requirement: "REQUIRED", sortOrder: 0 }),
    item({ intent: "RENT", field: "PURPOSE", label: "What is it", sortOrder: 0 }),
  ],
  examples: [example({ title: "Place example" })],
};

const CALENDAR_ROWS: OwnerBookingStandardRows = {
  items: [
    item({ field: "GENRE", label: "Your genre", hint: "One or two words", sortOrder: 0 }),
  ],
  examples: [],
};

describe("resolveBookingStandards (FR-003)", () => {
  it("calendar rows for the intent win whole — no merge with the place", () => {
    const out = resolveBookingStandards({
      intent: "PERFORM",
      calendarRows: CALENDAR_ROWS,
      placeRows: PLACE_ROWS,
      platformDefaults: PLATFORM,
    });
    expect(out.standards).toEqual([
      {
        source: "calendar",
        field: "GENRE",
        requirement: "SUGGESTED",
        label: "Your genre",
        hint: "One or two words",
      },
    ]);
    expect(out.droppedCount).toBe(0);
  });

  it("no calendar rows → the place's rows, in sortOrder", () => {
    const out = resolveBookingStandards({
      intent: "PERFORM",
      calendarRows: { items: [], examples: [] },
      placeRows: PLACE_ROWS,
      platformDefaults: PLATFORM,
    });
    expect(out.standards).toEqual([
      { source: "place", field: "LINK_MUSIC", requirement: "REQUIRED", label: "A music link", hint: null },
      { source: "place", field: "EXPECTED_DRAW", requirement: "REQUIRED", label: "Your usual draw", hint: null },
    ]);
  });

  it("neither → the platform defaults: KEYS, never a literal label, SUGGESTED", () => {
    const out = resolveBookingStandards({
      intent: "PERFORM",
      calendarRows: null,
      placeRows: undefined,
      platformDefaults: PLATFORM,
    });
    expect(out.standards).toEqual([
      {
        source: "platform",
        field: "LINK_MUSIC",
        requirement: "SUGGESTED",
        labelKey: "k.perform.music",
        hintKey: "k.perform.music.hint",
      },
    ]);
    expect(out.standards[0]).not.toHaveProperty("label");
    expect(out.droppedCount).toBe(0);
  });

  it("falls through PER INTENT: a calendar with PERFORM rows still inherits the place's RENT list", () => {
    const out = resolveBookingStandards({
      intent: "RENT",
      calendarRows: CALENDAR_ROWS,
      placeRows: PLACE_ROWS,
      platformDefaults: PLATFORM,
    });
    expect(out.standards.map((s) => s.source)).toEqual(["place"]);
    const use = resolveBookingStandards({
      intent: "USE",
      calendarRows: CALENDAR_ROWS,
      placeRows: PLACE_ROWS,
      platformDefaults: PLATFORM,
    });
    expect(use.standards.map((s) => s.source)).toEqual(["platform"]);
  });

  describe("a winning level emptied by filtering (review decision 2026-09-25)", () => {
    // The calendar OVERRODE the place, but its only RENT row points at a
    // PERFORM-only field (stale data / a catalogue change).
    const staleCalendar: OwnerBookingStandardRows = {
      items: [item({ intent: "RENT", field: "LINK_MUSIC", label: "stale", requirement: "REQUIRED" })],
      examples: [],
    };
    const placeWithRequired: OwnerBookingStandardRows = {
      items: [item({ intent: "RENT", field: "EXPECTED_ATTENDANCE", label: "Headcount", requirement: "REQUIRED" })],
      examples: [],
    };

    it("falls to the PLATFORM, never back down to the place's REQUIRED items", () => {
      const out = resolveBookingStandards({
        intent: "RENT",
        calendarRows: staleCalendar,
        placeRows: placeWithRequired,
        platformDefaults: PLATFORM,
      });
      expect(out.standards.map((s) => [s.source, s.field])).toEqual([["platform", "PURPOSE"]]);
      expect(unmetRequiredStandards(out.standards, {})).toEqual([]);
    });

    it("reports what it dropped in droppedCount", () => {
      const out = resolveBookingStandards({
        intent: "RENT",
        calendarRows: staleCalendar,
        placeRows: placeWithRequired,
        platformDefaults: PLATFORM,
      });
      expect(out.droppedCount).toBe(1);
    });

    it("a partly stale level keeps its applicable rows and still counts the dropped ones", () => {
      const out = resolveBookingStandards({
        intent: "RENT",
        calendarRows: {
          items: [
            item({ intent: "RENT", field: "LINK_MUSIC", label: "stale", sortOrder: 0 }),
            item({ intent: "RENT", field: "EXPECTED_ATTENDANCE", label: "Headcount", requirement: "REQUIRED", sortOrder: 1 }),
            // A field a NEWER API knows and this bundle does not.
            item({ intent: "RENT", field: "STAGE_PLOT" as BookingStandardField, label: "future", sortOrder: 2 }),
          ],
          examples: [],
        },
        placeRows: placeWithRequired,
        platformDefaults: PLATFORM,
      });
      expect(out.standards.map((s) => [s.source, s.field])).toEqual([["calendar", "EXPECTED_ATTENDANCE"]]);
      expect(out.droppedCount).toBe(2);
    });

    it("only the WINNING level's drops count (the place is not consulted)", () => {
      const out = resolveBookingStandards({
        intent: "PERFORM",
        calendarRows: CALENDAR_ROWS,
        placeRows: {
          items: [item({ field: "PURPOSE", label: "stale on the place" })],
          examples: [],
        },
        platformDefaults: PLATFORM,
      });
      expect(out.droppedCount).toBe(0);
    });
  });

  it("a stored REQUIRED on a field that cannot be required reads as SUGGESTED", () => {
    const out = resolveBookingStandards({
      intent: "PERFORM",
      placeRows: {
        items: [
          item({ field: "MESSAGE", label: "Tell us about you", requirement: "REQUIRED", sortOrder: 0 }),
          item({ field: "CUSTOM", label: "No covers", requirement: "REQUIRED", sortOrder: 1 }),
          item({ field: "LINK_EPK", label: "Your EPK", requirement: "REQUIRED", sortOrder: 2 }),
        ],
        examples: [],
      },
      platformDefaults: PLATFORM,
    });
    expect(out.standards.map((s) => [s.field, s.requirement])).toEqual([
      ["MESSAGE", "SUGGESTED"],
      ["CUSTOM", "SUGGESTED"],
      ["LINK_EPK", "REQUIRED"],
    ]);
  });

  describe("examples", () => {
    it("are ADDITIVE: venue examples (literal) first, then the platform's (keys)", () => {
      const out = resolveBookingStandards({
        intent: "PERFORM",
        calendarRows: {
          items: [],
          examples: [
            example({ title: "Cal second", sortOrder: 1 }),
            example({ title: "Cal first", sortOrder: 0 }),
          ],
        },
        placeRows: PLACE_ROWS,
        platformDefaults: PLATFORM,
      });
      expect(out.examples).toEqual([
        { source: "calendar", title: "Cal first", body: "Cal first body" },
        { source: "calendar", title: "Cal second", body: "Cal second body" },
        { source: "platform", titleKey: "k.perform.ex1.title", bodyKey: "k.perform.ex1.body" },
        { source: "platform", titleKey: "k.perform.ex2.title", bodyKey: "k.perform.ex2.body" },
      ]);
    });

    it("fall through calendar → place independently of the items", () => {
      const out = resolveBookingStandards({
        intent: "PERFORM",
        calendarRows: CALENDAR_ROWS,
        placeRows: PLACE_ROWS,
        platformDefaults: PLATFORM,
      });
      expect(out.standards.map((s) => s.source)).toEqual(["calendar"]);
      expect(out.examples.map((e) => e.source)).toEqual(["place", "platform", "platform"]);
      expect(out.examples[0]).toEqual({
        source: "place",
        title: "Place example",
        body: "Place example body",
      });
    });

    it("are scoped to the intent", () => {
      const out = resolveBookingStandards({
        intent: "RENT",
        calendarRows: null,
        placeRows: PLACE_ROWS, // its only example is PERFORM
        platformDefaults: PLATFORM,
      });
      expect(out.examples).toEqual([
        { source: "platform", titleKey: "k.rent.ex1.title", bodyKey: "k.rent.ex1.body" },
      ]);
    });
  });

  it("defaults to the shipped platform table", () => {
    const out = resolveBookingStandards({ intent: "PERFORM" });
    expect(out.standards).toHaveLength(
      BOOKING_STANDARDS_PLATFORM_DEFAULTS.PERFORM.items.length,
    );
    expect(out.examples).toHaveLength(2);
    expect(out.standards.every((s) => s.source === "platform")).toBe(true);
  });

  it("does not mutate its inputs", () => {
    const rows: OwnerBookingStandardRows = {
      items: [
        item({ field: "GENRE", label: "b", sortOrder: 1 }),
        item({ field: "FEE", label: "a", sortOrder: 0 }),
      ],
      examples: [],
    };
    resolveBookingStandards({ intent: "PERFORM", placeRows: rows, platformDefaults: PLATFORM });
    expect(rows.items.map((r) => r.label)).toEqual(["b", "a"]);
  });
});

describe("unmetRequiredStandards", () => {
  const standards = resolveBookingStandards({
    intent: "PERFORM",
    placeRows: {
      items: [
        item({ field: "LINK_MUSIC", label: "A music link", requirement: "REQUIRED", sortOrder: 0 }),
        item({ field: "EXPECTED_DRAW", label: "Your draw", requirement: "REQUIRED", sortOrder: 1 }),
        item({ field: "BILL", label: "Name the other acts", requirement: "REQUIRED", sortOrder: 2 }),
        item({ field: "GENRE", label: "Genre", requirement: "SUGGESTED", sortOrder: 3 }),
        item({ field: "CUSTOM", label: "No covers", requirement: "SUGGESTED", sortOrder: 4 }),
      ],
      examples: [],
    },
    platformDefaults: PLATFORM,
  }).standards;

  it("lists the REQUIRED venue items the payload misses, in order, with the venue's label", () => {
    expect(
      unmetRequiredStandards(standards, { message: "Hello there, we play." }).map(
        (s) => [s.source, s.field, s.label],
      ),
    ).toEqual([
      ["place", "LINK_MUSIC", "A music link"],
      ["place", "EXPECTED_DRAW", "Your draw"],
      ["place", "BILL", "Name the other acts"],
    ]);
  });

  it("the sender alone does not meet a REQUIRED bill; another act does", () => {
    const met = { linkMusic: "https://m.example", expectedDraw: 30 };
    expect(
      unmetRequiredStandards(standards, { ...met, bill: { includeSelf: true, acts: [] } }).map(
        (s) => s.field,
      ),
    ).toEqual(["BILL"]);
    expect(
      unmetRequiredStandards(standards, {
        ...met,
        bill: { includeSelf: true, acts: [{ kind: "external", name: "Opener" }] },
      }),
    ).toEqual([]);
  });

  it("never returns a field that cannot be required, even if it reads REQUIRED", () => {
    const venue = (field: BookingStandardField): EffectiveBookingStandard => ({
      source: "place",
      field,
      requirement: "REQUIRED",
      label: field,
      hint: null,
    });
    expect(
      unmetRequiredStandards(
        [venue("CUSTOM"), venue("MESSAGE"), venue("PURPOSE"), venue("STAGE_PLOT" as BookingStandardField)],
        {},
      ),
    ).toEqual([]);
  });

  it("NFR-002: the shipped platform defaults block nothing, for any intent, on an empty payload", () => {
    for (const intent of ["PERFORM", "RENT", "USE"] as const) {
      const resolved = resolveBookingStandards({ intent });
      expect(unmetRequiredStandards(resolved.standards, {})).toEqual([]);
    }
  });
});
