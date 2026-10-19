"use client";

import { forwardRef, useId } from "react";
import type { ElementRef, ReactNode } from "react";
import { Platform } from "react-native";
import {
  Label,
  RadioGroup,
  XStack,
  YStack,
  styled,
  type GetProps,
} from "tamagui";
import { Text } from "../typography/Text";

const isWeb = Platform.OS === "web";

const focusRing = {
  outlineWidth: 2,
  outlineStyle: "solid" as const,
  outlineColor: "$focus",
  outlineOffset: 2,
};

const buildAutomationTestProps = (
  baseId?: string,
  suffix?: string,
): Record<string, string> => {
  if (!baseId) {
    return {};
  }

  const testId = suffix ? `${baseId}-${suffix}` : baseId;
  return isWeb ? { "data-testid": testId } : { testID: testId };
};

const RadioContainer = styled(XStack, {
  name: "IthasFireRadioContainer",
  alignItems: "flex-start",
  gap: "$2",
  // Same trap Checkbox already guards against: Tamagui flex items get
  // flex-shrink:0 and min-width:auto on web, so a long label/description
  // holds the row at its single-line width and overflows narrow parents
  // (measured: 440px rows in a 300px dialog at a 320px viewport).
  minWidth: 0,
  maxWidth: "100%",
  flexShrink: 1,
});

const RadioTextContent = styled(YStack, {
  name: "IthasFireRadioTextContent",
  gap: "$1",
  // Let the label/description column shrink and wrap instead of pushing
  // the row wider than its parent.
  flexShrink: 1,
  minWidth: 0,
});

const RadioLabel = styled(Label, {
  name: "IthasFireRadioLabel",
  fontFamily: "$body",
  fontSize: "$3",
  fontWeight: "500",
  color: "$color",
  lineHeight: "$3",
  userSelect: "none",
});

const RadioFrame = styled(RadioGroup.Item, {
  name: "IthasFireRadioFrame",
  alignItems: "center",
  justifyContent: "center",
  // The square must never shrink when the row is space-constrained — only
  // the text column wraps.
  flexShrink: 0,
  borderWidth: 2,
  borderColor: "$borderColor",
  backgroundColor: "$surface",
  borderRadius: 0,
  transition: "all $motionFast",
  hoverStyle: {
    borderColor: "$borderColorStrong",
    backgroundColor: "$surfaceMuted",
  },
  pressStyle: {
    scale: 0.95,
  },
  focusStyle: focusRing,
  disabledStyle: {
    opacity: 0.5,
    cursor: "not-allowed",
  },
  variants: {
    size: {
      sm: {
        width: 16,
        height: 16,
      },
      md: {
        width: 20,
        height: 20,
      },
      lg: {
        width: 24,
        height: 24,
      },
    },
  },
  defaultVariants: {
    size: "md",
  },
});

const RadioIndicator = styled(RadioGroup.Indicator, {
  name: "IthasFireRadioIndicator",
  width: "100%",
  height: "100%",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 0,
});

const RadioDot = styled(XStack, {
  name: "IthasFireRadioDot",
  borderRadius: 0,
  backgroundColor: "$color",
  pointerEvents: "none",
  variants: {
    size: {
      sm: {
        width: 6,
        height: 6,
      },
      md: {
        width: 8,
        height: 8,
      },
      lg: {
        width: 12,
        height: 12,
      },
    },
  },
  defaultVariants: {
    size: "md",
  },
});

export type RadioBaseProps = GetProps<typeof RadioFrame>;

export interface RadioProps extends Omit<RadioBaseProps, "children" | "id"> {
  id?: string;
  label: ReactNode;
  description?: ReactNode;
  errorMessage?: ReactNode;
  testIdBase?: string;
  qaId?: string;
  required?: boolean;
  frameBackgroundColor?: string;
  frameBorderColor?: string;
  indicatorColor?: string;
}

type RadioRef = ElementRef<typeof RadioFrame>;

type RadioSizeVariant = "sm" | "md" | "lg";

const resolveSizeVariant = (value: RadioProps["size"]): RadioSizeVariant => {
  if (value === "sm" || value === "md" || value === "lg") {
    return value as RadioSizeVariant;
  }

  return "md";
};

