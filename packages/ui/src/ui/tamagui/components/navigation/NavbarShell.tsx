"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { XStack, YStack, styled } from "tamagui";

import { Navbar, type NavbarProps } from "./Navbar";
import {
  NavbarMenuButton,
  type NavbarMenuButtonProps,
} from "./NavbarMenuButton";
import {
  NavigationDrawer,
  type NavigationDrawerProps,
} from "./NavigationDrawer";
import { NavigationRail } from "../../../shell/components/NavigationRail";
import type {
  NavigationConfigControl,
  NavigationSection,
} from "../../../shell/NavigationShell.types";

export type NavbarShellDrawerContent =
  | ReactNode
  | ((closeDrawer: () => void) => ReactNode);

export interface NavbarShellProps extends Omit<
  NavbarProps,
  "leadingAccessory"
> {
  /**
   * Optional desktop rail config.
   * When provided, `NavbarShell` will render a persistent left rail next to `children`.
   */
  railSections?: NavigationSection[];
  railCurrentRoute?: string;
  onRailRouteSelect?: (route: string) => void;
  railCollapsed?: boolean;
  defaultRailCollapsed?: boolean;
  onRailCollapsedChange?: (collapsed: boolean) => void;
  /**
   * Whether to persist the rail collapsed state to localStorage on web.
   * Defaults to `true` when `railSections` is provided.
   */
  persistRailState?: boolean;
  /**
   * custom storage key when `persistRailState` is enabled
   */
  railStorageKey?: string;
  /** Extra controls rendered in the rail footer/config section. */
  railConfigControls?: NavigationConfigControl[];
  /** Key layout is always desktop for this component's rail. */
  railLayout?: "desktop";
  /** Show divider between rail and content. Defaults true. */
  railShowDivider?: boolean;

  drawerTitle?: NavigationDrawerProps["title"];
  drawerDescription?: NavigationDrawerProps["description"];
  drawerContent?: NavbarShellDrawerContent;
  drawerFooter?: NavigationDrawerProps["footer"];
  drawerProps?: Omit<
    NavigationDrawerProps,
    "title" | "description" | "footer" | "children" | "open" | "onOpenChange"
  >;
  defaultDrawerOpen?: boolean;
  drawerOpen?: boolean;
  onDrawerOpenChange?: (open: boolean) => void;
  hideMenuButton?: boolean;
  menuButtonProps?: Omit<NavbarMenuButtonProps, "open" | "onToggle">;
  leadingAccessory?: NavbarProps["leadingAccessory"];
}

const ShellFrame = styled(YStack, {
  name: "NavbarShellFrame",
  minHeight: "100%",
  width: "100%",
});

const ShellBody = styled(XStack, {
  name: "NavbarShellBody",
  flex: 1,
  minHeight: 0,
  width: "100%",
});

const ContentWrapper = styled(YStack, {
  name: "NavbarShellContentWrapper",
  flex: 1,
  minHeight: 0,
  width: "100%",
});

type RailPersistedState = "expanded" | "collapsed";

const readPersistedRailState = (key: string): RailPersistedState | null => {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const stored = window.localStorage.getItem(key);
    if (stored === "collapsed" || stored === "expanded") {
      return stored;
    }
    return null;
  } catch {
    return null;
  }
};

const DEFAULT_RAIL_STORAGE_KEY = "th:ui:navbarShell:railState";

