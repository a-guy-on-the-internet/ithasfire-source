// ─────────────────────────────────────────────────────────────────────────────
// Place Layout Designer — state reducer
// ─────────────────────────────────────────────────────────────────────────────

import type {
  DesignerState,
  DesignerAction,
  DesignerSection,
  DesignerSeat,
  DesignerStroke,
  StrokeControlPoint,
  ArcPlacementGroup,
  UndoSnapshot,
  UndoEntry,
  Point,
  PlacementGroup,
  SnapTarget,
  EdgeSmoothingFlag,
} from "./types";

let _sectionCounter = 0;

function nextSectionId(): string {
  _sectionCounter += 1;
  return `section-${_sectionCounter}`;
}

/** Reset counter (useful for tests or fresh loads). */
export function resetSectionCounter(value = 0): void {
  _sectionCounter = value;
}

function generateSeatId(
  sectionId: string,
  row: string,
  seatNum: number,
): string {
  return `${sectionId}-${row}-${seatNum}`;
}

let _groupCounter = 0;

function nextGroupId(): string {
  _groupCounter += 1;
  return `pg-${_groupCounter}`;
}

/** Reset group counter (useful for tests). */
export function resetGroupCounter(value = 0): void {
  _groupCounter = value;
}

let _strokeCounter = 0;

function nextStrokeId(): string {
  _strokeCounter += 1;
  return `stroke-${_strokeCounter}`;
}

/** Reset stroke counter (useful for tests). */
export function resetStrokeCounter(value = 0): void {
  _strokeCounter = value;
}

const DEFAULT_MAX_UNDO = 50;

/**
 * Increment a row label: A→B, Z→AA, AZ→BA, etc.
 * Mirrors spreadsheet-column naming.
 */
export function nextRowLabel(label: string): string {
  const chars = label.toUpperCase().split("");
  let carry = true;
  for (let i = chars.length - 1; i >= 0 && carry; i--) {
    const code = chars[i]!.charCodeAt(0);
    if (code < 90) {
      // A-Y → just increment
      chars[i] = String.fromCharCode(code + 1);
      carry = false;
    } else {
      // Z → wrap to A and carry
      chars[i] = "A";
    }
  }
  if (carry) chars.unshift("A"); // all were Z → prepend A (e.g. Z→AA)
  return chars.join("");
}

export function createInitialState(): DesignerState {
  return {
    sections: [],
    seats: [],
    strokes: [],
    stage: null,
    image: null,
    activeTool: "select",
    drawingPolygon: [],
    drawingSectionKind: "seat",
    activeSectionId: null,
    selectedSeatIds: new Set(),
    selectedSectionIds: new Set(),
    selectedStrokeIds: new Set(),
    imageSelected: false,
    defaultSeatRadius: 4,
    currentRow: "A",
    nextSeatNumber: 1,
    layoutName: "",
    undoStack: [],
    redoStack: [],
    maxUndoDepth: DEFAULT_MAX_UNDO,
    batchCount: 10,
    batchGridRows: 3,
    batchSpacing: 10,
    batchSpacingX: 0,
    batchSpacingY: 0,
    placementPreview: null,
    placementGroups: [],
    selectedPlacementGroupId: null,
    boxSectionStart: null,
    circleSectionCenter: null,
    drawingStrokePoints: [],
    strokeColor: "#333333",
    strokeWidth: 2,
    seatVisibilityThreshold: 0.3,
    vertexSnapEnabled: true,
    snapTarget: null,
    selectedEdge: null,
  };
}

// ── Undo helpers ─────────────────────────────────────────────────────────

function snapshot(state: DesignerState): UndoSnapshot {
  return {
    sections: state.sections.map((s) => ({
      ...s,
      polygon: [...s.polygon],
      edgeSmoothing: s.edgeSmoothing
        ? s.edgeSmoothing.map((f) => ({ ...f }))
        : undefined,
    })),
    seats: state.seats.map((s) => ({ ...s, position: { ...s.position } })),
    strokes: state.strokes.map((s) => ({
      ...s,
      points: s.points.map((p) => ({
        ...p,
        position: { ...p.position },
        handleIn: p.handleIn ? { ...p.handleIn } : null,
        handleOut: p.handleOut ? { ...p.handleOut } : null,
      })),
    })),
    stage: state.stage
      ? { ...state.stage, bounds: { ...state.stage.bounds } }
      : null,
    image: state.image
      ? { ...state.image, position: { ...state.image.position } }
      : null,
    placementGroups: state.placementGroups.map((g) => ({
      ...g,
      seatIds: [...g.seatIds],
      deletedIndices: g.deletedIndices ? [...g.deletedIndices] : undefined,
    })),
    drawingPolygon: state.drawingPolygon.map((p) => ({ ...p })),
    drawingStrokePoints: state.drawingStrokePoints.map((cp) => ({
      position: { ...cp.position },
      handleIn: cp.handleIn ? { ...cp.handleIn } : null,
      handleOut: cp.handleOut ? { ...cp.handleOut } : null,
    })),
  };
}

/**
 * Record an action-based undo entry: captures `before` snapshot from current
 * state, returns a function to call with the `after` state to produce the
 * final undo/redo stacks.
 */
function beginUndoEntry(
  state: DesignerState,
  label: string,
): {
  before: UndoSnapshot;
  finalize: (after: DesignerState) => {
    undoStack: UndoEntry[];
    redoStack: UndoEntry[];
  };
} {
  const before = snapshot(state);
  return {
    before,
    finalize(after: DesignerState) {
      const entry: UndoEntry = { label, before, after: snapshot(after) };
      const stack = [...state.undoStack, entry];
      if (stack.length > state.maxUndoDepth) {
        stack.splice(0, stack.length - state.maxUndoDepth);
      }
      return { undoStack: stack, redoStack: [] };
    },
  };
}

/**
 * Convenience: push an undo entry that captures state before and after in one shot.
 * Used when we can compute the full new state inline.
 */
function pushUndoEntry(
  state: DesignerState,
  label: string,
  newState: Partial<DesignerState>,
): DesignerState {
  const before = snapshot(state);
  const merged = { ...state, ...newState };
  const after = snapshot(merged);
  const entry: UndoEntry = { label, before, after };
  const stack = [...state.undoStack, entry];
  if (stack.length > state.maxUndoDepth) {
    stack.splice(0, stack.length - state.maxUndoDepth);
  }
  return { ...merged, undoStack: stack, redoStack: [] };
}

/** Restore an undo snapshot onto the state (replaces layout data only). */
function restoreSnapshot(
  state: DesignerState,
  snap: UndoSnapshot,
): DesignerState {
  // Preserve activeSectionId only if that section still exists in the snapshot
  const sectionIds = new Set(snap.sections.map((s) => s.sectionId));
  const activeSectionId =
    state.activeSectionId && sectionIds.has(state.activeSectionId)
      ? state.activeSectionId
      : snap.sections.length > 0
        ? snap.sections[0]!.sectionId
        : null;

  // Preserve selectedPlacementGroupId if that group still exists in the snapshot
  const groupIds = new Set(snap.placementGroups.map((g) => g.id));
  const selectedPlacementGroupId =
    state.selectedPlacementGroupId &&
    groupIds.has(state.selectedPlacementGroupId)
      ? state.selectedPlacementGroupId
      : null;

  // Preserve selected seat IDs that still exist in the snapshot
  const seatIds = new Set(snap.seats.map((s) => s.id));
  const selectedSeatIds = new Set(
    [...state.selectedSeatIds].filter((id) => seatIds.has(id)),
  );

  // Preserve selected section IDs that still exist in the snapshot
  const selectedSectionIds = new Set(
    [...state.selectedSectionIds].filter((id) => sectionIds.has(id)),
  );

  // Preserve selected stroke IDs that still exist in the snapshot
  const strokeIds = new Set(snap.strokes.map((s) => s.id));
  const selectedStrokeIds = new Set(
    [...state.selectedStrokeIds].filter((id) => strokeIds.has(id)),
  );

  return {
    ...state,
    sections: snap.sections,
    seats: snap.seats,
    strokes: snap.strokes,
    stage: snap.stage,
    image: snap.image,
    placementGroups: snap.placementGroups,
    activeSectionId,
    selectedSeatIds,
    selectedSectionIds,
    selectedStrokeIds,
    selectedPlacementGroupId,
    imageSelected: state.imageSelected && snap.image !== null,
    drawingPolygon: snap.drawingPolygon ?? [],
    drawingStrokePoints: snap.drawingStrokePoints ?? [],
  };
}

// ── Reducer ──────────────────────────────────────────────────────────────

