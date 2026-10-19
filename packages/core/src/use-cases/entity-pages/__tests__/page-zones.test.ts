import { describe, expect, it } from "vitest";

import {
  getPaletteBlockConfigs,
  getValidBlockKinds,
  isPinnedBlockKind,
} from "../block-config";
import { PAGE_TEMPLATES } from "../page-templates";
import {
  PAGE_ZONE_LAYOUTS,
  canPlace,
  insertionIndexFor,
  lockOf,
  moveRange,
  paletteGroupOf,
  resolvePageZoneLayout,
  sortByZone,
  zoneOf,
  type PageZoneLayout,
} from "../page-zones";

const standard = resolvePageZoneLayout("PLACE", "standard")!;

const kinds = (...list: string[]) => list.map((kind) => ({ kind }));

describe("venue standard layout table (R3)", () => {
  it("exists for PLACE standard only in this phase", () => {
    expect(standard).not.toBeNull();
    expect(resolvePageZoneLayout("PLACE", "grid")).toBeNull();
    expect(resolvePageZoneLayout("ORGANIZATION", "standard")).toBeNull();
    expect(PAGE_ZONE_LAYOUTS.PLACE?.standard).toBe(standard);
  });

  it("zones: upcoming leads, About then Photos fixed first, rest free, Booking fixed last", () => {
    expect(
      standard.zones.map((zone) => [
        zone.id,
        zone.kinds,
        zone.movable,
        zone.lock,
      ]),
    ).toEqual([
      ["upcoming", [], false, "leads"],
      ["lead", ["about", "photos"], false, "fixed_first"],
      ["free", "rest", true, undefined],
      ["tail", ["booking_info"], false, "fixed_last"],
    ]);
  });

  it("places every PLACE kind somewhere, and no kind in two places", () => {
    for (const kind of getValidBlockKinds("PLACE")) {
      expect(zoneOf(kind, standard).where, kind).not.toBe("none");
    }
    const explicit = standard.zones.flatMap((zone) =>
      zone.kinds === "rest" ? [] : [...zone.kinds],
    );
    const elsewhere = Object.keys(standard.elsewhere);
    expect(new Set([...explicit, ...elsewhere]).size).toBe(
      explicit.length + elsewhere.length,
    );
  });

  it("reports why a section is locked", () => {
    expect(lockOf("about", standard)).toBe("fixed_first");
    expect(lockOf("photos", standard)).toBe("fixed_first");
    expect(lockOf("booking_info", standard)).toBe("fixed_last");
    expect(lockOf("amenities", standard)).toBeNull();
    expect(lockOf("track_record", standard)).toBeNull();
  });

  it("groups the palette as FR-010 does", () => {
    expect(paletteGroupOf("faq", standard)).toBe("moves_freely");
    expect(paletteGroupOf("about", standard)).toBe("fixed_spot");
    expect(paletteGroupOf("booking_info", standard)).toBe("fixed_spot");
    expect(paletteGroupOf("links", standard)).toBe("elsewhere");
    expect(paletteGroupOf("request_to_play", standard)).toBe("elsewhere");
    expect(paletteGroupOf("upcoming_events", standard)).toBe("elsewhere");
  });
});

describe("canPlace: moves (R3)", () => {
  it("accepts the template order", () => {
    expect(
      canPlace(
        [
          "about",
          "photos",
          "capacity_info",
          "house_rules",
          "amenities",
          "tech_specs",
          "track_record",
          "booking_info",
        ],
        standard,
      ),
    ).toEqual({ ok: true });
  });

  it("lets free kinds reorder among themselves (including the pinned track_record)", () => {
    expect(
      canPlace(
        ["about", "photos", "track_record", "faq", "amenities", "booking_info"],
        standard,
      ).ok,
    ).toBe(true);
    expect(
      canPlace(
        ["about", "photos", "amenities", "faq", "track_record", "booking_info"],
        standard,
      ).ok,
    ).toBe(true);
  });

  it("refuses About below Photos", () => {
    expect(canPlace(["photos", "about", "faq"], standard)).toEqual({
      ok: false,
      reason: "zone_order",
      index: 1,
      kind: "about",
      after: "photos",
      lock: "fixed_first",
    });
  });

  it("refuses a free kind above About or Photos", () => {
    expect(canPlace(["faq", "about", "photos"], standard)).toMatchObject({
      ok: false,
      reason: "zone_order",
      kind: "about",
      after: "faq",
      lock: "fixed_first",
    });
    expect(canPlace(["about", "faq", "photos"], standard)).toMatchObject({
      ok: false,
      kind: "photos",
      lock: "fixed_first",
    });
  });

  it("refuses Booking info above any other section", () => {
    expect(canPlace(["about", "booking_info", "faq"], standard)).toEqual({
      ok: false,
      reason: "zone_order",
      index: 2,
      kind: "faq",
      after: "booking_info",
      lock: "fixed_last",
    });
  });

  it("skips kinds rendered elsewhere, wherever they sit", () => {
    expect(
      canPlace(
        [
          "links",
          "about",
          "location_map",
          "photos",
          "request_to_play",
          "faq",
          "upcoming_events",
          "booking_info",
          "links",
        ],
        standard,
      ),
    ).toEqual({ ok: true });
  });

  it("refuses a kind the layout has no place for", () => {
    const noRest: PageZoneLayout = {
      key: "test.norest",
      zones: [{ id: "only", kinds: ["about"], movable: true }],
      elsewhere: {},
    };
    expect(canPlace(["about", "faq"], noRest)).toEqual({
      ok: false,
      reason: "not_on_layout",
      index: 1,
      kind: "faq",
    });
    expect(insertionIndexFor("faq", kinds("about"), noRest)).toBeNull();
  });
});

