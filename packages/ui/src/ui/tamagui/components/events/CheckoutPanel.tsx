// @ts-nocheck
import { type FC, Fragment, type ReactNode } from "react";
import { Button, Card, Separator, XStack, YStack } from "tamagui";

import { Text } from "../typography/Text";
import { useTranslations } from "../../../../locale";

export interface CheckoutLineItem {
  label: string;
  value: string;
}

export interface CheckoutPanelProps {
  heading?: string;
  items: CheckoutLineItem[];
  totalLabel?: string;
  totalValue: string;
  actionLabel?: string;
  onAction?: () => void;
  footer?: ReactNode;
}

export const CheckoutPanel: FC<CheckoutPanelProps> = ({
  heading,
  items,
  totalLabel,
  totalValue,
  actionLabel,
  onAction,
  footer,
}) => {
  const t = useTranslations();
  const resolvedHeading = heading ?? String(t("tickets.checkout.reviewOrder"));
  const resolvedTotalLabel = totalLabel ?? String(t("tickets.checkout.total"));
  const resolvedActionLabel =
    actionLabel ?? String(t("tickets.checkout.confirmPurchase"));

  return (
    <Card gap="$4" padding="$4" borderRadius="$0">
      <YStack gap="$3">
        <Text variant="h4" weight="bold">
          {resolvedHeading}
        </Text>
        {items.map((item, index) => (
          <Fragment key={`${item.label}-${index}`}>
            {index === 0 ? null : <Separator />}
            <XStack alignItems="center" justifyContent="space-between">
              <Text variant="body" color="$colorMuted">
                {item.label}
              </Text>
              <Text variant="body" weight="bold">
                {item.value}
              </Text>
            </XStack>
          </Fragment>
        ))}
      </YStack>

      <Separator />

      <XStack alignItems="center" justifyContent="space-between">
        <Text variant="body" weight="bold">
          {resolvedTotalLabel}
        </Text>
        <Text variant="h3" fontSize="$6" weight="bold">
          {totalValue}
        </Text>
      </XStack>

      <Button onPress={onAction} disabled={!onAction} size="$5">
        {resolvedActionLabel}
      </Button>

      {footer ? <YStack>{footer}</YStack> : null}
    </Card>
  );
};
