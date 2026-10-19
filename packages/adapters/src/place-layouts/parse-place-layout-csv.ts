/**
 * Pure CSV → PlaceLayoutGeometryParserResult parser.
 *
 * Accepts raw RFC 4180 CSV text and returns glyphs, sections, stage info,
 * and any validation issues. Uses PapaParse for compliant parsing.
 *
 * ## CSV Format
 *
 * ### Seat rows (required)
 * ```
 * section,row,seat,x,y,rotation,width,height,tier,notes,accessible
 * Floor,A,1,10.5,20.3,0,,,general,,true
 * Floor,A,2,15.5,20.3,0,,,general,,
 * ```
 *
 * ### Section polygon rows (optional, prefixed with `#section`)
 * ```
 * #section,Floor,#4A90D2,polygon,"0 0,100 0,100 50,0 50"
 * ```
 * Fields: marker, sectionId, color (hex), geometry-type, coordinates
 *
 * ### Stage rows (optional, prefixed with `#stage`)
 * ```
 * #stage,rectangle,Main Stage,0,0,200,40
 * ```
 * Fields: marker, kind, label, minX, minY, maxX, maxY
 *
 * The header row is auto-detected via PapaParse. Unknown columns are
 * preserved in `metadata` on the glyph.
 */
import Papa from "papaparse";

import type {
  PlaceLayoutGeometryParserResult,
  PlaceLayoutParserIssue,
  SeatGlyph,
  SeatSection,
  StageLayout,
} from "@th/ports/place-layouts";

// ── Expected column names ────────────────────────────────────────────────

const REQUIRED_COLUMNS = ["section", "row", "seat", "x", "y"] as const;
const OPTIONAL_COLUMNS = [
  "rotation",
  "width",
  "height",
  "tier",
  "notes",
  "accessible",
] as const;
const KNOWN_COLUMNS = new Set<string>([
  ...REQUIRED_COLUMNS,
  ...OPTIONAL_COLUMNS,
]);

const SECTION_MARKER = "#section";
const STAGE_MARKER = "#stage";

// ── Public API ───────────────────────────────────────────────────────────

export type ParsePlaceLayoutCsvOptions = {
  /** Maximum number of seat rows before the parser bails. Default 50_000. */
  maxSeats?: number;
  /** Maximum number of distinct sections. Default 200. */
  maxSections?: number;
  /** Maximum polygon vertices per section (across all polygons). Default 100. */
  maxVerticesPerSection?: number;
  /** Maximum total polygon vertices across all sections. Default 2_000. */
  maxTotalVertices?: number;
  /** Default seat radius when not specified in the CSV. Default 4. */
  defaultSeatRadius?: number;
};

/**
 * Parse raw CSV text into a place layout geometry result.
 *
 * This is a **pure function** with no I/O — suitable for both server-side
 * import adapters and client-side preview before upload.
 */
