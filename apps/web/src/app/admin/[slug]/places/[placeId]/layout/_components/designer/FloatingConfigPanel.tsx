"use client";

// ─────────────────────────────────────────────────────────────────────────────
// FloatingConfigPanel — moveable config overlay on the canvas
// ─────────────────────────────────────────────────────────────────────────────
// Renders a small draggable panel anchored near the selected element.
// It surfaces the most common properties for the active selection:
//   • Placement group  → count, spacing, radius/angles (arc)
//   • Selected seat(s) → row, seat number, radius
// ─────────────────────────────────────────────────────────────────────────────

import {
  useCallback,
  useRef,
  useState,
  useMemo,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { YStack, XStack } from "tamagui";
import { Text, Button, useTranslations } from "@th/ui";
import { TextInput } from "@th/ui";
import { GripHorizontal, X, Accessibility } from "lucide-react";

import type { DesignerState, DesignerAction, PlacementGroup } from "./types";

// ── Types ────────────────────────────────────────────────────────────────

interface FloatingConfigPanelProps {
  state: DesignerState;
  dispatch: Dispatch<DesignerAction>;
  /** Converts world coords to screen-relative CSS pixels (top-left of canvas container). */
  worldToScreen: (wx: number, wy: number) => { sx: number; sy: number };
}

// ── Component ────────────────────────────────────────────────────────────

export function FloatingConfigPanel({
  state,
  dispatch,
  worldToScreen: _worldToScreen,
}: FloatingConfigPanelProps) {
  const t = useTranslations();
  // ── Drag offset for the panel itself ──
  // Start anchored to the top-right corner of the canvas container
  const [dragOffset, setDragOffset] = useState<{ dx: number; dy: number }>({
    dx: 0,
    dy: 0,
  });
  const panelDragRef = useRef<{
    startX: number;
    startY: number;
    startDx: number;
    startDy: number;
  } | null>(null);

  const handlePanelPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.stopPropagation();
      e.preventDefault();
      panelDragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startDx: dragOffset.dx,
        startDy: dragOffset.dy,
      };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [dragOffset],
  );

  const handlePanelPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!panelDragRef.current) return;
      setDragOffset({
        dx:
          panelDragRef.current.startDx +
          (e.clientX - panelDragRef.current.startX),
        dy:
          panelDragRef.current.startDy +
          (e.clientY - panelDragRef.current.startY),
      });
    },
    [],
  );

  const handlePanelPointerUp = useCallback(() => {
    panelDragRef.current = null;
  }, []);

  // ── Determine what to show ──

  const selectedGroup = useMemo(() => {
    if (!state.selectedPlacementGroupId) return null;
    return (
      state.placementGroups.find(
        (g) => g.id === state.selectedPlacementGroupId,
      ) ?? null
    );
  }, [state.selectedPlacementGroupId, state.placementGroups]);

  const selectedSeats = useMemo(() => {
    if (state.selectedSeatIds.size === 0) return [];
    return state.seats.filter((s) => state.selectedSeatIds.has(s.id));
  }, [state.selectedSeatIds, state.seats]);

  // Nothing selected → don't render
  if (!selectedGroup && selectedSeats.length === 0) return null;

  // ── Compute anchor position — fixed top-right corner of the canvas ──

  const panelX = dragOffset.dx;
  const panelY = dragOffset.dy;

  return (
    <div
      style={{
        position: "absolute",
        right: panelX,
        top: panelY + 12,
        zIndex: 50,
        pointerEvents: "auto",
      }}
    >
      <YStack
        backgroundColor="$surface"
        borderWidth={2}
        borderColor="$borderColor"
        borderRadius={0}
        padding="$3"
        gap="$2"
      >
        {/* Drag handle bar */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            cursor: "grab",
            paddingBottom: 4,
            borderBottom: "1px solid var(--borderColorSoft, rgba(33, 28, 22, 0.3))",
          }}
          onPointerDown={handlePanelPointerDown}
          onPointerMove={handlePanelPointerMove}
          onPointerUp={handlePanelPointerUp}
          onPointerCancel={handlePanelPointerUp}
        >
          <XStack gap="$1" alignItems="center">
            <GripHorizontal size={14} color="var(--colorMuted)" />
            <Text variant="caption" tone="muted" weight="bold">
              {selectedGroup
                ? String(
                    t("admin.configPanelGroupKind", {
                      kind: selectedGroup.kind,
                    }),
                  )
                : String(
                    t("admin.configPanelSeatCount", {
                      count: selectedSeats.length,
                    }),
                  )}
            </Text>
          </XStack>
          <Button
            variant="ghost"
            size="$1"
            icon
            onPress={() => {
              if (selectedGroup)
                dispatch({ type: "SELECT_PLACEMENT_GROUP", groupId: null });
              if (selectedSeats.length > 0)
                dispatch({ type: "CLEAR_SELECTION" });
            }}
            aria-label={t("admin.configPanelClosePanel") as string}
          >
            <X size={12} />
          </Button>
        </div>

        {/* Group config */}
        {selectedGroup && (
          <GroupConfig group={selectedGroup} dispatch={dispatch} />
        )}

        {/* Seat info (read-only for now) */}
        {!selectedGroup && selectedSeats.length === 1 && (
          <YStack gap="$1">
            <Text variant="caption">
              {String(t("admin.configPanelRow"))}: {selectedSeats[0]!.row} /{" "}
              {String(t("admin.configPanelSeat"))}: {selectedSeats[0]!.seat}
            </Text>
            <Text variant="caption" tone="muted">
              r={selectedSeats[0]!.radius}
            </Text>
            <Button
              variant={selectedSeats[0]!.accessible ? "primary" : "outlined"}
              size="$2"
              onPress={() =>
                dispatch({
                  type: "TOGGLE_SEAT_ACCESSIBLE",
                  seatIds: [selectedSeats[0]!.id],
                })
              }
              aria-label="Toggle ADA accessible"
            >
              <XStack gap="$2" alignItems="center">
                <Accessibility size={13} />
                <Text variant="caption" tone="inherit" weight="bold">
                  {selectedSeats[0]!.accessible ? "ADA" : "Mark ADA"}
                </Text>
              </XStack>
            </Button>
          </YStack>
        )}

        {!selectedGroup && selectedSeats.length > 1 && (
          <YStack gap="$1">
            <Text variant="caption" tone="muted">
              {String(
                t("admin.configPanelSeatsSelected", {
                  count: selectedSeats.length,
                }),
              )}
            </Text>
            <Button
              variant={
                selectedSeats.every((s) => s.accessible)
                  ? "primary"
                  : "outlined"
              }
              size="$2"
              onPress={() =>
                dispatch({
                  type: "TOGGLE_SEAT_ACCESSIBLE",
                  seatIds: selectedSeats.map((s) => s.id),
                })
              }
              aria-label="Toggle ADA accessible"
            >
              <XStack gap="$2" alignItems="center">
                <Accessibility size={13} />
                <Text variant="caption" tone="inherit" weight="bold">
                  {selectedSeats.every((s) => s.accessible)
                    ? "Remove ADA"
                    : "Mark ADA"}
                </Text>
              </XStack>
            </Button>
          </YStack>
        )}
      </YStack>
    </div>
  );
}

