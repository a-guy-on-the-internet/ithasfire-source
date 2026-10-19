"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ArrowLeft, ChevronDown } from "lucide-react";
import { Platform } from "react-native";
import {
  ScrollView,
  XStack,
  YStack,
  styled,
  type TamaguiElement,
} from "tamagui";

import { Badge } from "../../tamagui/components/feedback/Badge";
import { Reveal } from "../../tamagui/components/effects/Reveal";
import { Button } from "../../tamagui/components/forms/Button";
import { Text } from "../../tamagui/components/typography/Text";
import { Tooltip } from "../../tamagui/components/feedback/Tooltip";

import type {
  NavigationItem,
  NavigationRailBack,
  NavigationSection,
  NavigationShellLayout,
  NavigationConfigControl,
  RouteMeta,
} from "../NavigationShell.types";
import { isRouteActive } from "../utils/route-active";

export type { NavigationRailBack };

const isWeb = Platform.OS === "web";

// Active-route matching lives in `../utils/route-active` so the rail and the
// mobile NavigationBottomBar share one definition of "current".

const RailFrame = styled(YStack, {
  name: "NavigationRailFrame",
  backgroundColor: "$surfaceRaised",
  // No horizontal frame padding: rows own their inset so hover fills and the
  // 3px active spine run edge-to-edge (print-style, per design-system v2).
  paddingHorizontal: 0,
  paddingTop: 14,
  paddingBottom: 10,
  gap: "$4",
  flexShrink: 0,
  borderRadius: 0,
  marginTop: "$3",
  variants: {
    showDivider: {
      true: {
        borderRightWidth: 0,
      },
      false: {
        borderRightWidth: 0,
      },
    },
  },
  defaultVariants: {
    showDivider: true,
  },
});

const RailCollapsedFrame = styled(RailFrame, {
  name: "NavigationRailCollapsedFrame",
  width: 72,
});

const SectionHeading = styled(XStack, {
  name: "NavigationRailSectionHeading",
  alignItems: "center",
  gap: "$2",
  paddingHorizontal: "$4",
  paddingVertical: "$1",
});

/**
 * Interactive variant of `SectionHeading`: a real <button> on web so section
 * groups can be toggled with the keyboard (Enter/Space via native semantics).
 * Visually it stays the same micro-label row — tracked-uppercase `SectionLabel`
 * plus a small chevron.
 */
const SectionHeadingButton = styled(XStack, {
  name: "NavigationRailSectionHeadingButton",
  tag: "button",
  alignItems: "center",
  gap: "$2",
  paddingHorizontal: "$4",
  paddingTop: 8,
  paddingBottom: 6,
  width: "100%",
  backgroundColor: "transparent",
  borderWidth: 0,
  borderRadius: 0,
  cursor: "pointer",
  hoverStyle: {
    backgroundColor: "$surfaceMuted",
  },
  focusStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$accent",
    outlineOffset: 2,
  },
});

const SectionLabel = styled(Text, {
  name: "NavigationRailSectionLabel",
  variant: "bodySmall",
  // `$accentText` is the accent hue at small-text legibility — a 10px
  // micro-label on the raised surface needs the AA rung, not raw
  // `$brandSecondary`. The mono label idiom at the `xs` rung (10px / 2.5px /
  // 600) now carries the technical feel that bold-and-tracked Montserrat was
  // standing in for while Plex was retired.
  fontFamily: "$mono",
  fontWeight: "600",
  color: "$accentText",
  textTransform: "uppercase",
  letterSpacing: 2.5,
  fontSize: 10,
  // The interactive heading renders as a native <button>, whose UA default
  // centers content — the micro-label must stay left-aligned.
  textAlign: "left",
});

const SectionGroup = styled(YStack, {
  name: "NavigationRailSectionGroup",
  gap: "$1",
  variants: {
    collapsed: {
      true: {
        gap: "$2",
      },
    },
    // Hairline group boundary: every group but the first in the 72px icon
    // rail, and any wide-rail section flagged `separatorAbove` (used to set
    // off a trailing structural group like Workspace).
    withSeparator: {
      true: {
        borderTopWidth: 1,
        borderTopColor: "$borderColorSoft",
        paddingTop: "$2",
        marginTop: "$1",
      },
    },
  } as const,
  defaultVariants: {
    collapsed: false,
  },
});

const IdentityRow = styled(XStack, {
  name: "NavigationRailIdentity",
  alignItems: "center",
  gap: "$3",
  paddingHorizontal: "$4",
  paddingBottom: 14,
  borderBottomWidth: 1,
  borderBottomColor: "$borderColorSoft",
  variants: {
    collapsed: {
      true: {
        justifyContent: "center",
        paddingHorizontal: 0,
      },
    },
  } as const,
  defaultVariants: {
    collapsed: false,
  },
});

// Square initials block (strict-Swiss content, not chrome — radius 0, ink on
// paper inversion), matching the approved side-panel design.
const IdentityAvatar = styled(YStack, {
  name: "NavigationRailIdentityAvatar",
  width: 30,
  height: 30,
  flexShrink: 0,
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: "$backgroundInverted",
  borderRadius: 0,
});

/**
 * Interactive form of the identity block: the WHOLE row (avatar + name +
 * role) is one link/button to the workspace's own home — a 30px avatar alone
 * is far too small a target. Chrome affordances mirror {@link BackRow}; the
 * hairline stays on the outer `IdentityRow` so the hover fill never swallows
 * it. Only rendered when the consumer supplies `href`/`onPress`.
 */
