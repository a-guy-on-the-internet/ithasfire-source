import { type ReactNode } from "react";
import { XStack, YStack, type StackProps } from "tamagui";

export interface AlertContentProps extends Omit<StackProps, "children"> {
  /** Slot rendered before the main message block (icon, accent stripe, etc.). */
  leading?: ReactNode;
  /** Optional heading node – typically a styled `Text`. */
  title?: ReactNode;
  /** Optional supporting copy node. */
  description?: ReactNode;
  /** Extra body content placed beneath the description. */
  children?: ReactNode;
  /** Slot rendered after the message block (actions, dismiss button, etc.). */
  trailing?: ReactNode;
  /** Custom gap between stacked body elements. Defaults to `$2`. */
  bodyGap?: StackProps["gap"];
}

export const AlertContent = ({
  leading,
  title,
  description,
  children,
  trailing,
  gap = "$3",
  bodyGap = "$2",
  ...stackProps
}: AlertContentProps) => {
  const hasTitle = Boolean(title);
  const hasDescription = Boolean(description);
  const hasBodyChildren = Boolean(children);

  return (
    <XStack alignItems="flex-start" gap={gap} {...stackProps}>
      {leading ? leading : null}
      <YStack flex={1} gap={bodyGap}>
        {hasTitle ? title : null}
        {hasDescription ? description : null}
        {hasBodyChildren ? children : null}
      </YStack>
      {trailing ? (
        <XStack gap="$2" alignItems="center" justifyContent="flex-end">
          {trailing}
        </XStack>
      ) : null}
    </XStack>
  );
};