export function designerReducer(
  state: DesignerState,
  action: DesignerAction,
): DesignerState {
  switch (action.type) {
    // ── Tool switching ───────────────────────────────────────────────────
    case "SET_TOOL": {
      // Auto-commit in-progress stroke when switching away from draw_stroke
      let base = state;
      if (
        action.tool !== "draw_stroke" &&
        state.drawingStrokePoints.length >= 2
      ) {
        const stroke: DesignerStroke = {
          id: nextStrokeId(),
          points: state.drawingStrokePoints.map((cp) => ({
            position: { ...cp.position },
            handleIn: cp.handleIn ? { ...cp.handleIn } : null,
            handleOut: cp.handleOut ? { ...cp.handleOut } : null,
          })),
          closed: false,
          color: state.strokeColor,
          strokeWidth: state.strokeWidth,
        };
        base = pushUndoEntry(state, `Create stroke ${stroke.id}`, {
          strokes: [...state.strokes, stroke],
          drawingStrokePoints: [],
        });
      }
      return {
        ...base,
        activeTool: action.tool,
        // Cancel in-progress drawing when switching away
        drawingPolygon:
          action.tool === "draw_section" ? base.drawingPolygon : [],
        // Clear batch placement preview on tool switch
        placementPreview: null,
        // Cancel box section drawing
        boxSectionStart:
          action.tool === "draw_box_section" ? base.boxSectionStart : null,
        // Cancel circle section drawing
        circleSectionCenter:
          action.tool === "draw_circle_section"
            ? base.circleSectionCenter
            : null,
        // Clear stroke points (already committed above if ≥2, otherwise discard single point)
        drawingStrokePoints:
          action.tool === "draw_stroke" ? base.drawingStrokePoints : [],
        // Clear edge selection on tool switch
        selectedEdge: null,
      };
    }

    case "SET_ACTIVE_SECTION":
      return { ...state, activeSectionId: action.sectionId };

    // ── Section polygon drawing ──────────────────────────────────────────
    case "ADD_POLYGON_POINT":
      return pushUndoEntry(state, "Add polygon point", {
        drawingPolygon: [...state.drawingPolygon, action.point],
      });

    case "SET_DRAWING_SECTION_KIND":
      return { ...state, drawingSectionKind: action.sectionKind };

    case "CLOSE_POLYGON": {
      if (state.drawingPolygon.length < 3) return state;
      const kind = action.sectionKind ?? state.drawingSectionKind;
      const sectionId = nextSectionId();
      const newSection: DesignerSection = {
        sectionId,
        label: sectionId,
        color: action.color,
        polygon: [...state.drawingPolygon],
        kind,
        // GA sections get a default capacity; seat sections derive it from placed seats.
        capacity: kind === "ga" ? 100 : undefined,
      };
      const partial: Partial<DesignerState> = {
        sections: [...state.sections, newSection],
        drawingPolygon: [],
        // Seat sections: auto-switch to place_seat and reset row counters.
        // GA sections: select the section (for capacity editing) but stay on select tool.
        // Helper sections: no change.
        activeSectionId: kind !== "helper" ? sectionId : state.activeSectionId,
        activeTool:
          kind === "seat"
            ? "place_seat"
            : kind === "ga"
              ? "select"
              : state.activeTool,
        currentRow: kind === "seat" ? "A" : state.currentRow,
        nextSeatNumber: kind === "seat" ? 1 : state.nextSeatNumber,
      };
      return pushUndoEntry(state, `Create section ${sectionId}`, partial);
    }

    case "CANCEL_DRAWING":
      return { ...state, drawingPolygon: [] };

    // ── Seat placement (constrained to active section polygon) ───────────
    case "PLACE_SEAT": {
      if (!state.activeSectionId) return state;
      const section = state.sections.find(
        (s) => s.sectionId === state.activeSectionId,
      );
      if (section?.kind !== "seat") return state;

      // Constrain: seat must be inside the section polygon
      if (
        section.polygon.length >= 3 &&
        !pointInPolygon(action.position, tessellatedPolygon(section))
      ) {
        return state; // silently reject — seat outside polygon
      }

      const seatId = generateSeatId(
        state.activeSectionId,
        state.currentRow,
        state.nextSeatNumber,
      );
      const newSeat: DesignerSeat = {
        id: seatId,
        sectionId: state.activeSectionId,
        row: state.currentRow,
        seat: String(state.nextSeatNumber),
        position: action.position,
        radius: state.defaultSeatRadius,
        rotationDeg: 0,
      };
      return pushUndoEntry(state, `Place seat ${seatId}`, {
        seats: [...state.seats, newSeat],
        nextSeatNumber: state.nextSeatNumber + 1,
      });
    }

    // ── Stage placement (kept for CSV compat) ─────────────────────────
    case "SET_STAGE_DRAW_START":
      return state; // no-op — stages are now helper sections

    case "PLACE_STAGE":
      return pushUndoEntry(state, "Place stage", {
        stage: {
          kind: "rectangle",
          label: action.label,
          bounds: action.bounds,
        },
        activeTool: "select",
      });

    case "REMOVE_STAGE":
      return pushUndoEntry(state, "Remove stage", { stage: null });

    // ── Selection ────────────────────────────────────────────────────────
    case "SELECT_SEAT": {
      const next = new Set(action.additive ? state.selectedSeatIds : []);
      if (next.has(action.seatId)) {
        next.delete(action.seatId);
      } else {
        next.add(action.seatId);
      }
      return {
        ...state,
        selectedSeatIds: next,
        selectedSectionIds: new Set(),
        selectedStrokeIds: new Set(),
        imageSelected: false,
      };
    }

    case "SELECT_SECTION": {
      const next = new Set(action.additive ? state.selectedSectionIds : []);
      if (next.has(action.sectionId)) {
        next.delete(action.sectionId);
      } else {
        next.add(action.sectionId);
      }
      return {
        ...state,
        selectedSectionIds: next,
        selectedSeatIds: new Set(),
        selectedStrokeIds: new Set(),
        imageSelected: false,
      };
    }

    case "SELECT_STROKE": {
      const next = new Set(action.additive ? state.selectedStrokeIds : []);
      if (next.has(action.strokeId)) {
        next.delete(action.strokeId);
      } else {
        next.add(action.strokeId);
      }
      return {
        ...state,
        selectedStrokeIds: next,
        selectedSeatIds: new Set(),
        selectedSectionIds: new Set(),
        imageSelected: false,
      };
    }

    case "SELECT_IMAGE":
      return {
        ...state,
        imageSelected: true,
        selectedSeatIds: new Set(),
        selectedSectionIds: new Set(),
        selectedStrokeIds: new Set(),
      };

    case "CLEAR_SELECTION":
      return {
        ...state,
        selectedSeatIds: new Set(),
        selectedSectionIds: new Set(),
        selectedStrokeIds: new Set(),
        imageSelected: false,
      };

    // ── Deletion ─────────────────────────────────────────────────────────
    case "DELETE_SELECTED": {
      const seatIds = state.selectedSeatIds;
      const sectionIds = state.selectedSectionIds;
      const strokeIds = state.selectedStrokeIds;
      if (seatIds.size === 0 && sectionIds.size === 0 && strokeIds.size === 0)
        return state;
      // Deleting a section also deletes its seats
      const seats = state.seats.filter(
        (s) => !seatIds.has(s.id) && !sectionIds.has(s.sectionId),
      );
      const sections = state.sections.filter(
        (s) => !sectionIds.has(s.sectionId),
      );
      const strokes = state.strokes.filter((s) => !strokeIds.has(s.id));
      const activeSectionId =
        state.activeSectionId && sectionIds.has(state.activeSectionId)
          ? null
          : state.activeSectionId;
      // Remove deleted seat IDs from placement groups, track deleted indices,
      // and prune empty groups
      const deletedSeatIdSet = new Set([...seatIds]);
      for (const sid of sectionIds) {
        for (const seat of state.seats) {
          if (seat.sectionId === sid) deletedSeatIdSet.add(seat.id);
        }
      }
      const placementGroups = state.placementGroups
        .map((g) => {
          const removedFromGroup = g.seatIds
            .map((id, idx) => (deletedSeatIdSet.has(id) ? idx : -1))
            .filter((idx) => idx >= 0);
          if (removedFromGroup.length === 0) return g;
          const prevDeleted = g.deletedIndices ?? [];
          // Map seat-list index back to the original position index accounting
          // for previous deletions.  The current seatIds array already has gaps
          // from earlier deletions, so we need to map through the cumulative
          // position-index list.
          const existingPositionIndices = buildExistingPositionIndices(g);
          const newDeletedOriginalIndices = removedFromGroup.map(
            (seatListIdx) => existingPositionIndices[seatListIdx]!,
          );
          const mergedDeleted = [
            ...new Set([...prevDeleted, ...newDeletedOriginalIndices]),
          ].sort((a, b) => a - b);
          return {
            ...g,
            seatIds: g.seatIds.filter((id) => !deletedSeatIdSet.has(id)),
            deletedIndices: mergedDeleted,
          };
        })
        .filter((g) => g.seatIds.length > 0);
      return pushUndoEntry(state, "Delete selected", {
        seats,
        sections,
        strokes,
        activeSectionId,
        selectedSeatIds: new Set(),
        selectedSectionIds: new Set(),
        selectedStrokeIds: new Set(),
        placementGroups,
        selectedPlacementGroupId: placementGroups.find(
          (g) => g.id === state.selectedPlacementGroupId,
        )
          ? state.selectedPlacementGroupId
          : null,
      });
    }

    case "DELETE_SECTION": {
      const deletedSeatIds = new Set(
        state.seats
          .filter((s) => s.sectionId === action.sectionId)
          .map((s) => s.id),
      );
      const placementGroups = state.placementGroups
        .map((g) => ({
          ...g,
          seatIds: g.seatIds.filter((id) => !deletedSeatIds.has(id)),
        }))
        .filter((g) => g.seatIds.length > 0);
      return pushUndoEntry(state, `Delete section ${action.sectionId}`, {
        sections: state.sections.filter(
          (s) => s.sectionId !== action.sectionId,
        ),
        seats: state.seats.filter((s) => s.sectionId !== action.sectionId),
        activeSectionId:
          state.activeSectionId === action.sectionId
            ? null
            : state.activeSectionId,
        selectedSectionIds: (() => {
          const next = new Set(state.selectedSectionIds);
          next.delete(action.sectionId);
          return next;
        })(),
        placementGroups,
        selectedPlacementGroupId: placementGroups.find(
          (g) => g.id === state.selectedPlacementGroupId,
        )
          ? state.selectedPlacementGroupId
          : null,
      });
    }

    case "DELETE_STROKE": {
      // Also remove any stroke placement groups linked to this stroke
      const linkedGroups = state.placementGroups.filter(
        (g) => g.kind === "stroke" && g.strokeId === action.strokeId,
      );
      const linkedSeatIds = new Set(linkedGroups.flatMap((g) => g.seatIds));
      return pushUndoEntry(state, `Delete stroke ${action.strokeId}`, {
        strokes: state.strokes.filter((s) => s.id !== action.strokeId),
        seats:
          linkedSeatIds.size > 0
            ? state.seats.filter((s) => !linkedSeatIds.has(s.id))
            : state.seats,
        placementGroups:
          linkedGroups.length > 0
            ? state.placementGroups.filter(
                (g) => !(g.kind === "stroke" && g.strokeId === action.strokeId),
              )
            : state.placementGroups,
        selectedStrokeIds: (() => {
          const next = new Set(state.selectedStrokeIds);
          next.delete(action.strokeId);
          return next;
        })(),
        selectedPlacementGroupId: linkedGroups.some(
          (g) => g.id === state.selectedPlacementGroupId,
        )
          ? null
          : state.selectedPlacementGroupId,
      });
    }

    // ── Section updates ──────────────────────────────────────────────────
    case "UPDATE_SECTION_COLOR":
      return {
        ...state,
        sections: state.sections.map((s) =>
          s.sectionId === action.sectionId ? { ...s, color: action.color } : s,
        ),
      };

    case "UPDATE_SECTION_LABEL":
      return {
        ...state,
        sections: state.sections.map((s) =>
          s.sectionId === action.sectionId ? { ...s, label: action.label } : s,
        ),
      };

    case "SET_SECTION_CAPACITY": {
      const target = state.sections.find(
        (s) => s.sectionId === action.sectionId,
      );
      // Only GA sections have editable capacity.
      if (target?.kind !== "ga") return state;
      if (action.capacity < 0 || !Number.isFinite(action.capacity))
        return state;
      return {
        ...state,
        sections: state.sections.map((s) =>
          s.sectionId === action.sectionId
            ? { ...s, capacity: action.capacity }
            : s,
        ),
      };
    }

    case "SET_SECTION_METADATA": {
      const target = state.sections.find(
        (s) => s.sectionId === action.sectionId,
      );
      if (!target) return state;
      const metadata = {
        ...(target.metadata ?? {}),
        [action.key]: action.value,
      };
      return {
        ...state,
        sections: state.sections.map((s) =>
          s.sectionId === action.sectionId ? { ...s, metadata } : s,
        ),
      };
    }

    case "DELETE_SECTION_METADATA": {
      const target = state.sections.find(
        (s) => s.sectionId === action.sectionId,
      );
      if (!target?.metadata) return state;
      const { [action.key]: _, ...rest } = target.metadata;
      return {
        ...state,
        sections: state.sections.map((s) =>
          s.sectionId === action.sectionId
            ? {
                ...s,
                metadata: Object.keys(rest).length > 0 ? rest : undefined,
              }
            : s,
        ),
      };
    }

    // ── Section smoothing ────────────────────────────────────────────────
    case "SET_SECTION_SMOOTHING": {
      const target = state.sections.find(
        (s) => s.sectionId === action.sectionId,
      );
      if (!target) return state;
      const clamped = Math.max(0, Math.min(1, action.smoothing));
      // Store undefined when 0 to keep the data lean
      const smoothing = clamped > 0 ? clamped : undefined;
      return pushUndoEntry(state, `Set smoothing ${clamped}`, {
        sections: state.sections.map((s) =>
          s.sectionId === action.sectionId ? { ...s, smoothing } : s,
        ),
      });
    }

    // ── Per-edge smoothing ───────────────────────────────────────────────
    case "SELECT_EDGE": {
      const target = state.sections.find(
        (s) => s.sectionId === action.sectionId,
      );
      if (!target) return state;
      if (action.edgeIndex < 0 || action.edgeIndex >= target.polygon.length)
        return state;
      return {
        ...state,
        selectedEdge: {
          sectionId: action.sectionId,
          edgeIndex: action.edgeIndex,
        },
        activeSectionId: action.sectionId,
      };
    }

    case "CLEAR_EDGE_SELECTION":
      return { ...state, selectedEdge: null };

    case "SET_EDGE_SMOOTHING": {
      const target = state.sections.find(
        (s) => s.sectionId === action.sectionId,
      );
      if (!target) return state;
      if (action.edgeIndex < 0 || action.edgeIndex >= target.polygon.length)
        return state;
      const clamped = Math.max(0, Math.min(1, action.smoothing));

      // Build updated edgeSmoothing array for the target section
      const updatedSections = applyEdgeSmoothing(
        state.sections,
        action.sectionId,
        action.edgeIndex,
        clamped,
      );

      return pushUndoEntry(
        state,
        `Set edge ${action.edgeIndex} smoothing ${clamped}`,
        {
          sections: updatedSections,
        },
      );
    }

    case "SET_EDGE_SMOOTHING_BATCH": {
      const target = state.sections.find(
        (s) => s.sectionId === action.sectionId,
      );
      if (!target) return state;
      const clamped = Math.max(0, Math.min(1, action.smoothing));

      // Apply to every edge of the section
      let sections = state.sections;
      const edgeCount = target.polygon.length;
      for (let i = 0; i < edgeCount; i++) {
        sections = applyEdgeSmoothing(sections, action.sectionId, i, clamped);
      }

      return pushUndoEntry(
        state,
        clamped > 0 ? "Smooth all edges" : "Sharpen all edges",
        {
          sections,
        },
      );
    }

    // ── Row / seat numbering ─────────────────────────────────────────────
    case "SET_CURRENT_ROW":
      return { ...state, currentRow: action.row, nextSeatNumber: 1 };

    case "SET_NEXT_SEAT_NUMBER":
      return { ...state, nextSeatNumber: action.num };

    case "SET_DEFAULT_SEAT_RADIUS":
      return { ...state, defaultSeatRadius: action.radius };

    // ── Toggle ADA-accessible flag on seats ─────────────────────────────
    case "TOGGLE_SEAT_ACCESSIBLE": {
      const targetIds = new Set(action.seatIds);
      if (targetIds.size === 0) return state;
      // If ALL targeted seats are already accessible, turn it off; otherwise turn on.
      const allAccessible = state.seats
        .filter((s) => targetIds.has(s.id))
        .every((s) => s.accessible);
      const newValue = !allAccessible;
      return pushUndoEntry(state, "Toggle ADA accessible", {
        seats: state.seats.map((s) =>
          targetIds.has(s.id) ? { ...s, accessible: newValue } : s,
        ),
      });
    }

    // ── Move selected seats (no undo — BEGIN_DRAG snapshots before drag) ──
    case "MOVE_SELECTED_SEATS": {
      const ids = state.selectedSeatIds;
      if (ids.size === 0) return state;
      return {
        ...state,
        seats: state.seats.map((s) =>
          ids.has(s.id)
            ? {
                ...s,
                position: {
                  x: s.position.x + action.dx,
                  y: s.position.y + action.dy,
                },
              }
            : s,
        ),
      };
    }

    // ── Move selected sections (no undo — BEGIN_DRAG snapshots before drag)
    case "MOVE_SELECTED_SECTIONS": {
      const sids = state.selectedSectionIds;
      if (sids.size === 0) return state;
      return {
        ...state,
        sections: state.sections.map((s) =>
          sids.has(s.sectionId)
            ? {
                ...s,
                polygon: s.polygon.map((p) => ({
                  x: p.x + action.dx,
                  y: p.y + action.dy,
                })),
              }
            : s,
        ),
        seats: state.seats.map((s) =>
          sids.has(s.sectionId)
            ? {
                ...s,
                position: {
                  x: s.position.x + action.dx,
                  y: s.position.y + action.dy,
                },
              }
            : s,
        ),
      };
    }

    // ── Move selected strokes (no undo — BEGIN_DRAG snapshots before drag)
    case "MOVE_SELECTED_STROKES": {
      const ids = state.selectedStrokeIds;
      if (ids.size === 0) return state;
      return {
        ...state,
        strokes: state.strokes.map((s) =>
          ids.has(s.id)
            ? {
                ...s,
                points: s.points.map((cp) => ({
                  ...cp,
                  position: {
                    x: cp.position.x + action.dx,
                    y: cp.position.y + action.dy,
                  },
                })),
              }
            : s,
        ),
      };
    }

    // ── Image management ─────────────────────────────────────────────────
    case "SET_IMAGE":
      return pushUndoEntry(state, "Set image", { image: action.image });

    case "REMOVE_IMAGE":
      if (!state.image) return state;
      return pushUndoEntry(state, "Remove image", {
        image: null,
        imageSelected: false,
      });

    case "SET_IMAGE_OPACITY":
      if (!state.image) return state;
      return { ...state, image: { ...state.image, opacity: action.opacity } };

    case "MOVE_IMAGE":
      if (!state.image) return state;
      return {
        ...state,
        image: {
          ...state.image,
          position: {
            x: state.image.position.x + action.dx,
            y: state.image.position.y + action.dy,
          },
        },
      };

    // ── Begin drag — snapshot undo ONCE before a drag gesture ────────────
    // For drags we use beginUndoEntry and finalize on END_DRAG.
    // But since the old API doesn't have END_DRAG yet, we preserve the
    // same semantics: push a "before" snapshot now. The next mutation (or
    // another BEGIN_DRAG) will overwrite. We store the entry with
    // before === after initially; the draw loop's pointerUp will
    // dispatch END_DRAG to finalize it.
    case "BEGIN_DRAG": {
      const before = snapshot(state);
      const entry: UndoEntry = { label: "Drag", before, after: before };
      const stack = [...state.undoStack, entry];
      if (stack.length > state.maxUndoDepth) {
        stack.splice(0, stack.length - state.maxUndoDepth);
      }
      return { ...state, undoStack: stack, redoStack: [] };
    }

    /**
     * END_DRAG finalizes the most recent drag undo entry.
     * If no layout data actually changed, remove the no-op entry.
     */
    case "END_DRAG": {
      if (state.undoStack.length === 0) return state;
      const stack = [...state.undoStack];
      const entry = stack[stack.length - 1]!;
      if (entry.label !== "Drag") return state; // not a drag entry
      const afterSnap = snapshot(state);
      // Check if anything actually changed by comparing serialized snapshots
      const same =
        JSON.stringify(entry.before.seats.map((s) => s.id)) ===
          JSON.stringify(afterSnap.seats.map((s) => s.id)) &&
        JSON.stringify(entry.before.sections.map((s) => s.sectionId)) ===
          JSON.stringify(afterSnap.sections.map((s) => s.sectionId)) &&
        JSON.stringify(entry.before.placementGroups.map((g) => g.id)) ===
          JSON.stringify(afterSnap.placementGroups.map((g) => g.id)) &&
        entry.before.seats.every(
          (s, i) =>
            afterSnap.seats[i] &&
            s.position.x === afterSnap.seats[i]!.position.x &&
            s.position.y === afterSnap.seats[i]!.position.y,
        ) &&
        entry.before.sections.every(
          (s, i) =>
            afterSnap.sections[i] &&
            JSON.stringify(s.polygon) ===
              JSON.stringify(afterSnap.sections[i]!.polygon),
        );
      if (same) {
        // No-op drag — remove the empty undo entry
        stack.pop();
        return { ...state, undoStack: stack };
      }
      // Real drag — finalize with after snapshot
      stack[stack.length - 1] = { ...entry, after: afterSnap };
      return { ...state, undoStack: stack };
    }

    // ── Layout name ──────────────────────────────────────────────────────
    case "SET_LAYOUT_NAME":
      return { ...state, layoutName: action.name };

    // ── Bulk load (CSV import) ───────────────────────────────────────────
    case "LOAD_STATE":
      return pushUndoEntry(state, "Load state", {
        sections: action.sections,
        seats: action.seats,
        strokes: action.strokes ?? [],
        stage: action.stage,
        selectedSeatIds: new Set(),
        selectedSectionIds: new Set(),
        selectedStrokeIds: new Set(),
        imageSelected: false,
        drawingPolygon: [],
        placementGroups: [],
        selectedPlacementGroupId: null,
      });

    case "CLEAR_ALL": {
      const fresh = createInitialState();
      return pushUndoEntry(state, "Clear all", {
        sections: fresh.sections,
        seats: fresh.seats,
        strokes: fresh.strokes,
        stage: fresh.stage,
        placementGroups: fresh.placementGroups,
        selectedSeatIds: new Set(),
        selectedSectionIds: new Set(),
        selectedStrokeIds: new Set(),
        selectedPlacementGroupId: null,
        drawingPolygon: [],
      });
    }

    // ── Batch placement config ───────────────────────────────────────────
    case "SET_BATCH_COUNT":
      return { ...state, batchCount: Math.max(1, action.count) };

    case "SET_BATCH_GRID_ROWS":
      return { ...state, batchGridRows: Math.max(1, action.rows) };

    case "SET_BATCH_SPACING":
      return { ...state, batchSpacing: Math.max(0, action.spacing) };

    case "SET_BATCH_SPACING_X":
      return { ...state, batchSpacingX: Math.max(0, action.spacing) };

    case "SET_BATCH_SPACING_Y":
      return { ...state, batchSpacingY: Math.max(0, action.spacing) };

    case "SET_PLACEMENT_PREVIEW":
      return { ...state, placementPreview: action.preview };

    // ── Commit line placement ────────────────────────────────────────────
    case "COMMIT_LINE_PLACEMENT": {
      if (!state.activeSectionId) return state;
      const section = state.sections.find(
        (s) => s.sectionId === state.activeSectionId,
      );
      if (section?.kind !== "seat") return state;

      const positions =
        action.spacing > 0
          ? computeLinePositionsWithSpacing(
              action.start,
              action.end,
              action.spacing,
            )
          : computeLinePositions(action.start, action.end, action.count);
      const { newSeats, nextNum } = buildBatchSeats(
        positions,
        section,
        state.activeSectionId,
        state.currentRow,
        state.nextSeatNumber,
        state.defaultSeatRadius,
      );

      if (newSeats.length === 0) return state;

      const group: PlacementGroup = {
        id: nextGroupId(),
        kind: "line",
        start: action.start,
        end: action.end,
        count: action.count,
        spacing: action.spacing,
        sectionId: state.activeSectionId,
        row: state.currentRow,
        startNum: state.nextSeatNumber,
        seatIds: newSeats.map((s) => s.id),
      };

      return pushUndoEntry(state, "Line placement", {
        seats: [...state.seats, ...newSeats],
        nextSeatNumber: 1,
        currentRow: nextRowLabel(state.currentRow),
        placementPreview: null,
        placementGroups: [...state.placementGroups, group],
      });
    }

    // ── Commit arc placement ─────────────────────────────────────────────
    case "COMMIT_ARC_PLACEMENT": {
      if (!state.activeSectionId) return state;
      const section = state.sections.find(
        (s) => s.sectionId === state.activeSectionId,
      );
      if (section?.kind !== "seat") return state;

      const positions =
        action.spacing > 0
          ? computeArcPositionsWithSpacing(
              action.center,
              action.radius,
              action.startAngle,
              action.endAngle,
              action.spacing,
            )
          : computeArcPositions(
              action.center,
              action.radius,
              action.startAngle,
              action.endAngle,
              action.count,
            );
      const { newSeats, nextNum } = buildBatchSeats(
        positions,
        section,
        state.activeSectionId,
        state.currentRow,
        state.nextSeatNumber,
        state.defaultSeatRadius,
      );

      if (newSeats.length === 0) return state;

      const group: PlacementGroup = {
        id: nextGroupId(),
        kind: "arc",
        center: action.center,
        radius: action.radius,
        startAngle: action.startAngle,
        endAngle: action.endAngle,
        arcDeg: (Math.abs(action.endAngle - action.startAngle) * 180) / Math.PI,
        rotationDeg: 0,
        count: action.count,
        spacing: action.spacing,
        sectionId: state.activeSectionId,
        row: state.currentRow,
        startNum: state.nextSeatNumber,
        seatIds: newSeats.map((s) => s.id),
      };

      return pushUndoEntry(state, "Arc placement", {
        seats: [...state.seats, ...newSeats],
        nextSeatNumber: 1,
        currentRow: nextRowLabel(state.currentRow),
        placementPreview: null,
        placementGroups: [...state.placementGroups, group],
      });
    }

    // ── Commit grid placement ────────────────────────────────────────────
    case "COMMIT_GRID_PLACEMENT": {
      if (!state.activeSectionId) return state;
      const section = state.sections.find(
        (s) => s.sectionId === state.activeSectionId,
      );
      if (section?.kind !== "seat") return state;

      const effSpacingX = action.spacingX ?? 0;
      const effSpacingY = action.spacingY ?? 0;
      const hasPerAxisSpacing = effSpacingX > 0 || effSpacingY > 0;

      let positions: Point[];
      if (hasPerAxisSpacing) {
        positions = computeGridPositionsWithSeparateSpacing(
          action.origin,
          action.extent,
          action.rows,
          action.cols,
          effSpacingX,
          effSpacingY,
        );
      } else if (action.spacing > 0) {
        positions = computeGridPositionsWithSpacing(
          action.origin,
          action.extent,
          action.rows,
          action.cols,
          action.spacing,
        );
      } else {
        positions = computeGridPositions(
          action.origin,
          action.extent,
          action.rows,
          action.cols,
        );
      }
      const { newSeats, nextNum } = buildBatchSeats(
        positions,
        section,
        state.activeSectionId,
        state.currentRow,
        state.nextSeatNumber,
        state.defaultSeatRadius,
      );

      if (newSeats.length === 0) return state;

      const group: PlacementGroup = {
        id: nextGroupId(),
        kind: "grid",
        origin: action.origin,
        extent: action.extent,
        rows: action.rows,
        cols: action.cols,
        spacing: action.spacing,
        spacingX: action.spacingX ?? 0,
        spacingY: action.spacingY ?? 0,
        sectionId: state.activeSectionId,
        row: state.currentRow,
        startNum: state.nextSeatNumber,
        seatIds: newSeats.map((s) => s.id),
      };

      return pushUndoEntry(state, "Grid placement", {
        seats: [...state.seats, ...newSeats],
        nextSeatNumber: 1,
        currentRow: nextRowLabel(state.currentRow),
        placementPreview: null,
        placementGroups: [...state.placementGroups, group],
      });
    }

    // ── Placement group management ───────────────────────────────────────
    case "SELECT_PLACEMENT_GROUP":
      return { ...state, selectedPlacementGroupId: action.groupId };

    case "DELETE_PLACEMENT_GROUP": {
      const group = state.placementGroups.find((g) => g.id === action.groupId);
      if (!group) return state;
      const seatIdSet = new Set(group.seatIds);
      return pushUndoEntry(state, "Delete placement group", {
        seats: state.seats.filter((s) => !seatIdSet.has(s.id)),
        placementGroups: state.placementGroups.filter(
          (g) => g.id !== action.groupId,
        ),
        selectedPlacementGroupId:
          state.selectedPlacementGroupId === action.groupId
            ? null
            : state.selectedPlacementGroupId,
      });
    }

    case "UPDATE_PLACEMENT_GROUP": {
      const groupIdx = state.placementGroups.findIndex(
        (g) => g.id === action.groupId,
      );
      if (groupIdx === -1) return state;
      const group = state.placementGroups[groupIdx]!;

      // Find the section for constraint checking
      const section = state.sections.find(
        (s) => s.sectionId === group.sectionId,
      );
      if (section?.kind !== "seat") return state;

      // Remove old seats
      const oldSeatIdSet = new Set(group.seatIds);
      const remainingSeats = state.seats.filter((s) => !oldSeatIdSet.has(s.id));

      // Determine whether the structural shape changed (count/rows/cols).
      // If only spacing changed, we preserve deletedIndices.
      const updatedCount =
        action.updates.count ?? ("count" in group ? group.count : 0);
      const updatedSpacing =
        action.updates.spacing ?? ("spacing" in group ? group.spacing : 0);
      const prevCount = "count" in group ? group.count : 0;
      const prevRows = group.kind === "grid" ? group.rows : 1;
      const prevCols = group.kind === "grid" ? group.cols : prevCount;
      const updatedRows =
        group.kind === "grid" ? (action.updates.rows ?? group.rows) : 1;
      const updatedCols =
        group.kind === "grid"
          ? (action.updates.cols ?? group.cols)
          : updatedCount;

      const structureChanged =
        updatedCount !== prevCount ||
        updatedRows !== prevRows ||
        updatedCols !== prevCols;

      // Carry forward deletedIndices only when structure didn't change
      const deletedIndices = structureChanged
        ? undefined
        : (group.deletedIndices ?? undefined);

      let positions: Point[];

      if (group.kind === "line") {
        positions =
          updatedSpacing > 0
            ? computeLinePositionsWithSpacing(
                group.start,
                group.end,
                updatedSpacing,
              )
            : computeLinePositions(group.start, group.end, updatedCount);
      } else if (group.kind === "arc") {
        positions =
          updatedSpacing > 0
            ? computeArcPositionsWithSpacing(
                group.center,
                group.radius,
                group.startAngle,
                group.endAngle,
                updatedSpacing,
              )
            : computeArcPositions(
                group.center,
                group.radius,
                group.startAngle,
                group.endAngle,
                updatedCount,
              );
      } else if (group.kind === "stroke") {
        const stroke = state.strokes.find((s) => s.id === group.strokeId);
        if (!stroke) return state;
        positions = computeStrokePositions(stroke.points, updatedCount);
      } else {
        const effSpX = action.updates.spacingX ?? group.spacingX;
        const effSpY = action.updates.spacingY ?? group.spacingY;
        const hasPerAxis = effSpX > 0 || effSpY > 0;
        if (hasPerAxis) {
          positions = computeGridPositionsWithSeparateSpacing(
            group.origin,
            group.extent,
            updatedRows,
            updatedCols,
            effSpX,
            effSpY,
          );
        } else {
          positions =
            updatedSpacing > 0
              ? computeGridPositionsWithSpacing(
                  group.origin,
                  group.extent,
                  updatedRows,
                  updatedCols,
                  updatedSpacing,
                )
              : computeGridPositions(
                  group.origin,
                  group.extent,
                  updatedRows,
                  updatedCols,
                );
        }
      }

      // Apply deleted-index filtering (skip positions that were manually removed)
      const filteredPositions = applyDeletedIndices(positions, deletedIndices);

      // Seat-number bump-up: find seat numbers used by OTHER groups in the
      // same section+row and ensure our range doesn't overlap.
      const otherSeatNums = new Set<number>();
      for (const otherGroup of state.placementGroups) {
        if (otherGroup.id === group.id) continue;
        if (
          otherGroup.sectionId !== group.sectionId ||
          otherGroup.row !== group.row
        )
          continue;
        // Collect seat numbers from the other group's range
        for (let i = 0; i < otherGroup.seatIds.length; i++) {
          otherSeatNums.add(otherGroup.startNum + i);
        }
      }

      let startNum = group.startNum;
      // If expanding and our range would overlap, bump up
      if (otherSeatNums.size > 0) {
        const endNum = startNum + filteredPositions.length - 1;
        for (let n = startNum; n <= endNum; n++) {
          if (otherSeatNums.has(n)) {
            // Find next available contiguous range
            let candidate = n + 1;
            while (otherSeatNums.has(candidate)) candidate++;
            startNum = candidate;
            break;
          }
        }
      }

      const { newSeats, nextNum } = buildBatchSeats(
        filteredPositions,
        section,
        group.sectionId,
        group.row,
        startNum,
        state.defaultSeatRadius,
      );

      const updatedGroup: PlacementGroup = {
        ...group,
        count: updatedCount,
        ...("spacing" in group ? { spacing: updatedSpacing } : {}),
        startNum,
        deletedIndices: deletedIndices,
        ...(group.kind === "grid"
          ? {
              rows: updatedRows,
              cols: updatedCols,
              spacingX: action.updates.spacingX ?? group.spacingX,
              spacingY: action.updates.spacingY ?? group.spacingY,
            }
          : {}),
        seatIds: newSeats.map((s) => s.id),
      } as PlacementGroup;

      const updatedGroups = [...state.placementGroups];
      updatedGroups[groupIdx] = updatedGroup;

      return pushUndoEntry(state, "Update placement group", {
        seats: [...remainingSeats, ...newSeats],
        nextSeatNumber: Math.max(state.nextSeatNumber, nextNum),
        placementGroups: updatedGroups,
      });
    }

    // ── Move placement group (translate center + all seats) ─────────────
    case "MOVE_PLACEMENT_GROUP": {
      const groupIdx = state.placementGroups.findIndex(
        (g) => g.id === action.groupId,
      );
      if (groupIdx === -1) return state;
      const group = state.placementGroups[groupIdx]!;

      // Translate seats
      const seatIdSet = new Set(group.seatIds);
      const movedSeats = state.seats.map((s) =>
        seatIdSet.has(s.id)
          ? {
              ...s,
              position: {
                x: s.position.x + action.dx,
                y: s.position.y + action.dy,
              },
            }
          : s,
      );

      // Translate group geometry
      let updatedGroup: PlacementGroup;
      if (group.kind === "arc") {
        updatedGroup = {
          ...group,
          center: {
            x: group.center.x + action.dx,
            y: group.center.y + action.dy,
          },
        };
      } else if (group.kind === "line") {
        updatedGroup = {
          ...group,
          start: { x: group.start.x + action.dx, y: group.start.y + action.dy },
          end: { x: group.end.x + action.dx, y: group.end.y + action.dy },
        };
      } else if (group.kind === "grid") {
        updatedGroup = {
          ...group,
          origin: {
            x: group.origin.x + action.dx,
            y: group.origin.y + action.dy,
          },
          extent: {
            x: group.extent.x + action.dx,
            y: group.extent.y + action.dy,
          },
        };
      } else {
        // Stroke groups move their seats but have no intrinsic geometry to translate
        // (the stroke itself is a separate entity)
        updatedGroup = { ...group };
      }

      const movedGroups = [...state.placementGroups];
      movedGroups[groupIdx] = updatedGroup;

      return {
        ...state,
        seats: movedSeats,
        placementGroups: movedGroups,
      };
    }

    // ── Update arc group geometry (radius / angles via handle drag) ──────
    case "UPDATE_ARC_GROUP_GEOMETRY": {
      const groupIdx = state.placementGroups.findIndex(
        (g) => g.id === action.groupId,
      );
      if (groupIdx === -1) return state;
      const group = state.placementGroups[groupIdx]!;
      if (group.kind !== "arc") return state;

      const newCenter = action.updates.center ?? group.center;
      const newRadius = action.updates.radius ?? group.radius;

      // If arcDeg or rotationDeg are explicitly provided, derive start/end angles from them.
      // Otherwise fall back to direct startAngle/endAngle updates.
      const newArcDeg = action.updates.arcDeg ?? group.arcDeg;
      const newRotationDeg = action.updates.rotationDeg ?? group.rotationDeg;

      let newStartAngle: number;
      let newEndAngle: number;
      if (
        action.updates.arcDeg !== undefined ||
        action.updates.rotationDeg !== undefined
      ) {
        // Derive angles from the user-facing arc-length + rotation model
        newStartAngle = (newRotationDeg * Math.PI) / 180;
        newEndAngle = ((newRotationDeg + newArcDeg) * Math.PI) / 180;
      } else {
        newStartAngle = action.updates.startAngle ?? group.startAngle;
        newEndAngle = action.updates.endAngle ?? group.endAngle;
      }

      // Find section for constraint checking
      const section = state.sections.find(
        (s) => s.sectionId === group.sectionId,
      );
      if (section?.kind !== "seat") return state;

      // Remove old seats
      const oldSeatIdSet = new Set(group.seatIds);
      const remainingSeats = state.seats.filter((s) => !oldSeatIdSet.has(s.id));

      // Recompute positions with new geometry
      const allPositions =
        group.spacing > 0
          ? computeArcPositionsWithSpacing(
              newCenter,
              newRadius,
              newStartAngle,
              newEndAngle,
              group.spacing,
            )
          : computeArcPositions(
              newCenter,
              newRadius,
              newStartAngle,
              newEndAngle,
              group.count,
            );

      // Preserve manually deleted seats
      const positions = applyDeletedIndices(allPositions, group.deletedIndices);

      const { newSeats, nextNum } = buildBatchSeats(
        positions,
        section,
        group.sectionId,
        group.row,
        group.startNum,
        state.defaultSeatRadius,
      );

      const updatedGroup: ArcPlacementGroup = {
        ...group,
        center: newCenter,
        radius: newRadius,
        startAngle: newStartAngle,
        endAngle: newEndAngle,
        arcDeg: newArcDeg,
        rotationDeg: newRotationDeg,
        seatIds: newSeats.map((s) => s.id),
      };

      const updatedGroups = [...state.placementGroups];
      updatedGroups[groupIdx] = updatedGroup;

      return {
        ...state,
        seats: [...remainingSeats, ...newSeats],
        nextSeatNumber: Math.max(state.nextSeatNumber, nextNum),
        placementGroups: updatedGroups,
      };
    }

    // ── Auto-detection merge ─────────────────────────────────────────────
    case "MERGE_DETECTED": {
      return pushUndoEntry(state, "Merge detected shapes", {
        sections: [...state.sections, ...action.sections],
        seats: [...state.seats, ...action.seats],
      });
    }

    // ── Undo — restore the `before` snapshot from the most recent entry ──
    case "UNDO": {
      if (state.undoStack.length === 0) return state;
      const stack = [...state.undoStack];
      const entry = stack.pop()!;
      // Update the entry's `after` to reflect current state (in case of drag)
      const finalEntry: UndoEntry = { ...entry, after: snapshot(state) };
      return {
        ...restoreSnapshot(state, entry.before),
        undoStack: stack,
        redoStack: [...state.redoStack, finalEntry],
      };
    }

    // ── Redo — restore the `after` snapshot from the most recent redo entry
    case "REDO": {
      if (state.redoStack.length === 0) return state;
      const stack = [...state.redoStack];
      const entry = stack.pop()!;
      return {
        ...restoreSnapshot(state, entry.after),
        undoStack: [...state.undoStack, entry],
        redoStack: stack,
      };
    }

    // ── Box section tool ─────────────────────────────────────────────────
    case "SET_BOX_SECTION_START":
      return { ...state, boxSectionStart: action.point };

    case "COMMIT_BOX_SECTION": {
      if (!state.boxSectionStart) return state;
      const start = state.boxSectionStart;
      const end = action.corner;
      const minX = Math.min(start.x, end.x);
      const minY = Math.min(start.y, end.y);
      const maxX = Math.max(start.x, end.x);
      const maxY = Math.max(start.y, end.y);
      // Require at least 5x5 world units
      if (maxX - minX < 5 || maxY - minY < 5) {
        return { ...state, boxSectionStart: null };
      }
      const kind = state.drawingSectionKind;
      const sectionId = nextSectionId();
      const polygon: Point[] = [
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY },
      ];
      const newSection: DesignerSection = {
        sectionId,
        label: sectionId,
        color: action.color,
        polygon,
        kind,
        capacity: kind === "ga" ? 100 : undefined,
      };
      const partial: Partial<DesignerState> = {
        sections: [...state.sections, newSection],
        boxSectionStart: null,
        activeSectionId: kind !== "helper" ? sectionId : state.activeSectionId,
        activeTool:
          kind === "seat"
            ? "place_seat"
            : kind === "ga"
              ? "select"
              : state.activeTool,
        currentRow: kind === "seat" ? "A" : state.currentRow,
        nextSeatNumber: kind === "seat" ? 1 : state.nextSeatNumber,
      };
      return pushUndoEntry(state, `Create box section ${sectionId}`, partial);
    }

    case "CANCEL_BOX_SECTION":
      return { ...state, boxSectionStart: null };

    // ── Circle section tool ──────────────────────────────────────────────
    case "SET_CIRCLE_SECTION_CENTER":
      return { ...state, circleSectionCenter: action.point };

    case "COMMIT_CIRCLE_SECTION": {
      if (!state.circleSectionCenter) return state;
      const center = state.circleSectionCenter;
      const edge = action.edgePoint;
      const dx = edge.x - center.x;
      const dy = edge.y - center.y;
      const radius = Math.sqrt(dx * dx + dy * dy);
      // Require at least 5 world units radius
      if (radius < 5) {
        return { ...state, circleSectionCenter: null };
      }
      // Approximate circle as a polygon with 32 sides
      const numSides = 32;
      const polygon: Point[] = [];
      for (let i = 0; i < numSides; i++) {
        const angle = (2 * Math.PI * i) / numSides;
        polygon.push({
          x: center.x + radius * Math.cos(angle),
          y: center.y + radius * Math.sin(angle),
        });
      }
      const kind = state.drawingSectionKind;
      const sectionId = nextSectionId();
      const newSection: DesignerSection = {
        sectionId,
        label: sectionId,
        color: action.color,
        polygon,
        kind,
        capacity: kind === "ga" ? 100 : undefined,
      };
      const partial: Partial<DesignerState> = {
        sections: [...state.sections, newSection],
        circleSectionCenter: null,
        activeSectionId: kind !== "helper" ? sectionId : state.activeSectionId,
        activeTool:
          kind === "seat"
            ? "place_seat"
            : kind === "ga"
              ? "select"
              : state.activeTool,
        currentRow: kind === "seat" ? "A" : state.currentRow,
        nextSeatNumber: kind === "seat" ? 1 : state.nextSeatNumber,
      };
      return pushUndoEntry(
        state,
        `Create circle section ${sectionId}`,
        partial,
      );
    }

    case "CANCEL_CIRCLE_SECTION":
      return { ...state, circleSectionCenter: null };

    // ── Stroke tool (click-to-place Bezier) ────────────────────────────
    case "ADD_STROKE_POINT":
      return pushUndoEntry(state, "Add stroke point", {
        drawingStrokePoints: [
          ...state.drawingStrokePoints,
          { position: action.point, handleIn: null, handleOut: null },
        ],
      });

    case "SET_LAST_STROKE_HANDLES": {
      if (state.drawingStrokePoints.length === 0) return state;
      const pts = [...state.drawingStrokePoints];
      const last = pts[pts.length - 1]!;
      // Mirror: handleOut is from action, handleIn is its reflection
      pts[pts.length - 1] = {
        ...last,
        handleOut: { ...action.handleOut },
        handleIn: { x: -action.handleOut.x, y: -action.handleOut.y },
      };
      return { ...state, drawingStrokePoints: pts };
    }

    case "COMMIT_STROKE": {
      if (state.drawingStrokePoints.length < 2) return state;
      // Use the control points directly — they already have handles set
      const stroke: DesignerStroke = {
        id: nextStrokeId(),
        points: state.drawingStrokePoints.map((cp) => ({
          position: { ...cp.position },
          handleIn: cp.handleIn ? { ...cp.handleIn } : null,
          handleOut: cp.handleOut ? { ...cp.handleOut } : null,
        })),
        closed: action.closed ?? false,
        color: state.strokeColor,
        strokeWidth: state.strokeWidth,
      };

      // Auto-place seats along the stroke if there's an active seat section
      const section = state.activeSectionId
        ? state.sections.find((s) => s.sectionId === state.activeSectionId)
        : null;
      if (section?.kind === "seat" && state.batchCount > 0) {
        const positions = computeStrokePositions(
          stroke.points,
          state.batchCount,
        );
        const { newSeats, nextNum } = buildBatchSeats(
          positions,
          section,
          state.activeSectionId!,
          state.currentRow,
          state.nextSeatNumber,
          state.defaultSeatRadius,
        );
        if (newSeats.length > 0) {
          const group: PlacementGroup = {
            id: nextGroupId(),
            kind: "stroke",
            strokeId: stroke.id,
            count: state.batchCount,
            sectionId: state.activeSectionId!,
            row: state.currentRow,
            startNum: state.nextSeatNumber,
            seatIds: newSeats.map((s) => s.id),
          };
          return pushUndoEntry(state, `Create stroke ${stroke.id} with seats`, {
            strokes: [...state.strokes, stroke],
            seats: [...state.seats, ...newSeats],
            drawingStrokePoints: [],
            nextSeatNumber: 1,
            currentRow: nextRowLabel(state.currentRow),
            placementGroups: [...state.placementGroups, group],
          });
        }
      }

      return pushUndoEntry(state, `Create stroke ${stroke.id}`, {
        strokes: [...state.strokes, stroke],
        drawingStrokePoints: [],
      });
    }

    case "CANCEL_STROKE":
      return { ...state, drawingStrokePoints: [] };

    case "SET_STROKE_COLOR":
      return { ...state, strokeColor: action.color };

    case "SET_STROKE_WIDTH":
      return { ...state, strokeWidth: Math.max(0.5, action.width) };

    case "UPDATE_STROKE_HANDLE": {
      const updatedStrokes = state.strokes.map((s) => {
        if (s.id !== action.strokeId) return s;
        return {
          ...s,
          points: s.points.map((cp, idx) => {
            if (idx !== action.pointIndex) return cp;
            return {
              ...cp,
              ...(action.handle === "in"
                ? { handleIn: action.position }
                : { handleOut: action.position }),
            };
          }),
        };
      });

      // Recompute seats for any stroke placement groups linked to this stroke
      const linkedGroupIdx = state.placementGroups.findIndex(
        (g) => g.kind === "stroke" && g.strokeId === action.strokeId,
      );
      const updatedStroke = updatedStrokes.find(
        (s) => s.id === action.strokeId,
      );
      if (linkedGroupIdx >= 0 && updatedStroke) {
        const group = state.placementGroups[linkedGroupIdx]!;
        if (group.kind === "stroke") {
          const section = state.sections.find(
            (s) => s.sectionId === group.sectionId,
          );
          if (section?.kind === "seat") {
            const oldSeatIdSet = new Set(group.seatIds);
            const remainingSeats = state.seats.filter(
              (s) => !oldSeatIdSet.has(s.id),
            );
            const allPositions = computeStrokePositions(
              updatedStroke.points,
              group.count,
            );
            const positions = applyDeletedIndices(
              allPositions,
              group.deletedIndices,
            );
            const { newSeats } = buildBatchSeats(
              positions,
              section,
              group.sectionId,
              group.row,
              group.startNum,
              state.defaultSeatRadius,
            );
            const updatedGroup = {
              ...group,
              seatIds: newSeats.map((s) => s.id),
            };
            const updatedGroups = [...state.placementGroups];
            updatedGroups[linkedGroupIdx] = updatedGroup;
            return pushUndoEntry(state, "Edit stroke handle", {
              strokes: updatedStrokes,
              seats: [...remainingSeats, ...newSeats],
              placementGroups: updatedGroups,
            });
          }
        }
      }

      return pushUndoEntry(state, "Edit stroke handle", {
        strokes: updatedStrokes,
      });
    }

    case "MOVE_STROKE_POINT": {
      const strokeIdx = state.strokes.findIndex(
        (s) => s.id === action.strokeId,
      );
      if (strokeIdx === -1) return state;
      const stroke = state.strokes[strokeIdx]!;
      if (action.pointIndex < 0 || action.pointIndex >= stroke.points.length)
        return state;
      const updatedPoints = stroke.points.map((cp, idx) =>
        idx === action.pointIndex ? { ...cp, position: action.position } : cp,
      );
      const updatedStrokes = state.strokes.map((s, idx) =>
        idx === strokeIdx ? { ...s, points: updatedPoints } : s,
      );

      // Recompute seats for any stroke placement groups linked to this stroke
      const linkedGroupIdx = state.placementGroups.findIndex(
        (g) => g.kind === "stroke" && g.strokeId === action.strokeId,
      );
      if (linkedGroupIdx >= 0) {
        const group = state.placementGroups[linkedGroupIdx]!;
        if (group.kind === "stroke") {
          const section = state.sections.find(
            (s) => s.sectionId === group.sectionId,
          );
          if (section?.kind === "seat") {
            const oldSeatIdSet = new Set(group.seatIds);
            const remainingSeats = state.seats.filter(
              (s) => !oldSeatIdSet.has(s.id),
            );
            const allPositions = computeStrokePositions(
              updatedPoints,
              group.count,
            );
            const positions = applyDeletedIndices(
              allPositions,
              group.deletedIndices,
            );
            const { newSeats } = buildBatchSeats(
              positions,
              section,
              group.sectionId,
              group.row,
              group.startNum,
              state.defaultSeatRadius,
            );
            const updatedGroup = {
              ...group,
              seatIds: newSeats.map((s) => s.id),
            };
            const updatedGroups = [...state.placementGroups];
            updatedGroups[linkedGroupIdx] = updatedGroup;
            return {
              ...state,
              strokes: updatedStrokes,
              seats: [...remainingSeats, ...newSeats],
              placementGroups: updatedGroups,
            };
          }
        }
      }

      return { ...state, strokes: updatedStrokes };
    }

    case "PLACE_SEATS_ALONG_STROKE": {
      const stroke = state.strokes.find((s) => s.id === action.strokeId);
      if (!stroke || action.count <= 0) return state;

      // Must have an active seat section
      if (!state.activeSectionId) return state;
      const section = state.sections.find(
        (s) => s.sectionId === state.activeSectionId,
      );
      if (section?.kind !== "seat") return state;

      // If a stroke placement group already exists for this stroke, update it
      // instead of creating a duplicate.
      const existingGroupIdx = state.placementGroups.findIndex(
        (g) => g.kind === "stroke" && g.strokeId === action.strokeId,
      );
      if (existingGroupIdx >= 0) {
        const existingGroup = state.placementGroups[existingGroupIdx]!;
        if (existingGroup.kind !== "stroke") return state;
        const oldSeatIdSet = new Set(existingGroup.seatIds);
        const remainingSeats = state.seats.filter(
          (s) => !oldSeatIdSet.has(s.id),
        );
        const positions = computeStrokePositions(stroke.points, action.count);
        const { newSeats, nextNum } = buildBatchSeats(
          positions,
          section,
          existingGroup.sectionId,
          existingGroup.row,
          existingGroup.startNum,
          state.defaultSeatRadius,
        );
        const updatedGroup = {
          ...existingGroup,
          count: action.count,
          seatIds: newSeats.map((s) => s.id),
          deletedIndices: undefined,
        };
        const updatedGroups = [...state.placementGroups];
        updatedGroups[existingGroupIdx] = updatedGroup;
        return pushUndoEntry(state, "Update seats along stroke", {
          seats: [...remainingSeats, ...newSeats],
          nextSeatNumber: Math.max(state.nextSeatNumber, nextNum),
          placementGroups: updatedGroups,
        });
      }

      const positions = computeStrokePositions(stroke.points, action.count);
      const { newSeats, nextNum } = buildBatchSeats(
        positions,
        section,
        state.activeSectionId,
        state.currentRow,
        state.nextSeatNumber,
        state.defaultSeatRadius,
      );

      if (newSeats.length === 0) return state;

      const group: PlacementGroup = {
        id: nextGroupId(),
        kind: "stroke",
        strokeId: action.strokeId,
        count: action.count,
        sectionId: state.activeSectionId,
        row: state.currentRow,
        startNum: state.nextSeatNumber,
        seatIds: newSeats.map((s) => s.id),
      };

      return pushUndoEntry(state, "Place seats along stroke", {
        seats: [...state.seats, ...newSeats],
        nextSeatNumber: 1,
        currentRow: nextRowLabel(state.currentRow),
        placementGroups: [...state.placementGroups, group],
      });
    }

    // ── Zoom-based visibility ────────────────────────────────────────────
    case "SET_SEAT_VISIBILITY_THRESHOLD":
      return {
        ...state,
        seatVisibilityThreshold: Math.max(0, action.threshold),
      };

    // ── Section polygon point editing ─────────────────────────────────────
    case "MOVE_SECTION_POINT": {
      const section = state.sections.find(
        (s) => s.sectionId === action.sectionId,
      );
      if (
        !section ||
        action.pointIndex < 0 ||
        action.pointIndex >= section.polygon.length
      )
        return state;
      return {
        ...state,
        sections: state.sections.map((s) => {
          if (s.sectionId !== action.sectionId) return s;
          const polygon = [...s.polygon];
          polygon[action.pointIndex] = action.position;
          return { ...s, polygon };
        }),
      };
    }

    // ── Vertex snapping ──────────────────────────────────────────────────
    case "SET_SNAP_TARGET":
      return { ...state, snapTarget: action.target };

    case "TOGGLE_VERTEX_SNAP":
      return {
        ...state,
        vertexSnapEnabled: !state.vertexSnapEnabled,
        snapTarget: null,
      };

    // ── Line group geometry handles ──────────────────────────────────────
    case "UPDATE_LINE_GROUP_GEOMETRY": {
      const groupIdx = state.placementGroups.findIndex(
        (g) => g.id === action.groupId,
      );
      if (groupIdx === -1) return state;
      const group = state.placementGroups[groupIdx]!;
      if (group.kind !== "line") return state;

      const newStart = action.updates.start ?? group.start;
      const newEnd = action.updates.end ?? group.end;

      const section = state.sections.find(
        (s) => s.sectionId === group.sectionId,
      );
      if (section?.kind !== "seat") return state;

      const oldSeatIdSet = new Set(group.seatIds);
      const remainingSeats = state.seats.filter((s) => !oldSeatIdSet.has(s.id));

      const allPositions =
        group.spacing > 0
          ? computeLinePositionsWithSpacing(newStart, newEnd, group.spacing)
          : computeLinePositions(newStart, newEnd, group.count);

      // Preserve manually deleted seats
      const positions = applyDeletedIndices(allPositions, group.deletedIndices);

      const { newSeats, nextNum } = buildBatchSeats(
        positions,
        section,
        group.sectionId,
        group.row,
        group.startNum,
        state.defaultSeatRadius,
      );

      const updatedGroup = {
        ...group,
        start: newStart,
        end: newEnd,
        seatIds: newSeats.map((s) => s.id),
      };
      const updatedGroups = [...state.placementGroups];
      updatedGroups[groupIdx] = updatedGroup;

      return {
        ...state,
        seats: [...remainingSeats, ...newSeats],
        nextSeatNumber: Math.max(state.nextSeatNumber, nextNum),
        placementGroups: updatedGroups,
      };
    }

    // ── Grid group geometry handles ──────────────────────────────────────
    case "UPDATE_GRID_GROUP_GEOMETRY": {
      const groupIdx = state.placementGroups.findIndex(
        (g) => g.id === action.groupId,
      );
      if (groupIdx === -1) return state;
      const group = state.placementGroups[groupIdx]!;
      if (group.kind !== "grid") return state;

      const newOrigin = action.updates.origin ?? group.origin;
      const newExtent = action.updates.extent ?? group.extent;

      const section = state.sections.find(
        (s) => s.sectionId === group.sectionId,
      );
      if (section?.kind !== "seat") return state;

      const oldSeatIdSet = new Set(group.seatIds);
      const remainingSeats = state.seats.filter((s) => !oldSeatIdSet.has(s.id));

      const allPositions =
        group.spacing > 0
          ? computeGridPositionsWithSpacing(
              newOrigin,
              newExtent,
              group.rows,
              group.cols,
              group.spacing,
            )
          : computeGridPositions(newOrigin, newExtent, group.rows, group.cols);

      // Preserve manually deleted seats
      const positions = applyDeletedIndices(allPositions, group.deletedIndices);

      const { newSeats, nextNum } = buildBatchSeats(
        positions,
        section,
        group.sectionId,
        group.row,
        group.startNum,
        state.defaultSeatRadius,
      );

      const updatedGroup = {
        ...group,
        origin: newOrigin,
        extent: newExtent,
        seatIds: newSeats.map((s) => s.id),
      };
      const updatedGroups = [...state.placementGroups];
      updatedGroups[groupIdx] = updatedGroup;

      return {
        ...state,
        seats: [...remainingSeats, ...newSeats],
        nextSeatNumber: Math.max(state.nextSeatNumber, nextNum),
        placementGroups: updatedGroups,
      };
    }

    // ── Reorder section ──────────────────────────────────────────────────
    case "REORDER_SECTION": {
      const idx = state.sections.findIndex(
        (s) => s.sectionId === action.sectionId,
      );
      if (idx === -1) return state;
      const targetIdx = action.direction === "up" ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= state.sections.length) return state;
      const sections = [...state.sections];
      [sections[idx], sections[targetIdx]] = [
        sections[targetIdx]!,
        sections[idx]!,
      ];
      return { ...state, sections };
    }

    // ── Reorder placement group ──────────────────────────────────────────
    case "REORDER_PLACEMENT_GROUP": {
      const idx = state.placementGroups.findIndex(
        (g) => g.id === action.groupId,
      );
      if (idx === -1) return state;
      const targetIdx = action.direction === "up" ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= state.placementGroups.length)
        return state;
      const groups = [...state.placementGroups];
      [groups[idx], groups[targetIdx]] = [groups[targetIdx]!, groups[idx]!];
      return { ...state, placementGroups: groups };
    }

    default:
      return state;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Test whether a point is inside a polygon (ray-casting). */
