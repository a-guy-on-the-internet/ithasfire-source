"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, useWindowDimensions } from "react-native";
import { useThemeName } from "tamagui";

import { defaultTheme, type IthasFireThemeName } from "../tamagui";
import type {
  AccountContext,
  NavigationItem,
  NavigationSection,
  NavigationShellLayout,
  NavigationShellAnalyticsConfig,
  QuickActionConfig,
  RouteMeta,
} from "./NavigationShell.types";
import { isCommandPaletteChord } from "./utils/command-palette-chord";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DESKTOP_BREAKPOINT = 1200;
const RAIL_STORAGE_KEY = "th:navShell:railState";

const isWebPlatform = () => Platform.OS === "web";

// ─────────────────────────────────────────────────────────────────────────────
// Layout Resolution
// ─────────────────────────────────────────────────────────────────────────────

export const resolveLayout = (
  width: number | undefined,
  forceLayout: NavigationShellLayout | undefined,
  drawerBreakpoint: number,
): NavigationShellLayout => {
  if (forceLayout) {
    return forceLayout;
  }

  const viewportWidth = typeof width === "number" ? width : DESKTOP_BREAKPOINT;
  if (viewportWidth >= DESKTOP_BREAKPOINT) {
    return "desktop";
  }

  if (viewportWidth >= drawerBreakpoint) {
    return "compact";
  }

  return "mobile";
};

export function useShellLayout(
  drawerBreakpoint: number,
  forceLayout?: NavigationShellLayout,
): NavigationShellLayout {
  const { width } = useWindowDimensions();
  return resolveLayout(width, forceLayout, drawerBreakpoint);
}

// ─────────────────────────────────────────────────────────────────────────────
// Rail State (collapsed/expanded)
// ─────────────────────────────────────────────────────────────────────────────

const readStoredRailState = (): "expanded" | "collapsed" | null => {
  if (!isWebPlatform() || typeof window === "undefined") {
    return null;
  }

  try {
    const value = window.localStorage.getItem(RAIL_STORAGE_KEY);
    if (value === "expanded" || value === "collapsed") {
      return value;
    }
  } catch {
    return null;
  }

  return null;
};

const writeStoredRailState = (state: "expanded" | "collapsed") => {
  if (!isWebPlatform() || typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(RAIL_STORAGE_KEY, state);
  } catch {
    // ignore storage errors
  }
};

export interface UseRailStateOptions {
  behavior: "auto" | "expanded" | "collapsed";
  layout: NavigationShellLayout;
  analytics?: NavigationShellAnalyticsConfig;
}

export interface UseRailStateResult {
  railState: "expanded" | "collapsed";
  toggleRail: () => void;
  setRailState: (state: "expanded" | "collapsed") => void;
}

export function useRailState({
  behavior,
  layout,
  analytics,
}: UseRailStateOptions): UseRailStateResult {
  const storedRailState = useMemo(() => readStoredRailState(), []);
  const [railState, setRailStateInternal] = useState<"expanded" | "collapsed">(
    () => {
      if (behavior !== "auto") {
        return behavior;
      }
      return (
        storedRailState ?? (layout === "desktop" ? "expanded" : "collapsed")
      );
    },
  );
  const hasStoredPreferenceRef = useRef(Boolean(storedRailState));

  useEffect(() => {
    if (behavior !== "auto") {
      setRailStateInternal(behavior);
      return;
    }

    if (!hasStoredPreferenceRef.current) {
      const nextState = layout === "desktop" ? "expanded" : "collapsed";
      setRailStateInternal(nextState);
    }
  }, [behavior, layout]);

  const toggleRail = useCallback(() => {
    const nextState = railState === "expanded" ? "collapsed" : "expanded";
    setRailStateInternal(nextState);
    analytics?.onRailToggle?.({ state: nextState });

    if (behavior === "auto") {
      hasStoredPreferenceRef.current = true;
      writeStoredRailState(nextState);
    }
  }, [analytics, behavior, railState]);

  const setRailState = useCallback(
    (state: "expanded" | "collapsed") => {
      setRailStateInternal(state);
      if (behavior === "auto") {
        hasStoredPreferenceRef.current = true;
        writeStoredRailState(state);
      }
    },
    [behavior],
  );

  return { railState, toggleRail, setRailState };
}

// ─────────────────────────────────────────────────────────────────────────────
// Drawer State
// ─────────────────────────────────────────────────────────────────────────────

