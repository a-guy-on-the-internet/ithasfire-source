"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Platform } from "react-native";
import { Stack, YStack, XStack } from "tamagui";

import { Button, type ButtonProps } from "./Button";
import { Popover } from "../overlay/Popover";
import { Text } from "../typography/Text";

/**
 * MenuButton — one trigger opening a list of peer actions.
 *
 * Use it when several actions are **peers with no obvious default**. Two
 * wallet buttons sitting side by side in a toolbar is the case it exists for:
 * "Add to Apple Wallet" and "Add to Google Wallet" are one decision, not two,
 * and spelling both out makes them ~250px wide each next to a 125px "Refund" —
 * a bar of wildly uneven segments. Collapsed to "Add to wallet" they become one
 * evenly-sized action and the choice moves into the menu, where it belongs.
 *
 * If one action dominates the others, this is the wrong control — that is a
 * split button, or just the dominant action with the rest elsewhere.
 *
 * Closes on outside click and on Escape, and returns focus to the trigger so a
 * keyboard user is not dropped at the top of the document.
 */

export interface MenuButtonItem {
  label: string;
  /** Leading glyph, already rendered — the app owns its icon set. */
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** Destructive: rendered in the danger tone and placed last by convention. */
  danger?: boolean;
  testId?: string;
}

export interface MenuButtonProps
  extends Omit<ButtonProps, "children" | "onPress" | "label" | "icon"> {
  /**
   * Trigger label. Pass `""` together with `icon` for an icon-only trigger —
   * the button then needs its accessible name from `aria-label`.
   */
  label: string;
  /** Trigger's leading glyph. */
  icon?: ReactNode;
  items: MenuButtonItem[];
  /** Align the list to the trigger's right edge — for right-hand toolbars. */
  align?: "left" | "right";
  testId?: string;
}

const isWeb = Platform.OS === "web";

export const MenuButton = ({
  label,
  icon,
  items,
  align = "left",
  testId,
  ...buttonProps
}: MenuButtonProps) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  // The list is PORTALED out of `rootRef` by Floating UI, so a containment
  // check against the root alone counts every click on a menu item as an
  // outside click — it closed the menu on mousedown and the item's own click
  // never landed, which silently broke every action in it.
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus && triggerRef.current) {
      triggerRef.current.focus?.();
    }
  }, []);

  // Outside click and Escape. Both are listened for on the document rather than
  // the menu: a click that lands anywhere else must dismiss, including on
  // another control, and Escape has to work while focus is still on the trigger.
  useEffect(() => {
    if (!open || !isWeb) {
      return;
    }
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (!(e.target instanceof Node)) {
        return;
      }
      const inRoot = rootRef.current?.contains(e.target) ?? false;
      const inMenu = menuRef.current?.contains(e.target) ?? false;
      if (!inRoot && !inMenu) {
        close(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(true);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  // An icon-only trigger — a glyph with an empty label, its accessible name
  // riding `aria-label`. Rendering `{""}` anyway is not free: Tamagui still
  // emits a ButtonText child AND a gap Spacer between it and the icon, so the
  // frame's `gap` gets charged twice for a label of zero width. In the calendar
  // toolbar's 38px square that came to 16 + 8 + 10.56 + 8 = 42.56px inside a
  // 34px content box, and the icon — the only shrinkable item — was squeezed to
  // 7.4px and pinned flush against the left border. Drop the label child and
  // take the Button's own icon-only treatment (square, centred, no padding).
  const iconOnly = label === "" && icon != null;

  const trigger = (
    <Button
      {...(iconOnly ? ({ icon: true } as const) : {})}
      {...buttonProps}
      ref={triggerRef as never}
      onPress={() => setOpen((v) => !v)}
      {...(isWeb
        ? ({
            "aria-haspopup": "menu",
            "aria-expanded": open,
            "aria-controls": open ? menuId : undefined,
          } as Record<string, unknown>)
        : {})}
      {...(testId ? { "data-testid": testId } : {})}
    >
      {icon}
      {iconOnly ? null : label}
    </Button>
  );

  return (
    <Stack ref={rootRef as never} position="relative" alignSelf="stretch">
      <Popover
        open={open}
        anchor={trigger}
        placement={align === "right" ? "bottom-end" : "bottom-start"}
        // The list sizes to its own content: menu labels are longer than the
        // trigger's, and matching the anchor would truncate them.
        matchAnchorWidth={false}
        contentProps={{ padding: 0, minWidth: 200, borderWidth: 2 }}
      >
        <YStack
          ref={menuRef as never}
          {...(isWeb
            ? ({ role: "menu", id: menuId } as Record<string, unknown>)
            : {})}
        >
          {items.map((item, index) => (
            <XStack
              key={item.label}
              {...(isWeb
                ? ({
                    role: "menuitem",
                    tabIndex: item.disabled ? -1 : 0,
                    "aria-disabled": item.disabled || undefined,
                    onKeyDown: (e: React.KeyboardEvent) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        if (!item.disabled) {
                          item.onSelect();
                          close(true);
                        }
                      }
                    },
                  } as Record<string, unknown>)
                : {})}
              {...(item.testId ? { "data-testid": item.testId } : {})}
              onPress={() => {
                if (item.disabled) {
                  return;
                }
                item.onSelect();
                close(false);
              }}
              alignItems="center"
              gap="$3"
              paddingVertical="$3"
              paddingHorizontal="$4"
              minHeight={44}
              cursor={item.disabled ? "not-allowed" : "pointer"}
              opacity={item.disabled ? 0.5 : 1}
              // Hairline between items — the list is one object, not a stack
              // of separate rows.
              {...(index > 0
                ? { borderTopWidth: 1, borderTopColor: "$borderColorSoft" }
                : {})}
              hoverStyle={item.disabled ? {} : { backgroundColor: "$surfaceMuted" }}
            >
              {item.icon}
              <Text
                variant="bodySmall"
                flexShrink={1}
                {...(item.danger ? { color: "$dangerSoft" } : {})}
              >
                {item.label}
              </Text>
            </XStack>
          ))}
        </YStack>
      </Popover>
    </Stack>
  );
};
