"use client";

import { ArrowLeft, Check, ChevronDown, ChevronUp, Plus } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Platform } from "react-native";
import {
  Stack,
  XStack,
  YStack,
  getVariableValue,
  styled,
  useTheme,
} from "tamagui";

import type {
  AccountContext,
  NavigationShellLayout,
} from "../../../types/navigation";
import { Avatar } from "../display/Avatar";
import { Button } from "../forms/Button";
import { Spinner } from "../feedback/Spinner";
import { Text } from "../typography/Text";
import { TextInput } from "../forms/TextInput";

const isWeb = Platform.OS === "web";

/**
 * Above this many selectable workspaces the menu grows a filter field. Small
 * accounts (the overwhelming majority) never pay for the extra chrome.
 */
const FILTER_THRESHOLD = 6;

/** ~5.5 rows. Hard cap so the popover never runs away as the account grows. */
const WORKSPACE_LIST_MAX_HEIGHT = 320;

/** Compact utility row: 40px avatar + $2 padding top/bottom. */
const ROW_MIN_HEIGHT = 56;

const ROLE_LABELS: Partial<
  Record<NonNullable<AccountContext["role"]>, string>
> = {
  OWNER: "Owner",
  ADMIN: "Group Admin",
  EDITOR: "Editor",
  VIEWER: "Viewer",
  FINANCE: "Finance",
  SCANNER: "Scanner",
};

const CONTEXT_TYPE_LABELS: Record<AccountContext["type"], string> = {
  org: "Group",
  personal: "Personal",
  consumer: "Consumer",
};

export const getContextRoleLabel = ({
  roleLabel,
  role,
  type,
}: Pick<AccountContext, "roleLabel" | "role" | "type">) => {
  // An explicit label wins: `ROLE_LABELS` is an ORG vocabulary, so a console
  // whose actor is platform staff (which still has to declare `type: "org"`)
  // would otherwise be greeted as "Group Admin". See `AccountContext.roleLabel`.
  if (roleLabel) {
    return roleLabel;
  }

  if (role && ROLE_LABELS[role]) {
    return ROLE_LABELS[role];
  }

  return CONTEXT_TYPE_LABELS[type] ?? type;
};

export const createInitials = (label: string) =>
  label
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

// ── Chrome frame ────────────────────────────────────────────────────────────
// The switcher is navbar CHROME, so soft-chrome transitions apply — but it
// sits inside a strict-Swiss admin, so the frame keeps radius 0 and a 2px ink
// edge rather than a pill/hairline.

/**
 * Positioning context for the popover — and the switcher's horizontal bound.
 *
 * `flexShrink: 1` (not `0`) is load-bearing on DESKTOP/COMPACT, which is the
 * branch that is easy to get wrong. There the anchor is `width: auto`, so its
 * flex base size is its max-content — the whole trigger. Unshrinkable, it held
 * that width however tight the row got: measured in Chrome at `flexShrink: 0`,
 * 238px while its parent shrank to 124px at a 960 viewport, a 114px spill that
 * put the document's scrollWidth at 1058. The MOBILE branch below is not the
 * one at risk: `width: 100%` is a percentage against the parent's used width,
 * so the anchor tracks its parent there whatever its flex-shrink says
 * (measured: 0px spill at 320/390/414 either way).
 *
 * Shrinking is also what let the admin topbar stop CLIPPING this subtree —
 * that clip cropped the popover to the height of the top bar. The trigger's
 * labels carry `truncate` and a stretched column so the shrink reaches the
 * text; the absolutely-positioned menu is then free to paint outside the bar.
 */
const SwitcherAnchor = styled(Stack, {
  name: "WorkspaceSwitcherAnchor",
  position: "relative",
  flexShrink: 1,
  // Tamagui's `stackDefaultStyles` already sets this; kept explicit because it
  // is half of the shrink pair and must survive an upgrade that drops it.
  minWidth: 0,
});

const FloatingMenu = styled(YStack, {
  name: "WorkspaceSwitcherMenu",
  position: "absolute",
  top: "100%",
  right: 0,
  zIndex: 200,
  gap: 0,
  width: 312,
  maxWidth: 340,
  marginTop: "$2",
  padding: 0,
  borderWidth: 2,
  borderColor: "$borderColor",
  borderRadius: 0,
  backgroundColor: "$surface",
  overflow: "hidden",
});

/** Uppercase tracked 10px section label on the muted band. */
const MenuSectionHeader = styled(XStack, {
  name: "WorkspaceSwitcherSectionHeader",
  paddingHorizontal: "$3",
  paddingVertical: "$2",
  backgroundColor: "$surfaceMuted",
  borderBottomWidth: 2,
  borderBottomColor: "$borderColor",
});

/** Structural divider between menu regions (2px, full-width). */
const MenuDivider = styled(Stack, {
  name: "WorkspaceSwitcherDivider",
  height: 2,
  backgroundColor: "$borderColor",
  width: "100%",
  flexShrink: 0,
});

