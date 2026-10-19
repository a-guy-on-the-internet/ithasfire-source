"use client";

/**
 * FluidPressEffect - A "splash/dissolve" animation that creates the illusion
 * of a card surface rippling outward when pressed, revealing content beneath.
 *
 * Inspired by fluid/metaball simulations but implemented with CSS transforms
 * and radial gradients for performance.
 */
import { memo, useCallback, useRef, useState, type ReactNode } from "react";
import { Platform } from "react-native";
import { Stack, styled, useTheme, type GetProps } from "tamagui";

import { stubTheme } from "../../tokens/colors";
import { hexToRgba } from "../shared";

const isWeb = Platform.OS === "web";

/** Alpha for the default, theme-derived ripple tint. */
const RIPPLE_ALPHA = 0.3;

const EffectContainer = styled(Stack, {
  name: "FluidPressEffectContainer",
  position: "relative",
  overflow: "hidden",
});

const RippleLayer = styled(Stack, {
  name: "FluidPressRipple",
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  pointerEvents: "none",
  zIndex: 10,
  opacity: 0,
});

type RippleState = {
  active: boolean;
  x: number;
  y: number;
  scale: number;
};

export interface FluidPressEffectProps extends Omit<
  GetProps<typeof EffectContainer>,
  "onPress"
> {
  /** Content to render inside the effect container */
  children: ReactNode;
  /** Called when the press animation completes */
  onPressComplete?: () => void;
  /** Duration of the ripple animation in ms */
  duration?: number;
  /**
   * Color of the ripple effect. Defaults to the active theme's foreground at
   * 30% — an ink splash on Stub's paper, a light splash on Ember's navy.
   */
  rippleColor?: string;
  /** Whether the effect is disabled */
  disabled?: boolean;
}

/**
 * Wraps content with a fluid press animation effect.
 * When pressed, creates a radial "splash" that expands from the press point.
 */
export const FluidPressEffect = memo<FluidPressEffectProps>(
  ({
    children,
    onPressComplete,
    duration = 400,
    rippleColor: rippleColorProp,
    disabled = false,
    ...containerProps
  }) => {
    const theme = useTheme();
    // The ripple overlays caller-supplied content, so the only surface-agnostic
    // default is the active theme's own foreground. A raw white (the previous
    // default) was authored for Ember and is invisible on the shipped Stub paper.
    const rippleColor =
      rippleColorProp ??
      hexToRgba(theme.color?.val ?? stubTheme.color, RIPPLE_ALPHA);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [ripple, setRipple] = useState<RippleState>({
      active: false,
      x: 50,
      y: 50,
      scale: 0,
    });

    const handlePress = useCallback(
      (event: unknown) => {
        if (disabled || !isWeb) {
          onPressComplete?.();
          return;
        }

        // Extract click coordinates
        const mouseEvent = event as React.MouseEvent | React.TouchEvent;
        const container = containerRef.current;
        if (!container) {
          onPressComplete?.();
          return;
        }

        const rect = container.getBoundingClientRect();
        let clientX: number;
        let clientY: number;

        if ("touches" in mouseEvent && mouseEvent.touches.length > 0) {
          clientX = mouseEvent.touches[0]!.clientX;
          clientY = mouseEvent.touches[0]!.clientY;
        } else if ("clientX" in mouseEvent) {
          clientX = mouseEvent.clientX;
          clientY = mouseEvent.clientY;
        } else {
          // Fallback to center
          clientX = rect.left + rect.width / 2;
          clientY = rect.top + rect.height / 2;
        }

        // Calculate position as percentage
        const x = ((clientX - rect.left) / rect.width) * 100;
        const y = ((clientY - rect.top) / rect.height) * 100;

        // Calculate scale needed to cover entire container from click point
        const maxDistX = Math.max(x, 100 - x);
        const maxDistY = Math.max(y, 100 - y);
        const maxDist = Math.sqrt(maxDistX ** 2 + maxDistY ** 2);
        const scale = (maxDist / 50) * 1.5; // 1.5x overshoot for smooth coverage

        setRipple({ active: true, x, y, scale: 0 });

        // Trigger animation
        requestAnimationFrame(() => {
          setRipple({ active: true, x, y, scale });
        });

        // Complete after animation
        setTimeout(() => {
          setRipple({ active: false, x: 50, y: 50, scale: 0 });
          onPressComplete?.();
        }, duration);
      },
      [disabled, duration, onPressComplete],
    );

    // For native, just pass through without animation (could use Reanimated later)
    if (!isWeb) {
      return (
        <EffectContainer {...containerProps} onPress={onPressComplete}>
          {children}
        </EffectContainer>
      );
    }

    const rippleStyle: React.CSSProperties = {
      background: `radial-gradient(circle at ${ripple.x}% ${ripple.y}%, ${rippleColor} 0%, transparent 70%)`,
      transform: `scale(${ripple.scale})`,
      opacity: ripple.active ? 1 : 0,
      transition: ripple.active
        ? `transform ${duration}ms cubic-bezier(0.22, 1, 0.36, 1), opacity ${duration * 0.3}ms ease-out`
        : "opacity 150ms ease-out",
    };

    return (
      <EffectContainer
        {...containerProps}
        ref={containerRef as any}
        onPress={handlePress}
        cursor={disabled ? undefined : "pointer"}
      >
        {children}
        <RippleLayer style={rippleStyle} />
      </EffectContainer>
    );
  },
);

FluidPressEffect.displayName = "FluidPressEffect";
