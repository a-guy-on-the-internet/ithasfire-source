// ─────────────────────────────────────────────────────────────────────────────
// CSV ↔ Designer state bridge
// ─────────────────────────────────────────────────────────────────────────────
// Client-side (browser) serialization / deserialization between the designer's
// internal representation and the CSV format that the backend adapter expects.
//
// This does NOT import from @th/adapters (which is a Node package). Instead it
// uses PapaParse directly in the browser for lightweight CSV round-tripping.
// The CSV format matches the adapter's expectations (see
// packages/adapters/src/place-layouts/parse-place-layout-csv.ts).
// ─────────────────────────────────────────────────────────────────────────────

import Papa from "papaparse";

import type {
  DesignerSection,
  DesignerSeat,
  DesignerStage,
  DesignerImage,
  SectionKind,
} from "./types";

// ── Constants (must match the adapter) ───────────────────────────────────

const SECTION_MARKER = "#section";
const STAGE_MARKER = "#stage";
const IMAGE_MARKER = "#image";

const REQUIRED_COLUMNS = ["section", "row", "seat", "x", "y"] as const;
const OPTIONAL_COLUMNS = [
  "rotation",
  "width",
  "height",
  "tier",
  "notes",
  "accessible",
] as const;

const VALID_SECTION_KINDS = new Set<string>(["seat", "ga", "helper"]);

// ── Serialize → CSV ──────────────────────────────────────────────────────

