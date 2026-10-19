// @ts-nocheck — Tamagui ListItem children type mismatch with React 19 ReactNode
"use client";

import {
  Children,
  cloneElement,
  forwardRef,
  isValidElement,
  useCallback,
  useMemo,
  useState,
  type KeyboardEventHandler,
  type ReactElement,
  type ReactNode,
} from "react";
import { Platform } from "react-native";
import {
  Stack,
  XStack,
  YStack,
  styled,
  type TamaguiElement,
  type XStackProps,
  type YStackProps,
} from "tamagui";

import { ChevronDown, ChevronRight } from "lucide-react";

import { Text } from "../typography/Text";

const isWeb = Platform.OS === "web";

const IconContainer = styled(Stack, {
  name: "ListItemIconContainer",
  width: 28,
  height: 28,
  borderRadius: 0,
  borderWidth: 2,
  borderColor: "$borderColor",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
});

const TrailingContainer = styled(IconContainer, {
  name: "ListItemTrailingContainer",
});

const TextContainer = styled(YStack, {
  name: "ListItemTextContainer",
  flex: 1,
});

export interface ListItemProps extends Omit<XStackProps, "children"> {
  title: string;
  subtitle?: string;
  leadingAccessory?: ReactNode;
  trailingAccessory?: ReactNode;

  /**
   * Enables an expandable/collapsible area beneath the row.
   * When enabled, the row becomes interactive (press/click toggles).
   */
  collapsible?: boolean;

  /** Controlled collapsed state (when `collapsible`). `true` means content is hidden. */
  collapsed?: boolean;

  /** Uncontrolled initial collapsed state (when `collapsible`). Defaults to `true`. */
  defaultCollapsed?: boolean;

  /** Called when collapsed state changes (when `collapsible`). */
  onCollapsedChange?: (collapsed: boolean) => void;

  /** Content rendered beneath the row when expanded (when `collapsible`). */
  collapseContent?: ReactNode;

  /** Optional aria-label override for the collapse toggle semantics (web). */
  collapseLabel?: string;

  /** Show a chevron indicator (defaults to true when `collapsible`). */
  showCollapseChevron?: boolean;
  standalone?: boolean;
  showDivider?: boolean;
  testIdBase?: string;
  qaId?: string;

  /** Web-only keydown handler for keyboard navigation. */
  onKeyDown?: KeyboardEventHandler;
}

const resolveSlotAutomationProps = (
  baseId: string,
  qaId: string,
  slot: string,
) => {
  const slotId = `${baseId}-${slot}`;
  const slotQa = `${qaId}-${slot}`;

  if (isWeb) {
    return {
      "data-testid": slotId,
      "data-qa": slotQa,
    } as const;
  }

  return {
    testID: slotId,
    accessibilityLabel: slotQa,
  } as const;
};

