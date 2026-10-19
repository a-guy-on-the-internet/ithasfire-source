import { describe, it, expect, beforeEach } from "vitest";

import {
  designerReducer,
  createInitialState,
  resetSectionCounter,
  resetGroupCounter,
  resetStrokeCounter,
  pointInPolygon,
  distance,
  findSeatAt,
  findSectionAt,
  findStrokeAt,
  findNearestVertex,
  computeLinePositions,
  computeArcPositions,
  computeGridPositions,
  computeLinePositionsWithSpacing,
  computeArcPositionsWithSpacing,
  computeGridPositionsWithSpacing,
  computeGridPositionsWithSeparateSpacing,
  nextRowLabel,
  computeStrokePositions,
  catmullRomTessellate,
  tessellatedPolygon,
} from "../reducer";

import type {
  DesignerState,
  DesignerAction,
  DesignerSection,
  DesignerSeat,
  Point,
  StrokeControlPoint,
} from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function act(state: DesignerState, action: DesignerAction): DesignerState {
  return designerReducer(state, action);
}

function acts(
  state: DesignerState,
  ...actions: DesignerAction[]
): DesignerState {
  return actions.reduce((s, a) => designerReducer(s, a), state);
}

const SQUARE: Point[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("designerReducer", () => {
  let initial: DesignerState;

  beforeEach(() => {
    resetSectionCounter();
    resetGroupCounter();
    initial = createInitialState();
  });

  // ── Tool switching ─────────────────────────────────────────────────────

  it("switches tools", () => {
    const s = act(initial, { type: "SET_TOOL", tool: "draw_section" });
    expect(s.activeTool).toBe("draw_section");
  });

  it("cancels in-progress polygon when switching away from draw_section", () => {
    let s = act(initial, { type: "SET_TOOL", tool: "draw_section" });
    s = act(s, { type: "ADD_POLYGON_POINT", point: { x: 0, y: 0 } });
    s = act(s, { type: "ADD_POLYGON_POINT", point: { x: 10, y: 0 } });
    expect(s.drawingPolygon).toHaveLength(2);

    s = act(s, { type: "SET_TOOL", tool: "select" });
    expect(s.drawingPolygon).toHaveLength(0);
  });

  // ── Section polygon drawing ────────────────────────────────────────────

  it("adds polygon points", () => {
    let s = act(initial, { type: "SET_TOOL", tool: "draw_section" });
    s = act(s, { type: "ADD_POLYGON_POINT", point: { x: 0, y: 0 } });
    s = act(s, { type: "ADD_POLYGON_POINT", point: { x: 50, y: 0 } });
    s = act(s, { type: "ADD_POLYGON_POINT", point: { x: 50, y: 50 } });
    expect(s.drawingPolygon).toHaveLength(3);
  });

  it("closes polygon to create a seat section", () => {
    let s = act(initial, { type: "SET_TOOL", tool: "draw_section" });
    s = acts(
      s,
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 100 } },
      { type: "CLOSE_POLYGON", color: "#FF0000" },
    );
    expect(s.sections).toHaveLength(1);
    expect(s.sections[0]!.color).toBe("#FF0000");
    expect(s.sections[0]!.polygon).toHaveLength(3);
    expect(s.sections[0]!.kind).toBe("seat");
    expect(s.drawingPolygon).toHaveLength(0);
    // Auto-switches to seat placement for seat sections
    expect(s.activeTool).toBe("place_seat");
    expect(s.activeSectionId).toBe(s.sections[0]!.sectionId);
  });

  it("closes polygon as helper section and does NOT auto-switch to place_seat", () => {
    const s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "SET_DRAWING_SECTION_KIND", sectionKind: "helper" },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 100 } },
      { type: "CLOSE_POLYGON", color: "#FF0000" },
    );
    expect(s.sections).toHaveLength(1);
    expect(s.sections[0]!.kind).toBe("helper");
    // Does NOT auto-switch to place_seat for helper sections
    expect(s.activeTool).toBe("draw_section");
  });

  it("does not close polygon with fewer than 3 points", () => {
    let s = act(initial, { type: "SET_TOOL", tool: "draw_section" });
    s = acts(
      s,
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 10, y: 0 } },
      { type: "CLOSE_POLYGON", color: "#FF0000" },
    );
    expect(s.sections).toHaveLength(0);
    expect(s.drawingPolygon).toHaveLength(2);
  });

  it("cancels drawing", () => {
    let s = act(initial, { type: "SET_TOOL", tool: "draw_section" });
    s = acts(
      s,
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 10, y: 0 } },
      { type: "CANCEL_DRAWING" },
    );
    expect(s.drawingPolygon).toHaveLength(0);
  });

  // ── Seat placement ─────────────────────────────────────────────────────

  it("places seats with auto-incrementing numbers", () => {
    let s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 100 } },
      { type: "CLOSE_POLYGON", color: "#00FF00" },
    );
    const sectionId = s.activeSectionId!;

    s = acts(
      s,
      { type: "PLACE_SEAT", position: { x: 10, y: 10 } },
      { type: "PLACE_SEAT", position: { x: 20, y: 10 } },
      { type: "PLACE_SEAT", position: { x: 30, y: 10 } },
    );

    expect(s.seats).toHaveLength(3);
    expect(s.seats[0]!.id).toBe(`${sectionId}-A-1`);
    expect(s.seats[1]!.id).toBe(`${sectionId}-A-2`);
    expect(s.seats[2]!.id).toBe(`${sectionId}-A-3`);
    expect(s.nextSeatNumber).toBe(4);
  });

  it("does not place a seat without active section", () => {
    const s = act(initial, { type: "PLACE_SEAT", position: { x: 10, y: 10 } });
    expect(s.seats).toHaveLength(0);
  });

  it("rejects seat outside of section polygon", () => {
    let s = createStateWithSeats();
    // The section is a triangle: (0,0), (100,0), (100,100)
    // (90,90) is inside, (200,200) is outside
    const sectionId = s.activeSectionId!;
    const before = s.seats.length;

    s = act(s, { type: "PLACE_SEAT", position: { x: 200, y: 200 } });
    expect(s.seats.length).toBe(before); // no new seat
  });

  it("does not place seat in a helper section", () => {
    let s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "SET_DRAWING_SECTION_KIND", sectionKind: "helper" },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 100 } },
      { type: "CLOSE_POLYGON", color: "#00FF00" },
    );
    // Force activeSectionId to the helper section
    s = act(s, {
      type: "SET_ACTIVE_SECTION",
      sectionId: s.sections[0]!.sectionId,
    });
    s = act(s, { type: "PLACE_SEAT", position: { x: 50, y: 25 } });
    expect(s.seats).toHaveLength(0);
  });

  it("changes row and resets seat number", () => {
    let s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 50, y: 50 } },
      { type: "CLOSE_POLYGON", color: "#0000FF" },
      { type: "PLACE_SEAT", position: { x: 40, y: 10 } },
      { type: "PLACE_SEAT", position: { x: 50, y: 10 } },
      { type: "SET_CURRENT_ROW", row: "B" },
    );
    expect(s.currentRow).toBe("B");
    expect(s.nextSeatNumber).toBe(1);

    s = act(s, { type: "PLACE_SEAT", position: { x: 50, y: 20 } });
    expect(s.seats[2]!.row).toBe("B");
    expect(s.seats[2]!.seat).toBe("1");
  });

  // ── Stage (legacy) ─────────────────────────────────────────────────────

  it("SET_STAGE_DRAW_START is a no-op", () => {
    const s = act(initial, {
      type: "SET_STAGE_DRAW_START",
      point: { x: 0, y: 0 },
    });
    expect(s).toBe(initial); // same reference — no-op
  });

  it("places a legacy stage", () => {
    const s = act(initial, {
      type: "PLACE_STAGE",
      bounds: { minX: 0, minY: 0, maxX: 100, maxY: 40 },
      label: "Main Stage",
    });
    expect(s.stage).toBeTruthy();
    expect(s.stage!.label).toBe("Main Stage");
  });

  it("removes a stage", () => {
    let s = act(initial, {
      type: "PLACE_STAGE",
      bounds: { minX: 0, minY: 0, maxX: 100, maxY: 40 },
      label: "Stage",
    });
    s = act(s, { type: "REMOVE_STAGE" });
    expect(s.stage).toBeNull();
  });

  // ── Selection ──────────────────────────────────────────────────────────

  it("selects and deselects seats", () => {
    let s = createStateWithSeats();

    s = act(s, {
      type: "SELECT_SEAT",
      seatId: s.seats[0]!.id,
      additive: false,
    });
    expect(s.selectedSeatIds.size).toBe(1);

    s = act(s, { type: "SELECT_SEAT", seatId: s.seats[1]!.id, additive: true });
    expect(s.selectedSeatIds.size).toBe(2);

    // Toggle off
    s = act(s, { type: "SELECT_SEAT", seatId: s.seats[0]!.id, additive: true });
    expect(s.selectedSeatIds.size).toBe(1);
    expect(s.selectedSeatIds.has(s.seats[1]!.id)).toBe(true);
  });

  it("selects sections", () => {
    let s = createStateWithSeats();
    s = act(s, {
      type: "SELECT_SECTION",
      sectionId: s.sections[0]!.sectionId,
      additive: false,
    });
    expect(s.selectedSectionIds.size).toBe(1);
  });

  it("selects image", () => {
    let s = act(initial, {
      type: "SET_IMAGE",
      image: {
        src: "test",
        dataUrl: "",
        position: { x: 0, y: 0 },
        width: 100,
        height: 100,
        opacity: 1,
      },
    });
    s = act(s, { type: "SELECT_IMAGE" });
    expect(s.imageSelected).toBe(true);
    expect(s.selectedSeatIds.size).toBe(0);
  });

  it("clears selection", () => {
    let s = createStateWithSeats();
    s = act(s, {
      type: "SELECT_SEAT",
      seatId: s.seats[0]!.id,
      additive: false,
    });
    s = act(s, { type: "CLEAR_SELECTION" });
    expect(s.selectedSeatIds.size).toBe(0);
  });

  // ── Deletion ───────────────────────────────────────────────────────────

  it("deletes selected seats", () => {
    let s = createStateWithSeats();
    const id = s.seats[0]!.id;
    s = acts(
      s,
      { type: "SELECT_SEAT", seatId: id, additive: false },
      { type: "DELETE_SELECTED" },
    );
    expect(s.seats.find((seat) => seat.id === id)).toBeUndefined();
    expect(s.selectedSeatIds.size).toBe(0);
  });

  it("deletes a section and its seats", () => {
    let s = createStateWithSeats();
    const sectionId = s.sections[0]!.sectionId;
    const seatCount = s.seats.filter(
      (seat) => seat.sectionId === sectionId,
    ).length;
    const totalBefore = s.seats.length;

    s = act(s, { type: "DELETE_SECTION", sectionId });
    expect(
      s.sections.find((sec) => sec.sectionId === sectionId),
    ).toBeUndefined();
    expect(s.seats.length).toBe(totalBefore - seatCount);
  });

  it("deletes selected sections removes their seats too", () => {
    let s = createStateWithSeats();
    const sectionId = s.sections[0]!.sectionId;
    s = acts(
      s,
      { type: "SELECT_SECTION", sectionId, additive: false },
      { type: "DELETE_SELECTED" },
    );
    expect(s.sections).toHaveLength(0);
    expect(s.seats).toHaveLength(0);
  });

  // ── Section updates ────────────────────────────────────────────────────

  it("updates section color", () => {
    let s = createStateWithSeats();
    const sectionId = s.sections[0]!.sectionId;
    s = act(s, { type: "UPDATE_SECTION_COLOR", sectionId, color: "#ABCDEF" });
    expect(s.sections[0]!.color).toBe("#ABCDEF");
  });

  it("updates section label", () => {
    let s = createStateWithSeats();
    const sectionId = s.sections[0]!.sectionId;
    s = act(s, { type: "UPDATE_SECTION_LABEL", sectionId, label: "VIP" });
    expect(s.sections[0]!.label).toBe("VIP");
  });

  // ── Move seats ─────────────────────────────────────────────────────────

  it("moves selected seats", () => {
    let s = createStateWithSeats();
    const id = s.seats[0]!.id;
    const origX = s.seats[0]!.position.x;
    const origY = s.seats[0]!.position.y;

    s = acts(
      s,
      { type: "SELECT_SEAT", seatId: id, additive: false },
      { type: "MOVE_SELECTED_SEATS", dx: 5, dy: -3 },
    );

    expect(s.seats[0]!.position.x).toBe(origX + 5);
    expect(s.seats[0]!.position.y).toBe(origY - 3);
  });

  // ── Move sections ──────────────────────────────────────────────────────

  it("moves selected sections and their seats", () => {
    let s = createStateWithSeats();
    const sectionId = s.sections[0]!.sectionId;
    const origPolyX = s.sections[0]!.polygon[0]!.x;
    const origSeatX = s.seats[0]!.position.x;

    s = acts(
      s,
      { type: "SELECT_SECTION", sectionId, additive: false },
      { type: "MOVE_SELECTED_SECTIONS", dx: 10, dy: 20 },
    );

    expect(s.sections[0]!.polygon[0]!.x).toBe(origPolyX + 10);
    expect(s.seats[0]!.position.x).toBe(origSeatX + 10);
  });

  // ── BEGIN_DRAG / move undo strategy ────────────────────────────────────

  it("BEGIN_DRAG pushes undo snapshot", () => {
    let s = createStateWithSeats();
    const undoBefore = s.undoStack.length;
    s = act(s, { type: "BEGIN_DRAG" });
    expect(s.undoStack.length).toBe(undoBefore + 1);
  });

  it("MOVE_SELECTED_SEATS does NOT push undo", () => {
    let s = createStateWithSeats();
    s = act(s, {
      type: "SELECT_SEAT",
      seatId: s.seats[0]!.id,
      additive: false,
    });
    const undoBefore = s.undoStack.length;
    s = act(s, { type: "MOVE_SELECTED_SEATS", dx: 5, dy: 5 });
    expect(s.undoStack.length).toBe(undoBefore);
  });

  it("MOVE_SELECTED_SECTIONS does NOT push undo", () => {
    let s = createStateWithSeats();
    s = act(s, {
      type: "SELECT_SECTION",
      sectionId: s.sections[0]!.sectionId,
      additive: false,
    });
    const undoBefore = s.undoStack.length;
    s = act(s, { type: "MOVE_SELECTED_SECTIONS", dx: 5, dy: 5 });
    expect(s.undoStack.length).toBe(undoBefore);
  });

  it("MOVE_IMAGE does NOT push undo", () => {
    let s = act(initial, {
      type: "SET_IMAGE",
      image: {
        src: "t.png",
        dataUrl: "",
        position: { x: 0, y: 0 },
        width: 100,
        height: 100,
        opacity: 1,
      },
    });
    const undoBefore = s.undoStack.length;
    s = act(s, { type: "MOVE_IMAGE", dx: 5, dy: 5 });
    expect(s.undoStack.length).toBe(undoBefore);
  });

  // ── Image management ───────────────────────────────────────────────────

  it("sets image", () => {
    const img = {
      src: "test.png",
      dataUrl: "data:image/png;base64,abc",
      position: { x: 0, y: 0 },
      width: 200,
      height: 150,
      opacity: 0.5,
    };
    const s = act(initial, { type: "SET_IMAGE", image: img });
    expect(s.image).toEqual(img);
  });

  it("removes image", () => {
    let s = act(initial, {
      type: "SET_IMAGE",
      image: {
        src: "test.png",
        dataUrl: "",
        position: { x: 0, y: 0 },
        width: 200,
        height: 150,
        opacity: 0.5,
      },
    });
    s = act(s, { type: "REMOVE_IMAGE" });
    expect(s.image).toBeNull();
    expect(s.imageSelected).toBe(false);
  });

  it("sets image opacity", () => {
    let s = act(initial, {
      type: "SET_IMAGE",
      image: {
        src: "test.png",
        dataUrl: "",
        position: { x: 0, y: 0 },
        width: 200,
        height: 150,
        opacity: 0.5,
      },
    });
    s = act(s, { type: "SET_IMAGE_OPACITY", opacity: 0.8 });
    expect(s.image!.opacity).toBe(0.8);
  });

  it("moves image", () => {
    let s = act(initial, {
      type: "SET_IMAGE",
      image: {
        src: "test.png",
        dataUrl: "",
        position: { x: 10, y: 20 },
        width: 200,
        height: 150,
        opacity: 0.5,
      },
    });
    s = act(s, { type: "MOVE_IMAGE", dx: 5, dy: -10 });
    expect(s.image!.position).toEqual({ x: 15, y: 10 });
  });

  // ── Layout name ────────────────────────────────────────────────────────

  it("sets layout name", () => {
    const s = act(initial, { type: "SET_LAYOUT_NAME", name: "Main Hall" });
    expect(s.layoutName).toBe("Main Hall");
  });

  // ── Load state ─────────────────────────────────────────────────────────

  it("loads state from import", () => {
    const sections = [
      {
        sectionId: "A",
        label: "A",
        color: "#FF0000",
        polygon: SQUARE,
        kind: "seat" as const,
      },
    ];
    const seats = [
      {
        id: "A-A-1",
        sectionId: "A",
        row: "A",
        seat: "1",
        position: { x: 10, y: 10 },
        radius: 4,
        rotationDeg: 0,
      },
    ];

    const s = act(initial, {
      type: "LOAD_STATE",
      sections,
      seats,
      stage: {
        kind: "rectangle",
        label: "Stage",
        bounds: { minX: 0, minY: 0, maxX: 100, maxY: 30 },
      },
    });

    expect(s.sections).toHaveLength(1);
    expect(s.seats).toHaveLength(1);
    expect(s.stage).toBeTruthy();
    expect(s.selectedSeatIds.size).toBe(0);
  });

  // ── Clear all ──────────────────────────────────────────────────────────

  it("clears all but preserves layout name and image", () => {
    let s = createStateWithSeats();
    s = act(s, { type: "SET_LAYOUT_NAME", name: "Keep Me" });
    s = act(s, {
      type: "SET_IMAGE",
      image: {
        src: "keep.png",
        dataUrl: "",
        position: { x: 0, y: 0 },
        width: 100,
        height: 100,
        opacity: 0.5,
      },
    });
    s = act(s, { type: "CLEAR_ALL" });
    expect(s.sections).toHaveLength(0);
    expect(s.seats).toHaveLength(0);
    expect(s.stage).toBeNull();
    expect(s.layoutName).toBe("Keep Me");
    expect(s.image).toBeTruthy();
  });

  // ── Undo ───────────────────────────────────────────────────────────────

  it("undo restores previous state after placing a seat", () => {
    let s = createStateWithSeats(); // 3 seats
    const countBefore = s.seats.length;
    s = act(s, { type: "PLACE_SEAT", position: { x: 50, y: 25 } });
    expect(s.seats.length).toBe(countBefore + 1);
    expect(s.undoStack.length).toBeGreaterThan(0);

    s = act(s, { type: "UNDO" });
    expect(s.seats.length).toBe(countBefore);
  });

  it("undo restores previous state after deleting a section", () => {
    let s = createStateWithSeats();
    const sectionId = s.sections[0]!.sectionId;
    s = act(s, { type: "DELETE_SECTION", sectionId });
    expect(s.sections).toHaveLength(0);

    s = act(s, { type: "UNDO" });
    expect(s.sections).toHaveLength(1);
    expect(s.sections[0]!.sectionId).toBe(sectionId);
  });

  it("undo is a no-op when stack is empty", () => {
    const s = act(initial, { type: "UNDO" });
    expect(s).toBe(initial);
  });

  it("undo stack is bounded by maxUndoDepth", () => {
    let s = { ...initial, maxUndoDepth: 3 };
    // Create a section to place seats in
    s = acts(
      s,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 100 } },
      { type: "CLOSE_POLYGON", color: "#00FF00" },
    );
    // Place 5 seats, each pushing undo
    for (let i = 0; i < 5; i++) {
      s = act(s, { type: "PLACE_SEAT", position: { x: 10 + i * 10, y: 10 } });
    }
    // Stack should be capped at 3
    expect(s.undoStack.length).toBeLessThanOrEqual(3);
  });

  // ── Redo ───────────────────────────────────────────────────────────────

  it("redo restores state after undo", () => {
    let s = createStateWithSeats();
    s = act(s, { type: "PLACE_SEAT", position: { x: 50, y: 25 } });
    const countAfterPlace = s.seats.length;
    s = act(s, { type: "UNDO" });
    expect(s.seats.length).toBe(countAfterPlace - 1);
    expect(s.redoStack.length).toBe(1);
    s = act(s, { type: "REDO" });
    expect(s.seats.length).toBe(countAfterPlace);
    expect(s.redoStack.length).toBe(0);
  });

  it("redo is a no-op when redo stack is empty", () => {
    const s = act(initial, { type: "REDO" });
    expect(s).toBe(initial);
  });

  it("new mutation clears redo stack", () => {
    let s = createStateWithSeats();
    s = act(s, { type: "PLACE_SEAT", position: { x: 50, y: 25 } });
    s = act(s, { type: "UNDO" });
    expect(s.redoStack.length).toBe(1);
    // New mutation should clear redo
    s = act(s, { type: "PLACE_SEAT", position: { x: 60, y: 25 } });
    expect(s.redoStack.length).toBe(0);
  });

  it("multiple undos and redos work correctly", () => {
    let s = createStateWithSeats();
    const baseCount = s.seats.length;
    s = act(s, { type: "PLACE_SEAT", position: { x: 50, y: 25 } });
    s = act(s, { type: "PLACE_SEAT", position: { x: 60, y: 25 } });
    expect(s.seats.length).toBe(baseCount + 2);

    s = act(s, { type: "UNDO" });
    s = act(s, { type: "UNDO" });
    expect(s.seats.length).toBe(baseCount);
    expect(s.redoStack.length).toBe(2);

    s = act(s, { type: "REDO" });
    expect(s.seats.length).toBe(baseCount + 1);
    s = act(s, { type: "REDO" });
    expect(s.seats.length).toBe(baseCount + 2);
    expect(s.redoStack.length).toBe(0);
  });

  // ── Default seat radius ────────────────────────────────────────────────

  it("sets default seat radius", () => {
    const s = act(initial, { type: "SET_DEFAULT_SEAT_RADIUS", radius: 6 });
    expect(s.defaultSeatRadius).toBe(6);
  });

  // ── Drawing section kind ───────────────────────────────────────────────

  it("sets drawing section kind", () => {
    const s = act(initial, {
      type: "SET_DRAWING_SECTION_KIND",
      sectionKind: "helper",
    });
    expect(s.drawingSectionKind).toBe("helper");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Geometry helpers
// ─────────────────────────────────────────────────────────────────────────────

describe("pointInPolygon", () => {
  it("returns true for point inside a square", () => {
    expect(pointInPolygon({ x: 50, y: 50 }, SQUARE)).toBe(true);
  });

  it("returns false for point outside", () => {
    expect(pointInPolygon({ x: 150, y: 50 }, SQUARE)).toBe(false);
  });

  it("handles triangle", () => {
    const tri: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 50, y: 100 },
    ];
    expect(pointInPolygon({ x: 50, y: 30 }, tri)).toBe(true);
    expect(pointInPolygon({ x: 5, y: 80 }, tri)).toBe(false);
  });
});

