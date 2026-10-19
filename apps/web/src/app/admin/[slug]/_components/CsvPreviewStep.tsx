"use client";

import { useState, useMemo } from "react";
import type { ReactNode } from "react";
import { YStack, XStack } from "tamagui";
import {
  Button,
  DataTable,
  type DataTableColumn,
  Text,
  useTranslations,
} from "@th/ui";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle,
} from "lucide-react";

import {
  IMPORT_WARN_THRESHOLD,
  type ParsedCsvRow,
  type CsvRowValidation,
} from "@/lib/csv-import";

const PAGE_SIZE = 50;

interface CsvPreviewStepProps {
  parsedRows: ParsedCsvRow[];
  validRows: Record<string, string>[];
  mappedRows: Record<string, string>[];
  validationErrors: CsvRowValidation[];
  previewColumns: DataTableColumn<Record<string, string>>[];
  onBack: () => void;
  onSubmit: () => void;
  children?: ReactNode;
}

export function CsvPreviewStep({
  parsedRows,
  validRows,
  mappedRows,
  validationErrors,
  previewColumns,
  onBack,
  onSubmit,
  children,
}: CsvPreviewStepProps) {
  const t = useTranslations();
  const [activeTab, setActiveTab] = useState<"valid" | "invalid">("valid");
  const [page, setPage] = useState(0);

  // ── Invalid rows derivation ──────────────────────────────────────────

  const invalidRows = useMemo(() => {
    const errorMap = new Map(validationErrors.map((v) => [v.rowIndex, v]));
    return mappedRows
      .map((row, i) => ({ row, validation: errorMap.get(i) }))
      .filter(
        (
          item,
        ): item is {
          row: Record<string, string>;
          validation: CsvRowValidation;
        } => !!item.validation,
      );
  }, [mappedRows, validationErrors]);

  const invalidDisplayRows = useMemo(
    () =>
      invalidRows.map(({ row, validation }) => ({
        ...row,
        __errors: validation.errors
          .map((e) => `${e.field}: ${e.message}`)
          .join(", "),
      })),
    [invalidRows],
  );

  const invalidColumns = useMemo<DataTableColumn<Record<string, string>>[]>(
    () => [
      ...previewColumns,
      {
        id: "errors",
        header: String(t("admin.csvImportErrorsColumn")),
        cell: (row: Record<string, string>) => (
          <Text fontSize="$1" color="$error">
            {row.__errors ?? ""}
          </Text>
        ),
      },
    ],
    [previewColumns, t],
  );

  // ── Pagination ───────────────────────────────────────────────────────

  const currentRows = activeTab === "valid" ? validRows : invalidDisplayRows;
  const totalPages = Math.max(1, Math.ceil(currentRows.length / PAGE_SIZE));
  const pageRows = currentRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const currentColumns =
    activeTab === "valid" ? previewColumns : invalidColumns;

  return (
    <YStack padding="$4" gap="$4">
      {/* Stats row */}
      <XStack gap="$4" flexWrap="wrap">
        <YStack gap="$1">
          <Text
            fontSize={11}
            tone="muted"
            style={{
              textTransform: "uppercase",
              letterSpacing: 0.8,
            }}
          >
            {String(t("admin.csvImportTotalRows"))}
          </Text>
          <Text weight="bold">{parsedRows.length.toLocaleString()}</Text>
        </YStack>
        <YStack gap="$1">
          <Text
            fontSize={11}
            tone="muted"
            style={{
              textTransform: "uppercase",
              letterSpacing: 0.8,
            }}
          >
            {String(t("admin.csvImportValidRows"))}
          </Text>
          <Text weight="bold" tone="success">
            {validRows.length.toLocaleString()}
          </Text>
        </YStack>
        {validationErrors.length > 0 && (
          <YStack gap="$1">
            <Text
              fontSize={11}
              tone="muted"
              style={{
                textTransform: "uppercase",
                letterSpacing: 0.8,
              }}
            >
              {String(t("admin.csvImportInvalidRows"))}
            </Text>
            <Text weight="bold" tone="warning">
              {validationErrors.length.toLocaleString()}
            </Text>
          </YStack>
        )}
      </XStack>

      {/* Large import warning */}
      {validRows.length > IMPORT_WARN_THRESHOLD && (
        <XStack
          gap="$2"
          alignItems="center"
          padding="$2"
          backgroundColor="$surfaceMuted"
          borderWidth={2}
          borderColor="$borderColor"
        >
          <AlertTriangle size={16} color="var(--warning)" />
          <Text fontSize="$2" tone="warning">
            {String(
              t("admin.csvImportLargeWarning", {
                total: validRows.length.toLocaleString(),
              }),
            )}
          </Text>
        </XStack>
      )}

      {/* Preview table with tabs */}
      {previewColumns.length > 0 && (
        <YStack gap="$2">
          <Text
            fontSize={11}
            weight="bold"
            style={{
              textTransform: "uppercase",
              letterSpacing: 0.8,
            }}
          >
            {String(t("admin.csvImportPreview"))}
          </Text>

          {/* Tab bar */}
          <XStack
            gap="$2"
            borderBottomWidth={1}
            borderBottomColor="$borderColor"
          >
            <Button
              size="$2"
              variant="ghost"
              onPress={() => {
                setActiveTab("valid");
                setPage(0);
              }}
              borderRadius={0}
              borderBottomWidth={activeTab === "valid" ? 2 : 0}
              borderBottomColor={
                activeTab === "valid" ? "$success" : "transparent"
              }
            >
              {String(
                t("admin.csvImportTabValid", {
                  count: validRows.length.toLocaleString(),
                }),
              )}
            </Button>
            {validationErrors.length > 0 && (
              <Button
                size="$2"
                variant="ghost"
                onPress={() => {
                  setActiveTab("invalid");
                  setPage(0);
                }}
                borderRadius={0}
                borderBottomWidth={activeTab === "invalid" ? 2 : 0}
                borderBottomColor={
                  activeTab === "invalid" ? "$warning" : "transparent"
                }
              >
                {String(
                  t("admin.csvImportTabInvalid", {
                    count: validationErrors.length.toLocaleString(),
                  }),
                )}
              </Button>
            )}
          </XStack>

          {/* Table content */}
          {activeTab === "invalid" && invalidDisplayRows.length === 0 ? (
            <XStack gap="$2" alignItems="center" padding="$3">
              <CheckCircle size={16} color="var(--success)" />
              <Text fontSize="$2" tone="success">
                {String(t("admin.csvImportAllValid"))}
              </Text>
            </XStack>
          ) : currentRows.length > 0 ? (
            <>
              <YStack
                borderWidth={2}
                borderColor="$borderColor"
                borderRadius={0}
                overflow="scroll"
                maxHeight={280}
              >
                <DataTable
                  rows={pageRows}
                  columns={currentColumns}
                  getRowKey={(_row, i) => String(page * PAGE_SIZE + i)}
                />
              </YStack>

              {/* Pagination controls */}
              {totalPages > 1 && (
                <XStack gap="$2" alignItems="center" justifyContent="center">
                  <Button
                    size="$1"
                    variant="ghost"
                    disabled={page === 0}
                    onPress={() => setPage((p) => p - 1)}
                  >
                    <ArrowLeft size={14} />
                  </Button>
                  <Text fontSize="$1" tone="muted">
                    {String(
                      t("admin.csvImportPage", {
                        page: page + 1,
                        total: totalPages,
                      }),
                    )}
                  </Text>
                  <Button
                    size="$1"
                    variant="ghost"
                    disabled={page >= totalPages - 1}
                    onPress={() => setPage((p) => p + 1)}
                  >
                    <ArrowRight size={14} />
                  </Button>
                </XStack>
              )}
            </>
          ) : null}
        </YStack>
      )}

      {/* Consumer extras */}
      {children}

      {/* Navigation */}
      <XStack gap="$2" justifyContent="flex-end">
        <Button size="$2" variant="ghost" onPress={onBack}>
          <ArrowLeft size={14} />
          {String(t("admin.csvImportBack"))}
        </Button>
        <Button
          size="$2"
          variant="primary"
          onPress={onSubmit}
          disabled={validRows.length === 0}
        >
          {String(
            t("admin.csvImportSubmit", {
              count: validRows.length.toLocaleString(),
            }),
          )}
        </Button>
      </XStack>
    </YStack>
  );
}