export function designerStateToCsv(opts: {
  sections: DesignerSection[];
  seats: DesignerSeat[];
  stage: DesignerStage | null;
  image?: DesignerImage | null;
}): string {
  const lines: string[] = [];

  // Image directive — #image,<dataUrl>,<x>,<y>,<width>,<height>,<opacity>
  if (opts.image?.dataUrl) {
    lines.push(
      Papa.unparse(
        [
          [
            IMAGE_MARKER,
            opts.image.dataUrl,
            opts.image.position.x,
            opts.image.position.y,
            opts.image.width,
            opts.image.height,
            opts.image.opacity,
          ],
        ],
        { quotes: true },
      ),
    );
  }

  // Section directives — columns: marker, sectionId, color, shape, coords, kind, capacity, metadata(JSON), smoothing, edgeSmoothing
  for (const section of opts.sections) {
    if (section.polygon.length >= 3) {
      const coords = section.polygon.map((p) => `${p.x} ${p.y}`).join(",");
      const capacityStr =
        section.capacity != null ? String(section.capacity) : "";
      const metadataStr =
        section.metadata && Object.keys(section.metadata).length > 0
          ? JSON.stringify(section.metadata)
          : "";
      const smoothingStr =
        section.smoothing != null && section.smoothing > 0
          ? String(section.smoothing)
          : "";
      const edgeSmoothingStr =
        section.edgeSmoothing && section.edgeSmoothing.length > 0
          ? section.edgeSmoothing
              .map((f) => `${f.edgeIndex}:${f.smoothing}`)
              .join("|")
          : "";
      lines.push(
        Papa.unparse(
          [
            [
              SECTION_MARKER,
              section.sectionId,
              section.color,
              "polygon",
              coords,
              section.kind,
              capacityStr,
              metadataStr,
              smoothingStr,
              edgeSmoothingStr,
            ],
          ],
          { quotes: true },
        ),
      );
    }
  }

  // Stage directive — only emitted if a stage object exists
  if (opts.stage) {
    const s = opts.stage;
    lines.push(
      Papa.unparse(
        [
          [
            STAGE_MARKER,
            s.kind,
            s.label,
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

  // Seat rows
  const rows: Record<string, string>[] = opts.seats.map((seat) => ({
    section: seat.sectionId,
    row: seat.row,
    seat: seat.seat,
    x: String(seat.position.x),
    y: String(seat.position.y),
    rotation: seat.rotationDeg ? String(seat.rotationDeg) : "",
    width: "",
    height: "",
    tier: seat.tier ?? "",
    notes: seat.notes ?? "",
    accessible: seat.accessible ? "true" : "",
  }));

  if (rows.length > 0) {
    lines.push(
      Papa.unparse(rows, {
        header: true,
        columns: [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS],
        quotes: true,
      }),
    );
  }

  return lines.join("\n");
}

// ── Deserialize CSV → designer state ─────────────────────────────────────

export type CsvImportResult = {
  sections: DesignerSection[];
  seats: DesignerSeat[];
  stage: DesignerStage | null;
  image: DesignerImage | null;
  warnings: string[];
};

/**
 * Parse a CSV string into designer state objects.
 * Returns warnings for non-fatal issues (e.g. unrecognized directives).
 */
export function csvToDesignerState(csvText: string): CsvImportResult {
  const warnings: string[] = [];
  const sections: DesignerSection[] = [];
  const sectionMap = new Map<string, DesignerSection>();
  let stage: DesignerStage | null = null;
  let image: DesignerImage | null = null;
  const seats: DesignerSeat[] = [];

  // Split directives from seat data
  const rawLines = csvText.split(/\r?\n/);
  const directiveLines: string[] = [];
  const seatLines: string[] = [];

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed.startsWith('"#')) {
      directiveLines.push(line);
    } else {
      seatLines.push(line);
    }
  }

  // Parse directive lines
  for (const raw of directiveLines) {
    const parsed = Papa.parse<string[]>(raw, { header: false });
    const row = parsed.data[0];
    if (!row || row.length === 0) continue;

    const marker = row[0]!.trim().toLowerCase();

    if (marker === SECTION_MARKER) {
      const sectionId = row[1]?.trim() ?? "";
      const color = row[2]?.trim() || "#888888";
      const coordsStr = row[4]?.trim() ?? "";
      const rawKind = row[5]?.trim().toLowerCase() ?? "";
      const sectionKind: SectionKind = VALID_SECTION_KINDS.has(rawKind)
        ? (rawKind as SectionKind)
        : "seat";
      const rawCapacity = row[6]?.trim() ?? "";
      const capacity =
        rawCapacity !== "" && Number.isFinite(Number(rawCapacity))
          ? Math.max(0, Math.round(Number(rawCapacity)))
          : undefined;
      const rawMetadata = row[7]?.trim() ?? "";
      let metadata: Record<string, string> | undefined;
      if (rawMetadata) {
        try {
          const parsed = JSON.parse(rawMetadata);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            metadata = parsed as Record<string, string>;
          }
        } catch {
          // Invalid JSON metadata — skip silently
        }
      }
      // Smoothing field (column 8 / index 8) — optional, default 0
      const rawSmoothing = row[8]?.trim() ?? "";
      const smoothing =
        rawSmoothing !== "" &&
        Number.isFinite(Number(rawSmoothing)) &&
        Number(rawSmoothing) > 0
          ? Math.max(0, Math.min(1, Number(rawSmoothing)))
          : undefined;
      // Per-edge smoothing (column 9 / index 9) — pipe-delimited "edgeIndex:smoothing" pairs
      const rawEdgeSmoothing = row[9]?.trim() ?? "";
      let edgeSmoothing:
        | Array<{ edgeIndex: number; smoothing: number }>
        | undefined;
      if (rawEdgeSmoothing) {
        const flags: Array<{ edgeIndex: number; smoothing: number }> = [];
        for (const pair of rawEdgeSmoothing.split("|")) {
          const [idxStr, valStr] = pair.split(":");
          const idx = Number(idxStr);
          const val = Number(valStr);
          if (
            Number.isInteger(idx) &&
            idx >= 0 &&
            Number.isFinite(val) &&
            val > 0
          ) {
            flags.push({
              edgeIndex: idx,
              smoothing: Math.max(0, Math.min(1, val)),
            });
          }
        }
        if (flags.length > 0) edgeSmoothing = flags;
      }
      const points = coordsStr
        .split(",")
        .map((pair) => {
          const [xStr, yStr] = pair.trim().split(/\s+/);
          const x = Number(xStr);
          const y = Number(yStr);
          if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
          return null;
        })
        .filter((p): p is { x: number; y: number } => p !== null);

      if (sectionId && points.length >= 3) {
        const existing = sectionMap.get(sectionId);
        if (existing) {
          // Merge polygons? Designer only supports one polygon per section;
          // take the one with more points.
          if (points.length > existing.polygon.length) {
            existing.polygon = points;
          }
        } else {
          const section: DesignerSection = {
            sectionId,
            label: sectionId,
            color,
            polygon: points,
            kind: sectionKind,
            capacity,
            metadata,
            smoothing,
            edgeSmoothing,
          };
          sectionMap.set(sectionId, section);
          sections.push(section);
        }
      } else if (sectionId && points.length < 3) {
        warnings.push(
          `Section "${sectionId}" polygon has fewer than 3 points, skipped.`,
        );
      }
    } else if (marker === STAGE_MARKER) {
      const kind = row[1]?.trim() ?? "rectangle";
      const label = row[2]?.trim() ?? "";
      const minX = Number(row[3]);
      const minY = Number(row[4]);
      const maxX = Number(row[5]);
      const maxY = Number(row[6]);
      if ([minX, minY, maxX, maxY].every(Number.isFinite)) {
        stage = {
          kind: "rectangle",
          label,
          bounds: { minX, minY, maxX, maxY },
        };
      } else {
        warnings.push("Stage directive has invalid bounds, skipped.");
      }
    } else if (marker === IMAGE_MARKER) {
      const dataUrl = row[1]?.trim() ?? "";
      const imgX = Number(row[2]);
      const imgY = Number(row[3]);
      const imgW = Number(row[4]);
      const imgH = Number(row[5]);
      const imgOpacity = Number(row[6]);
      if (dataUrl && [imgX, imgY, imgW, imgH].every(Number.isFinite)) {
        image = {
          src: dataUrl, // When loaded from CSV, src === dataUrl (no objectUrl yet)
          dataUrl,
          position: { x: imgX, y: imgY },
          width: imgW,
          height: imgH,
          opacity: Number.isFinite(imgOpacity) ? imgOpacity : 1,
        };
      } else {
        warnings.push("Image directive has invalid data, skipped.");
      }
    }
  }

  // Parse seat CSV
  const seatCsv = seatLines.join("\n").trim();
  if (seatCsv) {
    const result = Papa.parse<Record<string, string>>(seatCsv, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim().toLowerCase(),
    });

    for (const record of result.data) {
      const sectionId = record.section?.trim() ?? "";
      const row = record.row?.trim() ?? "";
      const seat = record.seat?.trim() ?? "";
      const x = Number(record.x);
      const y = Number(record.y);
      const rotation = Number(record.rotation) || 0;

      if (!sectionId || !row || !seat) continue;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        warnings.push(
          `Seat ${sectionId}-${row}-${seat} has invalid coordinates, skipped.`,
        );
        continue;
      }

      const seatId = `${sectionId}-${row}-${seat}`;
      seats.push({
        id: seatId,
        sectionId,
        row,
        seat,
        position: { x, y },
        radius: 4, // default
        rotationDeg: rotation,
        tier: record.tier?.trim() || undefined,
        notes: record.notes?.trim() || undefined,
        accessible:
          record.accessible?.trim().toLowerCase() === "true" || undefined,
      });

      // Auto-create section if not declared via directive
      if (!sectionMap.has(sectionId)) {
        const section: DesignerSection = {
          sectionId,
          label: sectionId,
          color: "#888888",
          polygon: [],
          kind: "seat",
        };
        sectionMap.set(sectionId, section);
        sections.push(section);
      }
    }
  }

  return { sections, seats, stage, image, warnings };
}

