"use client";

import { forwardRef, type ElementRef, useEffect } from "react";
import { Platform } from "react-native";
import { Stack, type StackProps } from "tamagui";

// Reanimated is only loaded on native. On web we use a CSS keyframe
// animation (see `ensureSpinnerFallbackKeyframes` below) so the
// `Animated.createAnimatedComponent` wrapper isn't needed — and crucially,
// it stops Next 16 / Turbopack from tripping on the wrapped component
// setting indexed style properties on a raw `<div>` ("Cannot set indexed
// properties on this object"). Native imports are lazy so the web bundle
// never reaches into reanimated at all.
const isWeb = Platform.OS === "web";

type ReanimatedBindings = {
  Animated: typeof import("react-native-reanimated").default;
  Easing: typeof import("react-native-reanimated").Easing;
  useAnimatedStyle: typeof import("react-native-reanimated").useAnimatedStyle;
  useSharedValue: typeof import("react-native-reanimated").useSharedValue;
  withTiming: typeof import("react-native-reanimated").withTiming;
  withRepeat: typeof import("react-native-reanimated").withRepeat;
  cancelAnimation: typeof import("react-native-reanimated").cancelAnimation;
};

const reanimated: ReanimatedBindings | null = isWeb
  ? null
  : (require("react-native-reanimated") as ReanimatedBindings);

const AnimatedSpinner = (() => {
  if (isWeb || !reanimated) return Stack;
  // CommonJS interop: `require("react-native-reanimated")` gives an object
  // whose `default` key holds the Animated namespace; `.Animated` itself
  // is undefined. Reach through `default` first, then fall back to a top
  // level `createAnimatedComponent` named export if the underlying module
  // shape ever changes again. Optional chaining throughout so any partial
  // shape leaves us with the plain Stack rather than crashing module init.
  const bridge = reanimated as unknown as {
    Animated?: { createAnimatedComponent?: (c: typeof Stack) => typeof Stack };
    default?: { createAnimatedComponent?: (c: typeof Stack) => typeof Stack };
    createAnimatedComponent?: (c: typeof Stack) => typeof Stack;
  };
  const create =
    bridge.Animated?.createAnimatedComponent ??
    bridge.default?.createAnimatedComponent ??
    bridge.createAnimatedComponent;
  return (create?.(Stack) ?? Stack) as typeof Stack;
})();

type CanonicalSpinnerSize = "sm" | "md" | "lg";

export type SpinnerSize = CanonicalSpinnerSize | "small" | "medium" | "large";

type SpinnerSizeConfig = {
  dimension: number;
  stroke: number;
};

const sizeConfig: Record<CanonicalSpinnerSize, SpinnerSizeConfig> = {
  sm: { dimension: 16, stroke: 2 },
  md: { dimension: 24, stroke: 3 },
  lg: { dimension: 36, stroke: 4 },
};

const normalizeSpinnerSize = (
  size: string | undefined,
): CanonicalSpinnerSize => {
  switch (size) {
    case "sm":
    case "small":
      return "sm";
    case "lg":
    case "large":
      return "lg";
    case "md":
    case "medium":
    default:
      return "md";
  }
};

const FALLBACK_ANIMATION_NAME = "th-spinner-rotate";

const ensureSpinnerFallbackKeyframes = (() => {
  let inserted = false;
  return () => {
    if (inserted || typeof document === "undefined") {
      return;
    }
    if (document.getElementById("th-spinner-fallback-style")) {
      inserted = true;
      return;
    }
    const styleElement = document.createElement("style");
    styleElement.id = "th-spinner-fallback-style";
    styleElement.textContent = `@keyframes ${FALLBACK_ANIMATION_NAME} { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`;
    document.head.appendChild(styleElement);
    inserted = true;
  };
})();

export type SpinnerProps = Omit<
  StackProps,
  "children" | "accessibilityLabel"
> & {
  size?: SpinnerSize;
  trackColor?: string;
  indicatorColor?: string;
  durationMs?: number;
  reducedMotion?: boolean;
  qaId?: string;
  testID?: string;
  screenReaderLabel?: string;
  /**
   * @deprecated use `screenReaderLabel` instead to avoid deprecated RN prop usage.
   */
  accessibilityLabel?: string;
};

