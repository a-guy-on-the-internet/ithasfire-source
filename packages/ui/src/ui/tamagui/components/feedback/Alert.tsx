import { X } from "lucide-react";
import { forwardRef } from "react";
import {
  XStack,
  YStack,
  styled,
  type GetProps,
  type StackProps,
} from "tamagui";

import { Button } from "../forms/Button";
import {
  FeedbackVariant,
  getFeedbackTokens,
  type IntentVariant,
} from "../shared";
import { Text, type TextProps } from "../typography/Text";
import { AlertContent } from "./AlertContent";

const AlertContainer = styled(YStack, {
  name: "Alert",
  borderWidth: 2,
  borderRadius: 0,
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

const iconContainerStyles = {
  height: 32,
  width: 32,
  borderRadius: 0,
  alignItems: "center" as const,
  justifyContent: "center" as const,
} satisfies Partial<GetProps<typeof YStack>>;

export type AlertVariant = FeedbackVariant;

export interface AlertProps extends Omit<
  GetProps<typeof AlertContainer>,
  "tone"
> {
  tone?: IntentVariant;
  title?: string;
  description?: string;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  role?: "alert" | "status";
  variant?: AlertVariant;
  compact?: boolean;
  onDismiss?: () => void;
  dismissLabel?: string;
}

const getRoleForTone = (tone: AlertProps["tone"]) =>
  tone === "danger" || tone === "error" ? "alert" : "status";

export const Alert = forwardRef<HTMLDivElement, AlertProps>(
  (
    {
      tone = "info",
      variant = "soft",
      title,
      description,
      icon,
      actions,
      compact = false,
      onDismiss,
      dismissLabel = "Dismiss",
      children,
      role,
      ...rest
    },
    ref,
  ) => {
    const resolvedTone = tone ?? "info";
    const tokens = getFeedbackTokens(resolvedTone, variant);
    const paddingVertical = compact ? "$3" : "$4";
    const contentGap = compact ? "$2" : "$3";
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
    const trailingContent =
      actions || onDismiss ? (
        <XStack
          gap="$2"
          alignItems="center"
          flexWrap="wrap"
          justifyContent="flex-end"
        >
          {actions ? <Actions>{actions}</Actions> : null}
          {onDismiss ? (
            <Button
              size="$2"
              variant={variant === "solid" ? "secondary" : "ghost"}
              aria-label={dismissLabel}
              onPress={onDismiss}
              icon
            >
              <X size={16} strokeWidth={2.75} />
            </Button>
          ) : null}
        </XStack>
      ) : null;

    return (
      <AlertContainer
        ref={ref}
        backgroundColor={tokens.backgroundColor}
        borderColor={tokens.borderColor}
        paddingVertical={paddingVertical}
        gap={contentGap}
        role={role ?? getRoleForTone(resolvedTone)}
        aria-live={
          resolvedTone === "danger" || resolvedTone === "error"
            ? "assertive"
            : "polite"
        }
        {...rest}
      >
        <AlertContent
          gap={contentGap}
          leading={iconNode}
          title={
            title ? (
              <Title
                tone={resolvedTone}
                toneVariant={variant}
                color={tokens.titleColor}
              >
                {title}
              </Title>
            ) : null
          }
          description={
            description ? (
              <Description
                toneVariant={variant}
                tone={resolvedTone}
                color={tokens.descriptionColor}
              >
                {description}
              </Description>
            ) : null
          }
          trailing={trailingContent}
        >
          {children}
        </AlertContent>
      </AlertContainer>
    );
  },
);

Alert.displayName = "Alert";

export interface AlertTitleProps extends Omit<TextProps, "tone"> {
  tone?: IntentVariant;
  toneVariant?: AlertVariant;
}

const getTitleColor = (tone: IntentVariant, toneVariant: AlertVariant) =>
  getFeedbackTokens(tone, toneVariant).titleColor;

export const Title = ({
  tone = "info",
  toneVariant = "soft",
  color,
  ...props
}: AlertTitleProps) => (
  <Text
    variant="h5"
    weight="bold"
    color={color ?? getTitleColor(tone, toneVariant)}
    {...props}
  />
);

Title.displayName = "Alert.Title";

export interface AlertDescriptionProps extends Omit<TextProps, "tone"> {
  tone?: IntentVariant;
  toneVariant?: AlertVariant;
}

const getDescriptionColor = (tone: IntentVariant, toneVariant: AlertVariant) =>
  getFeedbackTokens(tone, toneVariant).descriptionColor;

export const Description = ({
  tone = "info",
  toneVariant = "soft",
  color,
  ...props
}: AlertDescriptionProps) => (
  <Text
    variant="body"
    lineHeight={20}
    color={color ?? getDescriptionColor(tone, toneVariant)}
    {...props}
  />
);

Description.displayName = "Alert.Description";

export const Actions = styled(XStack, {
  name: "AlertActions",
  gap: "$2",
  alignItems: "center",
});

export type AlertActionsProps = StackProps;
