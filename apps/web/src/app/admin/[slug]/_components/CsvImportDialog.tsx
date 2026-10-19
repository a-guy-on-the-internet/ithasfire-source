"use client";

/**
 * CsvImportDialog — Reusable multi-step CSV import overlay.
 *
 * Steps: Upload → Map Columns → Preview → Importing → Done
 *
 * Drop into any admin DataTable view. The consumer provides:
 * - `fields`: what columns the target table accepts
 * - `onSubmit`: async callback receiving the mapped rows
 * - `onClose`: dismiss handler
 *
 * The dialog handles file selection, parsing, column auto-mapping,
 * preview with validation, and progress display.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { YStack, XStack } from "tamagui";
import {
  Button,
  type DataTableColumn,
  Text,
  FormErrorBanner,
  useNotify,
  useTranslations,
  Spinner,
  type StyledSelectOption,
} from "@th/ui";
import { CheckCircle, ArrowRight, X, FileSpreadsheet } from "lucide-react";

import {
  parseCsv,
  autoDetectMappings,
  mapCsvRows,
  validateMappedRows,
  looksLikeHeaders,
  type CsvColumnMapping,
  type ParsedCsvRow,
} from "@/lib/csv-import";
import { useFormErrors } from "@/hooks/useFormErrors";

import type {
  ImportStep,
  CsvImportResult,
  CsvImportDialogProps,
} from "./csv-import-types";
import { CsvUploadStep } from "./CsvUploadStep";
import { CsvMappingStep } from "./CsvMappingStep";
import { CsvPreviewStep } from "./CsvPreviewStep";

// Re-export types so existing consumers keep working
export type {
  CsvImportResult,
  CsvImportDialogProps,
  ImportStep,
} from "./csv-import-types";

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function CsvImportDialog({
  open,
  onClose,
  fields,
  onSubmit,
  title,
  description,
  children,
}: CsvImportDialogProps) {
  const t = useTranslations();
  const { toast } = useNotify();
  const { formError, setError, clearAll } = useFormErrors();

  // ── State ─────────────────────────────────────────────────────────────

  const [step, setStep] = useState<ImportStep>("upload");
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [parsedRows, setParsedRows] = useState<ParsedCsvRow[]>([]);
  const [mappings, setMappings] = useState<CsvColumnMapping[]>([]);
  const [result, setResult] = useState<CsvImportResult | null>(null);

  type UploadMode = "file" | "paste";
  const [uploadMode, setUploadMode] = useState<UploadMode>("file");
  const [pasteText, setPasteText] = useState("");
  const [pastePreview, setPastePreview] = useState<{
    headers: string[];
    rowCount: number;
    error: string | null;
  } | null>(null);

  /** Whether the CSV has a header row. Auto-detected on parse, toggleable. */
  const [hasHeader, setHasHeader] = useState(true);
  /** Raw CSV text kept for re-parsing when hasHeader changes. */
  const [rawText, setRawText] = useState("");
  /** Which CSV column to preview on the mapping step. */
  const [previewColumn, setPreviewColumn] = useState<string | null>(null);

  // ── Derived ───────────────────────────────────────────────────────────

  const fieldKeys = useMemo(() => new Set(fields.map((f) => f.key)), [fields]);

  const requiredFields = useMemo(
    () => fields.filter((f) => f.required),
    [fields],
  );

  const missingRequired = useMemo(() => {
    const mapped = new Set(mappings.map((m) => m.targetField));
    return requiredFields.filter((f) => !mapped.has(f.key));
  }, [mappings, requiredFields]);

  const mappedRows = useMemo(
    () => mapCsvRows(parsedRows, mappings, fields),
    [parsedRows, mappings, fields],
  );

  const validationErrors = useMemo(
    () => validateMappedRows(mappedRows, fields),
    [mappedRows, fields],
  );

  const validRows = useMemo(() => {
    const errorIndices = new Set(validationErrors.map((v) => v.rowIndex));
    return mappedRows.filter((_, i) => !errorIndices.has(i));
  }, [mappedRows, validationErrors]);

  const previewColumns = useMemo<
    DataTableColumn<Record<string, string>>[]
  >(() => {
    return mappings
      .filter((m) => m.targetField !== "skip" && fieldKeys.has(m.targetField))
      .map((m) => {
        const field = fields.find((f) => f.key === m.targetField);
        return {
          id: m.targetField,
          header: field?.label ?? m.targetField,
          cell: (row: Record<string, string>) => (
            <Text fontSize="$2">{row[m.targetField] || "\u2014"}</Text>
          ),
        };
      });
  }, [mappings, fields, fieldKeys]);

  /** Options for the target-field dropdown (fields + "Skip"). */
  const targetFieldOptions = useMemo<StyledSelectOption<string>[]>(() => {
    return [
      { value: "skip", label: String(t("admin.csvImportSkip")) },
      ...fields.map((f) => ({
        value: f.key,
        label: `${f.label}${f.required ? " *" : ""}`,
      })),
    ];
  }, [fields, t]);

  /** Sample values for the currently previewed CSV column. */
  const columnPreviewSamples = useMemo(() => {
    if (!previewColumn || parsedRows.length === 0) return [];
    return parsedRows.slice(0, 8).map((row) => row[previewColumn] ?? "");
  }, [previewColumn, parsedRows]);

  // ── Reset ─────────────────────────────────────────────────────────────

  const reset = useCallback(() => {
    setStep("upload");
    setFileName("");
    setHeaders([]);
    setParsedRows([]);
    setMappings([]);
    setResult(null);
    setUploadMode("file");
    setPasteText("");
    setPastePreview(null);
    setHasHeader(true);
    setRawText("");
    setPreviewColumn(null);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  // ── File processing (shared by file input + drag-drop) ───────────────

  const processFile = useCallback(
    async (file: File) => {
      setFileName(file.name);

      const ext = file.name.split(".").pop()?.toLowerCase();
      if (ext !== "csv" && ext !== "tsv" && ext !== "txt") {
        toast.danger({
          id: "csv-import-format",
          title: String(t("admin.csvImportUnsupportedTitle")),
          message: String(t("admin.csvImportUnsupportedMessage")),
        });
        return;
      }

      const text = await file.text();
      setRawText(text);

      const detectedHasHeader = looksLikeHeaders(text);
      setHasHeader(detectedHasHeader);

      const parsed = parseCsv(text, { hasHeader: detectedHasHeader });

      if (parsed.headers.length === 0) {
        toast.danger({
          id: "csv-import-empty",
          title: String(t("admin.csvImportParseError")),
          message: String(t("admin.csvImportParseErrorMessage")),
        });
        return;
      }

      setHeaders(parsed.headers);
      setParsedRows(parsed.rows);
      setMappings(autoDetectMappings(parsed.headers, fields));
      setPreviewColumn(parsed.headers[0] ?? null);
      setStep("mapping");
    },
    [fields, toast, t],
  );

  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      await processFile(file);
      // Reset input so re-selecting the same file still fires onChange
      e.target.value = "";
    },
    [processFile],
  );

  // ── Paste text handling ───────────────────────────────────────────────

  /** Live-parse the textarea value to show a column preview. */
  const handlePasteChange = useCallback(
    (text: string) => {
      setPasteText(text);
      if (!text.trim()) {
        setPastePreview(null);
        return;
      }
      try {
        const parsed = parseCsv(text);
        if (parsed.headers.length === 0) {
          setPastePreview({
            headers: [],
            rowCount: 0,
            error: String(t("admin.csvImportPasteNoHeaders")),
          });
        } else {
          setPastePreview({
            headers: parsed.headers,
            rowCount: parsed.rows.length,
            error: null,
          });
        }
      } catch {
        setPastePreview({
          headers: [],
          rowCount: 0,
          error: String(t("admin.csvImportPasteInvalid")),
        });
      }
    },
    [t],
  );

  /** Commit pasted text: parse it fully and advance to mapping. */
  const handlePasteSubmit = useCallback(() => {
    if (!pasteText.trim()) return;

    const detectedHasHeader = looksLikeHeaders(pasteText);
    setHasHeader(detectedHasHeader);
    setRawText(pasteText);

    const parsed = parseCsv(pasteText, { hasHeader: detectedHasHeader });
    if (parsed.headers.length === 0) {
      toast.danger({
        id: "csv-import-empty",
        title: String(t("admin.csvImportParseError")),
        message: String(t("admin.csvImportParseErrorMessage")),
      });
      return;
    }
    setFileName(String(t("admin.csvImportPastedData")));
    setHeaders(parsed.headers);
    setParsedRows(parsed.rows);
    setMappings(autoDetectMappings(parsed.headers, fields));
    setPreviewColumn(parsed.headers[0] ?? null);
    setStep("mapping");
  }, [pasteText, fields, toast, t]);

  // ── Mapping changes ───────────────────────────────────────────────────

  const updateMapping = useCallback((index: number, targetField: string) => {
    setMappings((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], targetField };
      return next;
    });
  }, []);

  /** Toggle "has header" and re-parse from raw text. */
  const handleToggleHeader = useCallback(
    (checked: boolean) => {
      setHasHeader(checked);
      if (!rawText) return;

      const parsed = parseCsv(rawText, { hasHeader: checked });
      if (parsed.headers.length === 0) return;

      setHeaders(parsed.headers);
      setParsedRows(parsed.rows);
      setMappings(autoDetectMappings(parsed.headers, fields));
      setPreviewColumn(parsed.headers[0] ?? null);
    },
    [rawText, fields],
  );

  // ── Submit ────────────────────────────────────────────────────────────

  const handleSubmit = useCallback(async () => {
    clearAll();
    setStep("importing");
    try {
      const res = await onSubmit(validRows);
      setResult(res);
      setStep("done");
      toast.success({
        id: "csv-import-done",
        title: String(t("admin.csvImportComplete")),
        message: String(
          t("admin.csvImportCompleteMessage", {
            imported: res.imported.toLocaleString(),
            skipped: res.skipped.toLocaleString(),
          }),
        ),
      });
    } catch (err) {
      setError(err);
      setStep("preview");
    }
  }, [validRows, onSubmit, toast, t, clearAll, setError]);

  // ── Don't render when closed ──────────────────────────────────────────

  // Portal host — render into document.body so the dialog escapes any
  // overflow:auto/hidden ancestors (e.g. NavigationShell ContentArea).
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setPortalHost(document.body);
  }, []);

  if (!open || !portalHost) return null;

  // ── Step indicators ───────────────────────────────────────────────────

  const stepLabels: { key: ImportStep; label: string }[] = [
    { key: "upload", label: String(t("admin.csvImportStepUpload")) },
    { key: "mapping", label: String(t("admin.csvImportStepMap")) },
    { key: "preview", label: String(t("admin.csvImportStepPreview")) },
  ];

  const currentStepIndex = stepLabels.findIndex((s) => s.key === step);

  return createPortal(
    <YStack
      top={0}
      left={0}
      right={0}
      bottom={0}
      zIndex={9999}
      alignItems="center"
      justifyContent="center"
      style={{
        position: "fixed" as never,
        backdropFilter: "blur(4px)",
      }}
    >
      {/* Backdrop */}
      <YStack
        position="absolute"
        top={0}
        left={0}
        right={0}
        bottom={0}
        backgroundColor="rgba(0,0,0,0.6)"
        onPress={step !== "importing" ? handleClose : undefined}
      />

      {/* Dialog panel — flex column so body scrolls, header/footer stay */}
      <YStack
        position="relative"
        zIndex={1}
        backgroundColor="$surface"
        borderWidth={2}
        borderColor="$borderColor"
        borderRadius={0}
        maxWidth={1060}
        width="95%"
        maxHeight="90vh"
        style={{ display: "flex" as never, flexDirection: "column" as never }}
      >
        {/* Header — sticky at top */}
        <XStack
          paddingHorizontal="$4"
          paddingVertical="$3"
          borderBottomWidth={2}
          borderBottomColor="$borderColor"
          alignItems="center"
          gap="$3"
          style={{ flexShrink: 0 }}
        >
          <FileSpreadsheet size={20} />
          <Text variant="h6" weight="bold" flex={1}>
            {title ?? String(t("admin.csvImportTitle"))}
          </Text>
          {step !== "importing" && (
            <Button variant="ghost" size="$2" icon onPress={handleClose}>
              <X size={16} />
            </Button>
          )}
        </XStack>

        {/* Step indicator */}
        {step !== "importing" && step !== "done" && (
          <XStack
            paddingHorizontal="$4"
            paddingVertical="$2"
            gap="$3"
            borderBottomWidth={1}
            borderBottomColor="$borderColor"
            alignItems="center"
            style={{ flexShrink: 0 }}
          >
            {stepLabels.map((s, i) => {
              const isActive = s.key === step;
              const isPast = i < currentStepIndex;
              return (
                <XStack key={s.key} gap="$1" alignItems="center">
                  <YStack
                    width={20}
                    height={20}
                    borderRadius={0}
                    borderWidth={2}
                    borderColor={
                      isActive
                        ? "$brandSecondary"
                        : isPast
                          ? "$accent"
                          : "$borderColor"
                    }
                    backgroundColor={
                      isPast
                        ? "$accent"
                        : isActive
                          ? "$brandSecondary"
                          : "transparent"
                    }
                    alignItems="center"
                    justifyContent="center"
                  >
                    <Text
                      fontSize={10}
                      weight="bold"
                      color={
                        isPast || isActive ? "$onBrandSecondary" : "$colorMuted"
                      }
                    >
                      {i + 1}
                    </Text>
                  </YStack>
                  <Text
                    fontSize={11}
                    weight={isActive ? "bold" : "regular"}
                    color={isActive ? "$color" : "$colorMuted"}
                    style={{
                      textTransform: "uppercase",
                      letterSpacing: 0.8,
                    }}
                  >
                    {s.label}
                  </Text>
                  {i < stepLabels.length - 1 && (
                    <ArrowRight size={12} color="var(--colorMuted)" />
                  )}
                </XStack>
              );
            })}
          </XStack>
        )}

        {/* Scrollable step content */}
        <YStack overflow="scroll" style={{ flex: 1 }}>
          <FormErrorBanner message={formError} onDismiss={clearAll} />

          {/* ─── Step: Upload ──────────────────────────────────────── */}
          {step === "upload" && (
            <CsvUploadStep
              uploadMode={uploadMode}
              setUploadMode={setUploadMode}
              pasteText={pasteText}
              handlePasteChange={handlePasteChange}
              pastePreview={pastePreview}
              handlePasteSubmit={handlePasteSubmit}
              handleFileSelect={handleFileSelect}
              onFileDrop={processFile}
              description={description}
            />
          )}

          {/* ─── Step: Column mapping ──────────────────────────────── */}
          {step === "mapping" && (
            <CsvMappingStep
              fileName={fileName}
              parsedRows={parsedRows}
              mappings={mappings}
              hasHeader={hasHeader}
              previewColumn={previewColumn}
              targetFieldOptions={targetFieldOptions}
              columnPreviewSamples={columnPreviewSamples}
              missingRequired={missingRequired}
              updateMapping={updateMapping}
              handleToggleHeader={handleToggleHeader}
              setPreviewColumn={setPreviewColumn}
              onBack={reset}
              onNext={() => setStep("preview")}
            />
          )}

          {/* ─── Step: Preview ─────────────────────────────────────── */}
          {step === "preview" && (
            <CsvPreviewStep
              parsedRows={parsedRows}
              validRows={validRows}
              mappedRows={mappedRows}
              validationErrors={validationErrors}
              previewColumns={previewColumns}
              onBack={() => setStep("mapping")}
              onSubmit={handleSubmit}
            >
              {children}
            </CsvPreviewStep>
          )}

          {/* ─── Step: Importing ───────────────────────────────────── */}
          {step === "importing" && (
            <YStack
              padding="$8"
              gap="$4"
              alignItems="center"
              justifyContent="center"
              minHeight={260}
            >
              <Spinner size="lg" />
              <Text weight="bold" variant="h6">
                {String(t("admin.csvImportImporting"))}
              </Text>
              <Text tone="muted" textAlign="center">
                {String(
                  t("admin.csvImportImportingDescription", {
                    count: validRows.length.toLocaleString(),
                  }),
                )}
              </Text>
            </YStack>
          )}

          {/* ─── Step: Done ────────────────────────────────────────── */}
          {step === "done" && result && (
            <YStack
              padding="$8"
              gap="$4"
              alignItems="center"
              justifyContent="center"
              minHeight={260}
            >
              <CheckCircle size={44} color="var(--success)" />
              <Text weight="bold" variant="h5">
                {String(t("admin.csvImportCompleteTitle"))}
              </Text>

              <XStack gap="$6">
                <YStack alignItems="center">
                  <Text weight="bold" variant="h6">
                    {result.imported.toLocaleString()}
                  </Text>
                  <Text
                    fontSize={11}
                    tone="muted"
                    style={{
                      textTransform: "uppercase",
                      letterSpacing: 0.8,
                    }}
                  >
                    {String(t("admin.csvImportImported"))}
                  </Text>
                </YStack>
                {result.skipped > 0 && (
                  <YStack alignItems="center">
                    <Text weight="bold" variant="h6">
                      {result.skipped.toLocaleString()}
                    </Text>
                    <Text
                      fontSize={11}
                      tone="muted"
                      style={{
                        textTransform: "uppercase",
                        letterSpacing: 0.8,
                      }}
                    >
                      {String(t("admin.csvImportSkipped"))}
                    </Text>
                  </YStack>
                )}
              </XStack>

              <XStack gap="$2" paddingTop="$2">
                <Button size="$3" variant="primary" onPress={handleClose}>
                  {String(t("admin.csvImportDone"))}
                </Button>
                <Button size="$3" variant="secondary" onPress={reset}>
                  {String(t("admin.csvImportAnother"))}
                </Button>
              </XStack>
            </YStack>
          )}
        </YStack>
        {/* end scrollable step content */}
      </YStack>
    </YStack>,
    portalHost,
  );
}
