import type { OrgRole, StaffRole } from "@th/types";
import type { ReactNode } from "react";

/** Roles that can gate a nav item: org roles OR platform staff roles. */
export type NavRole = OrgRole | StaffRole;

export type NavigationShellLayout = "desktop" | "compact" | "mobile";

export type NavigationRouteSource =
  | "rail"
  | "drawer"
  | "secondary"
  | "quick-action"
  | "context-switcher"
  | "mobile-bottom";

export interface RouteMeta {
  source: NavigationRouteSource;
  sectionId?: string;
  parentId?: string;
}

export interface NavigationItem {
  id: string;
  label: string;
  route: string;
  icon?: ReactNode;
  badgeCount?: number;
  tone?: "default" | "danger" | "success";
  disabled?: boolean;
  /**
   * Externally-controlled active state. When set (true OR false) it overrides
   * the route-derived match entirely — used for anchor-style items (e.g. the
   * event rail's Build sections, driven by scroll-spy) whose `route` is a
   * deep link that never equals the current pathname.
   */
  active?: boolean;
  /**
   * How the route-derived active match is computed. Ignored when `active` is
   * set explicitly.
   *
   * - `"exact"` (default) — the item lights up only on its own URL. Correct for
   *   leaf routes, and the historical behaviour for every item.
   * - `"prefix"` — the item also lights up on its SUB-routes. Opt in for a
   *   destination that owns a route family with its own in-page navigation,
   *   e.g. `/admin/:slug/settings`, whose eight per-section routes would
   *   otherwise leave the rail's Settings entry unlit on seven of them.
   *
   * Deliberately opt-in rather than a global behaviour change: making prefix
   * matching universal would also light up "Events" while deep inside the event
   * builder, which the event-context rail already handles its own way.
   */
  activeMatch?: "exact" | "prefix";
  /**
   * Small trailing annotation rendered after the label in the wide rail
   * (mono, muted micro-type) — e.g. "post-pub" on items disabled until an
   * event is published. Not shown in the 72px icon rail or bottom bar.
   */
  note?: string;
  featureFlag?: string;
  /**
   * Roles permitted to see this item. Accepts org roles AND platform staff
   * roles (set-intersection against the actor's `AccountContext.roles`).
   * Empty/undefined → visible to all.
   */
  rbac?: readonly NavRole[];
  /**
   * Exclude this item from the mobile bottom bar (which flattens sections in
   * order and only surfaces the first few). Use for routes that already have a
   * dedicated affordance on mobile (e.g. search lives in the navbar slot).
   * The item still renders in the rail and drawer.
   */
  hideInBottomBar?: boolean;
  children?: NavigationItem[];
}

export interface NavigationSection {
  id: string;
  label: string;
  icon?: ReactNode;
  items: NavigationItem[];
  featureFlag?: string;
  /** See {@link NavigationItem.rbac}. */
  rbac?: readonly NavRole[];
  /**
   * Render a hairline rule above this section in the wide nav rail — use to
   * set off a trailing structural group (e.g. Workspace/Settings) from the
   * everyday sections. The 72px icon rail separates every group regardless.
   */
  separatorAbove?: boolean;
}

/**
 * Raised action slot rendered in the middle of the mobile bottom bar (the
 * admin "one bottom bar" redesign's SCAN square). It is an ACTION, not a tab:
 * it never joins the swipe order and never shows the active-tab rule, but it
 * does darken to its press rung while `currentRoute === id` so the bar still
 * reads correctly on the destination route. Optional and default-off — shells
 * that don't pass one render exactly the classic tab row.
 */
export interface NavigationBottomBarCenterAction {
  /** Stable route id (e.g. `"scan"`) compared against `currentRoute`. */
  id: string;
  /** Short label rendered uppercase inside the square — keep it to one word. */
  label: string;
  /** Lucide icon element; the bar re-colors it to the on-accent foreground. */
  icon: ReactNode;
  onPress: () => void;
  testId?: string;
  /**
   * Accessible name, when the visible `label` is not distinguishing enough.
   *
   * The centre square MIRRORS a control that already exists on the page, so
   * its one-word label can collide with that control's — a screen reader
   * listing the page then hears the same name twice. Pass the same qualified
   * string the source control uses.
   *
   * MUST still contain `label` verbatim: WCAG 2.5.3 Label in Name (Level A)
   * means a speech-input user saying the words they can see has to match.
   * Omitted ⇒ the accessible name stays `label`.
   */
  ariaLabel?: string;
}

/**
 * Back affordance for a rail showing a nested context (e.g. an event):
 * rendered above the sections as "← {label}".
 */
export interface NavigationRailBack {
  /** Visible label, e.g. "All events" (the arrow glyph is added by the rail). */
  label: string;
  /** Concrete href so web renders a real <a> (right-click / new-tab). */
  href?: string;
  onPress: () => void;
}

export interface AccountContext {
  id: string;
  label: string;
  type: "personal" | "org" | "consumer";
  avatarUrl?: string;
  /** Display role (single, for UI labelling). */
  role?: OrgRole;
  /**
   * Explicit display label for the actor's role, overriding whatever `role` /
   * `type` would otherwise produce. Exists for consoles whose actor is NOT an
   * org member: the platform staff console has to declare `type: "org"` +
   * `role: "ADMIN"` for layout reasons, which made it greet every staff member
   * as "Group Admin". Pass e.g. "Platform Admin" / "Support" here instead.
   *
   * Deliberately additive rather than a new `type` member — the `type` union
   * has consumers across web and mobile. Omit it and behaviour is unchanged.
   */
  roleLabel?: string;
  /**
   * The actor's effective role set used for nav filtering. Holds org roles
   * (e.g. `["EDITOR"]`) or platform staff roles (e.g. `["SUPPORT"]`). When
   * unknown/empty, filtering errs OPEN (see NavigationShell.hooks).
   */
  roles?: readonly NavRole[];
  defaultRoute?: string;
}

export interface QuickActionConfig {
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void | Promise<void>;
  /** See {@link NavigationItem.rbac}. */
  rbac?: readonly NavRole[];
  disabled?: boolean;
}

export interface AlertSummary {
  id: string;
  label: string;
  count?: number;
  tone?: "neutral" | "warning" | "danger";
  onSelect?: () => void;
}
