// ─────────────────────────────────────────────────────────────────────────────
// Place Layout Designer — shared types
// ─────────────────────────────────────────────────────────────────────────────

export type Point = { x: number; y: number };

/**
 * A snap target represents a vertex on an existing section polygon that
 * the cursor (or dragged point) is close enough to snap to.
 */
export type SnapTarget = {
  /** The exact vertex coordinate to snap to. */
  point: Point;
  /** The section that owns the vertex. */
  sectionId: string;
  /** Index of the vertex within the section's polygon. */
  pointIndex: number;
};

export type DesignerSeat = {
  id: string;
  sectionId: string;
  row: string;
  seat: string;
  position: Point;
  radius: number;
  rotationDeg: number;
  tier?: string;
  notes?: string;
  /** ADA / accessibility seat — rendered with a wheelchair indicator. */
  accessible?: boolean;
};

// ── Stroke (freeform path) ──────────────────────────────────────────────

/** A control point on a stroke path with optional Bezier handles. */
export type StrokeControlPoint = {
  /** The on-curve anchor position. */
  position: Point;
  /** Incoming Bezier control handle (relative to position). null = sharp corner. */
  handleIn: Point | null;
  /** Outgoing Bezier control handle (relative to position). null = sharp corner. */
  handleOut: Point | null;
};

/** A freeform path drawn with the stroke tool. */
export type DesignerStroke = {
  id: string;
  /** Ordered control points defining the path. */
  points: StrokeControlPoint[];
  /** Whether the path is closed (loops back to first point). */
  closed: boolean;
  /** Stroke color (hex). */
  color: string;
  /** Stroke width in world units. */
  strokeWidth: number;
};

/**
 * Section kind:
 * - "seat"   — holds seats; seats are constrained to its polygon.
 *              Capacity is auto-computed from the number of placed seats.
 * - "ga"     — general admission / standing zone. Has a user-defined capacity
 *              but no individual seats. Capacity acts as the upper bound on
 *              tickets sold for this section.
 * - "helper" — decorative / stage / annotation shape. No seats, no capacity.
 */
export type SectionKind = "seat" | "ga" | "helper";

/** Per-edge smoothing flag for selective Catmull-Rom tessellation. */
export type EdgeSmoothingFlag = {
  /** Edge index (0-based). Edge i connects polygon[i] to polygon[(i+1) % n]. */
  edgeIndex: number;
  /** Smoothing factor for this edge. 0 = sharp, 1 = full Catmull-Rom. */
  smoothing: number;
};

export type DesignerSection = {
  sectionId: string;
  label: string;
  color: string;
  polygon: Point[];
  kind: SectionKind;
  /**
   * Section capacity.
   * - "seat" sections: auto-computed (number of placed seats). Not editable.
   * - "ga" sections: user-defined upper bound. Editable in toolbar.
   * - "helper" sections: always undefined (no capacity concept).
   */
  capacity?: number;
  /** Freeform key-value metadata for seat-picker UIs (e.g. accessible, entryGate, description). */
  metadata?: Record<string, string>;
  /**
   * Catmull-Rom spline smoothing factor (0–1).
   * 0 = sharp/legacy (straight edges between vertices).
   * 1 = fully smooth curves through all control points.
   * When > 0, the polygon is tessellated at render/hit-test time.
   * @deprecated Use edgeSmoothing for per-edge control. Kept for migration compat.
   */
  smoothing?: number;
  /**
   * Per-edge smoothing flags. Sparse array: only edges with smoothing > 0
   * are listed. When present, takes precedence over `smoothing`.
   */
  edgeSmoothing?: EdgeSmoothingFlag[];
};

/**
 * @deprecated Stages are now represented as helper sections with polygonal
 * shapes. Kept only for backward CSV compatibility during import.
 */
export type DesignerStage = {
  kind: "rectangle";
  label: string;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
};

/** Background image loaded into the canvas (included in layout export). */
export type DesignerImage = {
  /** Object URL or data URL of the loaded image. */
  src: string;
  /**
   * Base64 data URL for serialization into the CSV export.
   * Set once on import; the src field may be an object URL for rendering.
   */
  dataUrl: string;
  /** World-space position of the image's top-left corner. */
  position: Point;
  /** Display width in world units. */
  width: number;
  /** Display height in world units. */
  height: number;
  /** Opacity 0–1. */
  opacity: number;
};