const focusRing = {
  outlineWidth: 2,
  outlineStyle: "solid" as const,
  outlineColor: "$accentText",
  // Inset — the menu frame clips overflow, so an outward ring would be cut.
  outlineOffset: -2,
} as const;

const MenuRow = styled(XStack, {
  name: "WorkspaceSwitcherRow",
  alignItems: "center",
  gap: "$3",
  paddingHorizontal: "$3",
  paddingVertical: "$2",
  minHeight: ROW_MIN_HEIGHT,
  borderRadius: 0,
  borderLeftWidth: 3,
  borderLeftColor: "transparent",
  backgroundColor: "transparent",
  cursor: "pointer",
  transition: "background-color 150ms ease-out, border-color 150ms ease-out",
  hoverStyle: {
    backgroundColor: "$surfaceMuted",
    borderLeftColor: "$accent",
  },
  pressStyle: {
    backgroundColor: "$surfaceOverlay",
  },
  variants: {
    active: {
      true: {
        backgroundColor: "$accentSoft",
        borderLeftColor: "$accent",
        // Hover is a no-op on the current workspace: swapping the accent tint
        // for $surfaceMuted made the selected row read as LESS selected than
        // its neighbours.
        hoverStyle: {
          backgroundColor: "$accentSoft",
          borderLeftColor: "$accent",
        },
      },
    },
    focused: {
      true: focusRing,
    },
  } as const,
});

const ActionRow = styled(MenuRow, {
  name: "WorkspaceSwitcherActionRow",
  minHeight: 44,
  alignItems: "center",
  gap: "$2",
});

/**
 * Fixed-width trailing slot. Reserved on EVERY row so the check/spinner
 * appearing never reflows the label column.
 */
const TrailingSlot = styled(Stack, {
  name: "WorkspaceSwitcherTrailingSlot",
  width: 20,
  height: 20,
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
});

/**
 * The trigger's and the rows' identity avatar.
 *
 * Sizing now comes from the `Avatar` primitive's `frameSize="sm"` variant —
 * the local box-pinning workaround that used to live here is gone, fixed at the
 * source (see the comment on `frameSize` in `display/Avatar.tsx`).
 *
 * What this wrapper still owns, and why it is not inlined: `aria-hidden` is
 * load-bearing. The monogram sits immediately beside the label, so without it
 * the trigger's accessible name reads "IF Ithas Fire Demo Org Group Admin"
 * instead of "Ithas Fire Demo Org Group Admin". Keeping the one place that
 * knows that stops the next row from silently re-introducing it.
 */
const SwitcherAvatar = ({
  context,
}: {
  context: Pick<AccountContext, "label" | "avatarUrl">;
}) => (
  <Avatar
    size="sm"
    src={context.avatarUrl}
    initials={createInitials(context.label)}
    alt={context.label}
    // Decorative: the label sits right next to it in the accessible name.
    aria-hidden
  />
);

/**
 * Lucide icons inherit `currentColor` (design-system-v2 §6) — they never carry
 * their own colour. Tamagui's `Stack` is a View and has no `color` style prop,
 * so the tint is set as a resolved CSS `color` on the wrapper instead. The
 * value comes from the live theme, never a literal.
 */
const IconTint = ({
  tint,
  children,
}: {
  tint?: string;
  children: ReactNode;
}) => (
  <Stack
    alignItems="center"
    justifyContent="center"
    flexShrink={0}
    {...(isWeb && tint ? { style: { color: tint } } : {})}
  >
    {children}
  </Stack>
);

const SECTION_ORDER = ["personal", "org", "consumer"] as const;

const SECTION_HEADINGS: Record<(typeof SECTION_ORDER)[number], string> = {
  personal: "Personal",
  org: "Groups",
  consumer: "Attendee",
};

/**
 * `menuitemradio` is the correct ARIA role for a single-select menu, but React
 * Native's `Role` union is a strict SUBSET of ARIA and omits it — and Tamagui
 * types every Stack against that union. Cast once, here, so the rest of the
 * row's props stay fully type-checked.
 */
const MENUITEMRADIO_ROLE = "menuitemradio" as unknown as NonNullable<
  ComponentProps<typeof XStack>["role"]
>;

/**
 * `title` is a genuine DOM attribute that Tamagui forwards on web (verified in
 * Chrome), but it is absent from the RN-derived prop union Tamagui types Stacks
 * against. Cast once here.
 */
const hoverTitle = (value: string) =>
  ({ title: value }) as unknown as Partial<ComponentProps<typeof XStack>>;

/** Satisfied by BOTH React's synthetic keyboard event and the DOM's native one. */
interface NavKeyEvent {
  key: string;
  preventDefault: () => void;
}

/** Keys the filter field hands over to menu navigation. */
const NAV_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "Home",
  "End",
  "Escape",
  "Tab",
]);

