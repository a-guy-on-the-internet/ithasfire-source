"use client";

import {
  forwardRef,
  type ComponentType,
  type ElementRef,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Platform } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import * as ReanimatedModule from "react-native-reanimated";
import { Stack, styled, type StackProps } from "tamagui";

type EasingFunction = (value: number) => number;

type EasingModule = {
  cubic?: EasingFunction;
  linear?: EasingFunction;
  inOut?: (fn: EasingFunction) => EasingFunction;
  out?: (fn: EasingFunction) => EasingFunction;
};

const identityEasing: EasingFunction = (value) => value;

const resolveEasing = () => {
  const easing = (Easing as unknown as EasingModule) ?? {};

  const base =
    typeof easing.cubic === "function"
      ? easing.cubic
      : typeof easing.linear === "function"
        ? easing.linear
        : identityEasing;

  const ensureFactoryResult = (
    factory?: (fn: EasingFunction) => EasingFunction,
  ): EasingFunction => {
    if (typeof factory !== "function") {
      return identityEasing;
    }
    const result = factory(base);
    return typeof result === "function" ? result : identityEasing;
  };

  return {
    cubic: base,
    inOut: ensureFactoryResult(easing.inOut),
    out: ensureFactoryResult(easing.out),
  } as const;
};

const easingHelpers = resolveEasing();

const clamp = (value: number, min: number, max: number) => {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
};

const toPercent = (value: number, min: number, max: number) => {
  if (max <= min) {
    return 0;
  }
  return ((value - min) / (max - min)) * 100;
};

const Track = styled(Stack, {
  name: "IthasFireProgressBarTrack",
  width: "100%",
  backgroundColor: "$surfaceMuted",
  overflow: "hidden",
  borderRadius: 0,
  position: "relative",
});

const FillBase = styled(Stack, {
  name: "IthasFireProgressBarFill",
  position: "absolute",
  top: 0,
  bottom: 0,
  left: 0,
  backgroundColor: "$accent",
  borderRadius: 0,
});

const makeAnimatedComponent = <T extends ComponentType<any>>(Component: T): T =>
  ((
    Animated as unknown as {
      createAnimatedComponent?: (component: T) => ComponentType<any>;
    }
  ).createAnimatedComponent?.(Component) ?? Component) as T;

const AnimatedFill = makeAnimatedComponent(FillBase);

const FALLBACK_BAR_ANIMATION_NAME = "th-progress-bar-indeterminate";

const ensureProgressBarFallbackKeyframes = (() => {
  let inserted = false;
  return () => {
    if (inserted || typeof document === "undefined") {
      return;
    }
    if (document.getElementById("th-progress-bar-fallback-style")) {
      inserted = true;
      return;
    }
    const styleElement = document.createElement("style");
    styleElement.id = "th-progress-bar-fallback-style";
    styleElement.textContent = `@keyframes ${FALLBACK_BAR_ANIMATION_NAME} { 0% { left: -40%; width: 35%; } 50% { left: 110%; width: 35%; } 100% { left: -40%; width: 35%; } }`;
    document.head.appendChild(styleElement);
    inserted = true;
  };
})();

export type ProgressBarSize = "sm" | "md" | "lg";

export type ProgressBarVariant = "determinate" | "indeterminate";

export type ProgressBarProps = Omit<StackProps, "children"> & {
  value?: number;
  min?: number;
  max?: number;
  variant?: ProgressBarVariant;
  size?: ProgressBarSize;
  durationMs?: number;
  reducedMotion?: boolean;
  fillColor?: string;
  trackColor?: string;
  testID?: string;
  qaId?: string;
};

const sizeStyles: Record<ProgressBarSize, StackProps> = {
  sm: {
    height: "$1",
  },
  md: {
    height: "$2",
  },
  lg: {
    height: "$3",
  },
};

export const ProgressBar = forwardRef<
  ElementRef<typeof Track>,
  ProgressBarProps