export function parsePlaceLayoutCsv(
  csvText: string,
  options?: ParsePlaceLayoutCsvOptions,
): PlaceLayoutGeometryParserResult {
  const maxSeats = options?.maxSeats ?? 50_000;
  const maxSections = options?.maxSections ?? 200;
  const maxVerticesPerSection = options?.maxVerticesPerSection ?? 100;
  const maxTotalVertices = options?.maxTotalVertices ?? 2_000;
  const defaultSeatRadius = options?.defaultSeatRadius ?? 4;

  const issues: PlaceLayoutParserIssue[] = [];
  const glyphs: SeatGlyph[] = [];
  const sectionMap = new Map<
    string,
    {
      label: string;
      color: string | null;
      seatCount: number;
      kind?: "seat" | "ga" | "helper";
      capacity?: number;
      metadata?: Record<string, unknown>;
      smoothing?: number;
      polygons: Array<Array<{ x: number; y: number }>>;
    }
  >();
  let stage: StageLayout | null = null;
  let totalVertexCount = 0;

  if (!csvText.trim()) {
    return {
      glyphs: [],
      sections: [],
      issues: [
        {
          code: "empty_input",
          message: "CSV input is empty",
          severity: "error",
        },
      ],
    };
  }

  // ── Split directive lines from seat data ─────────────────────────────

  const { directiveLines, seatCsv } = splitDirectives(csvText);

  // ── Parse directive lines (sections, stage) ──────────────────────────

  let sectionLimitReached = false;

  for (const { lineNumber, raw } of directiveLines) {
    const directiveResult = Papa.parse<string[]>(raw, {
      header: false,
      skipEmptyLines: true,
    });
    const row = directiveResult.data[0];
    if (!row || row.length === 0) continue;

    const marker = row[0]!.trim().toLowerCase();

    if (marker === SECTION_MARKER) {
      // Reject new sections once the cap is reached (still allow extra
      // polygons on existing sections — the vertex cap handles that).
      const sectionId = row[1]?.trim();
      if (
        sectionId &&
        !sectionMap.has(sectionId) &&
        sectionMap.size >= maxSections
      ) {
        if (!sectionLimitReached) {
          sectionLimitReached = true;
          issues.push({
            code: "max_sections_exceeded",
            message: `Stopped adding sections at ${maxSections} (limit reached)`,
            severity: "error",
            details: { maxSections, lineNumber },
          });
        }
        continue;
      }
      parseSectionDirective(row, lineNumber, sectionMap, issues, {
        maxVerticesPerSection,
        maxTotalVertices,
        totalVertexCount,
      });
      // Recount total vertices
      totalVertexCount = countTotalVertices(sectionMap);
    } else if (marker === STAGE_MARKER) {
      const parsed = parseStageDirective(row, lineNumber, issues);
      if (parsed) stage = parsed;
    } else {
      issues.push({
        code: "unknown_directive",
        message: `Unknown directive "${marker}" at line ${lineNumber}`,
        severity: "warning",
        details: { lineNumber, marker },
      });
    }
  }

  // ── Parse seat rows ──────────────────────────────────────────────────

  if (!seatCsv.trim()) {
    return {
      glyphs: [],
      sections: buildSections(sectionMap),
      stage,
      issues: [
        ...issues,
        {
          code: "no_seat_data",
          message: "CSV contains no seat data rows",
          severity: "error",
        },
      ],
    };
  }

  const seatResult = Papa.parse<Record<string, string>>(seatCsv, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase(),
  });

  // Surface PapaParse errors
  for (const err of seatResult.errors) {
    issues.push({
      code: `csv_${err.type.toLowerCase()}`,
      message: err.message,
      severity: err.type === "FieldMismatch" ? "warning" : "error",
      details: { row: err.row, type: err.type, code: err.code },
    });
  }

  // Validate required columns exist
  const fields = new Set(seatResult.meta.fields ?? []);
  const missingColumns: string[] = [];
  for (const col of REQUIRED_COLUMNS) {
    if (!fields.has(col)) missingColumns.push(col);
  }

  if (missingColumns.length > 0) {
    return {
      glyphs: [],
      sections: buildSections(sectionMap),
      stage,
      issues: [
        ...issues,
        {
          code: "missing_columns",
          message: `Required columns missing: ${missingColumns.join(", ")}`,
          severity: "error",
          details: { missingColumns },
        },
      ],
    };
  }

  // Warn about unknown columns
  const unknownColumns: string[] = [];
  for (const f of fields) {
    if (!KNOWN_COLUMNS.has(f)) unknownColumns.push(f);
  }
  if (unknownColumns.length > 0) {
    issues.push({
      code: "unknown_columns",
      message: `Unknown columns will be stored in metadata: ${unknownColumns.join(", ")}`,
      severity: "warning",
      details: { unknownColumns },
    });
  }

  // ── Process seat rows ────────────────────────────────────────────────

  const seenSeatIds = new Set<string>();

  for (let i = 0; i < seatResult.data.length; i++) {
    if (glyphs.length >= maxSeats) {
      issues.push({
        code: "max_seats_exceeded",
        message: `Stopped parsing at ${maxSeats} seats (limit reached)`,
        severity: "error",
        details: { maxSeats, rowIndex: i },
      });
      break;
    }

    const row = seatResult.data[i]!;
    const csvRowNumber = i + 2; // +1 for 0-index, +1 for header

    const section = row.section?.trim();
    const rowLabel = row.row?.trim();
    const seat = row.seat?.trim();
    const xRaw = row.x?.trim();
    const yRaw = row.y?.trim();

    // Validate required fields are present
    if (!section || !rowLabel || !seat) {
      issues.push({
        code: "missing_required_field",
        message: `Row ${csvRowNumber}: missing section, row, or seat value`,
        severity: "error",
        details: { csvRowNumber, section, row: rowLabel, seat },
      });
      continue;
    }

    const x = parseFloat(xRaw ?? "");
    const y = parseFloat(yRaw ?? "");

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      issues.push({
        code: "invalid_coordinates",
        message: `Row ${csvRowNumber}: invalid coordinates (x=${xRaw}, y=${yRaw})`,
        severity: "error",
        details: { csvRowNumber, x: xRaw, y: yRaw },
      });
      continue;
    }

    // Build seat ID: section-row-seat (deterministic, unique within layout)
    const seatId = `${section}-${rowLabel}-${seat}`;

    if (seenSeatIds.has(seatId)) {
      issues.push({
        code: "duplicate_seat_id",
        message: `Row ${csvRowNumber}: duplicate seat "${seatId}"`,
        severity: "error",
        details: { csvRowNumber, seatId },
      });
      continue;
    }
    seenSeatIds.add(seatId);

    // Parse optional numeric fields
    const rotation = safeParseFloat(row.rotation);
    const width = safeParseFloat(row.width);
    const height = safeParseFloat(row.height);

    // Collect unknown columns as metadata
    const metadata: Record<string, unknown> = {};
    if (row.tier?.trim()) metadata.tier = row.tier.trim();
    if (row.notes?.trim()) metadata.notes = row.notes.trim();
    if (row.accessible?.trim().toLowerCase() === "true")
      metadata.accessible = true;
    for (const col of unknownColumns) {
      const val = row[col]?.trim();
      if (val) metadata[col] = val;
    }

    const glyph: SeatGlyph = {
      seatId,
      sectionId: section,
      label: `${rowLabel}${seat}`,
      position: { x, y },
      ...(rotation != null ? { rotationDeg: rotation } : {}),
      ...(width != null ? { width } : {}),
      ...(height != null ? { height } : {}),
      ...(width == null && height == null ? { radius: defaultSeatRadius } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    };

    glyphs.push(glyph);

    // Track section membership
    const existing = sectionMap.get(section);
    if (existing) {
      existing.seatCount++;
    } else {
      sectionMap.set(section, {
        label: section,
        color: null,
        seatCount: 1,
        polygons: [],
      });
    }
  }

  return {
    glyphs,
    sections: buildSections(sectionMap),
    stage,
    issues,
  };
}

