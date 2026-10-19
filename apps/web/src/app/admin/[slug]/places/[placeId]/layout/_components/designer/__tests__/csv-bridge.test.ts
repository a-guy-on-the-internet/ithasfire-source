import { describe, it, expect, beforeEach } from "vitest";

import {
  designerStateToCsv,
  csvToDesignerState,
  glyphsToDesignerState,
} from "../csv-bridge";
import { resetSectionCounter } from "../reducer";
import type {
  DesignerSection,
  DesignerSeat,
  DesignerStage,
  DesignerImage,
} from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const TRIANGLE_POLYGON = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 50, y: 80 },
];

function makeSection(
  overrides: Partial<DesignerSection> = {},
): DesignerSection {
  return {
    sectionId: "GA",
    label: "General Admission",
    color: "#4A90D2",
    polygon: TRIANGLE_POLYGON,
    kind: "seat",
    ...overrides,
  };
}

function makeSeat(overrides: Partial<DesignerSeat> = {}): DesignerSeat {
  return {
    id: "GA-A-1",
    sectionId: "GA",
    row: "A",
    seat: "1",
    position: { x: 30, y: 20 },
    radius: 4,
    rotationDeg: 0,
    ...overrides,
  };
}

const STAGE: DesignerStage = {
  kind: "rectangle",
  label: "Main Stage",
  bounds: { minX: 0, minY: -30, maxX: 100, maxY: 0 },
};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("designerStateToCsv", () => {
  it("serializes empty state", () => {
    const csv = designerStateToCsv({ sections: [], seats: [], stage: null });
    // No sections, no seats, no stage → empty string
    expect(csv.trim()).toBe("");
  });

  it("includes section directive", () => {
    const csv = designerStateToCsv({
      sections: [makeSection()],
      seats: [],
      stage: null,
    });
    expect(csv).toContain("#section");
    expect(csv).toContain("GA");
    expect(csv).toContain("#4A90D2");
    expect(csv).toContain("polygon");
    expect(csv).toContain("0 0");
  });

  it("includes stage directive", () => {
    const csv = designerStateToCsv({
      sections: [],
      seats: [],
      stage: STAGE,
    });
    expect(csv).toContain("#stage");
    expect(csv).toContain("Main Stage");
  });

  it("includes seat rows", () => {
    const csv = designerStateToCsv({
      sections: [makeSection()],
      seats: [
        makeSeat({ id: "GA-A-1", seat: "1", position: { x: 30, y: 20 } }),
        makeSeat({ id: "GA-A-2", seat: "2", position: { x: 40, y: 20 } }),
      ],
      stage: null,
    });
    const lines = csv.trim().split("\n");
    // #section directive + header + 2 data rows = 4 lines
    // Filter to non-directive, non-header data lines containing seat data
    const dataLines = lines.filter(
      (l) =>
        !l.startsWith("#") &&
        !l.startsWith('"#') &&
        !l.toLowerCase().startsWith('"section"') &&
        l.length > 0,
    );
    expect(dataLines).toHaveLength(2);
  });

  it("serializes rotation and radius as width/height columns", () => {
    const csv = designerStateToCsv({
      sections: [makeSection()],
      seats: [makeSeat({ rotationDeg: 15, radius: 5 })],
      stage: null,
    });
    // rotation→rotation column, radius→width column
    expect(csv).toContain("15");
  });

  it("includes image directive when image has dataUrl", () => {
    const csv = designerStateToCsv({
      sections: [],
      seats: [],
      stage: null,
      image: {
        src: "blob:xyz",
        dataUrl: "data:image/png;base64,abc123",
        position: { x: -50, y: -25 },
        width: 400,
        height: 200,
        opacity: 0.6,
      },
    });
    expect(csv).toContain("#image");
    expect(csv).toContain("data:image/png;base64,abc123");
    expect(csv).toContain("-50");
    expect(csv).toContain("-25");
    expect(csv).toContain("400");
    expect(csv).toContain("200");
    expect(csv).toContain("0.6");
  });

  it("omits image directive when image is null", () => {
    const csv = designerStateToCsv({
      sections: [],
      seats: [],
      stage: null,
      image: null,
    });
    expect(csv).not.toContain("#image");
  });
});