// ── Glyph blob → designer state ──────────────────────────────────────────

/** Shape of the JSON envelope stored in the glyph blob. */
export type GlyphBlobEnvelope = {
  glyphs: Array<{
    seatId: string;
    sectionId: string;
    label: string;
    position: { x: number; y: number };
    radius?: number;
    rotationDeg?: number;
    metadata?: Record<string, unknown>;
  }>;
};

export type LayoutSectionInput = {
  sectionId: string;
  label: string;
  color?: string | null;
  capacity: number;
  geometry?: {
    polygons?: Array<Array<{ x: number; y: number }>> | null;
  } | null;
};

export type StageInput = {
  kind: string;
  label?: string | null;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
};

/**
 * Convert a glyph blob JSON + layout sections into designer state objects.
 * Used to re-load an existing saved layout into the designer for editing.
 */
export function glyphsToDesignerState(opts: {
  glyphs: GlyphBlobEnvelope["glyphs"];
  sections: LayoutSectionInput[];
  stage: StageInput | null;
}): CsvImportResult {
  const warnings: string[] = [];
  const sectionMap = new Map<string, DesignerSection>();
  const sections: DesignerSection[] = [];

  // Build sections from layout metadata (they have polygon geometry)
  for (const sec of opts.sections) {
    const polygons = sec.geometry?.polygons ?? [];
    const polygon = polygons.length > 0 ? polygons[0]! : [];

    const section: DesignerSection = {
      sectionId: sec.sectionId,
      label: sec.label,
      color: sec.color ?? "#888888",
      polygon: polygon.map((p) => ({ x: p.x, y: p.y })),
      kind: "seat",
    };
    sectionMap.set(sec.sectionId, section);
    sections.push(section);
  }

  // Convert glyphs to designer seats
  const seats: DesignerSeat[] = [];
  for (const glyph of opts.glyphs) {
    // Parse seatId format: "sectionId-row-seat"
    const parts = glyph.seatId.split("-");
    // sectionId may contain dashes, so find the last two parts
    const seat = parts.pop() ?? "";
    const row = parts.pop() ?? "A";
    const sectionId = parts.join("-") || glyph.sectionId;

    seats.push({
      id: glyph.seatId,
      sectionId: glyph.sectionId,
      row,
      seat,
      position: { x: glyph.position.x, y: glyph.position.y },
      radius: glyph.radius ?? 4,
      rotationDeg: glyph.rotationDeg ?? 0,
      accessible: glyph.metadata?.accessible === true || undefined,
    });

    // Auto-create section if not in the layout metadata
    if (!sectionMap.has(glyph.sectionId)) {
      const section: DesignerSection = {
        sectionId: glyph.sectionId,
        label: glyph.sectionId,
        color: "#888888",
        polygon: [],
        kind: "seat",
      };
      sectionMap.set(glyph.sectionId, section);
      sections.push(section);
    }
  }

  // Stage
  let stage: DesignerStage | null = null;
  if (opts.stage) {
    stage = {
      kind: "rectangle",
      label: opts.stage.label ?? "",
      bounds: { ...opts.stage.bounds },
    };
  }

  return { sections, seats, stage, image: null, warnings };
}

// ── File helpers ─────────────────────────────────────────────────────────

/** Trigger a CSV file download in the browser. */
export function downloadCsv(csvText: string, filename: string): void {
  const blob = new Blob([csvText], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** Read a File as text (for CSV imports). */
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsText(file);
  });
}