// ── CSV → sections serializer (for round-tripping) ──────────────────────

/**
 * Serialize a layout back to CSV text. Useful for export/round-trip.
 */
export function serializePlaceLayoutCsv(input: {
  glyphs: SeatGlyph[];
  sections: SeatSection[];
  stage?: StageLayout | null;
}): string {
  const lines: string[] = [];

  // Section directives
  for (const section of input.sections) {
    if (section.geometry?.polygons && section.geometry.polygons.length > 0) {
      for (const polygon of section.geometry.polygons) {
        const coords = polygon.map((p) => `${p.x} ${p.y}`).join(",");
        const color = section.color ?? "";
        const kind = section.kind ?? "";
        const capacity =
          section.capacity != null ? String(section.capacity) : "";
        const metadata =
          section.metadata && Object.keys(section.metadata).length > 0
            ? JSON.stringify(section.metadata)
            : "";
        const smoothing =
          section.geometry?.smoothing != null && section.geometry.smoothing > 0
            ? String(section.geometry.smoothing)
            : "";
        lines.push(
          Papa.unparse(
            [
              [
                SECTION_MARKER,
                section.sectionId,
                color,
                "polygon",
                coords,
                kind,
                capacity,
                metadata,
                smoothing,
              ],
            ],
            {
              quotes: true,
            },
          ),
        );
      }
    }
  }

  // Stage directive
  if (input.stage) {
    const s = input.stage;
    lines.push(
      Papa.unparse(
        [
          [
            STAGE_MARKER,
            s.kind,
            s.label ?? "",
            s.bounds.minX,
            s.bounds.minY,
            s.bounds.maxX,
            s.bounds.maxY,
          ],
        ],
        { quotes: true },
      ),
    );
  }

  // Seat header + rows
  const seatRows: Record<string, string>[] = input.glyphs.map((g) => {
    // Reverse the seatId format: "section-row-seat"
    const parts = g.seatId.split("-");
    const seat = parts.pop() ?? "";
    const rowLabel = parts.pop() ?? "";
    // Section may contain hyphens, so rejoin remaining parts
    const section = parts.join("-") || g.sectionId;

    return {
      section,
      row: rowLabel,
      seat,
      x: String(g.position.x),
      y: String(g.position.y),
      rotation: g.rotationDeg != null ? String(g.rotationDeg) : "",
      width: g.width != null ? String(g.width) : "",
      height: g.height != null ? String(g.height) : "",
      tier: (g.metadata?.tier as string) ?? "",
      notes: (g.metadata?.notes as string) ?? "",
      accessible: g.metadata?.accessible === true ? "true" : "",
    };
  });

  if (seatRows.length > 0) {
    lines.push(
      Papa.unparse(seatRows, {
        header: true,
        columns: [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS],
        quotes: true,
      }),
    );
  }

  return lines.join("\n");
}

