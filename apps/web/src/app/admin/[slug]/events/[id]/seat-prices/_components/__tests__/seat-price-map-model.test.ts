import { describe, expect, it } from "vitest";

import {
  seatPriceRead,
  seatRead,
  sectionRead,
} from "../__fixtures__/seat-price-read";
import {
  SeatGlyphFileError,
  approximateMapSeats,
  glyphFileKey,
  isSeatGlyph,
  nextSeatInDirection,
  pickMapLayoutId,
  readSeatGlyphFile,
  rectFromPoints,
  resolveMapSeats,
  seatLabelFor,
  selectableSeatIdsIn,
  type SeatGlyph,
} from "../seat-price-map-model";
import { buildSeatPriceModel } from "../seat-price-model";

const LAYOUT = "layout-1";

const glyph = (
  sectionId: string,
  seatId: string,
  x: number,
  y = 0,
): SeatGlyph => ({ sectionId, seatId, label: seatId, position: { x, y } });

/**
 * Layout sections `A` and `A-B`. A layout that joins section, row and seat
 * with "-" gives BOTH a glyph keyed `A-B-C-1`: section `A`, row `B-C`, seat 1;
 * and section `A-B`, row `C`, seat 1.
 */
function collidingModel() {
  return buildSeatPriceModel(
    seatPriceRead({
      sections: [
        sectionRead({
          seatSectionId: "event-section-a",
          name: "A",
          layoutSectionId: "A",
          placeLayoutId: LAYOUT,
          seats: [
            seatRead({ id: "seat-in-a", label: "B-C1", row: "B-C", number: 1, glyphKey: "A-B-C-1" }),
            seatRead({ id: "sold-in-a", label: "B-C2", row: "B-C", number: 2, glyphKey: "A-B-C-2", status: "SOLD" }),
          ],
        }),
        sectionRead({
          seatSectionId: "event-section-ab",
          name: "A-B",
          layoutSectionId: "A-B",
          placeLayoutId: LAYOUT,
          seats: [
            seatRead({ id: "seat-in-ab", label: "C1", row: "C", number: 1, glyphKey: "A-B-C-1" }),
          ],
        }),
      ],
    }),
  );
}

describe("resolveMapSeats", () => {
  it("resolves the same glyph key to a different seat in each section", () => {
    const seats = resolveMapSeats(
      collidingModel(),
      LAYOUT,
      [glyph("A", "A-B-C-1", 0), glyph("A-B", "A-B-C-1", 50)],
    );
    expect(seats.map((s) => [s.glyph.sectionId, s.seat?.id, s.section?.id])).toEqual([
      ["A", "seat-in-a", "event-section-a"],
      ["A-B", "seat-in-ab", "event-section-ab"],
    ]);
    expect(new Set(seats.map((s) => s.key)).size).toBe(2);
  });

  it("does not find a seat of another section by its glyph key", () => {
    // `A-B-C-2` exists only in section A. Drawn in A-B, it matches nothing.
    const [seat] = resolveMapSeats(
      collidingModel(),
      LAYOUT,
      [glyph("A-B", "A-B-C-2", 0)],
    );
    expect(seat!.seat).toBeNull();
    expect(seat!.section?.id).toBe("event-section-ab");
  });

  it("leaves a glyph of a section the event does not use unmatched", () => {
    const [seat] = resolveMapSeats(
      collidingModel(),
      LAYOUT,
      [glyph("Z", "A-B-C-1", 0)],
    );
    expect(seat!.seat).toBeNull();
    expect(seat!.section).toBeNull();
  });

  it("ignores sections that sit on another layout", () => {
    const [seat] = resolveMapSeats(
      collidingModel(),
      "other-layout",
      [glyph("A", "A-B-C-1", 0)],
    );
    expect(seat!.seat).toBeNull();
  });
});

describe("selectableSeatIdsIn", () => {
  it("takes only the selectable seats whose centre is inside the box", () => {
    const seats = resolveMapSeats(
      collidingModel(),
      LAYOUT,
      [
        glyph("A", "A-B-C-1", 0),
        glyph("A", "A-B-C-2", 10), // sold
        glyph("A-B", "A-B-C-1", 100), // outside
        glyph("Z", "nothing", 5), // unmatched
      ],
    );
    const box = rectFromPoints({ x: 20, y: 5 }, { x: -5, y: -5 });
    expect(seats[1]!.seat?.id).toBe("sold-in-a");
    expect(seats[1]!.seat?.selectable).toBe(false);
    expect(selectableSeatIdsIn(seats, box)).toEqual(["seat-in-a"]);
  });
});

describe("nextSeatInDirection", () => {
  it("moves to the nearest seat in line with the arrow, null at the edge", () => {
    const seats = resolveMapSeats(
      collidingModel(),
      LAYOUT,
      [glyph("A", "A-B-C-1", 0), glyph("A", "A-B-C-2", 30), glyph("A-B", "A-B-C-1", 30, 40)],
    );
    expect(nextSeatInDirection(seats, seats[0]!, "ArrowRight")?.key).toBe("sold-in-a");
    expect(nextSeatInDirection(seats, seats[1]!, "ArrowDown")?.key).toBe("seat-in-ab");
    expect(nextSeatInDirection(seats, seats[0]!, "ArrowLeft")).toBeNull();
  });

  it("passes over a glyph that is not a seat of this event", () => {
    const seats = resolveMapSeats(
      collidingModel(),
      LAYOUT,
      [
        glyph("A", "A-B-C-1", 0),
        glyph("Z", "nothing", 10), // nearer, but no event seat
        glyph("A", "A-B-C-2", 30),
      ],
    );
    expect(seats[1]!.seat).toBeNull();
    expect(nextSeatInDirection(seats, seats[0]!, "ArrowRight")?.key).toBe("sold-in-a");
  });
});

