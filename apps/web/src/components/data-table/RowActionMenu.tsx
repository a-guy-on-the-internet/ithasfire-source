"use client";

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { Popover } from "@th/ui";
import { MoreHorizontal } from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface RowActionMenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  /** "danger" renders in red — use for destructive actions like cancel/delete. */
  tone?: "default" | "danger";
  disabled?: boolean;
  /**
   * Optional `data-testid` for the rendered menu item. Lets an action keep a
   * stable test hook when it moves from an inline button into this menu.
   */
  testId?: string;
  /**
   * Optional class on the rendered menu item. Added for responsive callers
   * that show an action as an inline control on wide viewports and as a menu
   * item on phones: the class hides this half with `display: none` at the
   * widths where the inline half is the real one, so exactly ONE of the two
   * is in the accessibility tree. Keyboard navigation below skips any item
   * hidden this way. Purely additive — an item without it behaves as before.
   */
  className?: string;
  onPress: () => void;
}

export interface RowActionMenuProps {
  items: RowActionMenuItem[];
  /** Accessible label for the trigger button. */
  ariaLabel?: string;
  /**
   * `ghost` (default) — no border at rest (a 1px ink frame on hover), 36×36. Table rows use it: the `⋯` is the
   * quietest thing on the row, and a frame per row stacks a column of boxes
   * against the table's own rules. Toolbars use it for the same reason.
   * `framed` — the 32px, 1px-bordered square, for a standalone trigger with
   * no row or toolbar around it to read as its container (the public page
   * hero action bars pass it explicitly).
   * Hover fill, focus ring (the global `:focus-visible` rule) and aria are
   * identical between the two.
   */
  triggerVariant?: "framed" | "ghost";
}

/**
 * The items arrow keys and the open-focus may land on.
 *
 * Disabled items were always excluded. An item hidden by a caller's
 * `className` (a responsive half that is `display: none` at this width) has to
 * be excluded too: it is not in the accessibility tree, `.focus()` on it is a
 * silent no-op, and leaving it in the list would swallow an arrow press or
 * leave an opened menu with nothing focused.
 *
 * `display` is read from the COMPUTED style rather than from the class name so
 * this stays agnostic about which class a caller used. Under jsdom there is no
 * layout and no stylesheet, so the computed value is the component's own
 * inline `flex` and every item stays navigable — which is the correct answer
 * when no media query can be evaluated.
 */
function navigableItems(menu: HTMLElement): HTMLButtonElement[] {
  const all = Array.from(
    menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'),
  );
  if (typeof window === "undefined") return all;
  return all.filter((el) => window.getComputedStyle(el).display !== "none");
}

// ── Component ──────────────────────────────────────────────────────────────────

/**
 * Row overflow menu built on the shared `@th/ui` Popover (Floating UI):
 * portals to <body> so the menu is never clipped by the table's
 * `overflow: auto` container, repositions on scroll/resize (autoUpdate),
 * and flips above the trigger when there is no room below (flip middleware).
 *
 * Menu semantics (WAI-ARIA Menu pattern) stay local: Escape closes and
 * refocuses the trigger, arrow keys/Home/End move focus, outside clicks
 * close, and the first item is focused on open.
 */