// ── Internal helpers ─────────────────────────────────────────────────────

/**
 * Splits the raw CSV into directive lines (starting with # or quoted "#")
 * and the remaining seat-data CSV block.
 */
function splitDirectives(csvText: string): {
  directiveLines: Array<{ lineNumber: number; raw: string }>;
  seatCsv: string;
} {
  const lines = csvText.split(/\r?\n/);
  const directiveLines: Array<{ lineNumber: number; raw: string }> = [];
  const seatLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith("#") || trimmed.startsWith('"#')) {
      directiveLines.push({ lineNumber: i + 1, raw: lines[i]! });
    } else {
      seatLines.push(lines[i]!);
    }
  }

  return { directiveLines, seatCsv: seatLines.join("\n") };
}

function parseSectionDirective(
  row: string[],
  lineNumber: number,
  sectionMap: Map<
    string,
    {
      label: string;
      color: string | null;
      seatCount: number;
      kind?: "seat" | "ga" | "helper";
      capacity?: number;
      metadata?: Record<string, unknown>;
      smoothing?: number;
      polygons: Array<Array<{ x: number; y: number }>>;
    }
  >,
  issues: PlaceLayoutParserIssue[],
  limits?: {
    maxVerticesPerSection: number;
    maxTotalVertices: number;
    totalVertexCount: number;
  },
): void {
  // #section, sectionId, color, geometry-type, coordinates, kind, capacity, metadata(JSON), smoothing
  const sectionId = row[1]?.trim();
  if (!sectionId) {
    issues.push({
      code: "invalid_section_directive",
      message: `Line ${lineNumber}: #section directive missing sectionId`,
      severity: "warning",
      details: { lineNumber },
    });
    return;
  }

  const color = row[2]?.trim() || null;
  const geoType = row[3]?.trim().toLowerCase();
  const coordsRaw = row[4]?.trim();
  const rawKind = row[5]?.trim().toLowerCase();
  const rawCapacity = row[6]?.trim();
  const rawMetadata = row[7]?.trim();

  const existing = sectionMap.get(sectionId) ?? {
    label: sectionId,
    color: null,
    seatCount: 0,
    polygons: [],
  };

  if (color) existing.color = color;

  // Parse kind (columns 5+)
  const VALID_KINDS = new Set(["seat", "ga", "helper"]);
  if (rawKind && VALID_KINDS.has(rawKind)) {
    existing.kind = rawKind as "seat" | "ga" | "helper";
  }

  // Parse explicit capacity
  if (rawCapacity) {
    const cap = parseInt(rawCapacity, 10);
    if (Number.isFinite(cap) && cap >= 0) {
      existing.capacity = cap;
    }
  }

  // Parse metadata JSON
  if (rawMetadata) {
    try {
      const parsed = JSON.parse(rawMetadata);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing.metadata = parsed as Record<string, unknown>;
      }
    } catch {
      issues.push({
        code: "invalid_section_metadata",
        message: `Line ${lineNumber}: invalid metadata JSON for section "${sectionId}"`,
        severity: "warning",
        details: { lineNumber, sectionId },
      });
    }
  }

  // Parse smoothing (column 8)
  const rawSmoothing = row[8]?.trim();
  if (rawSmoothing) {
    const s = parseFloat(rawSmoothing);
    if (Number.isFinite(s) && s > 0) {
      existing.smoothing = Math.max(0, Math.min(1, s));
    }
  }

  if (geoType === "polygon" && coordsRaw) {
    const polygon = parsePolygonCoords(coordsRaw);
    if (polygon.length >= 3) {
      // ── Vertex limits ──────────────────────────────────────────────
      if (limits) {
        const sectionVertexCount = existing.polygons.reduce(
          (n, p) => n + p.length,
          0,
        );
        if (
          sectionVertexCount + polygon.length >
          limits.maxVerticesPerSection
        ) {
          issues.push({
            code: "max_vertices_per_section_exceeded",
            message: `Line ${lineNumber}: polygon for section "${sectionId}" would exceed ${limits.maxVerticesPerSection} vertices per section (current: ${sectionVertexCount}, adding: ${polygon.length})`,
            severity: "error",
            details: {
              lineNumber,
              sectionId,
              limit: limits.maxVerticesPerSection,
              current: sectionVertexCount,
              adding: polygon.length,
            },
          });
          sectionMap.set(sectionId, existing);
          return;
        }
        if (
          limits.totalVertexCount + polygon.length >
          limits.maxTotalVertices
        ) {
          issues.push({
            code: "max_total_vertices_exceeded",
            message: `Line ${lineNumber}: polygon for section "${sectionId}" would exceed ${limits.maxTotalVertices} total vertices across all sections (current: ${limits.totalVertexCount}, adding: ${polygon.length})`,
            severity: "error",
            details: {
              lineNumber,
              sectionId,
              limit: limits.maxTotalVertices,
              current: limits.totalVertexCount,
              adding: polygon.length,
            },
          });
          sectionMap.set(sectionId, existing);
          return;
        }
      }
      existing.polygons.push(polygon);
    } else {
      issues.push({
        code: "invalid_section_polygon",
        message: `Line ${lineNumber}: polygon for section "${sectionId}" has fewer than 3 points`,
        severity: "warning",
        details: { lineNumber, sectionId, pointCount: polygon.length },
      });
    }
  }

  sectionMap.set(sectionId, existing);
}