const IdentityAction = styled(XStack, {
  name: "NavigationRailIdentityAction",
  alignItems: "center",
  gap: "$3",
  flexGrow: 1,
  flexShrink: 1,
  minWidth: 0,
  paddingHorizontal: "$4",
  paddingVertical: "$2",
  // ≥44px tap target (design-system floor) — the inert block is only 30px.
  minHeight: 44,
  cursor: "pointer",
  backgroundColor: "transparent",
  // Neutralize the UA <button>/<a> chrome this renders as on web.
  borderWidth: 0,
  borderRadius: 0,
  hoverStyle: {
    backgroundColor: "$surfaceMuted",
  },
  focusStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$accent",
    outlineOffset: 2,
  },
  variants: {
    collapsed: {
      true: {
        justifyContent: "center",
        paddingHorizontal: 0,
      },
    },
  } as const,
  defaultVariants: {
    collapsed: false,
  },
});

const IdentityInitials = styled(Text, {
  name: "NavigationRailIdentityInitials",
  fontSize: 11,
  weight: "bold",
  color: "$colorInverted",
});

const IdentityName = styled(Text, {
  name: "NavigationRailIdentityName",
  fontSize: 13,
  weight: "bold",
});

const IdentitySub = styled(Text, {
  name: "NavigationRailIdentitySub",
  fontSize: 11,
  tone: "muted",
});

const ItemsStack = styled(YStack, {
  name: "NavigationRailItems",
  // Plain number: fractional space tokens ("$0.5") are unregistered in this
  // config and silently resolve to 0 — a known repo footgun.
  gap: 2,
});

/**
 * Back affordance rendered above the sections when the rail is in a nested
 * context (e.g. inside an event): an uppercase micro-label row ("← All events").
 * A real <a> on web (href provided) so right-click / new-tab work; chrome
 * styling per the soft-chrome exception (rail is chrome, not content).
 */
const BackRow = styled(XStack, {
  name: "NavigationRailBackRow",
  alignItems: "center",
  gap: "$2",
  paddingHorizontal: "$4",
  paddingVertical: "$2",
  minHeight: 36,
  width: "100%",
  cursor: "pointer",
  backgroundColor: "transparent",
  borderWidth: 0,
  borderRadius: 0,
  hoverStyle: {
    backgroundColor: "$surfaceMuted",
  },
  focusStyle: {
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineColor: "$accent",
    outlineOffset: 2,
  },
  variants: {
    collapsed: {
      true: {
        justifyContent: "center",
        paddingHorizontal: 0,
      },
    },
  } as const,
  defaultVariants: {
    collapsed: false,
  },
});

const BackLabel = styled(Text, {
  name: "NavigationRailBackLabel",
  variant: "bodySmall",
  tone: "muted",
  fontFamily: "$mono",
  fontWeight: "600",
  textTransform: "uppercase",
  letterSpacing: 2.5,
  fontSize: 10,
  textAlign: "left",
});

/**
 * Trailing per-item annotation (e.g. "post-pub" on a disabled item):
 * uppercase micro-type (Montserrat 600), muted, never truncating the label's
 * space claim.
 */
const ItemNote = styled(Text, {
  name: "NavigationRailItemNote",
  variant: "bodySmall",
  weight: "semibold",
  tone: "muted",
  textTransform: "uppercase",
  letterSpacing: 1.2,
  fontSize: 9,
  flexShrink: 0,
});

// Nested child rows (e.g. Settings → General/Contact): indented behind a soft
// vertical rule anchored under the parent's icon, rows otherwise identical to
// top-level items.
const ChildItemsStack = styled(YStack, {
  name: "NavigationRailChildItems",
  gap: "$1",
  marginLeft: 27,
  borderLeftWidth: 1,
  borderLeftColor: "$borderColorSoft",
});

/**
 * Reduced-motion preference resolved AFTER mount, so SSR and the first client
 * paint always agree (motion assumed OK); a reduced-motion client updates on
 * the next tick. Prevents hydration mismatches on motion-gated inline styles.
 */
const useReducedMotion = () => {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return undefined;
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener?.("change", sync);
    return () => mq.removeEventListener?.("change", sync);
  }, []);
  return reduced;
};

/**
 * Disclosure chevron shared by section headers and child-group rows: a single
 * glyph that rotates (-90° when closed) instead of swapping icons, so the
 * open/close reads as one continuous motion. Reduced motion drops the spin.
 */
const DisclosureChevron = ({
  open,
  reducedMotion,
}: {
  open: boolean;
  reducedMotion: boolean;
}) => {
  const glyph = <ChevronDown size={12} strokeWidth={2} aria-hidden />;
  if (!isWeb) return glyph;
  return (
    <span
      aria-hidden
      style={{
        display: "inline-flex",
        transform: open ? "none" : "rotate(-90deg)",
        transition: reducedMotion ? undefined : "transform 180ms ease",
      }}
    >
      {glyph}
    </span>
  );
};

const RailFooter = styled(YStack, {
  name: "NavigationRailFooter",
  marginTop: "auto",
  gap: "$3",
});

const ConfigSection = styled(YStack, {
  name: "NavigationRailConfigSection",
  gap: "$2",
  borderTopWidth: 2,
  borderTopColor: "$borderColor",
  paddingTop: "$3",
});

const ConfigHeading = styled(Text, {
  name: "NavigationRailConfigHeading",
  variant: "bodySmall",
  weight: "bold",
  tone: "muted",
  textTransform: "uppercase",
  letterSpacing: 1.6,
  fontSize: 10,
  // The frame no longer carries horizontal padding; align with the 16px
  // section-heading inset (buttons below own their padding).
  paddingHorizontal: "$4",
});

