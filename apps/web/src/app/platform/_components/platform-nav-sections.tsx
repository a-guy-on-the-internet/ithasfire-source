import {
  MapPin,
  ShoppingCart,
  Ticket,
  PackageOpen,
  Palette,
  Banknote,
  HandCoins,
  Settings,
  Percent,
  TicketPercent,
  Timer,
  Gauge,
  BadgePercent,
  FolderTree,
  ToggleLeft,
  Users,
  ShieldCheck,
  ScrollText,
  MessageSquareWarning,
  Star,
  AlertTriangle,
  MessageCircle,
  Layers,
  HeartHandshake,
  Flag,
  Gavel,
  ShieldAlert,
  ScanEye,
  ClipboardList,
  UserCheck,
  MailX,
  CalendarRange,
} from "lucide-react";

import type { NavigationSection } from "@th/ui";
import { STAFF_ALL, STAFF_TECH, STAFF_CUSTOMER } from "@th/types";

/**
 * Platform console navigation, grouped by TASK KIND rather than one flat
 * 27-item list. Mirrors the grouped-rail convention in
 * `admin/[slug]/_components/admin-nav-sections.tsx`: the shared
 * NavigationRail renders each section as a collapsible group in the wide
 * rail and separates every group in the 72px icon rail.
 *
 * The `overview` dashboard is deliberately NOT a nav item — the rail's
 * identity block (and, on mobile, the drawer's account header) is the one way
 * home. Listing it here too put two links to the same href inside a single
 * `role="navigation"`. `PlatformShell`'s fallback route id is the explicit
 * `PLATFORM_OVERVIEW_ROUTE` constant rather than `sections[0].items[0].route`
 * — do not re-add an overview item to restore that old coupling.
 *
 * Every `rbac` value below is documented against the specific server-side
 * guard it mirrors. They are deliberately NOT tidied into `STAFF_*` presets
 * or widened: an entry shown to a role the server rejects is a nav item that
 * only ever reaches a 403. `claims` mirrors `CLAIM_DESK_ROLES` in core
 * (`use-cases/resale/claim-desk-staff.ts`) — see its own comment. Every id → rbac pair is
 * SNAPSHOT-PINNED in `__tests__/platform-nav-sections.test.tsx`: widening one,
 * or deleting it (absent `rbac` means visible-to-everyone in
 * `filterSections`), fails there rather than shipping a rail entry whose every
 * procedure 403s.
 *
 * WHY THIS IS A SIBLING MODULE AND NOT A CONST IN `../layout.tsx`: Next's
 * generated route types run `checkFields<Diff<{ default: Function; … }, TEntry>>`
 * over a layout's module exports (`next/dist/build/webpack/plugins/next-types-plugin`),
 * so ANY extra named export from `layout.tsx` is a type error at build time —
 * and the nav has to be importable to be testable. Same shape as
 * `admin/[slug]/_components/admin-nav-sections.tsx`.
 */