describe("csvToDesignerState", () => {
  beforeEach(() => resetSectionCounter());

  it("parses empty CSV (header only)", () => {
    const csv = "section,row,seat,x,y,rotation,width,height,tier,notes\n";
    const result = csvToDesignerState(csv);
    expect(result.sections).toHaveLength(0);
    expect(result.seats).toHaveLength(0);
    expect(result.stage).toBeNull();
    expect(result.warnings).toHaveLength(0);
  });

  it("parses sections and seats", () => {
    const csv = [
      '#section,GA,#4A90D2,polygon,"0 0,100 0,50 80",seat',
      "section,row,seat,x,y,rotation,width,height,tier,notes",
      "GA,A,1,30,20,0,8,8,,",
      "GA,A,2,40,20,0,8,8,,",
    ].join("\n");

    const result = csvToDesignerState(csv);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.sectionId).toBe("GA");
    expect(result.sections[0]!.color).toBe("#4A90D2");
    expect(result.sections[0]!.polygon).toHaveLength(3);
    expect(result.sections[0]!.kind).toBe("seat");
    expect(result.seats).toHaveLength(2);
    expect(result.seats[0]!.row).toBe("A");
    expect(result.seats[1]!.seat).toBe("2");
  });

  it("parses stage directive", () => {
    const csv = [
      "#stage,rectangle,Main Stage,0,-30,100,0",
      "section,row,seat,x,y,rotation,width,height,tier,notes",
    ].join("\n");

    const result = csvToDesignerState(csv);
    expect(result.stage).toBeTruthy();
    expect(result.stage!.label).toBe("Main Stage");
    expect(result.stage!.bounds.minX).toBe(0);
    expect(result.stage!.bounds.maxX).toBe(100);
  });

  it("auto-creates sections for undeclared section IDs", () => {
    const csv = [
      "section,row,seat,x,y,rotation,width,height,tier,notes",
      "UNKNOWN,A,1,10,10,0,8,8,,",
    ].join("\n");

    const result = csvToDesignerState(csv);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.sectionId).toBe("UNKNOWN");
    // Auto-created sections get default color and empty polygon
    expect(result.sections[0]!.color).toBe("#888888");
    expect(result.sections[0]!.polygon).toHaveLength(0);
    expect(result.sections[0]!.kind).toBe("seat");
  });

  it("defaults section kind to seat when column is absent (legacy CSV)", () => {
    const csv = [
      '#section,GA,#4A90D2,polygon,"0 0,100 0,50 80"',
      "section,row,seat,x,y,rotation,width,height,tier,notes",
      "GA,A,1,30,20,0,8,8,,",
    ].join("\n");

    const result = csvToDesignerState(csv);
    expect(result.sections[0]!.kind).toBe("seat");
  });

  it("parses helper section kind", () => {
    const csv = [
      '#section,STAGE,#FF0000,polygon,"0 0,200 0,200 50,0 50",helper',
      "section,row,seat,x,y,rotation,width,height,tier,notes",
    ].join("\n");

    const result = csvToDesignerState(csv);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.kind).toBe("helper");
  });

  it("skips rows with non-numeric coordinates", () => {
    const csv = [
      "section,row,seat,x,y,rotation,width,height,tier,notes",
      "GA,A,1,abc,10,0,8,8,,",
    ].join("\n");

    const result = csvToDesignerState(csv);
    expect(result.seats).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("treats empty x as zero (Number('') === 0)", () => {
    const csv = [
      "section,row,seat,x,y,rotation,width,height,tier,notes",
      "GA,A,1,,10,0,8,8,,",
    ].join("\n");

    const result = csvToDesignerState(csv);
    // Number("") === 0 and is finite, so the seat is parsed with x=0
    expect(result.seats).toHaveLength(1);
    expect(result.seats[0]!.position.x).toBe(0);
  });

  it("parses image directive", () => {
    const csv = [
      '"#image","data:image/png;base64,abc123","-50","-25","400","200","0.6"',
      "section,row,seat,x,y,rotation,width,height,tier,notes",
    ].join("\n");

    const result = csvToDesignerState(csv);
    expect(result.image).toBeTruthy();
    expect(result.image!.dataUrl).toBe("data:image/png;base64,abc123");
    expect(result.image!.position).toEqual({ x: -50, y: -25 });
    expect(result.image!.width).toBe(400);
    expect(result.image!.height).toBe(200);
    expect(result.image!.opacity).toBe(0.6);
  });

  it("returns null image when no image directive present", () => {
    const csv = [
      '#section,GA,#4A90D2,polygon,"0 0,100 0,50 80",seat',
      "section,row,seat,x,y,rotation,width,height,tier,notes",
    ].join("\n");

    const result = csvToDesignerState(csv);
    expect(result.image).toBeNull();
  });
});

