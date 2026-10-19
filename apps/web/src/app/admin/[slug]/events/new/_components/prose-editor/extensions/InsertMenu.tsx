"use client";

import { useCallback, useEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, Ref } from "react";
import { insertOptionId, type InsertMenuItem } from "./insert-menu-items";

export type InsertMenuProps = {
  /** DOM id of the listbox; option ids derive from it (`insertOptionId`). */
  id: string;
  /** Accessible name of the list ("Insert block"). */
  label: string;
  /** The items to show, already filtered. */
  items: readonly InsertMenuItem[];
  activeIndex: number;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
  /**
   * The "+" button's menu takes focus itself (`tabIndex`, `onKeyDown`). The
   * "/" menu leaves focus in the editor, which drives it through the plugin,
   * so it passes neither.
   */
  focusable?: boolean;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  listRef?: Ref<HTMLDivElement>;
};

/**
 * The block list shared by the "/" menu and the "+" button: a listbox whose
 * active option is announced through `aria-activedescendant`, either on the
 * editor (the "/" menu, see SlashMenu.ts) or on this list (the "+" menu).
 *
 * Options are picked on click with the mousedown suppressed, so the "/" menu
 * never blurs the editor (a blur closes it) on the way to a pick.
 */
export function InsertMenu({
  id,
  label,
  items,
  activeIndex,
  onPick,
  onHover,
  focusable = false,
  onKeyDown,
  listRef,
}: InsertMenuProps) {
  const ownRef = useRef<HTMLDivElement | null>(null);
  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      ownRef.current = node;
      if (typeof listRef === "function") listRef(node);
      else if (listRef) listRef.current = node;
    },
    [listRef],
  );

  // Keep the active option in view when the arrows walk past the fold.
  useEffect(() => {
    // By id from the document: React's useId ids carry characters a CSS
    // selector would need escaped. Scrolled by hand, not scrollIntoView,
    // which would also scroll the Popover's clipping frame and the page.
    const list = ownRef.current;
    const option = list?.ownerDocument.getElementById(
      insertOptionId(id, activeIndex),
    );
    if (!list || !option) return;
    const top = option.offsetTop;
    const bottom = top + option.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight;
    }
  }, [id, activeIndex]);

  return (
    <div
      ref={setRef}
      id={id}
      role="listbox"
      aria-label={label}
      className="th-pe-menu"
      data-testid="prose-insert-menu"
      tabIndex={focusable ? -1 : undefined}
      aria-activedescendant={
        focusable && items.length > 0
          ? insertOptionId(id, activeIndex)
          : undefined
      }
      onKeyDown={onKeyDown}
    >
      {items.map((item, index) => {
        const Icon = item.icon;
        return (
          <div
            key={item.id}
            id={insertOptionId(id, index)}
            role="option"
            aria-selected={index === activeIndex}
            className="th-pe-menu-item"
            data-testid={`prose-insert-option-${item.id}`}
            // Keep focus (and the "/" menu's caret) where it is, and keep the
            // press out of the editor box's click-on-padding handler: React
            // bubbles it there through the portal.
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onMouseMove={() => {
              if (index !== activeIndex) onHover(index);
            }}
            onClick={() => onPick(index)}
          >
            <Icon size={16} aria-hidden />
            <span>{item.label}</span>
          </div>
        );
      })}
    </div>
  );
}
