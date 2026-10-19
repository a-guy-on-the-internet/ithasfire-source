import type { ReactNode } from "react";
import {
  Clock,
  Calendar,
  MapPin,
  ShoppingCart,
  Megaphone,
  CreditCard,
  IdCard,
  Users,
  Shield,
  Settings,
  Code,
  Tag,
  Search,
  HeartHandshake,
  ScanLine,
  Nfc,
  Store,
  ClipboardList,
  Banknote,
  Wallet,
  ScrollText,
  CalendarClock,
} from "lucide-react";

import type { NavigationSection } from "@th/ui";
import {
  ORG_ANY_ROLE,
  ORG_ADMIN_ROLES,
  ORG_NON_SCANNER,
  ORG_SCAN_ROLES,
  ORG_CONTENT_VIEW,
  ORG_FINANCE_ROLES,
  ORG_FINANCE_VIEW,
  ORG_MANAGE_VIEW,
} from "@th/types";

import {
  PAYOUTS_ROUTE_ID,
  type PayoutsSectionId,
} from "../payouts/_lib/payouts-sections";

/**
 * A Payouts rail child: an ANCHOR into the page (`payouts#ledger`), never a
 * route of its own. `active` is left unset here — AdminShell sets it from the
 * page's scroll-spy while the Payouts page is mounted and pins it to `false`
 * everywhere else, so the group stays closed off the page. Icons because the
 * 72px icon rail lists children flat, with tooltips.
 */
const payoutsChild = (
  sectionId: PayoutsSectionId,
  label: string,
  icon: ReactNode,
) => ({
  id: `payouts-${sectionId}`,
  label,
  route: `${PAYOUTS_ROUTE_ID}#${sectionId}`,
  icon,
});