export const Radio = forwardRef<RadioRef, RadioProps>(
  (
    {
      id,
      label,
      description,
      errorMessage,
      required,
      disabled,
      value,
      testIdBase,
      qaId,
      size = "md",
      frameBackgroundColor,
      frameBorderColor,
      indicatorColor,
      ...rest
    },
    ref,
  ) => {
    const autoId = useId();
    const radioId = id ?? `radio-${autoId}`;
    const descriptionId = description ? `${radioId}-description` : undefined;
    const errorId = errorMessage ? `${radioId}-error` : undefined;
    const describedBy =
      [descriptionId, errorId].filter(Boolean).join(" ") || undefined;

    const automationId = testIdBase ?? radioId;
    const automationQa = qaId ?? automationId;

    const automationProps = isWeb
      ? {
          ...(automationId ? { "data-testid": automationId } : {}),
          ...(automationQa ? { "data-qa": automationQa } : {}),
        }
      : {
          ...(automationId ? { testID: automationId } : {}),
          ...(automationQa ? { accessibilityLabel: automationQa } : {}),
        };

    const frameTestProps = buildAutomationTestProps(automationId, "frame");
    const indicatorTestProps = buildAutomationTestProps(
      automationId,
      "indicator",
    );
    const dotTestProps = buildAutomationTestProps(automationId, "dot");
    const labelTestProps = buildAutomationTestProps(automationId, "label");
    const labelTextTestId = automationId
      ? `${automationId}-label-text`
      : undefined;
    const labelTextQa = automationQa ? `${automationQa}-label-text` : undefined;

    const sizeVariant = resolveSizeVariant(size);

    const frameStyleOverride =
      frameBackgroundColor || frameBorderColor
        ? {
            ...(frameBackgroundColor
              ? { backgroundColor: frameBackgroundColor }
              : {}),
            ...(frameBorderColor ? { borderColor: frameBorderColor } : {}),
          }
        : undefined;

    const hoverStyleOverride = frameStyleOverride
      ? { ...frameStyleOverride }
      : undefined;

    const renderedLabel =
      typeof label === "string" || typeof label === "number" ? (
        <Text
          fontFamily="$body"
          fontSize="$3"
          lineHeight="$3"
          weight="medium"
          tone="default"
          testId={labelTextTestId}
          qaId={labelTextQa}
        >
          {label}
        </Text>
      ) : (
        label
      );

    return (
      <RadioContainer
        data-disabled={disabled ? "true" : undefined}
        {...automationProps}
      >
        <RadioFrame
          id={radioId}
          ref={ref}
          value={value}
          disabled={disabled}
          aria-describedby={describedBy}
          aria-invalid={errorMessage ? true : undefined}
          aria-required={required ? true : undefined}
          size={sizeVariant}
          {...frameTestProps}
          {...(frameStyleOverride ? { style: frameStyleOverride } : {})}
          {...(hoverStyleOverride ? { hoverStyle: hoverStyleOverride } : {})}
          {...rest}
        >
          <RadioIndicator {...indicatorTestProps}>
            <RadioDot
              size={sizeVariant}
              aria-hidden
              {...dotTestProps}
              {...(indicatorColor ? { backgroundColor: indicatorColor } : {})}
            />
          </RadioIndicator>
        </RadioFrame>
        <RadioTextContent>
          <RadioLabel htmlFor={radioId} {...labelTestProps}>
            {renderedLabel}
            {required ? (
              <Text
                aria-hidden
                variant="span"
                tone="error"
                weight="bold"
                marginLeft={4}
              >
                *
              </Text>
            ) : null}
          </RadioLabel>
          {description ? (
            <Text
              id={descriptionId}
              variant="bodySmall"
              tone="muted"
              margin={0}
            >
              {description}
            </Text>
          ) : null}
          {errorMessage ? (
            <Text
              id={errorId}
              role="alert"
              variant="bodySmall"
              tone="error"
              margin={0}
            >
              {errorMessage}
            </Text>
          ) : null}
        </RadioTextContent>
      </RadioContainer>
    );
  },
);

Radio.displayName = "Radio";

export const RadioGroupField = styled(RadioGroup, {
  name: "IthasFireRadioGroup",
  gap: "$3",
  flexDirection: "column",
});
