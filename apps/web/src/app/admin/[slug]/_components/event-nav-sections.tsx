import {
  AlignLeft,
  Armchair,
  ClipboardList,
  Gift,
  HeartHandshake,
  IdCard,
  Inbox,
  Info,
  MessageSquare,
  Music,
  Percent,
  Settings,
  Ticket,
  Users,
} from "lucide-react";

// The canonical client-side role sets (@th/types mirrors of core/lib/rbac.ts
// — one exported constant per set, shared with EventAdminPageShell's route
// gates so the rail and the routes can never drift apart). The one exception
// is EDIT_AND_FINANCE_ROLES, derived here as ORG_EDIT_ROLES ∩
// ORG_FINANCE_ROLES: core has no single set for "both", because no one use
// case needs both; the rewards PAGE does, since it calls into each. The route
// side expresses it as `requireEdit` + `requireFinance`.
// - ORG_EDIT_ROLES: roles that can author an event (org OWNER/ADMIN/EDITOR;
//   personal workspaces carry no roles and the nav filter errs open, matching
//   "humans always can").
// - ORG_EDIT_OR_FINANCE_ROLES: attendees and the comps ledger are
//   edit-OR-finance — running the event includes reading the door list and
//   who got in free, and both are also finance data — but VIEWER and SCANNER
//   get neither. Must stay in lock-step with `searchEventAttendees` /
//   `listCompOrders`, or the rail offers a link that 403s (or, for comps,
//   hides a surface whose server contract admits FINANCE).
// - ORG_EDIT_ROLES is also the whole volunteers group: every read the four
//   volunteer pages make (`getEventForEdit`, `volunteer.roles.list`,
//   `volunteer.signups.list`/`counts`, EVENT-subject `asks.listBySubject`) is
//   ORG_EDIT_ROLES server-side, so VIEWER / FINANCE / SCANNER were offered
//   pages whose every call 403'd.
// - EDIT_AND_FINANCE_ROLES (below): volunteer rewards. Reward config and the
//   grant ledger are ORG_FINANCE_ROLES, but the page resolves the event's ask
//   and roles through the edit-gated reads above first, so it only works for
//   a role in BOTH sets.
import {
  ORG_EDIT_OR_FINANCE_ROLES,
  ORG_EDIT_ROLES,
  ORG_FINANCE_ROLES,
  type OrgRole,
} from "@th/types";
import type { NavigationItem, NavigationSection } from "@th/ui";

import type { EventBuildSectionId } from "./event-nav-context";

export type EventAdminPathContext = {
  eventId: string;
  /** First segment after the event id ("edit", "attendees", …) or null. */
  subRoute: string | null;
};

/**
 * Detects an event-context admin path: `/admin/{slug}/events/{id}[/…]`.
 * Returns null for the events list (`/events`), the create flow
 * (`/events/new` and below — FR-301 keeps the workspace rail there), and any
 * non-event admin path. Pure so it's unit-testable.
 */