// Admin navigation sections with icons for better visual recognition.
// These `route` values are STABLE route ids; `AdminShell` turns them into
// `/admin/{slug}/...` hrefs. Grouped into task-oriented sections; the shared
// NavigationRail renders each section as a collapsible group in the wide rail.
//
// The dashboard is deliberately NOT a nav item: the rail's identity block
// ("IF / Acme Org / ADMIN") is the one way home, so listing it here too put
// two links to the same href inside one `role="navigation"`. AdminShell's
// fallback route id is the explicit `ADMIN_DASHBOARD_ROUTE` constant rather
// than `sections[0].items[0].route` — do not re-add a dashboard item to
// restore that old invariant.
export const ADMIN_SECTIONS: NavigationSection[] = [
  {
    id: "programming",
    label: "admin.navGroupProgramming",
    items: [
      {
        id: "search",
        label: "admin.navSearch",
        route: "search",
        icon: <Search size={18} />,
        rbac: ORG_ANY_ROLE,
        // The mobile bottom bar flattens sections in order; without this,
        // search — the first item overall now that the dashboard and the
        // one-item Overview group are gone — would steal a primary slot from
        // Events/Places. Mobile already has the navbar search slot.
        hideInBottomBar: true,
      },
      {
        id: "events",
        label: "admin.navEvents",
        route: "events",
        icon: <Calendar size={18} />,
        rbac: ORG_NON_SCANNER,
      },
      {
        id: "places",
        label: "admin.navPlaces",
        route: "places",
        icon: <MapPin size={18} />,
        rbac: ORG_NON_SCANNER,
        // One-bottom-bar redesign: the mobile bar is Dashboard · Events ·
        // [SCAN] · Orders · More. Places (and Bookings, below) yield their
        // flatten-order slots so Orders is the third tab; both stay in the
        // rail and the More drawer.
        hideInBottomBar: true,
      },
      {
        id: "bookings",
        label: "admin.navBookings",
        route: "bookings",
        icon: <HeartHandshake size={18} />,
        rbac: ORG_NON_SCANNER,
        // See places above — keeps Orders in the bar's third slot.
        hideInBottomBar: true,
      },
      {
        // Reusable application forms (application-driven-events spec Phase 4).
        // Lives under Programming rather than Workspace because it is what an
        // organizer reaches for while setting up an open call, not a
        // configuration screen.
        id: "application-form-templates",
        label: "admin.navApplicationFormTemplates",
        route: "application-form-templates",
        icon: <ClipboardList size={18} />,
        rbac: ORG_CONTENT_VIEW,
        // Rail + More drawer only; the bottom bar's five slots are spoken for.
        hideInBottomBar: true,
      },
    ],
  },
  {
    id: "sales",
    label: "admin.navGroupSales",
    items: [
      {
        id: "orders",
        label: "admin.navOrders",
        route: "orders",
        icon: <ShoppingCart size={18} />,
        rbac: ORG_NON_SCANNER,
      },
      {
        id: "promos",
        label: "admin.navPromos",
        route: "promos",
        icon: <Tag size={18} />,
        featureFlag: "promos",
        rbac: ORG_FINANCE_VIEW,
      },
      {
        id: "memberships",
        label: "admin.navMemberships",
        route: "memberships",
        icon: <IdCard size={18} />,
        // No featureFlag, deliberately: memberships are open to ANY payee
        // (spec 2026-08-05 — the $2 Connect fee is recovered from the payout,
        // so there is no unlock gate to represent).
        rbac: ORG_FINANCE_VIEW,
        // One-bottom-bar redesign: keeps Orders in the mobile bar's third
        // slot (see places/bookings above). Rail + More drawer still list it.
        hideInBottomBar: true,
      },
      {
        // "Where is my money" AND the Stripe setup behind it: Payments merged
        // into this page (2026-10-05, owner-approved), so there is no
        // separate Payments item — `/payments` redirects here. It replaced
        // the dead Settlements tab under Orders, which read a table with no
        // writers.
        id: "payouts",
        label: "admin.navPayouts",
        route: PAYOUTS_ROUTE_ID,
        icon: <Banknote size={18} />,
        // OWNER / ADMIN / FINANCE: the roles that can read the page's main
        // content (Balance and Ledger are canFinanceOrg). Not
        // ORG_FINANCE_VIEW: its VIEWER is refused every read on the page
        // (overview, statement, Stripe status, payout terms), so the entry
        // only led to errors. EDITOR was never in the set; it can read the
        // schedule and Stripe sections by URL, and the page says why the
        // money sections are hidden. Gating the parent drops the children
        // and the bottom-bar tab with it.
        rbac: ORG_FINANCE_ROLES,
        // In the bottom bar, by ruling (10-05): it takes the slot Payments
        // had. With promos on the bar is still Events / Orders / Promos; with
        // promos off Payouts is the third tab. The bar ignores `children`, so
        // its tab goes to the page itself (the top, when arriving from
        // elsewhere).
        //
        // With children the parent row is a disclosure toggle, not a link,
        // so Balance (the top of the page) is the first child. Labels are
        // i18n keys; AdminShell translates children too.
        children: [
          payoutsChild(
            "balance",
            "admin.payoutsSectionBalance",
            <Wallet size={16} />,
          ),
          payoutsChild(
            "ledger",
            "admin.payoutsLedgerHeading",
            <ScrollText size={16} />,
          ),
          payoutsChild(
            "schedule",
            "admin.payoutsSectionSchedule",
            <CalendarClock size={16} />,
          ),
          payoutsChild(
            "stripe",
            "admin.payoutsSectionStripe",
            <CreditCard size={16} />,
          ),
        ],
      },
    ],
  },
  {
    id: "audience",
    label: "admin.navGroupAudience",
    items: [
      {
        id: "audiences",
        label: "admin.navAudiences",
        route: "audiences",
        icon: <Users size={18} />,
        featureFlag: "broadcasts",
        rbac: ORG_CONTENT_VIEW,
      },
      {
        id: "announcements",
        label: "admin.navAnnouncements",
        route: "announcements",
        icon: <Megaphone size={18} />,
        featureFlag: "broadcasts",
        rbac: ORG_CONTENT_VIEW,
      },
    ],
  },
  {
    id: "door-crew",
    label: "admin.navGroupDoorCrew",
    items: [
      {
        id: "scan",
        label: "admin.scanTicket",
        route: "scan",
        icon: <ScanLine size={18} />,
        rbac: ORG_SCAN_ROLES,
        // The mobile bar's raised center SCAN square (AdminShell's
        // bottomBarCenterAction) is this route's mobile affordance — without
        // this flag a SCANNER-role bar would show scan twice (tab + square).
        // Rail and drawer still list it.
        hideInBottomBar: true,
      },
      {
        id: "sell",
        label: "admin.navSell",
        route: "sell",
        icon: <Store size={18} />,
        // ORG_SCAN_ROLES: the same people who work a door take money at it.
        // The server enforces this again on every sell procedure.
        rbac: ORG_SCAN_ROLES,
      },
      {
        id: "scanner-setup",
        label: "admin.navScannerSetup",
        route: "scanner-setup",
        icon: <ScanLine size={18} />,
        rbac: ORG_ADMIN_ROLES,
      },
      {
        id: "card-readers",
        label: "admin.navCardReaders",
        route: "card-readers",
        icon: <Nfc size={18} />,
        rbac: ORG_ADMIN_ROLES,
      },
      {
        id: "volunteers",
        label: "admin.navVolunteers",
        route: "volunteers",
        icon: <Clock size={18} />,
        // Any org role. The page opens on the hours report, whose
        // `volunteer.hours.orgSummary` admits every member — FINANCE was
        // hidden from it for no server reason. The page's other tab, Asks
        // (`asks.listByOrg`, ORG_EDIT_ROLES), is gated inside
        // `VolunteersHome`, not here.
        rbac: ORG_ANY_ROLE,
      },
      {
        id: "volunteer-templates",
        label: "admin.navVolunteerTemplates",
        route: "volunteer-templates",
        icon: <HeartHandshake size={18} />,
        // Any org role: the page's reads (`volunteer.templates.list`, and
        // `volunteerPacks.list` behind the picker) admit every member, and
        // every write affordance is already hidden behind `canManage`.
        rbac: ORG_ANY_ROLE,
      },
    ],
  },
  {
    id: "presence",
    label: "admin.navGroupPresence",
    items: [
      {
        id: "embeds",
        label: "admin.navEmbeds",
        route: "embeds",
        icon: <Code size={18} />,
        rbac: ORG_CONTENT_VIEW,
      },
    ],
  },
  {
    id: "workspace",
    label: "admin.navGroupWorkspace",
    // Hairline rule sets the structural group off from the everyday sections.
    separatorAbove: true,
    items: [
      {
        id: "team",
        label: "admin.navTeam",
        route: "team",
        icon: <Shield size={18} />,
        rbac: ORG_MANAGE_VIEW,
      },
      {
        id: "settings",
        label: "admin.navSettings",
        route: "settings",
        icon: <Settings size={18} />,
        rbac: ORG_MANAGE_VIEW,
        // NO `children`, deliberately. Settings owns its own grouped in-page
        // nav (`@/components/settings` SettingsNav, driven by
        // `settings/_lib/org-settings-sections.tsx`), so a partial copy here
        // was a third settings rail rendering beside a complete one — a stale
        // 2-of-8 subset, and it made `/admin/x/settings` and
        // `/admin/x/settings/general` look like two different destinations for
        // one view. `AdminShell.test.tsx` pins the absence so nothing re-adds it.
        //
        // `activeMatch: "prefix"` because those eight section routes give
        // `parseNamespacedPathname` a two-segment id (`settings/contact`), which
        // the default exact match never equals — the rail entry went dark on
        // every URL but the bare one.
        activeMatch: "prefix",
      },
    ],
  },
];

// Route ids whose page has no personal-workspace version: their reads take an
// `orgId` (`volunteer.templates.list`), and a human owner has no templates, so
// the page is a dead end there. `withoutOrgOnlyItems` hides them from a
// personal rail and from the workspace-switch portable set (so switching from a
// group's page lands on the dashboard, not the dead page). A direct URL still
// renders the page's own "group-scoped" notice.
export const ORG_ONLY_ADMIN_ROUTE_IDS: ReadonlySet<string> = new Set([
  "volunteer-templates",
]);

export const withoutOrgOnlyItems = (
  sections: NavigationSection[],
): NavigationSection[] =>
  sections
    .map((section) => ({
      ...section,
      items: section.items.filter(
        (item) => !ORG_ONLY_ADMIN_ROUTE_IDS.has(item.route),
      ),
    }))
    .filter((section) => section.items.length > 0);
