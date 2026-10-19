"use client";

import { type ReactNode } from "react";
import { styled, XStack } from "tamagui";

import { Text } from "@th/ui";

/** Editor main-column mode: the authoring surface, or the in-place preview. */
export type EditorViewMode = "edit" | "preview";

const ToggleGroup = styled(XStack, {
  alignItems: "stretch",
  borderWidth: 2,
  borderColor: "$borderColorStrong",
  borderRadius: 0,
  // Never compress below the labels' intrinsic width: shrinking the segments
  // made "PREVIEW" paint across the divider onto the adjacent segment's dark
  // fill (measured at 320px). The host row wraps instead, giving this its own
  // line when neighbouring chrome crowds it.
  flexShrink: 0,
});

/**
 * One segment — a real <button> so it's keyboard-activatable, with
 * `aria-pressed` toggle-button semantics. Strict Swiss: radius 0, uppercase
 * bold label, active segment = decisive ink fill (`$structure` on Stub).
 */
const SegmentButton = styled(XStack, {
  tag: "button",
  alignItems: "center",
  justifyContent: "center",
  gap: "$2",
  // ≥44px touch target (DS floor).
  minHeight: 44,
  paddingHorizontal: "$3",
  cursor: "pointer",
  backgroundColor: "transparent",
  borderWidth: 0,
  borderRadius: 0,
  hoverStyle: { backgroundColor: "$surfaceMuted" },
  focusVisibleStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$accent",
    outlineOffset: -2,
  },
  variants: {
    active: {
      true: {
        backgroundColor: "$structure",
        cursor: "default",
        hoverStyle: { backgroundColor: "$structure" },
      },
    },
  } as const,
});

export type ViewModeSegment<TValue extends string> = {
  value: TValue;
  label: string;
  testId?: string;
  /**
   * Optional LEADING icon (object/context per the DS icon grammar). The
   * caller builds it because only the caller knows which segment is active,
   * and lucide icons need a resolved colour — `currentColor` would land on
   * ink-over-ink on the `$structure` fill.
   */
  icon?: ReactNode;
  /** e.g. `"Meta+Shift+P Control+Shift+P"` — advertises a keyboard binding. */
  keyShortcuts?: string;
};

export type ViewModeToggleProps<TValue extends string> = {
  value: TValue;
  onChange: (next: TValue) => void;
  /** Two or more mutually exclusive segments, rendered left to right. */
  segments: readonly ViewModeSegment<TValue>[];
  /** Accessible name for the `role="group"` wrapper. */
  groupLabel: string;
  testId?: string;
};

/**
 * A segmented control for mutually exclusive view state, shared by every
 * editor surface that has some: the event builder's Edit | Preview, the entity
 * page editor's Edit | Preview, and that editor's Desktop | Mobile device
 * check. Labels, icons and test ids are props so each surface keeps its own
 * i18n keys and selectors while the semantics and the styling stay in one
 * place — the device switch used to be role-less divs with a hand-rolled
 * keydown handler, a sub-44px hit area, and a second token pairing for the
 * same "this one is selected" idea.
 */
export function ViewModeToggle<TValue extends string>({
  value,
  onChange,
  segments,
  groupLabel,
  testId,
}: ViewModeToggleProps<TValue>) {
  return (
    <ToggleGroup role="group" aria-label={groupLabel} data-testid={testId}>
      {segments.map((segment, index) => {
        const active = value === segment.value;
        return (
          <SegmentButton
            key={segment.value}
            active={active}
            onPress={() => {
              if (!active) onChange(segment.value);
            }}
            // Valid on the rendered <button>, absent from Tamagui's RN prop
            // types — the spread keeps the escape hatch scoped. `type` is
            // included because a styled `tag: "button"` defaults to
            // type="submit"; neither call site has a <form> ancestor today,
            // but this is a SHARED control and the next one might.
            {...({
              type: "button",
              "aria-pressed": active,
              "aria-keyshortcuts": segment.keyShortcuts,
              "data-testid": segment.testId,
            } as Record<string, unknown>)}
            // Divider between adjacent segments.
            {...(index < segments.length - 1
              ? { borderRightWidth: 2, borderRightColor: "$borderColorStrong" }
              : {})}
          >
            {segment.icon}
            <Text
              variant="caption"
              weight="bold"
              tag="span"
              textTransform="uppercase"
              letterSpacing={1.5}
              color={active ? "$onStructure" : "$color"}
            >
              {segment.label}
            </Text>
          </SegmentButton>
        );
      })}
    </ToggleGroup>
  );
}