export const NavbarShell = ({
  railSections,
  railCurrentRoute,
  onRailRouteSelect,
  railCollapsed,
  defaultRailCollapsed = false,
  onRailCollapsedChange,
  persistRailState,
  railStorageKey = DEFAULT_RAIL_STORAGE_KEY,
  railConfigControls,
  railLayout = "desktop",
  railShowDivider = true,
  drawerTitle = "Navigation",
  drawerDescription,
  drawerContent,
  drawerFooter,
  drawerProps,
  defaultDrawerOpen = false,
  drawerOpen,
  onDrawerOpenChange,
  hideMenuButton = false,
  menuButtonProps,
  leadingAccessory,
  children,
  ...navbarProps
}: NavbarShellProps) => {
  const [internalOpen, setInternalOpen] = useState(defaultDrawerOpen);
  const isControlled = typeof drawerOpen === "boolean";
  const resolvedOpen = isControlled ? !!drawerOpen : internalOpen;
  const shouldRenderDrawer = Boolean(drawerContent ?? drawerFooter);

  const shouldRenderRail = Boolean(railSections?.length);

  const railPersistEnabled = persistRailState ?? shouldRenderRail;
  const railIsControlled = typeof railCollapsed === "boolean";

  const [internalRailCollapsed, setInternalRailCollapsed] = useState<boolean>(
    () => {
      if (!shouldRenderRail) {
        return false;
      }
      if (railPersistEnabled) {
        const persisted = readPersistedRailState(railStorageKey);
        if (persisted) {
          return persisted === "collapsed";
        }
      }
      return defaultRailCollapsed;
    },
  );

  const resolvedRailCollapsed = railIsControlled
    ? !!railCollapsed
    : internalRailCollapsed;

  useEffect(() => {
    if (!shouldRenderRail || !railPersistEnabled) {
      return;
    }

    try {
      window.localStorage.setItem(
        railStorageKey,
        (resolvedRailCollapsed
          ? "collapsed"
          : "expanded") satisfies RailPersistedState,
      );
    } catch {
      // ignore storage failures
    }
  }, [
    railPersistEnabled,
    railStorageKey,
    resolvedRailCollapsed,
    shouldRenderRail,
  ]);

  const handleRailCollapsedChange = useCallback(
    (next: boolean) => {
      if (!railIsControlled) {
        setInternalRailCollapsed(next);
      }
      onRailCollapsedChange?.(next);
    },
    [onRailCollapsedChange, railIsControlled],
  );

  const toggleRail = useCallback(() => {
    handleRailCollapsedChange(!resolvedRailCollapsed);
  }, [handleRailCollapsedChange, resolvedRailCollapsed]);

  const handleDrawerOpenChange = useCallback(
    (next: boolean) => {
      if (!isControlled) {
        setInternalOpen(next);
      }
      onDrawerOpenChange?.(next);
    },
    [isControlled, onDrawerOpenChange],
  );

  const handleToggleDrawer = useCallback(() => {
    handleDrawerOpenChange(!resolvedOpen);
  }, [handleDrawerOpenChange, resolvedOpen]);

  const resolvedDrawerChildren = useMemo(() => {
    if (!drawerContent) {
      return null;
    }

    if (typeof drawerContent === "function") {
      return drawerContent(() => handleDrawerOpenChange(false));
    }

    return drawerContent;
  }, [drawerContent, handleDrawerOpenChange]);

  const resolvedLeadingAccessory = useMemo(() => {
    if (hideMenuButton || !shouldRenderDrawer) {
      return leadingAccessory;
    }

    if (leadingAccessory) {
      return leadingAccessory;
    }

    return (
      <NavbarMenuButton
        open={resolvedOpen}
        onToggle={handleToggleDrawer}
        {...(menuButtonProps ?? {})}
      />
    );
  }, [
    hideMenuButton,
    leadingAccessory,
    menuButtonProps,
    resolvedOpen,
    handleToggleDrawer,
    shouldRenderDrawer,
  ]);

  const resolvedRailControls = useMemo((): NavigationConfigControl[] => {
    if (!shouldRenderRail) {
      return [];
    }

    const baseControls: NavigationConfigControl[] = [
      {
        id: "toggle-rail",
        label: resolvedRailCollapsed ? "Expand" : "Collapse",
        description: resolvedRailCollapsed ? "Show labels" : "Show icons only",
        onPress: toggleRail,
      },
    ];

    return [...baseControls, ...(railConfigControls ?? [])];
  }, [railConfigControls, resolvedRailCollapsed, shouldRenderRail, toggleRail]);

  return (
    <ShellFrame>
      <Navbar leadingAccessory={resolvedLeadingAccessory} {...navbarProps}>
        {undefined}
      </Navbar>

      <ShellBody>
        {shouldRenderRail ? (
          <NavigationRail
            sections={railSections ?? []}
            currentRoute={railCurrentRoute ?? ""}
            collapsed={resolvedRailCollapsed}
            layout={railLayout}
            onSelect={(route) => onRailRouteSelect?.(route)}
            configControls={resolvedRailControls}
            showDivider={railShowDivider}
          />
        ) : null}

        <ContentWrapper>{children}</ContentWrapper>
      </ShellBody>

      {shouldRenderDrawer ? (
        <NavigationDrawer
          open={resolvedOpen}
          onOpenChange={handleDrawerOpenChange}
          title={drawerTitle}
          description={drawerDescription}
          footer={drawerFooter}
          {...(drawerProps ?? {})}
        >
          {resolvedDrawerChildren}
        </NavigationDrawer>
      ) : null}
    </ShellFrame>
  );
};

NavbarShell.displayName = "NavbarShell";
