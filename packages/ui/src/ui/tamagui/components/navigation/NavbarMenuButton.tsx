"use client";

import React, { forwardRef, useCallback, useEffect, useMemo } from "react";
import { Platform } from "react-native";
import {
  Stack,
  YStack,
  styled,
  type StackProps,
  type TamaguiElement,
} from "tamagui";
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { Button, type ButtonProps, type ButtonSize } from "../forms/Button";

const isWeb = Platform.OS === "web";

const ICON_SIZE = 24;
const LINE_WIDTH = 20;
const LINE_HEIGHT = 2;
const LINE_HORIZONTAL_OFFSET = (ICON_SIZE - LINE_WIDTH) / 2;
const LINE_VERTICAL_CENTER = ICON_SIZE / 2 - LINE_HEIGHT / 2;

const LINE_TRANSLATE_OFFSET = 6;
const ANIMATION_DURATION_MS = 220;
const GLYPH_TEST_ID = "navbar-menu-button-glyph";

const IconFrame = styled(Stack, {
  name: "NavbarMenuIconFrame",
  width: ICON_SIZE,
  height: ICON_SIZE,
  alignItems: "center",
  justifyContent: "center",
  position: "relative",
});

const IconLine = styled(Stack, {
  name: "NavbarMenuIconLine",
  position: "absolute",
  width: LINE_WIDTH,
  height: LINE_HEIGHT,
  borderRadius: 0,
  backgroundColor: "$color",
  top: LINE_VERTICAL_CENTER,
  left: LINE_HORIZONTAL_OFFSET,
});

// DIAG: defer createAnimatedComponent for module-init safety on RN.
const AnimatedIconLine = (
  (
    Animated as unknown as {
      createAnimatedComponent?: (c: unknown) => React.ComponentType<unknown>;
    }
  )?.createAnimatedComponent?.(IconLine) ?? IconLine
) as typeof IconLine;
if (typeof console !== "undefined" && !(Animated as unknown as { createAnimatedComponent?: unknown })?.createAnimatedComponent) {
  // eslint-disable-next-line no-console
  console.warn("[diag NavbarMenuButton] Animated.createAnimatedComponent undefined");
}

const MenuGlyph = ({
  open,
  iconProps,
}: {
  open: boolean;
  iconProps?: Partial<StackProps>;
}) => {
  const resolvedIconProps = useMemo(() => iconProps ?? {}, [iconProps]);
  const progress = useSharedValue(open ? 1 : 0);

  useEffect(() => {
    progress.value = withTiming(open ? 1 : 0, {
      duration: ANIMATION_DURATION_MS,
      easing: Easing.out(Easing.cubic),
    });
  }, [open, progress]);

  const topLineStyle = useAnimatedStyle(() => {
    "worklet";
    const translateY = interpolate(
      progress.value,
      [0, 1],
      [-LINE_TRANSLATE_OFFSET, 0],
    );
    const rotation = interpolate(progress.value, [0, 1], [0, 45]);

    return {
      transform: [{ translateY }, { rotate: `${rotation}deg` }],
    };
  });

  const middleLineStyle = useAnimatedStyle(() => {
    "worklet";
    const opacity = interpolate(progress.value, [0, 1], [1, 0]);
    const scaleX = interpolate(progress.value, [0, 1], [1, 0.75]);

    return {
      opacity,
      transform: [{ scaleX }],
    };
  });

  const bottomLineStyle = useAnimatedStyle(() => {
    "worklet";
    const translateY = interpolate(
      progress.value,
      [0, 1],
      [LINE_TRANSLATE_OFFSET, 0],
    );
    const rotation = interpolate(progress.value, [0, 1], [0, -45]);

    return {
      transform: [{ translateY }, { rotate: `${rotation}deg` }],
    };
  });

  const automationProps = isWeb
    ? ({ "data-testid": GLYPH_TEST_ID } as const)
    : ({
        testID: GLYPH_TEST_ID,
        accessibilityState: { expanded: open },
      } as const);

  return (
    <IconFrame
      {...automationProps}
      {...(resolvedIconProps as Record<string, unknown>)}
      {...(isWeb ? ({ "data-state": open ? "open" : "closed" } as const) : {})}
    >
      <AnimatedIconLine style={topLineStyle} />
      <AnimatedIconLine style={middleLineStyle} />
      <AnimatedIconLine style={bottomLineStyle} />
    </IconFrame>
  );
};

export interface NavbarMenuButtonProps extends Omit<
  ButtonProps,
  "children" | "variant" | "size" | "icon"
> {
  open?: boolean;
  label?: string;
  iconProps?: Partial<StackProps>;
  onToggle?: (nextOpen: boolean) => void;
  buttonSize?: ButtonSize;
}

export const NavbarMenuButton = forwardRef<
  TamaguiElement,
  NavbarMenuButtonProps
>(
  (
    {
      open = false,
      label,
      iconProps,
      onToggle,
      onPress,
      accessibilityLabel,
      buttonSize = "$2",
      ...buttonProps
    },
    ref,
  ) => {
    const handlePress = useCallback<NonNullable<ButtonProps["onPress"]>>(
      (event) => {
        onToggle?.(!open);
        onPress?.(event);
      },
      [onPress, onToggle, open],
    );

    const resolvedLabel =
      label ?? (open ? "Close navigation" : "Open navigation");
    const expandedProps = isWeb
      ? ({ "aria-expanded": open } as const)
      : ({ accessibilityState: { expanded: open } } as const);

    return (
      <Button
        ref={ref}
        variant="ghost"
        size={buttonSize}
        icon
        {...expandedProps}
        accessibilityRole={!isWeb ? "button" : undefined}
        accessibilityLabel={accessibilityLabel ?? resolvedLabel}
        onPress={handlePress}
        {...(buttonProps as Record<string, unknown>)}
      >
        <MenuGlyph open={open} iconProps={iconProps} />
      </Button>
    );
  },
);

NavbarMenuButton.displayName = "NavbarMenuButton";