const CTX_PREFIX = "ctx:";
const ACTION_CREATE_ORG = "action:create-organization";
const ACTION_RETURN_CONSUMER = "action:return-to-consumer";

interface WorkspaceSection {
  key: (typeof SECTION_ORDER)[number];
  /** Visible header, may carry a "· N" count. */
  label: string;
  /** Count-free name for `aria-label` ("Groups · 5" reads as "middle-dot"). */
  heading: string;
  items: AccountContext[];
}

export interface WorkspaceSwitcherProps {
  layout: NavigationShellLayout;
  accountContext: AccountContext;
  availableContexts?: AccountContext[];
  onContextSelect?: (contextId: string) => Promise<void> | void;
  onCreateOrganization?: () => void;
  contextSwitchingId?: string | null;
  onReturnToConsumer?: () => void;
  returnToConsumerLabel?: string;
  returnToConsumerDescription?: string;
  /**
   * Build an href for a workspace context switch. When provided, each
   * workspace row renders as a real `<a>` so modifier-click still opens a
   * new tab.
   */
  contextHrefBuilder?: (contextId: string) => string;
  testIdBase?: string;
}

export const WorkspaceSwitcher = ({
  layout,
  accountContext,
  availableContexts,
  onContextSelect,
  onCreateOrganization,
  contextSwitchingId,
  onReturnToConsumer,
  returnToConsumerLabel = "Switch to attendee view",
  returnToConsumerDescription,
  contextHrefBuilder,
  testIdBase = "navigation-top-bar",
}: WorkspaceSwitcherProps) => {
  // An empty array is NOT nullish — `?? [accountContext]` let `[]` through and
  // produced a menu with no focusable item, no reachable Escape, and a
  // "No workspaces match" body for an unfiltered list.
  const selectableContexts = useMemo(
    () =>
      availableContexts && availableContexts.length > 0
        ? availableContexts
        : [accountContext],
    [availableContexts, accountContext],
  );
  const hasMultipleContexts = selectableContexts.length > 1;
  const menuLabel = hasMultipleContexts ? "Switch workspace" : "Workspace";
  const menuId = `${testIdBase}-workspace-menu`;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const theme = useTheme();
  const mutedTint = getVariableValue(theme.colorMuted ?? "$colorMuted");
  const inkTint = getVariableValue(theme.color ?? "$color");
  // `accent` is a graphic value, not a text colour — the check glyph is a
  // 16px stroke, so it rides `accentText` to stay legible on `accentSoft`.
  const activeTint = getVariableValue(theme.accentText ?? "$accentText");

  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  // `TextInput` forwards the RAW node it was handed, which may be a wrapper
  // rather than the <input> (that is exactly why TextInput keeps its own
  // `resolveInputElement`). Resolve it here, and hold it in STATE rather than a
  // ref so the native-listener effect below re-runs when the node identity
  // changes — a remount that left `open`/`showFilter` untouched would otherwise
  // leave the listener bound to a detached node and silently kill arrow-key
  // navigation.
  const [filterInput, setFilterInput] = useState<HTMLElement | null>(null);
  const filterRef = useCallback((node: unknown) => {
    if (!node) {
      setFilterInput(null);
      return;
    }
    const el = node as HTMLElement;
    const resolved =
      el instanceof HTMLInputElement
        ? el
        : ((el.querySelector?.("input") as HTMLElement | null) ?? el);
    setFilterInput(resolved);
  }, []);
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const openedRef = useRef(false);

  const showFilter = selectableContexts.length > FILTER_THRESHOLD;

  const filteredContexts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return selectableContexts;
    }
    return selectableContexts.filter((context) =>
      context.label.toLowerCase().includes(needle),
    );
  }, [query, selectableContexts]);

  const sections = useMemo<WorkspaceSection[]>(() => {
    return SECTION_ORDER.map((key) => {
      const items = filteredContexts.filter((context) => context.type === key);
      const count = items.length;
      const base = SECTION_HEADINGS[key];
      return {
        key,
        label: count > 1 ? `${base} · ${count}` : base,
        heading: base,
        items,
      };
    }).filter((section) => section.items.length > 0);
  }, [filteredContexts]);

  // A single workspace needs no scaffolding — headers would be noise.
  const showSectionHeaders = sections.length > 1 || filteredContexts.length > 1;

  const menuItemIds = useMemo(() => {
    const ids = sections.flatMap((section) =>
      section.items.map((context) => `${CTX_PREFIX}${context.id}`),
    );
    if (onCreateOrganization) {
      ids.push(ACTION_CREATE_ORG);
    }
    if (onReturnToConsumer) {
      ids.push(ACTION_RETURN_CONSUMER);
    }
    return ids;
  }, [sections, onCreateOrganization, onReturnToConsumer]);

  const registerItem = useCallback(
    (id: string) => (node: HTMLElement | null) => {
      if (node) {
        itemRefs.current.set(id, node);
      } else {
        itemRefs.current.delete(id);
      }
    },
    [],
  );

  const focusItem = useCallback((id: string | undefined) => {
    if (!id) {
      return;
    }
    const node = itemRefs.current.get(id);
    if (!node) {
      // Never leave the roving tabIndex=0 pointing at nothing.
      return;
    }
    setFocusedId(id);
    node.focus();
    // Keep the section header above the focused row on screen — Home used to
    // move focus without scrolling the list back to the top.
    node.scrollIntoView?.({ block: "nearest" });
  }, []);

  const closeMenu = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) {
      triggerRef.current?.focus?.();
    }
  }, []);

  // ── Open/close lifecycle ─────────────────────────────────────────────────
  useEffect(() => {
    if (!open) {
      openedRef.current = false;
      setFocusedId(null);
      setQuery("");
      return;
    }
    if (openedRef.current) {
      return;
    }

    if (showFilter) {
      // The callback ref resolves the <input> into state, which lands one
      // render AFTER this effect first runs — so wait for it rather than
      // burning the one-shot latch on a null node (that silently dropped the
      // open-focus entirely).
      if (!filterInput) {
        return;
      }
      openedRef.current = true;
      filterInput.focus?.();
      return;
    }

    openedRef.current = true;
    const activeId = `${CTX_PREFIX}${accountContext.id}`;
    focusItem(menuItemIds.includes(activeId) ? activeId : menuItemIds[0]);
  }, [
    open,
    showFilter,
    menuItemIds,
    accountContext.id,
    focusItem,
    filterInput,
  ]);

  // ── Focus reconciliation ────────────────────────────────────────────────
  // The focused row can disappear underneath us: filtering narrows the list,
  // and AdminShell's `useEventOwnerEntities` refetches in the background and
  // can drop a workspace while the menu is open. When that happens the browser
  // drops focus to <body>, `handleMenuKeyDown` (bound to the popover) stops
  // firing, and the menu is left open and keyboard-dead.
  useEffect(() => {
    if (!open || !focusedId) {
      return;
    }
    if (menuItemIds.includes(focusedId)) {
      return;
    }
    const fallback = menuItemIds[0];
    if (fallback) {
      focusItem(fallback);
      return;
    }
    // Nothing left to focus (filter matched nothing) — park focus on the
    // popover itself so Escape/Tab still reach the handler.
    setFocusedId(null);
    menuRef.current?.focus?.();
  }, [open, focusedId, menuItemIds, focusItem]);

  // `showFilter` tracks the LIVE context count, so a background refetch that
  // drops it below the threshold can unmount the field while a non-matching
  // needle is still set — leaving "No workspaces match" with no way to clear
  // it. Drop the query with the field.
  useEffect(() => {
    if (!showFilter) {
      setQuery("");
    }
  }, [showFilter]);

  // Outside pointer-down closes. The trigger is treated as "inside" so its own
  // click toggles rather than close-then-reopen.
  useEffect(() => {
    if (!isWeb || !open) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      if (menuRef.current?.contains(target)) {
        return;
      }
      if (triggerRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const handleSelect = useCallback(
    async (contextId: string) => {
      if (contextId === accountContext.id) {
        closeMenu(true);
        return;
      }
      try {
        if (!onContextSelect) {
          return;
        }
        await onContextSelect(contextId);
      } finally {
        // design-system-v2 §9: manage focus on popover close. Every close path
        // hands focus back to the trigger rather than dropping it on <body>.
        closeMenu(true);
      }
    },
    [accountContext.id, closeMenu, onContextSelect],
  );

  const runAction = useCallback(
    (action?: () => void) => {
      closeMenu(true);
      action?.();
    },
    [closeMenu],
  );

  // ── Keyboard: roving focus across rows + footer actions ──────────────────
  const moveFocus = useCallback(
    (delta: 1 | -1) => {
      if (menuItemIds.length === 0) {
        return;
      }
      const current = focusedId ? menuItemIds.indexOf(focusedId) : -1;
      if (current === -1) {
        focusItem(delta === 1 ? menuItemIds[0] : menuItemIds.at(-1));
        return;
      }
      const next = (current + delta + menuItemIds.length) % menuItemIds.length;
      focusItem(menuItemIds[next]);
    },
    [focusItem, focusedId, menuItemIds],
  );

  const handleNavKey = useCallback(
    (event: NavKeyEvent, fromFilter: boolean) => {
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          moveFocus(1);
          break;
        case "ArrowUp":
          event.preventDefault();
          moveFocus(-1);
          break;
        // Home/End belong to the caret while the filter field has focus.
        case "Home":
          if (fromFilter) break;
          event.preventDefault();
          focusItem(menuItemIds[0]);
          break;
        case "End":
          if (fromFilter) break;
          event.preventDefault();
          focusItem(menuItemIds.at(-1));
          break;
        case "Escape":
          event.preventDefault();
          closeMenu(true);
          break;
        case "Tab":
          // Standard menu behaviour: leaving the menu dismisses it — but the
          // browser's own Tab advance is not usable here. Letting it run
          // computed "next tabbable" against a tree React was about to unmount
          // and landed focus on the nav rail's first heading (the rail follows
          // the navbar in DOM order, so it reads as a jump BACKWARDS on
          // screen). Measured live three times. So: swallow the default and
          // park focus on the trigger. One more Tab continues from a
          // predictable place, and focus never travels backwards.
          event.preventDefault();
          closeMenu(true);
          break;
        default:
          break;
      }
    },
    [closeMenu, focusItem, menuItemIds, moveFocus],
  );

  const handleMenuKeyDown = useCallback(
    (event: ReactKeyboardEvent) => handleNavKey(event, false),
    [handleNavKey],
  );

  /**
   * The filter field needs a NATIVE keydown listener.
   *
   * React Native Web's `TextInput` has a prop allow-list that DROPS `onKeyDown`
   * (the same allow-list `TextInput.tsx`'s `patchInputDOM` exists to work
   * around), and a keydown originating inside it never reached the popover
   * frame's React `onKeyDown` either. Measured in Chrome: ArrowDown from the
   * filter moved focus nowhere at all. Binding to the resolved DOM node is the
   * only path that behaves the same in jsdom and in the browser.
   *
   * LOAD-BEARING: this cannot double-fire with the frame's React handler
   * because RNW's TextInput calls `e.stopPropagation()` in its own
   * `handleKeyDown` (react-native-web/dist/exports/TextInput/index.js), which
   * kills React's simulated propagation before the frame sees the event. An
   * RNW upgrade that drops that call would make ArrowDown move TWO rows.
   */
  useEffect(() => {
    if (!isWeb || !open || !showFilter || !filterInput) {
      return;
    }
    const node = filterInput;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        const first = menuItemIds[0];
        if (first?.startsWith(CTX_PREFIX)) {
          void handleSelect(first.slice(CTX_PREFIX.length));
        }
        return;
      }
      if (!NAV_KEYS.has(event.key)) {
        return;
      }
      handleNavKey(event, true);
    };
    node.addEventListener("keydown", onKeyDown);
    return () => node.removeEventListener("keydown", onKeyDown);
  }, [open, showFilter, filterInput, menuItemIds, handleSelect, handleNavKey]);

  // Focus leaving the whole switcher dismisses it. `relatedTarget === null`
  // (focus dropped to the document) is ignored — the pointer-down handler
  // already covers plain clicks and this keeps programmatic blurs benign.
  const handleFocusOut = useCallback((event: ReactFocusEvent) => {
    const next = event.relatedTarget as Node | null;
    if (!next) {
      return;
    }
    if (menuRef.current?.contains(next) || triggerRef.current?.contains(next)) {
      return;
    }
    setOpen(false);
  }, []);

  const activateOnKey = useCallback(
    (event: ReactKeyboardEvent, activate: () => void) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      // preventDefault stops an <a>'s native Enter-click from double-firing.
      event.preventDefault();
      event.stopPropagation();
      activate();
    },
    [],
  );

  // ── Trigger ──────────────────────────────────────────────────────────────
  const triggerRoleLabel = getContextRoleLabel(accountContext);
  const isMobile = layout === "mobile";
  const ChevronIcon = open ? ChevronUp : ChevronDown;
  // Mobile keeps an explicit label carrying the menu semantics ("Switch
  // workspace: …") on top of the visible name — it is the top bar's identity
  // anchor there. Native always needs an explicit label.
  const triggerA11yLabel = `${menuLabel}: ${accountContext.label}, ${triggerRoleLabel}`;
  // NOTE: never pass `accessibilityLabel`/`accessibilityRole` as `undefined`
  // next to their aria-* twins — RNW maps them onto the same DOM attribute
  // and the explicit `undefined` WIPES the aria value.
  const triggerLabelProps = isWeb
    ? isMobile
      ? { "aria-label": triggerA11yLabel }
      : {}
    : { accessibilityLabel: triggerA11yLabel };

  const trigger = (
    <Button
      // Tamagui forwards the host node; on web that is the <button> element.
      ref={triggerRef as never}
      variant="ghost"
      size="$3"
      onPress={() => setOpen((value) => !value)}
      aria-expanded={open}
      {...(isWeb ? { "aria-haspopup": "menu" as const } : {})}
      {...(isWeb && open ? { "aria-controls": menuId } : {})}
      {...triggerLabelProps}
      borderWidth={2}
      borderColor={open ? "$borderColor" : "transparent"}
      paddingHorizontal="$2"
      paddingVertical="$1"
      height={48}
      // Mobile: the trigger is the top bar's LEADING identity anchor — it
      // fills the fluid slot and left-aligns, showing the full workspace name
      // (the same treatment compact/desktop always had) instead of collapsing
      // to a bare avatar chip.
      width={isMobile ? "100%" : undefined}
      justifyContent={isMobile ? "flex-start" : undefined}
      maxWidth={isMobile ? undefined : 260}
      borderRadius={0}
      // The last-resort clip, and the ONLY box in this subtree allowed to
      // carry one. The avatar and the chevron are `flexShrink: 0`, so the
      // trigger has a hard content floor (~86px); squeezed below it, a
      // `justifyContent: center` button spills its content SYMMETRICALLY and
      // paints over — and hit-blocks — whatever sits to its left in the
      // topbar (theme toggle, language, alerts). Not reachable at today's
      // widths, but it is one fat `navbarTrailingSlot` away.
      //
      // Safe here, and nowhere above here: the popover is this Button's
      // SIBLING inside `SwitcherAnchor`, not its descendant, so this clips
      // only trigger content. An element's own focus outline is not clipped
      // by its own overflow either. Putting the same rule on any ANCESTOR is
      // what cropped the dropdown to a sliver in production.
      overflow="hidden"
      data-testid={`${testIdBase}-context-trigger`}
      hoverStyle={{
        borderColor: "$borderColor",
        backgroundColor: "$surfaceMuted",
      }}
    >
      <XStack
        gap="$2"
        alignItems="center"
        flexShrink={1}
        minWidth={0}
        {...(isMobile ? { width: "100%", justifyContent: "flex-start" } : {})}
      >
        <SwitcherAvatar context={accountContext} />
        {/* `alignItems: stretch` (the default), NOT `flex-start`. The labels
            below are `truncate`, which is PAINT-ONLY — nowrap + ellipsis give
            a box no ability to shrink. Under `flex-start` each label sat at
            its own max-content width (measured: 148px, its `maxWidth` cap) and
            spilled straight out of a squeezed trigger, taking the document's
            scrollWidth with it: 1053 at a 1024 viewport, 1026 at 960. Stretch
            makes the label's used width the column's, so the shrink that
            starts at the anchor reaches the text and the ellipsis finally has
            a box to truncate against.

            Stretch is why the labels below MUST declare `textAlign="left"`:
            the <button> host centers its text, which a hugging box hid.
            Measured the moment the boxes stretched — "Group Admin" sat 33px
            in from the name above it. Same trap, same fix as
            NavigationRail's section headings. */}
        <YStack alignItems="stretch" flexShrink={1} minWidth={0}>
          {/* textTransform="none" is load-bearing: the Button atom sets
              `text-transform: uppercase` on its frame, which would otherwise
              shout a proper-noun workspace name. On mobile the name has the
              whole fluid slot, so it only truncates when genuinely too long. */}
          <Text
            variant="bodySmall"
            weight="bold"
            truncate
            textTransform="none"
            textAlign="left"
            maxWidth={isMobile ? undefined : 150}
            lineHeight={16}
          >
            {accountContext.label}
          </Text>
          <Text
            variant="caption"
            tone="muted"
            truncate
            textTransform="none"
            textAlign="left"
            maxWidth={isMobile ? undefined : 150}
            lineHeight={14}
          >
            {triggerRoleLabel}
          </Text>
        </YStack>
        <IconTint tint={mutedTint}>
          <ChevronIcon
            size={14}
            color="currentColor"
            aria-hidden="true"
            data-testid={`${testIdBase}-context-chevron-${open ? "up" : "down"}`}
          />
        </IconTint>
      </XStack>
    </Button>
  );

  // ── Rows ─────────────────────────────────────────────────────────────────
  const renderWorkspaceRow = (context: AccountContext) => {
    const itemId = `${CTX_PREFIX}${context.id}`;
    const isActive = context.id === accountContext.id;
    const isSwitching = contextSwitchingId === context.id;
    const isFocused = focusedId === itemId;
    // Web-only: the anchor branch below is gated on `isWeb`, so an unguarded
    // href would send native rows down the "anchor owns the handlers" path
    // with no anchor to own them — an inert, unlabelled row.
    const href = isWeb ? contextHrefBuilder?.(context.id) : undefined;
    const roleLabel = getContextRoleLabel(context);
    const activate = () => {
      void handleSelect(context.id);
    };

    const interactiveProps = isWeb
      ? ({
          role: MENUITEMRADIO_ROLE,
          "aria-checked": isActive,
          tabIndex: isFocused ? 0 : -1,
          onKeyDown: (event: ReactKeyboardEvent) =>
            activateOnKey(event, activate),
          onFocus: () => setFocusedId(itemId),
        } as const)
      : ({
          accessibilityRole: "menuitem" as const,
          accessibilityState: { selected: isActive },
          accessibilityLabel: `${context.label}, ${roleLabel}`,
        } as const);

    const row = (
      <MenuRow
        active={isActive}
        focused={isFocused}
        minWidth={0}
        // The truncated name must stay reachable on hover on BOTH paths: this
        // covers the plain row (which is the menuitemradio when there is no
        // href); the anchor below carries its own `title` for the link path.
        {...(isWeb ? hoverTitle(context.label) : {})}
        data-testid={`${testIdBase}-workspace-item`}
        data-workspace-id={context.id}
        data-active={isActive ? "true" : "false"}
        // Anchor path carries ONLY the anchor's onClick — wiring onPress here
        // too would double-fire (XStack attaches both handlers), which meant a
        // plain click ran handleSelect twice and a modifier-click navigated the
        // CURRENT tab before the anchor's guard could bail. Mirrors
        // NavigationRail's BackRow.
        {...(href
          ? {}
          : {
              onPress: activate,
              ...interactiveProps,
              ref: registerItem(itemId) as never,
            })}
      >
        <SwitcherAvatar context={context} />
        <YStack flex={1} minWidth={0} gap="$0">
          <Text variant="bodySmall" weight="bold" truncate lineHeight={18}>
            {context.label}
          </Text>
          <Text variant="caption" tone="muted" truncate lineHeight={14}>
            {roleLabel}
          </Text>
        </YStack>
        <TrailingSlot
          {...(isWeb ? { style: { color: activeTint } } : {})}
          data-testid={`${testIdBase}-workspace-item-trailing`}
        >
          {isSwitching ? (
            <Spinner
              size="sm"
              screenReaderLabel={`Switching to ${context.label}`}
            />
          ) : isActive ? (
            <Check
              size={16}
              strokeWidth={2.5}
              color="currentColor"
              aria-hidden="true"
              data-testid={`${testIdBase}-workspace-item-check`}
            />
          ) : null}
        </TrailingSlot>
      </MenuRow>
    );

    if (isWeb && href) {
      return (
        <a
          key={context.id}
          ref={registerItem(itemId) as never}
          href={href}
          title={context.label}
          onClick={(event) => {
            // Modifier-clicks keep the native "open in new tab" behaviour.
            if (
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            ) {
              return;
            }
            event.preventDefault();
            activate();
          }}
          style={{
            textDecoration: "none",
            color: "inherit",
            display: "block",
          }}
          {...interactiveProps}
        >
          {row}
        </a>
      );
    }

    return <Stack key={context.id}>{row}</Stack>;
  };

  const renderActionRow = ({
    id,
    icon,
    label,
    description,
    onActivate,
    testId,
  }: {
    id: string;
    icon: ReactNode;
    label: string;
    description?: string;
    onActivate: () => void;
    testId: string;
  }) => {
    const isFocused = focusedId === id;
    return (
      <YStack key={id}>
        <ActionRow
          focused={isFocused}
          onPress={onActivate}
          ref={registerItem(id) as never}
          data-testid={testId}
          {...(isWeb
            ? ({
                role: "menuitem" as const,
                tabIndex: isFocused ? 0 : -1,
                onKeyDown: (event: ReactKeyboardEvent) =>
                  activateOnKey(event, onActivate),
                onFocus: () => setFocusedId(id),
              } as const)
            : ({
                accessibilityRole: "menuitem" as const,
                accessibilityLabel: label,
              } as const))}
        >
          <IconTint tint={inkTint}>{icon}</IconTint>
          <Text
            variant="bodySmall"
            weight="bold"
            truncate
            flex={1}
            minWidth={0}
            style={{
              textTransform: "uppercase",
              letterSpacing: 1,
              fontSize: 12,
            }}
          >
            {label}
          </Text>
        </ActionRow>
        {description ? (
          <Text
            variant="caption"
            tone="muted"
            paddingLeft="$6"
            paddingRight="$3"
            paddingBottom="$2"
          >
            {description}
          </Text>
        ) : null}
      </YStack>
    );
  };

  return (
    <SwitcherAnchor
      {...(isWeb ? { onBlur: handleFocusOut } : {})}
      {...(isMobile ? { width: "100%" } : {})}
      data-testid={`${testIdBase}-workspace-switcher`}
    >
      {trigger}
      {open ? (
        // The popover FRAME is not the menu: a `textbox` is not a valid owned
        // element of `role="menu"` (and NVDA/JAWS swallow keystrokes in one
        // while in menu-browse mode), so the filter sits OUTSIDE `role="menu"`
        // but inside the frame. The keydown handler stays on the frame so
        // filter keystrokes still drive menu navigation.
        <FloatingMenu
          ref={menuRef}
          tabIndex={isWeb ? -1 : undefined}
          // Mobile: the anchor spans the fluid leading slot, so the menu
          // pins to BOTH anchor edges (left: 0 + right: 0, width auto) instead
          // of keeping the fixed 312px. Right-anchoring a 312px menu to a
          // ~250px-wide anchor at 320px viewports pushed it off-screen left —
          // and a fixed-width left-anchored menu clips on the RIGHT whenever
          // the anchor is offset (guard-case hamburger puts the trigger at
          // x≈60, so 60 + 312 overflows 320–360px viewports). Spanning the
          // anchor keeps the menu inside the row bounds at every width; the
          // viewport-relative maxWidth is a web-only backstop (calc() never
          // reaches native).
          {...(isMobile
            ? {
                left: 0,
                right: 0,
                width: "auto",
                ...(isWeb ? { maxWidth: "calc(100vw - 16px)" } : {}),
              }
            : {})}
          {...(isWeb ? { onKeyDown: handleMenuKeyDown } : {})}
        >
          {showFilter ? (
            <Stack
              padding="$2"
              borderBottomWidth={2}
              borderBottomColor="$borderColor"
              backgroundColor="$surfaceMuted"
              flexShrink={0}
            >
              <TextInput
                ref={filterRef as never}
                fullWidth
                value={query}
                onChangeText={setQuery}
                placeholder="Filter workspaces"
                aria-label="Filter workspaces"
                testId={`${testIdBase}-workspace-filter`}
                // Key handling is bound natively in the effect above — RNW
                // drops `onKeyDown` on TextInput.
                {...(isWeb ? { onFocus: () => setFocusedId(null) } : {})}
              />
            </Stack>
          ) : null}

          <YStack
            id={menuId}
            flexShrink={1}
            minHeight={0}
            {...(isWeb
              ? { role: "menu" as const, "aria-label": menuLabel }
              : {
                  accessibilityRole: "menu" as const,
                  accessibilityLabel: menuLabel,
                })}
          >
            {/* Scroll region — the filter above and the actions below stay
                outside it so they are always reachable.
                NOTE: `overflowY` is web-only; on native this clips at
                maxHeight with no way to scroll. The switcher is a web surface
                today (this popover has never shipped on native). */}
            <Stack
              {...(isWeb
                ? {
                    role: "none" as const,
                    style: { overflowY: "auto", overflowX: "hidden" },
                  }
                : {})}
              maxHeight={WORKSPACE_LIST_MAX_HEIGHT}
              flexShrink={1}
              minHeight={0}
              data-testid={`${testIdBase}-workspace-list`}
            >
              {sections.length === 0 ? (
                <Stack
                  // `menu` only owns menuitem*/group/separator — keep the
                  // empty state out of the a11y tree's ownership chain.
                  {...(isWeb ? { role: "none" as const } : {})}
                  paddingHorizontal="$3"
                  paddingVertical="$4"
                >
                  <Text
                    variant="bodySmall"
                    tone="muted"
                    data-testid={`${testIdBase}-workspace-empty`}
                  >
                    {query.trim()
                      ? "No workspaces match"
                      : "No workspaces available"}
                  </Text>
                </Stack>
              ) : (
                sections.map((section) => (
                  <Stack
                    key={section.key}
                    {...(isWeb
                      ? {
                          role: "group" as const,
                          // The visible header carries the "· 5" count; the
                          // accessible name must not, or it is announced as
                          // "Groups middle-dot 5".
                          "aria-label": section.heading,
                        }
                      : {})}
                  >
                    {showSectionHeaders ? (
                      <MenuSectionHeader>
                        <Text
                          variant="caption"
                          weight="bold"
                          tone="muted"
                          style={{
                            textTransform: "uppercase",
                            letterSpacing: 2,
                            fontSize: 10,
                          }}
                        >
                          {section.label}
                        </Text>
                      </MenuSectionHeader>
                    ) : null}
                    {section.items.map((context) =>
                      renderWorkspaceRow(context),
                    )}
                  </Stack>
                ))
              )}
            </Stack>

            {onCreateOrganization || onReturnToConsumer ? (
              <Stack
                {...(isWeb ? { role: "none" as const } : {})}
                flexShrink={0}
              >
                <MenuDivider
                  {...(isWeb
                    ? { role: "none" as const, "aria-hidden": true }
                    : {})}
                />
                <Stack
                  {...(isWeb
                    ? {
                        role: "group" as const,
                        "aria-label": "Workspace actions",
                      }
                    : {})}
                  paddingVertical="$1"
                >
                  {onCreateOrganization
                    ? renderActionRow({
                        id: ACTION_CREATE_ORG,
                        icon: <Plus size={16} color="currentColor" />,
                        label: "Create group",
                        onActivate: () => runAction(onCreateOrganization),
                        testId: `${testIdBase}-create-organization`,
                      })
                    : null}
                  {onReturnToConsumer
                    ? renderActionRow({
                        id: ACTION_RETURN_CONSUMER,
                        icon: <ArrowLeft size={16} color="currentColor" />,
                        label: returnToConsumerLabel,
                        description: returnToConsumerDescription,
                        onActivate: () => runAction(onReturnToConsumer),
                        testId: `${testIdBase}-return-to-consumer`,
                      })
                    : null}
                </Stack>
              </Stack>
            ) : null}
          </YStack>
        </FloatingMenu>
      ) : null}
    </SwitcherAnchor>
  );
};

WorkspaceSwitcher.displayName = "WorkspaceSwitcher";
