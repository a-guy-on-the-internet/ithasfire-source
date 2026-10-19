import { Bell } from "lucide-react";
import { forwardRef, type ReactNode } from "react";
import { Stack, styled, type TamaguiElement } from "tamagui";

import { Badge, type BadgeProps } from "./Badge";
import { Button, type ButtonProps } from "../forms/Button";
import type { IntentVariant } from "../shared";

const IconFrame = styled(Stack, {
  name: "NotificationButtonIconFrame",
  alignItems: "center",
  justifyContent: "center",
  position: "relative",
});

const NotificationBadge = styled(Badge, {
  name: "NotificationButtonBadge",
  position: "absolute",
  top: -6,
  right: -10,
  pointerEvents: "none",
});

export interface NotificationButtonProps extends Omit<ButtonProps, "children"> {
  /** Total count of notifications to surface. */
  count?: number;
  /** Upper bound before values collapse into a + suffix. */
  maxCount?: number;
  /** Whether to show a pulsing dot when no count is provided. */
  showIndicator?: boolean;
  /** Visual tone for the badge. Defaults to danger. */
  tone?: IntentVariant;
  /** Optional glyph to render instead of the default bell. */
  glyph?: ReactNode;
  /** Overrides to pass directly to the underlying Badge. */
  badgeProps?: Partial<BadgeProps>;
}

export const NotificationButton = forwardRef<
  TamaguiElement,
  NotificationButtonProps
>(
  (
    {
      count,
      maxCount = 99,
      showIndicator = false,
      tone = "danger",
      glyph,
      badgeProps,
      variant = "ghost",
      size = "$1",
      icon = true,
      ...buttonProps
    },
    ref,
  ) => {
    const safeCount =
      typeof count === "number" ? Math.max(0, count) : undefined;
    const hasCount = typeof safeCount === "number" && safeCount > 0;
    const displayCount = hasCount
      ? safeCount > maxCount
        ? `${maxCount}+`
        : `${safeCount}`
      : undefined;
    const shouldShowDot = !hasCount && showIndicator;
    const shouldRenderBadge = hasCount || shouldShowDot;

    return (
      <Button
        ref={ref}
        variant={variant}
        size={size}
        icon={icon}
        {...buttonProps}
      >
        <IconFrame>
          {glyph ?? <Bell size={18} />}
          {shouldRenderBadge ? (
            <NotificationBadge
              size="xs"
              variant="solid"
              tone={tone}
              dot={shouldShowDot}
              aria-live={hasCount ? "polite" : undefined}
              {...badgeProps}
            >
              {displayCount}
            </NotificationBadge>
          ) : null}
        </IconFrame>
      </Button>
    );
  },
);

NotificationButton.displayName = "NotificationButton";
