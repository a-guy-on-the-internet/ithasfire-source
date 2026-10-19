"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import type {
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { Editor } from "@tiptap/core";
import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2 } from "lucide-react";
import { Popover, useTranslations } from "@th/ui";
import { InsertMenu } from "./InsertMenu";
import { filterInsertItems, type InsertMenuItem } from "./insert-menu-items";
import {
  pickSlashMenuItem,
  setSlashMenuIndex,
  slashMenuKey,
} from "./SlashMenu";
import {
  BLOCK_MOVE_META,
  activeGripDrag,
  boundaryY,
  deleteBlock,
  dropBoundary,
  dropGripDrag,
  endBlockDrag,
  moveBlocks,
  startBlockDrag,
  topLevelIndexAt,
  topLevelRects,
  topLevelStart,
  type MoveDirection,
} from "./block-moves";
import "./block-gutter.css";

/**
 * Same layer as the toolbar's More panel: above Modal (10000), so the menus
 * open inside the announcement composer's dialog.
 */
const MENU_Z_INDEX = 10001;

export type BlockGutterProps = {
  editor: Editor;
  /** The insert items for this editor, the same list the "/" plugin reads. */
  items: readonly InsertMenuItem[];
  /** The "/" menu's listbox id, as given to the SlashMenu extension. */
  listboxId: string;
  editable: boolean;
};

/** Index of the top-level block nearest the viewport y coordinate `y`. */
function blockIndexAtY(editor: Editor, y: number): number {
  const { view } = editor;
  const { doc } = view.state;
  let best = -1;
  let bestDistance = Infinity;
  let pos = 0;
  for (let i = 0; i < doc.childCount; i++) {
    const dom = view.nodeDOM(pos);
    pos += doc.child(i).nodeSize;
    if (!(dom instanceof HTMLElement)) continue;
    const rect = dom.getBoundingClientRect();
    const distance =
      y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
      if (distance === 0) break;
    }
  }
  return best;
}

/**
 * The y of the middle of block `index`'s first line, relative to `layer`, so
 * a control beside it lines up with the text and not with the block's
 * middle (a long paragraph, a tall image).
 */
function firstLineCenter(
  editor: Editor,
  index: number,
  layer: HTMLElement,
): number | null {
  const { view } = editor;
  const { doc } = view.state;
  if (index < 0 || index >= doc.childCount) return null;
  const dom = view.nodeDOM(topLevelStart(doc, index));
  if (!(dom instanceof HTMLElement)) return null;
  const rect = dom.getBoundingClientRect();
  const base = layer.getBoundingClientRect();
  const style = window.getComputedStyle(dom);
  let lineHeight = parseFloat(style.lineHeight);
  if (!Number.isFinite(lineHeight)) {
    lineHeight = (parseFloat(style.fontSize) || 16) * 1.2;
  }
  return rect.top - base.top + Math.min(lineHeight, rect.height) / 2;
}

function matchesFinePointer(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: fine)")?.matches === true
  );
}

/**
 * The editor's left gutter: the "+" beside an empty paragraph holding the
 * caret, the grip beside a block (the one under a mouse, else the one with
 * the selection), the grip's Move up / Move down / Delete menu, the "/"
 * menu's popover, and a live region that announces moves.
 *
 * Everything here is UI state. Opening a menu, hovering a block or showing a
 * control dispatches no document change, so `onChange` and the builder's
 * unsaved-changes guard only ever see the edits a pick or a move makes.
 */