export type DesignerTool =
  | "select"
  | "pan"
  | "draw_section"
  | "draw_box_section"
  | "draw_circle_section"
  | "place_seat"
  | "place_line"
  | "place_arc"
  | "place_grid"
  | "draw_stroke"
  | "erase";

// ── Batch placement preview state ────────────────────────────────────────

/**
 * Live preview for line / arc / grid placement tools.
 * Stored in DesignerState so the draw loop can render ghost seats.
 */
export type LinePlacementPreview = {
  kind: "line";
  /** World-space start point (first click). */
  start: Point;
  /** World-space end point (current pointer or second click). */
  end: Point;
  /** Number of seats to place along the line. */
  count: number;
};

export type ArcPlacementPreview = {
  kind: "arc";
  /** Center of the arc circle. */
  center: Point;
  /** Radius of the arc. */
  radius: number;
  /** Start angle in radians. */
  startAngle: number;
  /** End angle in radians. */
  endAngle: number;
  /** Number of seats to distribute. */
  count: number;
};

export type GridPlacementPreview = {
  kind: "grid";
  /** World-space origin (top-left). */
  origin: Point;
  /** World-space extent (bottom-right). */
  extent: Point;
  /** Number of rows. */
  rows: number;
  /** Number of columns. */
  cols: number;
};

export type PlacementPreview =
  | LinePlacementPreview
  | ArcPlacementPreview
  | GridPlacementPreview
  | null;

export type DesignerState = {
  sections: DesignerSection[];
  seats: DesignerSeat[];
  /** Freeform stroke paths. */
  strokes: DesignerStroke[];
  /** @deprecated Use helper sections instead. Kept for CSV compat. */
  stage: DesignerStage | null;
  /** Background reference image. */
  image: DesignerImage | null;
  activeTool: DesignerTool;
  /** The section currently being drawn (polygon in progress). */
  drawingPolygon: Point[];
  /** The kind of section being drawn. */
  drawingSectionKind: SectionKind;
  /** Section ID whose seats are being placed / edited. */
  activeSectionId: string | null;
  /** Selected seat IDs for bulk operations. */
  selectedSeatIds: Set<string>;
  /** Selected section IDs. */
  selectedSectionIds: Set<string>;
  /** Selected stroke IDs. */
  selectedStrokeIds: Set<string>;
  /** Whether the background image is selected (for moving). */
  imageSelected: boolean;
  /** Default radius for newly placed seats. */
  defaultSeatRadius: number;
  /** Default row label for the next batch of seats. */
  currentRow: string;
  /** Running seat counter within the current row (auto-increments). */
  nextSeatNumber: number;
  /** User-assigned layout name (for saving). */
  layoutName: string;
  /** Action-based undo stack — most recent last. */
  undoStack: UndoEntry[];
  /** Action-based redo stack — most recent last. */
  redoStack: UndoEntry[];
  /** Maximum undo depth. */
  maxUndoDepth: number;

  // ── Batch placement config ────────────────────────────────────────────
  /** Line / arc / grid: number of seats per placement operation. */
  batchCount: number;
  /** Grid: number of rows to generate. */
  batchGridRows: number;
  /** Center-to-center spacing between seats (world units). 0 = auto (evenly distributed). */
  batchSpacing: number;
  /** Grid-specific X (column) spacing. When > 0, overrides batchSpacing for columns. */
  batchSpacingX: number;
  /** Grid-specific Y (row) spacing. When > 0, overrides batchSpacing for rows. */
  batchSpacingY: number;
  /** Live preview for the current batch placement (rendered as ghost seats). */
  placementPreview: PlacementPreview;
  /** Committed placement groups — remembers batch geometry for re-editing. */
  placementGroups: PlacementGroup[];
  /** Currently selected placement group ID (for re-editing in toolbar). */
  selectedPlacementGroupId: string | null;

  // ── Box section drawing state ─────────────────────────────────────────
  /** First corner of the box section being drawn (null when not drawing). */
  boxSectionStart: Point | null;

  // ── Circle section drawing state ──────────────────────────────────────
  /** Center point of the circle section being drawn (null when not drawing). */
  circleSectionCenter: Point | null;

  // ── Stroke drawing state ──────────────────────────────────────────────
  /** Control points accumulated during click-to-place Bezier stroke drawing. */
  drawingStrokePoints: StrokeControlPoint[];
  /** Stroke color for new strokes. */
  strokeColor: string;
  /** Stroke width for new strokes. */
  strokeWidth: number;

  // ── Vertex snapping ─────────────────────────────────────────────────────
  /**
   * When true, new polygon vertices and dragged section points snap to
   * nearby vertices of existing sections. Default: true.
   */
  vertexSnapEnabled: boolean;
  /**
   * Live snap target while drawing or dragging a section point.
   * Set on pointer-move, consumed by the draw loop to show a snap indicator,
   * and used by click/drag handlers to substitute the snapped coordinate.
   */
  snapTarget: SnapTarget | null;

  // ── Zoom-based visibility ─────────────────────────────────────────────
  /** Scale threshold below which individual seats are hidden (rendered as section fill only). */
  seatVisibilityThreshold: number;

  // ── Edge selection ────────────────────────────────────────────────────
  /** Currently selected polygon edge for per-edge smoothing controls. */
  selectedEdge: { sectionId: string; edgeIndex: number } | null;
};

