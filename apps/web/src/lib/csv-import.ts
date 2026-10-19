/**
 * Generic CSV import/parse utility.
 *
 * Companion to `csv-export.ts`. Uses PapaParse for RFC 4180-compliant
 * parsing (quoted fields, embedded commas/newlines, escaped quotes, BOM)
 * and provides column-mapping helpers for the reusable `CsvImportDialog`.
 */

import Papa from "papaparse";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** A single parsed row — keys are the raw CSV header names. */
export type ParsedCsvRow = Record<string, string>;

export interface ParsedCsv {
  headers: string[];
  rows: ParsedCsvRow[];
}

/**
 * Describes one target field the consumer table accepts.
 *
 * The import dialog renders these as mapping targets. `autoDetect` is a
 * list of common header names (case-insensitive, alphanumeric-only) that
 * should auto-bind to this field.
 */
export interface CsvImportFieldDef {
  /** Unique field key — matches the key in the output object. */
  key: string;
  /** Human-readable label shown in the mapping UI. */
  label: string;
  /** If true, at least one CSV column must map to this field. */
  required?: boolean;
  /**
   * Lowercase header names (stripped of non-alphanumeric chars) that
   * should auto-map to this field on parse.
   */
  autoDetect?: string[];
  /**
   * Optional transform applied to each cell value after mapping.
   * Useful for normalising dates, trimming, lowercasing emails, etc.
   */
  transform?: (raw: string) => string;
}

export interface CsvColumnMapping {
  /** The raw header from the CSV file. */
  sourceHeader: string;
  /** Target field key, or "skip" to ignore this column. */
  targetField: string;
}