export function BlockGutter({
  editor,
  items,
  listboxId,
  editable,
}: BlockGutterProps) {
  const t = useTranslations();
  const label = (key: string) => String(t(key));
  // Re-read the editor on every transaction (typing, selection, focus) and
  // on reflow (an image finishing loading moves every block below it).
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [plusEl, setPlusEl] = useState<HTMLButtonElement | null>(null);
  const [gripEl, setGripEl] = useState<HTMLDivElement | null>(null);
  const [caretEl, setCaretEl] = useState<HTMLSpanElement | null>(null);
  const plusMenuRef = useRef<HTMLDivElement | null>(null);
  const gripMenuRef = useRef<HTMLDivElement | null>(null);

  // Stable, so they run once per opening and not on every re-render: a
  // re-run would yank focus back to the first entry after each move.
  const plusMenuMounted = useCallback((node: HTMLDivElement | null) => {
    plusMenuRef.current = node;
    node?.focus({ preventScroll: true });
  }, []);
  const gripMenuMounted = useCallback((node: HTMLDivElement | null) => {
    gripMenuRef.current = node;
    node
      ?.querySelector<HTMLElement>(
        '[role="menuitem"]:not([aria-disabled="true"])',
      )
      ?.focus({ preventScroll: true });
  }, []);

  const [focusWithin, setFocusWithin] = useState(false);
  // Between pressing a control and its click: a press blurs the editor
  // first (Safari does not focus a pressed button), and the control must
  // not vanish before its click lands.
  const [pressing, setPressing] = useState(false);
  const [hovered, setHovered] = useState<number | null>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [plusIndex, setPlusIndex] = useState(0);
  const [gripMenu, setGripMenu] = useState<{ index: number } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [finePointer] = useState(matchesFinePointer);
  // A grip drag in flight: the block it carries, and where its top-level
  // insertion line sits (layer px; null while the drop would change nothing).
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropLineY, setDropLineY] = useState<number | null>(null);

  const plusListId = `${listboxId}-plus`;
  const gripMenuId = useId();

  const announce = useCallback((message: string) => {
    // A trailing zero-width space when the text repeats, so a second
    // "moved up" in a row is announced too.
    setAnnouncement((prev) =>
      prev === message ? `${message}\u200b` : message,
    );
  }, []);

  useEffect(() => {
    const onTransaction = ({
      transaction,
    }: {
      transaction: { getMeta: (key: string) => unknown };
    }) => {
      const moved = transaction.getMeta(BLOCK_MOVE_META) as
        | MoveDirection
        | undefined;
      if (moved) {
        announce(
          label(
            moved === "up" ? "admin.peBlockMovedUp" : "admin.peBlockMovedDown",
          ),
        );
      }
      rerender();
    };
    editor.on("transaction", onTransaction);
    editor.on("focus", rerender);
    editor.on("blur", rerender);
    const dom = editor.view.dom;
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => rerender());
    observer?.observe(dom);
    return () => {
      editor.off("transaction", onTransaction);
      editor.off("focus", rerender);
      editor.off("blur", rerender);
      observer?.disconnect();
    };
    // `label` reads `t`, which is stable for the editor's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, announce]);

  // Focus anywhere in the editor box (the text, the "+", the grip) keeps the
  // controls up; the hovered block follows a mouse, never a finger.
  useEffect(() => {
    const host = layerRef.current?.parentElement;
    if (!host) return;
    const inside = (node: EventTarget | null) =>
      node instanceof Node &&
      (host.contains(node) ||
        !!plusMenuRef.current?.contains(node) ||
        !!gripMenuRef.current?.contains(node));
    const onFocusIn = () => setFocusWithin(true);
    const onFocusOut = (event: FocusEvent) => {
      if (!inside(event.relatedTarget)) setFocusWithin(false);
    };
    let frame = 0;
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      const y = event.clientY;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const index = blockIndexAtY(editor, y);
        setHovered(index < 0 ? null : index);
      });
    };
    const onPointerLeave = () => {
      cancelAnimationFrame(frame);
      setHovered(null);
    };
    host.addEventListener("focusin", onFocusIn);
    host.addEventListener("focusout", onFocusOut);
    host.addEventListener("pointermove", onPointerMove);
    host.addEventListener("pointerleave", onPointerLeave);
    return () => {
      cancelAnimationFrame(frame);
      host.removeEventListener("focusin", onFocusIn);
      host.removeEventListener("focusout", onFocusOut);
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerleave", onPointerLeave);
    };
  }, [editor, editable]);

  useEffect(() => {
    if (!pressing) return;
    const release = () => window.setTimeout(() => setPressing(false), 0);
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    return () => {
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
    };
  }, [pressing]);

  // Read-only (preview, a pending submit): no controls, no open menus.
  useEffect(() => {
    if (editable) return;
    setPlusOpen(false);
    setGripMenu(null);
    setHovered(null);
    if (activeGripDrag(editor.view) !== null) endBlockDrag(editor.view);
    setDragFrom(null);
    setDropLineY(null);
  }, [editable, editor]);

  // A press outside an open menu and its trigger closes the menu.
  useEffect(() => {
    if (!plusOpen && !gripMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (plusOpen && !plusMenuRef.current?.contains(target) &&
        !plusEl?.contains(target)) {
        setPlusOpen(false);
      }
      if (gripMenu && !gripMenuRef.current?.contains(target) &&
        !gripEl?.contains(target)) {
        setGripMenu(null);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [plusOpen, gripMenu, plusEl, gripEl]);

  // Escape closes an open menu before anyone else hears it. The builder's
  // leave-page guard and Modal listen on window; a document capture listener
  // runs first wherever focus is (the menu, the editor after a pick, body).
  useEffect(() => {
    if (!plusOpen && !gripMenu) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (gripMenu) {
        gripEl?.focus();
        setGripMenu(null);
      }
      if (plusOpen) {
        plusEl?.focus();
        setPlusOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [plusOpen, gripMenu, plusEl, gripEl]);

  // A grip drag: draw the top-level insertion line, accept drops anywhere in
  // the editor box (the gutter too), and finish them here, ahead of
  // ProseMirror's own drop, which would nest the block in a list item.
  useEffect(() => {
    const layer = layerRef.current;
    const host = layer?.parentElement;
    if (dragFrom === null || !layer || !host) return;
    const { view } = editor;
    host.classList.add("th-pe-grip-dragging");
    const onDragOver = (event: DragEvent) => {
      if (activeGripDrag(view) === null) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      const rects = topLevelRects(view);
      const boundary = dropBoundary(rects, event.clientY);
      setDropLineY(
        boundary === dragFrom || boundary === dragFrom + 1
          ? null
          : boundaryY(rects, boundary) - layer.getBoundingClientRect().top,
      );
    };
    const onDragLeave = (event: DragEvent) => {
      const next = event.relatedTarget;
      if (!(next instanceof Node) || !host.contains(next)) setDropLineY(null);
    };
    const finish = () => {
      setDragFrom(null);
      setDropLineY(null);
    };
    // Only drops OUTSIDE the editable (the gutter, the padding) are taken
    // here. A drop on the text goes on to ProseMirror, whose drop calls
    // BlockMove's handleDrop (the same snapping) and also tells its drop
    // cursor the drag is over; stopping it here left that cursor on screen
    // for up to 5 s once the hiding class came off.
    const onDrop = (event: DragEvent) => {
      const target = event.target;
      if (target instanceof Node && view.dom.contains(target)) {
        finish();
        return;
      }
      if (!dropGripDrag(view, event.clientY)) return;
      event.preventDefault();
      event.stopPropagation();
      finish();
    };
    // The grip may unmount mid-drag (read-only, the block deleted), and its
    // own dragend with it; a stale drag would later swallow a file drop.
    const onDragEnd = () => {
      endBlockDrag(view);
      finish();
    };
    host.addEventListener("dragover", onDragOver);
    host.addEventListener("dragleave", onDragLeave);
    host.addEventListener("drop", onDrop, true);
    window.addEventListener("dragend", onDragEnd, true);
    return () => {
      host.classList.remove("th-pe-grip-dragging");
      host.removeEventListener("dragover", onDragOver);
      host.removeEventListener("dragleave", onDragLeave);
      host.removeEventListener("drop", onDrop, true);
      window.removeEventListener("dragend", onDragEnd, true);
    };
  }, [editor, dragFrom]);

  // ─── What shows where ─────────────────────────────────────────────────────
  const { state } = editor;
  const { doc, selection } = state;
  const slash = slashMenuKey.getState(state);
  const slashItems = slash?.active ? filterInsertItems(items, slash.query) : [];
  const selIndex = topLevelIndexAt(doc, selection.from);
  const { $from } = selection;
  const caretInEmptyParagraph =
    selection.empty &&
    $from.depth === 1 &&
    $from.parent.type.name === "paragraph" &&
    $from.parent.content.size === 0;
  const engaged =
    editable && (focusWithin || pressing || plusOpen || gripMenu !== null);
  const showPlus =
    editable &&
    items.length > 0 &&
    (plusOpen || (engaged && caretInEmptyParagraph && !slash?.active));
  const plusBlock = showPlus ? selIndex : -1;
  const gripTarget = !editable
    ? -1
    : gripMenu
      ? gripMenu.index
      : hovered !== null
        ? hovered
        : engaged
          ? selIndex
          : -1;
  const gripIndex =
    gripTarget >= 0 && gripTarget < doc.childCount && gripTarget !== plusBlock
      ? gripTarget
      : -1;

  // Place the controls (and the "/" menu's caret anchor) after every render:
  // a pure DOM read and style write, no state.
  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const place = (el: HTMLElement | null, index: number) => {
      if (!el || index < 0) return;
      const y = firstLineCenter(editor, index, layer);
      if (y !== null) el.style.top = `${y}px`;
    };
    place(plusEl, plusBlock);
    place(gripEl, gripIndex);
    if (caretEl && slash?.active) {
      try {
        const coords = editor.view.coordsAtPos(slash.from);
        const base = layer.getBoundingClientRect();
        caretEl.style.top = `${coords.top - base.top}px`;
        caretEl.style.left = `${coords.left - base.left}px`;
        caretEl.style.height = `${Math.max(0, coords.bottom - coords.top)}px`;
      } catch {
        // No layout (jsdom, a hidden tab): the menu opens at the layer's corner.
      }
    }
  });

  // ─── "+" menu ─────────────────────────────────────────────────────────────
  const closePlus = (returnFocus: boolean) => {
    // Focus first, while the "+" is still mounted: its focus keeps the
    // gutter engaged once the menu is gone.
    if (returnFocus) plusEl?.focus();
    setPlusOpen(false);
  };
  const pickPlus = (index: number) => {
    const item = items[index];
    if (!item) return;
    setPlusOpen(false);
    editor.commands.focus();
    item.run();
  };
  const onPlusMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const count = items.length;
    if (count === 0) return;
    const go = (index: number) => {
      event.preventDefault();
      setPlusIndex(((index % count) + count) % count);
    };
    switch (event.key) {
      case "ArrowDown":
        return go(plusIndex + 1);
      case "ArrowUp":
        return go(plusIndex - 1);
      case "Home":
        return go(0);
      case "End":
        return go(count - 1);
      case "Enter":
      case " ":
        event.preventDefault();
        return pickPlus(plusIndex);
      case "Escape":
        // Stop here: inside a Modal, Escape on window closes the dialog.
        event.preventDefault();
        event.stopPropagation();
        return closePlus(true);
      case "Tab":
        // The list is portalled to <body>; the next Tab stop would be
        // nowhere near the editor. Back to the "+", like the More panel.
        event.preventDefault();
        return closePlus(true);
      default: {
        if (event.key.length !== 1 || event.altKey || event.ctrlKey ||
          event.metaKey) {
          return;
        }
        const match = filterInsertItems(items, event.key)[0];
        if (match) go(items.indexOf(match));
      }
    }
  };

  // ─── Grip menu ────────────────────────────────────────────────────────────
  const gripMenuItems = () =>
    Array.from(
      gripMenuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ??
        [],
    );
  const closeGripMenu = (returnFocus: boolean) => {
    if (returnFocus) gripEl?.focus();
    setGripMenu(null);
  };
  const runMove = (direction: MoveDirection) => {
    if (!gripMenu) return;
    const tr = moveBlocks(editor.state, direction, gripMenu.index);
    if (!tr) return;
    editor.view.dispatch(tr);
    // The menu stays open on the block it moved, for the next move.
    setGripMenu({
      index: gripMenu.index + (direction === "up" ? -1 : 1),
    });
  };
  const runDelete = () => {
    if (!gripMenu) return;
    const tr = deleteBlock(editor.state, gripMenu.index);
    setGripMenu(null);
    if (!tr) return;
    editor.view.dispatch(tr);
    editor.commands.focus();
    announce(label("admin.peBlockDeleted"));
  };
  const onGripMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const entries = gripMenuItems();
    const at = entries.indexOf(document.activeElement as HTMLElement);
    const focusAt = (index: number) => {
      event.preventDefault();
      const count = entries.length;
      entries[((index % count) + count) % count]?.focus();
    };
    switch (event.key) {
      case "ArrowDown":
        return focusAt(at + 1);
      case "ArrowUp":
        return focusAt(at - 1);
      case "Home":
        return focusAt(0);
      case "End":
        return focusAt(entries.length - 1);
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        return closeGripMenu(true);
      case "Tab":
        event.preventDefault();
        return closeGripMenu(true);
    }
  };
  const openGripMenu = (index: number) => {
    setPlusOpen(false);
    setGripMenu({ index });
  };

  const onGripDragStart = (event: ReactDragEvent<HTMLDivElement>) => {
    setGripMenu(null);
    setPlusOpen(false);
    if (!startBlockDrag(editor.view, gripIndex, event.nativeEvent)) {
      event.preventDefault();
      return;
    }
    setDragFrom(gripIndex);
  };
  const onGripDragEnd = () => {
    endBlockDrag(editor.view);
    setDragFrom(null);
    setDropLineY(null);
  };

  if (!editable) return null;

  const lastIndex = doc.childCount - 1;
  const menuIndex = gripMenu?.index ?? -1;
  const menuEntry = (
    testId: string,
    text: string,
    Icon: typeof ArrowUp,
    onSelect: () => void,
    disabledEntry = false,
    danger = false,
  ) => (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      className={`th-pe-menu-item${danger ? " th-pe-menu-item--danger" : ""}`}
      aria-disabled={disabledEntry || undefined}
      data-testid={testId}
      onClick={(event) => {
        // The menu's mousedown keeps focus where it is (Safari would not
        // focus a clicked button anyway), so focus follows the click here.
        event.currentTarget.focus({ preventScroll: true });
        if (!disabledEntry) onSelect();
      }}
    >
      <Icon size={16} aria-hidden />
      <span>{text}</span>
    </button>
  );

  return (
    <div ref={layerRef} className="th-pe-gutter" data-testid="prose-gutter">
      {/* Where the "/" menu hangs from: the caret's line box. */}
      <span ref={setCaretEl} className="th-pe-caret-anchor" aria-hidden />

      {showPlus && (
        <button
          ref={setPlusEl}
          type="button"
          className="th-pe-gutter-btn"
          aria-label={label("admin.peInsertBlock")}
          title={finePointer ? label("admin.peInsertBlock") : undefined}
          aria-haspopup="listbox"
          aria-expanded={plusOpen}
          aria-controls={plusOpen ? plusListId : undefined}
          data-testid="prose-insert-block-btn"
          onPointerDown={() => setPressing(true)}
          // Keep the caret where it is: the pick lands in this paragraph.
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={() => {
            if (plusOpen) {
              closePlus(true);
              return;
            }
            setGripMenu(null);
            setPlusIndex(0);
            setPlusOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && !plusOpen) {
              event.preventDefault();
              setPlusIndex(0);
              setPlusOpen(true);
            }
          }}
        >
          <Plus size={16} aria-hidden />
        </button>
      )}

      {gripIndex >= 0 && (
        // A div, not a <button>: Firefox will not start a drag from a button.
        <div
          ref={setGripEl}
          role="button"
          tabIndex={0}
          className="th-pe-gutter-btn th-pe-grip"
          aria-label={label("admin.peBlockHandle")}
          title={finePointer ? label("admin.peBlockHandleHint") : undefined}
          aria-haspopup="menu"
          aria-keyshortcuts="Alt+Shift+ArrowUp Alt+Shift+ArrowDown"
          aria-expanded={gripMenu !== null}
          aria-controls={gripMenu ? gripMenuId : undefined}
          data-testid="prose-block-grip"
          data-block-index={gripIndex}
          draggable={finePointer}
          onPointerDown={() => setPressing(true)}
          // Not into the wrapper's click-to-focus-the-end handler.
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() =>
            gripMenu ? closeGripMenu(true) : openGripMenu(gripIndex)
          }
          onKeyDown={(event) => {
            if (
              event.key === "Enter" ||
              event.key === " " ||
              (event.key === "ArrowDown" && !gripMenu)
            ) {
              event.preventDefault();
              openGripMenu(gripIndex);
            }
          }}
          onDragStart={onGripDragStart}
          onDragEnd={onGripDragEnd}
        >
          <GripVertical size={16} aria-hidden />
        </div>
      )}

      {slash?.active && slashItems.length > 0 && (
        <Popover
          open
          anchorElement={caretEl}
          placement="bottom-start"
          matchAnchorWidth={false}
          contentProps={{ zIndex: MENU_Z_INDEX }}
        >
          <InsertMenu
            id={listboxId}
            label={label("admin.peInsertBlock")}
            items={slashItems}
            activeIndex={slash.index}
            onPick={(index) =>
              pickSlashMenuItem(editor.view, () => items, index)
            }
            onHover={(index) => setSlashMenuIndex(editor.view, index)}
          />
        </Popover>
      )}

      {plusOpen && (
        <Popover
          open
          anchorElement={plusEl}
          placement="bottom-start"
          matchAnchorWidth={false}
          contentProps={{ zIndex: MENU_Z_INDEX }}
        >
          <InsertMenu
            id={plusListId}
            label={label("admin.peInsertBlock")}
            items={items}
            activeIndex={Math.min(plusIndex, items.length - 1)}
            focusable
            listRef={plusMenuMounted}
            onKeyDown={onPlusMenuKeyDown}
            onPick={pickPlus}
            onHover={setPlusIndex}
          />
        </Popover>
      )}

      {gripMenu && (
        <Popover
          open
          anchorElement={gripEl}
          placement="bottom-start"
          matchAnchorWidth={false}
          contentProps={{ zIndex: MENU_Z_INDEX }}
        >
          <div
            ref={gripMenuMounted}
            id={gripMenuId}
            role="menu"
            // No focus change and no bubbling into the editor box's
            // click-on-padding handler (React bubbles through the portal).
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            aria-label={label("admin.peBlockHandle")}
            className="th-pe-menu"
            data-testid="prose-block-menu"
            onKeyDown={onGripMenuKeyDown}
          >
            {menuEntry(
              "prose-block-move-up",
              label("admin.peMoveBlockUp"),
              ArrowUp,
              () => runMove("up"),
              menuIndex <= 0,
            )}
            {menuEntry(
              "prose-block-move-down",
              label("admin.peMoveBlockDown"),
              ArrowDown,
              () => runMove("down"),
              menuIndex >= lastIndex,
            )}
            {menuEntry(
              "prose-block-delete",
              label("admin.peDeleteBlock"),
              Trash2,
              runDelete,
              false,
              true,
            )}
          </div>
        </Popover>
      )}

      {dropLineY !== null && (
        <div
          className="th-pe-drop-line"
          data-testid="prose-block-drop-line"
          style={{ top: dropLineY }}
          aria-hidden
        />
      )}

      <span role="status" aria-live="polite" className="th-pe-sr-only">
        {announcement}
      </span>
    </div>
  );
}