export const ListItem = forwardRef<TamaguiElement, ListItemProps>(
  (
    {
      title,
      subtitle,
      leadingAccessory,
      trailingAccessory,
      collapsible = false,
      collapsed: collapsedProp,
      defaultCollapsed = true,
      onCollapsedChange,
      collapseContent,
      collapseLabel,
      showCollapseChevron,
      standalone = false,
      showDivider = false,
      testIdBase,
      qaId,
      onKeyDown,
      role,
      accessibilityRole,
      ...rest
    },
    ref,
  ) => {
    const resolvedTestId = testIdBase ?? "list-item";
    const resolvedQaId = qaId ?? resolvedTestId;

    const automationProps = isWeb
      ? {
          "data-testid": resolvedTestId,
          "data-qa": resolvedQaId,
          "data-divider": showDivider ? "true" : "false",
        }
      : {
          testID: resolvedTestId,
          accessibilityLabel: resolvedQaId,
        };

    const dividerProps = showDivider
      ? {
          borderBottomWidth: 2,
          borderBottomColor: "$borderColor",
        }
      : undefined;

    const standaloneProps = standalone
      ? {
          borderWidth: 2,
          borderColor: "$borderColor",
          borderRadius: 0,
        }
      : undefined;

    const shouldRenderLeading =
      leadingAccessory !== undefined && leadingAccessory !== null;
    const shouldRenderTrailing =
      trailingAccessory !== undefined && trailingAccessory !== null;

    const isControlled = collapsedProp !== undefined;
    const [collapsedUncontrolled, setCollapsedUncontrolled] =
      useState(defaultCollapsed);

    const collapsed = collapsible
      ? isControlled
        ? Boolean(collapsedProp)
        : collapsedUncontrolled
      : true;
    const expanded = collapsible ? !collapsed : false;

    const effectiveShowChevron = useMemo(() => {
      if (!collapsible) {
        return false;
      }
      return showCollapseChevron ?? true;
    }, [collapsible, showCollapseChevron]);

    const resolvedTrailingAccessory = useMemo(() => {
      if (!effectiveShowChevron) {
        return trailingAccessory;
      }

      const chevron = expanded ? (
        <ChevronDown size={16} strokeWidth={1.5} />
      ) : (
        <ChevronRight size={16} strokeWidth={1.5} />
      );
      if (trailingAccessory) {
        return (
          <XStack gap="$2" alignItems="center">
            {trailingAccessory}
            {chevron}
          </XStack>
        );
      }
      return chevron;
    }, [effectiveShowChevron, expanded, trailingAccessory]);

    const handleToggle = useCallback(() => {
      if (!collapsible) {
        return;
      }
      const nextCollapsed = !collapsed;
      if (!isControlled) {
        setCollapsedUncontrolled(nextCollapsed);
      }
      onCollapsedChange?.(nextCollapsed);
    }, [collapsible, collapsed, isControlled, onCollapsedChange]);

    const handleKeyDownInternal: KeyboardEventHandler = useCallback(
      (event) => {
        onKeyDown?.(event);

        if (!isWeb || !collapsible) {
          return;
        }

        if (event.defaultPrevented) {
          return;
        }

        // Match native "disclosure" behavior on web.
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handleToggle();
        }
      },
      [collapsible, handleToggle, onKeyDown],
    );

    const webKeyDownProps = (
      isWeb ? ({ onKeyDown: handleKeyDownInternal } as unknown) : {}
    ) as Record<string, unknown>;

    const collapsiblePressProps = collapsible
      ? ({
          onPress: handleToggle,
          cursor: "pointer",
        } as const)
      : undefined;

    const webDisclosureA11yProps =
      isWeb && collapsible
        ? ({
            role: role ?? "button",
            "aria-expanded": expanded,
            "aria-label": collapseLabel ?? title,
          } as const)
        : ({} as const);

    const contentAutomationProps = collapsible
      ? isWeb
        ? ({ "data-testid": `${resolvedTestId}-collapse-content` } as const)
        : ({ testID: `${resolvedTestId}-collapse-content` } as const)
      : ({} as const);

    const row = (
      <XStack
        ref={ref}
        alignItems="center"
        justifyContent="space-between"
        gap="$3"
        paddingHorizontal="$4"
        paddingVertical="$3"
        backgroundColor="$surface"
        accessibilityRole={
          !isWeb ? (accessibilityRole ?? "text") : accessibilityRole
        }
        {...webDisclosureA11yProps}
        {...webKeyDownProps}
        {...collapsiblePressProps}
        {...standaloneProps}
        {...dividerProps}
        {...automationProps}
        {...rest}
      >
        {shouldRenderLeading ? (
          <IconContainer
            {...resolveSlotAutomationProps(
              resolvedTestId,
              resolvedQaId,
              "leading",
            )}
            backgroundColor="$surface"
          >
            {leadingAccessory}
          </IconContainer>
        ) : null}

        <TextContainer gap={subtitle ? "$1" : "$0"}>
          <Text variant="body" weight="bold">
            {title}
          </Text>
          {subtitle ? (
            <Text variant="bodySmall" tone="muted">
              {subtitle}
            </Text>
          ) : null}
        </TextContainer>

        {shouldRenderTrailing || effectiveShowChevron ? (
          <TrailingContainer
            {...resolveSlotAutomationProps(
              resolvedTestId,
              resolvedQaId,
              "trailing",
            )}
            backgroundColor="$surface"
          >
            {resolvedTrailingAccessory}
          </TrailingContainer>
        ) : null}
      </XStack>
    );

    if (!collapsible) {
      // Preserve legacy semantics.
      return cloneElement(row, {
        role: isWeb ? (role ?? "listitem") : role,
      });
    }

    return (
      <YStack gap={0}>
        {row}
        {expanded && collapseContent ? (
          <YStack
            paddingHorizontal="$4"
            paddingBottom="$3"
            backgroundColor="$surface"
            {...(contentAutomationProps as any)}
          >
            {collapseContent}
          </YStack>
        ) : null}
      </YStack>
    );
  },
);