const ConfigDescriptionsStack = styled(YStack, {
  name: "NavigationRailConfigStack",
  gap: "$2",
});

const ConfigLabel = styled(Text, {
  name: "NavigationRailConfigLabel",
  variant: "bodySmall",
  weight: "semibold",
});

const ConfigDescription = styled(Text, {
  name: "NavigationRailConfigDescription",
  variant: "bodySmall",
  tone: "muted",
});

const RailButton = styled(Button, {
  name: "NavigationRailButton",
  justifyContent: "flex-start",
  width: "100%",
  gap: "$3",
  variant: "ghost",
  fontSize: "$3",
  borderRadius: 0,
  borderLeftWidth: 3,
  borderLeftColor: "transparent",
  paddingHorizontal: "$4",
  // Plain number (fractional tokens resolve to 0 — see ItemsStack). This
  // default is currently dead — every rail call site overrides it
  // (nav/group rows: 9, config controls: "$3") — but a dead 0 is a live
  // footgun for the next caller.
  paddingVertical: 14,
  backgroundColor: "transparent",
  hoverStyle: {
    backgroundColor: "$surfaceMuted",
  },
});

const IconSlot = styled(XStack, {
  name: "NavigationRailIconSlot",
  width: 24,
  height: 24,
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
});

const LabelSlot = styled(Text, {
  name: "NavigationRailLabel",
  flex: 1,
  textAlign: "left",
  fontSize: 13.5,
  fontWeight: "600",
  // Nav rows are wayfinding, not CTAs: sentence case (undo the ghost
  // Button's uppercase cascade), no link underline.
  textTransform: "none",
  textDecorationLine: "none",
  variants: {
    active: {
      true: {
        fontWeight: "700",
      },
    },
  } as const,
  defaultVariants: {
    active: false,
  },
});

interface FlattenedItem {
  key: string;
  item: NavigationItem;
  section: NavigationSection;
  parent?: NavigationItem;
}

const SECTION_COLLAPSE_STORAGE_PREFIX = "th-nav-sections:";

/**
 * Read the persisted closed-section id list. SSR-safe and never throws —
 * degrades to "everything open" when storage is unavailable or corrupt.
 */
const readClosedSectionIds = (storageKey: string | undefined): string[] => {
  if (!storageKey || typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
};

/** Persist the closed-section id list; silently degrades to in-memory only. */
const writeClosedSectionIds = (
  storageKey: string | undefined,
  ids: string[],
) => {
  if (!storageKey || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(ids));
  } catch {
    // Storage unavailable (private mode, quota, …) — keep in-memory state.
  }
};

export interface NavigationRailProps {
  sections: NavigationSection[];
  currentRoute: string;
  collapsed?: boolean;
  layout: NavigationShellLayout;
  variant?: "rail" | "drawer";
  onSelect: (route: string, meta: RouteMeta) => void;
  testIdBase?: string;
  emptyState?: ReactNode;
  footerSlot?: ReactNode;
  configControls?: NavigationConfigControl[];
  showDivider?: boolean;
  /**
   * Opt-in: render each section heading as a toggle button that shows/hides
   * the section's items (wide rail only — the 72px icon rail always shows
   * every item). The section containing the active route is locked open.
   */
  collapsibleSections?: boolean;
  /**
   * When set, closed-section ids persist to localStorage under
   * `th-nav-sections:{key}` so the collapse state survives reloads.
   */
  sectionCollapsePersistKey?: string;
  /**
   * Optional workspace identity block rendered at the top of the rail
   * (square initials avatar + label + sublabel, hairline below). The icon
   * rail shows the avatar only.
   */
  identity?: {
    label: string;
    sublabel?: string;
    /**
     * Concrete href so web renders a real `<a>` (right-click / new tab /
     * middle-click). Ignored on native, which has no anchors — pass
     * `onPress` there.
     */
    href?: string;
    /**
     * Activate handler. With an `href` this runs on a plain click only
     * (modifier-clicks fall through to the browser); without one the row
     * renders as a `<button>`.
     */
    onPress?: () => void;
    /**
     * Accessible name for the interactive row. The consumer owns it so it
     * stays i18n-correct (e.g. "Go to Acme Org dashboard").
     *
     * Strongly recommended. In the WIDE rail, omitting it falls back to the
     * visible label + sublabel, which is serviceable. In the 72px icon rail
     * neither renders (the avatar is `aria-hidden`), so the row would have NO
     * accessible name at all — the collapsed branch therefore falls back to
     * `label`, mirroring BackRow's required `label`. The tooltip cannot cover
     * this: it contributes `aria-describedby`, and a description is never a
     * name.
     */
    actionLabel?: string;
  };
  /**
   * Back affordance rendered between the identity block and the sections —
   * used when the rail shows a nested context (e.g. an event) to return to
   * the parent surface ("← All events").
   */
  back?: NavigationRailBack;
  /**
   * Context header rendered under the back row, above the sections (wide
   * rail and drawer only) — e.g. the event title + status chip. The caller
   * owns its content; the rail only slots it.
   */
  contextHeader?: ReactNode;
}