export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i]!.x;
    const yi = polygon[i]!.y;
    const xj = polygon[j]!.x;
    const yj = polygon[j]!.y;

    const intersect =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// ── Catmull-Rom spline tessellation ─────────────────────────────────────

/**
 * Evaluate a single Catmull-Rom segment at parameter t ∈ [0, 1].
 * Uses the centripetal parameterisation (alpha = 0.5 baked into the
 * uniform basis matrix with tension = 0) for a balanced look.
 *
 * P0, P1, P2, P3 are four consecutive control points.
 * The curve runs from P1 to P2.
 */
function catmullRomPoint(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  t: number,
): Point {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x:
      0.5 *
      (2 * p1.x +
        (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y:
      0.5 *
      (2 * p1.y +
        (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}

/**
 * Tessellate a polygon into a smooth Catmull-Rom spline.
 *
 * @param polygon  The control points (vertices).
 * @param smoothing  0 = return the original polygon unchanged. 1 = full
 *                   smooth with max subdivisions per edge.
 * @param closed  Whether the polygon is closed (default true — sections
 *                are always closed polygons).
 * @returns  A dense array of points tracing the smooth curve.
 *
 * The function interpolates `segmentsPerEdge` points between each pair
 * of adjacent control vertices using a uniform Catmull-Rom spline. For
 * closed polygons the wrap-around neighbours are used so the curve is
 * seamless at the first/last vertex join.
 */
export function catmullRomTessellate(
  polygon: Point[],
  smoothing: number,
  closed: boolean = true,
): Point[] {
  if (smoothing <= 0 || polygon.length < 3) return polygon;

  const n = polygon.length;
  // 2–16 subdivisions per edge, scaled by smoothing
  const segmentsPerEdge = Math.max(2, Math.round(smoothing * 16));
  const result: Point[] = [];

  const edgeCount = closed ? n : n - 1;
  for (let i = 0; i < edgeCount; i++) {
    // Four control points: p0, p1, p2, p3
    // The spline segment runs from p1 → p2.
    const p0 = polygon[(i - 1 + n) % n]!;
    const p1 = polygon[i]!;
    const p2 = polygon[(i + 1) % n]!;
    const p3 = polygon[(i + 2) % n]!;

    for (let j = 0; j < segmentsPerEdge; j++) {
      const t = j / segmentsPerEdge;
      // Blend between the linear point and the spline point based on smoothing
      const splinePt = catmullRomPoint(p0, p1, p2, p3, t);
      const linearPt: Point = {
        x: p1.x + (p2.x - p1.x) * t,
        y: p1.y + (p2.y - p1.y) * t,
      };
      result.push({
        x: linearPt.x + (splinePt.x - linearPt.x) * smoothing,
        y: linearPt.y + (splinePt.y - linearPt.y) * smoothing,
      });
    }
  }

  return result;
}

/**
 * Tessellate a polygon with per-edge smoothing values.
 *
 * Each edge can have its own smoothing factor (0 = sharp, 1 = fully smooth).
 * Edges not present in the sparse `edgeSmoothing` array default to 0 (sharp).
 */
export function catmullRomTessellatePerEdge(
  polygon: Point[],
  edgeSmoothing: EdgeSmoothingFlag[],
  closed: boolean = true,
): Point[] {
  if (polygon.length < 3) return polygon;
  // Build a lookup: edgeIndex -> smoothing
  const smoothMap = new Map<number, number>();
  for (const flag of edgeSmoothing) {
    smoothMap.set(flag.edgeIndex, flag.smoothing);
  }
  // If every edge is 0 (or map empty), return original polygon
  if (smoothMap.size === 0) return polygon;

  const n = polygon.length;
  const edgeCount = closed ? n : n - 1;
  const result: Point[] = [];

  for (let i = 0; i < edgeCount; i++) {
    const s = smoothMap.get(i) ?? 0;

    const p0 = polygon[(i - 1 + n) % n]!;
    const p1 = polygon[i]!;
    const p2 = polygon[(i + 1) % n]!;
    const p3 = polygon[(i + 2) % n]!;

    if (s <= 0) {
      // Sharp edge: emit just the start vertex
      result.push(p1);
    } else {
      const segmentsPerEdge = Math.max(2, Math.round(s * 16));
      for (let j = 0; j < segmentsPerEdge; j++) {
        const t = j / segmentsPerEdge;
        const splinePt = catmullRomPoint(p0, p1, p2, p3, t);
        const linearPt: Point = {
          x: p1.x + (p2.x - p1.x) * t,
          y: p1.y + (p2.y - p1.y) * t,
        };
        result.push({
          x: linearPt.x + (splinePt.x - linearPt.x) * s,
          y: linearPt.y + (splinePt.y - linearPt.y) * s,
        });
      }
    }
  }

  return result;
}

/**
 * Find matching shared boundary edges across all sections.
 *
 * Two edges are "shared" if both endpoints of one edge are within
 * SNAP_THRESHOLD_WORLD of the (possibly reversed) endpoints of the
 * other edge. Returns all matches for a given section + edge.
 */
export function findSharedBoundaryEdges(
  sections: DesignerSection[],
  sectionId: string,
  edgeIndex: number,
  threshold: number = SNAP_THRESHOLD_WORLD,
): Array<{ sectionId: string; edgeIndex: number }> {
  const source = sections.find((s) => s.sectionId === sectionId);
  if (!source) return [];
  const n = source.polygon.length;
  if (edgeIndex < 0 || edgeIndex >= n) return [];

  const a1 = source.polygon[edgeIndex]!;
  const a2 = source.polygon[(edgeIndex + 1) % n]!;
  const matches: Array<{ sectionId: string; edgeIndex: number }> = [];

  for (const other of sections) {
    if (other.sectionId === sectionId) continue;
    const m = other.polygon.length;
    for (let j = 0; j < m; j++) {
      const b1 = other.polygon[j]!;
      const b2 = other.polygon[(j + 1) % m]!;
      // Check both orientations
      if (
        (distance(a1, b1) <= threshold && distance(a2, b2) <= threshold) ||
        (distance(a1, b2) <= threshold && distance(a2, b1) <= threshold)
      ) {
        matches.push({ sectionId: other.sectionId, edgeIndex: j });
      }
    }
  }

  return matches;
}

/**
 * Apply a smoothing value to a single edge, with automatic shared-boundary
 * propagation. Returns a new sections array.
 */
function applyEdgeSmoothing(
  sections: DesignerSection[],
  sectionId: string,
  edgeIndex: number,
  smoothing: number,
): DesignerSection[] {
  // Collect all edges to update: the target + any shared boundaries
  const edgesToUpdate: Array<{ sectionId: string; edgeIndex: number }> = [
    { sectionId, edgeIndex },
    ...findSharedBoundaryEdges(sections, sectionId, edgeIndex),
  ];

  return sections.map((s) => {
    const updates = edgesToUpdate.filter((e) => e.sectionId === s.sectionId);
    if (updates.length === 0) return s;

    const flags: EdgeSmoothingFlag[] = s.edgeSmoothing
      ? [...s.edgeSmoothing]
      : [];
    for (const upd of updates) {
      const existing = flags.findIndex((f) => f.edgeIndex === upd.edgeIndex);
      if (smoothing > 0) {
        if (existing >= 0) {
          flags[existing] = { edgeIndex: upd.edgeIndex, smoothing };
        } else {
          flags.push({ edgeIndex: upd.edgeIndex, smoothing });
        }
      } else {
        // Remove the entry when smoothing is 0
        if (existing >= 0) flags.splice(existing, 1);
      }
    }

    return {
      ...s,
      edgeSmoothing: flags.length > 0 ? flags : undefined,
    };
  });
}

/**
 * Convenience: return a tessellated polygon for a section, or the raw
 * control polygon when smoothing is absent/zero.
 *
 * Prefers per-edge smoothing (`edgeSmoothing`) when present, falls back to
 * the legacy uniform `smoothing` value.
 */
export function tessellatedPolygon(section: DesignerSection): Point[] {
  // Per-edge smoothing takes priority
  if (section.edgeSmoothing && section.edgeSmoothing.length > 0) {
    return catmullRomTessellatePerEdge(section.polygon, section.edgeSmoothing);
  }
  // Uniform smoothing fallback
  if (!section.smoothing || section.smoothing <= 0) return section.polygon;
  return catmullRomTessellate(section.polygon, section.smoothing);
}

/** Euclidean distance between two points. */
export function distance(a: Point, b: Point): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

/** Find the seat closest to a world-space point within a radius. */
export function findSeatAt(
  seats: DesignerSeat[],
  worldPoint: Point,
  hitRadius: number,
): DesignerSeat | null {
  let closest: DesignerSeat | null = null;
  let closestDist = Infinity;

  for (const seat of seats) {
    const d = distance(seat.position, worldPoint);
    if (d <= hitRadius && d < closestDist) {
      closest = seat;
      closestDist = d;
    }
  }
  return closest;
}

/** Find the section whose polygon contains the world-space point. */
export function findSectionAt(
  sections: DesignerSection[],
  worldPoint: Point,
): DesignerSection | null {
  for (let i = sections.length - 1; i >= 0; i--) {
    if (pointInPolygon(worldPoint, tessellatedPolygon(sections[i]!))) {
      return sections[i]!;
    }
  }
  return null;
}

/** Find the stroke closest to a world-space point within a hit radius. */
export function findStrokeAt(
  strokes: DesignerStroke[],
  worldPoint: Point,
  hitRadius: number,
): DesignerStroke | null {
  for (let i = strokes.length - 1; i >= 0; i--) {
    const stroke = strokes[i]!;
    for (let j = 0; j < stroke.points.length - 1; j++) {
      const a = stroke.points[j]!.position;
      const b = stroke.points[j + 1]!.position;
      if (
        distToSegment(worldPoint, a, b) <=
        hitRadius + stroke.strokeWidth / 2
      ) {
        return stroke;
      }
    }
  }
  return null;
}

/**
 * Default snap radius in world-space pixels.
 * At typical zoom levels this produces a comfortable ~12-14 screen-px snap zone.
 */
export const SNAP_THRESHOLD_WORLD = 12;

/**
 * Find the nearest section-polygon vertex to `worldPoint`, optionally
 * excluding a specific section (e.g. the section currently being drawn /
 * edited). Also skips any vertex belonging to the in-progress polygon itself.
 *
 * Returns `null` when nothing is within `threshold` world-pixels.
 */
export function findNearestVertex(
  sections: DesignerSection[],
  worldPoint: Point,
  excludeSectionId?: string,
  threshold = SNAP_THRESHOLD_WORLD,
): SnapTarget | null {
  let best: SnapTarget | null = null;
  let bestDist = threshold;

  for (const section of sections) {
    if (section.sectionId === excludeSectionId) continue;
    for (let i = 0; i < section.polygon.length; i++) {
      const d = distance(section.polygon[i]!, worldPoint);
      if (d < bestDist) {
        bestDist = d;
        best = {
          point: section.polygon[i]!,
          sectionId: section.sectionId,
          pointIndex: i,
        };
      }
    }
  }
  return best;
}

/** Distance from point to line segment. */
function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return distance(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/**
 * Simplify raw stroke points using the Ramer-Douglas-Peucker algorithm.
 * Reduces noise from freeform drawing while preserving shape.
 */
function simplifyStrokePoints(points: Point[], epsilon = 1.5): Point[] {
  if (points.length <= 2) return [...points];

  // Find the point with maximum distance from the line between first and last
  let maxDist = 0;
  let maxIdx = 0;
  const first = points[0]!;
  const last = points[points.length - 1]!;

  for (let i = 1; i < points.length - 1; i++) {
    const d = distToSegment(points[i]!, first, last);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  if (maxDist > epsilon) {
    const left = simplifyStrokePoints(points.slice(0, maxIdx + 1), epsilon);
    const right = simplifyStrokePoints(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }

  return [first, last];
}

// ── Deleted-index tracking helpers ───────────────────────────────────────

/**
 * Given a placement group (which may have `deletedIndices`), return
 * an array mapping each current seat-list position to its original
 * position index.  For example, if the group originally had 10 seats
 * and index 3 was deleted, `seatIds` now has 9 entries and this
 * returns `[0,1,2,4,5,6,7,8,9]`.
 */
function buildExistingPositionIndices(group: PlacementGroup): number[] {
  const deleted = new Set(group.deletedIndices ?? []);
  if (deleted.size === 0) {
    return group.seatIds.map((_, i) => i);
  }
  // Total original count = current seats + deleted count
  const totalOriginal = group.seatIds.length + deleted.size;
  const indices: number[] = [];
  for (let i = 0; i < totalOriginal; i++) {
    if (!deleted.has(i)) indices.push(i);
  }
  return indices;
}

/**
 * Filter a list of computed positions by removing the indices recorded
 * in `deletedIndices`.  Returns the surviving positions.
 */
function applyDeletedIndices(
  positions: Point[],
  deletedIndices: number[] | undefined,
): Point[] {
  if (!deletedIndices || deletedIndices.length === 0) return positions;
  const deleted = new Set(deletedIndices);
  return positions.filter((_, i) => !deleted.has(i));
}

// ── Batch geometry helpers ───────────────────────────────────────────────────

/**
 * Compute N evenly-spaced points along the line from `start` to `end`.
 * Returns positions in world coordinates.
 */
export function computeLinePositions(
  start: Point,
  end: Point,
  count: number,
): Point[] {
  if (count <= 0) return [];
  if (count === 1)
    return [{ x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }];
  const pts: Point[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    pts.push({
      x: start.x + (end.x - start.x) * t,
      y: start.y + (end.y - start.y) * t,
    });
  }
  return pts;
}

/**
 * Compute N evenly-spaced points along an arc.
 * Angles are in radians, measured counter-clockwise from +x axis.
 */
export function computeArcPositions(
  center: Point,
  radius: number,
  startAngle: number,
  endAngle: number,
  count: number,
): Point[] {
  if (count <= 0 || radius <= 0) return [];
  if (count === 1) {
    const mid = (startAngle + endAngle) / 2;
    return [
      {
        x: center.x + radius * Math.cos(mid),
        y: center.y + radius * Math.sin(mid),
      },
    ];
  }
  const pts: Point[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const angle = startAngle + (endAngle - startAngle) * t;
    pts.push({
      x: center.x + radius * Math.cos(angle),
      y: center.y + radius * Math.sin(angle),
    });
  }
  return pts;
}

/**
 * Compute a grid of positions spanning from `origin` to `extent`.
 * Returns positions row-by-row, left-to-right, top-to-bottom.
 */
export function computeGridPositions(
  origin: Point,
  extent: Point,
  rows: number,
  cols: number,
): Point[] {
  if (rows <= 0 || cols <= 0) return [];
  const pts: Point[] = [];
  for (let r = 0; r < rows; r++) {
    const ty = rows === 1 ? 0.5 : r / (rows - 1);
    const y = origin.y + (extent.y - origin.y) * ty;
    for (let c = 0; c < cols; c++) {
      const tx = cols === 1 ? 0.5 : c / (cols - 1);
      const x = origin.x + (extent.x - origin.x) * tx;
      pts.push({ x, y });
    }
  }
  return pts;
}

/**
 * Build DesignerSeat[] from candidate positions, filtering out any that
 * fall outside the section polygon.
 */
function buildBatchSeats(
  positions: Point[],
  section: DesignerSection,
  sectionId: string,
  row: string,
  startNum: number,
  radius: number,
): { newSeats: DesignerSeat[]; nextNum: number } {
  const newSeats: DesignerSeat[] = [];
  let num = startNum;
  for (const pos of positions) {
    // Respect polygon constraint (use tessellated for smooth sections)
    if (
      section.polygon.length >= 3 &&
      !pointInPolygon(pos, tessellatedPolygon(section))
    ) {
      continue;
    }
    newSeats.push({
      id: generateSeatId(sectionId, row, num),
      sectionId,
      row,
      seat: String(num),
      position: pos,
      radius,
      rotationDeg: 0,
    });
    num++;
  }
  return { newSeats, nextNum: num };
}

// ── Spacing-aware geometry helpers ───────────────────────────────────────

/**
 * Compute points along a line with fixed center-to-center spacing.
 * Seats start at `start` and march toward `end`; the last seat may not
 * reach `end` if the distance isn't an exact multiple of `spacing`.
 */
export function computeLinePositionsWithSpacing(
  start: Point,
  end: Point,
  spacing: number,
): Point[] {
  if (spacing <= 0) return [];
  const d = distance(start, end);
  if (d === 0) return [{ ...start }];
  const count = Math.max(1, Math.floor(d / spacing) + 1);
  const dx = (end.x - start.x) / d;
  const dy = (end.y - start.y) / d;
  const pts: Point[] = [];
  for (let i = 0; i < count; i++) {
    const dist = i * spacing;
    if (dist > d + 1e-9) break;
    pts.push({ x: start.x + dx * dist, y: start.y + dy * dist });
  }
  return pts;
}

/**
 * Compute points along an arc with fixed arc-length spacing between seats.
 */
export function computeArcPositionsWithSpacing(
  center: Point,
  radius: number,
  startAngle: number,
  endAngle: number,
  spacing: number,
): Point[] {
  if (spacing <= 0 || radius <= 0) return [];
  const totalAngle = Math.abs(endAngle - startAngle);
  const arcLength = radius * totalAngle;
  if (arcLength === 0) {
    return [
      {
        x: center.x + radius * Math.cos(startAngle),
        y: center.y + radius * Math.sin(startAngle),
      },
    ];
  }
  const count = Math.max(1, Math.floor(arcLength / spacing) + 1);
  const angularSpacing = spacing / radius;
  const direction = endAngle >= startAngle ? 1 : -1;
  const pts: Point[] = [];
  for (let i = 0; i < count; i++) {
    const angle = startAngle + direction * i * angularSpacing;
    if (Math.abs(angle - startAngle) > totalAngle + 1e-9) break;
    pts.push({
      x: center.x + radius * Math.cos(angle),
      y: center.y + radius * Math.sin(angle),
    });
  }
  return pts;
}

/**
 * Compute a grid of positions with fixed spacing between seats.
 * The grid starts at `origin` and expands toward `extent` with
 * `spacing` between adjacent seats in both directions.
 */
export function computeGridPositionsWithSpacing(
  origin: Point,
  extent: Point,
  rows: number,
  cols: number,
  spacing: number,
): Point[] {
  if (rows <= 0 || cols <= 0 || spacing <= 0) return [];
  const dirX = extent.x >= origin.x ? 1 : -1;
  const dirY = extent.y >= origin.y ? 1 : -1;
  const pts: Point[] = [];
  for (let r = 0; r < rows; r++) {
    const y = origin.y + dirY * r * spacing;
    for (let c = 0; c < cols; c++) {
      const x = origin.x + dirX * c * spacing;
      pts.push({ x, y });
    }
  }
  return pts;
}

/**
 * Compute a grid of positions with separate X and Y spacing.
 * If a spacing axis is 0, positions are evenly distributed between
 * origin and extent on that axis.
 */
export function computeGridPositionsWithSeparateSpacing(
  origin: Point,
  extent: Point,
  rows: number,
  cols: number,
  spacingX: number,
  spacingY: number,
): Point[] {
  if (rows <= 0 || cols <= 0) return [];
  const pts: Point[] = [];
  for (let r = 0; r < rows; r++) {
    let y: number;
    if (spacingY > 0) {
      const dirY = extent.y >= origin.y ? 1 : -1;
      y = origin.y + dirY * r * spacingY;
    } else {
      const ty = rows === 1 ? 0.5 : r / (rows - 1);
      y = origin.y + (extent.y - origin.y) * ty;
    }
    for (let c = 0; c < cols; c++) {
      let x: number;
      if (spacingX > 0) {
        const dirX = extent.x >= origin.x ? 1 : -1;
        x = origin.x + dirX * c * spacingX;
      } else {
        const tx = cols === 1 ? 0.5 : c / (cols - 1);
        x = origin.x + (extent.x - origin.x) * tx;
      }
      pts.push({ x, y });
    }
  }
  return pts;
}

// ── Bezier curve helpers ─────────────────────────────────────────────────

/**
 * Evaluate a cubic Bezier curve at parameter t ∈ [0,1].
 */
function cubicBezier(
  p0: Point,
  c0: Point,
  c1: Point,
  p1: Point,
  t: number,
): Point {
  const u = 1 - t;
  return {
    x:
      u * u * u * p0.x +
      3 * u * u * t * c0.x +
      3 * u * t * t * c1.x +
      t * t * t * p1.x,
    y:
      u * u * u * p0.y +
      3 * u * u * t * c0.y +
      3 * u * t * t * c1.y +
      t * t * t * p1.y,
  };
}

/**
 * Approximate the arc-length of a cubic Bezier segment by subdividing into
 * `steps` linear segments.
 */
function bezierSegmentLength(
  p0: Point,
  c0: Point,
  c1: Point,
  p1: Point,
  steps = 32,
): number {
  let len = 0;
  let prev = p0;
  for (let i = 1; i <= steps; i++) {
    const pt = cubicBezier(p0, c0, c1, p1, i / steps);
    len += distance(prev, pt);
    prev = pt;
  }
  return len;
}

/**
 * Compute evenly-spaced points along a multi-segment Bezier stroke.
 * Returns `count` positions distributed by equal arc-length along the path.
 */
export function computeStrokePositions(
  controlPoints: StrokeControlPoint[],
  count: number,
): Point[] {
  if (controlPoints.length < 2 || count <= 0) return [];
  if (count === 1) return [{ ...controlPoints[0]!.position }];

  // Build cubic Bezier segments
  type Seg = { p0: Point; c0: Point; c1: Point; p1: Point; length: number };
  const segments: Seg[] = [];
  for (let i = 0; i < controlPoints.length - 1; i++) {
    const a = controlPoints[i]!;
    const b = controlPoints[i + 1]!;
    const p0 = a.position;
    const p1 = b.position;
    const c0 = a.handleOut
      ? { x: p0.x + a.handleOut.x, y: p0.y + a.handleOut.y }
      : p0;
    const c1 = b.handleIn
      ? { x: p1.x + b.handleIn.x, y: p1.y + b.handleIn.y }
      : p1;
    const length = bezierSegmentLength(p0, c0, c1, p1);
    segments.push({ p0, c0, c1, p1, length });
  }

  const totalLength = segments.reduce((sum, s) => sum + s.length, 0);
  if (totalLength === 0)
    return Array.from({ length: count }, () => ({
      ...controlPoints[0]!.position,
    }));

  const spacing = totalLength / (count - 1);
  const points: Point[] = [];

  for (let i = 0; i < count; i++) {
    const targetDist = i * spacing;
    let segAccum = 0;
    let placed = false;

    for (let si = 0; si < segments.length; si++) {
      const seg = segments[si]!;
      if (targetDist <= segAccum + seg.length + 1e-9) {
        const localDist = targetDist - segAccum;
        const t = seg.length > 0 ? Math.min(1, localDist / seg.length) : 0;
        points.push(cubicBezier(seg.p0, seg.c0, seg.c1, seg.p1, t));
        placed = true;
        break;
      }
      segAccum += seg.length;
    }

    if (!placed) {
      points.push({ ...controlPoints[controlPoints.length - 1]!.position });
    }
  }

  return points;
}