export function parseEventAdminPath(
  pathname: string | null | undefined,
): EventAdminPathContext | null {
  if (!pathname) return null;
  const cleaned = pathname.split(/[?#]/, 1)[0] ?? "";
  const match = /^\/admin\/[^/]+\/events\/([^/]+)(?:\/([^/]+))?/.exec(cleaned);
  if (!match) return null;
  const eventId = match[1];
  if (!eventId || eventId === "new") return null;
  return { eventId, subRoute: match[2] ?? null };
}

/**
 * The Build anchors a COMMUNITY listing actually has a panel for.
 *
 * An ownerless listing renders Essentials, Details and Lineup in the builder
 * and nothing else: Tickets and Revenue splits presume a payee, and the
 * Settings accordion (access gate · tax/waiver/payout · sharing · scheduling)
 * is owned-event config to a row. The rail was NOT gated with the builder's own
 * sections, so all four kept deep-linking into panels that are not rendered and
 * whose writes the server refuses.
 *
 * Lineup is in because `eventHumans.*` was opened to community moderators; it
 * is the one owned-event surface a listing can use.
 */
const COMMUNITY_BUILD_SECTION_IDS: ReadonlySet<EventBuildSectionId> = new Set([
  "essentials",
  "details",
  "lineup",
]);

/**
 * The Manage items a COMMUNITY listing keeps: only suggestions, whose read
 * (`eventSuggestions.listForOwner`, event scope) and review both admit a
 * community moderator on a COMMUNITY listing. The rest go, whoever asks:
 * - comp-tickets: `comp.list` / `comp.issue` refuse a COMMUNITY event
 *   (`EVENT_NOT_TICKETED`, owner ruling 2026-10-07: no comps on one).
 * - attendees: `searchEventAttendees` is an ORDER read scoped to the URL org
 *   (`event.orgId = orgId`); an ownerless RSVP listing has no orders and no
 *   org, so the page could only ever show an empty list.
 * - volunteers: its one write (`events.updateSettings`) goes through
 *   `ensureActorCanEditEvent`, which refuses a COMMUNITY row for everyone,
 *   moderators included; its children already drop for any orgless event.
 * - feedback: `attendeeReviews.listEventFeedback` refuses an event with no
 *   owner (`NOT_RESOURCE_OWNER`) for everyone.
 */
const COMMUNITY_MANAGE_ITEM_IDS: ReadonlySet<string> = new Set(["suggestions"]);

/**
 * Roles that hold BOTH edit and finance rights (today OWNER / ADMIN). Derived
 * rather than aliased to ORG_ADMIN_ROLES: what the rewards page needs is the
 * intersection of the two sets it calls into, and deriving it keeps that true
 * if either set changes. `EventAdminPageShell` enforces the same intersection
 * by combining `requireEdit` with `requireFinance`.
 */
export const EDIT_AND_FINANCE_ROLES: readonly OrgRole[] =
  ORG_FINANCE_ROLES.filter((role) => ORG_EDIT_ROLES.includes(role));

/**
 * The rail's rights over ONE event, taken from the server's answer
 * (`getEventTitle`'s `viewerCan*`) rather than the URL workspace's role.
 *
 * Passed only for an OWNERLESS event (no `ownerOrgId`, no `ownerHumanId`: a
 * COMMUNITY listing). There the URL workspace says nothing about the event: a
 * community moderator who is also ADMIN of the URL's org would otherwise be
 * shown every item the org role admits, and the server refuses them (403).
 * When present, each item's role gate is decided here from these booleans and
 * the item carries no `rbac`, so NavigationShell's URL-role filter cannot put
 * a refused item back (nor hide an admitted one). Null/undefined keeps the
 * `rbac` annotations and today's URL-role filtering, which is also what
 * happens before `getEventTitle` answers.
 */
export type EventDerivedRights = {
  /** `viewerCanEdit` — stands in for ORG_EDIT_ROLES. */
  canEdit: boolean;
  /**
   * Stands in for ORG_EDIT_OR_FINANCE_ROLES. `getEventTitle` has no separate
   * finance answer; the caller passes `viewerCanEdit`, the same mapping
   * EventAdminPageShell already uses when it defers to the server.
   */
  canEditOrFinance: boolean;
  /** `viewerCanManagePayouts` — stands in for ORG_FINANCE_ROLES. */
  canFinance: boolean;
};

/** Which role set an item's gate follows. */
type EventAccess = "edit" | "editOrFinance" | "editAndFinance";

const ACCESS_ROLES: Record<EventAccess, readonly OrgRole[]> = {
  edit: ORG_EDIT_ROLES,
  editOrFinance: ORG_EDIT_OR_FINANCE_ROLES,
  editAndFinance: EDIT_AND_FINANCE_ROLES,
};

export type BuildEventNavSectionsArgs = {
  eventId: string;
  /**
   * Event status when known (edit-or-finance roles — the status derivation
   * in AdminShell is gated to the roles whose rail items consume it).
   * Undefined disables the post-publish surfaces, matching the old tab bar
   * which omitted them until the status loaded.
   */
  status?: string;
  /** Scroll-spy result while the edit surface is mounted. */
  activeSection: EventBuildSectionId | null;
  /** True when the current route IS the edit surface. */
  onEditSurface: boolean;
  /**
   * `Event.stewardship` — from the mounted edit surface on `/edit`, from
   * `getEventTitle` on the ops routes. `null`/`undefined` while unknown keeps
   * today's full rail: the ticketed shape stays the default.
   */
  stewardship?: string | null;
  /** See {@link EventDerivedRights}. Only passed for an ownerless event. */
  eventRights?: EventDerivedRights | null;
  /**
   * Whether the event belongs to an organisation, once `getEventTitle` has
   * answered. Every volunteer roles / signups / badges / rewards read throws
   * `EVENT_NOT_ORG_OWNED` for a person's event, whoever asks, owner
   * included, so `false` drops those children. An ownerless COMMUNITY
   * listing reaches `false` too (`getEventTitle` answers a community
   * moderator with `ownerOrgId: null`), and the server refuses it the same.
   * Unknown (`undefined`) keeps them, like every other rail gate that errs
   * open while loading.
   */
  orgOwned?: boolean;
  /**
   * Show the Seat prices page. The rail has no cheap answer to "does this
   * event have seats", so the caller passes the gate the builder's Seating
   * map button uses (`seatingLayouts`); on an event without seats the page
   * says so and links back to the editor. Off by default.
   */
  seatPricesEnabled?: boolean;
  t: (key: string) => unknown;
};

/**
 * Event-context sections for the admin rail (FR-202): a Build group of
 * scroll anchors into the edit surface and a Manage group of the real ops
 * routes. Item `route` values are stable ids that AdminShell namespaces
 * under `/admin/{slug}`.
 *
 * RBAC parity with the server-side read contracts (FR-203, then Phase 10):
 * - Build group + suggestions/feedback: edit roles only (personal
 *   workspaces err open — humans always edit their own events).
 * - attendees + comp-tickets: edit OR finance, matching
 *   `searchEventAttendees` / `listCompOrders`. Comps was edit-only while the
 *   page was nothing but the admin-only issue form; as a ledger its read is
 *   FINANCE data too.
 * - volunteers (setup + roles / signups / badges): edit roles only, matching
 *   the ORG_EDIT_ROLES gate on every read those pages make. Rewards: edit AND
 *   finance (`EDIT_AND_FINANCE_ROLES`).
 * - events without an org (`orgOwned: false`): the volunteers item keeps only
 *   its setup page (the one volunteer surface the server serves on a personal
 *   event); the four children go, because the server refuses them for
 *   everyone.
 * - comps/suggestions: disabled with a "post-pub" note until PUBLISHED.
 *
 * Stewardship parity (2026-09-15): a COMMUNITY listing keeps only the Build
 * anchors whose panel the builder actually renders — see
 * `COMMUNITY_BUILD_SECTION_IDS`. Since 2026-10-07 it also keeps only the
 * Manage items whose server reads serve a COMMUNITY listing at all — see
 * `COMMUNITY_MANAGE_ITEM_IDS`.
 *
 * Ownerless rights (2026-10-07): with `eventRights`, the role gates are
 * decided from the server's answer about THIS event, not the URL workspace's
 * role — see {@link EventDerivedRights}.
 */
export function buildEventNavSections({
  eventId,
  status,
  activeSection,
  onEditSurface,
  stewardship,
  eventRights,
  orgOwned,
  seatPricesEnabled = false,
  t,
}: BuildEventNavSectionsArgs): NavigationSection[] {
  const base = `events/${eventId}`;
  const published = status === "PUBLISHED";
  const postPubNote = published ? undefined : String(t("admin.evNavPostPub"));
  const isCommunity = stewardship === "COMMUNITY";

  // Without event-derived rights: annotate the URL-role set and let
  // NavigationShell filter (today's path). With them: decide here and leave
  // no `rbac` behind for the URL role to act on.
  const permits = (access: EventAccess): boolean => {
    if (!eventRights) return true;
    switch (access) {
      case "edit":
        return eventRights.canEdit;
      case "editOrFinance":
        return eventRights.canEditOrFinance;
      case "editAndFinance":
        return eventRights.canEdit && eventRights.canFinance;
    }
  };
  const gate = (access: EventAccess): { rbac?: readonly OrgRole[] } =>
    eventRights ? {} : { rbac: ACCESS_ROLES[access] };

  const buildItem = (
    id: EventBuildSectionId,
    labelKey: string,
    icon: React.ReactNode,
  ) => ({
    id: `build-${id}`,
    label: String(t(labelKey)),
    // Deep link into the edit surface; AdminShell intercepts this into an
    // in-page scroll when the edit surface is already mounted.
    route: `${base}/edit?section=${id}`,
    icon,
    // Controlled active state (scroll-spy) — route matching never applies to
    // anchor items (all six share the edit pathname).
    active: onEditSurface && activeSection === id,
    // Build anchors must not steal mobile bottom-bar slots (FR-206); the
    // drawer still lists them.
    hideInBottomBar: true,
  });

  // Declared in visual order and then filtered, so the community rail can
  // never drift out of the ticketed rail's order.
  const buildItems = [
    buildItem("essentials", "admin.evNavEssentials", <Info size={18} />),
    buildItem("details", "admin.evNavDetails", <AlignLeft size={18} />),
    buildItem("tickets", "admin.evNavTickets", <Ticket size={18} />),
    buildItem("lineup", "admin.evNavLineup", <Music size={18} />),
    buildItem("splits", "admin.evNavSplits", <Percent size={18} />),
    buildItem("settings", "admin.evNavSettings", <Settings size={18} />),
  ].filter(
    (item) =>
      !isCommunity ||
      COMMUNITY_BUILD_SECTION_IDS.has(
        item.id.slice("build-".length) as EventBuildSectionId,
      ),
  );

  // Each Manage item paired with the role set its route enforces, filtered
  // once below (stewardship, then event-derived rights).
  const manageItems: Array<{ access: EventAccess; item: NavigationItem }> = [
    {
      access: "editOrFinance",
      item: {
        id: "attendees",
        label: String(t("pageActions.attendees")),
        route: `${base}/attendees`,
        icon: <Users size={18} />,
        ...gate("editOrFinance"),
      },
    },
    {
      access: "edit",
      item: {
        id: "volunteers",
        label: String(t("pageActions.volunteers")),
        route: `${base}/volunteers`,
        icon: <HeartHandshake size={18} />,
        // The item's gate covers its children too (a hidden item drops
        // them), so roles / signups / badges need no rbac of their own.
        ...gate("edit"),
        // Roles / signups / rewards were tab panels behind the single
        // `/volunteers` URL; they are routes now, so the rail lists them as
        // children (the same nesting Org Settings already uses). Rewards
        // carries the narrower gate its route enforces — the rail must not
        // offer a link that redirects straight back out.
        children:
          orgOwned === false
            ? undefined
            : [
                {
                  id: "volunteers-roles",
                  label: String(t("admin.volunteerEventTabRoles")),
                  route: `${base}/volunteers/roles`,
                  icon: <ClipboardList size={16} />,
                },
                {
                  id: "volunteers-signups",
                  label: String(t("admin.volunteerEventTabSignups")),
                  route: `${base}/volunteers/signups`,
                  icon: <Users size={16} />,
                },
                {
                  // Printable badge sheet. It lived only as a secondary action on
                  // the signups screen, which put a whole document two levels deep
                  // behind a tab nobody had a reason to open — it was not findable.
                  // Badges follow from approved signups, so the rail lists it right
                  // after them.
                  id: "volunteers-badges",
                  label: String(t("admin.volunteerEventTabBadges")),
                  route: `${base}/volunteers/badges/print`,
                  icon: <IdCard size={16} />,
                },
                ...(permits("editAndFinance")
                  ? [
                      {
                        id: "volunteers-rewards",
                        label: String(t("admin.volunteerEventTabRewards")),
                        route: `${base}/volunteers/rewards`,
                        icon: <Gift size={16} />,
                        ...gate("editAndFinance"),
                      },
                    ]
                  : []),
              ],
      },
    },
    ...(seatPricesEnabled
      ? [
          {
            // Edit only: `events.setSeatPriceOverrides` and its read admit
            // edit roles. Stays open after tickets sell.
            access: "edit" as const,
            item: {
              id: "seat-prices",
              label: String(t("admin.seatPricesTitle")),
              route: `${base}/seat-prices`,
              icon: <Armchair size={18} />,
              ...gate("edit"),
            },
          },
        ]
      : []),
    {
      access: "editOrFinance",
      item: {
        id: "comp-tickets",
        label: String(t("pageActions.compTickets")),
        route: `${base}/comp-tickets`,
        icon: <Gift size={18} />,
        ...gate("editOrFinance"),
        disabled: !published,
        note: postPubNote,
      },
    },
    {
      access: "edit",
      item: {
        id: "suggestions",
        label: String(t("admin.ebTabSuggestions")),
        route: `${base}/suggestions`,
        icon: <Inbox size={18} />,
        ...gate("edit"),
        disabled: !published,
        note: postPubNote,
      },
    },
    {
      access: "edit",
      item: {
        id: "feedback",
        label: String(t("admin.ebTabFeedback")),
        route: `${base}/feedback`,
        icon: <MessageSquare size={18} />,
        ...gate("edit"),
      },
    },
  ];

  const sections: NavigationSection[] = [];
  if (permits("edit") && buildItems.length > 0) {
    sections.push({
      id: "event-build",
      label: String(t("admin.evNavGroupBuild")),
      ...gate("edit"),
      items: buildItems,
    });
  }
  const visibleManageItems = manageItems
    .filter(
      ({ access, item }) =>
        (!isCommunity || COMMUNITY_MANAGE_ITEM_IDS.has(item.id)) &&
        permits(access),
    )
    .map(({ item }) => item);
  if (visibleManageItems.length > 0) {
    sections.push({
      id: "event-manage",
      label: String(t("admin.evNavGroupManage")),
      items: visibleManageItems,
    });
  }
  return sections;
}
