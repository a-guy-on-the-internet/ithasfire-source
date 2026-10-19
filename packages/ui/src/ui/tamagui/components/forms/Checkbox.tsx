"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import type { ElementRef, ReactNode } from "react";
import { Platform } from "react-native";
import { Check, Minus } from "lucide-react";
import {
  Checkbox as TamaguiCheckbox,
  Label,
  XStack,
  YStack,
  styled,
  useTheme,
  type CheckboxProps as TamaguiCheckboxProps,
  type GetProps,
} from "tamagui";

import { stubTheme } from "../../tokens/colors";
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

const CheckboxContainer = styled(XStack, {
  name: "IthasFireCheckboxContainer",
  alignItems: "flex-start",
  gap: "$3",
  // Allow the whole control to shrink inside constrained rows. On web,
  // flex items default to min-width:auto, so a long label refuses to go
  // below its intrinsic single-line width and forces horizontal overflow
  // (observed in the volunteer sheet at 390px).
  minWidth: 0,
  maxWidth: "100%",
  flexShrink: 1,
});

const CheckboxTextContent = styled(YStack, {
  name: "IthasFireCheckboxTextContent",
  gap: "$1",
  // Let the label/description column shrink and wrap instead of pushing
  // the row wider than its parent.
  flexShrink: 1,
  minWidth: 0,
});

const CheckboxLabel = styled(Label, {
  name: "IthasFireCheckboxLabel",
  fontFamily: "$body",
  fontSize: "$3",
  fontWeight: "500",
  color: "$color",
  lineHeight: "$3",
  userSelect: "none",
});