/**
 * Action-based undo entry.
 * Each entry stores the forward delta and its inverse so undo/redo can apply
 * targeted patches instead of restoring full snapshots.
 *
 * `label` is a human-readable description for debugging / UI.
 * `doPatches` apply the action forward (redo); `undoPatches` reverse it.
 *
 * We use a simple "snapshot-patch" hybrid:  each entry stores a before/after
 * snapshot of only the fields it touches, which keeps the implementation
 * straightforward while avoiding full-state cloning.
 */
export type UndoEntry = {
  label: string;
  /** State slice *before* the mutation — restore this to undo. */
  before: UndoSnapshot;
  /** State slice *after* the mutation — restore this to redo. */
  after: UndoSnapshot;
};

/**
 * Lightweight snapshot for undo — captures only the parts of state that
 * represent the layout data (not UI state like active tool, selection, etc.).
 */
export type UndoSnapshot = {
  sections: DesignerSection[];
  seats: DesignerSeat[];
  strokes: DesignerStroke[];
  stage: DesignerStage | null;
  image: DesignerImage | null;
  placementGroups: PlacementGroup[];
  /** In-progress polygon points (for undoing individual vertex additions). */
  drawingPolygon?: Point[];
  /** In-progress stroke control points (for undoing individual point additions). */
  drawingStrokePoints?: StrokeControlPoint[];
};

// ── Placement groups ─────────────────────────────────────────────────────

/**
 * Remembers the parameters used to create a batch placement so
 * it can be re-selected and adjusted in the toolbar after committing.
 */
export type PlacementGroup =
  | LinePlacementGroup
  | ArcPlacementGroup
  | GridPlacementGroup
  | StrokePlacementGroup;

export type LinePlacementGroup = {
  id: string;
  kind: "line";
  start: Point;
  end: Point;
  count: number;
  spacing: number;
  sectionId: string;
  row: string;
  startNum: number;
  seatIds: string[];
  /** Position indices that were manually deleted (preserved across spacing changes). */
  deletedIndices?: number[];
};

export type ArcPlacementGroup = {
  id: string;
  kind: "arc";
  center: Point;
  radius: number;
  startAngle: number;
  endAngle: number;
  /** Arc sweep in degrees (0-360). Derived from |endAngle - startAngle|. */
  arcDeg: number;
  /** Rotation offset in degrees — rotates the entire arc about its center. */
  rotationDeg: number;
  count: number;
  spacing: number;
  sectionId: string;
  row: string;
  startNum: number;
  seatIds: string[];
  /** Position indices that were manually deleted (preserved across spacing changes). */
  deletedIndices?: number[];
};

export type GridPlacementGroup = {
  id: string;
  kind: "grid";
  origin: Point;
  extent: Point;
  rows: number;
  cols: number;
  spacing: number;
  /** Per-axis spacing — 0 means use `spacing` for both axes. */
  spacingX: number;
  spacingY: number;
  sectionId: string;
  row: string;
  startNum: number;
  seatIds: string[];
  /** Position indices that were manually deleted (preserved across spacing changes). */
  deletedIndices?: number[];
};

export type StrokePlacementGroup = {
  id: string;
  kind: "stroke";
  /** The stroke this group's seats are distributed along. */
  strokeId: string;
  count: number;
  sectionId: string;
  row: string;
  startNum: number;
  seatIds: string[];
  /** Position indices that were manually deleted (preserved across count changes). */
  deletedIndices?: number[];
};