export function RowActionMenu({
  items,
  ariaLabel = "Row actions",
  triggerVariant = "ghost",
}: RowActionMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Close on Escape. The consumed keystroke stops here: React flushes the
  // close in a microtask BETWEEN this document listener and any window
  // listener on the same event, so a page-level Escape handler that checks
  // the DOM for an open menu finds it already gone and fires too — the event
  // builder's "Escape leaves the page" did exactly that. Stopping propagation
  // at document reaches only window listeners; React's own handlers ran
  // earlier at the root.
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);

  // Focus the first menuitem when the menu opens.
  useEffect(() => {
    if (!open) return;
    // Defer to allow the menu DOM to render.
    const raf = requestAnimationFrame(() => {
      const menu = menuRef.current;
      if (menu) navigableItems(menu)[0]?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Arrow-key navigation inside the menu (WAI-ARIA Menu pattern).
  const handleMenuKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const menu = menuRef.current;
      if (!menu) return;

      const items = navigableItems(menu);
      if (items.length === 0) return;

      const current = document.activeElement as HTMLElement;
      const index = items.indexOf(current as HTMLButtonElement);

      let next: HTMLButtonElement | undefined;

      // Handled keys must ALSO stop propagation: the menu renders inside
      // table rows whose onRowPress/keyboard handlers listen on ancestors —
      // a leaked Enter toggled ROW expansion instead of the menu item, and
      // leaked arrows yanked focus into the table's own row navigation.
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          e.stopPropagation();
          next = items[(index + 1) % items.length];
          break;
        case "ArrowUp":
          e.preventDefault();
          e.stopPropagation();
          next = items[(index - 1 + items.length) % items.length];
          break;
        case "Home":
          e.preventDefault();
          e.stopPropagation();
          next = items[0];
          break;
        case "End":
          e.preventDefault();
          e.stopPropagation();
          next = items[items.length - 1];
          break;
        case "Enter":
        case " ":
          // Native button activation must proceed (no preventDefault) —
          // only keep the keystroke from reaching row-level handlers.
          e.stopPropagation();
          return;
        default:
          return;
      }

      next?.focus();
    },
    [],
  );

  const toggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setOpen((prev) => !prev);
  }, []);

  const handleItemPress = useCallback((item: RowActionMenuItem) => {
    if (item.disabled) return;
    setOpen(false);
    // Restore focus to the trigger BEFORE the item's handler runs — order is
    // load-bearing, not tidiness.
    //
    // `setOpen(false)` and `item.onPress()` land in ONE batched commit, and
    // `Popover` has no exit animation (it renders the anchor alone once
    // `open` is false), so the `[role="menuitem"]` the user just activated is
    // DETACHED in that same commit. Removing the focused element resets
    // `document.activeElement` to `<body>`, and any dialog the handler opens
    // then captures <body> as its "opener" — so on close, focus never comes
    // back to this `⋯` trigger and the next Tab restarts at the top of the
    // document (WCAG 2.4.3). Measured: `activeElement.tagName === "BODY"`
    // after Escape-ing a modal opened from this menu.
    //
    // Focusing first means the modal's opener capture sees the trigger, and it
    // mirrors what the Escape path above already does. Handlers that navigate
    // away are unaffected (the trigger unmounts with the route).
    buttonRef.current?.focus();
    item.onPress();
  }, []);

  /** Full ink inversion on hover/focus (v2 decisive hover); danger items
   * invert onto the danger fill instead (danger text on ink would fail AA). */
  const applyActiveStyle = useCallback(
    (el: HTMLButtonElement, isDanger: boolean) => {
      el.style.backgroundColor = isDanger
        ? "var(--danger, #B91C1C)"
        : "var(--surfaceStrong, #211C16)";
      el.style.color = "var(--onStructure, #FDFAF3)";
    },
    [],
  );

  const clearActiveStyle = useCallback(
    (el: HTMLButtonElement, isDanger: boolean) => {
      el.style.backgroundColor = "transparent";
      el.style.color = isDanger
        ? "var(--danger, #B91C1C)"
        : "var(--color, #211C16)";
    },
    [],
  );

  if (items.length === 0) return null;

  return (
    <Popover
      open={open}
      placement="bottom-end"
      matchAnchorWidth={false}
      contentProps={{ backgroundColor: "$surface", minWidth: 200, zIndex: 1200 }}
      anchor={
        // The Popover clones its anchor to attach the Floating UI reference
        // ref — the span wrapper takes it so the button keeps `buttonRef`.
        <span style={{ display: "inline-flex" }}>
          <button
            ref={buttonRef}
            type="button"
            onClick={toggle}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={ariaLabel}
            style={
              triggerVariant === "ghost" ? ghostTriggerStyle : triggerStyle
            }
            onMouseEnter={(e) => {
              const el = e.currentTarget as HTMLButtonElement;
              el.style.backgroundColor =
                "var(--surfaceOverlay, rgba(33,28,22,0.04))";
              // The overlay alone vanishes on a row already washed by the
              // table's hover, so ghost also draws its frame on hover.
              if (triggerVariant === "ghost")
                el.style.borderColor = GHOST_HOVER_BORDER_COLOR;
            }}
            onMouseLeave={(e) => {
              const el = e.currentTarget as HTMLButtonElement;
              el.style.backgroundColor = "transparent";
              if (triggerVariant === "ghost")
                el.style.borderColor = "transparent";
            }}
          >
            <MoreHorizontal size={16} strokeWidth={2} aria-hidden />
          </button>
        </span>
      }
    >
      <div
        ref={menuRef}
        role="menu"
        onKeyDown={handleMenuKeyDown}
        style={{
          display: "flex",
          flexDirection: "column",
          // Long menus scroll internally instead of overflowing the
          // viewport (Floating UI flip/shift keeps the frame on-screen).
          maxHeight: 320,
          overflowY: "auto",
        }}
      >
        {items.map((item) => {
          const isDanger = item.tone === "danger";
          return (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={item.disabled}
              className={item.className}
              {...(item.testId ? { "data-testid": item.testId } : {})}
              onClick={() => handleItemPress(item)}
              style={{
                ...itemStyle,
                color: isDanger
                  ? "var(--danger, #B91C1C)"
                  : "var(--color, #211C16)",
                opacity: item.disabled ? 0.4 : 1,
                cursor: item.disabled ? "not-allowed" : "pointer",
              }}
              onMouseEnter={(e) => {
                if (!item.disabled)
                  applyActiveStyle(e.currentTarget, isDanger);
              }}
              onMouseLeave={(e) => clearActiveStyle(e.currentTarget, isDanger)}
              // Keyboard parity: arrow-nav focus gets the same inversion as
              // hover, which doubles as the visible focus state.
              onFocus={(e) => {
                if (!item.disabled)
                  applyActiveStyle(e.currentTarget, isDanger);
              }}
              onBlur={(e) => clearActiveStyle(e.currentTarget, isDanger)}
            >
              {item.icon && (
                <span style={{ flexShrink: 0, display: "flex" }}>
                  {item.icon}
                </span>
              )}
              <span style={labelStyle}>{item.label}</span>
            </button>
          );
        })}
      </div>
    </Popover>
  );
}