export const Spinner = forwardRef<ElementRef<typeof Stack>, SpinnerProps>(
  (
    {
      size = "md",
      trackColor = "$surfaceMuted",
      indicatorColor = "$accent",
      durationMs = 900,
      reducedMotion = false,
      qaId = "spinner",
      testID = "spinner",
      style: styleProp,
      screenReaderLabel,
      accessibilityLabel: deprecatedAccessibilityLabel,
      ...stackProps
    },
    ref,
  ) => {
    const { dimension, stroke } = sizeConfig[normalizeSpinnerSize(size)];

    // Web: lean on CSS keyframes, skip reanimated entirely so the wrapper
    //      doesn't try to set indexed style props on a `<div>` under Next
    //      16 / Turbopack.
    // Native: reanimated drives the rotation via shared values + worklet.
    if (isWeb) {
      // Ensure keyframes exist before first paint. Safe to call repeatedly —
      // the helper short-circuits if the <style> node is already in the DOM.
      // eslint-disable-next-line react-hooks/rules-of-hooks
      useEffect(() => {
        if (!reducedMotion) ensureSpinnerFallbackKeyframes();
      }, [reducedMotion]);

      const resolvedLabel =
        screenReaderLabel ?? deprecatedAccessibilityLabel ?? qaId;

      return (
        <Stack
          ref={ref}
          role="status"
          aria-live="polite"
          aria-label={resolvedLabel}
          data-testid={testID}
          data-qa={qaId}
          {...stackProps}
          width={stackProps.width ?? dimension}
          height={stackProps.height ?? dimension}
          borderRadius={stackProps.borderRadius ?? dimension / 2}
          borderWidth={stackProps.borderWidth ?? stroke}
          borderColor={stackProps.borderColor ?? trackColor}
          borderTopColor={stackProps.borderTopColor ?? indicatorColor}
          borderRightColor={stackProps.borderRightColor ?? trackColor}
          borderLeftColor={stackProps.borderLeftColor ?? trackColor}
          borderBottomColor={stackProps.borderBottomColor ?? trackColor}
          style={
            {
              display: "flex",
              ...(reducedMotion
                ? null
                : {
                    animation: `${FALLBACK_ANIMATION_NAME} ${durationMs}ms linear infinite`,
                  }),
              ...(styleProp as object | null | undefined),
            } as StackProps["style"]
          }
        />
      );
    }

    // Native code path — relies on reanimated. Imports are guaranteed
    // present here because `reanimated` is non-null when `!isWeb`.
    const { useSharedValue, useAnimatedStyle, withTiming, Easing } =
      reanimated!;
    const withRepeatFn = reanimated!.withRepeat;
    const cancelAnimationFn = reanimated!.cancelAnimation;

    const rotation = useSharedValue(0);

    useEffect(() => {
      if (reducedMotion) {
        rotation.value = 0;
        return () => {
          rotation.value = 0;
        };
      }
      rotation.value = 0;
      rotation.value = withRepeatFn(
        withTiming(360, { duration: durationMs, easing: Easing.linear }),
        -1,
        false,
      );
      return () => {
        cancelAnimationFn?.(rotation);
        rotation.value = 0;
      };
    }, [
      Easing,
      cancelAnimationFn,
      durationMs,
      reducedMotion,
      rotation,
      withRepeatFn,
      withTiming,
    ]);

    const animatedStyle = useAnimatedStyle(() => {
      "worklet";
      return {
        transform: [{ rotate: `${rotation.value}deg` }],
      };
    });

    const resolvedLabel =
      screenReaderLabel ?? deprecatedAccessibilityLabel ?? qaId;

    return (
      <AnimatedSpinner
        ref={ref}
        testID={testID}
        accessibilityRole="progressbar"
        accessibilityLabel={resolvedLabel}
        accessibilityState={{ busy: true }}
        {...stackProps}
        width={stackProps.width ?? dimension}
        height={stackProps.height ?? dimension}
        borderRadius={stackProps.borderRadius ?? dimension / 2}
        borderWidth={stackProps.borderWidth ?? stroke}
        borderColor={stackProps.borderColor ?? trackColor}
        borderTopColor={stackProps.borderTopColor ?? indicatorColor}
        borderRightColor={stackProps.borderRightColor ?? trackColor}
        borderLeftColor={stackProps.borderLeftColor ?? trackColor}
        borderBottomColor={stackProps.borderBottomColor ?? trackColor}
        style={[
          { display: "flex" },
          reducedMotion ? null : animatedStyle,
          styleProp,
        ]}
      />
    );
  },
);

Spinner.displayName = "Spinner";