export type DesignerAction =
  | { type: "SET_TOOL"; tool: DesignerTool }
  | { type: "SET_ACTIVE_SECTION"; sectionId: string | null }
  | { type: "ADD_POLYGON_POINT"; point: Point }
  | { type: "CLOSE_POLYGON"; color: string; sectionKind?: SectionKind }
  | { type: "CANCEL_DRAWING" }
  | { type: "SET_DRAWING_SECTION_KIND"; sectionKind: SectionKind }
  | { type: "PLACE_SEAT"; position: Point }
  | { type: "PLACE_STAGE"; bounds: DesignerStage["bounds"]; label: string }
  | { type: "SET_STAGE_DRAW_START"; point: Point }
  | { type: "REMOVE_STAGE" }
  | { type: "SELECT_SEAT"; seatId: string; additive: boolean }
  | { type: "SELECT_SECTION"; sectionId: string; additive: boolean }
  | { type: "SELECT_STROKE"; strokeId: string; additive: boolean }
  | { type: "SELECT_IMAGE" }
  | { type: "CLEAR_SELECTION" }
  | { type: "DELETE_SELECTED" }
  | { type: "DELETE_SECTION"; sectionId: string }
  | { type: "DELETE_STROKE"; strokeId: string }
  | { type: "UPDATE_SECTION_COLOR"; sectionId: string; color: string }
  | { type: "UPDATE_SECTION_LABEL"; sectionId: string; label: string }
  | { type: "SET_SECTION_CAPACITY"; sectionId: string; capacity: number }
  | {
      type: "SET_SECTION_METADATA";
      sectionId: string;
      key: string;
      value: string;
    }
  | { type: "DELETE_SECTION_METADATA"; sectionId: string; key: string }
  | { type: "SET_SECTION_SMOOTHING"; sectionId: string; smoothing: number }
  // ── Per-edge smoothing ──────────────────────────────────────────────
  | { type: "SELECT_EDGE"; sectionId: string; edgeIndex: number }
  | { type: "CLEAR_EDGE_SELECTION" }
  | {
      type: "SET_EDGE_SMOOTHING";
      sectionId: string;
      edgeIndex: number;
      smoothing: number;
    }
  | { type: "SET_EDGE_SMOOTHING_BATCH"; sectionId: string; smoothing: number }
  | { type: "SET_CURRENT_ROW"; row: string }
  | { type: "SET_NEXT_SEAT_NUMBER"; num: number }
  | { type: "SET_DEFAULT_SEAT_RADIUS"; radius: number }
  | { type: "TOGGLE_SEAT_ACCESSIBLE"; seatIds: string[] }
  | { type: "MOVE_SELECTED_SEATS"; dx: number; dy: number }
  | { type: "MOVE_SELECTED_SECTIONS"; dx: number; dy: number }
  | { type: "MOVE_SELECTED_STROKES"; dx: number; dy: number }
  | { type: "MOVE_IMAGE"; dx: number; dy: number }
  | { type: "BEGIN_DRAG" }
  | { type: "END_DRAG" }
  | { type: "SET_IMAGE"; image: DesignerImage }
  | { type: "REMOVE_IMAGE" }
  | { type: "SET_IMAGE_OPACITY"; opacity: number }
  | { type: "SET_LAYOUT_NAME"; name: string }
  | {
      type: "LOAD_STATE";
      sections: DesignerSection[];
      seats: DesignerSeat[];
      stage: DesignerStage | null;
      strokes?: DesignerStroke[];
    }
  | { type: "CLEAR_ALL" }
  | { type: "UNDO" }
  | { type: "REDO" }
  // ── Batch placement ─────────────────────────────────────────────────
  | { type: "SET_BATCH_COUNT"; count: number }
  | { type: "SET_BATCH_GRID_ROWS"; rows: number }
  | { type: "SET_BATCH_SPACING"; spacing: number }
  | { type: "SET_BATCH_SPACING_X"; spacing: number }
  | { type: "SET_BATCH_SPACING_Y"; spacing: number }
  | { type: "SET_PLACEMENT_PREVIEW"; preview: PlacementPreview }
  | {
      type: "COMMIT_LINE_PLACEMENT";
      start: Point;
      end: Point;
      count: number;
      spacing: number;
    }
  | {
      type: "COMMIT_ARC_PLACEMENT";
      center: Point;
      radius: number;
      startAngle: number;
      endAngle: number;
      count: number;
      spacing: number;
    }
  | {
      type: "COMMIT_GRID_PLACEMENT";
      origin: Point;
      extent: Point;
      rows: number;
      cols: number;
      spacing: number;
      spacingX?: number;
      spacingY?: number;
    }
  // ── Placement groups ────────────────────────────────────────────────
  | { type: "SELECT_PLACEMENT_GROUP"; groupId: string | null }
  | { type: "DELETE_PLACEMENT_GROUP"; groupId: string }
  | {
      type: "UPDATE_PLACEMENT_GROUP";
      groupId: string;
      updates: Partial<{
        count: number;
        spacing: number;
        spacingX: number;
        spacingY: number;
        rows: number;
        cols: number;
      }>;
    }
  | { type: "MOVE_PLACEMENT_GROUP"; groupId: string; dx: number; dy: number }
  | {
      type: "UPDATE_ARC_GROUP_GEOMETRY";
      groupId: string;
      updates: Partial<{
        center: Point;
        radius: number;
        startAngle: number;
        endAngle: number;
        arcDeg: number;
        rotationDeg: number;
      }>;
    }
  // ── Auto-detection ──────────────────────────────────────────────────
  | {
      type: "MERGE_DETECTED";
      sections: DesignerSection[];
      seats: DesignerSeat[];
    }
  // ── Box section ─────────────────────────────────────────────────────
  | { type: "SET_BOX_SECTION_START"; point: Point }
  | { type: "COMMIT_BOX_SECTION"; corner: Point; color: string }
  | { type: "CANCEL_BOX_SECTION" }
  // ── Circle section ──────────────────────────────────────────────────
  | { type: "SET_CIRCLE_SECTION_CENTER"; point: Point }
  | { type: "COMMIT_CIRCLE_SECTION"; edgePoint: Point; color: string }
  | { type: "CANCEL_CIRCLE_SECTION" }
  // ── Stroke tool (click-to-place Bezier) ──────────────────────────────
  | { type: "ADD_STROKE_POINT"; point: Point }
  | { type: "SET_LAST_STROKE_HANDLES"; handleOut: Point }
  | { type: "COMMIT_STROKE"; closed?: boolean }
  | { type: "CANCEL_STROKE" }
  | { type: "SET_STROKE_COLOR"; color: string }
  | { type: "SET_STROKE_WIDTH"; width: number }
  | {
      type: "UPDATE_STROKE_HANDLE";
      strokeId: string;
      pointIndex: number;
      handle: "in" | "out";
      position: Point | null;
    }
  | {
      type: "MOVE_STROKE_POINT";
      strokeId: string;
      pointIndex: number;
      position: Point;
    }
  | { type: "PLACE_SEATS_ALONG_STROKE"; strokeId: string; count: number }
  // ── Zoom-based visibility ───────────────────────────────────────────
  | { type: "SET_SEAT_VISIBILITY_THRESHOLD"; threshold: number }
  // ── Section polygon editing ────────────────────────────────────────
  | {
      type: "MOVE_SECTION_POINT";
      sectionId: string;
      pointIndex: number;
      position: Point;
    }
  // ── Vertex snapping ─────────────────────────────────────────────────
  | { type: "SET_SNAP_TARGET"; target: SnapTarget | null }
  | { type: "TOGGLE_VERTEX_SNAP" }
  // ── Line / Grid group geometry handles ─────────────────────────────
  | {
      type: "UPDATE_LINE_GROUP_GEOMETRY";
      groupId: string;
      updates: Partial<{ start: Point; end: Point }>;
    }
  | {
      type: "UPDATE_GRID_GROUP_GEOMETRY";
      groupId: string;
      updates: Partial<{ origin: Point; extent: Point }>;
    }
  // ── Reordering ──────────────────────────────────────────────────────
  | { type: "REORDER_SECTION"; sectionId: string; direction: "up" | "down" }
  | {
      type: "REORDER_PLACEMENT_GROUP";
      groupId: string;
      direction: "up" | "down";
    };

// ── Viewport ────────────────────────────────────────────────────────────────

export type Viewport = {
  offsetX: number;
  offsetY: number;
  scale: number;
};