export const NavigationRail = ({
  sections,
  currentRoute,
  collapsed = false,
  layout,
  variant = "rail",
  onSelect,
  testIdBase = "navigation-rail",
  emptyState,
  footerSlot,
  configControls = [],
  showDivider = variant === "rail",
  collapsibleSections = false,
  sectionCollapsePersistKey,
  identity,
  back,
  contextHeader,
}: NavigationRailProps) => {
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const sectionContentIdBase = useId();
  const reducedMotion = useReducedMotion();

  // Expansion animations stay off until the first user-driven (or
  // route-driven) toggle, so hydrating stored collapse state or the initial
  // render never plays a visible open/close sweep.
  const animateExpansionRef = useRef(false);
  const revealDurationMs = animateExpansionRef.current ? undefined : 0;

  // ── Collapsible section groups (opt-in, wide rail only) ────────────────
  // NOTE: `collapsed` (the prop) means the 72px icon rail; the closed-section
  // set below is a separate, per-section visibility state.
  const sectionCollapseEnabled = collapsibleSections && !collapsed;
  const storageKey = sectionCollapsePersistKey
    ? `${SECTION_COLLAPSE_STORAGE_PREFIX}${sectionCollapsePersistKey}`
    : undefined;

  const [closedSectionIds, setClosedSectionIds] = useState<string[]>([]);

  // Hydrate the closed set from storage after mount (SSR-safe: the server and
  // first client paint always render every section open).
  useEffect(() => {
    if (!collapsibleSections) return;
    setClosedSectionIds(readClosedSectionIds(storageKey));
  }, [collapsibleSections, storageKey]);

  // Active state: an item's explicit `active` flag (anchor items driven by
  // e.g. scroll-spy) overrides the route-derived match entirely.
  const isItemActive = useCallback(
    (item: NavigationItem) =>
      item.active ?? isRouteActive(currentRoute, item.route, item.activeMatch),
    [currentRoute],
  );

  // The section that contains the active route can never be closed.
  const activeSectionId = useMemo(() => {
    for (const section of sections) {
      for (const item of section.items) {
        if (isItemActive(item)) return section.id;
        if (item.children?.some((child) => isItemActive(child))) {
          return section.id;
        }
      }
    }
    return undefined;
  }, [sections, isItemActive]);

  // When the route moves into a closed section, auto-open it (and persist).
  useEffect(() => {
    if (!collapsibleSections || !activeSectionId) return;
    if (!closedSectionIds.includes(activeSectionId)) return;
    animateExpansionRef.current = true;
    const next = closedSectionIds.filter((id) => id !== activeSectionId);
    writeClosedSectionIds(storageKey, next);
    setClosedSectionIds(next);
  }, [collapsibleSections, activeSectionId, closedSectionIds, storageKey]);

  const effectiveClosedIds = useMemo(() => {
    if (!sectionCollapseEnabled) return new Set<string>();
    const set = new Set(closedSectionIds);
    if (activeSectionId) set.delete(activeSectionId);
    return set;
  }, [sectionCollapseEnabled, closedSectionIds, activeSectionId]);

  const toggleSection = useCallback(
    (sectionId: string) => {
      // The active section is locked open — its header toggle is a no-op.
      if (sectionId === activeSectionId) return;
      animateExpansionRef.current = true;
      const next = closedSectionIds.includes(sectionId)
        ? closedSectionIds.filter((id) => id !== sectionId)
        : [...closedSectionIds, sectionId];
      writeClosedSectionIds(storageKey, next);
      setClosedSectionIds(next);
    },
    [activeSectionId, closedSectionIds, storageKey],
  );

  // ── Child-group disclosure (items with `children`, e.g. Settings) ──────
  // Session-local: open by default only while the group (or one of its
  // children) is the active route; user toggles override that default.
  const [itemGroupOverrides, setItemGroupOverrides] = useState<
    Record<string, boolean>
  >({});

  const isItemGroupActive = useCallback(
    (item: NavigationItem) =>
      isItemActive(item) ||
      Boolean(item.children?.some((child) => isItemActive(child))),
    [isItemActive],
  );

  const openItemGroupKeys = useMemo(() => {
    const open = new Set<string>();
    for (const section of sections) {
      for (const item of section.items) {
        if (!item.children?.length) continue;
        const itemKey = `${section.id}:${item.id}`;
        if (itemGroupOverrides[itemKey] ?? isItemGroupActive(item)) {
          open.add(itemKey);
        }
      }
    }
    return open;
  }, [sections, itemGroupOverrides, isItemGroupActive]);

  // Route moved into a group the user had closed → clear the override so the
  // active child is never hidden.
  useEffect(() => {
    for (const section of sections) {
      for (const item of section.items) {
        if (!item.children?.length) continue;
        const itemKey = `${section.id}:${item.id}`;
        if (itemGroupOverrides[itemKey] === false && isItemGroupActive(item)) {
          animateExpansionRef.current = true;
          setItemGroupOverrides((prev) => {
            const { [itemKey]: _cleared, ...rest } = prev;
            return rest;
          });
        }
      }
    }
  }, [sections, itemGroupOverrides, isItemGroupActive]);

  const toggleItemGroup = useCallback(
    (itemKey: string, currentlyOpen: boolean) => {
      animateExpansionRef.current = true;
      setItemGroupOverrides((prev) => ({ ...prev, [itemKey]: !currentlyOpen }));
    },
    [],
  );

  const focusOrder = useMemo(() => {
    const order: string[] = [];
    for (const section of sections) {
      if (sectionCollapseEnabled) {
        order.push(`header:${section.id}`);
        // Items in a closed section are not rendered — skip them.
        if (effectiveClosedIds.has(section.id)) continue;
      }
      for (const item of section.items) {
        const itemKey = `${section.id}:${item.id}`;
        if (!item.disabled) order.push(itemKey);
        // Children of a closed disclosure group are not rendered (the icon
        // rail always shows them) — keep the roving focus order in sync.
        const childrenVisible =
          collapsed ||
          !item.children?.length ||
          openItemGroupKeys.has(itemKey);
        if (!childrenVisible) continue;
        for (const child of item.children ?? []) {
          if (!child.disabled) order.push(`${itemKey}:${child.id}`);
        }
      }
    }
    return order;
  }, [
    sections,
    sectionCollapseEnabled,
    effectiveClosedIds,
    collapsed,
    openItemGroupKeys,
  ]);

  const focusById = useCallback((id: string) => {
    const ref = id ? itemRefs.current[id] : undefined;
    ref?.focus();
  }, []);

  useEffect(() => {
    if (!isWeb) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
        return;
      }

      const activeElement = document.activeElement as HTMLElement | null;
      const activeId = activeElement?.dataset?.navId;
      if (!activeId) {
        return;
      }

      event.preventDefault();
      const currentIndex = focusOrder.indexOf(activeId);
      if (currentIndex === -1) {
        return;
      }
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        (((currentIndex + delta + focusOrder.length) % focusOrder.length) +
          focusOrder.length) %
        focusOrder.length;
      const nextId = focusOrder[nextIndex];
      if (nextId) {
        focusById(nextId);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [focusOrder, focusById]);

  const renderItem = useCallback(
    (row: FlattenedItem) => {
      const { key, item, section, parent } = row;
      const isActive =
        item.active ?? isRouteActive(currentRoute, item.route, item.activeMatch);
      const showLabel = !collapsed;
      const meta: RouteMeta = {
        source: variant === "drawer" ? "drawer" : "rail",
        sectionId: section.id,
        parentId: parent?.id,
      };

      const toneColor = (() => {
        switch (item.tone) {
          case "danger":
            return "$danger";
          case "success":
            return "$success";
          default:
            return "$color";
        }
      })();

      const badgeTone = (() => {
        switch (item.tone) {
          case "danger":
            return "danger";
          case "success":
            return "success";
          default:
            return "neutral";
        }
      })();

      const handlePress = () => {
        if (item.disabled) return;
        onSelect(item.route, meta);
      };

      /**
       * On web: intercept link clicks for SPA navigation while keeping
       * the native <a> element so users can right-click → "Open in new tab"
       * and screen readers announce the item as a link.
       */
      const handleAnchorClick = isWeb
        ? (e: MouseEvent<HTMLAnchorElement>) => {
            // Allow modifier-clicks (⌘/Ctrl) to open in a new tab natively.
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            handlePress();
          }
        : undefined;

      const registerRef = (node: HTMLButtonElement | null) => {
        itemRefs.current[key] = node;
      };

      // On web, render as <a> for right-click and screen reader support.
      // text-decoration lives on the anchor and paints through descendants,
      // so the underline reset must happen here, not on the label.
      // Disabled items must NOT be anchors — an <a href> stays keyboard- and
      // middle-click-navigable regardless of pointer-events, so they render
      // as a native disabled <button> instead.
      const webLinkProps = isWeb
        ? item.disabled
          ? { type: "button" as const, "aria-disabled": true as const }
          : {
              tag: "a" as const,
              href: item.route,
              role: "link" as const,
              style: { textDecoration: "none" } as const,
            }
        : {};

      const button = (
        <RailButton
          key={key}
          ref={registerRef as unknown as (node: TamaguiElement) => void}
          justifyContent={showLabel ? "flex-start" : "center"}
          // 13px + the 3px spine = a 16px optical left edge, aligned with the
          // 16px section-heading inset.
          paddingLeft={showLabel ? 13 : 0}
          paddingRight={showLabel ? 16 : 0}
          paddingVertical={9}
          gap={showLabel ? "$3" : 0}
          opacity={item.disabled ? 0.4 : 1}
          disabled={item.disabled}
          backgroundColor="transparent"
          // `$accentText` is the AA rung for accent-coloured small text —
          // raw `$accent` fails 4.5:1 at this size on the raised surface.
          color={isActive ? "$accentText" : toneColor}
          fontWeight={isActive ? "700" : "600"}
          // Order matters: the borderWidth shorthand expands to all four
          // sides, so it must come BEFORE the left-spine longhands or it
          // zeroes them out.
          borderWidth={0}
          borderLeftWidth={3}
          borderLeftColor={isActive ? "$brandSecondary" : "transparent"}
          aria-current={isActive && isWeb ? "page" : undefined}
          data-active={isActive ? "true" : "false"}
          data-nav-id={key}
          // Icon-only mode (72px rail) hides the visible label, so the row
          // must carry its accessible name explicitly — the lucide icon is
          // nameless. Spread conditionally: never pass the a11y twins as
          // explicit `undefined` (RNW maps both onto one DOM attribute and
          // the undefined wipes the aria value).
          {...(!showLabel
            ? isWeb
              ? { "aria-label": item.label }
              : { accessibilityLabel: item.label }
            : {})}
          onPress={handlePress}
          flexDirection={showLabel ? "row" : "column"}
          width="100%"
          borderRadius={0}
          hoverStyle={{
            backgroundColor: "$surfaceMuted",
            borderLeftColor: isActive ? "$brandSecondary" : "transparent",
          }}
          pressStyle={{
            opacity: 0.92,
          }}
          testID={isWeb ? undefined : `${testIdBase}-${key}`}
          {...webLinkProps}
          {...(isWeb ? { onClick: handleAnchorClick } : {})}
        >
          {/* flex+minWidth (not width:100%) so a trailing Badge keeps its
              room, and the icon centers in the label-less 72px rail. */}
          <XStack
            gap="$3"
            alignItems="center"
            flex={1}
            minWidth={0}
            justifyContent={showLabel ? "flex-start" : "center"}
          >
            {item.icon ? <IconSlot>{item.icon}</IconSlot> : null}
            {showLabel ? (
              <LabelSlot flexShrink={1} truncate active={isActive}>
                {item.label}
              </LabelSlot>
            ) : null}
          </XStack>
          {showLabel && item.note ? <ItemNote>{item.note}</ItemNote> : null}
          {showLabel && item.badgeCount ? (
            <Badge tone={badgeTone}>{item.badgeCount}</Badge>
          ) : null}
        </RailButton>
      );

      if (collapsed) {
        return (
          <Tooltip
            key={`${key}-tooltip`}
            anchor={button}
            placement="right"
            showPointer={false}
          >
            <Text variant="bodySmall" weight="bold">
              {item.label}
            </Text>
          </Tooltip>
        );
      }

      return button;
    },
    [collapsed, currentRoute, onSelect, testIdBase, variant],
  );

  const renderMaybeCollapsibleItem = useCallback(
    (section: NavigationSection, item: NavigationItem) => {
      const itemKey = `${section.id}:${item.id}`;

      // If the rail is collapsed (icons only), keep current behavior: show parent + children always.
      // The UX of expanding content while labels are hidden is awkward, and tooltips already provide
      // the discoverability we want. (No ChildItemsStack: its nesting indent
      // has no room in the 72px rail.)
      if (collapsed || !item.children?.length) {
        return (
          <YStack key={itemKey} gap="$1" role={isWeb ? "none" : undefined}>
            {renderItem({ key: itemKey, item, section })}
            {item.children?.length ? (
              <YStack gap="$1">
                {item.children.map((child) =>
                  renderItem({
                    key: `${itemKey}:${child.id}`,
                    item: child,
                    section,
                    parent: item,
                  }),
                )}
              </YStack>
            ) : null}
          </YStack>
        );
      }

      // When a child is active, the child row carries the active spine — the
      // parent defers so we don't double-highlight (the parent route commonly
      // equals its first child's, e.g. Settings ↔ Settings/General).
      const childActive = Boolean(
        item.children?.some((child) => isItemActive(child)),
      );
      const isActive = isItemActive(item) && !childActive;
      const isOpen = openItemGroupKeys.has(itemKey);
      // A group holding the active route is locked open (like the active
      // section): its toggle is a no-op, otherwise the lock-open effect would
      // fight the close and produce a collapse→reopen wobble.
      const isLockedOpen = isItemGroupActive(item);
      const groupContentId = `${sectionContentIdBase}-${itemKey}`;

      const registerGroupRef = (node: HTMLButtonElement | null) => {
        itemRefs.current[itemKey] = node;
      };

      // Disclosure row styled EXACTLY like a nav row (same inset, type scale,
      // spine) — pressing toggles the children; it does not navigate.
      const groupRow = (
        <RailButton
          ref={registerGroupRef as unknown as (node: TamaguiElement) => void}
          justifyContent="flex-start"
          paddingLeft={13}
          paddingRight={16}
          paddingVertical={9}
          gap="$3"
          backgroundColor="transparent"
          color={isActive ? "$accentText" : "$color"}
          // borderWidth shorthand first — it expands to all four sides and
          // would zero the left spine if it came after the longhands.
          borderWidth={0}
          borderLeftWidth={3}
          borderLeftColor={isActive ? "$brandSecondary" : "transparent"}
          width="100%"
          borderRadius={0}
          data-active={isActive ? "true" : "false"}
          data-nav-id={itemKey}
          onPress={
            isLockedOpen ? undefined : () => toggleItemGroup(itemKey, isOpen)
          }
          hoverStyle={{
            backgroundColor: "$surfaceMuted",
            borderLeftColor: isActive ? "$brandSecondary" : "transparent",
          }}
          pressStyle={{ opacity: isLockedOpen ? 1 : 0.92 }}
          testID={isWeb ? undefined : `${testIdBase}-${itemKey}`}
          {...(isWeb
            ? {
                type: "button" as const,
                // A locked-open group is a static disclosure: report expanded,
                // drop the toggle semantics (no aria-controls, no handler)
                // rather than an aria-disabled the styled Button strips anyway.
                "aria-expanded": isLockedOpen ? undefined : isOpen,
                // Only reference the child container while it's mounted (Reveal
                // unmounts it when closed).
                ...(isOpen && !isLockedOpen
                  ? { "aria-controls": groupContentId }
                  : {}),
              }
            : {})}
        >
          <XStack gap="$3" alignItems="center" flex={1} minWidth={0}>
            {item.icon ? <IconSlot>{item.icon}</IconSlot> : null}
            <LabelSlot flexShrink={1} truncate active={isActive}>
              {item.label}
            </LabelSlot>
          </XStack>
          {item.badgeCount ? (
            <Badge tone="neutral">{item.badgeCount}</Badge>
          ) : null}
          <DisclosureChevron open={isOpen} reducedMotion={reducedMotion} />
        </RailButton>
      );

      const childRows = (
        <ChildItemsStack
          id={isWeb ? groupContentId : undefined}
          role={isWeb ? "list" : undefined}
        >
          {item.children.map((child) =>
            renderItem({
              key: `${itemKey}:${child.id}`,
              item: child,
              section,
              parent: item,
            }),
          )}
        </ChildItemsStack>
      );

      return (
        <YStack key={itemKey} gap="$1" role={isWeb ? "none" : undefined}>
          {groupRow}
          {isWeb ? (
            <Reveal show={isOpen} durationMs={revealDurationMs}>
              {childRows}
            </Reveal>
          ) : isOpen ? (
            childRows
          ) : null}
        </YStack>
      );
    },
    [
      collapsed,
      currentRoute,
      isItemActive,
      isItemGroupActive,
      openItemGroupKeys,
      toggleItemGroup,
      sectionContentIdBase,
      revealDurationMs,
      reducedMotion,
      testIdBase,
      onSelect,
      renderItem,
      variant,
    ],
  );

  const renderConfigControl = useCallback(
    (control: NavigationConfigControl) => {
      const button = (
        <RailButton
          key={control.id}
          onPress={control.onPress}
          disabled={control.disabled}
          justifyContent={collapsed ? "center" : "flex-start"}
          paddingHorizontal="$4"
          paddingVertical="$3"
          gap={collapsed ? 0 : "$3"}
          flexDirection={collapsed ? "column" : "row"}
          alignItems="center"
          backgroundColor="transparent"
          color={control.active ? "$accent" : "$color"}
          borderLeftColor={control.active ? "$brandSecondary" : "transparent"}
          hoverStyle={{
            backgroundColor: "$surfaceMuted",
            borderLeftColor: control.active ? "$brandSecondary" : "$accent",
          }}
          aria-pressed={isWeb ? (control.active ? "true" : "false") : undefined}
          data-active={control.active ? "true" : "false"}
          // Icon-only mode hides the label block below — carry the name.
          {...(collapsed
            ? isWeb
              ? { "aria-label": control.label }
              : { accessibilityLabel: control.label }
            : {})}
          testID={isWeb ? undefined : `${testIdBase}-config-${control.id}`}
        >
          {control.icon ? <IconSlot>{control.icon}</IconSlot> : null}
          {!collapsed ? (
            <YStack gap="$1" flex={1} alignItems="flex-start">
              <ConfigLabel>{control.label}</ConfigLabel>
              {control.description ? (
                <ConfigDescription>{control.description}</ConfigDescription>
              ) : null}
            </YStack>
          ) : null}
        </RailButton>
      );

      if (collapsed) {
        return (
          <Tooltip
            key={control.id}
            anchor={button}
            placement="right"
            showPointer={false}
          >
            <Text variant="bodySmall" weight="bold">
              {control.label}
            </Text>
            {control.description ? (
              <Text variant="bodySmall" tone="muted">
                {control.description}
              </Text>
            ) : null}
          </Tooltip>
        );
      }

      return button;
    },
    [collapsed, testIdBase],
  );

  const hasFooterContent = Boolean(
    (configControls?.length ?? 0) > 0 || footerSlot,
  );

  if (!sections.length) {
    return emptyState ? <>{emptyState}</> : null;
  }

  const FrameComponent =
    collapsed && variant === "rail" ? RailCollapsedFrame : RailFrame;

  return (
    <FrameComponent
      showDivider={showDivider}
      role={isWeb ? "navigation" : undefined}
      aria-label={isWeb ? "Main navigation" : undefined}
      data-variant={variant}
      data-layout={layout}
    >
      {identity
        ? (() => {
            const identityContent = (
              <>
                <IdentityAvatar aria-hidden>
                  <IdentityInitials>
                    {identity.label
                      .split(" ")
                      .map((part) => part[0])
                      .join("")
                      .slice(0, 2)
                      .toUpperCase()}
                  </IdentityInitials>
                </IdentityAvatar>
                {!collapsed ? (
                  <YStack flexShrink={1} minWidth={0}>
                    <IdentityName truncate>{identity.label}</IdentityName>
                    {identity.sublabel ? (
                      <IdentitySub truncate>{identity.sublabel}</IdentitySub>
                    ) : null}
                  </YStack>
                ) : null}
              </>
            );

            // `href` is web-only (native has no anchors), so gate it the way
            // WorkspaceSwitcher does — otherwise a native consumer passing
            // only an href would get an inert, unlabelled row.
            const identityHref = isWeb ? identity.href : undefined;
            const identityPress = identity.onPress;

            if (!identityHref && !identityPress) {
              // Inert: exactly as before, so consumers that pass neither are
              // untouched.
              return (
                <IdentityRow collapsed={collapsed}>
                  {identityContent}
                </IdentityRow>
              );
            }

            const identityRow = (
              <IdentityRow collapsed={collapsed} paddingHorizontal={0}>
                <IdentityAction
                  collapsed={collapsed}
                  testID={isWeb ? undefined : `${testIdBase}-identity`}
                  data-testid={isWeb ? `${testIdBase}-identity` : undefined}
                  {...(isWeb
                    ? {
                        // Collapsed: nothing else renders (avatar is
                        // aria-hidden, label/sublabel are dropped), so an
                        // omitted actionLabel would leave an unnamed link.
                        // Matches the native branch's fallback below.
                        "aria-label":
                          identity.actionLabel ??
                          (collapsed ? identity.label : undefined),
                      }
                    : {
                        accessibilityRole: "button" as const,
                        accessibilityLabel:
                          identity.actionLabel ?? identity.label,
                      })}
                  {...(identityHref
                    ? {
                        // Anchor path carries ONLY onClick — wiring onPress
                        // too would double-fire (XStack attaches both).
                        tag: "a" as const,
                        href: identityHref,
                        role: "link" as const,
                        style: { textDecoration: "none" } as const,
                        onClick: (e: MouseEvent<HTMLAnchorElement>) => {
                          // Modifier-clicks open in a new tab natively.
                          if (
                            e.metaKey ||
                            e.ctrlKey ||
                            e.shiftKey ||
                            e.altKey
                          ) {
                            return;
                          }
                          if (!identityPress) return;
                          e.preventDefault();
                          identityPress();
                        },
                      }
                    : {
                        onPress: identityPress,
                        ...(isWeb
                          ? { tag: "button" as const, type: "button" as const }
                          : {}),
                      })}
                >
                  {identityContent}
                </IdentityAction>
              </IdentityRow>
            );

            if (!collapsed) return identityRow;
            // Icon rail: the label is gone, so the only affordance text is
            // the tooltip — same treatment BackRow gets.
            return (
              <Tooltip
                anchor={identityRow}
                placement="right"
                showPointer={false}
              >
                <Text variant="bodySmall" weight="bold">
                  {identity.actionLabel ?? identity.label}
                </Text>
              </Tooltip>
            );
          })()
        : null}
      {back
        ? (() => {
            const backRow = (
              <BackRow
                collapsed={collapsed}
                aria-label={collapsed && isWeb ? back.label : undefined}
                testID={isWeb ? undefined : `${testIdBase}-back`}
                data-testid={isWeb ? `${testIdBase}-back` : undefined}
                {...(isWeb && back.href
                  ? {
                      // Anchor path carries ONLY onClick — wiring onPress too
                      // would double-fire (XStack attaches both handlers).
                      tag: "a" as const,
                      href: back.href,
                      role: "link" as const,
                      style: { textDecoration: "none" } as const,
                      onClick: (e: MouseEvent<HTMLAnchorElement>) => {
                        // Modifier-clicks open in a new tab natively.
                        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
                          return;
                        e.preventDefault();
                        back.onPress();
                      },
                    }
                  : {
                      onPress: back.onPress,
                      ...(isWeb
                        ? { tag: "button" as const, type: "button" as const }
                        : {}),
                    })}
              >
                <ArrowLeft size={14} strokeWidth={2} aria-hidden />
                {!collapsed ? <BackLabel>{back.label}</BackLabel> : null}
              </BackRow>
            );
            if (!collapsed) return backRow;
            return (
              <Tooltip anchor={backRow} placement="right" showPointer={false}>
                <Text variant="bodySmall" weight="bold">
                  {back.label}
                </Text>
              </Tooltip>
            );
          })()
        : null}
      {contextHeader && !collapsed ? contextHeader : null}
      <ScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        flex={1}
        minHeight={0}
      >
        <YStack gap="$2" flex={1}>
          {sections.map((section, sectionIndex) => {
            const isSectionClosed = effectiveClosedIds.has(section.id);
            const isActiveSection = section.id === activeSectionId;
            const sectionContentId = `${sectionContentIdBase}-${section.id}`;
            const headerKey = `header:${section.id}`;
            // In the icon rail there is no label to show; skip the heading
            // entirely unless the section carries its own icon.
            const showHeading = !collapsed || Boolean(section.icon);

            const heading = !showHeading ? null : sectionCollapseEnabled ? (
              <SectionHeadingButton
                ref={((node: HTMLButtonElement | null) => {
                  itemRefs.current[headerKey] = node;
                }) as unknown as (node: TamaguiElement) => void}
                data-nav-id={headerKey}
                onPress={() => toggleSection(section.id)}
                testID={
                  isWeb ? undefined : `${testIdBase}-section-${section.id}`
                }
                {...(isWeb
                  ? {
                      type: "button" as const,
                      "aria-expanded": !isSectionClosed,
                      "aria-controls": sectionContentId,
                      ...(isActiveSection
                        ? { "aria-disabled": true as const }
                        : {}),
                    }
                  : {})}
              >
                {section.icon ? <IconSlot>{section.icon}</IconSlot> : null}
                <SectionLabel flex={1}>{section.label}</SectionLabel>
                <DisclosureChevron
                  open={!isSectionClosed}
                  reducedMotion={reducedMotion}
                />
              </SectionHeadingButton>
            ) : (
              <SectionHeading>
                {section.icon ? <IconSlot>{section.icon}</IconSlot> : null}
                {!collapsed ? (
                  <SectionLabel>{section.label}</SectionLabel>
                ) : null}
              </SectionHeading>
            );

            return (
              <SectionGroup
                key={section.id}
                collapsed={collapsed}
                withSeparator={
                  collapsed
                    ? sectionIndex > 0
                    : Boolean(section.separatorAbove) && sectionIndex > 0
                }
              >
                {heading}
                <ItemsStack
                  id={isWeb ? sectionContentId : undefined}
                  role={isWeb ? "list" : undefined}
                >
                  {sectionCollapseEnabled && isWeb ? (
                    <Reveal
                      show={!isSectionClosed}
                      durationMs={revealDurationMs}
                    >
                      {section.items.map((item) =>
                        renderMaybeCollapsibleItem(section, item),
                      )}
                    </Reveal>
                  ) : isSectionClosed ? null : (
                    section.items.map((item) =>
                      renderMaybeCollapsibleItem(section, item),
                    )
                  )}
                </ItemsStack>
              </SectionGroup>
            );
          })}
        </YStack>
      </ScrollView>
      {hasFooterContent ? (
        <RailFooter>
          {configControls?.length ? (
            <ConfigSection>
              {!collapsed ? <ConfigHeading>Preferences</ConfigHeading> : null}
              <ConfigDescriptionsStack>
                {configControls.map((control) => renderConfigControl(control))}
              </ConfigDescriptionsStack>
            </ConfigSection>
          ) : null}
          {footerSlot}
        </RailFooter>
      ) : null}
    </FrameComponent>
  );
};

NavigationRail.displayName = "NavigationRail";
