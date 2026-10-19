/**
 * Generic CSV export utility.
 *
 * Converts an array of row objects into a CSV string and triggers a browser
 * download. Handles quoting, escaping, and BOM for Excel compatibility.
 */

export interface CsvColumnDef<TRow> {
  /** Header label shown in the first row. */
  header: string;
  /** Extract the cell value from a row. */
  value: (row: TRow) => string | number | boolean | null | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Large-export guard thresholds
// ─────────────────────────────────────────────────────────────────────────────

/** Above this total the UI shows a "may be slow" warning. */
export const EXPORT_WARN_THRESHOLD = 5_000;

/** Above this total the export switches to background job. */
export const EXPORT_BACKGROUND_THRESHOLD = 25_000;

export type ExportGuardStatus = "ok" | "warn" | "background";

/**
 * Evaluate whether an export should proceed in-browser, warn, or
 * be routed to the background job based on the total row count.
 */
export function getExportGuardStatus(total: number): ExportGuardStatus {
  if (total > EXPORT_BACKGROUND_THRESHOLD) return "background";
  if (total > EXPORT_WARN_THRESHOLD) return "warn";
  return "ok";
}

/**
 * Build a CSV string from rows + column definitions.
 */
export function rowsToCsv<TRow>(
  rows: TRow[],
  columns: CsvColumnDef<TRow>[],
): string {
  const escape = (v: string): string => {
    if (
      v.includes('"') ||
      v.includes(",") ||
      v.includes("\n") ||
      v.includes("\r")
    ) {
      return `"${v.replace(/"/g, '""')}"`;
    }
    return v;
  };

  const header = columns.map((c) => escape(c.header)).join(",");

  const body = rows
    .map((row) =>
      columns
        .map((col) => {
          const raw = col.value(row);
          if (raw == null) return "";
          return escape(String(raw));
        })
        .join(","),
    )
    .join("\n");

  return `${header}\n${body}`;
}

/**
 * Trigger a CSV file download in the browser.
 *
 * Prepends a UTF-8 BOM so Excel opens the file with the correct encoding.
 */
export function downloadCsv(csv: string, filename: string): void {
  const BOM = "\uFEFF";
  const blob = new Blob([BOM + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();

  // Cleanup
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Fetch all pages from a paginated tRPC query and return the complete item list.
 *
 * `fetcher` should call the tRPC query with `{ limit, offset }` merged into
 * whatever base input it needs. It must return `{ items: T[]; pageInfo: { total; hasNextPage } }`.
 */
export async function fetchAllPages<T>(
  fetcher: (pagination: { limit: number; offset: number }) => Promise<{
    items: T[];
    pageInfo: { total: number; hasNextPage: boolean };
  }>,
  /** Max rows per request. Stays within OFFSET_MAX_LIMIT (200). */
  pageSize = 200,
): Promise<T[]> {
  const allItems: T[] = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const page = await fetcher({ limit: pageSize, offset });
    allItems.push(...page.items);
    hasMore = page.pageInfo.hasNextPage;
    offset += pageSize;

    // Safety valve: don't loop forever.
    if (offset > 100_000) break;
  }

  return allItems;
}
