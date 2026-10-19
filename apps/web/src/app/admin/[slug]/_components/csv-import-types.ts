// ─────────────────────────────────────────────────────────────────────────────
// Shared types for the CSV import wizard.
// ─────────────────────────────────────────────────────────────────────────────

export type ImportStep =
  | "upload"
  | "mapping"
  | "preview"
  | "importing"
  | "done";

export interface CsvImportResult {
  /** Total rows submitted to the callback. */
  total: number;
  /** Rows successfully processed. */
  imported: number;
  /** Rows skipped (duplicates, invalid, etc.). */
  skipped: number;
}

export interface CsvImportDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Close handler. */
  onClose: () => void;
  /**
   * Target field definitions. Each field describes one column the
   * consumer table expects. The dialog maps CSV headers to these.
   */
  fields: import("@/lib/csv-import").CsvImportFieldDef[];
  /**
   * Async callback that receives the mapped row objects. The consumer
   * is responsible for calling the appropriate tRPC mutation or API.
   *
   * Return a `CsvImportResult` so the dialog can show a summary.
   */
  onSubmit: (rows: Record<string, string>[]) => Promise<CsvImportResult>;
  /** Dialog title (defaults to i18n key). */
  title?: string;
  /** Optional description shown in the upload step. */
  description?: string;
  /** Extra content rendered below the preview table. */
  children?: import("react").ReactNode;
}
