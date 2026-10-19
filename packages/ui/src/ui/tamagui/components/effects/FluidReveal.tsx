"use client";

/**
 * FluidReveal - A cross-platform fluid reveal animation.
 *
 * On native (iOS/Android): Uses react-native-reanimated for smooth 60fps animations
 * with multiple expanding circles that create a fluid/ripple effect.
 *
 * On web: Uses CSS animations with SVG filters for a metaball-like merging effect.
 */
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Platform,
  Pressable,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withDelay,
  runOnJS,
  Easing,
} from "react-native-reanimated";
import * as ReanimatedModule from "react-native-reanimated";
import { Stack, styled, useTheme, type GetProps } from "tamagui";

import { stubTheme } from "../../tokens/colors";
import { hexToRgba } from "../shared";

const isWeb = Platform.OS === "web";
const isNative = !isWeb;

/** Alphas for the default, theme-derived ripple tint (native / web). */
const NATIVE_RIPPLE_ALPHA = 0.4;
const WEB_RIPPLE_ALPHA = 0.35;

const EffectContainer = styled(Stack, {
  name: "FluidRevealContainer",
  position: "relative",
  overflow: "hidden",
});

// Number of ripple circles for native animation
const DEFAULT_RIPPLE_COUNT = 5;

export interface FluidRevealProps extends Omit<
  GetProps<typeof EffectContainer>,
  "onPress"
> {
  /** Content to render inside the effect container */
  children: ReactNode;
  /** Called when the reveal animation completes */
  onRevealComplete?: () => void;
  /** Total duration of the animation in ms */
  duration?: number;
  /**
   * Primary color of the fluid effect. Defaults to the active theme's
   * foreground at a low alpha — ink on Stub's paper, light on Ember's navy.
   */
  rippleColor?: string;
  /** Whether the effect is disabled */
  disabled?: boolean;
  /** Test ID for automation */
  testID?: string;
  /**
   * External control for triggering the animation (alternative to internal press handling).
   * When true, starts the animation from the center of the component.
   */
  isActive?: boolean;
  /**
   * Number of ripple circles to render (native only).
   * @default 5
   */
  circleCount?: number;
  /**
   * Alias for rippleColor to match other effect components.
   * If both are provided, revealColor takes precedence.
   */
  revealColor?: string;
}

// Individual ripple circle component using Reanimated
const RippleCircle = memo(
  ({
    index,
    centerX,
    centerY,
    containerSize,
    isActive,
    duration,
    color,
  }: {
    index: number;
    centerX: number;
    centerY: number;
    containerSize: { width: number; height: number };
    isActive: boolean;
    duration: number;
    color: string;
  }) => {
    const scale = useSharedValue(0);
    const opacity = useSharedValue(0);

    // Calculate max scale needed to cover entire container from center point
    const maxDistX = Math.max(centerX, containerSize.width - centerX);
    const maxDistY = Math.max(centerY, containerSize.height - centerY);
    const maxDist = Math.sqrt(maxDistX ** 2 + maxDistY ** 2);
    const baseSize = 60; // Base circle diameter
    const maxScale = (maxDist * 2.2) / baseSize; // Scale to cover + overshoot

    // Stagger delay based on index
    const delay = index * (duration / (DEFAULT_RIPPLE_COUNT * 2));

    // Trigger animation when active changes
    if (isActive) {
      scale.value = withDelay(
        delay,
        withTiming(maxScale * (1 + index * 0.15), {
          duration: duration,
          easing: Easing.out(Easing.cubic),
        }),
      );
      opacity.value = withDelay(
        delay,
        ReanimatedModule.withSequence(
          withTiming(0.6 - index * 0.08, { duration: duration * 0.3 }),
          withTiming(0, { duration: duration * 0.7 }),
        ),
      );
    } else {
      scale.value = 0;
      opacity.value = 0;
    }

    const animatedStyle = useAnimatedStyle(() => ({
      transform: [{ scale: scale.value }],
      opacity: opacity.value,
    }));

    return (
      <Animated.View
        style={[
          nativeStyles.ripple,
          {
            left: centerX - baseSize / 2,
            top: centerY - baseSize / 2,
            width: baseSize,
            height: baseSize,
            backgroundColor: color,
          },
          animatedStyle,
        ]}
        pointerEvents="none"
      />
    );
  },
);

