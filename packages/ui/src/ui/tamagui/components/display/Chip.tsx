import { forwardRef, type ReactNode } from "react";
import { XStack, styled, type GetProps } from "tamagui";

import { colorTokens } from "../../tokens/colors";
import { getIntentTokens, hexToRgba, type IntentVariant } from "../shared";
import { Text } from "../typography/Text";

const ChipFrame = styled(XStack, {
  name: "Chip",
  alignItems: "center",
  gap: "$2",
  borderRadius: 0,
  borderWidth: 2,
  paddingHorizontal: "$3",
  paddingVertical: "$1",
  minHeight: 32,
  // A chip sizes to its label, so a long one ("Wheelchair-accessible seating +
  // elevator") outgrew its container and pushed the whole PAGE sideways at
  // 320px. Cap it and let the label wrap to a second line instead: min-content
  // is the longest single word, which fits every viewport we support.
  maxWidth: "100%",
  minWidth: 0,
  cursor: "pointer",
  userSelect: "none",
  transition: "all 150ms ease-out",
  hoverStyle: {
    opacity: 0.95,
  },
  pressStyle: {
    scale: 0.96,
  },
  focusStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$focus",
    outlineOffset: 2,
  },
  variants: {
    chipSize: {
      sm: {
        minHeight: 28,
        paddingHorizontal: "$2",
        gap: "$1",
      },
      md: {},
      lg: {
        minHeight: 38,
        paddingHorizontal: "$4",
        gap: "$2",
      },
    },
    selectable: {
      true: {
        cursor: "pointer",
      },
      false: {
        cursor: "default",
      },
    },
  },
  defaultVariants: {
    chipSize: "md",
    selectable: true,
  },
});

const RemoveButton = styled(XStack, {
  height: 20,
  width: 20,
  borderRadius: 0,
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  pressStyle: {
    scale: 0.92,
  },
  hoverStyle: {
    backgroundColor: hexToRgba(colorTokens.color.brandPrimary, 0.08),
  },
  focusStyle: {
    outlineWidth: 2,
    outlineColor: "$focus",
    outlineStyle: "solid",
    outlineOffset: 2,
  },
});

const IconWrapper = styled(XStack, {
  height: 18,
  width: 18,
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
});

const chipVariants = ["subtle", "filled", "outline"] as const;

export type ChipVariant = (typeof chipVariants)[number];

const chipSizes = ["sm", "md", "lg"] as const;

export type ChipSize = (typeof chipSizes)[number];

interface ChipColorTokens {
  backgroundColor: string;
  borderColor: string;
  textColor: string;
  iconColor: string;
}

const getChipTokens = (
  tone: IntentVariant,
  variant: ChipVariant,
): ChipColorTokens => {
  const intent = getIntentTokens(tone);

  switch (variant) {
    // The fill is `solidBackground`, NOT `accent`. `onSolidText` is defined as
    // the foreground for `solidBackground`, so pairing it with a different fill
    // was the bug: `tone="info"` painted `$background` on `$accent` (#F6F0E4 on
    // #E2481D = 3.57:1 — the 13px label below fails AA). Reading both halves of
    // the pair from the same place keeps them honest, and the only tone whose
    // fill actually moves is `neutral` ($color -> $surfaceStrong, identical on
    // Stub). See intentVisualConfigs' INVARIANT note in ../shared.
    case "filled":
      return {
        backgroundColor: intent.solidBackground,
        borderColor: intent.solidBackground,
        textColor: intent.onSolidText,
        iconColor: intent.onSolidText,
      };
    case "outline":
      return {
        backgroundColor: "transparent",
        borderColor: intent.accent,
        textColor: intent.accent,
        iconColor: intent.accent,
      };
    case "subtle":
    default:
      return {
        backgroundColor: intent.softBackground,
        borderColor: intent.softBorder,
        textColor: intent.text,
        iconColor: intent.text,
      };
  }
};

export interface ChipProps extends Omit<
  GetProps<typeof ChipFrame>,
  "children" | "chipSize" | "selectable"
> {
  tone?: IntentVariant;
  variant?: ChipVariant;
  size?: ChipSize;
  icon?: ReactNode;
  trailingIcon?: ReactNode;
  onRemove?: () => void;
  removeLabel?: string;
  interactive?: boolean;
  children: ReactNode;
}

export const Chip = forwardRef<HTMLDivElement, ChipProps>(
  (
    {
      tone = "neutral",
      variant = "subtle",
      size = "md",
      icon,
      trailingIcon,
      onRemove,
      removeLabel = "Remove chip",
      interactive,
      children,
      role: roleProp,
      ...rest
    },
    ref,
  ) => {
    const tokens = getChipTokens(tone, variant);
    const isInteractive =
      interactive ??
      Boolean(rest.onPress || rest.onPressIn || rest.onLongPress);
    const content =
      typeof children === "string" || typeof children === "number" ? (
        // `minWidth: 0` so the label can actually shrink inside the capped
        // frame — without it the flex item's automatic minimum keeps the text
        // at max-content and the cap does nothing.
        <Text
          fontSize={13}
          weight="bold"
          color={tokens.textColor}
          flexShrink={1}
          minWidth={0}
        >
          {children}
        </Text>
      ) : (
        children
      );

    return (
      <ChipFrame
        ref={ref}
        chipSize={size}
        selectable={isInteractive}
        backgroundColor={tokens.backgroundColor}
        borderColor={tokens.borderColor}
        role={roleProp ?? (isInteractive ? "button" : undefined)}
        {...rest}
      >
        {icon ? (
          <IconWrapper style={{ color: tokens.iconColor }}>{icon}</IconWrapper>
        ) : null}
        {content}
        {trailingIcon ? (
          <IconWrapper style={{ color: tokens.iconColor }}>
            {trailingIcon}
          </IconWrapper>
        ) : null}
        {onRemove ? (
          <RemoveButton
            role="button"
            aria-label={removeLabel}
            tabIndex={0}
            onPress={(event) => {
              event?.stopPropagation?.();
              onRemove();
            }}
          >
            <Text
              aria-hidden
              color={tokens.iconColor}
              fontSize={16}
              lineHeight={16}
            >
              ×
            </Text>
          </RemoveButton>
        ) : null}
      </ChipFrame>
    );
  },
);

Chip.displayName = "Chip";
