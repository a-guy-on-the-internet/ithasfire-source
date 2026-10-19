"use client";

import { YStack, XStack } from "tamagui";
import {
  Button,
  Checkbox,
  StyledSelect,
  Text,
  useTranslations,
  type StyledSelectOption,
} from "@th/ui";
import { AlertTriangle, ArrowLeft, ArrowRight, Eye } from "lucide-react";

import type {
  CsvColumnMapping,
  CsvImportFieldDef,
  ParsedCsvRow,
} from "@/lib/csv-import";

interface CsvMappingStepProps {
  fileName: string;
  parsedRows: ParsedCsvRow[];
  mappings: CsvColumnMapping[];
  hasHeader: boolean;
  previewColumn: string | null;
  targetFieldOptions: StyledSelectOption<string>[];
  columnPreviewSamples: string[];
  missingRequired: CsvImportFieldDef[];
  updateMapping: (index: number, targetField: string) => void;
  handleToggleHeader: (checked: boolean) => void;
  setPreviewColumn: (col: string) => void;
  onBack: () => void;
  onNext: () => void;
}

export function CsvMappingStep({
  fileName,
  parsedRows,
  mappings,
  hasHeader,
  previewColumn,
  targetFieldOptions,
  columnPreviewSamples,
  missingRequired,
  updateMapping,
  handleToggleHeader,
  setPreviewColumn,
  onBack,
  onNext,
}: CsvMappingStepProps) {
  const t = useTranslations();

  return (
    <YStack padding="$4" gap="$4">
      {/* Title + description */}
      <YStack gap="$1">
        <Text weight="bold">{String(t("admin.csvImportMapColumns"))}</Text>
        <Text fontSize="$2" tone="muted">
          {String(
            t("admin.csvImportMapDescription", {
              fileName,
              rowCount: parsedRows.length.toLocaleString(),
            }),
          )}
        </Text>
      </YStack>

      {/* Has-header checkbox */}
      <Checkbox
        label="First row contains column headers"
        checked={hasHeader}
        onCheckedChange={(val) => handleToggleHeader(val === true)}
        size="sm"
      />

      {/* Side-by-side: mapping table + column preview */}
      <XStack
        gap="$4"
        style={{ display: "flex" as never, alignItems: "stretch" as never }}
      >
        {/* LEFT: Mapping table — CSS grid for consistent widths */}
        <YStack style={{ flex: "1 1 0%" as never, minWidth: 0 as never }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 36px",
              borderWidth: 2,
              borderStyle: "solid",
              borderColor: "var(--borderColor)",
              borderRadius: 0,
              overflow: "hidden",
            }}
          >
            {/* Header row */}
            <div
              style={{
                gridColumn: "1 / -1",
                display: "grid",
                gridTemplateColumns: "1fr 1fr 36px",
                padding: "8px 12px",
                borderBottom: "2px solid var(--borderColor)",
                backgroundColor: "var(--surfaceMuted)",
              }}
            >
              <Text
                fontSize={11}
                weight="bold"
                style={{
                  textTransform: "uppercase",
                  letterSpacing: 0.8,
                }}
              >
                {String(t("admin.csvImportSourceColumn"))}
              </Text>
              <Text
                fontSize={11}
                weight="bold"
                style={{
                  textTransform: "uppercase",
                  letterSpacing: 0.8,
                }}
              >
                {String(t("admin.csvImportTargetField"))}
              </Text>
              <span />
            </div>

            {/* Data rows */}
            {mappings.map((m, idx) => (
              <div
                key={`${m.sourceHeader}-${idx}`}
                style={{
                  gridColumn: "1 / -1",
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr 36px",
                  alignItems: "center",
                  padding: "6px 12px",
                  borderBottom:
                    idx < mappings.length - 1
                      ? "1px solid var(--borderColor)"
                      : "none",
                  backgroundColor:
                    previewColumn === m.sourceHeader
                      ? "var(--surfaceMuted)"
                      : "transparent",
                  gap: 12,
                }}
              >
                {/* CSV column name */}
                <Text
                  fontSize="$2"
                  weight="medium"
                  style={{
                    fontFamily: "monospace",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {m.sourceHeader}
                </Text>

                {/* Target field dropdown */}
                <StyledSelect
                  value={m.targetField}
                  options={targetFieldOptions}
                  onChange={(val) => updateMapping(idx, val)}
                  size="sm"
                  fullWidth
                />

                {/* Preview eye button */}
                <XStack
                  width={36}
                  height={36}
                  alignItems="center"
                  justifyContent="center"
                  cursor="pointer"
                  borderWidth={1}
                  borderColor={
                    previewColumn === m.sourceHeader
                      ? "$brandSecondary"
                      : "$borderColor"
                  }
                  backgroundColor={
                    previewColumn === m.sourceHeader
                      ? "$brandSecondary"
                      : "transparent"
                  }
                  onPress={() => setPreviewColumn(m.sourceHeader)}
                  hoverStyle={{
                    backgroundColor:
                      previewColumn === m.sourceHeader
                        ? "$brandSecondary"
                        : "$surfaceMuted",
                  }}
                >
                  <Eye
                    size={14}
                    color={
                      previewColumn === m.sourceHeader
                        ? "var(--onBrandSecondary, #FFFFFF)"
                        : "var(--colorMuted, #5C544A)"
                    }
                  />
                </XStack>
              </div>
            ))}
          </div>
        </YStack>

        {/* RIGHT: Column data preview — sticky sidebar */}
        <YStack
          width={280}
          style={{ flexShrink: 0 as never }}
          borderWidth={2}
          borderColor="$borderColor"
          backgroundColor="$surfaceMuted"
        >
          {previewColumn && columnPreviewSamples.length > 0 ? (
            <YStack gap="$2" padding="$3">
              <XStack gap="$2" alignItems="center">
                <Eye size={14} color="var(--colorMuted)" />
                <Text
                  fontSize={11}
                  weight="bold"
                  style={{
                    textTransform: "uppercase",
                    letterSpacing: 0.8,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {previewColumn}
                </Text>
              </XStack>
              <Text fontSize={11} tone="muted">
                {`${Math.min(8, parsedRows.length)} of ${parsedRows.length.toLocaleString()} rows`}
              </Text>
              <YStack
                gap="$1"
                paddingTop="$2"
                borderTopWidth={1}
                borderTopColor="$borderColor"
              >
                {columnPreviewSamples.map((val, i) => (
                  <Text
                    key={i}
                    fontSize={12}
                    color={val ? "$color" : "$colorMuted"}
                    style={{
                      fontFamily: "monospace",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {val || "\u2014"}
                  </Text>
                ))}
              </YStack>
            </YStack>
          ) : (
            <YStack
              flex={1}
              alignItems="center"
              justifyContent="center"
              padding="$4"
              gap="$2"
            >
              <Eye size={20} color="var(--colorMuted)" />
              <Text
                fontSize={11}
                tone="muted"
                textAlign="center"
                style={{
                  textTransform: "uppercase",
                  letterSpacing: 0.8,
                }}
              >
                {String(t("admin.csvImportPreviewHint"))}
              </Text>
            </YStack>
          )}
        </YStack>
      </XStack>

      {/* Required field warning */}
      {missingRequired.length > 0 && (
        <XStack gap="$2" alignItems="center">
          <AlertTriangle size={16} color="var(--danger)" />
          <Text tone="error" fontSize="$2">
            {String(
              t("admin.csvImportMissingRequired", {
                fields: missingRequired.map((f) => f.label).join(", "),
              }),
            )}
          </Text>
        </XStack>
      )}

      {/* Navigation */}
      <XStack gap="$2" justifyContent="flex-end">
        <Button size="$2" variant="ghost" onPress={onBack}>
          <ArrowLeft size={14} />
          {String(t("admin.csvImportStartOver"))}
        </Button>
        <Button
          size="$2"
          onPress={onNext}
          disabled={missingRequired.length > 0}
        >
          {String(t("admin.csvImportContinue"))}
          <ArrowRight size={14} />
        </Button>
      </XStack>
    </YStack>
  );
}
