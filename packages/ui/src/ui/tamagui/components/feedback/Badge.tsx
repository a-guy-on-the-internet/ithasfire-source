import {
  cloneElement,
  forwardRef,
  isValidElement,
  type ReactNode,
} from "react";
import { Stack, XStack, styled, type GetProps } from "tamagui";

import {
  getBadgeVariantTokens,
  type BadgeVariant,
  type IntentVariant,
} from "../shared";
import { Text } from "../typography/Text";

const badgeSizeStyles = {
  xs: {
    minHeight: 18,
    paddingHorizontal: 6,
    paddingVertical: 2,
    gap: 4,
  },
  sm: {
    minHeight: 20,
    paddingHorizontal: 8,
    paddingVertical: 3,
    gap: 6,
  },
  md: {
    minHeight: 24,
    paddingHorizontal: 10,
    paddingVertical: 4,
    gap: 7,
  },
  lg: {
    minHeight: 28,
    paddingHorizontal: 12,
    paddingVertical: 5,
    gap: 8,
  },
} as const;

type BadgeSizeMeta = {
  iconSize: number;
  dotSize: number;
  fontSize: number;
  letterSpacing: number;
};

const badgeSizeMeta = {
  xs: {
    iconSize: 16,
    dotSize: 4,
    fontSize: 11,
    letterSpacing: 0.5,
  },
  sm: {
    iconSize: 18,
    dotSize: 5,
    fontSize: 12,
    letterSpacing: 0.8,
  },
  md: {
    iconSize: 20,
    dotSize: 6,
    fontSize: 13,
    letterSpacing: 1,
  },
  lg: {
    iconSize: 22,
    dotSize: 7,
    fontSize: 14,
    letterSpacing: 1,
  },
} as const satisfies Record<"xs" | "sm" | "md" | "lg", BadgeSizeMeta>;

const BadgeContainer = styled(XStack, {
  name: "Badge",
  borderWidth: 2,
  borderRadius: 0,
  alignItems: "center",
  justifyContent: "center",
  variants: {
    size: {
      xs: badgeSizeStyles.xs,
      sm: badgeSizeStyles.sm,
      md: badgeSizeStyles.md,
      lg: badgeSizeStyles.lg,
    },
  },
  defaultVariants: {
    size: "md",
  },
});

const IconWrapper = styled(XStack, {
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 0,
});

const Dot = styled(Stack, {
  borderRadius: 0,
});

type BadgeSize = keyof typeof badgeSizeMeta;
export interface BadgeProps extends Omit<
  GetProps<typeof BadgeContainer>,
  "size"
> {
  tone?: IntentVariant;
  variant?: BadgeVariant;
  size?: BadgeSize;
  icon?: ReactNode;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  dot?: boolean;
  children?: ReactNode;
}

export const Badge = forwardRef<HTMLDivElement, BadgeProps>(
  (
    {
      tone = "neutral",
      variant = "soft",
      size = "md",
      icon,
      leadingIcon,
      trailingIcon,
      dot = false,
      children,
      ...rest
    },
    ref,
  ) => {
    const resolvedVariant = variant ?? "soft";
    const tokens = getBadgeVariantTokens(tone, resolvedVariant);
    const sizeTokens = badgeSizeMeta[size] ?? badgeSizeMeta.md;
    const resolvedLeading = leadingIcon ?? icon;
    const isSolid = resolvedVariant === "solid";

    const renderAdornment = (node?: ReactNode) => {
      if (!node) {
        return null;
      }
      const element = isValidElement<{ color?: string; size?: number }>(node)
        ? cloneElement(node, {
            color: node.props.color ?? tokens.iconColor,
            size: node.props.size ?? sizeTokens.iconSize - 2,
          })
        : node;
      return (
        <IconWrapper
          width={sizeTokens.iconSize}
          height={sizeTokens.iconSize}
          paddingHorizontal={2}
          backgroundColor={tokens.iconBackground}
        >
          {element}
        </IconWrapper>
      );
    };

    const hasLabel =
      typeof children !== "undefined" &&
      children !== null &&
      children !== false;

    return (
      <BadgeContainer
        ref={ref}
        size={size}
        backgroundColor={tokens.backgroundColor}
        borderColor={tokens.borderColor}
        borderWidth={isSolid ? 0 : 1}
        data-variant={resolvedVariant}
        data-tone={tone}
        {...rest}
      >
        {dot ? (
          <Dot
            width={sizeTokens.dotSize}
            height={sizeTokens.dotSize}
            backgroundColor={tokens.dotColor}
            aria-hidden
            data-testid="badge-dot"
          />
        ) : null}
        {renderAdornment(resolvedLeading)}
        {hasLabel ? (
          <Text
            variant="overline"
            weight="bold"
            letterSpacing={sizeTokens.letterSpacing}
            fontSize={sizeTokens.fontSize}
            lineHeight={sizeTokens.fontSize + 2}
            color={tokens.textColor}
            truncate
          >
            {children}
          </Text>
        ) : null}
        {renderAdornment(trailingIcon)}
      </BadgeContainer>
    );
  },
);

Badge.displayName = "Badge";
