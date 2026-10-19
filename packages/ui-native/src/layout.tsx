import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";

/**
 * `Column` / `Row` — plain flex stacks.
 *
 * These exist for exactly one reason (FR-009): three scanner screens imported
 * `YStack` from `tamagui` purely to get a gapped vertical stack, which made the
 * scan surfaces straddle two layout systems for no benefit. React Native ≥0.71
 * supports `gap` natively, so a `View` does the whole job with none of the
 * Tamagui prop-resolution cost on a hot screen.
 *
 * `gap` is a NUMBER here, not a `$token`. That is deliberate: Tamagui's space
 * scale is integer-only, and a fractional token silently resolves to a 0 gap
 * (project memory: "fractional space-token bug"). A number cannot lie.
 *
 * `packages/ui-native/src/primitives.tsx` still imports Tamagui — that is the
 * design-system layer wrapping it, i.e. the boundary, not a violation.
 */

type StackProps = {
  children?: ReactNode;
  /** Space between children, in points. */
  gap?: number;
  /** `flex: 1` when true; a number sets the flex factor directly. */
  flex?: boolean | number;
  align?: ViewStyle["alignItems"];
  justify?: ViewStyle["justifyContent"];
  /** Uniform padding, in points. */
  pad?: number;
  /**
   * `pin="bottom"` = `marginTop: "auto"` — pushes this stack to the bottom of
   * its parent even when the content above doesn't fill the screen, and keeps
   * it from being pushed off-screen when the content overflows.
   */
  pin?: "bottom";
  wrap?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityRole?: "none" | "summary" | "alert";
  accessibilityLiveRegion?: "none" | "polite" | "assertive";
};

const baseStyle = (
  props: StackProps,
  direction: "column" | "row",
): ViewStyle => ({
  flexDirection: direction,
  ...(props.gap === undefined ? {} : { gap: props.gap }),
  ...(props.flex === undefined
    ? {}
    : {
        flex: props.flex === true ? 1 : props.flex === false ? 0 : props.flex,
      }),
  ...(props.align === undefined ? {} : { alignItems: props.align }),
  ...(props.justify === undefined ? {} : { justifyContent: props.justify }),
  ...(props.pad === undefined ? {} : { padding: props.pad }),
  ...(props.pin === "bottom" ? { marginTop: "auto" as const } : {}),
  ...(props.wrap ? { flexWrap: "wrap" as const } : {}),
});

export const Column = (props: StackProps) => (
  <View
    style={[baseStyle(props, "column"), props.style]}
    testID={props.testID}
    accessibilityRole={props.accessibilityRole}
    accessibilityLiveRegion={props.accessibilityLiveRegion}
  >
    {props.children}
  </View>
);

export const Row = (props: StackProps) => (
  <View
    style={[baseStyle(props, "row"), props.style]}
    testID={props.testID}
    accessibilityRole={props.accessibilityRole}
    accessibilityLiveRegion={props.accessibilityLiveRegion}
  >
    {props.children}
  </View>
);
