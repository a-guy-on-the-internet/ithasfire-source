"use client";

import { forwardRef, useCallback, useRef, type KeyboardEvent } from "react";
import {
  YStack,
  XStack,
  styled,
  type TamaguiElement,
  type StackProps,
} from "tamagui";
import { ChevronUp, ChevronDown, Minus, Plus } from "lucide-react";

import { Text } from "../typography/Text";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type QuantityStepperOrientation = "horizontal" | "vertical";

export interface QuantityStepperProps {
  /** Current quantity value */
  value: number;
  /** Called when the user increments (+1) or decrements (-1) */
  onStep: (delta: number) => void;
  /** Disallow going below this value (default 0) */
  min?: number;
  /** Disallow going above this value */
  max?: number;
  /** Disable the entire control */
  disabled?: boolean;
  /** Orientation: "horizontal" (default) or "vertical" */
  orientation?: QuantityStepperOrientation;
  /** Label for accessibility (e.g. ticket type name) */
  "aria-label"?: string;
  /**
   * Full accessible name for the increment button (pass a translated string,
   * e.g. "Increase quantity — General Admission"). Without it the button
   * composes "Increase quantity — {aria-label}" when an `aria-label` is given,
   * falling back to a bare "Increase" — which is ambiguous the moment two
   * steppers share a screen.
   */
  incrementLabel?: string;
  /** Full accessible name for the decrement button (see `incrementLabel`). */
  decrementLabel?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Styled primitives
// ─────────────────────────────────────────────────────────────────────────────

const StepButton = styled(XStack, {
  name: "QtyStepButton",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  backgroundColor: "transparent",
  borderColor: "$borderColor",
  borderWidth: 2,
  pressStyle: {
    backgroundColor: "$surfaceMuted",
    scale: 0.94,
  },
  hoverStyle: {
    backgroundColor: "$surfaceOverlay",
  },
  focusStyle: {
    outlineWidth: 2,
    outlineColor: "$accent",
    outlineStyle: "solid" as const,
    outlineOffset: -2,
  },
  disabledStyle: {
    opacity: 0.3,
    cursor: "not-allowed",
  },
});

const ValueDisplay = styled(XStack, {
  name: "QtyValueDisplay",
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: "$surfaceMuted",
  borderColor: "$borderColor",
  variants: {
    orientation: {
      horizontal: {
        borderTopWidth: 2,
        borderBottomWidth: 2,
        // 44px matches the step buttons — the mobile tap-target floor.
        height: 44,
        minWidth: 44,
        paddingHorizontal: "$1",
      },
      vertical: {
        borderLeftWidth: 2,
        borderRightWidth: 2,
        width: 46,
        minHeight: 32,
        paddingVertical: "$0.5",
      },
    },
  } as const,
});

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export const QuantityStepper = forwardRef<
  TamaguiElement,
  QuantityStepperProps & Omit<StackProps, "onStep">
>(
  (
    {
      value,
      onStep,
      min = 0,
      max,
      disabled = false,
      orientation = "horizontal",
      "aria-label": ariaLabel,
      incrementLabel,
      decrementLabel,
      ...rest
    },
    ref,
  ) => {
    const containerRef = useRef<HTMLDivElement>(null);
    // Per-button accessible names. Screen readers announce the button's own
    // name without reliably voicing the surrounding group, so the ticket-type
    // context must live ON the button.
    const increaseLabel =
      incrementLabel ??
      (ariaLabel ? `Increase quantity — ${ariaLabel}` : "Increase");
    const decreaseLabel =
      decrementLabel ??
      (ariaLabel ? `Decrease quantity — ${ariaLabel}` : "Decrease");
    const canDecrement = value > min && !disabled;
    const canIncrement = (max === undefined || value < max) && !disabled;

    const handleKeyDown = useCallback(
      (e: KeyboardEvent) => {
        const upKeys =
          orientation === "vertical" ? ["ArrowUp"] : ["ArrowRight", "ArrowUp"];
        const downKeys =
          orientation === "vertical"
            ? ["ArrowDown"]
            : ["ArrowLeft", "ArrowDown"];

        if (upKeys.includes(e.key) && canIncrement) {
          e.preventDefault();
          onStep(1);
        } else if (downKeys.includes(e.key) && canDecrement) {
          e.preventDefault();
          onStep(-1);
        }
      },
      [onStep, canIncrement, canDecrement, orientation],
    );

    const isVertical = orientation === "vertical";
    const Container = isVertical ? YStack : XStack;

    const iconSize = 18;
    const iconStroke = 2.5;

    // Button sizing — horizontal steppers meet the 44px mobile tap-target
    // floor. The vertical variant is a compact desktop-only control.
    const btnH = isVertical ? 28 : 44;
    const btnW = isVertical ? 46 : 44;

    return (
      <Container
        ref={ref}
        role="group"
        aria-label={ariaLabel ? `${ariaLabel} quantity` : "Quantity selector"}
        // @ts-expect-error — web-only event handler on Tamagui container
        onKeyDown={handleKeyDown}
        alignItems="center"
        {...rest}
      >
        {/* Decrement (left) — horizontal only */}
        {isVertical ? null : (
          <StepButton
            tag={"button" as never}
            role="button"
            aria-label={decreaseLabel}
            onPress={() => canDecrement && onStep(-1)}
            disabled={!canDecrement}
            height={btnH}
            width={btnW}
            borderTopLeftRadius="$sm"
            borderBottomLeftRadius="$sm"
            borderTopRightRadius={0}
            borderBottomRightRadius={0}
            tabIndex={0}
          >
            <Minus size={iconSize} strokeWidth={iconStroke} />
          </StepButton>
        )}

        {/* Increment (top) — vertical only */}
        {isVertical && (
          <StepButton
            tag={"button" as never}
            role="button"
            aria-label={increaseLabel}
            onPress={() => canIncrement && onStep(1)}
            disabled={!canIncrement}
            height={btnH}
            width={btnW}
            borderTopLeftRadius="$sm"
            borderTopRightRadius="$sm"
            borderBottomLeftRadius={0}
            borderBottomRightRadius={0}
            tabIndex={0}
          >
            <ChevronUp size={iconSize} strokeWidth={iconStroke} />
          </StepButton>
        )}

        {/* Value display */}
        <ValueDisplay orientation={orientation as never}>
          <Text
            variant="bodySmall"
            weight="bold"
            textAlign="center"
            userSelect="none"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {value}
          </Text>
        </ValueDisplay>

        {/* Decrement (bottom) — vertical only */}
        {isVertical && (
          <StepButton
            tag={"button" as never}
            role="button"
            aria-label={decreaseLabel}
            onPress={() => canDecrement && onStep(-1)}
            disabled={!canDecrement}
            height={btnH}
            width={btnW}
            borderBottomLeftRadius="$sm"
            borderBottomRightRadius="$sm"
            borderTopLeftRadius={0}
            borderTopRightRadius={0}
            tabIndex={0}
          >
            <ChevronDown size={iconSize} strokeWidth={iconStroke} />
          </StepButton>
        )}

        {/* Increment (right) — horizontal only */}
        {!isVertical && (
          <StepButton
            tag={"button" as never}
            role="button"
            aria-label={increaseLabel}
            onPress={() => canIncrement && onStep(1)}
            disabled={!canIncrement}
            height={btnH}
            width={btnW}
            borderTopRightRadius="$sm"
            borderBottomRightRadius="$sm"
            borderTopLeftRadius={0}
            borderBottomLeftRadius={0}
            tabIndex={0}
          >
            <Plus size={iconSize} strokeWidth={iconStroke} />
          </StepButton>
        )}
      </Container>
    );
  },
);

QuantityStepper.displayName = "QuantityStepper";