export const PLATFORM_SECTIONS: NavigationSection[] = [
  {
    // Headings are real i18n keys. They live in the APP catalogs
    // (`apps/web/src/i18n/messages/{en,es}.ts`), which `locale-provider.tsx`
    // deep-merges OVER `@th/locale`'s package catalogs with app keys winning —
    // the same place the admin rail's `navGroup*` keys live. The package
    // catalogs are not touched.
    id: "queues",
    label: "admin.navGroupQueues",
    items: [
      {
        // Entity-report intake queue (spec v1.1: PLATFORM trust & safety,
        // not community moderation). STAFF_CUSTOMER = ADMIN/SUPPORT/DEVELOPER
        // — the exact set the entityReports.listForModeration/review authz
        // enforces server-side; REVIEWER shown this entry would only reach a
        // 403. Flag icon matches the hero "Report" action that files these.
        id: "reports",
        label: "admin.navPlatformReports",
        route: "reports",
        icon: <Flag size={18} />,
        rbac: STAFF_CUSTOMER,
      },
      {
        // Invite complaint auto-pause queue (W4). rbac is the exact
        // INVITE_PAUSE_VIEW_ROLES set `platform.invitePauses.list` enforces
        // (ADMIN/REVIEWER/SUPPORT; deciding is ADMIN/REVIEWER). No STAFF_*
        // preset matches: STAFF_CUSTOMER drops REVIEWER and adds DEVELOPER.
        // A desk decision with a written note: out of the bottom bar.
        id: "invite-pauses",
        label: "admin.navPlatformInvitePauses",
        route: "invite-pauses",
        icon: <MailX size={18} />,
        rbac: ["ADMIN", "REVIEWER", "SUPPORT"],
        hideInBottomBar: true,
      },
      {
        // rbac is the LITERAL ["ADMIN", "DEVELOPER"] set, deliberately not the
        // STAFF_TECH preset that happens to equal it today: this must track
        // `PLATFORM_OPS_ROLES` in the moderation router, which is the gate the
        // `moderation.queueSnapshot` / `moderation.queueSignal` procedures
        // enforce server-side. A REVIEWER or SUPPORT member shown this entry
        // would only reach a 403 — and if the shared preset is ever widened,
        // this entry must NOT follow it.
        id: "image-moderation",
        label: "admin.navPlatformImageModeration",
        route: "image-moderation",
        icon: <ScanEye size={18} />,
        rbac: ["ADMIN", "DEVELOPER"],
        // Judging a flagged image is a desktop workflow — you cannot do it on
        // a phone. It yields its bottom-bar slot so the bar reads as triage
        // (Reports · Reviews · Support) rather than three judgement queues.
        hideInBottomBar: true,
      },
      {
        id: "reviews",
        label: "admin.navPlatformReviews",
        route: "reviews",
        icon: <MessageSquareWarning size={18} />,
        rbac: STAFF_ALL,
      },
      {
        // Mirrors the server-side guard: `listClaims` / `getClaim` /
        // `reviewClaim` gate on `CLAIM_DESK_ROLES` = ["ADMIN", "SUPPORT"]
        // (`packages/core/src/use-cases/resale/claim-desk-staff.ts`, enforced
        // inside each use case since 2026-09-15; before that `claims.list` was
        // a bare `authedProcedure` readable by any signed-in user). Keep this
        // list and that constant reconciled.
        //
        // The page itself (`platform/claims/page.tsx`) has shipped without any
        // nav entry: staff reached it by typing the URL. The coverage test in
        // `__tests__/platform-nav-sections.test.tsx` now fails on that class of
        // omission.
        id: "claims",
        label: "admin.navPlatformClaims",
        route: "claims",
        icon: <Gavel size={18} />,
        rbac: ["ADMIN", "SUPPORT"],
        // Resolving a resale claim means reading evidence and moving money —
        // a desk workflow. See image-moderation above.
        hideInBottomBar: true,
      },
      {
        // rbac is the exact ["ADMIN", "SUPPORT"] set the desk's READ use
        // cases enforce (`DISPUTE_DESK_READ_ROLES` in
        // core/use-cases/disputes/evidence/staff.ts); writes are ADMIN-only
        // and the page hides them for SUPPORT. No STAFF_* preset matches —
        // STAFF_CUSTOMER adds DEVELOPER, who would only reach a 403.
        id: "disputes",
        label: "admin.navPlatformDisputes",
        route: "disputes",
        icon: <ShieldAlert size={18} />,
        rbac: ["ADMIN", "SUPPORT"],
        // Same desk-workflow reasoning as claims above.
        hideInBottomBar: true,
      },
      {
        id: "support",
        label: "admin.navPlatformSupport",
        route: "support",
        icon: <MessageCircle size={18} />,
        rbac: STAFF_ALL,
      },
      {
        id: "webhook-dlq",
        label: "admin.navPlatformWebhookDlq",
        route: "webhook-dlq",
        icon: <AlertTriangle size={18} />,
        rbac: STAFF_TECH,
        // Dead-letter replay is an on-call console, not a thumb-reach tab —
        // it yields its bottom-bar slot to the human-facing queues above.
        // Still in the rail and the More drawer.
        hideInBottomBar: true,
      },
      // ── Cross-area queues (/moderate/**, NOT under /platform) ───────────
      // The two entries below are the first nav items in this console whose
      // gate lives OUTSIDE `/platform`: `/moderate/**` has its own edge gate
      // (`middleware/staff-route-gate.ts`) and server layout, both admitting
      // COMMUNITY_MODERATOR *or* platform ADMIN via `checkModeratorAccess`.
      // ADMIN is therefore the only platform staff role that gets in — the
      // other three would reach `/access-denied`, so `rbac: ["ADMIN"]` is not
      // a preset that happens to be narrow, it is the whole intersection.
      // They shipped reachable only by typing the URL.
      //
      // Their `route` is an ABSOLUTE path, which `namespaceNavSections` now
      // passes through verbatim (it used to re-base it to
      // `/platform/moderate/…`, a 404) and every shell's `onRouteSelect`
      // already forwards unchanged. Consequence worth knowing: `/moderate/**`
      // renders `ModerateShell`, not this rail, so these entries never light
      // up as the active route — the destination's own tab strip takes over.
      //
      // `/moderate/images` is DELIBERATELY not listed. It is the human review
      // queue and `/platform/image-moderation` above is the pipeline ops
      // dashboard; two near-identical rows two apart in the same group would
      // invite mis-clicks. It stays linked from the body of the ops dashboard.
      {
        // ClipboardList matches this destination's own tab glyph in
        // `moderate/_components/ModerateShell.tsx`, so the row and the page it
        // lands on read as the same place. "Edit suggestions", not
        // "Suggestions": the admin event rail already has a per-event
        // Suggestions entry, and these are platform-wide listing edits.
        id: "edit-suggestions",
        label: "admin.navPlatformEditSuggestions",
        route: "/moderate/suggestions",
        icon: <ClipboardList size={18} />,
        rbac: ["ADMIN"],
        // Judging a proposed listing edit means diffing prose against a live
        // listing — a desk workflow, same reasoning as claims/disputes above.
        hideInBottomBar: true,
      },
      {
        // UserCheck likewise mirrors the Applications tab in ModerateShell.
        id: "moderator-applications",
        label: "admin.navPlatformModeratorApplications",
        route: "/moderate/applications",
        icon: <UserCheck size={18} />,
        // ADMIN-only twice over: the moderate gate admits only ADMIN of the
        // staff roles, and `moderatorApplications.list` / `.review` are
        // platform-ADMIN procedures that the page re-checks for itself.
        rbac: ["ADMIN"],
        hideInBottomBar: true,
      },
    ],
  },
  {
    id: "records",
    label: "admin.navGroupRecords",
    items: [
      {
        id: "orders",
        label: "admin.navOrders",
        route: "orders",
        icon: <ShoppingCart size={18} />,
        rbac: STAFF_CUSTOMER,
      },
      {
        id: "tickets",
        label: "admin.navPlatformTickets",
        route: "tickets",
        icon: <Ticket size={18} />,
        rbac: STAFF_CUSTOMER,
      },
      {
        id: "humans",
        label: "admin.navPlatformHumans",
        route: "humans",
        icon: <Users size={18} />,
        rbac: STAFF_CUSTOMER,
      },
      {
        id: "places",
        label: "admin.navPlaces",
        route: "places",
        icon: <MapPin size={18} />,
        rbac: STAFF_ALL,
      },
      {
        id: "settlements",
        label: "admin.navPlatformSettlements",
        route: "settlements",
        icon: <Banknote size={18} />,
        rbac: STAFF_TECH,
        // ADMIN/DEVELOPER reconciliation screen — it held a thumb-reach tab
        // only because the bottom bar flattens sections in order and nothing
        // opted out. Rail + More drawer only.
        hideInBottomBar: true,
      },
      {
        // Door cash-sale tax (plus the platform fee on sales before
        // 2026-10-08) no payout has recovered in 30+ days. Mirrors
        // PAYEE_DEBT_READ_ROLES, which `listUnrecoveredCashDebts` enforces
        // (core use-cases/platform/list-unrecovered-cash-debts.ts). A desk
        // read for collecting by hand: rail + More drawer only.
        id: "cash-debts",
        label: "admin.navPlatformCashDebts",
        route: "cash-debts",
        icon: <HandCoins size={18} />,
        rbac: ["ADMIN", "SUPPORT"],
        hideInBottomBar: true,
      },
    ],
  },
  {
    // Every item in this group carries `hideInBottomBar`: these are
    // configuration surfaces staff sit down at a desk for, and the mobile bar
    // has room for three tabs plus MORE. They all stay in the rail and the
    // More drawer.
    id: "catalog",
    label: "admin.navGroupCatalog",
    items: [
      {
        id: "fees",
        label: "admin.navFees",
        route: "fees",
        icon: <Percent size={18} />,
        rbac: STAFF_TECH,
        hideInBottomBar: true,
      },
      {
        id: "fee-waivers",
        label: "admin.navFeeWaivers",
        route: "fee-waivers",
        icon: <TicketPercent size={18} />,
        rbac: STAFF_TECH,
        hideInBottomBar: true,
      },
      {
        // BadgePercent, not Tag: `categories` used the same Tag glyph, which
        // made the two rows indistinguishable in the 72px collapsed rail.
        // Promos keeps the percent family (Percent/TicketPercent above).
        id: "promos",
        label: "admin.navPromos",
        route: "promos",
        icon: <BadgePercent size={18} />,
        rbac: STAFF_TECH,
        hideInBottomBar: true,
      },
      {
        // ADMIN-only, matching what the three `platform.*MembershipStanding*`
        // procedures enforce server-side (STAFF_ONLY with requiredRoles
        // ["ADMIN"]) — a DEVELOPER shown this entry would only reach a 403.
        id: "memberships",
        label: "admin.navPlatformMemberships",
        route: "memberships",
        icon: <HeartHandshake size={18} />,
        rbac: ["ADMIN"],
        hideInBottomBar: true,
      },
      {
        // FolderTree, not Tag — see the promos note above; a taxonomy tree
        // also reads truer than a price tag for this surface.
        id: "categories",
        label: "admin.navPlatformCategories",
        route: "categories",
        icon: <FolderTree size={18} />,
        rbac: STAFF_ALL,
        hideInBottomBar: true,
      },
      {
        id: "featured",
        label: "admin.navPlatformFeatured",
        route: "featured",
        icon: <Star size={18} />,
        rbac: STAFF_ALL,
        hideInBottomBar: true,
      },
      {
        // ADMIN-only, matching `community.listListingsForPlatform` (platform
        // ADMIN; moderators get FORBIDDEN). A desk surface: rail + More only.
        id: "community-listings",
        label: "admin.navPlatformCommunityListings",
        route: "community-listings",
        icon: <CalendarRange size={18} />,
        rbac: ["ADMIN"],
        hideInBottomBar: true,
      },
      {
        // Same STAFF_TECH reasoning as volunteer-packs directly below — the
        // ticket catalogue (ticket-type-packs FR-012) ships staff-authored
        // content to every organizer; the server additionally 2FA-gates it
        // wholesale (platform.ticketPacks.* under guard.ts's platform.*).
        //
        // PackageOpen, not Ticket: plain Tickets (Records) keeps `Ticket`, and
        // two identical glyphs are unreadable in the collapsed rail.
        id: "ticket-packs",
        label: "admin.navPlatformTicketPacks",
        route: "ticket-packs",
        icon: <PackageOpen size={18} />,
        rbac: STAFF_TECH,
        hideInBottomBar: true,
      },
      {
        // STAFF_TECH (ADMIN + DEVELOPER), NOT the STAFF_ALL its neighbour
        // `featured` uses — publishing a pack ships staff-authored content to
        // every organizer on the platform with no PR and no CI, which FR-014
        // puts at the fees/jobs privilege level. It is also exactly what the
        // five `volunteerPacks.admin.*` use cases enforce server-side, so a
        // REVIEWER or SUPPORT member shown this entry would only reach a 403.
        id: "volunteer-packs",
        label: "admin.navPlatformVolunteerPacks",
        route: "volunteer-packs",
        icon: <Layers size={18} />,
        rbac: STAFF_TECH,
        hideInBottomBar: true,
      },
    ],
  },
  {
    // `separatorAbove` sets this trailing structural group off from the
    // everyday sections in the wide rail (the 72px icon rail separates every
    // group regardless). Same treatment ADMIN_SECTIONS gives its Workspace
    // group. Every item carries `hideInBottomBar` for the same reason as
    // Catalog & pricing above.
    id: "operations",
    label: "admin.navGroupOperations",
    separatorAbove: true,
    items: [
      {
        id: "jobs",
        label: "admin.navPlatformJobs",
        route: "jobs",
        icon: <Timer size={18} />,
        rbac: STAFF_TECH,
        hideInBottomBar: true,
      },
      {
        id: "quotas",
        label: "admin.navPlatformQuotas",
        route: "quotas",
        icon: <Gauge size={18} />,
        rbac: STAFF_TECH,
        hideInBottomBar: true,
      },
      {
        id: "features",
        label: "admin.navPlatformFeatureGates",
        route: "features",
        icon: <ToggleLeft size={18} />,
        rbac: STAFF_TECH,
        hideInBottomBar: true,
      },
      {
        id: "theme-editor",
        label: "admin.navPlatformThemeEditor",
        route: "theme-editor",
        icon: <Palette size={18} />,
        rbac: STAFF_TECH,
        hideInBottomBar: true,
      },
      {
        id: "roles",
        label: "admin.navPlatformRoles",
        route: "roles",
        icon: <ShieldCheck size={18} />,
        rbac: STAFF_TECH,
        hideInBottomBar: true,
      },
      {
        // rbac is the exact ["ADMIN", "REVIEWER"] set the server-side
        // `listAuditLogs` use case enforces (audit-trail review is core to a
        // REVIEWER's job; this surface is read-only, so no STAFF_TECH/
        // STAFF_ALL/STAFF_CUSTOMER preset matches it — those either exclude
        // REVIEWER or include SUPPORT/DEVELOPER, who'd hit a 403 here).
        id: "audit-log",
        label: "admin.navPlatformAuditLog",
        route: "audit-log",
        icon: <ScrollText size={18} />,
        rbac: ["ADMIN", "REVIEWER"],
        hideInBottomBar: true,
      },
      {
        id: "settings",
        label: "admin.navPlatformSettings",
        route: "settings",
        icon: <Settings size={18} />,
        rbac: STAFF_TECH,
        hideInBottomBar: true,
      },
    ],
  },
];
