import { forwardRef } from "react";
import { Platform } from "react-native";
import { Stack, type StackProps, type TamaguiElement } from "tamagui";

import { colorTokens, type ColorTokenName } from "../../tokens/colors";

export type SeparatorOrientation = "horizontal" | "vertical";

export type SeparatorProps = Omit<StackProps, "children"> & {
  orientation?: SeparatorOrientation;
  thickness?: number;
  colorToken?: ColorTokenName;
  qaId?: string;
  testId?: string;
};

const DEFAULT_THICKNESS = 1;

export const Separator = forwardRef<TamaguiElement, SeparatorProps>(
  (
    {
      orientation = "horizontal",
      thickness = DEFAULT_THICKNESS,
      colorToken,
      qaId = "separator",
      testId = "separator",
      backgroundColor: backgroundColorProp,
      width: providedWidth,
      height: providedHeight,
      style,
      ...rest
    },
    ref,
  ) => {
    const tokenColor = colorToken ? colorTokens.color[colorToken] : undefined;
    const resolvedLineColor =
      backgroundColorProp ?? tokenColor ?? "$borderColor";
    const isVertical = orientation === "vertical";
    const resolvedThickness = thickness ?? DEFAULT_THICKNESS;

    const width = providedWidth ?? (isVertical ? resolvedThickness : "100%");
    const height = providedHeight ?? (isVertical ? "100%" : resolvedThickness);
    const resolvedBackgroundColor = resolvedLineColor;

    const automationProps = Platform.select({
      web: {
        role: "presentation" as const,
        "aria-hidden": true,
        ...(testId ? { "data-testid": testId } : {}),
        ...(qaId ? { "data-qa": qaId } : {}),
      },
      default: {
        testID: testId,
        accessible: false,
        accessibilityRole: "none" as const,
        importantForAccessibility: "no-hide-descendants" as const,
      },
    });

    return (
      <Stack
        ref={ref}
        {...rest}
        {...automationProps}
        width={width}
        height={height}
        backgroundColor={resolvedBackgroundColor}
        flexShrink={rest.flexShrink ?? 0}
        style={style}
      />
    );
  },
);

Separator.displayName = "Separator";