RippleCircle.displayName = "RippleCircle";

/**
 * Native implementation using Reanimated
 */
const NativeFluidReveal = memo<FluidRevealProps>(
  ({
    children,
    onRevealComplete,
    duration = 450,
    rippleColor: rippleColorProp,
    revealColor,
    disabled = false,
    isActive: externalIsActive,
    circleCount = DEFAULT_RIPPLE_COUNT,
    testID,
    ...containerProps
  }) => {
    const theme = useTheme();
    // The ripple overlays caller-supplied content, so the only surface-agnostic
    // default is the active theme's own foreground. A raw white (the previous
    // default) was authored for Ember and is invisible on the shipped Stub paper.
    // revealColor takes precedence over rippleColor for API consistency.
    const rippleColor =
      revealColor ??
      rippleColorProp ??
      hexToRgba(theme.color?.val ?? stubTheme.color, NATIVE_RIPPLE_ALPHA);

    const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
    const [pressPoint, setPressPoint] = useState({ x: 0, y: 0 });
    const [isAnimating, setIsAnimating] = useState(false);
    const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const wasExternallyActivatedRef = useRef(false);

    const handleLayout = useCallback((event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout;
      setContainerSize({ width, height });
    }, []);

    // Handle external isActive changes
    useEffect(() => {
      if (
        externalIsActive &&
        !wasExternallyActivatedRef.current &&
        !isAnimating &&
        !disabled
      ) {
        // Start animation from center when externally activated
        setPressPoint({
          x: containerSize.width / 2,
          y: containerSize.height / 2,
        });
        setIsAnimating(true);
        wasExternallyActivatedRef.current = true;

        // Schedule completion
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }
        timeoutRef.current = setTimeout(() => {
          setIsAnimating(false);
          onRevealComplete?.();
        }, duration);
      } else if (!externalIsActive && wasExternallyActivatedRef.current) {
        // Reset when external activation ends
        wasExternallyActivatedRef.current = false;
      }
    }, [
      containerSize.height,
      containerSize.width,
      disabled,
      duration,
      externalIsActive,
      isAnimating,
      onRevealComplete,
    ]);

    const handlePressIn = useCallback(
      (event: GestureResponderEvent) => {
        // Skip internal press handling if externally controlled
        if (externalIsActive !== undefined || disabled || isAnimating) return;

        const { locationX, locationY } = event.nativeEvent;
        setPressPoint({ x: locationX, y: locationY });
        setIsAnimating(true);

        // Schedule completion
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
        }
        timeoutRef.current = setTimeout(() => {
          setIsAnimating(false);
          onRevealComplete?.();
        }, duration);
      },
      [disabled, duration, externalIsActive, isAnimating, onRevealComplete],
    );

    const handlePress = useCallback(() => {
      // Press is handled by pressIn for the animation
      // This just ensures the callback fires if animation hasn't started
      if (!isAnimating && !disabled && externalIsActive === undefined) {
        onRevealComplete?.();
      }
    }, [disabled, externalIsActive, isAnimating, onRevealComplete]);

    return (
      <EffectContainer {...containerProps} onLayout={handleLayout}>
        <Pressable
          onPressIn={handlePressIn}
          onPress={handlePress}
          disabled={disabled || externalIsActive !== undefined}
          testID={testID}
          style={nativeStyles.pressable}
        >
          {children}
          <View style={nativeStyles.rippleContainer} pointerEvents="none">
            {isAnimating &&
              containerSize.width > 0 &&
              Array.from({ length: circleCount }).map((_, index) => (
                <RippleCircle
                  key={index}
                  index={index}
                  centerX={pressPoint.x}
                  centerY={pressPoint.y}
                  containerSize={containerSize}
                  isActive={isAnimating}
                  duration={duration}
                  color={rippleColor}
                />
              ))}
          </View>
        </Pressable>
      </EffectContainer>
    );
  },
);

NativeFluidReveal.displayName = "NativeFluidReveal";

/**
 * Web implementation using CSS animations
 */
