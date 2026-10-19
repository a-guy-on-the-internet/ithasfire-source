import { describe, expect, it } from "vitest";

import {
  parsePlaceLayoutCsv,
  serializePlaceLayoutCsv,
} from "../parse-place-layout-csv";

// ── Helpers ──────────────────────────────────────────────────────────────

/** Build a minimal valid CSV with the given seat rows. */
function csv(seatRows: string[], directives: string[] = []): string {
  const header = "section,row,seat,x,y,rotation,width,height,tier,notes";
  return [...directives, header, ...seatRows].join("\n");
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("parsePlaceLayoutCsv", () => {
  // ── Happy path ───────────────────────────────────────────────────────

  it("parses a minimal valid CSV into glyphs and sections", () => {
    const input = csv([
      "Floor,A,1,10,20,0,,,general,",
      "Floor,A,2,15,20,0,,,general,",
      "Balcony,B,1,50,100,45,2,2,vip,corner seat",
    ]);

    const result = parsePlaceLayoutCsv(input);

    expect(result.glyphs).toHaveLength(3);
    expect(result.sections).toHaveLength(2);
    expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);

    // Verify glyph structure
    const first = result.glyphs[0]!;
    expect(first.seatId).toBe("Floor-A-1");
    expect(first.sectionId).toBe("Floor");
    expect(first.label).toBe("A1");
    expect(first.position).toEqual({ x: 10, y: 20 });
    expect(first.radius).toBe(4); // default when no width/height

    // Verify glyph with explicit dimensions
    const third = result.glyphs[2]!;
    expect(third.seatId).toBe("Balcony-B-1");
    expect(third.width).toBe(2);
    expect(third.height).toBe(2);
    expect(third.rotationDeg).toBe(45);
    expect(third.radius).toBeUndefined(); // no default when width/height present
    expect(third.metadata).toEqual({ tier: "vip", notes: "corner seat" });
  });

  it("builds sections with correct capacity from seat rows", () => {
    const input = csv([
      "Floor,A,1,0,0,,,,,",
      "Floor,A,2,5,0,,,,,",
      "Floor,B,1,0,5,,,,,",
      "Balcony,C,1,0,50,,,,,",
    ]);

    const result = parsePlaceLayoutCsv(input);
    const floor = result.sections.find((s) => s.sectionId === "Floor");
    const balcony = result.sections.find((s) => s.sectionId === "Balcony");

    expect(floor?.capacity).toBe(3);
    expect(balcony?.capacity).toBe(1);
  });

  it("preserves unknown columns in glyph metadata", () => {
    const header =
      "section,row,seat,x,y,rotation,width,height,tier,notes,accessible,companion";
    const row = "Floor,A,1,10,20,0,,,general,,true,Floor-A-2";
    const input = [header, row].join("\n");

    const result = parsePlaceLayoutCsv(input);

    expect(result.glyphs[0]!.metadata).toEqual({
      tier: "general",
      accessible: true,
      companion: "Floor-A-2",
    });
    expect(
      result.issues.find((i) => i.code === "unknown_columns"),
    ).toBeTruthy();
  });

  // ── Section directives ───────────────────────────────────────────────

  it("parses #section directives with polygon geometry", () => {
    const input = csv(
      ["Floor,A,1,10,20,,,,,"],
      ['#section,Floor,#4A90D2,polygon,"0 0,100 0,100 50,0 50"'],
    );

    const result = parsePlaceLayoutCsv(input);
    const floor = result.sections.find((s) => s.sectionId === "Floor");

    expect(floor?.color).toBe("#4A90D2");
    expect(floor?.geometry?.polygons).toHaveLength(1);
    expect(floor?.geometry?.polygons![0]).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
      { x: 0, y: 50 },
    ]);
  });

  it("merges multiple #section polygon directives for the same section", () => {
    const input = csv(
      ["Floor,A,1,10,20,,,,,"],
      [
        '#section,Floor,#4A90D2,polygon,"0 0,100 0,100 50,0 50"',
        '#section,Floor,,polygon,"200 0,300 0,300 50,200 50"',
      ],
    );

    const result = parsePlaceLayoutCsv(input);
    const floor = result.sections.find((s) => s.sectionId === "Floor");

    expect(floor?.geometry?.polygons).toHaveLength(2);
    expect(floor?.color).toBe("#4A90D2"); // Color from first directive
  });

  // ── Stage directives ─────────────────────────────────────────────────

  it("parses #stage directive", () => {
    const input = csv(
      ["Floor,A,1,10,20,,,,,"],
      ["#stage,rectangle,Main Stage,0,0,200,40"],
    );

    const result = parsePlaceLayoutCsv(input);

    expect(result.stage).toEqual({
      kind: "rectangle",
      label: "Main Stage",
      bounds: { minX: 0, minY: 0, maxX: 200, maxY: 40 },
    });
  });

  it("uses null label when stage label is empty", () => {
    const input = csv(
      ["Floor,A,1,10,20,,,,,"],
      ["#stage,circle,,50,50,150,150"],
    );

    const result = parsePlaceLayoutCsv(input);
    expect(result.stage?.label).toBeNull();
    expect(result.stage?.kind).toBe("circle");
  });

  // ── Error handling ───────────────────────────────────────────────────

  it("returns error issue for empty input", () => {
    const result = parsePlaceLayoutCsv("");

    expect(result.glyphs).toHaveLength(0);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.code).toBe("empty_input");
    expect(result.issues[0]!.severity).toBe("error");
  });

  it("returns error issue for whitespace-only input", () => {
    const result = parsePlaceLayoutCsv("   \n  \n  ");

    expect(result.glyphs).toHaveLength(0);
    expect(result.issues[0]!.code).toBe("empty_input");
  });

  it("returns error when required columns are missing", () => {
    const input = "name,x,y\nFloor,10,20";

    const result = parsePlaceLayoutCsv(input);

    expect(result.glyphs).toHaveLength(0);
    const missingIssue = result.issues.find(
      (i) => i.code === "missing_columns",
    );
    expect(missingIssue).toBeTruthy();
    expect(missingIssue!.severity).toBe("error");
    expect((missingIssue!.details as any).missingColumns).toContain("section");
    expect((missingIssue!.details as any).missingColumns).toContain("row");
    expect((missingIssue!.details as any).missingColumns).toContain("seat");
  });

  it("skips rows with missing required field values", () => {
    const input = csv([
      "Floor,A,1,10,20,,,,,",
      ",A,2,15,20,,,,,", // missing section
      "Floor,,3,20,20,,,,,", // missing row
      "Floor,A,,25,20,,,,,", // missing seat
      "Floor,A,4,30,20,,,,,",
    ]);

    const result = parsePlaceLayoutCsv(input);

    expect(result.glyphs).toHaveLength(2); // Only rows 1 and 5
    expect(
      result.issues.filter((i) => i.code === "missing_required_field"),
    ).toHaveLength(3);
  });

  it("skips rows with invalid coordinates", () => {
    const input = csv([
      "Floor,A,1,10,20,,,,,",
      "Floor,A,2,abc,20,,,,,",
      "Floor,A,3,10,xyz,,,,,",
      "Floor,A,4,30,20,,,,,",
    ]);

    const result = parsePlaceLayoutCsv(input);

    expect(result.glyphs).toHaveLength(2);
    expect(
      result.issues.filter((i) => i.code === "invalid_coordinates"),
    ).toHaveLength(2);
  });

  it("reports duplicate seat IDs", () => {
    const input = csv([
      "Floor,A,1,10,20,,,,,",
      "Floor,A,1,15,20,,,,,", // duplicate
      "Floor,A,2,20,20,,,,,",
    ]);

    const result = parsePlaceLayoutCsv(input);

    expect(result.glyphs).toHaveLength(2); // First occurrence + A2
    expect(
      result.issues.find((i) => i.code === "duplicate_seat_id"),
    ).toBeTruthy();
  });

  it("enforces maxSeats limit", () => {
    const rows = Array.from(
      { length: 10 },
      (_, i) => `Floor,A,${i + 1},${i * 5},0,,,,,`,
    );
    const input = csv(rows);

    const result = parsePlaceLayoutCsv(input, { maxSeats: 5 });

    expect(result.glyphs).toHaveLength(5);
    expect(
      result.issues.find((i) => i.code === "max_seats_exceeded"),
    ).toBeTruthy();
  });

  it("warns on invalid #section polygon with fewer than 3 points", () => {
    const input = csv(
      ["Floor,A,1,10,20,,,,,"],
      ['#section,Floor,#aaa,polygon,"0 0,100 0"'],
    );

    const result = parsePlaceLayoutCsv(input);
    expect(
      result.issues.find((i) => i.code === "invalid_section_polygon"),
    ).toBeTruthy();
  });

  it("warns on invalid #stage bounds", () => {
    const input = csv(
      ["Floor,A,1,10,20,,,,,"],
      ["#stage,rectangle,Stage,abc,0,200,40"],
    );

    const result = parsePlaceLayoutCsv(input);
    expect(result.stage).toBeNull();
    expect(
      result.issues.find((i) => i.code === "invalid_stage_bounds"),
    ).toBeTruthy();
  });

  it("warns on unknown directives", () => {
    const input = csv(["Floor,A,1,10,20,,,,,"], ["#unknown,foo,bar"]);

    const result = parsePlaceLayoutCsv(input);
    expect(
      result.issues.find((i) => i.code === "unknown_directive"),
    ).toBeTruthy();
  });

  // ── Header normalization ─────────────────────────────────────────────

  it("normalizes column headers (whitespace, casing)", () => {
    const input =
      " Section , Row , Seat , X , Y ,Rotation,Width,Height,Tier,Notes\nFloor,A,1,10,20,0,,,general,";

    const result = parsePlaceLayoutCsv(input);

    expect(result.glyphs).toHaveLength(1);
    expect(result.glyphs[0]!.seatId).toBe("Floor-A-1");
  });

  // ── CSV quoting (RFC 4180) ───────────────────────────────────────────

  it("handles RFC 4180 quoted fields with commas and newlines", () => {
    const input = csv([
      '"Floor, Level 1",A,1,10,20,,,,,',
      '"Floor, Level 1",A,2,15,20,,,,,"A note with, comma"',
    ]);

    const result = parsePlaceLayoutCsv(input);

    expect(result.glyphs).toHaveLength(2);
    expect(result.glyphs[0]!.sectionId).toBe("Floor, Level 1");
    expect(result.glyphs[1]!.metadata?.notes).toBe("A note with, comma");
  });

  // ── Only directives, no seat data ────────────────────────────────────

  it("returns no_seat_data error when CSV has only directives", () => {
    const input = [
      '#section,Floor,#4A90D2,polygon,"0 0,100 0,100 50,0 50"',
    ].join("\n");

    const result = parsePlaceLayoutCsv(input);

    expect(result.glyphs).toHaveLength(0);
    expect(result.issues.find((i) => i.code === "no_seat_data")).toBeTruthy();
    // Section directive should still be parsed
    expect(result.sections).toHaveLength(1);
  });
});

