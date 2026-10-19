import { forwardRef, type ReactNode } from "react";
import { Platform } from "react-native";
import { XStack, styled, type GetProps } from "tamagui";
import { ChevronDown } from "lucide-react";

import { Text } from "../typography/Text";

// ─────────────────────────────────────────────────────────────────────────────
// Styled frame (matches TextInput styling)
// ─────────────────────────────────────────────────────────────────────────────

const SelectFrame = styled(XStack, {
  name: "StyledSelect",
  alignItems: "center",
  borderWidth: 2,
  borderColor: "$borderColor",
  backgroundColor: "transparent",
  borderRadius: "$md",
  paddingHorizontal: "$3",
  gap: "$2",
  cursor: "pointer",
  minHeight: 36,
  height: 36,

  hoverStyle: {
    borderColor: "$borderColorStrong",
  },

  focusStyle: {
    borderColor: "$borderColorStrong",
  },

  variants: {
    fullWidth: {
      true: {
        width: "100%",
      },
    },
    size: {
      sm: {
        minHeight: 30,
        height: 30,
        paddingHorizontal: "$2",
        gap: "$1.5",
      },
      md: {
        minHeight: 36,
        height: 36,
        paddingHorizontal: "$3",
        gap: "$2",
      },
      lg: {
        minHeight: 42,
        height: 42,
        paddingHorizontal: "$3",
        gap: "$2.5",
      },
    },
    disabled: {
      true: {
        opacity: 0.5,
        cursor: "not-allowed",
      },
    },
  } as const,

  defaultVariants: {
    size: "md",
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface StyledSelectOption<T extends string = string> {
  value: T;
  label: string;
}

export interface StyledSelectProps<T extends string = string> extends Omit<
  GetProps<typeof SelectFrame>,
  "size"
> {
  value: T;
  options: StyledSelectOption<T>[];
  onChange: (value: T) => void;
  /** Optional icon displayed to the left of the selected label. */
  icon?: ReactNode;
  /** Placeholder when no value is selected. */
  placeholder?: string;
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  fullWidth?: boolean;
  /** data-testid for the hidden native select. */
  testId?: string;
  /**
   * DOM id for the hidden native `<select>` — the element assistive tech
   * actually focuses. Without it a sibling `<label htmlFor>` has nothing to
   * point at and the control is announced unlabelled.
   */
  selectId?: string;
  /** `aria-label` for the native `<select>` when there is no visible label. */
  ariaLabel?: string;
  /** `aria-describedby` for the native `<select>` (helper/hint copy). */
  ariaDescribedBy?: string;
}

const isWeb = Platform.OS === "web";

const fontSizeMap = { sm: 13, md: 14, lg: 16 } as const;
const chevronSizeMap = { sm: 12, md: 14, lg: 16 } as const;
const iconSizeMap = { sm: 14, md: 16, lg: 18 } as const;

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

function StyledSelectInner<T extends string = string>(
  {
    value,
    options,
    onChange,
    icon,
    placeholder,
    size = "md",
    disabled = false,
    fullWidth,
    testId,
    selectId,
    ariaLabel,
    ariaDescribedBy,
    ...frameProps
  }: StyledSelectProps<T>,
  ref: React.Ref<HTMLDivElement>,
) {
  const selectedOption = options.find((o) => o.value === value);
  const displayLabel = selectedOption?.label ?? placeholder ?? "";
  const fontSize = fontSizeMap[size];
  const chevronSize = chevronSizeMap[size];
  const _iconSize = iconSizeMap[size];

  return (
    <SelectFrame
      ref={ref}
      size={size}
      disabled={disabled}
      fullWidth={fullWidth}
      position="relative"
      {...frameProps}
    >
      {icon ? (
        <XStack
          alignItems="center"
          justifyContent="center"
          flexShrink={0}
          pointerEvents="none"
        >
          {icon}
        </XStack>
      ) : null}

      <Text
        variant="body"
        fontSize={fontSize}
        flex={1}
        truncate
        color={selectedOption ? "$color" : "$colorMuted"}
        pointerEvents="none"
      >
        {displayLabel}
      </Text>

      <XStack
        alignItems="center"
        justifyContent="center"
        flexShrink={0}
        pointerEvents="none"
      >
        {/* A CSS colour, not a Tamagui token: lucide writes `color` straight
            into the SVG `stroke` attribute, and `stroke="$color"` is not a
            colour, so the chevron computed to `stroke: none` and never drew. */}
        <ChevronDown size={chevronSize} color="var(--color, #211C16)" />
      </XStack>

      {/* Hidden native <select> overlays the styled frame for accessibility.
          onPointerDown stopPropagation prevents the Tamagui press-responder
          on the parent XStack from swallowing the first click (double-click
          bug). */}
      {isWeb ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value as T)}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          disabled={disabled}
          id={selectId}
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedBy}
          {...(testId ? { "data-testid": testId } : {})}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            opacity: 0,
            cursor: disabled ? "not-allowed" : "pointer",
            zIndex: 1,
          }}
        >
          {placeholder && !selectedOption ? (
            <option value="" disabled>
              {placeholder}
            </option>
          ) : null}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      ) : null}
    </SelectFrame>
  );
}

export const StyledSelect = forwardRef(StyledSelectInner) as <
  T extends string = string,
>(
  props: StyledSelectProps<T> & { ref?: React.Ref<HTMLDivElement> },
) => ReturnType<typeof StyledSelectInner>;
