"use client";

import type { ComponentProps, ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { styled, XStack, YStack } from "tamagui";

import { Text } from "@th/ui";

/**
 * Shared mobile list-row primitives for the event builder's dense sub-editors
 * (ticket types, lineup people, split lines). On phones the editors swap their
 * cramped horizontal XStack rows for these stacked cards so the primary line,
 * meta caption, and actions don't collide at 360px.
 *
 * Strict Swiss: radius 0, 2px $borderColor border, $surface background, no
 * shadows, no nested cards.
 *
 * Layout: the card is a row-direction frame with two siblings — a flexible
 * title/meta column (`children`) and an optional right-hand `actions` slot.
 * The `actions` slot stays flush-right and never shrinks, so destructive/drag
 * affordances sit beside the title instead of stacking beneath it.
 *
 * Interaction contract (nested-interactive rule):
 *  - A card with `onPress` is itself the button (role=button, Enter/Space,
 *    trailing chevron). Do NOT pass `actions` containing buttons to a pressable
 *    card — that nests interactive controls inside a button.
 *  - A card with `actions` should be STATIC (omit `onPress`). The frame then
 *    carries no button role; only the action children are interactive.
 */

// ─── Card container ──────────────────────────────────────────────────────────

const EditorCardFrame = styled(XStack, {
  name: "EditorCard",
  backgroundColor: "$surface",
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  minHeight: 44,
  paddingVertical: "$3",
  paddingHorizontal: "$3",
  gap: "$3",
  alignItems: "center",

  variants: {
    interactive: {
      true: {
        cursor: "pointer",
        hoverStyle: { backgroundColor: "$surfaceOverlay" },
        pressStyle: { backgroundColor: "$surfaceOverlay", opacity: 0.85 },
        focusStyle: {
          backgroundColor: "$surfaceOverlay",
          borderColor: "$accent",
        },
      },
    },
  } as const,
});

export type EditorCardProps = ComponentProps<typeof EditorCardFrame> & {
  /** Title/meta column. Lives in the flexible left column of the row. */
  children: ReactNode;
  /**
   * Activates the whole card. When set the card gains button semantics,
   * keyboard activation (Enter/Space), and a trailing chevron. Omit for a
   * static card (e.g. a row that only contains its own action buttons).
   * Mutually exclusive with interactive `actions` (no nested buttons).
   */
  onPress?: () => void;
  /**
   * Optional right-hand slot rendered as a sibling of the title/meta column
   * (typically an `EditorCardActions` wrapping delete/drag buttons). Pass this
   * only on a STATIC card (no `onPress`) so the buttons aren't nested inside an
   * interactive card.
   */
  actions?: ReactNode;
};

/**
 * Stacked card row. With `onPress` it renders as a keyboard-activatable button
 * row with a trailing chevron. With `actions` (and no `onPress`) it renders a
 * static container whose right-hand slot holds its own interactive controls.
 */
export function EditorCard({
  children,
  onPress,
  actions,
  ...rest
}: EditorCardProps) {
  const interactive = Boolean(onPress);

  return (
    <EditorCardFrame
      interactive={interactive}
      onPress={onPress}
      {...(interactive
        ? {
            role: "button",
            tabIndex: 0,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onPress?.();
              }
            },
          }
        : {})}
      {...rest}
    >
      <YStack
        flex={1}
        minWidth={0}
        gap="$1"
        {...({ "data-testid": "editor-card-content" } as Record<
          string,
          unknown
        >)}
      >
        {children}
      </YStack>
      {actions}
      {interactive ? (
        <ChevronRight
          size={18}
          color="var(--colorMuted)"
          aria-hidden="true"
          style={{ flexShrink: 0 }}
        />
      ) : null}
    </EditorCardFrame>
  );
}

EditorCard.displayName = "EditorCard";

// ─── Title + meta ────────────────────────────────────────────────────────────

const ELLIPSIS_STYLE = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

export type EditorCardTitleProps = ComponentProps<typeof Text> & {
  children: ReactNode;
};

/** Bold, single-line primary label. Ellipsizes so long names don't wrap. */
export function EditorCardTitle({ children, ...rest }: EditorCardTitleProps) {
  return (
    <Text
      variant="bodySmall"
      weight="bold"
      minWidth={0}
      style={ELLIPSIS_STYLE}
      {...rest}
    >
      {children}
    </Text>
  );
}

EditorCardTitle.displayName = "EditorCardTitle";

export type EditorCardMetaProps = ComponentProps<typeof Text> & {
  children: ReactNode;
};

/** Muted caption line under the title (price, role, percentage, etc.). */
export function EditorCardMeta({ children, ...rest }: EditorCardMetaProps) {
  return (
    <Text variant="caption" tone="muted" minWidth={0} {...rest}>
      {children}
    </Text>
  );
}

EditorCardMeta.displayName = "EditorCardMeta";

// ─── Actions slot ────────────────────────────────────────────────────────────

const EditorCardActionsFrame = styled(XStack, {
  name: "EditorCardActions",
  flexShrink: 0,
  alignItems: "center",
  gap: "$1",
});

export type EditorCardActionsProps = ComponentProps<
  typeof EditorCardActionsFrame
> & {
  children: ReactNode;
};

/**
 * Right-aligned action slot for delete / drag affordances that must stay on the
 * card. Each child should be its own >=44px control. Pass this to the `actions`
 * prop of a static `EditorCard` (no `onPress`); it renders as a non-shrinking
 * sibling of the title/meta column, so the buttons aren't nested inside an
 * interactive card.
 */
export function EditorCardActions({
  children,
  ...rest
}: EditorCardActionsProps) {
  return (
    <EditorCardActionsFrame
      {...({ "data-testid": "editor-card-actions" } as Record<string, unknown>)}
      {...rest}
    >
      {children}
    </EditorCardActionsFrame>
  );
}

EditorCardActions.displayName = "EditorCardActions";