function parseStageDirective(
  row: string[],
  lineNumber: number,
  issues: PlaceLayoutParserIssue[],
): StageLayout | null {
  // #stage, kind, label, minX, minY, maxX, maxY
  const kind = (row[1]?.trim() || "rectangle") as StageLayout["kind"];
  const label = row[2]?.trim() || null;
  const minX = parseFloat(row[3] ?? "");
  const minY = parseFloat(row[4] ?? "");
  const maxX = parseFloat(row[5] ?? "");
  const maxY = parseFloat(row[6] ?? "");

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    issues.push({
      code: "invalid_stage_bounds",
      message: `Line ${lineNumber}: #stage directive has invalid bounds`,
      severity: "warning",
      details: { lineNumber, minX, minY, maxX, maxY },
    });
    return null;
  }

  return { kind, label, bounds: { minX, minY, maxX, maxY } };
}

function parsePolygonCoords(raw: string): Array<{ x: number; y: number }> {
  return raw
    .split(",")
    .map((pair) => {
      const [xStr, yStr] = pair.trim().split(/\s+/);
      const x = parseFloat(xStr ?? "");
      const y = parseFloat(yStr ?? "");
      if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
      return null;
    })
    .filter((p): p is { x: number; y: number } => p !== null);
}

function buildSections(
  sectionMap: Map<
    string,
    {
      label: string;
      color: string | null;
      seatCount: number;
      kind?: "seat" | "ga" | "helper";
      capacity?: number;
      metadata?: Record<string, unknown>;
      smoothing?: number;
      polygons: Array<Array<{ x: number; y: number }>>;
    }
  >,
): SeatSection[] {
  return Array.from(sectionMap.entries()).map(([sectionId, data]) => {
    // For GA sections use the explicit capacity; for seat sections fall back to counted seats.
    const effectiveCapacity = data.capacity ?? data.seatCount;

    const section: SeatSection = {
      sectionId,
      label: data.label,
      color: data.color,
      capacity: effectiveCapacity,
    };

    // Omit "helper" from SeatSection.kind since helper sections are
    // filtered at the materialization layer. For seat/ga, carry through.
    if (data.kind === "ga" || data.kind === "seat") {
      section.kind = data.kind;
    }

    if (data.metadata && Object.keys(data.metadata).length > 0) {
      section.metadata = data.metadata;
    }

    if (data.polygons.length > 0) {
      section.geometry = {
        polygons: data.polygons,
        ...(data.smoothing != null && data.smoothing > 0
          ? { smoothing: data.smoothing }
          : {}),
      };
    }

    return section;
  });
}

function safeParseFloat(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/** Sum all polygon vertex counts across every section in the map. */
function countTotalVertices(
  sectionMap: Map<string, { polygons: Array<Array<{ x: number; y: number }>> }>,
): number {
  let total = 0;
  for (const section of sectionMap.values()) {
    for (const polygon of section.polygons) {
      total += polygon.length;
    }
  }
  return total;
}
