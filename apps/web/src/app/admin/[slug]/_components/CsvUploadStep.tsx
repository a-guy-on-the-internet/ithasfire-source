"use client";

import { useCallback, useRef, useState } from "react";
import { YStack, XStack } from "tamagui";
import { Button, Text, useTranslations } from "@th/ui";
import {
  Upload,
  CheckCircle,
  AlertTriangle,
  ArrowRight,
  ClipboardPaste,
} from "lucide-react";

interface CsvUploadStepProps {
  uploadMode: "file" | "paste";
  setUploadMode: (mode: "file" | "paste") => void;
  pasteText: string;
  handlePasteChange: (text: string) => void;
  pastePreview: {
    headers: string[];
    rowCount: number;
    error: string | null;
  } | null;
  handlePasteSubmit: () => void;
  handleFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onFileDrop?: (file: File) => void;
  description?: string;
}

export function CsvUploadStep({
  uploadMode,
  setUploadMode,
  pasteText,
  handlePasteChange,
  pastePreview,
  handlePasteSubmit,
  handleFileSelect,
  onFileDrop,
  description,
}: CsvUploadStepProps) {
  const t = useTranslations();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Only leave when actually exiting the container (not entering a child)
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file && onFileDrop) {
        onFileDrop(file);
      }
    },
    [onFileDrop],
  );

  return (
    <YStack padding="$4" gap="$4">
      {/* Mode toggle */}
      <XStack gap={0} borderWidth={2} borderColor="$borderColor">
        {(["file", "paste"] as const).map((mode) => (
          <XStack
            key={mode}
            flex={1}
            paddingVertical="$2"
            alignItems="center"
            justifyContent="center"
            gap="$2"
            backgroundColor={uploadMode === mode ? "$accent" : "transparent"}
            onPress={() => setUploadMode(mode)}
            cursor="pointer"
            borderRightWidth={mode === "file" ? 2 : 0}
            borderRightColor="$borderColor"
            hoverStyle={{
              backgroundColor:
                uploadMode === mode ? "$accent" : "$surfaceMuted",
            }}
          >
            {mode === "file" ? (
              <Upload
                size={14}
                color={
                  uploadMode === mode
                    ? "var(--onBrandSecondary, #FFFFFF)"
                    : "var(--colorMuted, #5C544A)"
                }
              />
            ) : (
              <ClipboardPaste
                size={14}
                color={
                  uploadMode === mode
                    ? "var(--onBrandSecondary, #FFFFFF)"
                    : "var(--colorMuted, #5C544A)"
                }
              />
            )}
            <Text
              fontSize={11}
              weight="bold"
              color={uploadMode === mode ? "$onBrandSecondary" : "$colorMuted"}
              style={{
                textTransform: "uppercase",
                letterSpacing: 0.8,
              }}
            >
              {String(
                mode === "file"
                  ? t("admin.csvImportModeFile")
                  : t("admin.csvImportModePaste"),
              )}
            </Text>
          </XStack>
        ))}
      </XStack>

      {/* File upload */}
      {uploadMode === "file" && (
        <div
          onDragOver={handleDragOver}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          style={{ width: "100%" }}
        >
          <YStack
            alignItems="center"
            justifyContent="center"
            padding="$8"
            gap="$4"
            borderWidth={2}
            borderColor={isDragOver ? "$brandSecondary" : "$borderColor"}
            borderStyle="dashed"
            backgroundColor={isDragOver ? "$surfaceMuted" : "transparent"}
            width="100%"
            minHeight={260}
            cursor="pointer"
            onPress={() => fileInputRef.current?.click()}
          >
            <Upload
              size={36}
              color={
                isDragOver ? "var(--brandSecondary)" : "var(--colorMuted)"
              }
            />
            <Text weight="bold" variant="h6">
              {String(t("admin.csvImportUploadTitle"))}
            </Text>
            <Text
              tone="muted"
              textAlign="center"
              fontSize="$2"
              maxWidth={340}
            >
              {description ?? String(t("admin.csvImportUploadDescription"))}
            </Text>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.tsv,.txt"
              onChange={handleFileSelect}
              style={{ display: "none" }}
            />
            <Button
              size="$3"
              variant="primary"
              onPress={(e) => {
                e.stopPropagation();
                fileInputRef.current?.click();
              }}
            >
              {String(t("admin.csvImportChooseFile"))}
            </Button>
            <Text tone="muted" fontSize={11}>
              {String(t("admin.csvImportDragHint"))}
            </Text>
          </YStack>
        </div>
      )}

      {/* Paste text */}
      {uploadMode === "paste" && (
        <YStack gap="$3">
          <Text fontSize="$2" tone="muted">
            {String(t("admin.csvImportPasteDescription"))}
          </Text>

          <textarea
            id="csv-paste-area"
            value={pasteText}
            onChange={(e) => handlePasteChange(e.target.value)}
            placeholder={String(t("admin.csvImportPastePlaceholder"))}
            rows={8}
            spellCheck={false}
            style={{
              width: "100%",
              padding: 12,
              border: "2px solid var(--borderColor)",
              background: "var(--surfaceMuted)",
              color: "var(--color)",
              fontFamily: "monospace",
              fontSize: 12,
              // Numbers are pixels on a Tamagui component — see DashboardContent.
					lineHeight: "1.5em",
              resize: "vertical",
              borderRadius: 0,
            }}
            onFocus={(e) => {
              (e.target as HTMLTextAreaElement).style.borderColor =
                "var(--brandSecondary)";
            }}
            onBlur={(e) => {
              (e.target as HTMLTextAreaElement).style.borderColor =
                "var(--borderColor)";
            }}
          />

          {/* Live preview */}
          {pastePreview && (
            <YStack
              gap="$2"
              padding="$3"
              borderWidth={2}
              borderColor={pastePreview.error ? "$danger" : "$accent"}
              backgroundColor={
                pastePreview.error ? "transparent" : "$surfaceMuted"
              }
            >
              {pastePreview.error ? (
                <XStack gap="$2" alignItems="center">
                  <AlertTriangle size={14} color="var(--danger)" />
                  <Text tone="error" fontSize="$2">
                    {pastePreview.error}
                  </Text>
                </XStack>
              ) : (
                <YStack gap="$2">
                  <XStack gap="$3" alignItems="center">
                    <XStack gap="$1" alignItems="center">
                      <CheckCircle size={14} color="var(--success)" />
                      <Text fontSize="$2" weight="bold" tone="success">
                        {String(t("admin.csvImportPasteValid"))}
                      </Text>
                    </XStack>
                    <Text fontSize="$2" tone="muted">
                      {String(
                        t("admin.csvImportPasteStats", {
                          columns: pastePreview.headers.length.toLocaleString(),
                          rows: pastePreview.rowCount.toLocaleString(),
                        }),
                      )}
                    </Text>
                  </XStack>
                  <XStack gap="$1" flexWrap="wrap">
                    {pastePreview.headers.map((h) => (
                      <XStack
                        key={h}
                        paddingHorizontal="$2"
                        paddingVertical={2}
                        borderWidth={1}
                        borderColor="$accent"
                        backgroundColor="$surface"
                      >
                        <Text
                          fontSize={11}
                          weight="medium"
                          tone="accent"
                          style={{
                            fontFamily: "monospace",
                          }}
                        >
                          {h}
                        </Text>
                      </XStack>
                    ))}
                  </XStack>
                </YStack>
              )}
            </YStack>
          )}

          {/* Actions */}
          <XStack justifyContent="flex-end" gap="$2">
            {pasteText.trim() && (
              <Button
                size="$2"
                variant="ghost"
                onPress={() => {
                  handlePasteChange("");
                }}
              >
                {String(t("admin.csvImportPasteClear"))}
              </Button>
            )}
            <Button
              size="$2"
              variant="primary"
              onPress={handlePasteSubmit}
              disabled={
                pastePreview?.error !== null ||
                pastePreview.headers.length === 0
              }
            >
              {String(t("admin.csvImportContinue"))}
              <ArrowRight size={14} />
            </Button>
          </XStack>
        </YStack>
      )}
    </YStack>
  );
}