ListItem.displayName = "ListItem";

type ListItemElement = ReactElement<ListItemProps>;

const isListItemElement = (child: ReactNode): child is ListItemElement =>
  isValidElement<ListItemProps>(child) && child.type === ListItem;

const countListItemElements = (nodes: ReactNode): number =>
  Children.toArray(nodes).reduce((count, child) => {
    if (isListItemElement(child)) {
      return count + 1;
    }

    if (isValidElement(child) && child.props.children !== undefined) {
      return count + countListItemElements(child.props.children);
    }

    return count;
  }, 0);

export interface ListItemGroupProps extends Omit<YStackProps, "children"> {
  children: ReactNode;
  bordered?: boolean;
  testIdBase?: string;
  qaId?: string;
}

const GroupContainer = styled(YStack, {
  name: "ListItemGroup",
  gap: 0,
  borderRadius: 0,
  overflow: "hidden",
  backgroundColor: "$surface",
  variants: {
    bordered: {
      true: {
        borderWidth: 2,
        borderColor: "$borderColor",
      },
      false: {
        borderWidth: 0,
      },
    },
  },
});

export const ListItemGroup = forwardRef<TamaguiElement, ListItemGroupProps>(
  (
    {
      children,
      bordered = true,
      testIdBase,
      qaId,
      role,
      accessibilityRole,
      ...rest
    },
    ref,
  ) => {
    const resolvedTestId = testIdBase ?? "list-item-group";
    const resolvedQaId = qaId ?? resolvedTestId;

    const automationProps = isWeb
      ? {
          "data-testid": resolvedTestId,
          "data-qa": resolvedQaId,
        }
      : {
          testID: resolvedTestId,
          accessibilityLabel: resolvedQaId,
        };

    const items = Children.toArray(children);
    const listItemCount = countListItemElements(items);
    let listItemIndex = 0;

    const decorateChildren = (nodes: ReactNode): ReactNode =>
      Children.map(nodes, (child) => {
        if (!isValidElement(child)) {
          return child;
        }

        if (isListItemElement(child)) {
          listItemIndex += 1;
          const overrideProps: Partial<ListItemProps> = {};

          if (child.props.showDivider === undefined) {
            overrideProps.showDivider = listItemIndex < listItemCount;
          }

          if (child.props.standalone !== false) {
            overrideProps.standalone = false;
          }

          if (child.props.testIdBase === undefined) {
            overrideProps.testIdBase = `${resolvedTestId}-item-${listItemIndex}`;
          }

          if (child.props.qaId === undefined) {
            overrideProps.qaId = `${resolvedQaId}-item-${listItemIndex}`;
          }

          return cloneElement(child, overrideProps);
        }

        if (child.props.children === undefined) {
          return child;
        }

        return cloneElement(
          child,
          undefined,
          decorateChildren(child.props.children),
        );
      });

    return (
      <GroupContainer
        ref={ref}
        bordered={bordered}
        role={isWeb ? (role ?? "list") : role}
        accessibilityRole={
          !isWeb ? (accessibilityRole ?? "list") : accessibilityRole
        }
        {...automationProps}
        {...rest}
      >
        {decorateChildren(items)}
      </GroupContainer>
    );
  },
);

ListItemGroup.displayName = "ListItemGroup";

export type { ListItemElement };