const WebFluidReveal = memo<FluidRevealProps>(
  ({
    children,
    onRevealComplete,
    duration = 450,
    rippleColor: rippleColorProp,
    revealColor,
    disabled = false,
    isActive: externalIsActive,
    // circleCount is not used on web but accepted for API compatibility
    circleCount: _circleCount,
    ...containerProps
  }) => {
    const theme = useTheme();
    // The ripple overlays caller-supplied content, so the only surface-agnostic
    // default is the active theme's own foreground. A raw white (the previous
    // default) was authored for Ember and is invisible on the shipped Stub paper.
    // revealColor takes precedence over rippleColor for API consistency.
    const rippleColor =
      revealColor ??
      rippleColorProp ??
      hexToRgba(theme.color?.val ?? stubTheme.color, WEB_RIPPLE_ALPHA);

    const containerRef = useRef<HTMLDivElement | null>(null);
    const [animation, setAnimation] = useState<{
      active: boolean;
      x: number;
      y: number;
    }>({ active: false, x: 50, y: 50 });
    const wasExternallyActivatedRef = useRef(false);

    // Handle external isActive changes
    useEffect(() => {
      if (
        externalIsActive &&
        !wasExternallyActivatedRef.current &&
        !animation.active &&
        !disabled
      ) {
        // Start animation from center when externally activated
        setAnimation({ active: true, x: 50, y: 50 });
        wasExternallyActivatedRef.current = true;

        setTimeout(() => {
          setAnimation({ active: false, x: 50, y: 50 });
          onRevealComplete?.();
        }, duration);
      } else if (!externalIsActive && wasExternallyActivatedRef.current) {
        // Reset when external activation ends
        wasExternallyActivatedRef.current = false;
      }
    }, [
      animation.active,
      disabled,
      duration,
      externalIsActive,
      onRevealComplete,
    ]);

    const handlePress = useCallback(
      (event: unknown) => {
        // Skip internal press handling if externally controlled
        if (externalIsActive !== undefined || disabled) {
          if (externalIsActive === undefined) {
            onRevealComplete?.();
          }
          return;
        }

        const mouseEvent = event as React.MouseEvent | React.TouchEvent;
        const container = containerRef.current;
        if (!container) {
          onRevealComplete?.();
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
          clientX = rect.left + rect.width / 2;
          clientY = rect.top + rect.height / 2;
        }

        const x = ((clientX - rect.left) / rect.width) * 100;
        const y = ((clientY - rect.top) / rect.height) * 100;

        setAnimation({ active: true, x, y });

        setTimeout(() => {
          setAnimation({ active: false, x: 50, y: 50 });
          onRevealComplete?.();
        }, duration);
      },
      [disabled, duration, externalIsActive, onRevealComplete],
    );

    const rippleStyle: React.CSSProperties = animation.active
      ? {
          background: `radial-gradient(circle at ${animation.x}% ${animation.y}%, ${rippleColor} 0%, ${rippleColor} 30%, transparent 70%)`,
          transform: "scale(3)",
          opacity: 0,
          transition: `transform ${duration}ms cubic-bezier(0.22, 1, 0.36, 1), opacity ${duration}ms ease-out`,
        }
      : {
          transform: "scale(0)",
          opacity: 1,
          transition: "none",
        };

    return (
      <EffectContainer
        {...containerProps}
        ref={containerRef as any}
        onPress={externalIsActive === undefined ? handlePress : undefined}
        cursor={
          disabled || externalIsActive !== undefined ? undefined : "pointer"
        }
      >
        {children}
        <div style={{ ...webStyles.rippleLayer, ...rippleStyle }} />
      </EffectContainer>
    );
  },
);

WebFluidReveal.displayName = "WebFluidReveal";

/**
 * Cross-platform FluidReveal component.
 * Automatically uses the appropriate implementation based on platform.
 */
export const FluidReveal = memo<FluidRevealProps>((props) => {
  if (isNative) {
    return <NativeFluidReveal {...props} />;
  }
  return <WebFluidReveal {...props} />;
});

FluidReveal.displayName = "FluidReveal";

// Native styles
const nativeStyles = StyleSheet.create({
  pressable: {
    flex: 1,
  },
  rippleContainer: {
    ...StyleSheet.absoluteFillObject,
    overflow: "hidden",
    pointerEvents: "none",
  },
  ripple: {
    position: "absolute",
    borderRadius: 9999,
  },
});

// Web styles
const webStyles: Record<string, React.CSSProperties> = {
  rippleLayer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    pointerEvents: "none",
    zIndex: 10,
    borderRadius: "inherit",
  },
};
