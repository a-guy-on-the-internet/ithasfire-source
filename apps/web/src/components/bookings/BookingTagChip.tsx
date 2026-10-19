"use client";

import { XStack, styled } from "tamagui";
import { Text } from "@th/ui";
import { X } from "lucide-react";

import { bookingTagColorStyle } from "./booking-tag-color";

// ─────────────────────────────────────────────────────────────────────────────
// ONE TAG, as a chip. Content, so strict Swiss: square, hairline border, a
// 12% tint of its colour, an uppercase 10px label. Optionally removable — the
// remove control is a real <button> with an accessible name and a 28px hit
// area (the chip is 24px tall; 44px would dwarf a tag in a table cell, and
// the chip rows sit in a panel, not a touch-first toolbar).
// ─────────────────────────────────────────────────────────────────────────────

const ChipFrame = styled(XStack, {
  name: "BookingTagChip",
  alignItems: "center",
  gap: 4,
  minHeight: 24,
  paddingLeft: 8,
  paddingRight: 8,
  borderWidth: 1,
  borderStyle: "solid",
  borderRadius: 0,
  maxWidth: "100%",
  minWidth: 0,
  variants: {
    removable: {
      true: { paddingRight: 2 },
    },
  } as const,
});

const RemoveButton = styled(XStack, {
  name: "BookingTagChipRemove",
  tag: "button",
  width: 24,
  height: 24,
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: "transparent",
  borderWidth: 0,
  borderRadius: 0,
  cursor: "pointer",
  hoverStyle: { opacity: 0.7 },
  focusVisibleStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$accent",
    outlineOffset: -2,
  },
});

export function BookingTagChip({
  name,
  color,
  onRemove,
  removeLabel,
  testId,
}: {
  name: string;
  color: string;
  /** Present ⇒ a remove control renders. */
  onRemove?: () => void;
  /** Accessible name for the remove control ("Remove tag {name}"). Required with `onRemove`. */
  removeLabel?: string;
  testId?: string;
}) {
  const style = bookingTagColorStyle(color);
  return (
    <ChipFrame
      removable={Boolean(onRemove)}
      style={{ backgroundColor: style.background, borderColor: style.border }}
      data-testid={testId}
      data-color={color}
    >
      <Text
        variant="caption"
        weight="bold"
        fontSize={10}
        letterSpacing={0.8}
        textTransform="uppercase"
        color={style.text}
        minWidth={0}
        truncate
      >
        {name}
      </Text>
      {onRemove ? (
        <RemoveButton
          onPress={onRemove}
          aria-label={removeLabel}
          {...({ type: "button" } as Record<string, unknown>)}
          data-testid={testId ? `${testId}-remove` : undefined}
        >
          <X size={12} strokeWidth={2} aria-hidden color="currentColor" />
        </RemoveButton>
      ) : null}
    </ChipFrame>
  );
}