describe("insertionIndexFor: adds (R3: a new block lands in its zone)", () => {
  const page = kinds(
    "about",
    "photos",
    "amenities",
    "tech_specs",
    "booking_info",
  );

  it("lands a free kind at the end of the free zone, above Booking info", () => {
    expect(insertionIndexFor("faq", page, standard)).toBe(4);
  });

  it("lands About before Photos and Photos after About", () => {
    expect(insertionIndexFor("about", kinds("photos", "faq"), standard)).toBe(
      0,
    );
    expect(insertionIndexFor("photos", kinds("about", "faq"), standard)).toBe(
      1,
    );
    expect(insertionIndexFor("photos", page, standard)).toBe(2);
  });

  it("lands Booking info last", () => {
    expect(
      insertionIndexFor("booking_info", kinds("about", "faq"), standard),
    ).toBe(2);
  });

  it("lands a pinned kind in the free zone like any free kind", () => {
    expect(isPinnedBlockKind("track_record")).toBe(true);
    expect(insertionIndexFor("track_record", page, standard)).toBe(4);
  });

  it("lands a kind rendered elsewhere at the end", () => {
    expect(insertionIndexFor("links", page, standard)).toBe(page.length);
  });

  it("always produces an order canPlace accepts", () => {
    for (const kind of getValidBlockKinds("PLACE")) {
      const at = insertionIndexFor(kind, page, standard)!;
      const next = [...page.slice(0, at), { kind }, ...page.slice(at)];
      expect(
        canPlace(
          next.map((block) => block.kind),
          standard,
        ).ok,
        kind,
      ).toBe(true);
    }
  });

  it("works on an empty page", () => {
    expect(insertionIndexFor("faq", [], standard)).toBe(0);
  });
});

describe("moveRange (Move up / Move down, drop targets)", () => {
  const order = [
    "about",
    "photos",
    "capacity_info",
    "amenities",
    "faq",
    "booking_info",
  ];

  it("a free block moves anywhere inside the free zone", () => {
    expect(moveRange(order, 3, standard)).toEqual({
      min: 2,
      max: 4,
      lock: null,
    });
  });

  it("a fixed block cannot move, and says why", () => {
    expect(moveRange(order, 0, standard)).toEqual({
      min: 0,
      max: 0,
      lock: "fixed_first",
    });
    expect(moveRange(order, 5, standard)).toEqual({
      min: 5,
      max: 5,
      lock: "fixed_last",
    });
  });
});