export interface UseDrawerStateResult {
  drawerOpen: boolean;
  toggleDrawer: () => void;
  openDrawer: () => void;
  closeDrawer: () => void;
  setDrawerOpen: (open: boolean) => void;
}

export function useDrawerState(): UseDrawerStateResult {
  const [drawerOpen, setDrawerOpen] = useState(false);

  const toggleDrawer = useCallback(() => {
    setDrawerOpen((open) => !open);
  }, []);

  const openDrawer = useCallback(() => {
    setDrawerOpen(true);
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
  }, []);

  return { drawerOpen, toggleDrawer, openDrawer, closeDrawer, setDrawerOpen };
}

// ─────────────────────────────────────────────────────────────────────────────
// Appearance/Theme State
//
// This hook reports which base theme the shell should render under.
//
// - Web: FOLLOW the ambient theme set by the root AppThemeProvider's
//   `<Theme name={stub|ember}>` (driven by the navbar light/dark toggle +
//   `th-theme` cookie). The shell must NOT re-pin a base theme, or the toggle
//   would be dead everywhere under the Admin/Platform/Seller shells. We read
//   the ambient name via Tamagui's `useThemeName()` so `appearance` tracks the
//   live mode, falling back to `defaultTheme` (Stub) if it is ever unresolved.
// - Native (mobile / scanner): always Ember (dark). Mobile is deliberately
//   dark and unaffected by the web preference. This branch is gated on
//   `isWebPlatform()` and returns exactly "ember" — byte-for-byte the prior
//   behaviour — so the native code path is unchanged.
//
// (The Tamagui theme key is "ember", not "dark", so Tamagui does not emit it
// into a prefers-color-scheme :root rule.)
// ─────────────────────────────────────────────────────────────────────────────

export interface UseAppearanceResult {
  appearance: IthasFireThemeName;
}