describe("serializePlaceLayoutCsv", () => {
  it("round-trips a simple layout", () => {
    const original = csv(
      ["Floor,A,1,10,20,0,,,general,", "Floor,A,2,15,20,0,,,general,"],
      [
        '#section,Floor,#4A90D2,polygon,"0 0,100 0,100 50,0 50"',
        "#stage,rectangle,Main Stage,0,0,200,40",
      ],
    );

    // Parse the original
    const parsed = parsePlaceLayoutCsv(original);
    expect(parsed.glyphs).toHaveLength(2);

    // Serialize back to CSV
    const serialized = serializePlaceLayoutCsv({
      glyphs: parsed.glyphs,
      sections: parsed.sections,
      stage: parsed.stage,
    });

    // Parse the serialized version
    const reparsed = parsePlaceLayoutCsv(serialized);

    expect(reparsed.glyphs).toHaveLength(2);
    expect(reparsed.sections).toHaveLength(1);
    expect(reparsed.stage).toBeTruthy();

    // Same glyphs (positions, IDs)
    expect(reparsed.glyphs.map((g) => g.seatId)).toEqual(
      parsed.glyphs.map((g) => g.seatId),
    );
    expect(reparsed.glyphs.map((g) => g.position)).toEqual(
      parsed.glyphs.map((g) => g.position),
    );
  });

  it("serializes layout without stage or section geometry", () => {
    const input = csv(["Floor,A,1,10,20,,,,,", "Floor,A,2,15,20,,,,,"]);
    const parsed = parsePlaceLayoutCsv(input);

    const serialized = serializePlaceLayoutCsv({
      glyphs: parsed.glyphs,
      sections: parsed.sections,
    });

    const reparsed = parsePlaceLayoutCsv(serialized);
    expect(reparsed.glyphs).toHaveLength(2);
    expect(reparsed.stage).toBeNull();
  });

  // ── Security / size limits ─────────────────────────────────────────

  it("enforces maxSections limit", () => {
    const directives = Array.from(
      { length: 5 },
      (_, i) => `#section,Section${i},#aaa,polygon,"0 0,100 0,100 50,0 50"`,
    );
    const input = csv(["Section0,A,1,10,20,,,,,"], directives);

    const result = parsePlaceLayoutCsv(input, { maxSections: 3 });

    // Only the first 3 sections get added
    expect(result.sections.length).toBe(3);
    expect(
      result.issues.find((i) => i.code === "max_sections_exceeded"),
    ).toBeTruthy();
  });

  it("allows extra polygons on existing sections even at maxSections cap", () => {
    // Two directives for the same section, plus a third new section
    const directives = [
      '#section,Floor,#aaa,polygon,"0 0,100 0,100 50,0 50"',
      '#section,Floor,#aaa,polygon,"200 0,300 0,300 50,200 50"',
      '#section,Balcony,#bbb,polygon,"0 0,50 0,50 50,0 50"',
      '#section,NewSection,#ccc,polygon,"0 0,10 0,10 10,0 10"',
    ];
    const input = csv(["Floor,A,1,10,20,,,,,"], directives);

    const result = parsePlaceLayoutCsv(input, { maxSections: 2 });

    // Floor + Balcony get through, NewSection is rejected
    expect(result.sections.map((s) => s.sectionId).sort()).toEqual([
      "Balcony",
      "Floor",
    ]);
    const floorSection = result.sections.find((s) => s.sectionId === "Floor");
    // Floor should have both polygons
    expect(floorSection?.geometry?.polygons).toHaveLength(2);
    expect(
      result.issues.find((i) => i.code === "max_sections_exceeded"),
    ).toBeTruthy();
  });

  it("enforces maxVerticesPerSection limit", () => {
    // A polygon with 8 vertices — should be rejected when limit is 5
    const bigPolygon = "0 0,10 0,20 0,30 0,40 0,50 0,50 50,0 50";
    const directives = [`#section,Floor,#aaa,polygon,"${bigPolygon}"`];
    const input = csv(["Floor,A,1,10,20,,,,,"], directives);

    const result = parsePlaceLayoutCsv(input, { maxVerticesPerSection: 5 });

    const floorSection = result.sections.find((s) => s.sectionId === "Floor");
    expect(floorSection?.geometry).toBeUndefined();
    expect(
      result.issues.find((i) => i.code === "max_vertices_per_section_exceeded"),
    ).toBeTruthy();
  });

  it("enforces maxTotalVertices limit across sections", () => {
    const directives = [
      '#section,Floor,#aaa,polygon,"0 0,100 0,100 50,0 50"',
      '#section,Balcony,#bbb,polygon,"0 0,50 0,50 50,0 50"',
      '#section,Mezz,#ccc,polygon,"0 0,30 0,30 30,0 30"',
    ];
    const input = csv(["Floor,A,1,10,20,,,,,"], directives);

    // 4 + 4 = 8 fits under 10, but 4 + 4 + 4 = 12 exceeds 10
    const result = parsePlaceLayoutCsv(input, { maxTotalVertices: 10 });

    // Floor + Balcony should have polygons, Mezz should not
    const mezzSection = result.sections.find((s) => s.sectionId === "Mezz");
    expect(mezzSection?.geometry).toBeUndefined();
    expect(
      result.issues.find((i) => i.code === "max_total_vertices_exceeded"),
    ).toBeTruthy();
  });

  it("accumulates vertices across multiple polygons for per-section limit", () => {
    const directives = [
      '#section,Floor,#aaa,polygon,"0 0,100 0,100 50,0 50"', // 4 vertices
      '#section,Floor,#aaa,polygon,"200 0,300 0,300 50,200 50"', // 4 more → 8 total
    ];
    const input = csv(["Floor,A,1,10,20,,,,,"], directives);

    // First polygon (4) is fine. Second (4) would make 8, exceeds 6.
    const result = parsePlaceLayoutCsv(input, { maxVerticesPerSection: 6 });

    const floorSection = result.sections.find((s) => s.sectionId === "Floor");
    expect(floorSection?.geometry?.polygons).toHaveLength(1);
    expect(
      result.issues.find((i) => i.code === "max_vertices_per_section_exceeded"),
    ).toBeTruthy();
  });
});
