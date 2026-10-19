import {
  Card as TamaguiCard,
  Separator,
  XStack,
  YStack,
  styled,
  type CardProps as TamaguiCardProps,
} from "tamagui";

import { colorTokens } from "../../tokens/colors";
import { Button, type ButtonProps } from "../forms/Button";
import { hexToRgba } from "../shared";
import { Text } from "../typography/Text";

export const CardSurface = styled(TamaguiCard, {
  name: "CardSurface",
  padding: "$5",
  gap: "$5",
  borderRadius: 0,
  borderWidth: 2,
  borderColor: "$borderColor",
  elevation: 0,
  shadowColor: "transparent",
});

export type CardVariant = "light" | "dark";

export interface CardStat {
  label: string;
  value: string;
  helperText?: string;
}

export interface CardProps extends TamaguiCardProps {
  variant?: CardVariant;
  eyebrow: string;
  title: string;
  description: string;
  stats?: CardStat[];
  primaryMetricLabel?: string;
  primaryMetricValue?: string;
  primaryMetricHelper?: string;
  ctaLabel?: string;
  onCtaPress?: ButtonProps["onPress"];
}

const backgroundByVariant: Record<CardVariant, string> = {
  dark: "$neutral900",
  light: "$neutral100",
};

const brandPrimaryHex = colorTokens.color.brandPrimary;
const brandSecondaryHex = colorTokens.color.brandSecondary;

const cardBorderByVariant: Record<CardVariant, string> = {
  dark: hexToRgba(brandSecondaryHex, 0.16),
  light: hexToRgba(brandPrimaryHex, 0.12),
};

const textColorByVariant: Record<CardVariant, string> = {
  dark: "$brandSecondary",
  light: "$brandPrimary",
};

const mutedColorByVariant: Record<CardVariant, string> = {
  dark: "$neutral300",
  light: "$neutral700",
};

const dividerColorByVariant: Record<CardVariant, string> = {
  dark: hexToRgba(brandSecondaryHex, 0.12),
  light: hexToRgba(brandPrimaryHex, 0.08),
};

const buttonVariantByCard: Record<CardVariant, "primary" | "secondary"> = {
  dark: "secondary",
  light: "primary",
};

export const Card = ({
  variant = "dark",
  eyebrow,
  title,
  description,
  stats,
  primaryMetricLabel,
  primaryMetricValue,
  primaryMetricHelper,
  ctaLabel,
  onCtaPress,
  ...cardProps
}: CardProps) => {
  const backgroundColor = backgroundByVariant[variant];
  const borderColor = cardBorderByVariant[variant];
  const textColor = textColorByVariant[variant];
  const mutedColor = mutedColorByVariant[variant];
  const dividerColor = dividerColorByVariant[variant];

  const hasPrimaryMetric = Boolean(primaryMetricLabel && primaryMetricValue);
  const hasStats = Array.isArray(stats) && stats.length > 0;

  return (
    <CardSurface
      backgroundColor={backgroundColor}
      borderColor={borderColor}
      {...cardProps}
    >
      <YStack gap="$2">
        <Text
          variant="overline"
          weight="bold"
          letterSpacing={3}
          color={mutedColor}
        >
          {eyebrow}
        </Text>
        <Text variant="h3" weight="bold" color={textColor}>
          {title}
        </Text>
        <Text variant="body" color={mutedColor} lineHeight={22}>
          {description}
        </Text>
      </YStack>

      {hasStats ? (
        <YStack gap="$3">
          <Separator
            borderWidth={0}
            height={1}
            backgroundColor={dividerColor}
          />
          <XStack gap="$4" flexWrap="wrap">
            {stats?.map((stat) => (
              <YStack
                key={`${stat.label}-${stat.value}`}
                gap="$1"
                flexBasis="45%"
              >
                <Text variant="bodySmall" weight="bold" color={mutedColor}>
                  {stat.label}
                </Text>
                <Text
                  variant="body"
                  fontSize="$4"
                  weight="bold"
                  color={textColor}
                >
                  {stat.value}
                </Text>
                {stat.helperText ? (
                  <Text variant="bodySmall" color={mutedColor}>
                    {stat.helperText}
                  </Text>
                ) : null}
              </YStack>
            ))}
          </XStack>
        </YStack>
      ) : null}

      {hasPrimaryMetric ? (
        <YStack gap="$3">
          <Separator
            borderWidth={0}
            height={1}
            backgroundColor={dividerColor}
          />
          <XStack
            alignItems="flex-end"
            justifyContent="space-between"
            gap="$4"
            flexWrap="wrap"
          >
            <YStack gap="$1">
              <Text variant="bodySmall" weight="bold" color={mutedColor}>
                {primaryMetricLabel}
              </Text>
              <Text variant="h3" weight="bold" color={textColor}>
                {primaryMetricValue}
              </Text>
              {primaryMetricHelper ? (
                <Text variant="bodySmall" color={mutedColor}>
                  {primaryMetricHelper}
                </Text>
              ) : null}
            </YStack>
            {ctaLabel ? (
              <Button
                variant={buttonVariantByCard[variant] as ButtonProps["variant"]}
                onPress={onCtaPress}
              >
                {ctaLabel}
              </Button>
            ) : null}
          </XStack>
        </YStack>
      ) : null}
    </CardSurface>
  );
};