// ── Group config sub-panel ──────────────────────────────────────────────

function GroupConfig({
  group,
  dispatch,
}: {
  group: PlacementGroup;
  dispatch: Dispatch<DesignerAction>;
}) {
  const t = useTranslations();
  const INPUT_W = 60;
  return (
    <YStack gap="$2">
      {/* Count (line / arc only) */}
      {group.kind !== "grid" && (
        <XStack gap="$2" alignItems="center">
          <Text variant="caption" flex={1}>
            {String(t("admin.configPanelCount"))}
          </Text>
          <TextInput
            size="$2"
            value={String("count" in group ? group.count : 0)}
            onChangeText={(val: string) => {
              const n = Number(val);
              if (
                val !== "" &&
                Number.isFinite(n) &&
                n > 0 &&
                Number.isInteger(n)
              ) {
                dispatch({
                  type: "UPDATE_PLACEMENT_GROUP",
                  groupId: group.id,
                  updates: { count: n },
                });
              }
            }}
            width={INPUT_W}
            aria-label={t("admin.configPanelCount") as string}
          />
        </XStack>
      )}

      {group.kind !== "stroke" && (
        <XStack gap="$2" alignItems="center">
          <Text variant="caption" flex={1}>
            {group.kind === "grid"
              ? String(t("admin.configPanelGapX"))
              : String(t("admin.configPanelGap"))}
          </Text>
          <TextInput
            size="$2"
            value={
              group.kind === "grid"
                ? String(
                    (group as { spacingX?: number }).spacingX ?? group.spacing,
                  )
                : String(group.spacing)
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
            width={INPUT_W}
            aria-label={
              group.kind === "grid"
                ? (t("admin.configPanelGapX") as string)
                : (t("admin.configPanelGap") as string)
            }
          />
        </XStack>
      )}

      {group.kind === "grid" && (
        <>
          <XStack gap="$2" alignItems="center">
            <Text variant="caption" flex={1}>
              {String(t("admin.configPanelGapY"))}
            </Text>
            <TextInput
              size="$2"
              value={String(
                (group as { spacingY?: number }).spacingY ?? group.spacing,
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
              width={INPUT_W}
              aria-label={t("admin.configPanelGapY") as string}
            />
          </XStack>
          <XStack gap="$2" alignItems="center">
            <Text variant="caption" flex={1}>
              {String(t("admin.configPanelCols"))}
            </Text>
            <TextInput
              size="$2"
              value={String(group.cols)}
              onChangeText={(val: string) => {
                const n = Number(val);
                if (
                  val !== "" &&
                  Number.isFinite(n) &&
                  n > 0 &&
                  Number.isInteger(n)
                ) {
                  dispatch({
                    type: "UPDATE_PLACEMENT_GROUP",
                    groupId: group.id,
                    updates: { cols: n },
                  });
                }
              }}
              width={INPUT_W}
              aria-label={t("admin.configPanelCols") as string}
            />
          </XStack>
          <XStack gap="$2" alignItems="center">
            <Text variant="caption" flex={1}>
              {String(t("admin.configPanelRows"))}
            </Text>
            <TextInput
              size="$2"
              value={String(group.rows)}
              onChangeText={(val: string) => {
                const n = Number(val);
                if (
                  val !== "" &&
                  Number.isFinite(n) &&
                  n > 0 &&
                  Number.isInteger(n)
                ) {
                  dispatch({
                    type: "UPDATE_PLACEMENT_GROUP",
                    groupId: group.id,
                    updates: { rows: n },
                  });
                }
              }}
              width={INPUT_W}
              aria-label={t("admin.configPanelRows") as string}
            />
          </XStack>
        </>
      )}

      {group.kind === "arc" && (
        <>
          <XStack gap="$2" alignItems="center">
            <Text variant="caption" flex={1}>
              {String(t("admin.configPanelRadius"))}
            </Text>
            <TextInput
              size="$2"
              value={String(Math.round(group.radius))}
              onChangeText={(val: string) => {
                const n = Number(val);
                if (val !== "" && Number.isFinite(n) && n > 0) {
                  dispatch({
                    type: "UPDATE_ARC_GROUP_GEOMETRY",
                    groupId: group.id,
                    updates: { radius: n },
                  });
                }
              }}
              width={INPUT_W}
              aria-label={t("admin.configPanelRadius") as string}
            />
          </XStack>
          <XStack gap="$2" alignItems="center">
            <Text variant="caption" flex={1}>
              {String(t("admin.configPanelArc"))} °
            </Text>
            <TextInput
              size="$2"
              value={String(Math.round(group.arcDeg))}
              onChangeText={(val: string) => {
                if (val === "") return;
                const deg = Number(val);
                if (Number.isFinite(deg) && deg >= 0 && deg <= 360) {
                  dispatch({
                    type: "UPDATE_ARC_GROUP_GEOMETRY",
                    groupId: group.id,
                    updates: { arcDeg: deg },
                  });
                }
              }}
              width={INPUT_W}
              aria-label={t("admin.configPanelArc") as string}
            />
          </XStack>
          <XStack gap="$2" alignItems="center">
            <Text variant="caption" flex={1}>
              {String(t("admin.configPanelRotate"))} °
            </Text>
            <TextInput
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
              width={INPUT_W}
              aria-label={t("admin.configPanelRotate") as string}
            />
          </XStack>
        </>
      )}
    </YStack>
  );
}