describe("round-trip", () => {
  beforeEach(() => resetSectionCounter());

  it("round-trips sections + seats + stage", () => {
    const sections = [makeSection()];
    const seats = [
      makeSeat({ id: "GA-A-1", seat: "1", position: { x: 30, y: 20 } }),
      makeSeat({ id: "GA-A-2", seat: "2", position: { x: 40, y: 20 } }),
    ];

    const csv = designerStateToCsv({ sections, seats, stage: STAGE });
    const result = csvToDesignerState(csv);

    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.sectionId).toBe("GA");
    expect(result.sections[0]!.polygon).toHaveLength(3);
    expect(result.sections[0]!.color).toBe("#4A90D2");

    expect(result.seats).toHaveLength(2);
    expect(result.seats[0]!.row).toBe("A");
    expect(result.seats[0]!.seat).toBe("1");
    expect(result.seats[0]!.position.x).toBe(30);

    expect(result.stage).toBeTruthy();
    expect(result.stage!.label).toBe("Main Stage");
  });

  it("round-trips section kind", () => {
    const sections = [
      makeSection({ kind: "seat" }),
      makeSection({
        sectionId: "STAGE",
        label: "Stage",
        color: "#FF0000",
        polygon: [
          { x: 0, y: 0 },
          { x: 200, y: 0 },
          { x: 200, y: 50 },
          { x: 0, y: 50 },
        ],
        kind: "helper",
      }),
    ];
    const csv = designerStateToCsv({ sections, seats: [], stage: null });
    const result = csvToDesignerState(csv);

    expect(result.sections).toHaveLength(2);
    expect(result.sections.find((s) => s.sectionId === "GA")!.kind).toBe(
      "seat",
    );
    expect(result.sections.find((s) => s.sectionId === "STAGE")!.kind).toBe(
      "helper",
    );
  });

  it("round-trips multiple sections", () => {
    const sections = [
      makeSection({ sectionId: "A", label: "Section A", color: "#FF0000" }),
      makeSection({
        sectionId: "B",
        label: "Section B",
        color: "#00FF00",
        polygon: [
          { x: 200, y: 0 },
          { x: 300, y: 0 },
          { x: 250, y: 100 },
        ],
      }),
    ];
    const seats = [
      makeSeat({
        id: "A-A-1",
        sectionId: "A",
        seat: "1",
        position: { x: 30, y: 20 },
      }),
      makeSeat({
        id: "B-A-1",
        sectionId: "B",
        seat: "1",
        position: { x: 220, y: 20 },
      }),
    ];

    const csv = designerStateToCsv({ sections, seats, stage: null });
    const result = csvToDesignerState(csv);

    expect(result.sections).toHaveLength(2);
    expect(result.seats).toHaveLength(2);
    // Seats belong to correct sections
    expect(result.seats[0]!.sectionId).toBe("A");
    expect(result.seats[1]!.sectionId).toBe("B");
  });

  it("round-trips image directive", () => {
    const image: DesignerImage = {
      src: "blob:local",
      dataUrl: "data:image/png;base64,roundtrip",
      position: { x: -100, y: -50 },
      width: 500,
      height: 300,
      opacity: 0.75,
    };

    const csv = designerStateToCsv({
      sections: [],
      seats: [],
      stage: null,
      image,
    });
    const result = csvToDesignerState(csv);

    expect(result.image).toBeTruthy();
    expect(result.image!.dataUrl).toBe("data:image/png;base64,roundtrip");
    expect(result.image!.position).toEqual({ x: -100, y: -50 });
    expect(result.image!.width).toBe(500);
    expect(result.image!.height).toBe(300);
    expect(result.image!.opacity).toBe(0.75);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// glyphsToDesignerState
// ─────────────────────────────────────────────────────────────────────────────

describe("glyphsToDesignerState", () => {
  it("converts glyphs and sections into designer state", () => {
    const result = glyphsToDesignerState({
      glyphs: [
        {
          seatId: "GA-A-1",
          sectionId: "GA",
          label: "A-1",
          position: { x: 10, y: 20 },
          radius: 4,
          rotationDeg: 0,
        },
        {
          seatId: "GA-A-2",
          sectionId: "GA",
          label: "A-2",
          position: { x: 20, y: 20 },
          radius: 5,
          rotationDeg: 15,
        },
      ],
      sections: [
        {
          sectionId: "GA",
          label: "General Admission",
          color: "#4A90D2",
          capacity: 2,
          geometry: {
            polygons: [
              [
                { x: 0, y: 0 },
                { x: 100, y: 0 },
                { x: 50, y: 80 },
              ],
            ],
          },
        },
      ],
      stage: null,
    });

    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.sectionId).toBe("GA");
    expect(result.sections[0]!.label).toBe("General Admission");
    expect(result.sections[0]!.polygon).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 50, y: 80 },
    ]);

    expect(result.seats).toHaveLength(2);
    expect(result.seats[0]!.id).toBe("GA-A-1");
    expect(result.seats[0]!.sectionId).toBe("GA");
    expect(result.seats[0]!.row).toBe("A");
    expect(result.seats[0]!.seat).toBe("1");
    expect(result.seats[0]!.position).toEqual({ x: 10, y: 20 });
    expect(result.seats[0]!.radius).toBe(4);

    expect(result.seats[1]!.radius).toBe(5);
    expect(result.seats[1]!.rotationDeg).toBe(15);

    expect(result.stage).toBeNull();
    expect(result.image).toBeNull();
  });

  it("auto-creates sections for glyphs without matching section metadata", () => {
    const result = glyphsToDesignerState({
      glyphs: [
        {
          seatId: "VIP-B-3",
          sectionId: "VIP",
          label: "B-3",
          position: { x: 50, y: 60 },
        },
      ],
      sections: [],
      stage: null,
    });

    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.sectionId).toBe("VIP");
    expect(result.sections[0]!.polygon).toEqual([]);

    expect(result.seats).toHaveLength(1);
    expect(result.seats[0]!.sectionId).toBe("VIP");
    expect(result.seats[0]!.row).toBe("B");
    expect(result.seats[0]!.seat).toBe("3");
  });

  it("includes stage when provided", () => {
    const result = glyphsToDesignerState({
      glyphs: [],
      sections: [],
      stage: {
        kind: "rectangle",
        label: "Main Stage",
        bounds: { minX: -50, minY: -10, maxX: 50, maxY: 10 },
      },
    });

    expect(result.stage).not.toBeNull();
    expect(result.stage!.label).toBe("Main Stage");
    expect(result.stage!.bounds).toEqual({
      minX: -50,
      minY: -10,
      maxX: 50,
      maxY: 10,
    });
  });

  it("defaults radius to 4 and rotationDeg to 0 when not provided", () => {
    const result = glyphsToDesignerState({
      glyphs: [
        {
          seatId: "SEC-C-5",
          sectionId: "SEC",
          label: "C-5",
          position: { x: 0, y: 0 },
        },
      ],
      sections: [],
      stage: null,
    });

    expect(result.seats[0]!.radius).toBe(4);
    expect(result.seats[0]!.rotationDeg).toBe(0);
  });

  it("handles sections without polygon geometry", () => {
    const result = glyphsToDesignerState({
      glyphs: [],
      sections: [
        {
          sectionId: "X",
          label: "No Geo",
          capacity: 0,
        },
      ],
      stage: null,
    });

    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.polygon).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Smoothing round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe("smoothing serialization round-trip", () => {
  it("preserves smoothing through CSV serialize/deserialize", () => {
    const section = makeSection({ smoothing: 0.75 });
    const csv = designerStateToCsv({
      sections: [section],
      seats: [],
      stage: null,
    });
    expect(csv).toContain("0.75");

    const result = csvToDesignerState(csv);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.smoothing).toBe(0.75);
  });

  it("omits smoothing column when smoothing is 0 or absent", () => {
    const section = makeSection({ smoothing: undefined });
    const csv = designerStateToCsv({
      sections: [section],
      seats: [],
      stage: null,
    });
    // Should NOT have a trailing column for smoothing (or it should be empty)
    const result = csvToDesignerState(csv);
    expect(result.sections[0]!.smoothing).toBeUndefined();
  });

  it("clamps out-of-range smoothing values on import", () => {
    // Manually construct CSV with smoothing > 1
    const csv = `"#section","TestSec","#ff0000","polygon","0 0,100 0,50 80","seat","","","1.5"`;
    const result = csvToDesignerState(csv);
    expect(result.sections[0]!.smoothing).toBe(1);
  });
});
