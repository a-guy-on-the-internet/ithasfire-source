// Use import-then-export (direct binding) instead of `export { X } from`
// (indirect binding) so that `export *` in parent barrels can always resolve
// names synchronously — avoids "Indirectly exported binding name … is not found"
// in Vite's ESM dev server.
import { NavigationShell } from "./NavigationShell";
export { NavigationShell };
export type { NavigationShellProps } from "./NavigationShell.types";

import {
  NavigationShellProvider,
  useNavigationShell,
  NavigationShellContext,
} from "./NavigationShellContext";
export { NavigationShellProvider, useNavigationShell, NavigationShellContext };
export type { NavigationShellContextValue } from "./NavigationShell.types";

import { AdminLedgerShell } from "./AdminLedgerShell";
export { AdminLedgerShell };
export type { AdminLedgerShellProps } from "./AdminLedgerShell.types";

import { ADMIN_BOTTOM_NAV_HEIGHT_VAR } from "./utils/admin-bottom-nav-height";
export { ADMIN_BOTTOM_NAV_HEIGHT_VAR };

import {
  LedgerTopbar,
  LedgerSectionTabs,
  LedgerContextStrip,
  LEDGER_TOPBAR_HEIGHT,
  LEDGER_SECTION_TABS_HEIGHT,
  LEDGER_CONTEXT_STRIP_MIN_HEIGHT,
} from "./ledger";
export {
  LedgerTopbar,
  LedgerSectionTabs,
  LedgerContextStrip,
  LEDGER_TOPBAR_HEIGHT,
  LEDGER_SECTION_TABS_HEIGHT,
  LEDGER_CONTEXT_STRIP_MIN_HEIGHT,
};
export type {
  LedgerTopbarProps,
  LedgerSectionTabsProps,
  LedgerSectionTabItem,
  LedgerContextStripProps,
} from "./ledger";

import { NavigationRail } from "./components/NavigationRail";
export { NavigationRail };
export type { NavigationRailProps } from "./components/NavigationRail";

import { NavigationTopBar } from "./components/NavigationTopBar";
export { NavigationTopBar };
export type { NavigationTopBarProps } from "./components/NavigationTopBar";

import { NavigationShellDrawer } from "./components/NavigationDrawer";
export { NavigationShellDrawer };
export type { NavigationShellDrawerProps } from "./components/NavigationDrawer";

import { NavigationBottomBar } from "../tamagui/components";
export { NavigationBottomBar };
export type { NavigationBottomBarProps } from "../tamagui/components";

export type {
  AccountContext,
  NavigationSection,
  NavigationItem,
  NavigationBottomBarCenterAction,
  NavigationRailBack,
  NavigationShellLayout,
  NavigationShellAnalyticsConfig,
  NavigationRouteSource,
  QuickActionConfig,
  AlertSummary,
  RouteMeta,
  NavigationConfigControl,
} from "./NavigationShell.types";

import { filterSections } from "./NavigationShell.hooks";
export { filterSections };

export {
  isApplePlatform,
  isCommandPaletteChord,
} from "./utils/command-palette-chord";
export type { ChordKeyEvent } from "./utils/command-palette-chord";

import {
  namespaceNavSections,
  parseNamespacedPathname,
  toNamespacedHref,
} from "./utils/route-namespacing";
export { namespaceNavSections, parseNamespacedPathname, toNamespacedHref };

export type {
  RouteNamespacingConfig,
  NamespacedRouteMapping,
} from "./utils/route-namespacing";
