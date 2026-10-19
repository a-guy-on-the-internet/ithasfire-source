"use client";

import { Fragment, useMemo } from "react";
import { Platform } from "react-native";
import { Stack, XStack, YStack, styled, type StackProps } from "tamagui";

import { Text, type TextProps } from "../typography/Text";

export type StepperStatus = "complete" | "current" | "upcoming";

export type StepperOrientation = "horizontal" | "vertical";

export type StepperSize = "sm" | "md";

export type StepperStepDefinition = {
  id: string;
  title: string;
  description?: string;
  optional?: boolean;
  disabled?: boolean;
};

export type StepperProps = Omit<StackProps, "children"> & {
  steps: StepperStepDefinition[];
  currentStepId: string;
  completedStepIds?: string[];
  onStepPress?: (stepId: string) => void;
  orientation?: StepperOrientation;
  size?: StepperSize;
  showDescriptions?: boolean;
  qaId?: string;
};

const indicatorSizeTokens: Record<StepperSize, number> = {
  sm: 28,
  md: 36,
};

const titleVariantMap: Record<StepperSize, TextProps["variant"]> = {
  sm: "body",
  md: "subtitle",
};

const descriptionVariantMap: Record<StepperSize, TextProps["variant"]> = {
  sm: "bodySmall",
  md: "body",
};

const indicatorStyles: Record<
  StepperStatus,
  { backgroundColor: string; borderColor: string; textColor: string }
> = {
  complete: {
    backgroundColor: "$accent",
    borderColor: "$accent",
    // The completed-step "✓". Was `$brandSecondary`, which on Stub is the SAME #E2481D as the
    // `$accent` fill — an invisible checkmark (1:1). `$onBrandSecondary` is the foreground for an
    // accent fill (white), so the ✓ reads at 4.06:1 (a state graphic, ≥3:1).
    textColor: "$onBrandSecondary",
  },
  current: {
    backgroundColor: "$surface",
    borderColor: "$accent",
    textColor: "$color",
  },
  upcoming: {
    backgroundColor: "$surface",
    borderColor: "$borderColor",
    textColor: "$colorMuted",
  },
};

const connectorStyles: Record<StepperStatus, StackProps> = {
  complete: {
    backgroundColor: "$accent",
  },
  current: {
    backgroundColor: "$borderColorStrong",
  },
  upcoming: {
    backgroundColor: "$surfaceMuted",
  },
};

const StepIndicator = styled(XStack, {
  name: "IthasFireStepperIndicator",
  alignItems: "center",
  justifyContent: "center",
  borderWidth: 2,
  borderRadius: 0,
  backgroundColor: "$surface",
  transition: "all $motionFast",
});

const StepConnectorHorizontal = styled(Stack, {
  name: "IthasFireStepperConnectorHorizontal",
  height: 2,
  borderRadius: 0,
});

const StepConnectorVertical = styled(Stack, {
  name: "IthasFireStepperConnectorVertical",
  width: 2,
  borderRadius: 0,
});

const buildAutomationProps = (qaId?: string, suffix?: string) => {
  if (!qaId) return {};
  const testId = suffix ? `${qaId}-${suffix}` : qaId;
  if (Platform.OS === "web") {
    return {
      "data-testid": testId,
      "data-qa": testId,
    } as const;
  }
  return {
    testID: testId,
    accessibilityLabel: testId,
  } as const;
};

const isWeb = Platform.OS === "web";

const isActivationKey = (
  event: unknown,
): event is { key: string; preventDefault: () => void } => {
  if (!event || typeof event !== "object") return false;
  return (
    "key" in event &&
    typeof (event as any).key === "string" &&
    "preventDefault" in event
  );
};

export const deriveStepperStatuses = (
  steps: StepperStepDefinition[],
  currentStepId: string,
  completedStepIds: readonly string[] = [],
): Record<string, StepperStatus> => {
  if (!steps.length) {
    return {};
  }

  const completedSet = new Set(completedStepIds);
  const activeStep = steps.find((step) => step.id === currentStepId);
  const fallbackCurrentId = activeStep ? activeStep.id : steps[0]!.id;
  const currentIndex = steps.findIndex((step) => step.id === fallbackCurrentId);

  return steps.reduce<Record<string, StepperStatus>>((acc, step, index) => {
    if (
      completedSet.has(step.id) ||
      (currentIndex >= 0 && index < currentIndex)
    ) {
      acc[step.id] = "complete";
      return acc;
    }

    if (index === currentIndex) {
      acc[step.id] = "current";
      return acc;
    }

    acc[step.id] = "upcoming";
    return acc;
  }, {});
};

const getConnectorStatus = (
  statuses: Record<string, StepperStatus>,
  currentStepId: string,
  nextStepId: string,
): StepperStatus => {
  const currentStatus = statuses[currentStepId];
  const nextStatus = statuses[nextStepId];
  if (
    currentStatus === "complete" &&
    (nextStatus === "complete" || nextStatus === "current")
  ) {
    return "complete";
  }
  if (currentStatus === "complete" || currentStatus === "current") {
    return "current";
  }
  return "upcoming";
};