export function useAppearance(): UseAppearanceResult {
  // Called unconditionally to respect the rules of hooks; the value is only
  // consumed on web (native pins Ember below).
  const ambient = useThemeName();
  return useMemo(() => {
    if (!isWebPlatform()) {
      // Native is deliberately dark — always Ember, unchanged from before.
      return { appearance: "ember" as IthasFireThemeName };
    }
    // Web follows the ambient mode; fall back to the default (Stub) theme.
    return {
      appearance: (ambient as IthasFireThemeName) || defaultTheme,
    };
  }, [ambient]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Context Switching
// ─────────────────────────────────────────────────────────────────────────────

export interface UseContextSwitchOptions {
  accountContext: AccountContext;
  onContextSwitch?: (contextId: string) => Promise<void> | void;
  analytics?: NavigationShellAnalyticsConfig;
}

export interface UseContextSwitchResult {
  contextSwitchingId: string | null;
  handleContextSwitch: (nextContextId: string) => Promise<void>;
}

export function useContextSwitch({
  accountContext,
  onContextSwitch,
  analytics,
}: UseContextSwitchOptions): UseContextSwitchResult {
  const [contextSwitchingId, setContextSwitchingId] = useState<string | null>(
    null,
  );

  const handleContextSwitch = useCallback(
    async (nextContextId: string) => {
      if (!onContextSwitch) {
        return;
      }
      setContextSwitchingId(nextContextId);
      const start =
        typeof performance !== "undefined" ? performance.now() : Date.now();

      try {
        await onContextSwitch(nextContextId);
        const latencyMs =
          (typeof performance !== "undefined"
            ? performance.now()
            : Date.now()) - start;
        analytics?.onContextSwitch?.({
          fromContextId: accountContext.id,
          toContextId: nextContextId,
          latencyMs,
        });
      } finally {
        setContextSwitchingId(null);
      }
    },
    [accountContext.id, analytics, onContextSwitch],
  );

  return { contextSwitchingId, handleContextSwitch };
}

// ─────────────────────────────────────────────────────────────────────────────
// RBAC Filtering
// ─────────────────────────────────────────────────────────────────────────────

type ActorRoles = NonNullable<AccountContext["roles"]>;

const isRolePermitted = (
  requiredRoles: NavigationSection["rbac"] | NavigationItem["rbac"],
  roles: ActorRoles,
) => {
  // No constraint → visible to everyone.
  if (!requiredRoles?.length) {
    return true;
  }
  // Err OPEN when the actor's roles are unknown/empty (still loading the
  // membership/staff query). Hiding everything would flash an empty shell or
  // lock a legitimate user out mid-load. Server-side use-case checks remain
  // the real security boundary; nav `rbac` only hides affordances.
  if (!roles.length) {
    return true;
  }
  // Visible iff the actor holds at least one of the required roles.
  return requiredRoles.some((required) => roles.includes(required));
};

const isFeatureEnabled = (
  flag: string | undefined,
  enabledFlags: string[] | undefined,
) => {
  if (!flag) {
    return true;
  }
  return enabledFlags?.includes(flag) ?? false;
};

const filterItems = (
  items: NavigationItem[],
  roles: ActorRoles,
  enabledFlags?: string[],
): NavigationItem[] => {
  const visibleItems: NavigationItem[] = [];

  for (const item of items) {
    if (
      !isRolePermitted(item.rbac, roles) ||
      !isFeatureEnabled(item.featureFlag, enabledFlags)
    ) {
      continue;
    }

    const filteredChildren = item.children?.filter(
      (child) =>
        isRolePermitted(child.rbac, roles) &&
        isFeatureEnabled(child.featureFlag, enabledFlags),
    );

    visibleItems.push({
      ...item,
      children: filteredChildren?.length ? filteredChildren : undefined,
    });
  }

  return visibleItems;
};

export const filterSections = (
  sections: NavigationSection[],
  roles: ActorRoles,
  enabledFlags?: string[],
): NavigationSection[] => {
  const visibleSections: NavigationSection[] = [];

  for (const section of sections) {
    if (
      !isRolePermitted(section.rbac, roles) ||
      !isFeatureEnabled(section.featureFlag, enabledFlags)
    ) {
      continue;
    }
    const filteredItems = filterItems(section.items, roles, enabledFlags);
    if (!filteredItems.length) {
      continue;
    }

    visibleSections.push({
      ...section,
      items: filteredItems,
    });
  }

  return visibleSections;
};

export function useFilteredNavigation(
  sections: NavigationSection[],
  roles: ActorRoles,
  enabledFlags?: string[],
): NavigationSection[] {
  return useMemo(
    () => filterSections(sections, roles, enabledFlags),
    [sections, roles, enabledFlags],
  );
}

export function useFilteredQuickActions(
  quickActions: QuickActionConfig[] | undefined,
  roles: ActorRoles,
): QuickActionConfig[] {
  return useMemo(
    () =>
      (quickActions ?? []).filter((action) =>
        isRolePermitted(action.rbac, roles),
      ),
    [quickActions, roles],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Route Selection
// ─────────────────────────────────────────────────────────────────────────────

export interface UseRouteSelectionOptions {
  onRouteSelect: (routeId: string, meta?: RouteMeta) => void;
  layout: NavigationShellLayout;
  closeDrawer: () => void;
  analytics?: NavigationShellAnalyticsConfig;
}

export function useRouteSelection({
  onRouteSelect,
  layout,
  closeDrawer,
  analytics,
}: UseRouteSelectionOptions) {
  return useCallback(
    (routeId: string, meta?: RouteMeta) => {
      onRouteSelect(routeId, meta);
      if (meta) {
        analytics?.onRouteSelect?.({ routeId, meta });
      }

      if (layout === "mobile") {
        closeDrawer();
      }
    },
    [analytics, closeDrawer, layout, onRouteSelect],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Command Palette Keyboard Shortcut
// ─────────────────────────────────────────────────────────────────────────────

export function useCommandPaletteShortcut(onOpenCommandPalette?: () => void) {
  useEffect(() => {
    if (!isWebPlatform() || !onOpenCommandPalette) {
      return undefined;
    }

    const handler = (event: KeyboardEvent) => {
      // ⌘K on Apple platforms, Ctrl+K elsewhere — the one shared rule.
      if (isCommandPaletteChord(event)) {
        // Another handler (the web app's Spotlight shortcut listens on
        // `document`, which runs before this `window` listener) already took
        // the chord; opening a second palette on the same press would stack.
        if (event.defaultPrevented) return;
        event.preventDefault();
        onOpenCommandPalette();
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onOpenCommandPalette]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Analytics View Tracking
// ─────────────────────────────────────────────────────────────────────────────

export function useShellViewTracking(
  layout: NavigationShellLayout,
  accountContext: AccountContext,
  sectionCount: number,
  loading: boolean,
  analytics?: NavigationShellAnalyticsConfig,
) {
  useEffect(() => {
    if (loading) {
      return;
    }

    analytics?.onView?.({
      layout,
      contextType: accountContext.type,
      sectionCount,
    });
  }, [accountContext.type, analytics, layout, loading, sectionCount]);
}