describe("isSeatGlyph", () => {
  it("keeps entries the map can draw and drops the rest", () => {
    const good = { seatId: "s", sectionId: "A", label: "A1", position: { x: 1, y: 2 } };
    expect(isSeatGlyph(good)).toBe(true);
    expect(isSeatGlyph({ ...good, radius: 4 })).toBe(true);
    expect(isSeatGlyph(null)).toBe(false);
    expect(isSeatGlyph({ ...good, label: 5 })).toBe(false);
    expect(isSeatGlyph({ ...good, position: null })).toBe(false);
    expect(isSeatGlyph({ ...good, position: { x: "1", y: 2 } })).toBe(false);
    expect(isSeatGlyph({ ...good, radius: "big" })).toBe(false);
  });
});

describe("pickMapLayoutId", () => {
  it("is the layout of the seated sections, or null without one", () => {
    expect(pickMapLayoutId(collidingModel())).toBe(LAYOUT);
    const noLayout = buildSeatPriceModel(
      seatPriceRead({ sections: [sectionRead({ seats: [seatRead()] })] }),
    );
    expect(pickMapLayoutId(noLayout)).toBeNull();
  });

  it("takes sections of any other layout off the map", () => {
    const model = buildSeatPriceModel(
      seatPriceRead({
        sections: [
          sectionRead({ seatSectionId: "main-1", layoutSectionId: "A", placeLayoutId: LAYOUT, seats: [seatRead()] }),
          sectionRead({ seatSectionId: "main-2", layoutSectionId: "B", placeLayoutId: LAYOUT, seats: [seatRead()] }),
          sectionRead({ seatSectionId: "annex", layoutSectionId: "A", placeLayoutId: "other-layout", seats: [seatRead()] }),
        ],
      }),
    );
    expect(pickMapLayoutId(model)).toBe(LAYOUT);
    expect(model.sectionsById.get("main-1")!.onMap).toBe(true);
    expect(model.sectionsById.get("annex")!.onMap).toBe(false);
  });
});

describe("seatLabelFor", () => {
  const maxLen = { full: 3, digits: 2 };
  it("drops, shortens or keeps the label by on-screen size", () => {
    expect(seatLabelFor("P12", 10, 0.5, maxLen).text).toBe("");
    expect(seatLabelFor("P12", 10, 1, maxLen).text).toBe("12");
    expect(seatLabelFor("P12", 10, 2, maxLen).text).toBe("P12");
  });
});

describe("approximateMapSeats", () => {
  it("lays each section's own seats in rows inside its outline", () => {
    const seats = approximateMapSeats(collidingModel(), LAYOUT, [
      {
        sectionId: "A",
        label: "A",
        color: null,
        capacity: 2,
        geometry: { polygons: [[{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 }, { x: 0, y: 40 }]] },
        stageAnchor: null,
      },
      // A-B has no outline or origin: left off the map.
      { sectionId: "A-B", label: "A-B", color: null, capacity: 1, geometry: null, stageAnchor: null },
    ]);
    expect(seats.map((s) => s.seat?.id)).toEqual(["seat-in-a", "sold-in-a"]);
    for (const seat of seats) expect(seat.key).toBe(seat.seat!.id);
    for (const { glyph } of seats) {
      expect(glyph.position.x).toBeGreaterThan(0);
      expect(glyph.position.x).toBeLessThan(100);
      expect(glyph.position.y).toBeGreaterThan(0);
      expect(glyph.position.y).toBeLessThan(40);
    }
  });
});

describe("readSeatGlyphFile", () => {
  const good = { seatId: "s", sectionId: "A", label: "A1", position: { x: 1, y: 2 } };
  it("reads a list or a { glyphs } object, dropping unreadable entries", () => {
    expect(readSeatGlyphFile([good, { nope: 1 }])).toEqual([good]);
    expect(readSeatGlyphFile({ glyphs: [good] })).toEqual([good]);
    expect(readSeatGlyphFile([])).toEqual([]);
  });
  it("throws for a file that is not a list, or whose entries are all unreadable", () => {
    expect(() => readSeatGlyphFile({ seats: [] })).toThrow(SeatGlyphFileError);
    try {
      readSeatGlyphFile([{ a: 1 }, { b: 2 }, null]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SeatGlyphFileError);
      expect((error as SeatGlyphFileError).entries).toBe(3);
    }
  });
});

describe("glyphFileKey", () => {
  it("is the same for two signatures of one file, different for another file", () => {
    const a = "https://s.example.com/l/place/abc.json?X-Goog-Signature=1";
    const b = "https://s.example.com/l/place/abc.json?X-Goog-Signature=2";
    const c = "https://s.example.com/l/place/def.json?X-Goog-Signature=1";
    expect(glyphFileKey(a)).toBe(glyphFileKey(b));
    expect(glyphFileKey(a)).not.toBe(glyphFileKey(c));
    expect(glyphFileKey(a)).not.toContain("Signature");
  });
});
