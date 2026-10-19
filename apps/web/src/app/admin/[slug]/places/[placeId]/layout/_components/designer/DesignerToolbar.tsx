"use client";

// ─────────────────────────────────────────────────────────────────────────────
// DesignerToolbar — tool palette + section list + row/seat controls + save
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useRef, useState } from "react";
import { YStack, XStack, Stack } from "tamagui";
import {
  Text,
  Button,
  TextInput,
  Badge,
  Tooltip,
  Spinner,
  useTranslations,
} from "@th/ui";
import {
  MousePointer2,
  Hand,
  Pentagon,
  CircleDot,
  Circle,
  Eraser,
  ZoomIn,
  ZoomOut,
  Maximize,
  Upload,
  Download,
  Trash2,
  Image as ImageIcon,
  Undo2,
  Redo2,
  Save,
  X,
  Pencil,
  Minus,
  Spline,
  Grid3X3,
  ScanSearch,
  Square,
  PenTool,
  ChevronDown,
  ChevronRight,
  ArrowUp,
  ArrowDown,
  Magnet,
  Link2,
} from "lucide-react";

import type { DesignerState, DesignerAction, DesignerTool } from "./types";
import {
  designerStateToCsv,
  csvToDesignerState,
  downloadCsv,
  readFileAsText,
} from "./csv-bridge";
import { findSharedBoundaryEdges } from "./reducer";
import { shortcutHint } from "@/lib/platform";

// ── NumericInput — TextInput with arrow key increment/decrement ──────────

type NumericInputProps = {
  value: string;
  onChangeText: (val: string) => void;
  step?: number;
  min?: number;
  max?: number;
  allowFloat?: boolean;
  size?: string;
  width?: number;
  flex?: number;
  "aria-label"?: string;
};

function NumericInput({
  value,
  onChangeText,
  step = 1,
  min,
  max,
  allowFloat = false,
  ...rest
}: NumericInputProps) {
  const handleKeyDown = useCallback(
    (e: { nativeEvent: { key: string }; preventDefault?: () => void }) => {
      const key = e.nativeEvent.key;
      if (key !== "ArrowUp" && key !== "ArrowDown") return;
      e.preventDefault?.();
      const current = allowFloat ? parseFloat(value) : parseInt(value, 10);
      if (!Number.isFinite(current)) return;
      const delta = key === "ArrowUp" ? step : -step;
      let next = allowFloat
        ? Math.round((current + delta) * 1000) / 1000
        : current + delta;
      if (min !== undefined) next = Math.max(min, next);
      if (max !== undefined) next = Math.min(max, next);
      onChangeText(String(next));
    },
    [value, onChangeText, step, min, max, allowFloat],
  );

  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      onKeyPress={handleKeyDown}
      {...rest}
    />
  );
}

// ── SectionMetadataEditor — key/value pairs on a section ─────────────────

function SectionMetadataEditor({
  sectionId,
  metadata,
  dispatch,
}: {
  sectionId: string;
  metadata?: Record<string, string>;
  dispatch: React.Dispatch<DesignerAction>;
}) {
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");

  const entries = Object.entries(metadata ?? {});

  const addEntry = useCallback(() => {
    const k = newKey.trim();
    if (!k) return;
    dispatch({
      type: "SET_SECTION_METADATA",
      sectionId,
      key: k,
      value: newVal,
    });
    setNewKey("");
    setNewVal("");
  }, [dispatch, sectionId, newKey, newVal]);

  return (
    <YStack gap="$1" paddingLeft="$3" paddingRight="$4" paddingVertical="$1">
      <Text variant="caption" weight="bold" tone="muted">
        Metadata
      </Text>
      {entries.map(([key, val]) => (
        <XStack key={key} gap="$1" alignItems="center">
          <Text variant="caption" style={{ minWidth: 60 }}>
            {key}
          </Text>
          <TextInput
            size="$1"
            flex={1}
            value={val}
            onChangeText={(v: string) =>
              dispatch({
                type: "SET_SECTION_METADATA",
                sectionId,
                key,
                value: v,
              })
            }
            aria-label={`Metadata value for ${key}`}
          />
          <Button
            variant="ghost"
            size="$1"
            icon
            onPress={() =>
              dispatch({ type: "DELETE_SECTION_METADATA", sectionId, key })
            }
            aria-label={`Remove ${key}`}
          >
            <X size={10} />
          </Button>
        </XStack>
      ))}
      <XStack gap="$1" alignItems="center">
        <TextInput
          size="$1"
          placeholder="key"
          value={newKey}
          onChangeText={setNewKey}
          flex={1}
          aria-label="New metadata key"
          onKeyPress={(e: { nativeEvent: { key: string } }) => {
            if (e.nativeEvent.key === "Enter") addEntry();
          }}
        />
        <TextInput
          size="$1"
          placeholder="value"
          value={newVal}
          onChangeText={setNewVal}
          flex={1}
          aria-label="New metadata value"
          onKeyPress={(e: { nativeEvent: { key: string } }) => {
            if (e.nativeEvent.key === "Enter") addEntry();
          }}
        />
        <Button
          variant="ghost"
          size="$1"
          disabled={!newKey.trim()}
          onPress={addEntry}
          aria-label="Add metadata entry"
        >
          <Text variant="caption">+</Text>
        </Button>
      </XStack>
    </YStack>
  );
}

// ── Tool config ──────────────────────────────────────────────────────────

type ToolEntry = {
  tool: DesignerTool;
  label: string;
  Icon: typeof MousePointer2;
  shortcut?: string;
};

const GENERAL_TOOLS: ToolEntry[] = [
  { tool: "select", label: "Select", Icon: MousePointer2, shortcut: "V" },
  { tool: "pan", label: "Pan", Icon: Hand, shortcut: "H" },
];

const SECTION_TOOLS: ToolEntry[] = [
  {
    tool: "draw_section",
    label: "Polygon Section",
    Icon: Pentagon,
    shortcut: "S",
  },
  {
    tool: "draw_box_section",
    label: "Box Section",
    Icon: Square,
    shortcut: "B",
  },
  {
    tool: "draw_circle_section",
    label: "Circle Section",
    Icon: Circle,
    shortcut: "O",
  },
  { tool: "draw_stroke", label: "Stroke", Icon: PenTool, shortcut: "K" },
];

const SEAT_TOOLS: ToolEntry[] = [
  { tool: "place_seat", label: "Single Seat", Icon: CircleDot, shortcut: "P" },
  { tool: "place_line", label: "Line of Seats", Icon: Minus, shortcut: "L" },
  { tool: "place_arc", label: "Arc of Seats", Icon: Spline, shortcut: "A" },
  { tool: "place_grid", label: "Grid of Seats", Icon: Grid3X3, shortcut: "G" },
];

const OTHER_TOOLS: ToolEntry[] = [
  { tool: "erase", label: "Erase", Icon: Eraser, shortcut: "E" },
];

/** Flat list for keyboard-shortcut lookup */
const ALL_TOOLS: ToolEntry[] = [
  ...GENERAL_TOOLS,
  ...SECTION_TOOLS,
  ...SEAT_TOOLS,
  ...OTHER_TOOLS,
];

const PALETTE = [
  "#4A90D2",
  "#E74C3C",
  "#2ECC71",
  "#F39C12",
  "#9B59B6",
  "#1ABC9C",
  "#E67E22",
  "#3498DB",
  "#E91E63",
  "#00BCD4",
  "#8BC34A",
  "#FF5722",
  "#607D8B",
  "#795548",
  "#CDDC39",
];

// ── Props ────────────────────────────────────────────────────────────────

type DesignerToolbarProps = {
  state: DesignerState;
  dispatch: React.Dispatch<DesignerAction>;
  nextSectionColor: string;
  onNextSectionColorChange: (color: string) => void;
  controls: {
    zoomIn: () => void;
    zoomOut: () => void;
    fitToContent: () => void;
  };
  onLoadImage: (file: File) => void | Promise<void>;
  onSave: () => void;
  isSaving: boolean;
  onDetect: () => void;
  isDetecting: boolean;
};

// ── Component ────────────────────────────────────────────────────────────