const getAutomationRoles = (
  status: StepperStatus,
  disabled?: boolean,
  interactive?: boolean,
) => {
  if (isWeb) {
    return {
      role: interactive ? "button" : "listitem",
      "aria-current": status === "current" ? "step" : undefined,
      "aria-disabled": interactive && disabled ? true : undefined,
    } as const;
  }

  return {
    accessibilityRole: interactive ? "button" : "summary",
    accessibilityState: {
      selected: status === "current",
      disabled: Boolean(disabled),
    },
  } as const;
};

export const Stepper = ({
  steps,
  currentStepId,
  completedStepIds = [],
  onStepPress,
  orientation = "horizontal",
  size = "md",
  showDescriptions = true,
  qaId,
  ...rest
}: StepperProps) => {
  const statuses = useMemo(
    () => deriveStepperStatuses(steps, currentStepId, completedStepIds),
    [steps, currentStepId, completedStepIds],
  );

  const indicatorSize = indicatorSizeTokens[size];
  const titleVariant = titleVariantMap[size] ?? "body";
  const descriptionVariant = descriptionVariantMap[size] ?? "bodySmall";

  const handleStepPress = (stepId: string, disabled?: boolean) => {
    if (disabled || !onStepPress) {
      return;
    }
    onStepPress(stepId);
  };

  const handleStepKeyDown = (
    event: unknown,
    stepId: string,
    disabled?: boolean,
  ) => {
    if (!isWeb) return;
    if (!onStepPress || disabled) return;
    if (!isActivationKey(event)) return;

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onStepPress(stepId);
    }
  };

  const renderStepContent = (step: StepperStepDefinition, index: number) => {
    const status = statuses[step.id] ?? "upcoming";
    const indicatorStyle = indicatorStyles[status];
    const automationProps = buildAutomationProps(qaId, `step-${step.id}`);
    const connectorStatus =
      index < steps.length - 1 && steps[index + 1]
        ? getConnectorStatus(statuses, step.id, steps[index + 1]!.id)
        : null;

    const indicatorContent = status === "complete" ? "✓" : index + 1;

    const interactive = typeof onStepPress === "function" && !step.disabled;

    const stepBody = (
      <XStack
        gap="$2"
        alignItems="center"
        flexShrink={0}
        paddingVertical="$2"
        onPress={() => handleStepPress(step.id, step.disabled)}
        {...(isWeb && typeof onStepPress === "function"
          ? ({
              onKeyDown: (event: unknown) =>
                handleStepKeyDown(event as any, step.id, step.disabled),
              tabIndex: !step.disabled ? 0 : undefined,
            } as any)
          : null)}
        cursor={interactive ? "pointer" : undefined}
        opacity={step.disabled ? 0.5 : 1}
        {...automationProps}
        {...getAutomationRoles(status, step.disabled, interactive)}
      >
        <StepIndicator
          width={indicatorSize}
          height={indicatorSize}
          backgroundColor={indicatorStyle.backgroundColor}
          borderColor={indicatorStyle.borderColor}
        >
          <Text variant="body" weight="bold" color={indicatorStyle.textColor}>
            {indicatorContent}
          </Text>
        </StepIndicator>
        <YStack gap="$1" flexShrink={1}>
          <XStack alignItems="center" gap="$2">
            <Text variant={titleVariant} weight="bold">
              {step.title}
            </Text>
            {step.optional ? (
              <Text variant="caption" tone="muted">
                Optional
              </Text>
            ) : null}
          </XStack>
          {showDescriptions && step.description ? (
            <Text variant={descriptionVariant} tone="muted">
              {step.description}
            </Text>
          ) : null}
        </YStack>
      </XStack>
    );

    if (orientation === "vertical") {
      return (
        <YStack key={step.id} gap="$3">
          {stepBody}
          {index < steps.length - 1 && connectorStatus ? (
            <StepConnectorVertical
              height={32}
              marginLeft={indicatorSize / 2}
              {...connectorStyles[connectorStatus]}
            />
          ) : null}
        </YStack>
      );
    }

    return (
      <Fragment key={step.id}>
        <YStack flex={1} minWidth={120} gap="$2">
          {stepBody}
        </YStack>
        {index < steps.length - 1 && connectorStatus ? (
          <StepConnectorHorizontal
            flex={1}
            alignSelf="center"
            marginHorizontal="$2"
            {...connectorStyles[connectorStatus]}
          />
        ) : null}
      </Fragment>
    );
  };

  return (
    <YStack gap="$3" {...rest}>
      {orientation === "horizontal" ? (
        <XStack alignItems="center" gap="$2" role="list">
          {steps.map((step, index) => renderStepContent(step, index))}
        </XStack>
      ) : (
        <YStack gap="$4" role="list">
          {steps.map((step, index) => renderStepContent(step, index))}
        </YStack>
      )}
    </YStack>
  );
};

Stepper.displayName = "Stepper";