RowActionMenu.displayName = "RowActionMenu";

// ── Styles ─────────────────────────────────────────────────────────────────────

const triggerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 32,
  height: 32,
  background: "transparent",
  border: "1px solid var(--borderColor, #211C16)",
  // v2 locks radius 0 (icon-only buttons are square); was a stray 4.
  borderRadius: 0,
  cursor: "pointer",
  padding: 0,
  color: "inherit",
  transition: "background-color 120ms ease-out",
};

/** Ghost hover frame: the same ink hairline the framed variant wears at rest. */
const GHOST_HOVER_BORDER_COLOR = "var(--borderColor, #211C16)";

const ghostTriggerStyle: React.CSSProperties = {
  ...triggerStyle,
  // Same 36px hit area as a `$3` Button so it sits level with its neighbours.
  width: 36,
  height: 36,
  // A transparent 1px border is reserved at rest and coloured on hover, so
  // the hover frame shifts nothing (border-box keeps the 36px outer size).
  boxSizing: "border-box",
  border: "1px solid transparent",
  transition: "background-color 120ms ease-out, border-color 120ms ease-out",
};

const itemStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  gap: 8,
  // 44px min-height meets the touch tap-target minimum (this is the primary
  // mobile action surface for the event-builder header). Padding stays at 8px
  // vertical so single-line uppercase labels remain centered inside the taller
  // box; alignItems: center handles any residual slack.
  minHeight: 44,
  padding: "8px 14px",
  border: "none",
  background: "transparent",
  borderBottom: "1px solid var(--borderColor, #211C16)",
  transition: "background-color 120ms ease-out, color 120ms ease-out",
  width: "100%",
  textAlign: "left",
};

const labelStyle: React.CSSProperties = {
  // Inherit the design-system Montserrat via the semantic body-font var
  // (matches packages/ui typography tokens). The menu portals to <body>, so an
  // explicit var is more robust than `inherit` across portal context.
  fontFamily: "var(--font-body, Montserrat, sans-serif)",
  fontSize: 12,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.8,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