describe("distance", () => {
  it("computes Euclidean distance", () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });
});

describe("findSeatAt", () => {
  it("finds closest seat within radius", () => {
    const seats = [
      {
        id: "s1",
        sectionId: "sec",
        row: "A",
        seat: "1",
        position: { x: 10, y: 10 },
        radius: 4,
        rotationDeg: 0,
      },
      {
        id: "s2",
        sectionId: "sec",
        row: "A",
        seat: "2",
        position: { x: 30, y: 10 },
        radius: 4,
        rotationDeg: 0,
      },
    ];
    expect(findSeatAt(seats, { x: 11, y: 10 }, 5)?.id).toBe("s1");
    expect(findSeatAt(seats, { x: 20, y: 10 }, 5)).toBeNull();
  });
});

describe("findSectionAt", () => {
  it("finds section containing point", () => {
    const sections = [
      {
        sectionId: "s1",
        label: "S1",
        color: "#f00",
        polygon: SQUARE,
        kind: "seat" as const,
      },
    ];
    expect(findSectionAt(sections, { x: 50, y: 50 })?.sectionId).toBe("s1");
    expect(findSectionAt(sections, { x: 200, y: 200 })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Batch geometry helpers
// ─────────────────────────────────────────────────────────────────────────────

describe("computeLinePositions", () => {
  it("returns empty array for count <= 0", () => {
    expect(computeLinePositions({ x: 0, y: 0 }, { x: 100, y: 0 }, 0)).toEqual(
      [],
    );
    expect(computeLinePositions({ x: 0, y: 0 }, { x: 100, y: 0 }, -1)).toEqual(
      [],
    );
  });

  it("returns midpoint for count === 1", () => {
    const pts = computeLinePositions({ x: 0, y: 0 }, { x: 100, y: 0 }, 1);
    expect(pts).toHaveLength(1);
    expect(pts[0]!.x).toBeCloseTo(50);
    expect(pts[0]!.y).toBeCloseTo(0);
  });

  it("distributes N points evenly along a line", () => {
    const pts = computeLinePositions({ x: 0, y: 0 }, { x: 100, y: 0 }, 5);
    expect(pts).toHaveLength(5);
    expect(pts[0]!.x).toBeCloseTo(0);
    expect(pts[1]!.x).toBeCloseTo(25);
    expect(pts[2]!.x).toBeCloseTo(50);
    expect(pts[3]!.x).toBeCloseTo(75);
    expect(pts[4]!.x).toBeCloseTo(100);
    for (const p of pts) expect(p.y).toBeCloseTo(0);
  });

  it("works with a diagonal line", () => {
    const pts = computeLinePositions({ x: 0, y: 0 }, { x: 30, y: 40 }, 2);
    expect(pts).toHaveLength(2);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[1]).toEqual({ x: 30, y: 40 });
  });
});

describe("computeArcPositions", () => {
  it("returns empty array for count <= 0 or radius <= 0", () => {
    expect(computeArcPositions({ x: 0, y: 0 }, 50, 0, Math.PI, 0)).toEqual([]);
    expect(computeArcPositions({ x: 0, y: 0 }, 0, 0, Math.PI, 5)).toEqual([]);
    expect(computeArcPositions({ x: 0, y: 0 }, -1, 0, Math.PI, 5)).toEqual([]);
  });

  it("returns midpoint angle for count === 1", () => {
    const pts = computeArcPositions({ x: 0, y: 0 }, 100, 0, Math.PI, 1);
    expect(pts).toHaveLength(1);
    // mid-angle is PI/2 → (0, 100)
    expect(pts[0]!.x).toBeCloseTo(0, 5);
    expect(pts[0]!.y).toBeCloseTo(100, 5);
  });

  it("distributes seats evenly along an arc", () => {
    // Quarter circle: 0 to PI/2, 3 seats
    const pts = computeArcPositions({ x: 0, y: 0 }, 10, 0, Math.PI / 2, 3);
    expect(pts).toHaveLength(3);
    // At angle 0: (10, 0)
    expect(pts[0]!.x).toBeCloseTo(10, 5);
    expect(pts[0]!.y).toBeCloseTo(0, 5);
    // At angle PI/4: (10*cos(PI/4), 10*sin(PI/4))
    expect(pts[1]!.x).toBeCloseTo(10 * Math.cos(Math.PI / 4), 5);
    expect(pts[1]!.y).toBeCloseTo(10 * Math.sin(Math.PI / 4), 5);
    // At angle PI/2: (0, 10)
    expect(pts[2]!.x).toBeCloseTo(0, 5);
    expect(pts[2]!.y).toBeCloseTo(10, 5);
  });
});

describe("computeGridPositions", () => {
  it("returns empty array for rows <= 0 or cols <= 0", () => {
    expect(
      computeGridPositions({ x: 0, y: 0 }, { x: 100, y: 100 }, 0, 5),
    ).toEqual([]);
    expect(
      computeGridPositions({ x: 0, y: 0 }, { x: 100, y: 100 }, 5, 0),
    ).toEqual([]);
  });

  it("places single seat in center for 1x1 grid", () => {
    const pts = computeGridPositions({ x: 0, y: 0 }, { x: 100, y: 100 }, 1, 1);
    expect(pts).toHaveLength(1);
    expect(pts[0]!.x).toBeCloseTo(50);
    expect(pts[0]!.y).toBeCloseTo(50);
  });

  it("creates a proper 2x3 grid", () => {
    const pts = computeGridPositions({ x: 0, y: 0 }, { x: 100, y: 50 }, 2, 3);
    expect(pts).toHaveLength(6);
    // Row 0: y=0
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[1]).toEqual({ x: 50, y: 0 });
    expect(pts[2]).toEqual({ x: 100, y: 0 });
    // Row 1: y=50
    expect(pts[3]).toEqual({ x: 0, y: 50 });
    expect(pts[4]).toEqual({ x: 50, y: 50 });
    expect(pts[5]).toEqual({ x: 100, y: 50 });
  });

  it("handles single row with multiple columns", () => {
    const pts = computeGridPositions({ x: 10, y: 20 }, { x: 110, y: 20 }, 1, 4);
    expect(pts).toHaveLength(4);
    // All at y=20 (midpoint since rows=1 → ty=0.5)
    for (const p of pts) expect(p.y).toBeCloseTo(20);
    expect(pts[0]!.x).toBeCloseTo(10);
    expect(pts[3]!.x).toBeCloseTo(110);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Batch placement reducer actions
// ─────────────────────────────────────────────────────────────────────────────

describe("designerReducer — batch placement", () => {
  let initial: DesignerState;

  beforeEach(() => {
    resetSectionCounter();
    resetGroupCounter();
    initial = createInitialState();
  });

  function stateWithSection(): DesignerState {
    let s = initial;
    s = acts(
      s,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 200, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 200, y: 200 } },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 200 } },
      { type: "CLOSE_POLYGON", color: "#4A90D2" },
    );
    return s;
  }

  // ── SET_BATCH_COUNT / SET_BATCH_GRID_ROWS ──────────────────────────────

  it("sets batch count (clamped to >= 1)", () => {
    let s = act(initial, { type: "SET_BATCH_COUNT", count: 20 });
    expect(s.batchCount).toBe(20);
    s = act(s, { type: "SET_BATCH_COUNT", count: 0 });
    expect(s.batchCount).toBe(1);
    s = act(s, { type: "SET_BATCH_COUNT", count: -5 });
    expect(s.batchCount).toBe(1);
  });

  it("sets batch grid rows (clamped to >= 1)", () => {
    let s = act(initial, { type: "SET_BATCH_GRID_ROWS", rows: 5 });
    expect(s.batchGridRows).toBe(5);
    s = act(s, { type: "SET_BATCH_GRID_ROWS", rows: 0 });
    expect(s.batchGridRows).toBe(1);
  });

  it("SET_PLACEMENT_PREVIEW updates preview", () => {
    const preview = {
      kind: "line" as const,
      start: { x: 0, y: 0 },
      end: { x: 100, y: 0 },
      count: 5,
    };
    const s = act(initial, { type: "SET_PLACEMENT_PREVIEW", preview });
    expect(s.placementPreview).toEqual(preview);
  });

  it("SET_TOOL clears placement preview", () => {
    const preview = {
      kind: "line" as const,
      start: { x: 0, y: 0 },
      end: { x: 100, y: 0 },
      count: 5,
    };
    let s = act(initial, { type: "SET_PLACEMENT_PREVIEW", preview });
    s = act(s, { type: "SET_TOOL", tool: "select" });
    expect(s.placementPreview).toBeNull();
  });

  // ── COMMIT_LINE_PLACEMENT ──────────────────────────────────────────────

  it("places seats in a line", () => {
    let s = stateWithSection();
    expect(s.seats).toHaveLength(0);
    s = act(s, {
      type: "COMMIT_LINE_PLACEMENT",
      start: { x: 10, y: 50 },
      end: { x: 90, y: 50 },
      count: 5,
      spacing: 0,
    });
    expect(s.seats).toHaveLength(5);
    expect(s.seats[0]!.position.x).toBeCloseTo(10);
    expect(s.seats[4]!.position.x).toBeCloseTo(90);
    for (const seat of s.seats) {
      expect(seat.position.y).toBeCloseTo(50);
      expect(seat.row).toBe("A");
    }
    // Seat numbers are sequential
    expect(s.seats.map((st) => st.seat)).toEqual(["1", "2", "3", "4", "5"]);
    // Auto-row advance: nextSeatNumber resets and row moves to "B"
    expect(s.nextSeatNumber).toBe(1);
    expect(s.currentRow).toBe("B");
  });

  it("line placement pushes undo", () => {
    let s = stateWithSection();
    const undoBefore = s.undoStack.length;
    s = act(s, {
      type: "COMMIT_LINE_PLACEMENT",
      start: { x: 10, y: 10 },
      end: { x: 90, y: 10 },
      count: 3,
      spacing: 0,
    });
    expect(s.undoStack.length).toBe(undoBefore + 1);
  });

  it("line placement clears preview", () => {
    let s = stateWithSection();
    s = act(s, {
      type: "SET_PLACEMENT_PREVIEW",
      preview: {
        kind: "line",
        start: { x: 0, y: 0 },
        end: { x: 50, y: 0 },
        count: 3,
      },
    });
    s = act(s, {
      type: "COMMIT_LINE_PLACEMENT",
      start: { x: 10, y: 10 },
      end: { x: 90, y: 10 },
      count: 3,
      spacing: 0,
    });
    expect(s.placementPreview).toBeNull();
  });

  it("line placement skips seats outside section polygon", () => {
    let s = stateWithSection();
    // Line extends outside the 0-200 section
    s = act(s, {
      type: "COMMIT_LINE_PLACEMENT",
      start: { x: -50, y: 50 },
      end: { x: 250, y: 50 },
      count: 7,
      spacing: 0,
    });
    // Only seats inside 0..200 should be placed
    expect(s.seats.length).toBeGreaterThan(0);
    expect(s.seats.length).toBeLessThan(7);
    for (const seat of s.seats) {
      expect(seat.position.x).toBeGreaterThanOrEqual(0);
      expect(seat.position.x).toBeLessThanOrEqual(200);
    }
  });

  it("line placement is no-op without active section", () => {
    let s = initial;
    s = act(s, {
      type: "COMMIT_LINE_PLACEMENT",
      start: { x: 0, y: 0 },
      end: { x: 100, y: 0 },
      count: 5,
      spacing: 0,
    });
    expect(s.seats).toHaveLength(0);
  });

  // ── COMMIT_ARC_PLACEMENT ───────────────────────────────────────────────

  it("places seats along an arc", () => {
    let s = stateWithSection();
    s = act(s, {
      type: "COMMIT_ARC_PLACEMENT",
      center: { x: 100, y: 100 },
      radius: 50,
      startAngle: -Math.PI / 2,
      endAngle: Math.PI / 2,
      count: 3,
      spacing: 0,
    });
    expect(s.seats).toHaveLength(3);
    // First seat at angle -PI/2: (100, 50)
    expect(s.seats[0]!.position.x).toBeCloseTo(100, 0);
    expect(s.seats[0]!.position.y).toBeCloseTo(50, 0);
    // Last seat at angle PI/2: (100, 150)
    expect(s.seats[2]!.position.x).toBeCloseTo(100, 0);
    expect(s.seats[2]!.position.y).toBeCloseTo(150, 0);
  });

  it("arc placement pushes undo", () => {
    let s = stateWithSection();
    const undoBefore = s.undoStack.length;
    s = act(s, {
      type: "COMMIT_ARC_PLACEMENT",
      center: { x: 100, y: 100 },
      radius: 50,
      startAngle: 0,
      endAngle: Math.PI,
      count: 3,
      spacing: 0,
    });
    expect(s.undoStack.length).toBe(undoBefore + 1);
  });

  // ── COMMIT_GRID_PLACEMENT ─────────────────────────────────────────────

  it("places seats in a grid", () => {
    let s = stateWithSection();
    s = act(s, {
      type: "COMMIT_GRID_PLACEMENT",
      origin: { x: 10, y: 10 },
      extent: { x: 110, y: 60 },
      rows: 2,
      cols: 3,
      spacing: 0,
    });
    expect(s.seats).toHaveLength(6);
    // Row 0
    expect(s.seats[0]!.position.x).toBeCloseTo(10);
    expect(s.seats[0]!.position.y).toBeCloseTo(10);
    expect(s.seats[2]!.position.x).toBeCloseTo(110);
    expect(s.seats[2]!.position.y).toBeCloseTo(10);
    // Row 1
    expect(s.seats[3]!.position.x).toBeCloseTo(10);
    expect(s.seats[3]!.position.y).toBeCloseTo(60);
    expect(s.seats[5]!.position.x).toBeCloseTo(110);
    expect(s.seats[5]!.position.y).toBeCloseTo(60);
  });

  it("grid placement skips seats outside section polygon", () => {
    let s = stateWithSection();
    // Grid extends outside the 0-200 section boundary
    s = act(s, {
      type: "COMMIT_GRID_PLACEMENT",
      origin: { x: -50, y: -50 },
      extent: { x: 250, y: 250 },
      rows: 4,
      cols: 4,
      spacing: 0,
    });
    expect(s.seats.length).toBeGreaterThan(0);
    expect(s.seats.length).toBeLessThan(16);
    for (const seat of s.seats) {
      expect(seat.position.x).toBeGreaterThanOrEqual(0);
      expect(seat.position.x).toBeLessThanOrEqual(200);
      expect(seat.position.y).toBeGreaterThanOrEqual(0);
      expect(seat.position.y).toBeLessThanOrEqual(200);
    }
  });

  it("grid placement pushes undo", () => {
    let s = stateWithSection();
    const undoBefore = s.undoStack.length;
    s = act(s, {
      type: "COMMIT_GRID_PLACEMENT",
      origin: { x: 10, y: 10 },
      extent: { x: 60, y: 60 },
      rows: 2,
      cols: 2,
      spacing: 0,
    });
    expect(s.undoStack.length).toBe(undoBefore + 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper to create state with one section + 3 seats
// ─────────────────────────────────────────────────────────────────────────────

function createStateWithSeats(): DesignerState {
  resetSectionCounter();
  let s = createInitialState();
  s = designerReducer(s, { type: "SET_TOOL", tool: "draw_section" });
  s = designerReducer(s, { type: "ADD_POLYGON_POINT", point: { x: 0, y: 0 } });
  s = designerReducer(s, {
    type: "ADD_POLYGON_POINT",
    point: { x: 100, y: 0 },
  });
  s = designerReducer(s, {
    type: "ADD_POLYGON_POINT",
    point: { x: 100, y: 100 },
  });
  s = designerReducer(s, { type: "CLOSE_POLYGON", color: "#4A90D2" });
  // Now in place_seat mode with active section
  s = designerReducer(s, { type: "PLACE_SEAT", position: { x: 10, y: 10 } });
  s = designerReducer(s, { type: "PLACE_SEAT", position: { x: 20, y: 10 } });
  s = designerReducer(s, { type: "PLACE_SEAT", position: { x: 30, y: 10 } });
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// MERGE_DETECTED
// ─────────────────────────────────────────────────────────────────────────────

describe("designerReducer — MERGE_DETECTED", () => {
  const act = (s: DesignerState, a: DesignerAction) => designerReducer(s, a);

  it("merges detected sections and seats into existing state", () => {
    const initial = createStateWithSeats();
    const existingSections = initial.sections.length;
    const existingSeats = initial.seats.length;

    const newSections: DesignerSection[] = [
      {
        sectionId: "det-1",
        label: "Detected Section 1",
        color: "#FF0000",
        polygon: [
          { x: 300, y: 0 },
          { x: 400, y: 0 },
          { x: 400, y: 100 },
          { x: 300, y: 100 },
        ],
        kind: "seat",
      },
    ];

    const newSeats: DesignerSeat[] = [
      {
        id: "det-seat-1",
        sectionId: "det-1",
        row: "A",
        seat: "1",
        position: { x: 350, y: 50 },
        radius: 4,
        rotationDeg: 0,
      },
      {
        id: "det-seat-2",
        sectionId: "det-1",
        row: "A",
        seat: "2",
        position: { x: 370, y: 50 },
        radius: 4,
        rotationDeg: 0,
      },
    ];

    const merged = act(initial, {
      type: "MERGE_DETECTED",
      sections: newSections,
      seats: newSeats,
    });

    expect(merged.sections).toHaveLength(existingSections + 1);
    expect(merged.seats).toHaveLength(existingSeats + 2);
    // Original sections are preserved
    expect(merged.sections[0]).toEqual(initial.sections[0]);
    // New section is appended
    expect(merged.sections[existingSections]!.sectionId).toBe("det-1");
  });

  it("pushes undo before merging", () => {
    const initial = createStateWithSeats();
    const undoBefore = initial.undoStack.length;

    const merged = act(initial, {
      type: "MERGE_DETECTED",
      sections: [],
      seats: [],
    });

    expect(merged.undoStack.length).toBe(undoBefore + 1);
  });

  it("preserves existing seats and sections when adding empty detection", () => {
    const initial = createStateWithSeats();
    const merged = act(initial, {
      type: "MERGE_DETECTED",
      sections: [],
      seats: [],
    });

    expect(merged.sections).toEqual(initial.sections);
    expect(merged.seats).toEqual(initial.seats);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Spacing-aware geometry helpers
// ─────────────────────────────────────────────────────────────────────────────

describe("computeLinePositionsWithSpacing", () => {
  it("returns empty array when spacing is 0", () => {
    const pts = computeLinePositionsWithSpacing(
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      0,
    );
    expect(pts).toHaveLength(0);
  });

  it("returns single point when start equals end", () => {
    const pts = computeLinePositionsWithSpacing(
      { x: 50, y: 50 },
      { x: 50, y: 50 },
      10,
    );
    expect(pts).toHaveLength(1);
    expect(pts[0]).toEqual({ x: 50, y: 50 });
  });

  it("places seats at fixed intervals along a horizontal line", () => {
    // Line from (0,0) to (100,0) with spacing 25 → seats at 0,25,50,75,100
    const pts = computeLinePositionsWithSpacing(
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      25,
    );
    expect(pts).toHaveLength(5);
    expect(pts[0]!.x).toBeCloseTo(0);
    expect(pts[1]!.x).toBeCloseTo(25);
    expect(pts[2]!.x).toBeCloseTo(50);
    expect(pts[3]!.x).toBeCloseTo(75);
    expect(pts[4]!.x).toBeCloseTo(100);
    for (const p of pts) expect(p.y).toBeCloseTo(0);
  });

  it("does not exceed the endpoint", () => {
    // Line of length 100, spacing 30 → seats at 0,30,60,90 (next would be 120 > 100)
    const pts = computeLinePositionsWithSpacing(
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      30,
    );
    expect(pts).toHaveLength(4);
    expect(pts[3]!.x).toBeCloseTo(90);
  });

  it("returns only start when spacing exceeds distance", () => {
    const pts = computeLinePositionsWithSpacing(
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      50,
    );
    expect(pts).toHaveLength(1);
    expect(pts[0]!.x).toBeCloseTo(0);
  });
});

describe("computeArcPositionsWithSpacing", () => {
  it("returns empty array when spacing is 0", () => {
    const pts = computeArcPositionsWithSpacing(
      { x: 0, y: 0 },
      50,
      0,
      Math.PI,
      0,
    );
    expect(pts).toHaveLength(0);
  });

  it("returns empty array when radius is 0", () => {
    const pts = computeArcPositionsWithSpacing(
      { x: 0, y: 0 },
      0,
      0,
      Math.PI,
      10,
    );
    expect(pts).toHaveLength(0);
  });

  it("places seats along an arc with fixed arc-length spacing", () => {
    const center = { x: 0, y: 0 };
    const radius = 100;
    // Half-circle: arc length = π*100 ≈ 314.16
    // Spacing 100 → seats at arc-distances 0, 100, 200, 300 → 4 seats
    const pts = computeArcPositionsWithSpacing(center, radius, 0, Math.PI, 100);
    expect(pts.length).toBeGreaterThanOrEqual(3);
    expect(pts.length).toBeLessThanOrEqual(4);
    // First point should be at angle 0 → (100, 0)
    expect(pts[0]!.x).toBeCloseTo(100);
    expect(pts[0]!.y).toBeCloseTo(0);
  });

  it("all points sit on the circle", () => {
    const center = { x: 50, y: 50 };
    const radius = 40;
    const pts = computeArcPositionsWithSpacing(center, radius, 0, Math.PI, 20);
    for (const p of pts) {
      const d = Math.sqrt((p.x - center.x) ** 2 + (p.y - center.y) ** 2);
      expect(d).toBeCloseTo(radius, 5);
    }
  });
});

describe("computeGridPositionsWithSpacing", () => {
  it("returns empty when spacing is 0", () => {
    const pts = computeGridPositionsWithSpacing(
      { x: 0, y: 0 },
      { x: 100, y: 100 },
      3,
      3,
      0,
    );
    expect(pts).toHaveLength(0);
  });

  it("returns empty when rows or cols is 0", () => {
    expect(
      computeGridPositionsWithSpacing(
        { x: 0, y: 0 },
        { x: 100, y: 100 },
        0,
        3,
        10,
      ),
    ).toHaveLength(0);
    expect(
      computeGridPositionsWithSpacing(
        { x: 0, y: 0 },
        { x: 100, y: 100 },
        3,
        0,
        10,
      ),
    ).toHaveLength(0);
  });

  it("creates a grid with correct number of points", () => {
    const pts = computeGridPositionsWithSpacing(
      { x: 0, y: 0 },
      { x: 100, y: 100 },
      3,
      4,
      20,
    );
    expect(pts).toHaveLength(12); // 3 * 4
  });

  it("spaces points correctly in both axes", () => {
    const pts = computeGridPositionsWithSpacing(
      { x: 10, y: 10 },
      { x: 100, y: 100 },
      2,
      3,
      25,
    );
    // Row 0: (10,10), (35,10), (60,10)
    // Row 1: (10,35), (35,35), (60,35)
    expect(pts[0]).toEqual({ x: 10, y: 10 });
    expect(pts[1]).toEqual({ x: 35, y: 10 });
    expect(pts[2]).toEqual({ x: 60, y: 10 });
    expect(pts[3]).toEqual({ x: 10, y: 35 });
    expect(pts[4]).toEqual({ x: 35, y: 35 });
    expect(pts[5]).toEqual({ x: 60, y: 35 });
  });

  it("respects direction from extent", () => {
    // extent to the left and above origin → negative direction
    const pts = computeGridPositionsWithSpacing(
      { x: 100, y: 100 },
      { x: 0, y: 0 },
      2,
      2,
      20,
    );
    expect(pts[0]).toEqual({ x: 100, y: 100 });
    expect(pts[1]).toEqual({ x: 80, y: 100 });
    expect(pts[2]).toEqual({ x: 100, y: 80 });
    expect(pts[3]).toEqual({ x: 80, y: 80 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Placement groups
// ─────────────────────────────────────────────────────────────────────────────

describe("designerReducer — placement groups", () => {
  let initial: DesignerState;

  beforeEach(() => {
    resetSectionCounter();
    resetGroupCounter();
    initial = createInitialState();
  });

  function stateWithSection(): DesignerState {
    return acts(
      initial,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 200, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 200, y: 200 } },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 200 } },
      { type: "CLOSE_POLYGON", color: "#4A90D2" },
    );
  }

  it("COMMIT_LINE_PLACEMENT creates a placement group", () => {
    let s = stateWithSection();
    s = act(s, {
      type: "COMMIT_LINE_PLACEMENT",
      start: { x: 10, y: 50 },
      end: { x: 90, y: 50 },
      count: 5,
      spacing: 0,
    });
    expect(s.placementGroups).toHaveLength(1);
    const g = s.placementGroups[0]!;
    expect(g.kind).toBe("line");
    if (g.kind !== "line") throw new Error("expected line placement group");
    expect(g.seatIds).toHaveLength(5);
    expect(g.count).toBe(5);
    // Every seatId in the group should exist in the seats array
    for (const id of g.seatIds) {
      expect(s.seats.find((seat) => seat.id === id)).toBeDefined();
    }
  });

  it("COMMIT_ARC_PLACEMENT creates a placement group", () => {
    let s = stateWithSection();
    s = act(s, {
      type: "COMMIT_ARC_PLACEMENT",
      center: { x: 100, y: 100 },
      radius: 50,
      startAngle: 0,
      endAngle: Math.PI,
      count: 6,
      spacing: 0,
    });
    expect(s.placementGroups).toHaveLength(1);
    const g = s.placementGroups[0]!;
    expect(g.kind).toBe("arc");
    expect(g.seatIds).toHaveLength(6);
  });

  it("COMMIT_GRID_PLACEMENT creates a placement group", () => {
    let s = stateWithSection();
    s = act(s, {
      type: "COMMIT_GRID_PLACEMENT",
      origin: { x: 10, y: 10 },
      extent: { x: 190, y: 190 },
      rows: 2,
      cols: 3,
      spacing: 0,
    });
    expect(s.placementGroups).toHaveLength(1);
    const g = s.placementGroups[0]!;
    expect(g.kind).toBe("grid");
    expect(g.seatIds).toHaveLength(6);
  });

  it("multiple commits create multiple groups", () => {
    let s = stateWithSection();
    s = act(s, {
      type: "COMMIT_LINE_PLACEMENT",
      start: { x: 10, y: 50 },
      end: { x: 90, y: 50 },
      count: 3,
      spacing: 0,
    });
    s = act(s, {
      type: "COMMIT_LINE_PLACEMENT",
      start: { x: 10, y: 100 },
      end: { x: 90, y: 100 },
      count: 4,
      spacing: 0,
    });
    expect(s.placementGroups).toHaveLength(2);
    expect(s.seats).toHaveLength(7);
    expect(s.placementGroups[0]!.seatIds).toHaveLength(3);
    expect(s.placementGroups[1]!.seatIds).toHaveLength(4);
  });

  it("DELETE_PLACEMENT_GROUP removes the group and its seats", () => {
    let s = stateWithSection();
    s = act(s, {
      type: "COMMIT_LINE_PLACEMENT",
      start: { x: 10, y: 50 },
      end: { x: 90, y: 50 },
      count: 5,
      spacing: 0,
    });
    const groupId = s.placementGroups[0]!.id;
    expect(s.seats).toHaveLength(5);

    s = act(s, { type: "DELETE_PLACEMENT_GROUP", groupId });
    expect(s.placementGroups).toHaveLength(0);
    expect(s.seats).toHaveLength(0);
  });

  it("DELETE_PLACEMENT_GROUP only removes that group's seats", () => {
    let s = stateWithSection();
    // Add two groups
    s = act(s, {
      type: "COMMIT_LINE_PLACEMENT",
      start: { x: 10, y: 50 },
      end: { x: 90, y: 50 },
      count: 3,
      spacing: 0,
    });
    s = act(s, {
      type: "COMMIT_LINE_PLACEMENT",
      start: { x: 10, y: 100 },
      end: { x: 90, y: 100 },
      count: 4,
      spacing: 0,
    });
    const firstGroupId = s.placementGroups[0]!.id;
    expect(s.seats).toHaveLength(7);

    s = act(s, { type: "DELETE_PLACEMENT_GROUP", groupId: firstGroupId });
    expect(s.placementGroups).toHaveLength(1);
    expect(s.seats).toHaveLength(4);
  });

  it("SELECT_PLACEMENT_GROUP sets selectedPlacementGroupId", () => {
    let s = stateWithSection();
    s = act(s, {
      type: "COMMIT_LINE_PLACEMENT",
      start: { x: 10, y: 50 },
      end: { x: 90, y: 50 },
      count: 3,
      spacing: 0,
    });
    const groupId = s.placementGroups[0]!.id;
    s = act(s, { type: "SELECT_PLACEMENT_GROUP", groupId });
    expect(s.selectedPlacementGroupId).toBe(groupId);

    s = act(s, { type: "SELECT_PLACEMENT_GROUP", groupId: null });
    expect(s.selectedPlacementGroupId).toBeNull();
  });

  it("COMMIT_LINE_PLACEMENT with spacing creates seats using fixed spacing", () => {
    let s = stateWithSection();
    // Line of length 100, spacing 25 → 5 seats
    s = act(s, {
      type: "COMMIT_LINE_PLACEMENT",
      start: { x: 10, y: 50 },
      end: { x: 110, y: 50 },
      count: 999, // count is ignored when spacing > 0
      spacing: 25,
    });
    expect(s.seats).toHaveLength(5);
    expect(s.seats[0]!.position.x).toBeCloseTo(10);
    expect(s.seats[1]!.position.x).toBeCloseTo(35);
    expect(s.seats[4]!.position.x).toBeCloseTo(110);
    const g = s.placementGroups[0]!;
    if (g.kind !== "line") throw new Error("expected line placement group");
    expect(g.spacing).toBe(25);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SET_BATCH_SPACING
// ─────────────────────────────────────────────────────────────────────────────

describe("designerReducer — SET_BATCH_SPACING", () => {
  let initial: DesignerState;

  beforeEach(() => {
    resetSectionCounter();
    resetGroupCounter();
    initial = createInitialState();
  });

  it("sets batch spacing (clamped to >= 0)", () => {
    let s = act(initial, { type: "SET_BATCH_SPACING", spacing: 30 });
    expect(s.batchSpacing).toBe(30);
    s = act(s, { type: "SET_BATCH_SPACING", spacing: 0 });
    expect(s.batchSpacing).toBe(0);
    s = act(s, { type: "SET_BATCH_SPACING", spacing: -10 });
    expect(s.batchSpacing).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Box Section Tool
// ─────────────────────────────────────────────────────────────────────────────

describe("designerReducer — box section", () => {
  let initial: DesignerState;

  beforeEach(() => {
    resetSectionCounter();
    resetGroupCounter();
    resetStrokeCounter();
    initial = createInitialState();
  });

  it("SET_BOX_SECTION_START stores the start point", () => {
    const s = act(initial, {
      type: "SET_BOX_SECTION_START",
      point: { x: 10, y: 20 },
    });
    expect(s.boxSectionStart).toEqual({ x: 10, y: 20 });
  });

  it("COMMIT_BOX_SECTION creates a rectangular section", () => {
    let s = act(initial, {
      type: "SET_BOX_SECTION_START",
      point: { x: 0, y: 0 },
    });
    s = act(s, {
      type: "COMMIT_BOX_SECTION",
      corner: { x: 50, y: 30 },
      color: "#FF0000",
    });
    expect(s.sections).toHaveLength(1);
    expect(s.sections[0]!.polygon).toHaveLength(4);
    expect(s.sections[0]!.color).toBe("#FF0000");
    expect(s.boxSectionStart).toBeNull();
    expect(s.undoStack.length).toBeGreaterThan(0);
  });

  it("COMMIT_BOX_SECTION rejects rectangles smaller than 5x5", () => {
    let s = act(initial, {
      type: "SET_BOX_SECTION_START",
      point: { x: 0, y: 0 },
    });
    s = act(s, {
      type: "COMMIT_BOX_SECTION",
      corner: { x: 3, y: 3 },
      color: "#FF0000",
    });
    expect(s.sections).toHaveLength(0);
    expect(s.boxSectionStart).toBeNull();
  });

  it("COMMIT_BOX_SECTION auto-switches to place_seat for seat-kind sections", () => {
    const s = acts(
      initial,
      { type: "SET_DRAWING_SECTION_KIND", sectionKind: "seat" },
      { type: "SET_BOX_SECTION_START", point: { x: 0, y: 0 } },
      {
        type: "COMMIT_BOX_SECTION",
        corner: { x: 50, y: 50 },
        color: "#00FF00",
      },
    );
    expect(s.activeTool).toBe("place_seat");
    expect(s.activeSectionId).toBe(s.sections[0]!.sectionId);
  });

  it("COMMIT_BOX_SECTION does NOT auto-switch for helper sections", () => {
    const s = acts(
      initial,
      { type: "SET_DRAWING_SECTION_KIND", sectionKind: "helper" },
      { type: "SET_TOOL", tool: "draw_box_section" },
      { type: "SET_BOX_SECTION_START", point: { x: 0, y: 0 } },
      {
        type: "COMMIT_BOX_SECTION",
        corner: { x: 50, y: 50 },
        color: "#00FF00",
      },
    );
    expect(s.activeTool).toBe("draw_box_section");
  });

  it("CANCEL_BOX_SECTION clears the start point", () => {
    let s = act(initial, {
      type: "SET_BOX_SECTION_START",
      point: { x: 10, y: 20 },
    });
    s = act(s, { type: "CANCEL_BOX_SECTION" });
    expect(s.boxSectionStart).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stroke Tool
// ─────────────────────────────────────────────────────────────────────────────

describe("designerReducer — stroke tool", () => {
  let initial: DesignerState;

  beforeEach(() => {
    resetSectionCounter();
    resetGroupCounter();
    resetStrokeCounter();
    initial = createInitialState();
  });

  it("ADD_STROKE_POINT accumulates points", () => {
    const s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_stroke" },
      { type: "ADD_STROKE_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_STROKE_POINT", point: { x: 10, y: 10 } },
      { type: "ADD_STROKE_POINT", point: { x: 20, y: 20 } },
    );
    expect(s.drawingStrokePoints).toHaveLength(3);
  });

  it("COMMIT_STROKE creates a stroke and clears drawing points", () => {
    const s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_stroke" },
      { type: "ADD_STROKE_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_STROKE_POINT", point: { x: 10, y: 10 } },
      { type: "ADD_STROKE_POINT", point: { x: 50, y: 50 } },
      { type: "COMMIT_STROKE" },
    );
    expect(s.strokes).toHaveLength(1);
    expect(s.strokes[0]!.points.length).toBeGreaterThanOrEqual(2);
    expect(s.drawingStrokePoints).toHaveLength(0);
    expect(s.undoStack.length).toBeGreaterThan(0);
  });

  it("COMMIT_STROKE is a no-op with fewer than 2 points", () => {
    const s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_stroke" },
      { type: "ADD_STROKE_POINT", point: { x: 0, y: 0 } },
      { type: "COMMIT_STROKE" },
    );
    expect(s.strokes).toHaveLength(0);
    // drawingStrokePoints is NOT cleared since COMMIT_STROKE is a no-op
    expect(s.drawingStrokePoints).toHaveLength(1);
  });

  it("CANCEL_STROKE clears drawing points without creating a stroke", () => {
    const s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_stroke" },
      { type: "ADD_STROKE_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_STROKE_POINT", point: { x: 10, y: 10 } },
      { type: "CANCEL_STROKE" },
    );
    expect(s.strokes).toHaveLength(0);
    expect(s.drawingStrokePoints).toHaveLength(0);
  });

  it("SET_STROKE_COLOR updates the default stroke color", () => {
    const s = act(initial, { type: "SET_STROKE_COLOR", color: "#FF0000" });
    expect(s.strokeColor).toBe("#FF0000");
  });

  it("SET_STROKE_WIDTH updates the default stroke width", () => {
    const s = act(initial, { type: "SET_STROKE_WIDTH", width: 5 });
    expect(s.strokeWidth).toBe(5);
  });

  it("SELECT_STROKE selects a stroke", () => {
    let s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_stroke" },
      { type: "ADD_STROKE_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_STROKE_POINT", point: { x: 50, y: 50 } },
      { type: "COMMIT_STROKE" },
    );
    const strokeId = s.strokes[0]!.id;
    s = act(s, { type: "SELECT_STROKE", strokeId, additive: false });
    expect(s.selectedStrokeIds.has(strokeId)).toBe(true);
    expect(s.selectedSeatIds.size).toBe(0);
    expect(s.selectedSectionIds.size).toBe(0);
  });

  it("DELETE_STROKE removes a stroke", () => {
    let s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_stroke" },
      { type: "ADD_STROKE_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_STROKE_POINT", point: { x: 50, y: 50 } },
      { type: "COMMIT_STROKE" },
    );
    const strokeId = s.strokes[0]!.id;
    s = act(s, { type: "DELETE_STROKE", strokeId });
    expect(s.strokes).toHaveLength(0);
    expect(s.undoStack.length).toBeGreaterThan(0);
  });

  it("DELETE_SELECTED removes selected strokes", () => {
    let s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_stroke" },
      { type: "ADD_STROKE_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_STROKE_POINT", point: { x: 50, y: 50 } },
      { type: "COMMIT_STROKE" },
    );
    const strokeId = s.strokes[0]!.id;
    s = act(s, { type: "SELECT_STROKE", strokeId, additive: false });
    s = act(s, { type: "DELETE_SELECTED" });
    expect(s.strokes).toHaveLength(0);
  });

  it("MOVE_SELECTED_STROKES translates selected strokes", () => {
    let s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_stroke" },
      { type: "ADD_STROKE_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_STROKE_POINT", point: { x: 50, y: 50 } },
      { type: "COMMIT_STROKE" },
    );
    const strokeId = s.strokes[0]!.id;
    const origX = s.strokes[0]!.points[0]!.position.x;
    s = act(s, { type: "SELECT_STROKE", strokeId, additive: false });
    s = act(s, { type: "MOVE_SELECTED_STROKES", dx: 10, dy: 20 });
    expect(s.strokes[0]!.points[0]!.position.x).toBeCloseTo(origX + 10);
    expect(s.strokes[0]!.points[0]!.position.y).toBeCloseTo(20);
  });

  it("undo/redo works for stroke creation", () => {
    let s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_stroke" },
      { type: "ADD_STROKE_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_STROKE_POINT", point: { x: 50, y: 50 } },
      { type: "COMMIT_STROKE" },
    );
    expect(s.strokes).toHaveLength(1);
    s = act(s, { type: "UNDO" });
    expect(s.strokes).toHaveLength(0);
    s = act(s, { type: "REDO" });
    expect(s.strokes).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findStrokeAt helper
// ─────────────────────────────────────────────────────────────────────────────

describe("findStrokeAt", () => {
  it("finds a stroke near a point on the line segment", () => {
    const s = acts(
      createInitialState(),
      { type: "SET_TOOL", tool: "draw_stroke" },
      { type: "ADD_STROKE_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_STROKE_POINT", point: { x: 100, y: 0 } },
      { type: "COMMIT_STROKE" },
    );
    // Point on the line
    const hit = findStrokeAt(s.strokes, { x: 50, y: 0 }, 5);
    expect(hit).not.toBeNull();
    expect(hit!.id).toBe(s.strokes[0]!.id);
  });

  it("returns null when far from any stroke", () => {
    const s = acts(
      createInitialState(),
      { type: "SET_TOOL", tool: "draw_stroke" },
      { type: "ADD_STROKE_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_STROKE_POINT", point: { x: 100, y: 0 } },
      { type: "COMMIT_STROKE" },
    );
    const hit = findStrokeAt(s.strokes, { x: 50, y: 100 }, 5);
    expect(hit).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Seat visibility threshold
// ─────────────────────────────────────────────────────────────────────────────

describe("designerReducer — seat visibility threshold", () => {
  let initial: DesignerState;

  beforeEach(() => {
    resetSectionCounter();
    resetGroupCounter();
    resetStrokeCounter();
    initial = createInitialState();
  });

  it("has a default seat visibility threshold", () => {
    expect(initial.seatVisibilityThreshold).toBe(0.3);
  });

  it("SET_SEAT_VISIBILITY_THRESHOLD updates the threshold", () => {
    const s = act(initial, {
      type: "SET_SEAT_VISIBILITY_THRESHOLD",
      threshold: 0.5,
    });
    expect(s.seatVisibilityThreshold).toBe(0.5);
  });

  it("clamps threshold to valid range", () => {
    let s = act(initial, {
      type: "SET_SEAT_VISIBILITY_THRESHOLD",
      threshold: -1,
    });
    expect(s.seatVisibilityThreshold).toBeGreaterThanOrEqual(0);
    s = act(initial, { type: "SET_SEAT_VISIBILITY_THRESHOLD", threshold: 100 });
    expect(s.seatVisibilityThreshold).toBeLessThanOrEqual(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Action-based undo (UndoEntry)
// ─────────────────────────────────────────────────────────────────────────────

describe("designerReducer — action-based undo entries", () => {
  let initial: DesignerState;

  beforeEach(() => {
    resetSectionCounter();
    resetGroupCounter();
    resetStrokeCounter();
    initial = createInitialState();
  });

  it("undo entries have label, before, and after snapshots", () => {
    let s = createInitialState();
    s = acts(
      s,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 100 } },
      { type: "CLOSE_POLYGON", color: "#FF0000" },
    );
    expect(s.undoStack.length).toBeGreaterThan(0);
    const entry = s.undoStack[s.undoStack.length - 1]!;
    expect(entry).toHaveProperty("label");
    expect(entry).toHaveProperty("before");
    expect(entry).toHaveProperty("after");
    expect(entry.before.sections).toHaveLength(0);
    expect(entry.after.sections).toHaveLength(1);
  });

  it("undo restores the before snapshot", () => {
    let s = createInitialState();
    s = acts(
      s,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 100 } },
      { type: "CLOSE_POLYGON", color: "#FF0000" },
    );
    expect(s.sections).toHaveLength(1);
    s = act(s, { type: "UNDO" });
    expect(s.sections).toHaveLength(0);
  });

  it("redo restores the after snapshot", () => {
    let s = createInitialState();
    s = acts(
      s,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 100 } },
      { type: "CLOSE_POLYGON", color: "#FF0000" },
    );
    s = act(s, { type: "UNDO" });
    expect(s.sections).toHaveLength(0);
    s = act(s, { type: "REDO" });
    expect(s.sections).toHaveLength(1);
  });

  it("BEGIN_DRAG captures before snapshot and undo restores pre-drag state", () => {
    let s = createInitialState();
    // Create a section + seat
    s = acts(
      s,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 200, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 200, y: 200 } },
      { type: "CLOSE_POLYGON", color: "#FF0000" },
      { type: "PLACE_SEAT", position: { x: 50, y: 50 } },
    );
    const origX = s.seats[0]!.position.x;
    // Select + begin drag + move
    s = act(s, {
      type: "SELECT_SEAT",
      seatId: s.seats[0]!.id,
      additive: false,
    });
    s = act(s, { type: "BEGIN_DRAG" });
    s = act(s, { type: "MOVE_SELECTED_SEATS", dx: 20, dy: 0 });
    s = act(s, { type: "MOVE_SELECTED_SEATS", dx: 10, dy: 0 });
    expect(s.seats[0]!.position.x).toBeCloseTo(origX + 30);
    // Undo should restore to pre-drag
    s = act(s, { type: "UNDO" });
    expect(s.seats[0]!.position.x).toBeCloseTo(origX);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Arc tool refactor — move placement group + update arc geometry
// ─────────────────────────────────────────────────────────────────────────────
describe("designerReducer — arc tool refactor", () => {
  const initial = createInitialState();

  function stateWithArcGroup(): DesignerState {
    let s = initial;
    s = acts(
      s,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: -200, y: -200 } },
      { type: "ADD_POLYGON_POINT", point: { x: 400, y: -200 } },
      { type: "ADD_POLYGON_POINT", point: { x: 400, y: 400 } },
      { type: "ADD_POLYGON_POINT", point: { x: -200, y: 400 } },
      { type: "CLOSE_POLYGON", color: "#4A90D2" },
    );
    s = act(s, {
      type: "COMMIT_ARC_PLACEMENT",
      center: { x: 100, y: 100 },
      radius: 50,
      startAngle: -Math.PI / 2,
      endAngle: Math.PI / 2,
      count: 3,
      spacing: 0,
    });
    return s;
  }

  it("MOVE_PLACEMENT_GROUP translates arc center and seats", () => {
    let s = stateWithArcGroup();
    const group = s.placementGroups[0]!;
    expect(group.kind).toBe("arc");
    const origCenter = (group as { center: { x: number; y: number } }).center;
    const origSeatX = s.seats[0]!.position.x;

    s = act(s, {
      type: "MOVE_PLACEMENT_GROUP",
      groupId: group.id,
      dx: 30,
      dy: 20,
    });

    const movedGroup = s.placementGroups[0]!;
    expect(movedGroup.kind).toBe("arc");
    if (movedGroup.kind === "arc") {
      expect(movedGroup.center.x).toBeCloseTo(origCenter.x + 30);
      expect(movedGroup.center.y).toBeCloseTo(origCenter.y + 20);
    }
    // All seats should be translated
    expect(s.seats[0]!.position.x).toBeCloseTo(origSeatX + 30);
  });

  it("MOVE_PLACEMENT_GROUP is a no-op for unknown groupId", () => {
    const s = stateWithArcGroup();
    const result = act(s, {
      type: "MOVE_PLACEMENT_GROUP",
      groupId: "nonexistent",
      dx: 10,
      dy: 10,
    });
    expect(result).toBe(s);
  });

  it("UPDATE_ARC_GROUP_GEOMETRY updates radius and recalculates seats", () => {
    let s = stateWithArcGroup();
    const group = s.placementGroups[0]!;
    const origSeatCount = s.seats.length;

    s = act(s, {
      type: "UPDATE_ARC_GROUP_GEOMETRY",
      groupId: group.id,
      updates: { radius: 80 },
    });

    if (s.placementGroups[0]!.kind === "arc") {
      expect(s.placementGroups[0]!.radius).toBe(80);
    }
    // Same count, but recalculated positions
    expect(s.seats).toHaveLength(origSeatCount);
    // Verify seats are on the new radius — first seat at angle -PI/2
    // should be at (100, 100 - 80) = (100, 20)
    expect(s.seats[0]!.position.x).toBeCloseTo(100, 0);
    expect(s.seats[0]!.position.y).toBeCloseTo(20, 0);
  });

  it("UPDATE_ARC_GROUP_GEOMETRY updates angles and recalculates seats", () => {
    let s = stateWithArcGroup();
    const group = s.placementGroups[0]!;

    s = act(s, {
      type: "UPDATE_ARC_GROUP_GEOMETRY",
      groupId: group.id,
      updates: { startAngle: 0, endAngle: Math.PI },
    });

    if (s.placementGroups[0]!.kind === "arc") {
      expect(s.placementGroups[0]!.startAngle).toBe(0);
      expect(s.placementGroups[0]!.endAngle).toBe(Math.PI);
    }
    // 3 seats on a half-circle from 0 to PI
    // First seat at angle 0: (150, 100)
    expect(s.seats[0]!.position.x).toBeCloseTo(150, 0);
    expect(s.seats[0]!.position.y).toBeCloseTo(100, 0);
  });

  it("UPDATE_ARC_GROUP_GEOMETRY is a no-op for non-arc group", () => {
    let s = initial;
    s = acts(
      s,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 200, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 200, y: 200 } },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 200 } },
      { type: "CLOSE_POLYGON", color: "#4A90D2" },
    );
    s = act(s, {
      type: "COMMIT_LINE_PLACEMENT",
      start: { x: 10, y: 10 },
      end: { x: 190, y: 10 },
      count: 3,
      spacing: 0,
    });
    const group = s.placementGroups[0]!;
    expect(group.kind).toBe("line");

    const result = act(s, {
      type: "UPDATE_ARC_GROUP_GEOMETRY",
      groupId: group.id,
      updates: { radius: 999 },
    });
    expect(result).toBe(s); // no-op
  });

  it("MOVE_PLACEMENT_GROUP works for line groups too", () => {
    let s = initial;
    s = acts(
      s,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: -100, y: -100 } },
      { type: "ADD_POLYGON_POINT", point: { x: 300, y: -100 } },
      { type: "ADD_POLYGON_POINT", point: { x: 300, y: 300 } },
      { type: "ADD_POLYGON_POINT", point: { x: -100, y: 300 } },
      { type: "CLOSE_POLYGON", color: "#4A90D2" },
    );
    s = act(s, {
      type: "COMMIT_LINE_PLACEMENT",
      start: { x: 10, y: 10 },
      end: { x: 110, y: 10 },
      count: 3,
      spacing: 0,
    });
    const group = s.placementGroups[0]!;
    const origSeatX = s.seats[0]!.position.x;

    s = act(s, {
      type: "MOVE_PLACEMENT_GROUP",
      groupId: group.id,
      dx: 15,
      dy: 25,
    });

    if (s.placementGroups[0]!.kind === "line") {
      expect(s.placementGroups[0]!.start.x).toBeCloseTo(25);
      expect(s.placementGroups[0]!.start.y).toBeCloseTo(35);
    }
    expect(s.seats[0]!.position.x).toBeCloseTo(origSeatX + 15);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Arc arcDeg / rotationDeg — circle tool conversion
// ─────────────────────────────────────────────────────────────────────────────

describe("designerReducer — arc arcDeg/rotationDeg", () => {
  let initial: DesignerState;

  beforeEach(() => {
    resetSectionCounter();
    resetGroupCounter();
    initial = createInitialState();
  });

  function makeArcState(): DesignerState {
    let s = initial;
    s = acts(
      s,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: -200, y: -200 } },
      { type: "ADD_POLYGON_POINT", point: { x: 400, y: -200 } },
      { type: "ADD_POLYGON_POINT", point: { x: 400, y: 400 } },
      { type: "ADD_POLYGON_POINT", point: { x: -200, y: 400 } },
      { type: "CLOSE_POLYGON", color: "#4A90D2" },
    );
    s = act(s, {
      type: "COMMIT_ARC_PLACEMENT",
      center: { x: 100, y: 100 },
      radius: 50,
      startAngle: 0,
      endAngle: Math.PI,
      count: 5,
      spacing: 0,
    });
    return s;
  }

  it("setting arcDeg derives start/end angles from rotationDeg + arcDeg", () => {
    let s = makeArcState();
    const group = s.placementGroups[0]!;

    // Set arcDeg to 360 (full circle), rotation stays 0
    s = act(s, {
      type: "UPDATE_ARC_GROUP_GEOMETRY",
      groupId: group.id,
      updates: { arcDeg: 360 },
    });

    if (s.placementGroups[0]!.kind === "arc") {
      const g = s.placementGroups[0]!;
      expect(g.arcDeg).toBe(360);
      expect(g.rotationDeg).toBe(0);
      expect(g.startAngle).toBeCloseTo(0);
      expect(g.endAngle).toBeCloseTo(2 * Math.PI);
    }
  });

  it("setting rotationDeg rotates the arc about its center", () => {
    let s = makeArcState();
    const group = s.placementGroups[0]!;

    // Rotate 90 degrees
    s = act(s, {
      type: "UPDATE_ARC_GROUP_GEOMETRY",
      groupId: group.id,
      updates: { rotationDeg: 90 },
    });

    if (s.placementGroups[0]!.kind === "arc") {
      const g = s.placementGroups[0]!;
      expect(g.rotationDeg).toBe(90);
      expect(g.startAngle).toBeCloseTo(Math.PI / 2); // 90° in radians
      expect(g.endAngle).toBeCloseTo(Math.PI / 2 + (g.arcDeg * Math.PI) / 180);
    }
  });

  it("setting both arcDeg and rotationDeg together", () => {
    let s = makeArcState();
    const group = s.placementGroups[0]!;

    s = act(s, {
      type: "UPDATE_ARC_GROUP_GEOMETRY",
      groupId: group.id,
      updates: { arcDeg: 270, rotationDeg: 45 },
    });

    if (s.placementGroups[0]!.kind === "arc") {
      const g = s.placementGroups[0]!;
      expect(g.arcDeg).toBe(270);
      expect(g.rotationDeg).toBe(45);
      expect(g.startAngle).toBeCloseTo((45 * Math.PI) / 180);
      expect(g.endAngle).toBeCloseTo(((45 + 270) * Math.PI) / 180);
    }
  });

  it("raw startAngle/endAngle update still works (backward compat)", () => {
    let s = makeArcState();
    const group = s.placementGroups[0]!;

    s = act(s, {
      type: "UPDATE_ARC_GROUP_GEOMETRY",
      groupId: group.id,
      updates: { startAngle: Math.PI / 4, endAngle: (Math.PI * 3) / 4 },
    });

    if (s.placementGroups[0]!.kind === "arc") {
      const g = s.placementGroups[0]!;
      expect(g.startAngle).toBeCloseTo(Math.PI / 4);
      expect(g.endAngle).toBeCloseTo((Math.PI * 3) / 4);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// END_DRAG — no-op cleanup and finalization
// ─────────────────────────────────────────────────────────────────────────────

describe("designerReducer — END_DRAG", () => {
  let initial: DesignerState;

  beforeEach(() => {
    resetSectionCounter(0);
    resetGroupCounter(0);
    resetStrokeCounter(0);
    initial = createInitialState();
  });

  it("removes no-op drag undo entry when nothing moved", () => {
    let s = initial;
    s = acts(
      s,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 100 } },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 100 } },
      { type: "CLOSE_POLYGON", color: "#4A90D2" },
      { type: "PLACE_SEAT", position: { x: 50, y: 50 } },
    );

    const undoDepthBefore = s.undoStack.length;
    // BEGIN_DRAG adds an entry
    s = act(s, { type: "BEGIN_DRAG" });
    expect(s.undoStack.length).toBe(undoDepthBefore + 1);

    // END_DRAG without any movement removes the no-op entry
    s = act(s, { type: "END_DRAG" });
    expect(s.undoStack.length).toBe(undoDepthBefore);
  });

  it("finalizes drag undo entry when something moved", () => {
    let s = initial;
    s = acts(
      s,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 200, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 200, y: 200 } },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 200 } },
      { type: "CLOSE_POLYGON", color: "#4A90D2" },
      { type: "PLACE_SEAT", position: { x: 50, y: 50 } },
    );

    const undoDepthBefore = s.undoStack.length;
    s = act(s, {
      type: "SELECT_SEAT",
      seatId: s.seats[0]!.id,
      additive: false,
    });
    s = act(s, { type: "BEGIN_DRAG" });
    s = act(s, { type: "MOVE_SELECTED_SEATS", dx: 20, dy: 30 });
    s = act(s, { type: "END_DRAG" });

    // Drag entry stays on stack since something actually moved
    expect(s.undoStack.length).toBe(undoDepthBefore + 1);
    // The finalized entry has after snapshot reflecting the new position
    const lastEntry = s.undoStack[s.undoStack.length - 1]!;
    expect(lastEntry.label).toBe("Drag");
    expect(lastEntry.after.seats[0]!.position.x).toBeCloseTo(70);
    expect(lastEntry.after.seats[0]!.position.y).toBeCloseTo(80);
  });

  it("is a no-op when undo stack is empty", () => {
    const result = act(initial, { type: "END_DRAG" });
    expect(result).toBe(initial);
  });

  it("is a no-op when top entry is not a drag", () => {
    let s = initial;
    s = acts(
      s,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 100 } },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 100 } },
      { type: "CLOSE_POLYGON", color: "#4A90D2" },
    );
    const undoDepthBefore = s.undoStack.length;
    s = act(s, { type: "END_DRAG" });
    expect(s.undoStack.length).toBe(undoDepthBefore);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SET_BATCH_SPACING_X / SET_BATCH_SPACING_Y
// ─────────────────────────────────────────────────────────────────────────────

describe("designerReducer — batch spacing X/Y", () => {
  let initial: DesignerState;

  beforeEach(() => {
    resetSectionCounter(0);
    resetGroupCounter(0);
    initial = createInitialState();
  });

  it("SET_BATCH_SPACING_X updates batchSpacingX (clamped to >= 0)", () => {
    let s = act(initial, { type: "SET_BATCH_SPACING_X", spacing: 15 });
    expect(s.batchSpacingX).toBe(15);

    s = act(initial, { type: "SET_BATCH_SPACING_X", spacing: -5 });
    expect(s.batchSpacingX).toBe(0);
  });

  it("SET_BATCH_SPACING_Y updates batchSpacingY (clamped to >= 0)", () => {
    let s = act(initial, { type: "SET_BATCH_SPACING_Y", spacing: 20 });
    expect(s.batchSpacingY).toBe(20);

    s = act(initial, { type: "SET_BATCH_SPACING_Y", spacing: -3 });
    expect(s.batchSpacingY).toBe(0);
  });

  it("initial state has batchSpacingX and batchSpacingY at 0", () => {
    expect(initial.batchSpacingX).toBe(0);
    expect(initial.batchSpacingY).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MOVE_SECTION_POINT — polygon vertex editing
// ─────────────────────────────────────────────────────────────────────────────

describe("designerReducer — MOVE_SECTION_POINT", () => {
  let initial: DesignerState;

  beforeEach(() => {
    resetSectionCounter(0);
    resetGroupCounter(0);
    initial = createInitialState();
  });

  it("moves a polygon vertex to a new position", () => {
    let s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 100 } },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 100 } },
      { type: "CLOSE_POLYGON", color: "#4A90D2" },
    );

    const sectionId = s.sections[0]!.sectionId;
    s = act(s, {
      type: "MOVE_SECTION_POINT",
      sectionId,
      pointIndex: 2,
      position: { x: 150, y: 150 },
    });

    expect(s.sections[0]!.polygon[2]).toEqual({ x: 150, y: 150 });
    // Other points unchanged
    expect(s.sections[0]!.polygon[0]).toEqual({ x: 0, y: 0 });
    expect(s.sections[0]!.polygon[1]).toEqual({ x: 100, y: 0 });
    expect(s.sections[0]!.polygon[3]).toEqual({ x: 0, y: 100 });
  });

  it("is a no-op for invalid section ID", () => {
    const s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 100 } },
      { type: "CLOSE_POLYGON", color: "#4A90D2" },
    );
    const result = act(s, {
      type: "MOVE_SECTION_POINT",
      sectionId: "nonexistent",
      pointIndex: 0,
      position: { x: 999, y: 999 },
    });
    expect(result).toBe(s);
  });

  it("is a no-op for out-of-range point index", () => {
    const s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 100 } },
      { type: "CLOSE_POLYGON", color: "#4A90D2" },
    );
    const sectionId = s.sections[0]!.sectionId;
    const result = act(s, {
      type: "MOVE_SECTION_POINT",
      sectionId,
      pointIndex: 99,
      position: { x: 999, y: 999 },
    });
    expect(result).toBe(s);
  });

  it("is a no-op for negative point index", () => {
    const s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 100 } },
      { type: "CLOSE_POLYGON", color: "#4A90D2" },
    );
    const sectionId = s.sections[0]!.sectionId;
    const result = act(s, {
      type: "MOVE_SECTION_POINT",
      sectionId,
      pointIndex: -1,
      position: { x: 999, y: 999 },
    });
    expect(result).toBe(s);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE_LINE_GROUP_GEOMETRY — line handle editing
// ─────────────────────────────────────────────────────────────────────────────

describe("designerReducer — UPDATE_LINE_GROUP_GEOMETRY", () => {
  let initial: DesignerState;

  beforeEach(() => {
    resetSectionCounter(0);
    resetGroupCounter(0);
    initial = createInitialState();
  });

  function setupLineGroup(s: DesignerState): DesignerState {
    s = acts(
      s,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: -100, y: -100 } },
      { type: "ADD_POLYGON_POINT", point: { x: 500, y: -100 } },
      { type: "ADD_POLYGON_POINT", point: { x: 500, y: 500 } },
      { type: "ADD_POLYGON_POINT", point: { x: -100, y: 500 } },
      { type: "CLOSE_POLYGON", color: "#4A90D2" },
    );
    s = act(s, {
      type: "COMMIT_LINE_PLACEMENT",
      start: { x: 10, y: 50 },
      end: { x: 110, y: 50 },
      count: 5,
      spacing: 0,
    });
    return s;
  }

  it("updates the start point and recalculates seats", () => {
    let s = setupLineGroup(initial);
    const group = s.placementGroups[0]!;
    expect(group.kind).toBe("line");

    const oldSeatCount = s.seats.length;
    s = act(s, {
      type: "UPDATE_LINE_GROUP_GEOMETRY",
      groupId: group.id,
      updates: { start: { x: 0, y: 0 } },
    });

    if (s.placementGroups[0]!.kind === "line") {
      expect(s.placementGroups[0]!.start).toEqual({ x: 0, y: 0 });
      expect(s.placementGroups[0]!.end).toEqual({ x: 110, y: 50 }); // unchanged
    }
    expect(s.seats.length).toBe(oldSeatCount); // same count
  });

  it("updates the end point and recalculates seats", () => {
    let s = setupLineGroup(initial);
    const group = s.placementGroups[0]!;

    s = act(s, {
      type: "UPDATE_LINE_GROUP_GEOMETRY",
      groupId: group.id,
      updates: { end: { x: 200, y: 100 } },
    });

    if (s.placementGroups[0]!.kind === "line") {
      expect(s.placementGroups[0]!.end).toEqual({ x: 200, y: 100 });
    }
  });

  it("is a no-op for non-line groups", () => {
    let s = initial;
    s = acts(
      s,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: -100, y: -100 } },
      { type: "ADD_POLYGON_POINT", point: { x: 500, y: -100 } },
      { type: "ADD_POLYGON_POINT", point: { x: 500, y: 500 } },
      { type: "ADD_POLYGON_POINT", point: { x: -100, y: 500 } },
      { type: "CLOSE_POLYGON", color: "#4A90D2" },
    );
    s = act(s, {
      type: "COMMIT_ARC_PLACEMENT",
      center: { x: 100, y: 100 },
      radius: 50,
      startAngle: 0,
      endAngle: Math.PI,
      count: 5,
      spacing: 0,
    });
    const group = s.placementGroups[0]!;
    const result = act(s, {
      type: "UPDATE_LINE_GROUP_GEOMETRY",
      groupId: group.id,
      updates: { start: { x: 0, y: 0 } },
    });
    expect(result).toBe(s);
  });

  it("is a no-op for unknown group ID", () => {
    const s = setupLineGroup(initial);
    const result = act(s, {
      type: "UPDATE_LINE_GROUP_GEOMETRY",
      groupId: "nonexistent",
      updates: { start: { x: 0, y: 0 } },
    });
    expect(result).toBe(s);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE_GRID_GROUP_GEOMETRY — grid handle editing
// ─────────────────────────────────────────────────────────────────────────────

describe("designerReducer — UPDATE_GRID_GROUP_GEOMETRY", () => {
  let initial: DesignerState;

  beforeEach(() => {
    resetSectionCounter(0);
    resetGroupCounter(0);
    initial = createInitialState();
  });

  function setupGridGroup(s: DesignerState): DesignerState {
    s = acts(
      s,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: -100, y: -100 } },
      { type: "ADD_POLYGON_POINT", point: { x: 500, y: -100 } },
      { type: "ADD_POLYGON_POINT", point: { x: 500, y: 500 } },
      { type: "ADD_POLYGON_POINT", point: { x: -100, y: 500 } },
      { type: "CLOSE_POLYGON", color: "#4A90D2" },
    );
    s = act(s, {
      type: "COMMIT_GRID_PLACEMENT",
      origin: { x: 0, y: 0 },
      extent: { x: 100, y: 100 },
      rows: 2,
      cols: 3,
      spacing: 0,
    });
    return s;
  }

  it("updates the origin point and recalculates seats", () => {
    let s = setupGridGroup(initial);
    const group = s.placementGroups[0]!;
    expect(group.kind).toBe("grid");

    s = act(s, {
      type: "UPDATE_GRID_GROUP_GEOMETRY",
      groupId: group.id,
      updates: { origin: { x: 10, y: 10 } },
    });

    if (s.placementGroups[0]!.kind === "grid") {
      expect(s.placementGroups[0]!.origin).toEqual({ x: 10, y: 10 });
      expect(s.placementGroups[0]!.extent).toEqual({ x: 100, y: 100 }); // unchanged
    }
    // Same number of seats (2x3 = 6)
    expect(s.seats.length).toBe(6);
  });

  it("updates the extent point and recalculates seats", () => {
    let s = setupGridGroup(initial);
    const group = s.placementGroups[0]!;

    s = act(s, {
      type: "UPDATE_GRID_GROUP_GEOMETRY",
      groupId: group.id,
      updates: { extent: { x: 200, y: 200 } },
    });

    if (s.placementGroups[0]!.kind === "grid") {
      expect(s.placementGroups[0]!.extent).toEqual({ x: 200, y: 200 });
    }
  });

  it("is a no-op for non-grid groups", () => {
    let s = initial;
    s = acts(
      s,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: -100, y: -100 } },
      { type: "ADD_POLYGON_POINT", point: { x: 500, y: -100 } },
      { type: "ADD_POLYGON_POINT", point: { x: 500, y: 500 } },
      { type: "ADD_POLYGON_POINT", point: { x: -100, y: 500 } },
      { type: "CLOSE_POLYGON", color: "#4A90D2" },
    );
    s = act(s, {
      type: "COMMIT_LINE_PLACEMENT",
      start: { x: 10, y: 50 },
      end: { x: 110, y: 50 },
      count: 5,
      spacing: 0,
    });
    const result = act(s, {
      type: "UPDATE_GRID_GROUP_GEOMETRY",
      groupId: s.placementGroups[0]!.id,
      updates: { origin: { x: 0, y: 0 } },
    });
    expect(result).toBe(s);
  });

  it("is a no-op for unknown group ID", () => {
    const s = setupGridGroup(initial);
    const result = act(s, {
      type: "UPDATE_GRID_GROUP_GEOMETRY",
      groupId: "nonexistent",
      updates: { origin: { x: 0, y: 0 } },
    });
    expect(result).toBe(s);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeGridPositionsWithSeparateSpacing
// ─────────────────────────────────────────────────────────────────────────────

describe("computeGridPositionsWithSeparateSpacing", () => {
  it("returns empty array for rows <= 0 or cols <= 0", () => {
    expect(
      computeGridPositionsWithSeparateSpacing(
        { x: 0, y: 0 },
        { x: 100, y: 100 },
        0,
        3,
        10,
        10,
      ),
    ).toEqual([]);
    expect(
      computeGridPositionsWithSeparateSpacing(
        { x: 0, y: 0 },
        { x: 100, y: 100 },
        3,
        0,
        10,
        10,
      ),
    ).toEqual([]);
  });

  it("uses fixed spacing when both spacingX and spacingY are > 0", () => {
    const pts = computeGridPositionsWithSeparateSpacing(
      { x: 0, y: 0 },
      { x: 100, y: 100 },
      2,
      3,
      20,
      30,
    );
    expect(pts).toHaveLength(6);
    // Row 0: y = 0, cols at x = 0, 20, 40
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[1]).toEqual({ x: 20, y: 0 });
    expect(pts[2]).toEqual({ x: 40, y: 0 });
    // Row 1: y = 30, cols at x = 0, 20, 40
    expect(pts[3]).toEqual({ x: 0, y: 30 });
    expect(pts[4]).toEqual({ x: 20, y: 30 });
    expect(pts[5]).toEqual({ x: 40, y: 30 });
  });

  it("uses even distribution on X when spacingX is 0", () => {
    const pts = computeGridPositionsWithSeparateSpacing(
      { x: 0, y: 0 },
      { x: 100, y: 100 },
      2,
      3,
      0,
      25,
    );
    expect(pts).toHaveLength(6);
    // X is evenly distributed: 0, 50, 100
    expect(pts[0]!.x).toBeCloseTo(0);
    expect(pts[1]!.x).toBeCloseTo(50);
    expect(pts[2]!.x).toBeCloseTo(100);
    // Y uses fixed spacing: 0, 25
    expect(pts[0]!.y).toBeCloseTo(0);
    expect(pts[3]!.y).toBeCloseTo(25);
  });

  it("uses even distribution on Y when spacingY is 0", () => {
    const pts = computeGridPositionsWithSeparateSpacing(
      { x: 0, y: 0 },
      { x: 100, y: 100 },
      3,
      2,
      15,
      0,
    );
    expect(pts).toHaveLength(6);
    // X uses fixed spacing: 0, 15
    expect(pts[0]!.x).toBeCloseTo(0);
    expect(pts[1]!.x).toBeCloseTo(15);
    // Y is evenly distributed: 0, 50, 100
    expect(pts[0]!.y).toBeCloseTo(0);
    expect(pts[2]!.y).toBeCloseTo(50);
    expect(pts[4]!.y).toBeCloseTo(100);
  });

  it("handles negative direction (extent < origin)", () => {
    const pts = computeGridPositionsWithSeparateSpacing(
      { x: 100, y: 100 },
      { x: 0, y: 0 },
      2,
      2,
      20,
      20,
    );
    expect(pts).toHaveLength(4);
    // Direction is negative, so spacing goes toward 0
    expect(pts[0]).toEqual({ x: 100, y: 100 });
    expect(pts[1]).toEqual({ x: 80, y: 100 });
    expect(pts[2]).toEqual({ x: 100, y: 80 });
    expect(pts[3]).toEqual({ x: 80, y: 80 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// COMMIT_GRID_PLACEMENT with per-axis spacing
// ─────────────────────────────────────────────────────────────────────────────

describe("designerReducer — grid placement with per-axis spacing", () => {
  let initial: DesignerState;

  beforeEach(() => {
    resetSectionCounter(0);
    resetGroupCounter(0);
    initial = createInitialState();
  });

  it("COMMIT_GRID_PLACEMENT with spacingX and spacingY creates correctly spaced grid", () => {
    let s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: -100, y: -100 } },
      { type: "ADD_POLYGON_POINT", point: { x: 500, y: -100 } },
      { type: "ADD_POLYGON_POINT", point: { x: 500, y: 500 } },
      { type: "ADD_POLYGON_POINT", point: { x: -100, y: 500 } },
      { type: "CLOSE_POLYGON", color: "#4A90D2" },
    );
    s = act(s, {
      type: "COMMIT_GRID_PLACEMENT",
      origin: { x: 0, y: 0 },
      extent: { x: 200, y: 200 },
      rows: 2,
      cols: 3,
      spacing: 0,
      spacingX: 15,
      spacingY: 25,
    });

    expect(s.seats.length).toBe(6);
    const group = s.placementGroups[0]!;
    expect(group.kind).toBe("grid");
    if (group.kind === "grid") {
      expect(group.spacingX).toBe(15);
      expect(group.spacingY).toBe(25);
    }

    // Verify seat positions: row 0 at y=0, row 1 at y=25
    const sortedSeats = [...s.seats].sort((a, b) => {
      if (a.position.y !== b.position.y) return a.position.y - b.position.y;
      return a.position.x - b.position.x;
    });
    expect(sortedSeats[0]!.position).toEqual({ x: 0, y: 0 });
    expect(sortedSeats[1]!.position).toEqual({ x: 15, y: 0 });
    expect(sortedSeats[2]!.position).toEqual({ x: 30, y: 0 });
    expect(sortedSeats[3]!.position).toEqual({ x: 0, y: 25 });
  });

  it("COMMIT_GRID_PLACEMENT falls back to even distribution when spacingX/Y are 0", () => {
    let s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: -100, y: -100 } },
      { type: "ADD_POLYGON_POINT", point: { x: 500, y: -100 } },
      { type: "ADD_POLYGON_POINT", point: { x: 500, y: 500 } },
      { type: "ADD_POLYGON_POINT", point: { x: -100, y: 500 } },
      { type: "CLOSE_POLYGON", color: "#4A90D2" },
    );
    s = act(s, {
      type: "COMMIT_GRID_PLACEMENT",
      origin: { x: 0, y: 0 },
      extent: { x: 100, y: 100 },
      rows: 2,
      cols: 2,
      spacing: 0,
      spacingX: 0,
      spacingY: 0,
    });

    // With spacing = 0 and spacingX/Y = 0, uses even distribution
    expect(s.seats.length).toBe(4);
    const group = s.placementGroups[0]!;
    if (group.kind === "grid") {
      expect(group.spacingX).toBe(0);
      expect(group.spacingY).toBe(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// nextRowLabel helper
// ─────────────────────────────────────────────────────────────────────────────

describe("nextRowLabel", () => {
  it("increments single letters", () => {
    expect(nextRowLabel("A")).toBe("B");
    expect(nextRowLabel("B")).toBe("C");
    expect(nextRowLabel("Y")).toBe("Z");
  });

  it("wraps Z to AA", () => {
    expect(nextRowLabel("Z")).toBe("AA");
  });

  it("increments multi-letter labels", () => {
    expect(nextRowLabel("AA")).toBe("AB");
    expect(nextRowLabel("AZ")).toBe("BA");
    expect(nextRowLabel("ZZ")).toBe("AAA");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Auto-row advance on batch placement
// ─────────────────────────────────────────────────────────────────────────────

describe("designerReducer — auto-row advance", () => {
  let initial: DesignerState;

  beforeEach(() => {
    resetSectionCounter();
    resetGroupCounter();
    initial = createInitialState();
  });

  function stateWithSection(): DesignerState {
    let s = initial;
    s = acts(
      s,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 200, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 200, y: 200 } },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 200 } },
      { type: "CLOSE_POLYGON", color: "#4A90D2" },
    );
    return s;
  }

  it("COMMIT_LINE_PLACEMENT advances row A→B", () => {
    let s = stateWithSection();
    expect(s.currentRow).toBe("A");
    s = act(s, {
      type: "COMMIT_LINE_PLACEMENT",
      start: { x: 10, y: 10 },
      end: { x: 90, y: 10 },
      count: 3,
      spacing: 0,
    });
    expect(s.currentRow).toBe("B");
    expect(s.nextSeatNumber).toBe(1);
  });

  it("COMMIT_ARC_PLACEMENT advances row A→B", () => {
    let s = stateWithSection();
    s = act(s, {
      type: "COMMIT_ARC_PLACEMENT",
      center: { x: 100, y: 100 },
      radius: 50,
      startAngle: 0,
      endAngle: Math.PI,
      count: 3,
      spacing: 0,
    });
    expect(s.currentRow).toBe("B");
    expect(s.nextSeatNumber).toBe(1);
  });

  it("COMMIT_GRID_PLACEMENT advances row A→B", () => {
    let s = stateWithSection();
    s = act(s, {
      type: "COMMIT_GRID_PLACEMENT",
      origin: { x: 10, y: 10 },
      extent: { x: 90, y: 90 },
      rows: 2,
      cols: 2,
      spacing: 0,
    });
    expect(s.currentRow).toBe("B");
    expect(s.nextSeatNumber).toBe(1);
  });

  it("successive commits advance row A→B→C", () => {
    let s = stateWithSection();
    s = act(s, {
      type: "COMMIT_LINE_PLACEMENT",
      start: { x: 10, y: 10 },
      end: { x: 90, y: 10 },
      count: 3,
      spacing: 0,
    });
    expect(s.currentRow).toBe("B");
    expect(s.placementGroups[0]!.row).toBe("A");

    s = act(s, {
      type: "COMMIT_LINE_PLACEMENT",
      start: { x: 10, y: 50 },
      end: { x: 90, y: 50 },
      count: 3,
      spacing: 0,
    });
    expect(s.currentRow).toBe("C");
    expect(s.placementGroups[1]!.row).toBe("B");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Seat number bump-up on overlap
// ─────────────────────────────────────────────────────────────────────────────

describe("designerReducer — seat number bump-up", () => {
  let initial: DesignerState;

  beforeEach(() => {
    resetSectionCounter();
    resetGroupCounter();
    initial = createInitialState();
  });

  it("bumps startNum when expanding a group would overlap another in the same section+row", () => {
    // Create a section
    let s = initial;
    s = acts(
      s,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 500, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 500, y: 200 } },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 200 } },
      { type: "CLOSE_POLYGON", color: "#4A90D2" },
    );

    // Place group A: row A, seats 1-3
    s = act(s, {
      type: "COMMIT_LINE_PLACEMENT",
      start: { x: 10, y: 50 },
      end: { x: 90, y: 50 },
      count: 3,
      spacing: 0,
    });
    // Row auto-advances to B, reset row back to A manually for test
    s = act(s, { type: "SET_CURRENT_ROW", row: "A" });

    // Place group B: row A, seats 1-3 (same row)
    s = act(s, {
      type: "COMMIT_LINE_PLACEMENT",
      start: { x: 200, y: 50 },
      end: { x: 400, y: 50 },
      count: 3,
      spacing: 0,
    });

    const groupA = s.placementGroups[0]!;
    const groupB = s.placementGroups[1]!;
    expect(groupA.row).toBe("A");
    expect(groupB.row).toBe("A");

    // Now increase groupA's count to 5 — seats 4, 5 would NOT overlap with groupB since
    // groupB starts at 1 too. The bump-up should detect the collision with groupB's range.
    s = act(s, {
      type: "UPDATE_PLACEMENT_GROUP",
      groupId: groupA.id,
      updates: { count: 5 },
    });

    // GroupA should have been bumped to avoid overlapping with groupB's range
    const updatedGroupA = s.placementGroups.find((g) => g.id === groupA.id)!;
    // The seat IDs should all be unique
    const allSeatIds = s.seats.map((seat) => seat.id);
    const uniqueSeatIds = new Set(allSeatIds);
    expect(uniqueSeatIds.size).toBe(allSeatIds.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bezier Stroke — computeStrokePositions
// ─────────────────────────────────────────────────────────────────────────────

describe("computeStrokePositions", () => {
  it("returns empty array for fewer than 2 points", () => {
    const cp: StrokeControlPoint[] = [
      { position: { x: 0, y: 0 }, handleIn: null, handleOut: null },
    ];
    expect(computeStrokePositions(cp, 5)).toEqual([]);
    expect(computeStrokePositions([], 5)).toEqual([]);
  });

  it("returns single point when count = 1", () => {
    const cp: StrokeControlPoint[] = [
      { position: { x: 0, y: 0 }, handleIn: null, handleOut: null },
      { position: { x: 100, y: 0 }, handleIn: null, handleOut: null },
    ];
    const result = computeStrokePositions(cp, 1);
    expect(result).toHaveLength(1);
    expect(result[0]!.x).toBeCloseTo(0);
    expect(result[0]!.y).toBeCloseTo(0);
  });

  it("distributes points evenly along a straight line (no handles)", () => {
    const cp: StrokeControlPoint[] = [
      { position: { x: 0, y: 0 }, handleIn: null, handleOut: null },
      { position: { x: 100, y: 0 }, handleIn: null, handleOut: null },
    ];
    const result = computeStrokePositions(cp, 3);
    expect(result).toHaveLength(3);
    expect(result[0]!.x).toBeCloseTo(0);
    expect(result[1]!.x).toBeCloseTo(50);
    expect(result[2]!.x).toBeCloseTo(100);
    // All y should be 0
    for (const p of result) expect(p.y).toBeCloseTo(0);
  });

  it("distributes points along a curved Bezier path", () => {
    // Quarter-circle-ish curve from (0,0) to (100,100) with handles
    const cp: StrokeControlPoint[] = [
      { position: { x: 0, y: 0 }, handleIn: null, handleOut: { x: 50, y: 0 } },
      {
        position: { x: 100, y: 100 },
        handleIn: { x: 0, y: -50 },
        handleOut: null,
      },
    ];
    const result = computeStrokePositions(cp, 5);
    expect(result).toHaveLength(5);
    // First and last should be start/end
    expect(result[0]!.x).toBeCloseTo(0);
    expect(result[0]!.y).toBeCloseTo(0);
    expect(result[4]!.x).toBeCloseTo(100);
    expect(result[4]!.y).toBeCloseTo(100);
    // Middle points should be between start and end
    for (let i = 1; i < 4; i++) {
      expect(result[i]!.x).toBeGreaterThan(0);
      expect(result[i]!.x).toBeLessThan(100);
    }
  });

  it("handles multi-segment paths", () => {
    const cp: StrokeControlPoint[] = [
      { position: { x: 0, y: 0 }, handleIn: null, handleOut: null },
      { position: { x: 50, y: 0 }, handleIn: null, handleOut: null },
      { position: { x: 100, y: 0 }, handleIn: null, handleOut: null },
    ];
    const result = computeStrokePositions(cp, 5);
    expect(result).toHaveLength(5);
    expect(result[0]!.x).toBeCloseTo(0);
    expect(result[1]!.x).toBeCloseTo(25);
    expect(result[2]!.x).toBeCloseTo(50);
    expect(result[3]!.x).toBeCloseTo(75);
    expect(result[4]!.x).toBeCloseTo(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bezier Stroke — SET_LAST_STROKE_HANDLES & PLACE_SEATS_ALONG_STROKE
// ─────────────────────────────────────────────────────────────────────────────

describe("designerReducer — Bezier stroke actions", () => {
  let initial: DesignerState;

  beforeEach(() => {
    initial = createInitialState();
    resetSectionCounter();
    resetGroupCounter();
    resetStrokeCounter();
  });

  it("SET_LAST_STROKE_HANDLES sets handleOut on last point and mirrors handleIn", () => {
    let s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_stroke" },
      { type: "ADD_STROKE_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_STROKE_POINT", point: { x: 100, y: 100 } },
    );
    // Apply handle to the last point
    s = act(s, {
      type: "SET_LAST_STROKE_HANDLES",
      handleOut: { x: 30, y: -10 },
    });
    const pts = s.drawingStrokePoints;
    expect(pts).toHaveLength(2);
    // Last point should have the handle set
    expect(pts[1]!.handleOut).toEqual({ x: 30, y: -10 });
    // handleIn should be mirrored (negated)
    expect(pts[1]!.handleIn).toEqual({ x: -30, y: 10 });
  });

  it("SET_LAST_STROKE_HANDLES is no-op on empty drawing points", () => {
    const s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_stroke" },
      { type: "SET_LAST_STROKE_HANDLES", handleOut: { x: 30, y: -10 } },
    );
    expect(s.drawingStrokePoints).toHaveLength(0);
  });

  it("COMMIT_STROKE preserves Bezier handles on committed stroke", () => {
    const s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_stroke" },
      { type: "ADD_STROKE_POINT", point: { x: 0, y: 0 } },
      { type: "SET_LAST_STROKE_HANDLES", handleOut: { x: 20, y: 0 } },
      { type: "ADD_STROKE_POINT", point: { x: 100, y: 0 } },
      { type: "SET_LAST_STROKE_HANDLES", handleOut: { x: 10, y: 5 } },
      { type: "COMMIT_STROKE" },
    );
    expect(s.strokes).toHaveLength(1);
    const stroke = s.strokes[0]!;
    expect(stroke.points).toHaveLength(2);
    // First point should have handleOut from SET_LAST_STROKE_HANDLES
    expect(stroke.points[0]!.handleOut).toEqual({ x: 20, y: 0 });
    expect(stroke.points[0]!.handleIn!.x).toBe(-20);
    expect(stroke.points[0]!.handleIn!.y).toBeCloseTo(0);
    // Second point
    expect(stroke.points[1]!.handleOut).toEqual({ x: 10, y: 5 });
    expect(stroke.points[1]!.handleIn).toEqual({ x: -10, y: -5 });
    // Drawing points should be cleared
    expect(s.drawingStrokePoints).toHaveLength(0);
  });

  it("PLACE_SEATS_ALONG_STROKE places seats evenly along a committed stroke", () => {
    // Create a section first, then deactivate before committing stroke
    // so COMMIT_STROKE doesn't auto-place seats.
    let s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: -10, y: -10 } },
      { type: "ADD_POLYGON_POINT", point: { x: 200, y: -10 } },
      { type: "ADD_POLYGON_POINT", point: { x: 200, y: 200 } },
      { type: "CLOSE_POLYGON", color: "#ff0000" },
    );
    const sectionId = s.sections[0]!.sectionId;

    // Deactivate section, commit stroke → no auto-placement
    s = act(s, { type: "SET_ACTIVE_SECTION", sectionId: null });
    s = acts(
      s,
      { type: "SET_TOOL", tool: "draw_stroke" },
      { type: "ADD_STROKE_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_STROKE_POINT", point: { x: 100, y: 0 } },
      { type: "COMMIT_STROKE" },
    );
    expect(s.strokes).toHaveLength(1);
    expect(s.seats).toHaveLength(0); // no auto-place
    const strokeId = s.strokes[0]!.id;

    // Now activate section and place 5 seats along the stroke
    s = act(s, { type: "SET_ACTIVE_SECTION", sectionId });
    s = act(s, { type: "PLACE_SEATS_ALONG_STROKE", strokeId, count: 5 });
    expect(s.seats).toHaveLength(5);

    // Verify seats are distributed along the stroke
    const xs = s.seats.map((seat) => seat.position.x).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(0);
    expect(xs[4]).toBeCloseTo(100);
    // All y should be 0
    for (const seat of s.seats) expect(seat.position.y).toBeCloseTo(0);

    // Should auto-advance row
    expect(s.currentRow).toBe("B");
    expect(s.nextSeatNumber).toBe(1);
  });

  it("PLACE_SEATS_ALONG_STROKE is no-op without active section", () => {
    let s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_stroke" },
      { type: "ADD_STROKE_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_STROKE_POINT", point: { x: 100, y: 0 } },
      { type: "COMMIT_STROKE" },
    );
    const strokeId = s.strokes[0]!.id;
    s = act(s, { type: "PLACE_SEATS_ALONG_STROKE", strokeId, count: 5 });
    expect(s.seats).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Undo preserves activeSectionId
// ─────────────────────────────────────────────────────────────────────────────

describe("designerReducer — undo preserves activeSectionId", () => {
  let initial: DesignerState;

  beforeEach(() => {
    resetSectionCounter();
    resetGroupCounter();
    resetStrokeCounter();
    initial = createInitialState();
  });

  it("activeSectionId survives undo when the section still exists", () => {
    // Create a section
    let s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 100 } },
      { type: "CLOSE_POLYGON", color: "#FF0000" },
    );
    const sectionId = s.sections[0]!.sectionId;
    expect(s.activeSectionId).toBe(sectionId);

    // Place a seat (creates an undo entry)
    s = act(s, { type: "PLACE_SEAT", position: { x: 50, y: 50 } });
    expect(s.seats).toHaveLength(1);
    expect(s.activeSectionId).toBe(sectionId);

    // Undo the seat placement
    s = act(s, { type: "UNDO" });
    expect(s.seats).toHaveLength(0);
    // activeSectionId should still be set since the section still exists
    expect(s.activeSectionId).toBe(sectionId);
  });

  it("activeSectionId falls back to first section when current section is removed by undo", () => {
    // Create two sections
    let s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 100 } },
      { type: "CLOSE_POLYGON", color: "#FF0000" },
    );
    const firstSectionId = s.sections[0]!.sectionId;

    s = acts(
      s,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: 200, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 300, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 300, y: 100 } },
      { type: "CLOSE_POLYGON", color: "#0000FF" },
    );
    const secondSectionId = s.sections[1]!.sectionId;
    expect(s.activeSectionId).toBe(secondSectionId);

    // Undo creating the second section — should fall back to first
    s = act(s, { type: "UNDO" });
    expect(s.sections).toHaveLength(1);
    expect(s.activeSectionId).toBe(firstSectionId);
  });

  it("activeSectionId is null when undo removes all sections", () => {
    let s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 100 } },
      { type: "CLOSE_POLYGON", color: "#FF0000" },
    );
    expect(s.sections).toHaveLength(1);

    s = act(s, { type: "UNDO" });
    expect(s.sections).toHaveLength(0);
    expect(s.activeSectionId).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SET_TOOL auto-commits in-progress strokes
// ─────────────────────────────────────────────────────────────────────────────

describe("designerReducer — SET_TOOL auto-commits strokes", () => {
  let initial: DesignerState;

  beforeEach(() => {
    resetSectionCounter();
    resetGroupCounter();
    resetStrokeCounter();
    initial = createInitialState();
  });

  it("auto-commits stroke with 2+ points when switching away from draw_stroke", () => {
    let s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_stroke" },
      { type: "ADD_STROKE_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_STROKE_POINT", point: { x: 100, y: 0 } },
      { type: "ADD_STROKE_POINT", point: { x: 100, y: 100 } },
    );
    expect(s.drawingStrokePoints).toHaveLength(3);
    expect(s.strokes).toHaveLength(0);

    // Switch tool — should auto-commit the stroke
    s = act(s, { type: "SET_TOOL", tool: "select" });
    expect(s.strokes).toHaveLength(1);
    expect(s.strokes[0]!.points).toHaveLength(3);
    expect(s.drawingStrokePoints).toHaveLength(0);
  });

  it("discards stroke with only 1 point when switching away", () => {
    let s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_stroke" },
      { type: "ADD_STROKE_POINT", point: { x: 50, y: 50 } },
    );
    expect(s.drawingStrokePoints).toHaveLength(1);

    s = act(s, { type: "SET_TOOL", tool: "select" });
    expect(s.strokes).toHaveLength(0);
    expect(s.drawingStrokePoints).toHaveLength(0);
  });

  it("preserves stroke points when switching back to draw_stroke", () => {
    let s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_stroke" },
      { type: "ADD_STROKE_POINT", point: { x: 0, y: 0 } },
    );
    // Switching back to same tool should keep points
    s = act(s, { type: "SET_TOOL", tool: "draw_stroke" });
    expect(s.drawingStrokePoints).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Default batchSpacing
// ─────────────────────────────────────────────────────────────────────────────

describe("designerReducer — default batchSpacing", () => {
  it("initial batchSpacing is 10 (non-zero default)", () => {
    const s = createInitialState();
    expect(s.batchSpacing).toBe(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MOVE_STROKE_POINT
// ─────────────────────────────────────────────────────────────────────────────

describe("designerReducer — MOVE_STROKE_POINT", () => {
  let initial: DesignerState;

  beforeEach(() => {
    resetSectionCounter();
    resetGroupCounter();
    resetStrokeCounter();
    initial = createInitialState();
  });

  it("moves an anchor point to a new position", () => {
    let s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_stroke" },
      { type: "ADD_STROKE_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_STROKE_POINT", point: { x: 100, y: 0 } },
      { type: "COMMIT_STROKE" },
    );
    expect(s.strokes).toHaveLength(1);
    const strokeId = s.strokes[0]!.id;

    s = act(s, {
      type: "MOVE_STROKE_POINT",
      strokeId,
      pointIndex: 0,
      position: { x: 50, y: 50 },
    });
    expect(s.strokes[0]!.points[0]!.position).toEqual({ x: 50, y: 50 });
    // Other point unchanged
    expect(s.strokes[0]!.points[1]!.position).toEqual({ x: 100, y: 0 });
  });

  it("is a no-op for unknown strokeId", () => {
    let s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_stroke" },
      { type: "ADD_STROKE_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_STROKE_POINT", point: { x: 100, y: 0 } },
      { type: "COMMIT_STROKE" },
    );
    const before = s;
    s = act(s, {
      type: "MOVE_STROKE_POINT",
      strokeId: "non-existent",
      pointIndex: 0,
      position: { x: 50, y: 50 },
    });
    expect(s).toBe(before);
  });

  it("is a no-op for out-of-range pointIndex", () => {
    let s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_stroke" },
      { type: "ADD_STROKE_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_STROKE_POINT", point: { x: 100, y: 0 } },
      { type: "COMMIT_STROKE" },
    );
    const strokeId = s.strokes[0]!.id;
    const before = s;
    s = act(s, {
      type: "MOVE_STROKE_POINT",
      strokeId,
      pointIndex: 5,
      position: { x: 50, y: 50 },
    });
    expect(s).toBe(before);
  });

  it("is a no-op for negative pointIndex", () => {
    let s = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_stroke" },
      { type: "ADD_STROKE_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_STROKE_POINT", point: { x: 100, y: 0 } },
      { type: "COMMIT_STROKE" },
    );
    const strokeId = s.strokes[0]!.id;
    const before = s;
    s = act(s, {
      type: "MOVE_STROKE_POINT",
      strokeId,
      pointIndex: -1,
      position: { x: 50, y: 50 },
    });
    expect(s).toBe(before);
  });
});

// ── Section & placement group reordering ─────────────────────────────
describe("designerReducer — REORDER_SECTION", () => {
  let initial: DesignerState;
  beforeEach(() => {
    resetSectionCounter();
    resetGroupCounter();
    initial = createInitialState();
  });

  function makeThreeSections(s: DesignerState): DesignerState {
    for (let i = 0; i < 3; i++) {
      s = acts(
        s,
        { type: "SET_TOOL", tool: "draw_section" },
        { type: "ADD_POLYGON_POINT", point: { x: i * 200, y: 0 } },
        { type: "ADD_POLYGON_POINT", point: { x: i * 200 + 100, y: 0 } },
        { type: "ADD_POLYGON_POINT", point: { x: i * 200 + 100, y: 100 } },
        { type: "CLOSE_POLYGON", color: "#ff0000", sectionKind: "ga" as const },
      );
    }
    return s;
  }

  it("moves a section down (swaps with next)", () => {
    let s = makeThreeSections(initial);
    const ids = s.sections.map((sec) => sec.sectionId);
    s = act(s, {
      type: "REORDER_SECTION",
      sectionId: ids[0]!,
      direction: "down",
    });
    expect(s.sections.map((sec) => sec.sectionId)).toEqual([
      ids[1],
      ids[0],
      ids[2],
    ]);
  });

  it("moves a section up (swaps with previous)", () => {
    let s = makeThreeSections(initial);
    const ids = s.sections.map((sec) => sec.sectionId);
    s = act(s, {
      type: "REORDER_SECTION",
      sectionId: ids[2]!,
      direction: "up",
    });
    expect(s.sections.map((sec) => sec.sectionId)).toEqual([
      ids[0],
      ids[2],
      ids[1],
    ]);
  });

  it("is a no-op when moving the first section up", () => {
    let s = makeThreeSections(initial);
    const before = s;
    s = act(s, {
      type: "REORDER_SECTION",
      sectionId: s.sections[0]!.sectionId,
      direction: "up",
    });
    expect(s).toBe(before);
  });

  it("is a no-op when moving the last section down", () => {
    let s = makeThreeSections(initial);
    const before = s;
    s = act(s, {
      type: "REORDER_SECTION",
      sectionId: s.sections[2]!.sectionId,
      direction: "down",
    });
    expect(s).toBe(before);
  });

  it("is a no-op for unknown sectionId", () => {
    let s = makeThreeSections(initial);
    const before = s;
    s = act(s, {
      type: "REORDER_SECTION",
      sectionId: "nonexistent",
      direction: "up",
    });
    expect(s).toBe(before);
  });
});

describe("designerReducer — REORDER_PLACEMENT_GROUP", () => {
  let initial: DesignerState;
  beforeEach(() => {
    resetSectionCounter();
    resetGroupCounter();
    initial = createInitialState();
  });

  function makeSectionWithTwoLineGroups(s: DesignerState): DesignerState {
    // Create a seat section
    s = acts(
      s,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: -10, y: -10 } },
      { type: "ADD_POLYGON_POINT", point: { x: 500, y: -10 } },
      { type: "ADD_POLYGON_POINT", point: { x: 500, y: 500 } },
      { type: "ADD_POLYGON_POINT", point: { x: -10, y: 500 } },
      { type: "CLOSE_POLYGON", color: "#ff0000" },
    );
    // Place two line groups
    s = act(s, {
      type: "COMMIT_LINE_PLACEMENT",
      start: { x: 0, y: 0 },
      end: { x: 100, y: 0 },
      count: 3,
      spacing: 0,
    });
    s = act(s, {
      type: "COMMIT_LINE_PLACEMENT",
      start: { x: 0, y: 50 },
      end: { x: 100, y: 50 },
      count: 3,
      spacing: 0,
    });
    return s;
  }

  it("moves a placement group down", () => {
    let s = makeSectionWithTwoLineGroups(initial);
    const ids = s.placementGroups.map((g) => g.id);
    expect(ids).toHaveLength(2);
    s = act(s, {
      type: "REORDER_PLACEMENT_GROUP",
      groupId: ids[0]!,
      direction: "down",
    });
    expect(s.placementGroups.map((g) => g.id)).toEqual([ids[1], ids[0]]);
  });

  it("moves a placement group up", () => {
    let s = makeSectionWithTwoLineGroups(initial);
    const ids = s.placementGroups.map((g) => g.id);
    s = act(s, {
      type: "REORDER_PLACEMENT_GROUP",
      groupId: ids[1]!,
      direction: "up",
    });
    expect(s.placementGroups.map((g) => g.id)).toEqual([ids[1], ids[0]]);
  });

  it("is a no-op when moving the first group up", () => {
    let s = makeSectionWithTwoLineGroups(initial);
    const before = s;
    s = act(s, {
      type: "REORDER_PLACEMENT_GROUP",
      groupId: s.placementGroups[0]!.id,
      direction: "up",
    });
    expect(s).toBe(before);
  });

  it("is a no-op when moving the last group down", () => {
    let s = makeSectionWithTwoLineGroups(initial);
    const before = s;
    s = act(s, {
      type: "REORDER_PLACEMENT_GROUP",
      groupId: s.placementGroups[1]!.id,
      direction: "down",
    });
    expect(s).toBe(before);
  });

  it("is a no-op for unknown groupId", () => {
    let s = makeSectionWithTwoLineGroups(initial);
    const before = s;
    s = act(s, {
      type: "REORDER_PLACEMENT_GROUP",
      groupId: "nonexistent",
      direction: "up",
    });
    expect(s).toBe(before);
  });
});

// ── StrokePlacementGroup & intrinsic stroke seats ────────────────────
describe("designerReducer — StrokePlacementGroup", () => {
  let initial: DesignerState;
  beforeEach(() => {
    resetSectionCounter();
    resetGroupCounter();
    resetStrokeCounter();
    initial = createInitialState();
  });

  /** Helper: create section + straight stroke WITH auto-placed seats */
  function sectionAndStrokeWithSeats(s: DesignerState): DesignerState {
    s = acts(
      s,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: -10, y: -10 } },
      { type: "ADD_POLYGON_POINT", point: { x: 300, y: -10 } },
      { type: "ADD_POLYGON_POINT", point: { x: 300, y: 200 } },
      { type: "ADD_POLYGON_POINT", point: { x: -10, y: 200 } },
      { type: "CLOSE_POLYGON", color: "#ff0000" },
    );
    // Default batchCount=10 → COMMIT_STROKE auto-places 10 seats
    s = acts(
      s,
      { type: "SET_TOOL", tool: "draw_stroke" },
      { type: "ADD_STROKE_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_STROKE_POINT", point: { x: 200, y: 0 } },
      { type: "COMMIT_STROKE" },
    );
    return s;
  }

  it("COMMIT_STROKE auto-creates a StrokePlacementGroup when section is active", () => {
    const s = sectionAndStrokeWithSeats(initial);
    expect(s.strokes).toHaveLength(1);
    expect(s.seats).toHaveLength(10);
    expect(s.placementGroups).toHaveLength(1);
    const group = s.placementGroups[0]!;
    expect(group.kind).toBe("stroke");
    if (group.kind !== "stroke") throw new Error("Expected stroke group");
    expect(group.strokeId).toBe(s.strokes[0]!.id);
    expect(group.count).toBe(10);
    expect(group.seatIds).toHaveLength(10);
    expect(group.row).toBe("A");
    expect(group.startNum).toBe(1);
    // Row advanced after auto-place
    expect(s.currentRow).toBe("B");
    expect(s.nextSeatNumber).toBe(1);
  });

  it("COMMIT_STROKE does NOT auto-place seats when no active section", () => {
    let s = initial;
    s = acts(
      s,
      { type: "SET_TOOL", tool: "draw_stroke" },
      { type: "ADD_STROKE_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_STROKE_POINT", point: { x: 100, y: 0 } },
      { type: "COMMIT_STROKE" },
    );
    expect(s.strokes).toHaveLength(1);
    expect(s.seats).toHaveLength(0);
    expect(s.placementGroups).toHaveLength(0);
  });

  it("PLACE_SEATS_ALONG_STROKE updates existing group instead of duplicating", () => {
    let s = sectionAndStrokeWithSeats(initial);
    const strokeId = s.strokes[0]!.id;
    expect(s.placementGroups).toHaveLength(1);

    // Update to 5 seats
    s = act(s, { type: "PLACE_SEATS_ALONG_STROKE", strokeId, count: 5 });
    expect(s.placementGroups).toHaveLength(1); // still 1 group, not 2
    const group = s.placementGroups[0]!;
    expect(group.kind).toBe("stroke");
    if (group.kind !== "stroke") throw new Error("Expected stroke group");
    expect(group.count).toBe(5);
    expect(group.seatIds).toHaveLength(5);
    expect(s.seats).toHaveLength(5);
  });

  it("DELETE_STROKE cascades to linked stroke placement group and seats", () => {
    let s = sectionAndStrokeWithSeats(initial);
    expect(s.seats).toHaveLength(10);
    expect(s.placementGroups).toHaveLength(1);
    const strokeId = s.strokes[0]!.id;

    s = act(s, { type: "DELETE_STROKE", strokeId });
    expect(s.strokes).toHaveLength(0);
    expect(s.seats).toHaveLength(0);
    expect(s.placementGroups).toHaveLength(0);
  });

  it("MOVE_STROKE_POINT recomputes linked stroke placement group seats", () => {
    let s = sectionAndStrokeWithSeats(initial);
    const strokeId = s.strokes[0]!.id;
    const seatsBefore = s.seats.map((seat) => ({ ...seat.position }));

    // Move end point from (200,0) to (200,100)
    s = act(s, {
      type: "MOVE_STROKE_POINT",
      strokeId,
      pointIndex: 1,
      position: { x: 200, y: 100 },
    });
    expect(s.seats).toHaveLength(10);

    // Positions should have changed (y values should no longer all be 0)
    const seatsAfter = s.seats.map((seat) => ({ ...seat.position }));
    const anyYChanged = seatsAfter.some((pos) => Math.abs(pos.y) > 0.01);
    expect(anyYChanged).toBe(true);
  });

  it("UPDATE_STROKE_HANDLE recomputes linked stroke placement group seats", () => {
    let s = sectionAndStrokeWithSeats(initial);
    const strokeId = s.strokes[0]!.id;

    // Add a handle to curve the stroke
    s = act(s, {
      type: "UPDATE_STROKE_HANDLE",
      strokeId,
      pointIndex: 0,
      handle: "out",
      position: { x: 50, y: 80 },
    });
    expect(s.seats).toHaveLength(10);

    // Seats should be placed along the curved path now, so y values should differ
    const anyYChanged = s.seats.some(
      (seat) => Math.abs(seat.position.y) > 0.01,
    );
    expect(anyYChanged).toBe(true);
  });
});

// ── deletedIndices preservation ──────────────────────────────────────
describe("designerReducer — deletedIndices", () => {
  let initial: DesignerState;
  beforeEach(() => {
    resetSectionCounter();
    resetGroupCounter();
    initial = createInitialState();
  });

  /** Helper: create section + line group with 5 seats */
  function sectionWithLineGroup(s: DesignerState): DesignerState {
    s = acts(
      s,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: -10, y: -10 } },
      { type: "ADD_POLYGON_POINT", point: { x: 500, y: -10 } },
      { type: "ADD_POLYGON_POINT", point: { x: 500, y: 200 } },
      { type: "ADD_POLYGON_POINT", point: { x: -10, y: 200 } },
      { type: "CLOSE_POLYGON", color: "#ff0000" },
    );
    s = act(s, {
      type: "COMMIT_LINE_PLACEMENT",
      start: { x: 0, y: 0 },
      end: { x: 400, y: 0 },
      count: 5,
      spacing: 0,
    });
    return s;
  }

  it("DELETE_SELECTED records deleted seat index in deletedIndices", () => {
    let s = sectionWithLineGroup(initial);
    expect(s.seats).toHaveLength(5);
    expect(s.placementGroups).toHaveLength(1);
    const group = s.placementGroups[0]!;
    // Delete the middle seat (index 2)
    const middleSeatId = group.seatIds[2]!;
    s = { ...s, selectedSeatIds: new Set([middleSeatId]) };
    s = act(s, { type: "DELETE_SELECTED" });
    expect(s.seats).toHaveLength(4);
    const updatedGroup = s.placementGroups[0]!;
    expect(updatedGroup.seatIds).toHaveLength(4);
    expect(updatedGroup.deletedIndices).toEqual([2]);
  });

  it("deletedIndices survives spacing-only change", () => {
    let s = sectionWithLineGroup(initial);
    const group = s.placementGroups[0]!;
    // Delete seat at index 1
    const seatId = group.seatIds[1]!;
    s = { ...s, selectedSeatIds: new Set([seatId]) };
    s = act(s, { type: "DELETE_SELECTED" });
    expect(s.placementGroups[0]!.deletedIndices).toEqual([1]);

    // Change spacing to 100 on a 400px line → still 5 total positions → 4 after deletion
    s = act(s, {
      type: "UPDATE_PLACEMENT_GROUP",
      groupId: group.id,
      updates: { spacing: 100 },
    });
    expect(s.placementGroups[0]!.deletedIndices).toEqual([1]);
    // Still 4 seats (5 positions minus 1 deleted)
    expect(s.placementGroups[0]!.seatIds).toHaveLength(4);
  });

  it("deletedIndices cleared on count change", () => {
    let s = sectionWithLineGroup(initial);
    const group = s.placementGroups[0]!;
    // Delete seat at index 1
    const seatId = group.seatIds[1]!;
    s = { ...s, selectedSeatIds: new Set([seatId]) };
    s = act(s, { type: "DELETE_SELECTED" });
    expect(s.placementGroups[0]!.deletedIndices).toEqual([1]);

    // Change count → structure changed → deletedIndices cleared
    s = act(s, {
      type: "UPDATE_PLACEMENT_GROUP",
      groupId: group.id,
      updates: { count: 8 },
    });
    expect(s.placementGroups[0]!.deletedIndices).toBeUndefined();
    // Should have 8 seats now (all positions present)
    expect(s.placementGroups[0]!.seatIds).toHaveLength(8);
    expect(s.seats).toHaveLength(8);
  });

  it("multiple deletions accumulate in deletedIndices", () => {
    let s = sectionWithLineGroup(initial);
    const group = s.placementGroups[0]!;
    // Delete seat at index 0
    s = { ...s, selectedSeatIds: new Set([group.seatIds[0]!]) };
    s = act(s, { type: "DELETE_SELECTED" });
    expect(s.placementGroups[0]!.deletedIndices).toEqual([0]);
    expect(s.placementGroups[0]!.seatIds).toHaveLength(4);

    // Delete what was originally at index 3 (now at list index 2 because 0 was removed)
    const updatedGroup = s.placementGroups[0]!;
    s = { ...s, selectedSeatIds: new Set([updatedGroup.seatIds[2]!]) };
    s = act(s, { type: "DELETE_SELECTED" });
    expect(s.placementGroups[0]!.deletedIndices).toEqual([0, 3]);
    expect(s.placementGroups[0]!.seatIds).toHaveLength(3);
  });

  it("UPDATE_LINE_GROUP_GEOMETRY preserves deletedIndices", () => {
    let s = sectionWithLineGroup(initial);
    const group = s.placementGroups[0]!;
    // Delete seat at index 2
    s = { ...s, selectedSeatIds: new Set([group.seatIds[2]!]) };
    s = act(s, { type: "DELETE_SELECTED" });
    expect(s.placementGroups[0]!.deletedIndices).toEqual([2]);

    // Move the line group geometry
    if (group.kind !== "line") throw new Error("Expected line group");
    s = act(s, {
      type: "UPDATE_LINE_GROUP_GEOMETRY",
      groupId: group.id,
      updates: { start: { x: 10, y: 10 }, end: { x: 410, y: 10 } },
    });
    // deletedIndices should survive the geometry change
    expect(s.placementGroups[0]!.deletedIndices).toEqual([2]);
    expect(s.placementGroups[0]!.seatIds).toHaveLength(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findNearestVertex
// ─────────────────────────────────────────────────────────────────────────────

describe("findNearestVertex", () => {
  const sectionA: DesignerSection = {
    sectionId: "A",
    label: "A",
    color: "#f00",
    polygon: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ],
    kind: "seat",
  };

  const sectionB: DesignerSection = {
    sectionId: "B",
    label: "B",
    color: "#0f0",
    polygon: [
      { x: 100, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 100 },
      { x: 100, y: 100 },
    ],
    kind: "seat",
  };

  it("finds the nearest vertex within threshold", () => {
    // (102,2) is ~2.8px from sectionB's vertex at (100,0) — same distance as
    // sectionA's vertex at (100,0). The first section wins ties, but we test
    // the point value which is unambiguous.
    const result = findNearestVertex([sectionA, sectionB], { x: 102, y: 2 });
    expect(result).not.toBeNull();
    expect(result!.point).toEqual({ x: 100, y: 0 });
  });

  it("returns null when nothing is within threshold", () => {
    const result = findNearestVertex(
      [sectionA],
      { x: 500, y: 500 },
      undefined,
      10,
    );
    expect(result).toBeNull();
  });

  it("excludes a specific section by id", () => {
    // Point is closest to sectionA vertex at (100,0), but we exclude A
    const result = findNearestVertex(
      [sectionA, sectionB],
      { x: 99, y: 1 },
      "A",
    );
    expect(result).not.toBeNull();
    // Should snap to sectionB's vertex at (100,0) instead
    expect(result!.sectionId).toBe("B");
    expect(result!.point).toEqual({ x: 100, y: 0 });
  });

  it("respects a custom threshold", () => {
    // Point is 5px away from (100,0)
    const result = findNearestVertex(
      [sectionA],
      { x: 103, y: 4 },
      undefined,
      2,
    );
    expect(result).toBeNull();

    const result2 = findNearestVertex(
      [sectionA],
      { x: 103, y: 4 },
      undefined,
      10,
    );
    expect(result2).not.toBeNull();
  });

  it("picks the closest when multiple vertices are within range", () => {
    // (100,0) belongs to both sectionA[1] and sectionB[0].
    // Point at (101,1) is ~1.4px from both — either is acceptable.
    // But (100,100) from sectionA[2] and sectionB[3] is ~99px away so not picked.
    const result = findNearestVertex(
      [sectionA, sectionB],
      { x: 101, y: 1 },
      undefined,
      20,
    );
    expect(result).not.toBeNull();
    expect(result!.point).toEqual({ x: 100, y: 0 });
  });

  it("returns null for an empty sections list", () => {
    expect(findNearestVertex([], { x: 50, y: 50 })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Vertex-snap reducer actions
// ─────────────────────────────────────────────────────────────────────────────

describe("designerReducer — vertex snap", () => {
  let initial: DesignerState;

  beforeEach(() => {
    resetSectionCounter();
    resetGroupCounter();
    initial = createInitialState();
  });

  it("initialises with vertexSnapEnabled=true and snapTarget=null", () => {
    expect(initial.vertexSnapEnabled).toBe(true);
    expect(initial.snapTarget).toBeNull();
  });

  it("TOGGLE_VERTEX_SNAP flips the flag and clears snapTarget", () => {
    const withTarget = act(initial, {
      type: "SET_SNAP_TARGET",
      target: { point: { x: 1, y: 2 }, sectionId: "s1", pointIndex: 0 },
    });
    expect(withTarget.snapTarget).not.toBeNull();

    const toggled = act(withTarget, { type: "TOGGLE_VERTEX_SNAP" });
    expect(toggled.vertexSnapEnabled).toBe(false);
    expect(toggled.snapTarget).toBeNull();
  });

  it("SET_SNAP_TARGET sets and clears the snap target", () => {
    const target = { point: { x: 10, y: 20 }, sectionId: "s", pointIndex: 2 };
    const s1 = act(initial, { type: "SET_SNAP_TARGET", target });
    expect(s1.snapTarget).toEqual(target);

    const s2 = act(s1, { type: "SET_SNAP_TARGET", target: null });
    expect(s2.snapTarget).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Catmull-Rom Tessellation
// ─────────────────────────────────────────────────────────────────────────────

describe("catmullRomTessellate", () => {
  const TRIANGLE: Point[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 50, y: 80 },
  ];

  it("returns the original polygon when smoothing is 0", () => {
    const result = catmullRomTessellate(TRIANGLE, 0);
    expect(result).toBe(TRIANGLE); // same reference
  });

  it("returns the original polygon when fewer than 3 points", () => {
    const line = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ];
    const result = catmullRomTessellate(line, 0.5);
    expect(result).toBe(line);
  });

  it("produces more points than the original when smoothing > 0", () => {
    const result = catmullRomTessellate(TRIANGLE, 0.5);
    expect(result.length).toBeGreaterThan(TRIANGLE.length);
  });

  it("produces even more points at smoothing = 1 vs 0.25", () => {
    const lowSmooth = catmullRomTessellate(TRIANGLE, 0.25);
    const fullSmooth = catmullRomTessellate(TRIANGLE, 1);
    expect(fullSmooth.length).toBeGreaterThan(lowSmooth.length);
  });

  it("output passes through (near) the original control points", () => {
    const result = catmullRomTessellate(SQUARE, 1);
    // Each control point is the start of a segment at t=0 → should appear in output
    for (const cp of SQUARE) {
      const closest = result.reduce(
        (best, p) => {
          const d = Math.hypot(p.x - cp.x, p.y - cp.y);
          return d < best.d ? { d, p } : best;
        },
        { d: Infinity, p: result[0]! },
      );
      // At t=0 the spline evaluates exactly to p1, so distance should be ~0
      expect(closest.d).toBeLessThan(0.01);
    }
  });

  it("closed polygon wraps smoothly (no gap at seam)", () => {
    const result = catmullRomTessellate(SQUARE, 0.8);
    const first = result[0]!;
    const last = result[result.length - 1]!;
    // The last tessellated point and first should be close (the close
    // path fills the gap between them)
    const gapDistance = Math.hypot(last.x - first.x, last.y - first.y);
    // Should be within one segment span — not a huge gap
    expect(gapDistance).toBeLessThan(20);
  });

  it("all output points have finite coordinates", () => {
    const result = catmullRomTessellate(SQUARE, 0.7);
    for (const p of result) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });
});

describe("tessellatedPolygon", () => {
  const section: DesignerSection = {
    sectionId: "test",
    label: "Test",
    color: "#ff0000",
    polygon: SQUARE,
    kind: "seat",
  };

  it("returns raw polygon when no smoothing", () => {
    expect(tessellatedPolygon(section)).toBe(SQUARE);
  });

  it("returns raw polygon when smoothing is 0", () => {
    expect(tessellatedPolygon({ ...section, smoothing: 0 })).toBe(SQUARE);
  });

  it("returns tessellated polygon when smoothing > 0", () => {
    const result = tessellatedPolygon({ ...section, smoothing: 0.5 });
    expect(result.length).toBeGreaterThan(SQUARE.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SET_SECTION_SMOOTHING action
// ─────────────────────────────────────────────────────────────────────────────

describe("SET_SECTION_SMOOTHING", () => {
  let initial: DesignerState;

  beforeEach(() => {
    resetSectionCounter();
    resetGroupCounter();
    initial = createInitialState();
    // Create a section via the standard polygon flow
    initial = acts(
      initial,
      { type: "SET_TOOL", tool: "draw_section" },
      { type: "ADD_POLYGON_POINT", point: { x: 0, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 100, y: 0 } },
      { type: "ADD_POLYGON_POINT", point: { x: 50, y: 80 } },
      { type: "CLOSE_POLYGON", color: "#ff0000" },
    );
  });

  it("sets smoothing on a section", () => {
    const sectionId = initial.sections[0]!.sectionId;
    const result = act(initial, {
      type: "SET_SECTION_SMOOTHING",
      sectionId,
      smoothing: 0.7,
    });
    expect(result.sections[0]!.smoothing).toBe(0.7);
  });

  it("clamps smoothing to [0, 1]", () => {
    const sectionId = initial.sections[0]!.sectionId;
    const over = act(initial, {
      type: "SET_SECTION_SMOOTHING",
      sectionId,
      smoothing: 1.5,
    });
    expect(over.sections[0]!.smoothing).toBe(1);

    const under = act(initial, {
      type: "SET_SECTION_SMOOTHING",
      sectionId,
      smoothing: -0.3,
    });
    expect(under.sections[0]!.smoothing).toBeUndefined();
  });

  it("stores undefined when smoothing is set to 0", () => {
    const sectionId = initial.sections[0]!.sectionId;
    const withSmoothing = act(initial, {
      type: "SET_SECTION_SMOOTHING",
      sectionId,
      smoothing: 0.5,
    });
    const cleared = act(withSmoothing, {
      type: "SET_SECTION_SMOOTHING",
      sectionId,
      smoothing: 0,
    });
    expect(cleared.sections[0]!.smoothing).toBeUndefined();
  });

  it("supports undo", () => {
    const sectionId = initial.sections[0]!.sectionId;
    const smoothed = act(initial, {
      type: "SET_SECTION_SMOOTHING",
      sectionId,
      smoothing: 0.8,
    });
    expect(smoothed.sections[0]!.smoothing).toBe(0.8);

    const undone = act(smoothed, { type: "UNDO" });
    expect(undone.sections[0]!.smoothing).toBeUndefined();
  });

  it("ignores unknown section IDs", () => {
    const result = act(initial, {
      type: "SET_SECTION_SMOOTHING",
      sectionId: "nonexistent",
      smoothing: 0.5,
    });
    expect(result).toBe(initial);
  });
});