describe("sortByZone (the BLOCK_PRIORITY sort)", () => {
  it("matches PlaceEntityLayout's priority sort: about 10, photos 20, default 500, booking 1000, stable", () => {
    const stored = [
      { id: "1", kind: "booking_info" },
      { id: "2", kind: "amenities" },
      { id: "3", kind: "photos" },
      { id: "4", kind: "house_rules" },
      { id: "5", kind: "about" },
      { id: "6", kind: "capacity_info" },
    ];
    expect(sortByZone(stored, standard).map((block) => block.id)).toEqual([
      "5",
      "3",
      "2",
      "4",
      "6",
      "1",
    ]);
  });

  it("puts kinds rendered elsewhere last, and sorts the rest exactly as BLOCK_PRIORITY does", () => {
    // A copy of PlaceEntityLayout's sort (apps/web), the behaviour the zone
    // table must reproduce for the blocks the main column renders.
    const BLOCK_PRIORITY: Record<string, number> = {
      about: 10,
      photos: 20,
      booking_info: 1000,
    };
    const prioritySort = <T extends { kind: string }>(list: readonly T[]) =>
      list
        .map((block, position) => ({ block, position }))
        .sort(
          (a, b) =>
            (BLOCK_PRIORITY[a.block.kind] ?? 500) -
              (BLOCK_PRIORITY[b.block.kind] ?? 500) || a.position - b.position,
        )
        .map(({ block }) => block);

    const elsewhereKinds = new Set([
      "links",
      "location_map",
      "request_to_play",
    ]);
    const stored = [
      { id: "1", kind: "links" },
      { id: "2", kind: "booking_info" },
      { id: "3", kind: "amenities" },
      { id: "4", kind: "request_to_play" },
      { id: "5", kind: "photos" },
      { id: "6", kind: "faq" },
      { id: "7", kind: "location_map" },
      { id: "8", kind: "about" },
      { id: "9", kind: "tech_specs" },
    ];
    const sorted = sortByZone(stored, standard);
    const tail = sorted.slice(-elsewhereKinds.size);
    const head = sorted.slice(0, -elsewhereKinds.size);

    // Elsewhere kinds last, in their stored order.
    expect(tail.map((block) => block.id)).toEqual(["1", "4", "7"]);
    // The rest matches the priority sort of the same blocks.
    const mainColumn = stored.filter(
      (block) => !elsewhereKinds.has(block.kind),
    );
    expect(head.map((block) => block.id)).toEqual(
      prioritySort(mainColumn).map((block) => block.id),
    );
    expect(head.map((block) => block.id)).toEqual([
      "8",
      "5",
      "3",
      "6",
      "9",
      "2",
    ]);
  });
});

describe("R19: the table decides, not code", () => {
  // Table-driven: each row is (order, layout, ok). The same functions give
  // different answers only because the table differs.
  const freeform: PageZoneLayout = {
    key: "test.freeform",
    zones: [{ id: "canvas", kinds: "rest", movable: true }],
    elsewhere: {},
  };
  const swappedTail: PageZoneLayout = {
    key: "test.swapped",
    zones: [
      {
        id: "lead",
        kinds: ["booking_info"],
        movable: false,
        lock: "fixed_first",
      },
      { id: "free", kinds: "rest", movable: true },
      { id: "tail", kinds: ["about"], movable: false, lock: "fixed_last" },
    ],
    elsewhere: {},
  };
  const rows: Array<[string[], PageZoneLayout, boolean]> = [
    [["booking_info", "faq", "about"], standard, false],
    [["booking_info", "faq", "about"], swappedTail, true],
    [["booking_info", "faq", "about"], freeform, true],
    [["photos", "about"], standard, false],
    [["photos", "about"], freeform, true],
    [["about", "photos", "faq", "booking_info"], swappedTail, false],
  ];

  it.each(rows)("%j on %s", (order, layout, ok) => {
    expect(canPlace(order, layout).ok).toBe(ok);
  });

  it("a layout with no fixed zones allows every order, move and add", () => {
    const placeKinds = [...getValidBlockKinds("PLACE")];
    expect(canPlace(placeKinds, freeform)).toEqual({ ok: true });
    expect(canPlace([...placeKinds].reverse(), freeform)).toEqual({ ok: true });
    for (const kind of placeKinds) {
      expect(lockOf(kind, freeform)).toBeNull();
      expect(paletteGroupOf(kind, freeform)).toBe("moves_freely");
      // A new block lands at the end; nothing is skipped.
      expect(
        insertionIndexFor(kind, kinds("booking_info", "about"), freeform),
      ).toBe(2);
    }
    expect(moveRange(["booking_info", "faq", "about"], 0, freeform)).toEqual({
      min: 0,
      max: 2,
      lock: null,
    });
  });
});

describe("resident_artists is out of the palette (FR-010)", () => {
  it("is no longer offered to PLACE, but stays a valid kind", () => {
    expect(
      getPaletteBlockConfigs("PLACE").map((config) => config.kind),
    ).not.toContain("resident_artists");
    expect(getValidBlockKinds("PLACE")).toContain("resident_artists");
    // Retired, not palette:false: no template seeds it either.
    expect(
      Object.values(PAGE_TEMPLATES).flatMap((specs) =>
        specs.map((spec) => spec.kind),
      ),
    ).not.toContain("resident_artists");
  });
});