>(
  (
    {
      value = 0,
      min = 0,
      max = 100,
      variant = "determinate",
      size = "md",
      durationMs = 360,
      reducedMotion = false,
      fillColor,
      trackColor,
      qaId = "progress-bar",
      testID = "progress-bar",
      ...rest
    },
    ref,
  ) => {
    const initialPercent = useMemo(
      () => toPercent(clamp(value, min, max), min, max),
      [value, min, max],
    );
    const determinateProgress = useSharedValue(initialPercent);
    const indeterminateOffset = useSharedValue(-40);
    const withRepeatFn = ReanimatedModule.withRepeat;
    const cancelAnimationFn = ReanimatedModule.cancelAnimation;
    const hasReanimatedLoop = typeof withRepeatFn === "function";
    const isWeb = Platform.OS === "web";
    const shouldUseReanimatedIndeterminate = hasReanimatedLoop && !isWeb;
    const shouldUseReanimatedDeterminate = !isWeb;
    const [webDeterminatePercent, setWebDeterminatePercent] =
      useState(initialPercent);

    useEffect(() => {
      if (variant === "indeterminate") {
        if (reducedMotion) {
          indeterminateOffset.value = 0;
          return () => {
            indeterminateOffset.value = 0;
          };
        }

        if (shouldUseReanimatedIndeterminate) {
          indeterminateOffset.value = -40;

          indeterminateOffset.value = withRepeatFn(
            withTiming(110, {
              duration: durationMs * 3,
              easing: easingHelpers.inOut,
            }),
            -1,
            false,
          );

          return () => {
            if (typeof cancelAnimationFn === "function") {
              cancelAnimationFn(indeterminateOffset);
            }
            indeterminateOffset.value = -40;
          };
        }

        if (isWeb) {
          ensureProgressBarFallbackKeyframes();
          indeterminateOffset.value = -40;
          return () => {
            indeterminateOffset.value = -40;
          };
        }

        let cancelled = false;

        const animate = () => {
          if (cancelled) {
            return;
          }
          indeterminateOffset.value = -40;
          indeterminateOffset.value = withTiming(110, {
            duration: durationMs * 3,
            easing: easingHelpers.inOut,
          });
        };

        animate();
        const interval = setInterval(animate, durationMs * 3);

        return () => {
          cancelled = true;
          clearInterval(interval);
          indeterminateOffset.value = -40;
        };
      }

      const nextPercent = toPercent(clamp(value, min, max), min, max);
      if (reducedMotion) {
        determinateProgress.value = nextPercent;
        setWebDeterminatePercent(nextPercent);
        return;
      }

      if (shouldUseReanimatedDeterminate) {
        determinateProgress.value = withTiming(nextPercent, {
          duration: durationMs,
          easing: easingHelpers.out,
        });
      } else {
        determinateProgress.value = nextPercent;
        setWebDeterminatePercent(nextPercent);
      }
    }, [
      variant,
      value,
      min,
      max,
      determinateProgress,
      indeterminateOffset,
      reducedMotion,
      durationMs,
      shouldUseReanimatedIndeterminate,
      cancelAnimationFn,
      withRepeatFn,
      isWeb,
      shouldUseReanimatedDeterminate,
    ]);

    const determinateStyle = useAnimatedStyle(() => {
      "worklet";
      return {
        width: `${Math.max(0, Math.min(100, determinateProgress.value))}%`,
      };
    });

    const indeterminateStyle = useAnimatedStyle(() => {
      "worklet";
      return {
        width: "35%",
        left: `${indeterminateOffset.value}%`,
      };
    });

    const fallbackIndeterminateStyle: StackProps["style"] | null =
      variant === "indeterminate" &&
      !reducedMotion &&
      isWeb &&
      !shouldUseReanimatedIndeterminate
        ? ({
            width: "35%",
            left: "-40%",
            animation: `${FALLBACK_BAR_ANIMATION_NAME} ${durationMs * 3}ms ease-in-out infinite`,
          } as unknown as StackProps["style"])
        : null;

    const fallbackDeterminateStyle: StackProps["style"] | null =
      variant === "determinate" && (!shouldUseReanimatedDeterminate || isWeb)
        ? ({
            width: `${Math.max(0, Math.min(100, webDeterminatePercent))}%`,
            transition: reducedMotion
              ? undefined
              : `width ${durationMs}ms ease-out`,
          } as unknown as StackProps["style"])
        : null;

    const accessibilityProps = useMemo(() => {
      if (variant === "indeterminate") {
        if (Platform.OS === "web") {
          return {
            role: "progressbar",
            "aria-valuemin": undefined,
            "aria-valuemax": undefined,
            "aria-valuenow": undefined,
            "aria-busy": true,
          } as const;
        }
        return {
          accessibilityRole: "progressbar" as const,
          accessibilityState: { busy: true },
        };
      }

      const clampedValue = clamp(value, min, max);
      if (Platform.OS === "web") {
        return {
          role: "progressbar",
          "aria-valuemin": min,
          "aria-valuemax": max,
          "aria-valuenow": clampedValue,
        } as const;
      }

      return {
        accessibilityRole: "progressbar" as const,
        accessibilityValue: { min, max, now: clampedValue },
      };
    }, [variant, value, min, max]);

    return (
      <Track
        ref={ref}
        {...sizeStyles[size]}
        backgroundColor={trackColor ?? "$surfaceMuted"}
        data-testid={Platform.OS === "web" ? testID : undefined}
        data-qa={Platform.OS === "web" ? qaId : undefined}
        testID={Platform.OS !== "web" ? testID : undefined}
        {...accessibilityProps}
        {...rest}
      >
        {isWeb ? (
          // Web: skip the reanimated wrapper entirely and render a plain
          // FillBase with a single merged style object. The reanimated
          // wrapper trips Next 16 / Turbopack into trying to set indexed
          // properties on the underlying `<div>` ("Cannot set indexed
          // properties on this object"). CSS keyframes (indeterminate)
          // and a `transition: width` (determinate) drive the animation
          // — reanimated isn't needed on web at all.
          <FillBase
            backgroundColor={fillColor ?? "$accent"}
            style={
              {
                ...(fallbackIndeterminateStyle as object | null),
                ...(fallbackDeterminateStyle as object | null),
              } as StackProps["style"]
            }
          />
        ) : (
          <AnimatedFill
            backgroundColor={fillColor ?? "$accent"}
            style={[
              variant === "determinate" && shouldUseReanimatedDeterminate
                ? determinateStyle
                : null,
              variant === "indeterminate" &&
              !reducedMotion &&
              shouldUseReanimatedIndeterminate
                ? indeterminateStyle
                : null,
            ]}
          />
        )}
      </Track>
    );
  },
);

ProgressBar.displayName = "ProgressBar";