/** Validation result for a single row. */
export interface CsvRowValidation {
  rowIndex: number;
  errors: { field: string; message: string }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV parser (PapaParse — RFC 4180)
// ─────────────────────────────────────────────────────────────────────────────

export interface ParseCsvOptions {
  /** Whether the first row contains column headers. Defaults to `true`. */
  hasHeader?: boolean;
}

/**
 * Parse raw CSV text into headers + rows.
 *
 * Delegates to PapaParse which handles:
 * - RFC 4180 compliant quoting, embedded commas, and newlines
 * - Escaped quotes (`""` inside quoted fields)
 * - UTF-8 BOM prefix (via `skipEmptyLines`)
 * - Both `\r\n` and `\n` line endings
 * - TSV (tab-separated) auto-detection
 *
 * When `hasHeader` is `false`, synthetic headers are generated as
 * "Column 1", "Column 2", etc. and the first row is treated as data.
 */
export function parseCsv(text: string, opts?: ParseCsvOptions): ParsedCsv {
  const hasHeader = opts?.hasHeader ?? true;

  // Strip BOM — PapaParse handles most cases, but be safe
  const clean = text.replace(/^\uFEFF/, "");
  if (!clean.trim()) return { headers: [], rows: [] };

  if (hasHeader) {
    const result = Papa.parse<Record<string, string>>(clean, {
      header: true,
      skipEmptyLines: "greedy",
      transformHeader: (h: string) => h.trim(),
      transform: (v: string) => v.trim(),
    });

    const headers = result.meta.fields ?? [];
    if (headers.length === 0) return { headers: [], rows: [] };

    const rows: ParsedCsvRow[] = result.data.map((row) => {
      const out: ParsedCsvRow = {};
      for (const h of headers) {
        out[h] = row[h] ?? "";
      }
      return out;
    });

    return { headers, rows };
  }

  // No header row — parse as array-of-arrays and generate synthetic headers
  const result = Papa.parse<string[]>(clean, {
    header: false,
    skipEmptyLines: "greedy",
    transform: (v: string) => v.trim(),
  });

  const data = result.data;
  if (data.length === 0) return { headers: [], rows: [] };

  const colCount = Math.max(...data.map((r) => r.length));
  const headers = Array.from({ length: colCount }, (_, i) => `Column ${i + 1}`);

  const rows: ParsedCsvRow[] = data.map((arr) => {
    const out: ParsedCsvRow = {};
    for (let i = 0; i < colCount; i++) {
      out[headers[i]] = arr[i] ?? "";
    }
    return out;
  });

  return { headers, rows };
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-detect mappings
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Given CSV headers and a list of target field definitions, produce an
 * initial mapping array. Columns that match a field's `autoDetect` list
 * bind automatically; everything else defaults to "skip".
 */
export function autoDetectMappings(
  headers: string[],
  fields: CsvImportFieldDef[],
): CsvColumnMapping[] {
  // Track which fields have already been claimed to avoid double-mapping
  const claimed = new Set<string>();

  return headers.map((h) => {
    const normalised = h.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const field of fields) {
      if (claimed.has(field.key)) continue;
      const detectors = field.autoDetect ?? [];
      if (detectors.some((d) => d.replace(/[^a-z0-9]/g, "") === normalised)) {
        claimed.add(field.key);
        return { sourceHeader: h, targetField: field.key };
      }
    }
    return { sourceHeader: h, targetField: "skip" };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Map rows
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply column mappings + optional transforms to produce an array of
 * typed row objects. Skipped columns are excluded.
 */
export function mapCsvRows(
  rows: ParsedCsvRow[],
  mappings: CsvColumnMapping[],
  fields: CsvImportFieldDef[],
): Record<string, string>[] {
  const fieldMap = new Map(fields.map((f) => [f.key, f]));

  return rows.map((row) => {
    const out: Record<string, string> = {};
    for (const m of mappings) {
      if (m.targetField === "skip") continue;
      const raw = row[m.sourceHeader]?.trim() ?? "";
      const field = fieldMap.get(m.targetField);
      out[m.targetField] = field?.transform ? field.transform(raw) : raw;
    }
    return out;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate mapped rows against required field definitions.
 * Returns only rows that have errors.
 */
export function validateMappedRows(
  rows: Record<string, string>[],
  fields: CsvImportFieldDef[],
): CsvRowValidation[] {
  const required = fields.filter((f) => f.required);
  const results: CsvRowValidation[] = [];

  for (let i = 0; i < rows.length; i++) {
    const errors: { field: string; message: string }[] = [];
    for (const f of required) {
      if (!rows[i][f.key]?.trim()) {
        errors.push({ field: f.key, message: `${f.label} is required` });
      }
    }
    if (errors.length > 0) results.push({ rowIndex: i, errors });
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Thresholds
// ─────────────────────────────────────────────────────────────────────────────

/** Above this count the import dialog shows a performance warning. */
export const IMPORT_WARN_THRESHOLD = 5_000;

/** Above this count the import requires chunked submission. */
export const IMPORT_CHUNK_THRESHOLD = 25_000;

/** Rows per chunk for large imports. */
export const IMPORT_CHUNK_SIZE = 1_000;

/**
 * Heuristic: does the first row look like column headers?
 *
 * Returns `true` when every cell in the first row is non-numeric and
 * distinct from every cell in subsequent sample rows. Not foolproof,
 * but good enough for a default toggle value.
 */
export function looksLikeHeaders(text: string): boolean {
  const clean = text.replace(/^\uFEFF/, "").trim();
  if (!clean) return false;

  const result = Papa.parse<string[]>(clean, {
    header: false,
    skipEmptyLines: "greedy",
    preview: 6,
    transform: (v: string) => v.trim(),
  });

  const data = result.data;
  if (data.length < 2) return true; // single row — assume header

  const first = data[0];
  // If every cell in the first row is non-numeric and non-empty, likely headers
  const allNonNumeric = first.every(
    (cell) => cell !== "" && isNaN(Number(cell)),
  );
  // Check that first-row values don't repeat in data rows (headers are usually unique labels)
  const dataRows = data.slice(1, 6);
  const firstAsSet = new Set(first.map((c) => c.toLowerCase()));
  const anyDataMatch = dataRows.some((row) =>
    row.some((cell) => cell !== "" && firstAsSet.has(cell.toLowerCase())),
  );

  return allNonNumeric && !anyDataMatch;
}