export function DesignerToolbar({
  state,
  dispatch,
  nextSectionColor,
  onNextSectionColorChange,
  controls,
  onLoadImage,
  onSave,
  isSaving,
  onDetect,
  isDetecting,
}: DesignerToolbarProps) {
  const csvInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const t = useTranslations();

  // Inline section rename tracking
  const [renamingSectionId, setRenamingSectionId] = useState<string | null>(
    null,
  );
  const [renameValue, setRenameValue] = useState("");

  // Collapsible section seat lists
  const [expandedSectionIds, setExpandedSectionIds] = useState<Set<string>>(
    new Set(),
  );

  // Place seats along stroke
  const [strokeSeatCount, setStrokeSeatCount] = useState(10);

  const toggleSectionExpanded = useCallback((sectionId: string) => {
    setExpandedSectionIds((prev) => {
      const next = new Set(prev);
      if (next.has(sectionId)) {
        next.delete(sectionId);
      } else {
        next.add(sectionId);
      }
      return next;
    });
  }, []);

  // ── CSV import / export ────────────────────────────────────────────────

  const handleExportCsv = useCallback(() => {
    const csv = designerStateToCsv({
      sections: state.sections,
      seats: state.seats,
      stage: state.stage,
      image: state.image,
    });
    downloadCsv(csv, `layout-${Date.now()}.csv`);
  }, [state]);

  const handleImportCsv = useCallback(
    async (file: File) => {
      try {
        const text = await readFileAsText(file);
        const result = csvToDesignerState(text);
        dispatch({
          type: "LOAD_STATE",
          sections: result.sections,
          seats: result.seats,
          stage: result.stage,
        });
        if (result.warnings.length > 0) {
          console.warn("CSV import warnings:", result.warnings);
        }
      } catch (err) {
        console.error("CSV import failed:", err);
      }
    },
    [dispatch],
  );

  const handleCsvImportClick = useCallback(() => {
    csvInputRef.current?.click();
  }, []);

  const handleCsvFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void handleImportCsv(file);
      if (csvInputRef.current) csvInputRef.current.value = "";
    },
    [handleImportCsv],
  );

  // ── Image import ──────────────────────────────────────────────────────

  const handleImageImportClick = useCallback(() => {
    imageInputRef.current?.click();
  }, []);

  const handleImageFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) void onLoadImage(file);
      if (imageInputRef.current) imageInputRef.current.value = "";
    },
    [onLoadImage],
  );

  // ── Actions ────────────────────────────────────────────────────────────

  const handleClearAll = useCallback(() => {
    dispatch({ type: "CLEAR_ALL" });
  }, [dispatch]);

  const handleDeleteSelected = useCallback(() => {
    dispatch({ type: "DELETE_SELECTED" });
  }, [dispatch]);

  const handleUndo = useCallback(() => {
    dispatch({ type: "UNDO" });
  }, [dispatch]);

  const handleRedo = useCallback(() => {
    dispatch({ type: "REDO" });
  }, [dispatch]);

  // ── Row controls ───────────────────────────────────────────────────────

  const handleRowChange = useCallback(
    (val: string) => {
      dispatch({ type: "SET_CURRENT_ROW", row: val || "A" });
    },
    [dispatch],
  );

  const handleSeatNumberChange = useCallback(
    (val: string) => {
      const n = parseInt(val, 10);
      if (val !== "" && Number.isFinite(n) && n > 0) {
        dispatch({ type: "SET_NEXT_SEAT_NUMBER", num: n });
      }
    },
    [dispatch],
  );

  const handleRadiusChange = useCallback(
    (val: string) => {
      const n = Number(val);
      if (val !== "" && Number.isFinite(n) && n > 0) {
        dispatch({ type: "SET_DEFAULT_SEAT_RADIUS", radius: n });
      }
    },
    [dispatch],
  );

  // ── Batch placement controls ───────────────────────────────────────────

  const handleBatchCountChange = useCallback(
    (val: string) => {
      const n = parseInt(val, 10);
      if (val !== "" && Number.isFinite(n) && n >= 1) {
        dispatch({ type: "SET_BATCH_COUNT", count: n });
      }
    },
    [dispatch],
  );

  const handleBatchGridRowsChange = useCallback(
    (val: string) => {
      const n = parseInt(val, 10);
      if (val !== "" && Number.isFinite(n) && n > 0) {
        dispatch({ type: "SET_BATCH_GRID_ROWS", rows: n });
      }
    },
    [dispatch],
  );

  const handleBatchSpacingChange = useCallback(
    (val: string) => {
      const n = Number(val);
      if (val !== "" && Number.isFinite(n) && n >= 0) {
        dispatch({ type: "SET_BATCH_SPACING", spacing: n });
      }
    },
    [dispatch],
  );

  const handleBatchSpacingXChange = useCallback(
    (val: string) => {
      const n = Number(val);
      if (val !== "" && Number.isFinite(n) && n >= 0) {
        dispatch({ type: "SET_BATCH_SPACING_X", spacing: n });
      }
    },
    [dispatch],
  );

  const handleBatchSpacingYChange = useCallback(
    (val: string) => {
      const n = Number(val);
      if (val !== "" && Number.isFinite(n) && n >= 0) {
        dispatch({ type: "SET_BATCH_SPACING_Y", spacing: n });
      }
    },
    [dispatch],
  );

  // ── Section rename ────────────────────────────────────────────────────

  const startRename = useCallback((sectionId: string, currentLabel: string) => {
    setRenamingSectionId(sectionId);
    setRenameValue(currentLabel);
  }, []);

  const commitRename = useCallback(() => {
    if (renamingSectionId && renameValue.trim()) {
      dispatch({
        type: "UPDATE_SECTION_LABEL",
        sectionId: renamingSectionId,
        label: renameValue.trim(),
      });
    }
    setRenamingSectionId(null);
    setRenameValue("");
  }, [renamingSectionId, renameValue, dispatch]);

  // ── Render ─────────────────────────────────────────────────────────────

  const hasSelection =
    state.selectedSeatIds.size > 0 ||
    state.selectedSectionIds.size > 0 ||
    state.selectedStrokeIds.size > 0;

  // Build seat number list for the current row in the active section
  const activeSectionSeats = state.activeSectionId
    ? state.seats.filter(
        (s) =>
          s.sectionId === state.activeSectionId && s.row === state.currentRow,
      )
    : [];

  return (
    <YStack
      gap="$3"
      padding="$3"
      borderRightWidth={1}
      borderColor="$borderColor"
      backgroundColor="$surface"
      width={260}
      overflow="scroll"
      data-testid="designer-toolbar"
    >
      {/* Hidden file inputs */}
      <input
        ref={csvInputRef}
        type="file"
        accept=".csv,text/csv"
        style={{ display: "none" }}
        onChange={handleCsvFileChange}
      />
      <input
        ref={imageInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/heic,image/heif,.heic,.heif"
        style={{ display: "none" }}
        onChange={handleImageFileChange}
      />

      {/* Layout name */}
      <YStack gap="$2">
        <Text variant="caption" weight="bold" tone="muted">
          {String(t("admin.toolbarLayoutName"))}
        </Text>
        <TextInput
          size="$2"
          value={state.layoutName}
          onChangeText={(val: string) =>
            dispatch({ type: "SET_LAYOUT_NAME", name: val })
          }
          placeholder={t("admin.toolbarLayoutNamePlaceholder") as string}
          aria-label={t("admin.toolbarLayoutName") as string}
          data-testid="designer-layout-name"
        />
      </YStack>

      {/* Tool palette */}
      <YStack gap="$2">
        <XStack gap="$1" flexWrap="wrap">
          {GENERAL_TOOLS.map(({ tool, label, Icon, shortcut }) => (
            <Tooltip
              key={tool}
              anchor={
                <Button
                  variant={state.activeTool === tool ? "primary" : "ghost"}
                  size="$2"
                  icon
                  onPress={() => dispatch({ type: "SET_TOOL", tool })}
                  aria-label={label}
                  aria-pressed={state.activeTool === tool}
                >
                  <Icon size={16} />
                </Button>
              }
              placement="bottom"
            >
              {label}
              {shortcut ? ` (${shortcut})` : ""}
            </Tooltip>
          ))}
        </XStack>

        <Text variant="caption" weight="bold" tone="muted">
          {String(t("admin.toolbarSections"))}
        </Text>
        <XStack gap="$1" flexWrap="wrap">
          {SECTION_TOOLS.map(({ tool, label, Icon, shortcut }) => (
            <Tooltip
              key={tool}
              anchor={
                <Button
                  variant={state.activeTool === tool ? "primary" : "ghost"}
                  size="$2"
                  icon
                  onPress={() => dispatch({ type: "SET_TOOL", tool })}
                  aria-label={label}
                  aria-pressed={state.activeTool === tool}
                >
                  <Icon size={16} />
                </Button>
              }
              placement="bottom"
            >
              {label}
              {shortcut ? ` (${shortcut})` : ""}
            </Tooltip>
          ))}
        </XStack>

        <Text variant="caption" weight="bold" tone="muted">
          {String(t("admin.toolbarSeats"))}
        </Text>
        <XStack gap="$1" flexWrap="wrap">
          {SEAT_TOOLS.map(({ tool, label, Icon, shortcut }) => (
            <Tooltip
              key={tool}
              anchor={
                <Button
                  variant={state.activeTool === tool ? "primary" : "ghost"}
                  size="$2"
                  icon
                  onPress={() => dispatch({ type: "SET_TOOL", tool })}
                  aria-label={label}
                  aria-pressed={state.activeTool === tool}
                >
                  <Icon size={16} />
                </Button>
              }
              placement="bottom"
            >
              {label}
              {shortcut ? ` (${shortcut})` : ""}
            </Tooltip>
          ))}
        </XStack>

        <XStack gap="$1" flexWrap="wrap">
          {OTHER_TOOLS.map(({ tool, label, Icon, shortcut }) => (
            <Tooltip
              key={tool}
              anchor={
                <Button
                  variant={state.activeTool === tool ? "primary" : "ghost"}
                  size="$2"
                  icon
                  onPress={() => dispatch({ type: "SET_TOOL", tool })}
                  aria-label={label}
                  aria-pressed={state.activeTool === tool}
                >
                  <Icon size={16} />
                </Button>
              }
              placement="bottom"
            >
              {label}
              {shortcut ? ` (${shortcut})` : ""}
            </Tooltip>
          ))}
        </XStack>
      </YStack>

      {/* View controls */}
      <YStack gap="$2">
        <Text variant="caption" weight="bold" tone="muted">
          {String(t("admin.toolbarView"))}
        </Text>
        <XStack gap="$1">
          <Tooltip
            anchor={
              <Button
                variant="ghost"
                size="$2"
                icon
                onPress={controls.zoomIn}
                aria-label={t("admin.toolbarZoomIn") as string}
              >
                <ZoomIn size={16} />
              </Button>
            }
            placement="bottom"
          >
            {String(t("admin.toolbarZoomIn"))}
          </Tooltip>
          <Tooltip
            anchor={
              <Button
                variant="ghost"
                size="$2"
                icon
                onPress={controls.zoomOut}
                aria-label={t("admin.toolbarZoomOut") as string}
              >
                <ZoomOut size={16} />
              </Button>
            }
            placement="bottom"
          >
            {String(t("admin.toolbarZoomOut"))}
          </Tooltip>
          <Tooltip
            anchor={
              <Button
                variant="ghost"
                size="$2"
                icon
                onPress={controls.fitToContent}
                aria-label={t("admin.toolbarFitToView") as string}
              >
                <Maximize size={16} />
              </Button>
            }
            placement="bottom"
          >
            {String(t("admin.toolbarFitToView"))}
          </Tooltip>
          <Tooltip
            anchor={
              <Button
                variant={state.vertexSnapEnabled ? "primary" : "ghost"}
                size="$2"
                icon
                onPress={() => dispatch({ type: "TOGGLE_VERTEX_SNAP" })}
                aria-label="Vertex Snap"
                aria-pressed={state.vertexSnapEnabled}
              >
                <Magnet size={16} />
              </Button>
            }
            placement="bottom"
          >
            Vertex Snap {state.vertexSnapEnabled ? "(On)" : "(Off)"} — Hold Alt
            to temporarily disable
          </Tooltip>
        </XStack>
      </YStack>

      {/* Section drawing controls */}
      {state.activeTool === "draw_section" && (
        <YStack
          gap="$2"
          padding="$3"
          borderWidth={2}
          borderColor="$borderColor"
          borderRadius={0}
        >
          <Text variant="caption" weight="bold" tone="muted">
            {String(t("admin.toolbarSectionDrawing"))}
          </Text>

          {/* Section kind toggle */}
          <XStack gap="$2" alignItems="center">
            <Text variant="caption" flex={1}>
              {String(t("admin.toolbarKind"))}
            </Text>
            <XStack gap="$1">
              {(["seat", "ga", "helper"] as const).map((k) => (
                <Button
                  key={k}
                  variant={state.drawingSectionKind === k ? "primary" : "ghost"}
                  size="$2"
                  onPress={() =>
                    dispatch({
                      type: "SET_DRAWING_SECTION_KIND",
                      sectionKind: k,
                    })
                  }
                  aria-label={`Section kind: ${k}`}
                  aria-pressed={state.drawingSectionKind === k}
                >
                  <Text variant="caption" tone="inherit">
                    {k === "seat"
                      ? String(t("admin.toolbarKindSeat"))
                      : k === "ga"
                        ? String(t("admin.toolbarKindGa"))
                        : String(t("admin.toolbarKindHelper"))}
                  </Text>
                </Button>
              ))}
            </XStack>
          </XStack>

          {/* Color palette */}
          <Text variant="caption" weight="bold" tone="muted">
            {String(t("admin.toolbarColor"))}
          </Text>
          <XStack gap="$1" flexWrap="wrap">
            {PALETTE.map((color) => (
              <button
                key={color}
                onClick={() => onNextSectionColorChange(color)}
                aria-label={`Color ${color}`}
                aria-pressed={nextSectionColor === color}
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 0,
                  backgroundColor: color,
                  border:
                    nextSectionColor === color
                      ? "2px solid #000"
                      : "1px solid #ccc",
                  cursor: "pointer",
                  padding: 0,
                }}
              />
            ))}
          </XStack>
          {state.drawingPolygon.length > 0 && (
            <Text variant="caption" tone="muted">
              {String(
                t("admin.toolbarVerticesHint", {
                  count: state.drawingPolygon.length,
                }),
              )}
            </Text>
          )}
        </YStack>
      )}

      {/* Seat placement controls */}
      {state.activeTool === "place_seat" && (
        <YStack
          gap="$2"
          padding="$3"
          borderWidth={2}
          borderColor="$borderColor"
          borderRadius={0}
        >
          <Text variant="caption" weight="bold" tone="muted">
            {String(t("admin.toolbarSeatPlacement"))}
          </Text>
          <XStack gap="$2" alignItems="center">
            <Text variant="caption" flex={1}>
              {String(t("admin.toolbarRow"))}
            </Text>
            <TextInput
              size="$2"
              value={state.currentRow}
              onChangeText={handleRowChange}
              width={60}
              aria-label={t("admin.toolbarRow") as string}
            />
          </XStack>
          <XStack gap="$2" alignItems="center">
            <Text variant="caption" flex={1}>
              {String(t("admin.toolbarNextNum"))}
            </Text>
            <NumericInput
              size="$2"
              value={String(state.nextSeatNumber)}
              onChangeText={handleSeatNumberChange}
              width={60}
              min={1}
              aria-label={t("admin.toolbarNextNum") as string}
            />
          </XStack>
          <XStack gap="$2" alignItems="center">
            <Text variant="caption" flex={1}>
              {String(t("admin.toolbarSeatRadius"))}
            </Text>
            <NumericInput
              size="$2"
              value={String(state.defaultSeatRadius)}
              onChangeText={handleRadiusChange}
              width={60}
              min={1}
              step={1}
              allowFloat
              aria-label={t("admin.toolbarSeatRadius") as string}
            />
          </XStack>

          {/* Seat number dropdown */}
          {activeSectionSeats.length > 0 && (
            <YStack gap="$1">
              <Text variant="caption" weight="bold" tone="muted">
                {String(
                  t("admin.toolbarPlacedInRow", { row: state.currentRow }),
                )}
              </Text>
              <select
                style={{
                  fontSize: 12,
                  padding: "4px 6px",
                  borderRadius: 0,
                  border: "1px solid #ccc",
                  width: "100%",
                }}
                value=""
                onChange={(e) => {
                  const seatId = e.target.value;
                  if (seatId) {
                    dispatch({ type: "SELECT_SEAT", seatId, additive: false });
                  }
                }}
                aria-label={t("admin.toolbarSelectASeat") as string}
              >
                <option value="">
                  {String(t("admin.toolbarSelectASeat"))}
                </option>
                {activeSectionSeats.map((seat) => (
                  <option key={seat.id} value={seat.id}>
                    {seat.row}
                    {seat.seat} ({seat.position.x.toFixed(1)},{" "}
                    {seat.position.y.toFixed(1)})
                  </option>
                ))}
              </select>
            </YStack>
          )}

          {!state.activeSectionId && (
            <Text variant="caption" tone="error">
              {String(t("admin.toolbarSelectSectionFirst"))}
            </Text>
          )}
        </YStack>
      )}

      {/* Batch placement controls (Line / Arc / Grid) */}
      {(state.activeTool === "place_line" ||
        state.activeTool === "place_arc" ||
        state.activeTool === "place_grid") && (
        <YStack
          gap="$2"
          padding="$3"
          borderWidth={2}
          borderColor="$borderColor"
          borderRadius={0}
        >
          <Text variant="caption" weight="bold" tone="muted">
            {state.activeTool === "place_line"
              ? String(t("admin.toolbarLinePlacement"))
              : state.activeTool === "place_arc"
                ? String(t("admin.toolbarArcPlacement"))
                : String(t("admin.toolbarGridPlacement"))}
          </Text>

          <XStack gap="$2" alignItems="center">
            <Text variant="caption" flex={1}>
              {String(t("admin.toolbarRow"))}
            </Text>
            <TextInput
              size="$2"
              value={state.currentRow}
              onChangeText={handleRowChange}
              width={60}
              aria-label={t("admin.toolbarRow") as string}
            />
          </XStack>
          <XStack gap="$2" alignItems="center">
            <Text variant="caption" flex={1}>
              {String(t("admin.toolbarNextNum"))}
            </Text>
            <NumericInput
              size="$2"
              value={String(state.nextSeatNumber)}
              onChangeText={handleSeatNumberChange}
              width={60}
              min={1}
              aria-label={t("admin.toolbarNextNum") as string}
            />
          </XStack>
          <XStack gap="$2" alignItems="center">
            <Text variant="caption" flex={1}>
              {String(t("admin.toolbarSeatRadius"))}
            </Text>
            <NumericInput
              size="$2"
              value={String(state.defaultSeatRadius)}
              onChangeText={handleRadiusChange}
              width={60}
              min={1}
              step={1}
              allowFloat
              aria-label={t("admin.toolbarSeatRadius") as string}
            />
          </XStack>
          <XStack gap="$2" alignItems="center">
            <Text variant="caption" flex={1}>
              {state.activeTool === "place_grid"
                ? String(t("admin.toolbarCols"))
                : String(t("admin.toolbarCount"))}
            </Text>
            <NumericInput
              size="$2"
              value={String(state.batchCount)}
              onChangeText={handleBatchCountChange}
              width={60}
              min={1}
              aria-label={
                state.activeTool === "place_grid"
                  ? (t("admin.toolbarCols") as string)
                  : (t("admin.toolbarCount") as string)
              }
            />
          </XStack>
          {state.activeTool === "place_grid" && (
            <XStack gap="$2" alignItems="center">
              <Text variant="caption" flex={1}>
                {String(t("admin.toolbarRows"))}
              </Text>
              <NumericInput
                size="$2"
                value={String(state.batchGridRows)}
                onChangeText={handleBatchGridRowsChange}
                width={60}
                min={1}
                aria-label={t("admin.toolbarRows") as string}
              />
            </XStack>
          )}
          <XStack gap="$2" alignItems="center">
            <Text variant="caption" flex={1}>
              {state.activeTool === "place_grid"
                ? String(t("admin.toolbarGapX"))
                : String(t("admin.toolbarGap"))}
            </Text>
            <NumericInput
              size="$2"
              value={
                state.activeTool === "place_grid"
                  ? String(state.batchSpacingX)
                  : String(state.batchSpacing)
              }
              onChangeText={
                state.activeTool === "place_grid"
                  ? handleBatchSpacingXChange
                  : handleBatchSpacingChange
              }
              width={60}
              min={0}
              step={1}
              allowFloat
              aria-label={
                state.activeTool === "place_grid"
                  ? (t("admin.toolbarGapX") as string)
                  : (t("admin.toolbarGap") as string)
              }
            />
          </XStack>
          {state.activeTool === "place_grid" && (
            <XStack gap="$2" alignItems="center">
              <Text variant="caption" flex={1}>
                {String(t("admin.toolbarGapY"))}
              </Text>
              <NumericInput
                size="$2"
                value={String(state.batchSpacingY)}
                onChangeText={handleBatchSpacingYChange}
                width={60}
                min={0}
                step={1}
                allowFloat
                aria-label={t("admin.toolbarGapY") as string}
              />
            </XStack>
          )}
          <Text variant="caption" tone="muted">
            {state.activeTool === "place_grid"
              ? String(t("admin.toolbarGridGapHint"))
              : String(t("admin.toolbarLineGapHint"))}
          </Text>

          <Text variant="caption" tone="muted">
            {state.activeTool === "place_line"
              ? String(t("admin.toolbarLineInstructions"))
              : state.activeTool === "place_arc"
                ? String(t("admin.toolbarArcInstructions"))
                : String(t("admin.toolbarGridInstructions"))}
          </Text>

          {!state.activeSectionId && (
            <Text variant="caption" tone="error">
              {String(t("admin.toolbarSelectSectionFirst"))}
            </Text>
          )}
        </YStack>
      )}

      {/* Box section controls */}
      {state.activeTool === "draw_box_section" && (
        <YStack
          gap="$2"
          padding="$3"
          borderWidth={2}
          borderColor="$borderColor"
          borderRadius={0}
        >
          <Text variant="caption" weight="bold" tone="muted">
            {String(t("admin.toolbarBoxSection"))}
          </Text>

          {/* Section kind toggle */}
          <XStack gap="$2" alignItems="center">
            <Text variant="caption" flex={1}>
              {String(t("admin.toolbarKind"))}
            </Text>
            <XStack gap="$1">
              {(["seat", "ga", "helper"] as const).map((k) => (
                <Button
                  key={k}
                  variant={state.drawingSectionKind === k ? "primary" : "ghost"}
                  size="$2"
                  onPress={() =>
                    dispatch({
                      type: "SET_DRAWING_SECTION_KIND",
                      sectionKind: k,
                    })
                  }
                  aria-label={`Section kind: ${k}`}
                  aria-pressed={state.drawingSectionKind === k}
                >
                  <Text variant="caption" tone="inherit">
                    {k === "seat"
                      ? String(t("admin.toolbarKindSeat"))
                      : k === "ga"
                        ? String(t("admin.toolbarKindGa"))
                        : String(t("admin.toolbarKindHelper"))}
                  </Text>
                </Button>
              ))}
            </XStack>
          </XStack>

          {/* Color palette */}
          <Text variant="caption" weight="bold" tone="muted">
            {String(t("admin.toolbarColor"))}
          </Text>
          <XStack gap="$1" flexWrap="wrap">
            {PALETTE.map((color) => (
              <button
                key={color}
                onClick={() => onNextSectionColorChange(color)}
                aria-label={`Color ${color}`}
                aria-pressed={nextSectionColor === color}
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 0,
                  backgroundColor: color,
                  border:
                    nextSectionColor === color
                      ? "2px solid #000"
                      : "1px solid #ccc",
                  cursor: "pointer",
                  padding: 0,
                }}
              />
            ))}
          </XStack>

          <Text variant="caption" tone="muted">
            {String(t("admin.toolbarBoxSectionHint"))}
          </Text>
        </YStack>
      )}

      {/* Stroke tool controls */}
      {state.activeTool === "draw_stroke" && (
        <YStack
          gap="$2"
          padding="$3"
          borderWidth={2}
          borderColor="$borderColor"
          borderRadius={0}
        >
          <Text variant="caption" weight="bold" tone="muted">
            {String(t("admin.toolbarStroke"))}
          </Text>

          <XStack gap="$2" alignItems="center">
            <Text variant="caption" flex={1}>
              {String(t("admin.toolbarColor"))}
            </Text>
            <input
              type="color"
              value={state.strokeColor}
              onChange={(e) =>
                dispatch({ type: "SET_STROKE_COLOR", color: e.target.value })
              }
              style={{
                width: 32,
                height: 24,
                border: "1px solid #ccc",
                borderRadius: 0,
                cursor: "pointer",
                padding: 0,
              }}
              aria-label={t("admin.toolbarStrokeColorLabel") as string}
            />
            <Text variant="caption" tone="muted">
              {state.strokeColor}
            </Text>
          </XStack>

          <XStack gap="$2" alignItems="center">
            <Text variant="caption" flex={1}>
              {String(t("admin.toolbarStrokeWidth"))}
            </Text>
            <input
              type="range"
              min={0.5}
              max={10}
              step={0.5}
              value={state.strokeWidth}
              onChange={(e) =>
                dispatch({
                  type: "SET_STROKE_WIDTH",
                  width: parseFloat(e.target.value),
                })
              }
              style={{ flex: 1 }}
              aria-label={t("admin.toolbarStrokeWidthLabel") as string}
            />
            <Text variant="caption" width={30}>
              {state.strokeWidth}
            </Text>
          </XStack>

          <Text variant="caption" tone="muted">
            {String(t("admin.toolbarStrokeHint"))}
          </Text>
        </YStack>
      )}

      {/* Background image controls */}
      <YStack gap="$2">
        <Text variant="caption" weight="bold" tone="muted">
          {String(t("admin.toolbarBackgroundImage"))}
        </Text>
        <XStack gap="$1" alignItems="center">
          <Tooltip
            anchor={
              <Button
                variant="ghost"
                size="$2"
                icon
                onPress={handleImageImportClick}
                aria-label={t("admin.toolbarImportImage") as string}
              >
                <ImageIcon size={16} />
              </Button>
            }
            placement="bottom"
          >
            {String(t("admin.toolbarImportImage"))}
          </Tooltip>
          {state.image && (
            <Tooltip
              anchor={
                <Button
                  variant="ghost"
                  size="$2"
                  icon
                  onPress={() => dispatch({ type: "REMOVE_IMAGE" })}
                  aria-label={t("admin.toolbarRemoveImage") as string}
                >
                  <X size={16} />
                </Button>
              }
              placement="bottom"
            >
              {String(t("admin.toolbarRemoveImage"))}
            </Tooltip>
          )}
          {state.image && (
            <Tooltip
              anchor={
                <Button
                  variant="ghost"
                  size="$2"
                  icon
                  onPress={onDetect}
                  disabled={isDetecting}
                  aria-label={t("admin.toolbarAutoDetect") as string}
                >
                  {isDetecting ? (
                    <Spinner size="sm" />
                  ) : (
                    <ScanSearch size={16} />
                  )}
                </Button>
              }
              placement="bottom"
            >
              {String(t("admin.toolbarAutoDetect"))}
            </Tooltip>
          )}
        </XStack>
        {state.image && (
          <XStack gap="$2" alignItems="center">
            <Text variant="caption" flex={1}>
              {String(t("admin.toolbarOpacity"))}
            </Text>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={state.image.opacity}
              onChange={(e) =>
                dispatch({
                  type: "SET_IMAGE_OPACITY",
                  opacity: parseFloat(e.target.value),
                })
              }
              style={{ flex: 1 }}
              aria-label={t("admin.toolbarImageOpacityLabel") as string}
            />
            <Text variant="caption" width={30}>
              {Math.round(state.image.opacity * 100)}%
            </Text>
          </XStack>
        )}
      </YStack>

      {/* Sections list */}
      <YStack gap="$2">
        <Text variant="caption" weight="bold" tone="muted">
          {String(
            t("admin.toolbarSectionsCount", { count: state.sections.length }),
          )}
        </Text>
        {state.sections.length === 0 && (
          <Text variant="caption" tone="muted">
            {String(t("admin.toolbarDrawPolygonHint"))}
          </Text>
        )}
        {state.sections.map((section) => {
          const sectionSeats = state.seats.filter(
            (s) => s.sectionId === section.sectionId,
          );
          const isActive = state.activeSectionId === section.sectionId;
          const isRenaming = renamingSectionId === section.sectionId;
          // Group seats by row for display
          const seatsByRow = new Map<string, typeof sectionSeats>();
          for (const seat of sectionSeats) {
            const arr = seatsByRow.get(seat.row) ?? [];
            arr.push(seat);
            seatsByRow.set(seat.row, arr);
          }
          return (
            <YStack key={section.sectionId} gap="$1">
              <XStack
                gap="$2"
                alignItems="center"
                paddingHorizontal="$2"
                paddingVertical="$3"
                borderRadius={0}
                borderWidth={2}
                borderColor={isActive ? "$primary" : "$borderColor"}
                backgroundColor={isActive ? "$primaryMuted" : "$background"}
                cursor="pointer"
                onPress={() =>
                  dispatch({
                    type: "SET_ACTIVE_SECTION",
                    sectionId: section.sectionId,
                  })
                }
                role="button"
                aria-label={`Section ${section.label}`}
              >
                <Stack
                  width={14}
                  height={14}
                  borderRadius={0}
                  backgroundColor={section.color}
                />
                <YStack flex={1}>
                  {isRenaming ? (
                    <TextInput
                      size="$2"
                      value={renameValue}
                      onChangeText={setRenameValue}
                      onBlur={commitRename}
                      onKeyPress={(e: { nativeEvent: { key: string } }) => {
                        if (e.nativeEvent.key === "Enter") commitRename();
                      }}
                      autoFocus
                      aria-label={
                        t("admin.toolbarRenameSectionLabel") as string
                      }
                    />
                  ) : (
                    <XStack gap="$1" alignItems="center">
                      <Text variant="caption" weight="bold">
                        {section.label}
                      </Text>
                      <Badge
                        tone={
                          section.kind === "helper"
                            ? "warning"
                            : section.kind === "ga"
                              ? "success"
                              : "info"
                        }
                        size="sm"
                      >
                        {section.kind.toUpperCase()}
                      </Badge>
                    </XStack>
                  )}
                  {!isRenaming && (
                    <Text variant="caption" tone="muted">
                      {section.kind === "seat"
                        ? String(
                            t("admin.toolbarSeatCountLabel", {
                              count: sectionSeats.length,
                            }),
                          )
                        : section.kind === "ga"
                          ? String(
                              t("admin.toolbarGaInfo", {
                                capacity: section.capacity ?? 0,
                              }),
                            )
                          : String(t("admin.toolbarHelper"))}
                    </Text>
                  )}
                </YStack>
                {/* Edit / delete actions */}
                <XStack gap="$1" alignItems="center">
                  {!isRenaming && (
                    <>
                      <Tooltip
                        anchor={
                          <Button
                            variant="ghost"
                            size="$1"
                            icon
                            onPress={(e: { stopPropagation: () => void }) => {
                              e.stopPropagation();
                              startRename(section.sectionId, section.label);
                            }}
                            aria-label={`Rename section ${section.label}`}
                          >
                            <Pencil size={12} />
                          </Button>
                        }
                        placement="top"
                      >
                        {String(t("admin.toolbarRename"))}
                      </Tooltip>
                    </>
                  )}
                  <Tooltip
                    anchor={
                      <Button
                        variant="ghost"
                        size="$1"
                        icon
                        onPress={(e: { stopPropagation: () => void }) => {
                          e.stopPropagation();
                          dispatch({
                            type: "DELETE_SECTION",
                            sectionId: section.sectionId,
                          });
                        }}
                        aria-label={`Delete section ${section.label}`}
                      >
                        <Trash2 size={12} />
                      </Button>
                    }
                    placement="top"
                  >
                    {String(t("admin.toolbarDeleteSection"))}
                  </Tooltip>
                </XStack>

                {/* Reorder arrows — vertically stacked at far right */}
                {!isRenaming && state.sections.length > 1 && (
                  <YStack
                    gap="$0"
                    alignItems="center"
                    justifyContent="center"
                    marginLeft="$1"
                    borderLeftWidth={1}
                    borderColor="$borderColor"
                    paddingLeft="$1"
                  >
                    <Tooltip
                      anchor={
                        <Button
                          variant="ghost"
                          size="$1"
                          icon
                          disabled={state.sections.indexOf(section) === 0}
                          onPress={(e: { stopPropagation: () => void }) => {
                            e.stopPropagation();
                            dispatch({
                              type: "REORDER_SECTION",
                              sectionId: section.sectionId,
                              direction: "up",
                            });
                          }}
                          aria-label={`Move section ${section.label} up`}
                        >
                          <ArrowUp size={12} />
                        </Button>
                      }
                      placement="top"
                    >
                      {String(t("admin.toolbarMoveUp"))}
                    </Tooltip>
                    <Tooltip
                      anchor={
                        <Button
                          variant="ghost"
                          size="$1"
                          icon
                          disabled={
                            state.sections.indexOf(section) ===
                            state.sections.length - 1
                          }
                          onPress={(e: { stopPropagation: () => void }) => {
                            e.stopPropagation();
                            dispatch({
                              type: "REORDER_SECTION",
                              sectionId: section.sectionId,
                              direction: "down",
                            });
                          }}
                          aria-label={`Move section ${section.label} down`}
                        >
                          <ArrowDown size={12} />
                        </Button>
                      }
                      placement="top"
                    >
                      {String(t("admin.toolbarMoveDown"))}
                    </Tooltip>
                  </YStack>
                )}
              </XStack>

              {/* GA capacity editor (inline when active) */}
              {isActive && section.kind === "ga" && (
                <XStack
                  gap="$2"
                  alignItems="center"
                  paddingHorizontal="$2"
                  paddingVertical="$1"
                >
                  <Text variant="caption" flex={1}>
                    {String(t("admin.toolbarGaCapacity"))}
                  </Text>
                  <NumericInput
                    size="$2"
                    value={String(section.capacity ?? 0)}
                    onChangeText={(v: string) => {
                      const n = parseInt(v, 10);
                      if (!Number.isNaN(n) && n >= 0) {
                        dispatch({
                          type: "SET_SECTION_CAPACITY",
                          sectionId: section.sectionId,
                          capacity: n,
                        });
                      }
                    }}
                    width={70}
                    min={0}
                    step={1}
                    aria-label={t("admin.toolbarGaCapacityHint") as string}
                  />
                </XStack>
              )}

              {/* Curve smoothing slider (inline when active) */}
              {isActive && (
                <XStack
                  gap="$2"
                  alignItems="center"
                  paddingHorizontal="$2"
                  paddingVertical="$1"
                >
                  <Text variant="caption" style={{ minWidth: 62 }}>
                    Smoothing
                  </Text>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={Math.round((section.smoothing ?? 0) * 100)}
                    onChange={(e) => {
                      const v = Number(e.target.value) / 100;
                      dispatch({
                        type: "SET_SECTION_SMOOTHING",
                        sectionId: section.sectionId,
                        smoothing: v,
                      });
                    }}
                    style={{
                      flex: 1,
                      cursor: "pointer",
                      accentColor: section.color,
                    }}
                    aria-label="Curve smoothing"
                  />
                  <Text
                    variant="caption"
                    tone="muted"
                    style={{ minWidth: 28, textAlign: "right" }}
                  >
                    {Math.round((section.smoothing ?? 0) * 100)}%
                  </Text>
                </XStack>
              )}

              {/* Per-edge smoothing controls */}
              {isActive &&
                (() => {
                  const sel = state.selectedEdge;
                  const isEdgeOnThisSection =
                    sel && sel.sectionId === section.sectionId;

                  if (isEdgeOnThisSection) {
                    // Per-edge slider for the selected edge
                    const currentSmoothing =
                      section.edgeSmoothing?.find(
                        (f) => f.edgeIndex === sel.edgeIndex,
                      )?.smoothing ?? 0;
                    const shared = findSharedBoundaryEdges(
                      state.sections,
                      sel.sectionId,
                      sel.edgeIndex,
                    );
                    return (
                      <YStack
                        gap="$1"
                        paddingHorizontal="$2"
                        paddingVertical="$1"
                      >
                        <XStack gap="$2" alignItems="center">
                          <Text variant="caption" style={{ minWidth: 62 }}>
                            Edge {sel.edgeIndex}
                          </Text>
                          <input
                            type="range"
                            min={0}
                            max={100}
                            step={5}
                            value={Math.round(currentSmoothing * 100)}
                            onChange={(e) => {
                              const v = Number(e.target.value) / 100;
                              dispatch({
                                type: "SET_EDGE_SMOOTHING",
                                sectionId: sel.sectionId,
                                edgeIndex: sel.edgeIndex,
                                smoothing: v,
                              });
                            }}
                            style={{
                              flex: 1,
                              cursor: "pointer",
                              accentColor: "#14b8a6",
                            }}
                            aria-label={`Edge ${sel.edgeIndex} smoothing`}
                          />
                          <Text
                            variant="caption"
                            tone="muted"
                            style={{ minWidth: 28, textAlign: "right" }}
                          >
                            {Math.round(currentSmoothing * 100)}%
                          </Text>
                        </XStack>
                        {shared.length > 0 && (
                          <XStack gap="$1" alignItems="center" paddingLeft="$1">
                            <Link2 size={10} color="#f59e0b" />
                            <Text
                              variant="caption"
                              tone="muted"
                              style={{ fontSize: 10 }}
                            >
                              Linked to {shared.length} shared{" "}
                              {shared.length === 1 ? "boundary" : "boundaries"}
                            </Text>
                          </XStack>
                        )}
                      </YStack>
                    );
                  }

                  // Bulk smooth/sharpen buttons (when no edge is selected on this section)
                  return (
                    <XStack
                      gap="$1"
                      paddingHorizontal="$2"
                      paddingVertical="$1"
                    >
                      <Button
                        size="$2"
                        variant="ghost"
                        onPress={() => {
                          dispatch({
                            type: "SET_EDGE_SMOOTHING_BATCH",
                            sectionId: section.sectionId,
                            smoothing: 0.6,
                          });
                        }}
                        aria-label="Smooth all edges"
                      >
                        <Text variant="caption">Smooth All</Text>
                      </Button>
                      <Button
                        size="$2"
                        variant="ghost"
                        onPress={() => {
                          dispatch({
                            type: "SET_EDGE_SMOOTHING_BATCH",
                            sectionId: section.sectionId,
                            smoothing: 0,
                          });
                        }}
                        aria-label="Sharpen all edges"
                      >
                        <Text variant="caption">Sharpen All</Text>
                      </Button>
                    </XStack>
                  );
                })()}

              {/* Section metadata key-value editor (inline when active) */}
              {isActive && (
                <SectionMetadataEditor
                  sectionId={section.sectionId}
                  metadata={section.metadata}
                  dispatch={dispatch}
                />
              )}

              {/* Seats nested under the section (collapsible) */}
              {isActive && sectionSeats.length > 0 && (
                <YStack
                  gap="$1"
                  paddingLeft="$2"
                  paddingRight="$1"
                  paddingBottom="$1"
                >
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleSectionExpanded(section.sectionId);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      padding: "2px 0",
                      fontSize: 11,
                      color: "#666",
                    }}
                    aria-label={
                      expandedSectionIds.has(section.sectionId)
                        ? (t("admin.toolbarCollapse") as string)
                        : (t("admin.toolbarExpand") as string)
                    }
                    aria-expanded={expandedSectionIds.has(section.sectionId)}
                  >
                    {expandedSectionIds.has(section.sectionId) ? (
                      <ChevronDown size={12} />
                    ) : (
                      <ChevronRight size={12} />
                    )}
                    {String(
                      t("admin.toolbarSeatCountLabel", {
                        count: sectionSeats.length,
                      }),
                    )}
                  </button>
                  {expandedSectionIds.has(section.sectionId) && (
                    <YStack gap="$1" paddingLeft="$2">
                      {[...seatsByRow.entries()].map(([rowLabel, rowSeats]) => (
                        <YStack key={rowLabel} gap="$1">
                          <Text variant="caption" weight="bold" tone="muted">
                            {String(
                              t("admin.toolbarRowLabel", { row: rowLabel }),
                            )}
                          </Text>
                          <XStack gap="$1" flexWrap="wrap">
                            {rowSeats.map((seat) => {
                              const isSelected = state.selectedSeatIds.has(
                                seat.id,
                              );
                              return (
                                <button
                                  key={seat.id}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    dispatch({
                                      type: "SELECT_SEAT",
                                      seatId: seat.id,
                                      additive: e.shiftKey,
                                    });
                                  }}
                                  aria-label={`Seat ${seat.row}${seat.seat}`}
                                  aria-pressed={isSelected}
                                  style={{
                                    fontSize: 11,
                                    padding: "2px 5px",
                                    borderRadius: 0,
                                    border: isSelected
                                      ? "2px solid var(--accent, #E2481D)"
                                      : "1px solid var(--borderColor, #211C16)",
                                    backgroundColor: isSelected
                                      ? "var(--accentSoft, rgba(226, 72, 29, 0.10))"
                                      : "var(--surfaceMuted, #EFE7D6)",
                                    cursor: "pointer",
                                    fontVariantNumeric: "tabular-nums",
                                  }}
                                >
                                  {seat.seat}
                                </button>
                              );
                            })}
                          </XStack>
                        </YStack>
                      ))}
                    </YStack>
                  )}
                </YStack>
              )}
            </YStack>
          );
        })}
      </YStack>

      {/* Strokes list */}
      {state.strokes.length > 0 && (
        <YStack gap="$2">
          <Text variant="caption" weight="bold" tone="muted">
            {String(
              t("admin.toolbarStrokesCount", { count: state.strokes.length }),
            )}
          </Text>
          {state.strokes.map((stroke) => {
            const isSelected = state.selectedStrokeIds.has(stroke.id);
            return (
              <XStack
                key={stroke.id}
                gap="$2"
                alignItems="center"
                paddingHorizontal="$2"
                paddingVertical="$2"
                borderRadius={0}
                borderWidth={2}
                borderColor={isSelected ? "$primary" : "$borderColor"}
                backgroundColor={isSelected ? "$primaryMuted" : "$background"}
                cursor="pointer"
                onPress={() =>
                  dispatch({
                    type: "SELECT_STROKE",
                    strokeId: stroke.id,
                    additive: false,
                  })
                }
                role="button"
                aria-label={`Stroke ${stroke.id}`}
              >
                <Stack
                  width={14}
                  height={4}
                  borderRadius={0}
                  backgroundColor={stroke.color}
                />
                <Text variant="caption" flex={1}>
                  {String(
                    t("admin.toolbarPts", { count: stroke.points.length }),
                  )}
                </Text>
                <Tooltip
                  anchor={
                    <Button
                      variant="ghost"
                      size="$1"
                      icon
                      onPress={(e: { stopPropagation: () => void }) => {
                        e.stopPropagation();
                        dispatch({
                          type: "DELETE_STROKE",
                          strokeId: stroke.id,
                        });
                      }}
                      aria-label={`Delete stroke ${stroke.id}`}
                    >
                      <Trash2 size={12} />
                    </Button>
                  }
                  placement="top"
                >
                  {String(t("admin.toolbarDeleteStroke"))}
                </Tooltip>
              </XStack>
            );
          })}
        </YStack>
      )}

      {/* Place seats along selected stroke */}
      {state.selectedStrokeIds.size === 1 && state.activeSectionId && (
        <YStack
          gap="$2"
          padding="$3"
          borderWidth={2}
          borderColor="$borderColor"
          borderRadius={0}
        >
          <Text variant="caption" weight="bold" tone="muted">
            {String(t("admin.toolbarPlaceSeatsAlongStroke"))}
          </Text>
          <XStack gap="$2" alignItems="center">
            <Text variant="caption" flex={1}>
              {String(t("admin.toolbarCount"))}
            </Text>
            <NumericInput
              size="$2"
              flex={1}
              value={String(strokeSeatCount)}
              onChangeText={(v: string) => {
                const n = parseInt(v, 10);
                if (!isNaN(n) && n > 0) setStrokeSeatCount(n);
              }}
              min={1}
              aria-label={t("admin.toolbarPlaceSeatsAlongStroke") as string}
            />
          </XStack>
          <Button
            size="$2"
            variant="secondary"
            onPress={() => {
              const strokeId = [...state.selectedStrokeIds][0]!;
              dispatch({
                type: "PLACE_SEATS_ALONG_STROKE",
                strokeId,
                count: strokeSeatCount,
              });
            }}
          >
            {String(t("admin.toolbarPlaceSeats", { count: strokeSeatCount }))}
          </Button>
        </YStack>
      )}

      {/* Placement groups */}
      {state.placementGroups.length > 0 && (
        <YStack gap="$2">
          <Text variant="caption" weight="bold" tone="muted">
            {String(
              t("admin.toolbarPlacementGroups", {
                count: state.placementGroups.length,
              }),
            )}
          </Text>
          {state.placementGroups.map((group, groupIndex) => {
            const isSelected = state.selectedPlacementGroupId === group.id;
            const groupLabel = String(
              t("admin.toolbarGroupLabel", {
                kind: group.kind,
                seatCount: group.seatIds.length,
              }),
            );
            return (
              <XStack
                key={group.id}
                gap="$2"
                alignItems="center"
                paddingHorizontal="$2"
                paddingVertical="$2"
                borderRadius={0}
                borderWidth={2}
                borderColor={isSelected ? "$primary" : "$borderColor"}
                backgroundColor={isSelected ? "$primaryMuted" : "$background"}
                cursor="pointer"
                onPress={() =>
                  dispatch({
                    type: "SELECT_PLACEMENT_GROUP",
                    groupId: isSelected ? null : group.id,
                  })
                }
                role="button"
                aria-label={`Placement group ${group.kind}`}
              >
                <Badge tone="info" size="sm">
                  {group.kind}
                </Badge>
                <YStack flex={1}>
                  <Text variant="caption" weight="bold">
                    {groupLabel}
                  </Text>
                  <Text variant="caption" tone="muted">
                    {"spacing" in group && group.spacing > 0
                      ? String(
                          t("admin.toolbarGapValue", {
                            spacing: group.spacing,
                          }),
                        )
                      : String(t("admin.toolbarCountBased"))}
                    {group.kind === "grid"
                      ? ` \u00B7 ${String(t("admin.toolbarGridDims", { rows: group.rows, cols: group.cols }))}`
                      : ""}
                    {group.kind === "stroke"
                      ? ` \u00B7 ${String(t("admin.toolbarStrokeKind"))}`
                      : ""}
                  </Text>
                </YStack>
                <XStack gap="$1">
                  <Tooltip
                    anchor={
                      <Button
                        variant="ghost"
                        size="$1"
                        icon
                        disabled={groupIndex === 0}
                        onPress={(e: { stopPropagation: () => void }) => {
                          e.stopPropagation();
                          dispatch({
                            type: "REORDER_PLACEMENT_GROUP",
                            groupId: group.id,
                            direction: "up",
                          });
                        }}
                        aria-label={t("admin.toolbarMoveGroupUp") as string}
                      >
                        <ArrowUp size={10} />
                      </Button>
                    }
                    placement="top"
                  >
                    {String(t("admin.toolbarMoveUp"))}
                  </Tooltip>
                  <Tooltip
                    anchor={
                      <Button
                        variant="ghost"
                        size="$1"
                        icon
                        disabled={
                          groupIndex === state.placementGroups.length - 1
                        }
                        onPress={(e: { stopPropagation: () => void }) => {
                          e.stopPropagation();
                          dispatch({
                            type: "REORDER_PLACEMENT_GROUP",
                            groupId: group.id,
                            direction: "down",
                          });
                        }}
                        aria-label={t("admin.toolbarMoveGroupDown") as string}
                      >
                        <ArrowDown size={10} />
                      </Button>
                    }
                    placement="top"
                  >
                    {String(t("admin.toolbarMoveDown"))}
                  </Tooltip>
                  <Tooltip
                    anchor={
                      <Button
                        variant="ghost"
                        size="$1"
                        icon
                        onPress={(e: { stopPropagation: () => void }) => {
                          e.stopPropagation();
                          dispatch({
                            type: "DELETE_PLACEMENT_GROUP",
                            groupId: group.id,
                          });
                        }}
                        aria-label={
                          t("admin.toolbarDeleteGroupSeats") as string
                        }
                      >
                        <Trash2 size={12} />
                      </Button>
                    }
                    placement="top"
                  >
                    {String(t("admin.toolbarDeleteGroupSeats"))}
                  </Tooltip>
                </XStack>
              </XStack>
            );
          })}

          {/* Inline editor for the selected placement group */}
          {state.selectedPlacementGroupId &&
            (() => {
              const group = state.placementGroups.find(
                (g) => g.id === state.selectedPlacementGroupId,
              );
              if (!group) return null;
              return (
                <YStack
                  gap="$2"
                  padding="$3"
                  borderWidth={2}
                  borderColor="$primary"
                  borderRadius={0}
                >
                  <Text variant="caption" weight="bold" tone="muted">
                    {String(t("admin.toolbarEditGroup", { kind: group.kind }))}
                  </Text>
                  {group.kind !== "grid" && (
                    <XStack gap="$2" alignItems="center">
                      <Text variant="caption" flex={1}>
                        {String(t("admin.toolbarGroupCount"))}
                      </Text>
                      <NumericInput
                        size="$2"
                        value={String(group.count)}
                        onChangeText={(val: string) => {
                          const n = parseInt(val, 10);
                          if (Number.isFinite(n) && n > 0) {
                            dispatch({
                              type: "UPDATE_PLACEMENT_GROUP",
                              groupId: group.id,
                              updates: { count: n },
                            });
                          }
                        }}
                        width={60}
                        min={1}
                        aria-label={t("admin.toolbarGroupCount") as string}
                      />
                    </XStack>
                  )}
                  {group.kind === "grid" && (
                    <>
                      <XStack gap="$2" alignItems="center">
                        <Text variant="caption" flex={1}>
                          {String(t("admin.toolbarGroupCols"))}
                        </Text>
                        <NumericInput
                          size="$2"
                          value={String(group.cols)}
                          onChangeText={(val: string) => {
                            const n = parseInt(val, 10);
                            if (Number.isFinite(n) && n > 0) {
                              dispatch({
                                type: "UPDATE_PLACEMENT_GROUP",
                                groupId: group.id,
                                updates: { cols: n },
                              });
                            }
                          }}
                          width={60}
                          min={1}
                          aria-label={t("admin.toolbarGroupCols") as string}
                        />
                      </XStack>
                      <XStack gap="$2" alignItems="center">
                        <Text variant="caption" flex={1}>
                          {String(t("admin.toolbarGroupRows"))}
                        </Text>
                        <NumericInput
                          size="$2"
                          value={String(group.rows)}
                          onChangeText={(val: string) => {
                            const n = parseInt(val, 10);
                            if (Number.isFinite(n) && n > 0) {
                              dispatch({
                                type: "UPDATE_PLACEMENT_GROUP",
                                groupId: group.id,
                                updates: { rows: n },
                              });
                            }
                          }}
                          width={60}
                          aria-label={t("admin.toolbarGroupRows") as string}
                        />
                      </XStack>
                    </>
                  )}
                  {group.kind !== "stroke" && (
                    <XStack gap="$2" alignItems="center">
                      <Text variant="caption" flex={1}>
                        {group.kind === "grid"
                          ? String(t("admin.toolbarGroupGapX"))
                          : String(t("admin.toolbarGroupGap"))}
                      </Text>
                      <NumericInput
                        size="$2"
                        value={
                          group.kind === "grid"
                            ? String(
                                (group as { spacingX: number }).spacingX ??
                                  (group as { spacing: number }).spacing,
                              )
                            : String((group as { spacing: number }).spacing)
                        }
                        onChangeText={(val: string) => {
                          const n = Number(val);
                          if (val !== "" && Number.isFinite(n) && n >= 0) {
                            if (group.kind === "grid") {
                              dispatch({
                                type: "UPDATE_PLACEMENT_GROUP",
                                groupId: group.id,
                                updates: { spacingX: n },
                              });
                            } else {
                              dispatch({
                                type: "UPDATE_PLACEMENT_GROUP",
                                groupId: group.id,
                                updates: { spacing: n },
                              });
                            }
                          }
                        }}
                        width={60}
                        min={0}
                        step={1}
                        allowFloat
                        aria-label={
                          group.kind === "grid"
                            ? (t("admin.toolbarGroupGapX") as string)
                            : (t("admin.toolbarGroupGap") as string)
                        }
                      />
                    </XStack>
                  )}
                  {group.kind === "grid" && (
                    <XStack gap="$2" alignItems="center">
                      <Text variant="caption" flex={1}>
                        {String(t("admin.toolbarGroupGapY"))}
                      </Text>
                      <NumericInput
                        size="$2"
                        value={String(
                          (group as { spacingY: number }).spacingY ??
                            (group as { spacing: number }).spacing,
                        )}
                        onChangeText={(val: string) => {
                          const n = Number(val);
                          if (val !== "" && Number.isFinite(n) && n >= 0) {
                            dispatch({
                              type: "UPDATE_PLACEMENT_GROUP",
                              groupId: group.id,
                              updates: { spacingY: n },
                            });
                          }
                        }}
                        width={60}
                        min={0}
                        step={1}
                        allowFloat
                        aria-label={t("admin.toolbarGroupGapY") as string}
                      />
                    </XStack>
                  )}
                  {group.kind === "arc" && (
                    <>
                      <XStack gap="$2" alignItems="center">
                        <Text variant="caption" flex={1}>
                          {String(t("admin.toolbarGroupRadius"))}
                        </Text>
                        <NumericInput
                          size="$2"
                          value={String(Math.round(group.radius))}
                          onChangeText={(val: string) => {
                            const n = Number(val);
                            if (Number.isFinite(n) && n > 0) {
                              dispatch({
                                type: "UPDATE_ARC_GROUP_GEOMETRY",
                                groupId: group.id,
                                updates: { radius: n },
                              });
                            }
                          }}
                          width={60}
                          min={1}
                          step={5}
                          aria-label={t("admin.toolbarGroupRadius") as string}
                        />
                      </XStack>
                      <XStack gap="$2" alignItems="center">
                        <Text variant="caption" flex={1}>
                          {String(t("admin.toolbarGroupArc"))} °
                        </Text>
                        <NumericInput
                          size="$2"
                          value={String(Math.round(group.arcDeg))}
                          onChangeText={(val: string) => {
                            if (val === "") return;
                            const deg = Number(val);
                            if (
                              Number.isFinite(deg) &&
                              deg >= 0 &&
                              deg <= 360
                            ) {
                              dispatch({
                                type: "UPDATE_ARC_GROUP_GEOMETRY",
                                groupId: group.id,
                                updates: { arcDeg: deg },
                              });
                            }
                          }}
                          width={60}
                          min={0}
                          max={360}
                          step={5}
                          aria-label={t("admin.toolbarGroupArc") as string}
                        />
                      </XStack>
                      <XStack gap="$2" alignItems="center">
                        <Text variant="caption" flex={1}>
                          {String(t("admin.toolbarGroupRotate"))} °
                        </Text>
                        <NumericInput
                          size="$2"
                          value={String(Math.round(group.rotationDeg))}
                          onChangeText={(val: string) => {
                            if (val === "") return;
                            const deg = Number(val);
                            if (Number.isFinite(deg)) {
                              dispatch({
                                type: "UPDATE_ARC_GROUP_GEOMETRY",
                                groupId: group.id,
                                updates: { rotationDeg: deg },
                              });
                            }
                          }}
                          width={60}
                          aria-label={t("admin.toolbarGroupRotate") as string}
                        />
                      </XStack>
                      <Text variant="caption" tone="muted">
                        {String(t("admin.toolbarDragHandlesHint"))}
                      </Text>
                    </>
                  )}
                </YStack>
              );
            })()}
        </YStack>
      )}

      {/* Actions */}
      <YStack gap="$2" marginTop="auto">
        <Text variant="caption" weight="bold" tone="muted">
          {String(t("admin.toolbarActions"))}
        </Text>
        <XStack gap="$1" flexWrap="wrap">
          <Tooltip
            anchor={
              <Button
                variant="ghost"
                size="$2"
                icon
                onPress={handleUndo}
                disabled={state.undoStack.length === 0}
                aria-label={t("admin.toolbarUndo") as string}
              >
                <Undo2 size={16} />
              </Button>
            }
            placement="top"
          >
            {String(t("admin.toolbarUndo"))} ({shortcutHint("Z")})
          </Tooltip>
          <Tooltip
            anchor={
              <Button
                variant="ghost"
                size="$2"
                icon
                onPress={handleRedo}
                disabled={state.redoStack.length === 0}
                aria-label={t("admin.toolbarRedo") as string}
              >
                <Redo2 size={16} />
              </Button>
            }
            placement="top"
          >
            {String(t("admin.toolbarRedo"))} ({shortcutHint("Z", true)})
          </Tooltip>
          <Tooltip
            anchor={
              <Button
                variant="ghost"
                size="$2"
                icon
                onPress={handleCsvImportClick}
                aria-label={t("admin.toolbarImportCsv") as string}
              >
                <Upload size={16} />
              </Button>
            }
            placement="top"
          >
            {String(t("admin.toolbarImportCsv"))}
          </Tooltip>
          <Tooltip
            anchor={
              <Button
                variant="ghost"
                size="$2"
                icon
                onPress={handleExportCsv}
                disabled={
                  state.seats.length === 0 && state.sections.length === 0
                }
                aria-label={t("admin.toolbarExportCsv") as string}
              >
                <Download size={16} />
              </Button>
            }
            placement="top"
          >
            {String(t("admin.toolbarExportCsv"))}
          </Tooltip>
          {hasSelection && (
            <Tooltip
              anchor={
                <Button
                  variant="ghost"
                  size="$2"
                  icon
                  onPress={handleDeleteSelected}
                  aria-label={t("admin.toolbarDeleteSelected") as string}
                >
                  <Trash2 size={16} />
                </Button>
              }
              placement="top"
            >
              {String(t("admin.toolbarDeleteSelected"))}
            </Tooltip>
          )}
          <Tooltip
            anchor={
              <Button
                variant="ghost"
                size="$2"
                icon
                onPress={handleClearAll}
                disabled={
                  state.seats.length === 0 && state.sections.length === 0
                }
                aria-label={t("admin.toolbarClearAll") as string}
              >
                <Trash2 size={16} color="var(--danger)" />
              </Button>
            }
            placement="top"
          >
            {String(t("admin.toolbarClearAll"))}
          </Tooltip>
        </XStack>

        {/* Save button */}
        <Button
          variant="primary"
          size="$3"
          onPress={onSave}
          disabled={isSaving || !state.layoutName.trim()}
          aria-label={t("admin.toolbarSaveLayout") as string}
          data-testid="designer-save-btn"
        >
          <XStack gap="$2" alignItems="center">
            <Save size={16} />
            {/* Button variant="primary" already pins its label to
                $onBrandSecondary; the hardcoded white was overriding it. */}
            <Text variant="bodySmall" weight="bold" color="$onBrandSecondary">
              {isSaving
                ? String(t("admin.toolbarSaving"))
                : String(t("admin.toolbarSaveLayout"))}
            </Text>
          </XStack>
        </Button>
        {!state.layoutName.trim() && (
          <Text variant="caption" tone="error">
            {String(t("admin.toolbarEnterNameToSave"))}
          </Text>
        )}
      </YStack>

      {/* Summary */}
      <YStack
        gap="$1"
        paddingTop="$2"
        borderTopWidth={1}
        borderColor="$borderColor"
      >
        <Text variant="caption" tone="muted">
          {String(
            t("admin.toolbarSummary", {
              seats: state.seats.length.toLocaleString(),
              sections: state.sections.length,
            }),
          )}
          {state.image ? String(t("admin.toolbarSummaryImage")) : ""}
          {state.undoStack.length > 0
            ? String(
                t("admin.toolbarSummaryUndo", {
                  count: state.undoStack.length,
                }),
              )
            : ""}
          {state.redoStack.length > 0
            ? String(
                t("admin.toolbarSummaryRedo", {
                  count: state.redoStack.length,
                }),
              )
            : ""}
        </Text>
        {hasSelection && (
          <Text variant="caption" tone="muted">
            {String(
              t("admin.toolbarSelectedSummary", {
                seats: state.selectedSeatIds.size,
                sections: state.selectedSectionIds.size,
              }),
            )}
          </Text>
        )}
      </YStack>
    </YStack>
  );
}
