export type SeatGlyph = {
  seatId: string;
  sectionId: string;
  label: string;
  position: { x: number; y: number };
  radius?: number;
  width?: number;
  height?: number;
  rotationDeg?: number;
  facingAngleDeg?: number;
  metadata?: Record<string, unknown>;
};

export type SeatSection = {
  sectionId: string;
  label: string;
  /** "seat" = individually-placed seats, "ga" = general admission (capacity only). Helper sections are not materialised. */
  kind?: "seat" | "ga";
  color?: string | null;
  capacity: number;
  metadata?: Record<string, unknown>;
  geometry?: {
    polygons?: Array<Array<{ x: number; y: number }>>;
    origin?: { x: number; y: number };
    rotation?: number;
    scale?: number;
    /** Catmull-Rom smoothing factor (0–1). 0 or absent = sharp edges. */
    smoothing?: number;
  } | null;
  stageAnchor?: {
    point: { x: number; y: number };
    facingAngle?: number;
  } | null;
};

export type StageLayout = {
  kind: "rectangle" | "circle" | "polygon" | "custom";
  label?: string | null;
  bounds: SeatIndexBounds;
  metadata?: Record<string, unknown>;
};

export type SeatIndexBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export type PlaceLayoutDiff = {
  added: number;
  removed: number;
  moved: number;
  sectionsChanged: string[];
};

export type PlaceLayoutSnapshot = {
  id: string;
  name: string;
  placeId: string;
  checksum: string;
  seatCount: number;
  sectionCount: number;
  seatIndexBounds: SeatIndexBounds;
  sections: SeatSection[];
  stage?: StageLayout | null;
  updatedAt: Date;
};

export type PlaceLayoutParserIssue = {
  code: string;
  message: string;
  severity: "warning" | "error";
  details?: Record<string, unknown>;
};

export type PlaceLayoutGeometryParserResult = {
  glyphs: SeatGlyph[];
  sections: SeatSection[];
  stage?: StageLayout | null;
  issues: PlaceLayoutParserIssue[];
  errors?: PlaceLayoutParserIssue[];
};
