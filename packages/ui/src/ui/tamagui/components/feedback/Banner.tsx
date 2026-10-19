import { forwardRef } from "react";
import { XStack, YStack, styled, type GetProps } from "tamagui";

import { Button } from "../forms/Button";
import {
  FeedbackVariant,
  getFeedbackTokens,
  type IntentVariant,
} from "../shared";
import { Text } from "../typography/Text";

const BannerFrame = styled(YStack, {
  name: "Banner",
  borderRadius: 0,
  borderWidth: 2,
  paddingHorizontal: "$4",
  paddingVertical: "$4",
  gap: "$3",
  backgroundColor: "$surface",
  variants: {
    fullWidth: {
      true: {
        width: "100%",
      },
    },
  },
});

const BannerActions = styled(XStack, {
  gap: "$2",
  flexWrap: "wrap",
  alignItems: "center",
});

const iconContainerStyles = {
  height: 36,
  width: 36,
  borderRadius: 0,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  marginTop: 2,
} satisfies Partial<GetProps<typeof YStack>>;

type BannerVariant = FeedbackVariant;

export interface BannerProps extends Omit<
  GetProps<typeof BannerFrame>,
  "tone"
> {
  tone?: Extract<
    IntentVariant,
    "info" | "success" | "warning" | "danger" | "error"
  >;
  title?: string;
  description?: string;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
  variant?: BannerVariant;
  compact?: boolean;
}

export const Banner = forwardRef<HTMLDivElement, BannerProps>(
  (
    {
      tone = "info",
      variant = "surface",
      title,
      description,
      icon,
      actions,
      onDismiss,
      dismissLabel = "Dismiss",
      compact = false,
      children,
      ...rest
    },
    ref,
  ) => {
    const resolvedTone = tone ?? "info";
    const tokens = getFeedbackTokens(resolvedTone, variant);
    const paddingVertical = compact ? "$3" : "$4";
    const bodyGap = compact ? "$2" : "$3";
    const hasBodyChildren = Boolean(children);
    const iconNode = icon ? (
      <YStack
        {...iconContainerStyles}
        backgroundColor={tokens.iconBackground}
        borderColor={tokens.borderColor}
        borderWidth={variant === "solid" ? 0 : 1}
        style={{ color: tokens.iconColor }}
      >
        {icon}
      </YStack>
    ) : null;

    return (
      <BannerFrame
        ref={ref}
        backgroundColor={tokens.backgroundColor}
        borderColor={tokens.borderColor}
        paddingVertical={paddingVertical}
        role="region"
        aria-live="polite"
        {...rest}
      >
        <XStack
          gap="$3"
          alignItems="flex-start"
          justifyContent="space-between"
          flexWrap="wrap"
        >
          {iconNode}
          <YStack flex={1} gap={bodyGap} minWidth={0}>
            {title ? (
              <Text variant="h4" weight="bold" color={tokens.titleColor}>
                {title}
              </Text>
            ) : null}
            {description ? (
              <Text
                variant="body"
                color={tokens.descriptionColor}
                lineHeight={22}
              >
                {description}
              </Text>
            ) : null}
            {hasBodyChildren ? children : null}
            {actions ? <BannerActions>{actions}</BannerActions> : null}
          </YStack>
          {onDismiss ? (
            <Button
              size="$2"
              variant={variant === "solid" ? "secondary" : "ghost"}
              aria-label={dismissLabel}
              onPress={onDismiss}
            >
              {dismissLabel}
            </Button>
          ) : null}
        </XStack>
      </BannerFrame>
    );
  },
);

Banner.displayName = "Banner";
