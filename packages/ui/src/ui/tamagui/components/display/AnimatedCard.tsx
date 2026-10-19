"use client";

import { useEffect, useMemo, type PropsWithChildren } from "react";
import { Platform } from "react-native";
import Animated, {
  Easing as ReanimatedEasing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import {
  Button,
  Card,
  CardProps,
  Separator,
  Stack,
  XStack,
  YStack,
} from "tamagui";

import { Text } from "../typography/Text";

const ssrWarnings: Record<string, boolean> = {};

const warnIfServerRendering = (componentName: string) => {
  if (typeof window !== "undefined") {
    return;
  }
  if (ssrWarnings[componentName] || typeof console === "undefined") {
    return;
  }
  // eslint-disable-next-line no-console
  console.warn(
    `[Ithas Fire/UI] ${componentName} must be rendered in a client component. Add "use client" to the consuming module to silence this warning.`,
  );
  ssrWarnings[componentName] = true;
};

export type AnimatedCardProps = PropsWithChildren<
  Omit<CardProps, "children"> & {
    title: string;
    description?: string;
    accentColor?: string;
    actionLabel?: string;
    onActionPress?: () => void;
    active?: boolean;
    reducedMotion?: boolean;
    activeScale?: number;
    inactiveScale?: number;
    activeOpacity?: number;
    inactiveOpacity?: number;
    durationMs?: number;
    testID?: string;
    qaId?: string;
  }
>;

export const AnimatedCard = ({
  children,
  title,
  description,
  accentColor = "$color8",
  actionLabel = "View details",
  onActionPress,
  active = true,
  reducedMotion = false,
  activeScale = 1,
  inactiveScale = 0.94,
  activeOpacity = 1,
  inactiveOpacity = 0.7,
  durationMs = 320,
  testID = "animated-card",
  qaId = "animated-card",
  ...rest
}: AnimatedCardProps) => {
  warnIfServerRendering("AnimatedCard");

  const { accessibilityLabel, ...cardProps } = rest;
  const resolvedAccessibilityLabel = accessibilityLabel ?? qaId;

  const scale = useSharedValue(active ? activeScale : inactiveScale);
  const opacity = useSharedValue(active ? activeOpacity : inactiveOpacity);

  useEffect(() => {
    const nextScale = active ? activeScale : inactiveScale;
    const nextOpacity = active ? activeOpacity : inactiveOpacity;

    if (reducedMotion) {
      scale.value = nextScale;
      opacity.value = nextOpacity;
      return;
    }

    const animationConfig = {
      duration: durationMs,
      easing: ReanimatedEasing.out(ReanimatedEasing.cubic),
    };

    scale.value = withTiming(nextScale, animationConfig);
    opacity.value = withTiming(nextOpacity, animationConfig);
  }, [
    active,
    activeScale,
    inactiveScale,
    activeOpacity,
    inactiveOpacity,
    reducedMotion,
    durationMs,
    scale,
    opacity,
  ]);

  const animatedStyle = useAnimatedStyle(() => {
    "worklet";
    return {
      opacity: opacity.value,
      transform: [{ scale: scale.value }],
    };
  });

  type AriaLiveValue = "polite" | "assertive" | "off";

  type AutomationProps =
    | {
        "aria-live": AriaLiveValue;
        "data-testid": string;
        "data-qa": string;
        "data-state": "active" | "inactive";
      }
    | {
        testID: string;
        accessibilityLabel: string;
        accessibilityState: { busy: boolean };
      };

  const automationProps = useMemo<AutomationProps>(() => {
    if (Platform.OS === "web") {
      const ariaLive: AriaLiveValue = active ? "polite" : "off";
      return {
        "aria-live": ariaLive,
        "data-testid": testID,
        "data-qa": qaId,
        "data-state": active ? "active" : "inactive",
      };
    }

    return {
      testID,
      accessibilityLabel: resolvedAccessibilityLabel,
      accessibilityState: { busy: !active },
    };
  }, [active, qaId, resolvedAccessibilityLabel, testID]);

  return (
    <Animated.View
      style={[{ width: "100%" }, animatedStyle]}
      {...automationProps}
    >
      <Card
        padding="$4"
        borderRadius="$0"
        borderColor="$borderColor"
        borderWidth={2}
        accessibilityLabel={resolvedAccessibilityLabel}
        {...cardProps}
      >
        <XStack gap="$4" alignItems="flex-start">
          <Stack
            alignSelf="stretch"
            backgroundColor={accentColor}
            borderRadius="$0"
            minHeight={48}
            width={6}
          />
          <YStack gap="$2" flex={1}>
            <Text
              variant="body"
              weight="bold"
              fontSize="$5"
              lineHeight="$5"
              margin={0}
            >
              {title}
            </Text>
            {description ? (
              <Text
                variant="body"
                tone="muted"
                fontSize="$4"
                lineHeight="$4"
                margin={0}
              >
                {description}
              </Text>
            ) : null}
            {children ? <YStack gap="$2">{children}</YStack> : null}
          </YStack>
        </XStack>
        <Separator marginVertical="$4" />
        <XStack justifyContent="flex-end">
          <Button
            variant="outlined"
            size="$3"
            onPress={onActionPress}
            {...(Platform.OS === "web"
              ? {
                  "data-testid": `${testID}-action`,
                  "data-qa": `${qaId}-action`,
                }
              : {
                  testID: `${testID}-action`,
                  accessibilityLabel: `${qaId}-action`,
                })}
          >
            {actionLabel}
          </Button>
        </XStack>
      </Card>
    </Animated.View>
  );
};
