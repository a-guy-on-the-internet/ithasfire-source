import type { ReactNode } from "react";

import type { IthasFireThemeName } from "../tamagui";
import type {
  AccountContext,
  AlertSummary,
  NavigationBottomBarCenterAction,
  NavigationItem,
  NavigationRailBack,
  NavigationSection,
  NavigationRouteSource,
  NavigationShellLayout,
  QuickActionConfig,
  RouteMeta,
} from "../types/navigation";

export type {
  AccountContext,
  AlertSummary,
  NavigationBottomBarCenterAction,
  NavigationItem,
  NavigationRailBack,
  NavigationSection,
  NavigationRouteSource,
  NavigationShellLayout,
  QuickActionConfig,
  RouteMeta,
} from "../types/navigation";

export interface NavigationShellAnalyticsConfig {
  onView?: (payload: {
    layout: NavigationShellLayout;
    contextType: AccountContext["type"];
    sectionCount: number;
  }) => void;
  onRouteSelect?: (payload: { routeId: string; meta: RouteMeta }) => void;
  onContextSwitch?: (payload: {
    fromContextId: string;
    toContextId: string;
    latencyMs?: number;
  }) => void;
  onQuickAction?: (payload: { actionId: string }) => void;
  onRailToggle?: (payload: { state: "expanded" | "collapsed" }) => void;
}

export interface NavigationConfigControl {
  id: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  active?: boolean;
  disabled?: boolean;
  onPress: () => void;
}

export interface NavigationShellContextValue {
  layout: NavigationShellLayout;
  railState: "expanded" | "collapsed";
  setRailState: (state: "expanded" | "collapsed") => void;
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  accountContext: AccountContext;
  appearance: IthasFireThemeName;
}

export interface NavigationShellProps {
  navSections: NavigationSection[];
  currentRoute: string;
  accountContext: AccountContext;
  onRouteSelect: (routeId: string, meta?: RouteMeta) => void;
  availableContexts?: AccountContext[];
  onContextSwitch?: (contextId: string) => Promise<void> | void;
  onCreateOrganization?: () => void;
  quickActions?: QuickActionConfig[];
  alerts?: AlertSummary[];
  onAlertSelect?: () => void;
  secondaryNav?: ReactNode;
  onOpenCommandPalette?: () => void;
  onInviteTeammate?: () => void;
  railBehavior?: "auto" | "expanded" | "collapsed";
  drawerBreakpoint?: number;
  /**
   * Environment chip rendered beside the brand in the top bar. NOTE: it
   * rides the brand stack, which the MOBILE top bar does not render (the
   * workspace switcher is the identity anchor there) — so this badge only
   * appears at compact/desktop. No consumer passes it on a mobile-facing
   * surface today (stories only); build it a mobile home before relying on
   * it there.
   */
  environmentBadge?: "staging" | "development" | null;
  analytics?: NavigationShellAnalyticsConfig;
  loading?: boolean;
  testIdBase?: string;
  brand?: ReactNode;
  onBrandPress?: () => void;
  onReturnToConsumer?: () => void;
  returnToConsumerLabel?: string;
  returnToConsumerDescription?: string;
  children?: ReactNode;
  emptyState?: ReactNode;
  quickActionFooter?: ReactNode;
  enabledFeatureFlags?: string[];
  forceLayout?: NavigationShellLayout;
  skipToContentLabel?: string;
  configControls?: NavigationConfigControl[];
  /**
   * Opt-in: section headings in the wide nav rail (and drawer) become toggle
   * buttons that show/hide the section's items. The section containing the
   * active route is locked open. Default off.
   */
  collapsibleSections?: boolean;
  /**
   * Scope for persisting closed-section ids (localStorage key
   * `th-nav-sections:{key}`), e.g. a workspace slug. Omit for in-memory only.
   */
  sectionCollapsePersistKey?: string;
  /**
   * Opt-in: show a workspace identity block (square initials avatar, label,
   * role) at the top of the nav rail, derived from `accountContext`.
   */
  showRailIdentity?: boolean;
  /**
   * Makes the rail identity block a link to the workspace's own home. Renders
   * a real `<a>` on web so right-click / middle-click / new-tab work.
   * Requires `showRailIdentity`.
   */
  railIdentityHref?: string;
  /**
   * Activate handler for the rail identity block (client-side navigation).
   * On mobile this closes the drawer, matching a normal rail route select.
   * Requires `showRailIdentity`.
   */
  onRailIdentityPress?: () => void;
  /**
   * Accessible name for the interactive rail identity block — the consumer
   * owns it so it stays i18n-correct (e.g. "Go to Acme Org dashboard").
   */
  railIdentityLabel?: string;
  /**
   * Back affordance rendered above the rail sections (and in the mobile
   * drawer) when the rail shows a nested context — e.g. "← All events"
   * inside an event. Omit for the normal workspace rail.
   */
  railBack?: NavigationRailBack;
  /**
   * Context header slotted between the back row and the sections (wide rail
   * + drawer) — e.g. the event title and status chip.
   */
  railContextHeader?: ReactNode;
  contentVariant?: "plain" | "panel" | "edge";
  contentMaxWidth?: number;
  /**
   * Raised action slot rendered mid-row in the MOBILE bottom bar (see
   * {@link NavigationBottomBarCenterAction}). Ignored on desktop/compact
   * layouts. Default off — omitting it keeps today's bar exactly.
   */
  bottomBarCenterAction?: NavigationBottomBarCenterAction;
  /** Max width for the top-bar navbar content. When set, the navbar items are centered within this width. */
  navbarContentMaxWidth?: number;
  /**
   * Extra content rendered inside the top-bar trailing controls. Pass a
   * function to vary the content by resolved layout — the MOBILE top bar is
   * deliberately sparse (workspace switcher + notifications only), so
   * consumers move secondary controls (theme, language, …) into the drawer
   * via `quickActionFooter` and return just the notifications affordance for
   * `"mobile"`.
   */
  navbarTrailingSlot?:
    | ReactNode
    | ((layout: NavigationShellLayout) => ReactNode);
  /** Search accessory rendered in the center search slot of the top-bar Navbar. */
  navbarSearchSlot?: ReactNode;
  /**
   * Build an href for a workspace context switch. When provided, each
   * workspace item in the switcher renders as a proper `<a>` link so
   * users can right-click → "Open in new tab" and screen readers
   * announce them correctly.
   */
  contextHrefBuilder?: (contextId: string) => string;
}