const CheckboxFrame = styled(TamaguiCheckbox, {
  name: "IthasFireCheckboxFrame",
  alignItems: "center",
  justifyContent: "center",
  // The box itself must never shrink when the row is space-constrained —
  // only the text column wraps.
  flexShrink: 0,
  borderWidth: 2,
  borderColor: "$borderColor",
  backgroundColor: "$surface",
  borderRadius: "$sm",
  // Clip the absolutely-positioned indicator fill to the rounded corners so
  // the checked (brand-filled) state reads as a solid, radius-respecting box.
  overflow: "hidden",
  transition: "all $motionFast",
  shadowColor: "transparent",
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

const CheckboxIndicator = styled(TamaguiCheckbox.Indicator, {
  name: "IthasFireCheckboxIndicator",
  // Absolute inset:0 fill guarantees the brand-blue fill covers the whole
  // interior of the frame. Percentage width/height collapsed under the
  // frame's flex centering (the indicator shrank to a thin vertical strip),
  // which left most of the cream tick invisible on cream — the reported bug.
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  alignItems: "center",
  justifyContent: "center",
  variants: {
    size: {
      sm: {
        padding: 0,
      },
      md: {
        padding: 0,
      },
      lg: {
        padding: 0,
      },
    },
  },
  defaultVariants: {
    size: "md",
  },
});

const indicatorIconSizes = {
  sm: 10,
  md: 12,
  lg: 14,
} as const;

type CheckboxFrameProps = GetProps<typeof CheckboxFrame>;

type CheckboxCheckedState = TamaguiCheckboxProps["checked"];

export interface CheckboxProps extends Omit<
  CheckboxFrameProps,
  "children" | "id" | "size" | "value"
> {
  id?: string;
  /** Visible label text. Omit (or pass `null`) for icon-only checkboxes (e.g. DataTable rows). */
  label?: ReactNode;
  description?: ReactNode;
  errorMessage?: ReactNode;
  required?: boolean;
  testIdBase?: string;
  qaId?: string;
  size?: "sm" | "md" | "lg";
  frameBackgroundColor?: string;
  frameBorderColor?: string;
  indicatorBackgroundColor?: string;
  indicatorColor?: string;
}

type CheckboxRef = ElementRef<typeof CheckboxFrame>;

const resolveSizeVariant = (
  value: CheckboxProps["size"],
): NonNullable<CheckboxProps["size"]> => {
  if (value === "sm" || value === "md" || value === "lg") {
    return value;
  }

  return "md";
};

export const Checkbox = forwardRef<CheckboxRef, CheckboxProps>(
  (
    {
      id,
      label,
      description,
      errorMessage,
      required,
      disabled,
      testIdBase,
      qaId,
      size = "md",
      frameBackgroundColor,
      frameBorderColor,
      indicatorBackgroundColor,
      indicatorColor,
      checked,
      defaultChecked,
      onCheckedChange,
      ...rest
    },
    ref,
  ) => {
    const autoId = useId();
    const theme = useTheme();
    // Tick color for the default `$brandPrimary` (steel-blue) indicator fill.
    // Light-on-a-fixed-dark-fill is correct here — it routes to the semantic
    // `onStructure` token rather than a raw white. Resolved to a real value
    // because lucide's `color` prop can't read a Tamagui `$token`.
    const onIndicator = theme.onStructure?.val ?? stubTheme.onStructure;
    const checkboxId = id ?? `checkbox-${autoId}`;
    const descriptionId = description ? `${checkboxId}-description` : undefined;
    const errorId = errorMessage ? `${checkboxId}-error` : undefined;
    const describedBy =
      [descriptionId, errorId].filter(Boolean).join(" ") || undefined;

    const automationId = testIdBase ?? checkboxId;
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
    const labelTestProps = buildAutomationTestProps(automationId, "label");
    const labelTextTestId = automationId
      ? `${automationId}-label-text`
      : undefined;
    const labelTextQa = automationQa ? `${automationQa}-label-text` : undefined;

    const sizeVariant = resolveSizeVariant(size);

    const [internalChecked, setInternalChecked] =
      useState<CheckboxCheckedState>(checked ?? defaultChecked ?? false);

    useEffect(() => {
      if (checked !== undefined) {
        setInternalChecked(checked);
      }
    }, [checked]);

    const handleCheckedChange = useCallback<
      NonNullable<TamaguiCheckboxProps["onCheckedChange"]>
    >(
      (value) => {
        onCheckedChange?.(value);
        if (checked === undefined) {
          setInternalChecked(value);
        }
      },
      [checked, onCheckedChange],
    );

    const currentState = checked ?? internalChecked;

    const indicatorType = useMemo(() => {
      if (currentState === "indeterminate") {
        return "minus" as const;
      }

      if (currentState) {
        return "check" as const;
      }

      return null;
    }, [currentState]);

    // A checked/indeterminate box fills solid `$brandPrimary`, so its border
    // should match to read as one solid control — unless the caller pinned a
    // `frameBorderColor` (their override always wins).
    const isMarked = indicatorType !== null;

    const resolvedBorderColor = frameBorderColor
      ? frameBorderColor
      : isMarked
        ? "$brandPrimary"
        : undefined;

    const frameStyleOverrides =
      frameBackgroundColor || resolvedBorderColor
        ? {
            ...(frameBackgroundColor
              ? { backgroundColor: frameBackgroundColor }
              : {}),
            ...(resolvedBorderColor
              ? {
                  borderColor: resolvedBorderColor,
                  // Hold the resolved border on hover — the base frame's
                  // hoverStyle sets `$borderColorStrong`, which would otherwise
                  // flip a checked box's brand border to grey mid-hover.
                  hoverStyle: { borderColor: resolvedBorderColor },
                }
              : {}),
          }
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

    const hasTextContent =
      Boolean(renderedLabel) ||
      Boolean(description) ||
      Boolean(errorMessage) ||
      Boolean(required);

    const checkboxFrame = (
      <CheckboxFrame
        id={checkboxId}
        ref={ref}
        disabled={disabled}
        aria-describedby={describedBy}
        aria-invalid={errorMessage ? true : undefined}
        aria-required={required ? true : undefined}
        size={sizeVariant}
        checked={checked}
        defaultChecked={defaultChecked}
        onCheckedChange={handleCheckedChange}
        {...frameTestProps}
        {...(frameStyleOverrides ?? {})}
        {...rest}
      >
        <CheckboxIndicator
          size={sizeVariant}
          backgroundColor={indicatorBackgroundColor ?? "$brandPrimary"}
          {...indicatorTestProps}
        >
          {indicatorType ? (
            <XStack
              alignItems="center"
              justifyContent="center"
              width={indicatorIconSizes[sizeVariant]}
              height={indicatorIconSizes[sizeVariant]}
            >
              {indicatorType === "check" ? (
                <Check
                  strokeWidth={3}
                  size={indicatorIconSizes[sizeVariant]}
                  color={indicatorColor ?? onIndicator}
                />
              ) : (
                <Minus
                  strokeWidth={3}
                  size={indicatorIconSizes[sizeVariant]}
                  color={indicatorColor ?? onIndicator}
                />
              )}
            </XStack>
          ) : null}
        </CheckboxIndicator>
      </CheckboxFrame>
    );

    // When no label, description, or error text is needed, render just the
    // checkbox frame to avoid extra wrapper elements (useful in DataTables).
    if (!hasTextContent) {
      return (
        <CheckboxContainer
          data-disabled={disabled ? "true" : undefined}
          {...automationProps}
        >
          {checkboxFrame}
        </CheckboxContainer>
      );
    }

    return (
      <CheckboxContainer
        data-disabled={disabled ? "true" : undefined}
        {...automationProps}
      >
        {checkboxFrame}
        <CheckboxTextContent>
          <CheckboxLabel htmlFor={checkboxId} {...labelTestProps}>
            {/* Required is conveyed by `aria-required` on the frame and is
                deliberately NOT drawn: the design system marks OPTIONAL
                fields, never required ones (docs/design/design-system-v2.md
                §6a). */}
            {renderedLabel}
          </CheckboxLabel>
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
        </CheckboxTextContent>
      </CheckboxContainer>
    );
  },
);

Checkbox.displayName = "Checkbox";
