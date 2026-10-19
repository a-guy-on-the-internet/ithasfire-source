"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useRouter } from "@bprogress/next/app";
import { BrandLockup } from "@/components/navigation/BrandLockup";
import Link from "next/link";
import { XStack, YStack } from "tamagui";
import { ScanLine } from "lucide-react";
import { ORG_SCAN_ROLES } from "@th/types";

import {
  AdminLedgerShell,
  AlertsSidebar,
  Text,
  filterSections,
  namespaceNavSections,
  parseNamespacedPathname,
  toNamespacedHref,
  useTranslations,
  type AccountContext,
  type NavigationBottomBarCenterAction,
  type NavigationSection,
  type NavigationShellLayout,
} from "@th/ui";
import { useAlertsSidebarI18n } from "@/components/notifications/useAlertsSidebarI18n";
import {
  useAdminRailContext,
  type AdminRailContextDeps,
} from "./admin-context-registry";
import { withoutOrgOnlyItems } from "./admin-nav-sections";
import {
  sectionTargetFromHref,
  useAdminPageSectionsActions,
  useAdminPageSectionsState,
} from "./admin-page-sections";
import { AdminPageTransition } from "./AdminPageTransition";
import { CreateOrganizationDialog } from "./CreateOrganizationDialog";
import {
  ADMIN_DASHBOARD_ROUTE,
  collectPortableRouteSegments,
  resolveWorkspaceSwitchTarget,
} from "./workspace-switch-target";

import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";
import { LanguageSwitcher } from "@/components/i18n/LanguageSwitcher";
import { ThemeToggleButton } from "@/components/theme/ThemeToggleButton";
import { NotificationInboxContainer } from "@/components/notifications/NotificationInboxContainer";
import { NavbarSearch } from "@/components/search/NavbarSearch";
import {
  useDocumentTitleFallback,
  useDocumentTitleUnread,
} from "@/hooks/useDocumentTitle";
import { useEventOwnerEntities } from "@/hooks/useEventOwnerEntities";
import { useFeatureGates } from "@/hooks/useFeatureGates";
import { useCreateDraftEvent } from "@/hooks/useCreateDraftEvent";
import { normalizeAdminSlug } from "@/hooks/useAdminSlug";
import { guardedNavigate } from "@/hooks/navigation-guard";
import { setLastAdminSlug } from "@/lib/last-admin-context";
import { trpc } from "@/trpc";

export type AdminShellProps = {
  slug: string;
  sections: NavigationSection[];
  accountContext: AccountContext;
  children: React.ReactNode;
};

// Safety net: if the owner-entities query never errors and never resolves
// (e.g. the auth session stays unresolved so the query is pending, or a
// request hangs), fall through to the error+Retry card after this window
// instead of spinning on "Loading…" forever.
const LOAD_TIMEOUT_MS = 15_000;

/**
 * Web admin shell mounted at `/admin/[slug]/**`.
 *
 * Contract:
 * - `sections[i].items[j].route` is a STABLE route id (e.g. `"dashboard"`, `"orders"`).
 * - We generate concrete hrefs by namespacing beneath `/admin/{slug}`.
 * - We derive `currentRoute` (stable id) from Next's `usePathname()`.
 */
export const AdminShell = ({
  slug,
  sections,
  accountContext,
  children,
}: AdminShellProps) => {
  const router = useRouter();
  const pathname = usePathname();
  const ownerEntitiesQuery = useEventOwnerEntities();
  const utils = trpc.useUtils();
  const t = useTranslations();
  // Bell name and panel labels in the user's language.
  const { formatButtonLabel: formatBellLabel, labels: alertsLabels } =
    useAlertsSidebarI18n();
  const { gates } = useFeatureGates();

  const [createOrgOpen, setCreateOrgOpen] = useState(false);
  const [loadTimedOut, setLoadTimedOut] = useState(false);

  // Draft creation without an `/events/new` route — handed to the pages that
  // offer a "Create event" affordance (dashboard cards, the events table).
  const { createDraft: createDraftEvent, modeChoiceDialog } =
    useCreateDraftEvent(slug);

  // Derive enabled feature flags from gates for NavigationShell filtering.
  const enabledFeatureFlags = useMemo(() => {
    if (!gates) return undefined;
    return Object.entries(gates)
      .filter(([, enabled]) => enabled)
      .map(([key]) => key);
  }, [gates]);

  const normalizedSlug = useMemo(() => normalizeAdminSlug(slug), [slug]);
  const allowedSlugs = useMemo(() => {
    const owners = ownerEntitiesQuery.ownersWithSlugs ?? [];
    const slugs = new Set<string>();
    for (const o of owners) {
      slugs.add(normalizeAdminSlug(o.adminSlug));
      // Also accept the raw humanId so old/direct links still resolve.
      if (o.kind === "human") {
        slugs.add(normalizeAdminSlug(`@${o.humanId}`));
      }
    }
    return slugs;
  }, [ownerEntitiesQuery.ownersWithSlugs]);

  const adminBasePath = `/admin/${slug}`;

  // Fallback is the EXPLICIT dashboard route, not `sections[0].items[0]`.
  // The dashboard is no longer a nav item (the rail identity block is the one
  // way home), so deriving the fallback from the first nav item would land an
  // unparseable pathname on whatever now sits at the top of the rail — Search.
  const currentRoute =
    parseNamespacedPathname(pathname, {
      adminBasePath,
      fallbackRouteId: ADMIN_DASHBOARD_ROUTE,
    }) ?? ADMIN_DASHBOARD_ROUTE;

  useEffect(() => {
    // Client RBAC gate.
    // - AuthN is handled by AppAuthGate in AppChrome (unauth -> /sign-in?redirect=...)
    // - AuthZ/ownership is derived from our API (events.listEventOwnerEntities)
    //
    // Avoid redirect loops:
    // - Do nothing while the query is loading.
    // - Only redirect when we have data and the slug is definitively not allowed.
    // - Prefer redirecting to the user's preferred slug when available; otherwise /unauthorized.
    if (!ownerEntitiesQuery.data) return;
    if (ownerEntitiesQuery.isError) {
      // If we can't resolve ownership, fail closed.
      router.replace("/unauthorized");
      return;
    }
    if (!normalizedSlug) return;
    if (allowedSlugs.has(normalizedSlug)) return;

    const preferred = ownerEntitiesQuery.preferredAdminSlug
      ? normalizeAdminSlug(ownerEntitiesQuery.preferredAdminSlug)
      : null;
    if (preferred && preferred !== normalizedSlug) {
      router.replace(`/admin/${preferred}`);
      return;
    }

    router.replace("/unauthorized");
  }, [
    allowedSlugs,
    normalizedSlug,
    ownerEntitiesQuery.data,
    ownerEntitiesQuery.isError,
    ownerEntitiesQuery.preferredAdminSlug,
    router,
  ]);

  const shouldBlockRender = useMemo(() => {
    // Block rendering admin chrome while loading or if slug is not allowed (we'll redirect).
    if (!normalizedSlug) return true;
    if (ownerEntitiesQuery.isLoading) return true;
    if (!ownerEntitiesQuery.data) return true;
    if (ownerEntitiesQuery.isError) return true;
    return !allowedSlugs.has(normalizedSlug);
  }, [
    allowedSlugs,
    normalizedSlug,
    ownerEntitiesQuery.data,
    ownerEntitiesQuery.isError,
    ownerEntitiesQuery.isLoading,
  ]);

  // Persist last-used admin workspace so attendee-view "Manage events" can route here.
  useEffect(() => {
    if (!shouldBlockRender && normalizedSlug) {
      setLastAdminSlug(slug);
    }
  }, [shouldBlockRender, normalizedSlug, slug]);

  const handleReturnToConsumer = useCallback(() => {
    guardedNavigate(() => router.push("/"));
  }, [router]);

  const handleRetryOwnerEntities = useCallback(() => {
    // Reset the timeout first so Retry restarts the wait window rather than
    // instantly re-rendering the timed-out card.
    setLoadTimedOut(false);
    void ownerEntitiesQuery.refetch();
  }, [ownerEntitiesQuery]);

  // Arm a load-timeout while we're still genuinely loading (not yet
  // error/success/timeout). If the query never resolves or errors, this trips
  // and routes us to the same error+Retry card. `data` presence is a fine
  // "resolved" proxy; we avoid depending on the churny whole-query object.
  useEffect(() => {
    if (ownerEntitiesQuery.isError || ownerEntitiesQuery.data || loadTimedOut) {
      return;
    }
    const id = setTimeout(() => setLoadTimedOut(true), LOAD_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [ownerEntitiesQuery.isError, ownerEntitiesQuery.data, loadTimedOut]);

  // Move focus into the error card's Retry button when it appears so keyboard
  // users aren't stranded (the card is the only thing rendered while errored,
  // and this branch can mount/unmount as the query state changes).
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (ownerEntitiesQuery.isError || loadTimedOut) {
      retryButtonRef.current?.focus();
    }
  }, [ownerEntitiesQuery.isError, loadTimedOut]);

  // Derive better account context from the loaded owner entity
  const currentOwner = useMemo(() => {
    const owners = ownerEntitiesQuery.ownersWithSlugs ?? [];
    return owners.find((o) => {
      if (normalizeAdminSlug(o.adminSlug) === normalizedSlug) return true;
      // Also match by raw humanId for legacy/direct URLs
      if (
        o.kind === "human" &&
        normalizeAdminSlug(`@${o.humanId}`) === normalizedSlug
      )
        return true;
      return false;
    });
  }, [ownerEntitiesQuery.ownersWithSlugs, normalizedSlug]);

  // ── Bookings rail badge (booking-inbox-placement FR-007) ────────────────
  // `ADMIN_SECTIONS` is a static const, so the count is injected here at
  // render time rather than baked into the nav model. One `countOpen` query
  // covers both halves of "things waiting for you on that page": the org's
  // as-an-act inbox plus every owned venue's inbox.
  //
  // SILENT ON FAILURE, deliberately: `meta.silent` + `retry: false` so a
  // failed count renders the rail with NO badge and NO toast. A badge is
  // decoration on a nav item — it must never be able to break navigation, and
  // an error toast on every admin page load would be worse than no badge.
  // This is not a swallow-with-fallback in the ReporterPort sense (NFR-004):
  // nothing is caught here, the query simply has no data, and the tRPC
  // backstop still captures the underlying error server-side.
  //
  // A HUMAN admin gets the same badge with the human selector: a person can
  // own venues directly, and those requests now render on their personal
  // Bookings page. For a human the badge is the VENUE sum only: the wire's
  // `performerInbox` is the person's own act-side inbox, which lives in
  // account settings, not on this page — counting it would badge a page that
  // has nothing waiting on it.
  const bookingsOrgId =
    currentOwner?.kind === "org" ? currentOwner.orgId : null;
  const bookingsIsHuman = currentOwner?.kind === "human";
  const openBookingsQuery = trpc.bookingRequests.countOpen.useQuery(
    bookingsOrgId !== null
      ? { orgId: bookingsOrgId }
      : { owner: { kind: "human" as const } },
    {
      enabled: bookingsOrgId !== null || bookingsIsHuman,
      staleTime: 30_000,
      retry: false,
      meta: { silent: true },
    },
  );
  const openBookingsCount = useMemo(() => {
    const data = openBookingsQuery.data;
    if (!data) return 0;
    const venueSum = data.venues.reduce(
      (sum, venue) => sum + venue.openCount,
      0,
    );
    return bookingsIsHuman ? venueSum : data.performerInbox + venueSum;
  }, [openBookingsQuery.data, bookingsIsHuman]);

  // ── In-page section anchors (Payouts) ──────────────────────────────────
  // A workspace item whose route carries a fragment (`payouts#ledger`) is an
  // anchor into a page. Its `active` is CONTROLLED: true only for the section
  // the mounted page's scroll-spy reports, and false everywhere else — never
  // left to route matching — so the group stays closed off the page and
  // exactly one child is lit on it. See `admin-page-sections.tsx`.
  const pageSectionsActions = useAdminPageSectionsActions();
  const activePageSection =
    useAdminPageSectionsState()?.activeSection ?? null;

  // Derive context-aware section labels (e.g. "Team" → "Delegates" for humans)
  // and resolve i18n translation keys for all labels.
  const contextAwareSections = useMemo(() => {
    const isHuman = currentOwner?.kind === "human";

    const anchorActive = (route: string): boolean | undefined => {
      const hashIndex = route.indexOf("#");
      if (hashIndex === -1) return undefined;
      const routeId = route.slice(0, hashIndex);
      return (
        currentRoute === routeId &&
        activePageSection?.routeId === routeId &&
        activePageSection.sectionId === route.slice(hashIndex + 1)
      );
    };

    const translateItem = (
      item: NavigationSection["items"][number],
    ): NavigationSection["items"][number] => {
      const labelKey =
        isHuman && item.id === "team" ? "admin.navDelegates" : item.label;
      const active = anchorActive(item.route);
      return {
        ...item,
        label: String(t(labelKey)),
        ...(active === undefined ? {} : { active }),
        // `badgeCount` is falsy-guarded by the rail, so 0 renders no badge.
        ...(item.id === "bookings" && openBookingsCount > 0
          ? { badgeCount: openBookingsCount }
          : {}),
        ...(item.children
          ? { children: item.children.map(translateItem) }
          : {}),
      };
    };

    // A personal workspace has no org-only pages (Volunteer Roles).
    const visibleSections = isHuman ? withoutOrgOnlyItems(sections) : sections;
    return visibleSections.map((section) => ({
      ...section,
      label: String(t(section.label)),
      items: section.items.map(translateItem),
    }));
  }, [
    sections,
    currentOwner?.kind,
    openBookingsCount,
    t,
    currentRoute,
    activePageSection,
  ]);

  // ── Nested-context rail swap (place-admin-rail-context D2/FR-101) ───────
  // On a nested context route (today: /admin/[slug]/events/[id]/*, not the
  // list, not /events/new) the rail swaps to that context's sections, back
  // slot, header, persist key and prefetch list. Context descriptors live in
  // admin-context-registry; first match wins, no match ⇒ the workspace rail.
  const railContextDeps = useMemo<AdminRailContextDeps>(
    () => ({
      slug,
      persistKeyBase: normalizedSlug ?? slug,
      router,
      t,
      currentOwner,
    }),
    [slug, normalizedSlug, router, t, currentOwner],
  );
  const railContext = useAdminRailContext(pathname, railContextDeps);

  // Prefetch the active context's routes as soon as its rail mounts so rail
  // clicks feel like the old tab switches instead of full route loads.
  // `router` here is @bprogress's extended app router, which exposes Next's
  // `prefetch` — guarded (optional chain + swallow) because test/mocked
  // routers omit it and prefetch is best-effort by definition. Dev-mode
  // first-visit compile latency (Turbopack) is unaffected; this pays off in
  // prod where prefetch warms the RSC payload cache.
  const prefetchRoutes = railContext?.prefetchRoutes;
  useEffect(() => {
    if (!prefetchRoutes) return;
    for (const href of prefetchRoutes) {
      try {
        router.prefetch?.(href);
      } catch {
        // Best-effort: an unsupported/mocked router must never break the shell.
      }
    }
  }, [prefetchRoutes, router]);

  const effectiveSections = railContext?.sections ?? contextAwareSections;

  const { sections: namespacedSections } = useMemo(
    () => namespaceNavSections(effectiveSections, { adminBasePath }),
    [adminBasePath, effectiveSections],
  );

  const derivedAccountContext: AccountContext = useMemo(() => {
    if (!currentOwner) return accountContext;

    if (currentOwner.kind === "org") {
      return {
        id: currentOwner.adminSlug,
        label: currentOwner.orgName,
        type: "org",
        role: currentOwner.role,
        // Real membership role drives nav RBAC filtering.
        roles: [currentOwner.role],
        defaultRoute: "dashboard",
      };
    }

    return {
      id: currentOwner.adminSlug,
      label: currentOwner.humanName,
      type: "personal",
      defaultRoute: "dashboard",
    };
  }, [currentOwner, accountContext]);

  // ── Mobile bottom-bar center action: SCAN (one-bottom-bar redesign) ─────
  // The raised accent square between the tabs navigates to the admin scan
  // route. Gated on the same role set as the nav item (err-open on empty
  // roles, matching NavigationShell's rbac filtering), and dropped inside
  // any nested rail context (event today), where the bar shows context nav
  // and the builder owns its actions in its own header. `hideInBottomBar` on the
  // scan nav item keeps the square from doubling up with a scan TAB for
  // SCANNER-role members.
  const canScan = useMemo(() => {
    const roles =
      derivedAccountContext.roles ??
      (derivedAccountContext.role ? [derivedAccountContext.role] : []);
    if (!roles.length) return true; // unknown roles err open, like nav rbac
    return roles.some((role) =>
      (ORG_SCAN_ROLES as readonly string[]).includes(role),
    );
  }, [derivedAccountContext.roles, derivedAccountContext.role]);

  const scanCenterAction = useMemo<
    NavigationBottomBarCenterAction | undefined
  >(() => {
    if (railContext || !canScan) return undefined;
    return {
      id: "scan",
      // "Scan" / "Escanear" — the short label; the drawer's longer
      // admin.scanTicket ("Scan Ticket") doesn't fit the 64px square.
      label: String(t("pageActions.scanTicket")),
      icon: <ScanLine />,
      // Same select mechanism the shell uses for routes: namespaced href via
      // the router, so pathname-derived active state stays consistent.
      onPress: () =>
        guardedNavigate(() =>
          router.push(toNamespacedHref("scan", { adminBasePath })),
        ),
      testId: "admin-bottom-scan",
    };
  }, [railContext, canScan, router, adminBasePath, t]);

  // Descriptive browser tab/history title: "<Section> · <Workspace>".
  // Client admin pages can't export Next metadata, so without this every admin
  // route shows the generic root title in back-button history.
  const activeSectionLabel = useMemo(() => {
    for (const section of effectiveSections) {
      for (const item of section.items) {
        if (item.route === currentRoute) return item.label;
        const child = item.children?.find((c) => c.route === currentRoute);
        if (child) return child.label;
      }
    }
    return undefined;
  }, [effectiveSections, currentRoute]);

  useDocumentTitleFallback(
    activeSectionLabel
      ? `${activeSectionLabel} · ${derivedAccountContext.label}`
      : derivedAccountContext.label,
  );

  // Build available contexts for workspace switching
  const availableContexts: AccountContext[] = useMemo(() => {
    const owners = ownerEntitiesQuery.ownersWithSlugs ?? [];
    return owners.map((owner) => {
      if (owner.kind === "org") {
        return {
          id: owner.adminSlug,
          label: owner.orgName,
          type: "org" as const,
          role: owner.role,
          defaultRoute: "dashboard",
        };
      }
      return {
        id: owner.adminSlug,
        label: owner.humanName,
        type: "personal" as const,
        defaultRoute: "dashboard",
      };
    });
  }, [ownerEntitiesQuery.ownersWithSlugs]);

  // ── Workspace switching keeps you on the same SECTION ──────────────────
  // Portable sections are derived from the `sections` prop (the workspace nav
  // model) rather than a hardcoded list, so they cannot drift from the rail —
  // and run through the SAME rbac/feature-flag filter NavigationShell
  // applies, so a section the rail wouldn't offer is never a switch target.
  //
  // Note this is the RAW `sections` prop, not `effectiveSections`: inside a
  // nested rail context (an event) the effective sections are that context's
  // own routes, and we want the workspace-level section root it lives under.
  //
  // The filter runs PER TARGET, not once against the current workspace: an
  // OWNER of orgA who is only a SCANNER of orgB must not be handed
  // `/admin/orgB/team` (ORG_MANAGE_VIEW) just because Team is visible here —
  // orgB's own rail doesn't offer it and the roster query answers FORBIDDEN.
  // Two things make this cheap:
  //   * feature gates are PLATFORM-level (`PlatformSetting` rows keyed
  //     `feature:<slug>`; `features.getFeatureGates` takes no org), so they
  //     resolve identically for every target and need no per-target lookup;
  //   * the target role is already in `availableContexts`, and
  //     `shouldBlockRender` gates the whole shell on the same
  //     `ownerEntitiesQuery.data` that fills it, so there is no window where a
  //     row is clickable with an unknown role.
  // Personal targets carry no role, so `filterSections` errs open and human
  // workspaces keep today's behaviour.
  const portableRoutesByContext = useMemo(() => {
    const byContext = new Map<string, ReadonlySet<string>>();
    for (const context of availableContexts) {
      byContext.set(
        context.id,
        collectPortableRouteSegments(
          filterSections(
            context.type === "personal"
              ? withoutOrgOnlyItems(sections)
              : sections,
            context.roles ?? (context.role ? [context.role] : []),
            enabledFeatureFlags,
          ),
        ),
      );
    }
    return byContext;
  }, [availableContexts, sections, enabledFeatureFlags]);

  // Fallback for a context id that isn't in `availableContexts` (the switcher
  // only renders ids that are, so this is belt-and-braces).
  const currentPortableRoutes = useMemo(
    () =>
      collectPortableRouteSegments(
        filterSections(
          derivedAccountContext.type === "personal"
            ? withoutOrgOnlyItems(sections)
            : sections,
          derivedAccountContext.roles ??
            (derivedAccountContext.role ? [derivedAccountContext.role] : []),
          enabledFeatureFlags,
        ),
      ),
    [
      sections,
      derivedAccountContext.type,
      derivedAccountContext.roles,
      derivedAccountContext.role,
      enabledFeatureFlags,
    ],
  );

  // Both the click handler and the anchor `href` MUST produce the same
  // target, or a plain click and a middle-click disagree.
  const buildContextHref = useCallback(
    (contextId: string) =>
      resolveWorkspaceSwitchTarget({
        pathname,
        adminBasePath,
        targetContextId: contextId,
        portableRoutes:
          portableRoutesByContext.get(contextId) ?? currentPortableRoutes,
      }),
    [pathname, adminBasePath, portableRoutesByContext, currentPortableRoutes],
  );

  // Handle context/workspace switching
  const handleContextSwitch = useCallback(
    (contextId: string) => {
      guardedNavigate(() => router.push(buildContextHref(contextId)));
    },
    [router, buildContextHref],
  );

  // Rail identity block ("IF / Ithas Fire Demo Org / ADMIN") is the
  // workspace's home affordance — it goes to that workspace's dashboard.
  const workspaceHomeHref = toNamespacedHref("dashboard", { adminBasePath });
  const handleRailIdentityPress = useCallback(() => {
    guardedNavigate(() => router.push(workspaceHomeHref));
  }, [router, workspaceHomeHref]);

  const handleOpenCreateOrg = useCallback(() => {
    setCreateOrgOpen(true);
  }, []);

  const handleCloseCreateOrg = useCallback(() => {
    setCreateOrgOpen(false);
  }, []);

  const handleOrgCreated = useCallback(
    async (orgId: string) => {
      setCreateOrgOpen(false);
      // Refetch owner entities so the new org appears in the workspace switcher.
      await utils.events.listEventOwnerEntities.invalidate();
      // Resolve the new org's admin slug from the refreshed data.
      const freshOwners = await utils.events.listEventOwnerEntities.ensureData(
        {},
      );
      const newOrg = freshOwners?.owners?.find(
        (o) => o.kind === "org" && o.orgId === orgId,
      );
      const newSlug =
        newOrg?.kind === "org" ? newOrg.orgSlug || newOrg.orgId : orgId;
      guardedNavigate(() => router.push(`/admin/${newSlug}/dashboard`));
    },
    [router, utils.events.listEventOwnerEntities],
  );

  // Notification bell for admin navbar. Polls so the badge stays current
  // without a live push (the SSE subscription is not wired to Redis).
  const unreadCountQuery = trpc.notifications.countUnread.useQuery(undefined, {
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
  const unreadCount = unreadCountQuery.data?.count;
  useDocumentTitleUnread(unreadCount);

  const renderInbox = useCallback(() => <NotificationInboxContainer />, []);

  // Brand element matching consumer side. This Link is the ONE home
  // affordance in the header — NavigationShell gets no `onBrandPress`, so the
  // navbar never wraps it in a Button (a link nested in a button put two
  // stacked "go home" targets in the a11y tree). Mobile never renders it: the
  // workspace switcher is the identity anchor there.
  const brandElement = (
    <Link
      href="/"
      aria-label={t("common.goToHome") as string}
      style={{
        display: "inline-flex",
        alignItems: "center",
        // Shrinkable so the lockup scales instead of bleeding over its
        // neighbours if the brand slot ever runs out of width.
        maxWidth: "100%",
        minWidth: 0,
      }}
    >
      <BrandLockup width={128} height={32} />
    </Link>
  );

  // ── Route select (rail, drawer, bottom bar AND the section tabs) ───────
  // `routeId` is a concrete href for the namespaced rail; stable ids are still
  // mapped. A nested context may swallow the select — the event Build anchors
  // (…/edit?section=x) scroll in place while the edit surface is mounted.
  // A workspace page may too: `payouts#ledger` scrolls in place while Payouts
  // is mounted. Otherwise fall through to the router, and the page lands on
  // the fragment once its sections render.
  const handleRouteSelect = useCallback(
    (routeId: string) => {
      const href = routeId.startsWith("/")
        ? routeId
        : toNamespacedHref(routeId, { adminBasePath });
      if (railContext?.interceptRouteSelect?.(href)) {
        return;
      }
      const sectionTarget = sectionTargetFromHref(href, adminBasePath);
      if (
        sectionTarget &&
        pageSectionsActions?.jumpToSection(
          sectionTarget.routeId,
          sectionTarget.sectionId,
        )
      ) {
        return;
      }
      // Through the page's unsaved-changes guard: the bottom bar and drawer
      // are buttons, so no link click reaches it on its own.
      guardedNavigate(() => router.push(href));
    },
    [adminBasePath, railContext, router, pageSectionsActions],
  );

  if (shouldBlockRender) {
    // Keep this intentionally minimal (no shared UI) to reduce risk of hook/server boundary issues.
    const fontFamily =
      "'Montserrat', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji'";

    // A failed owner-entities query (e.g. the API blipped during a restart),
    // or one that never resolves within LOAD_TIMEOUT_MS, must surface an
    // actionable error + Retry instead of an indefinite "Loading…". The
    // redirect effect only fires once we have data, so a no-data error falls
    // through to here and would otherwise hang every admin page.
    if (ownerEntitiesQuery.isError || loadTimedOut) {
      const retrying = ownerEntitiesQuery.isFetching;
      return (
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            fontFamily,
          }}
        >
          <div
            role="alert"
            style={{
              maxWidth: 420,
              width: "100%",
              textAlign: "center",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 12,
            }}
          >
            <h1
              style={{
                margin: 0,
                fontSize: 18,
                fontWeight: 600,
                lineHeight: 1.3,
              }}
            >
              {String(t("admin.asLoadErrorTitle"))}
            </h1>
            <p
              style={{
                margin: 0,
                fontSize: 14,
                lineHeight: 1.5,
                opacity: 0.7,
              }}
            >
              {String(t("admin.asLoadErrorBody"))}
            </p>
            <button
              ref={retryButtonRef}
              type="button"
              onClick={handleRetryOwnerEntities}
              disabled={retrying}
              style={{
                marginTop: 4,
                padding: "8px 16px",
                fontFamily,
                fontSize: 14,
                fontWeight: 600,
                // Raw inline styles (this branch deliberately renders without
                // shared UI), so tokens come through `var()` with the Stub hex
                // as the SSR/first-paint fallback.
                color: "var(--onStructure, #FDFAF3)",
                background: "var(--structure, #211C16)",
                border: "none",
                borderRadius: 0,
                textTransform: "uppercase",
                letterSpacing: 1.5,
                cursor: retrying ? "default" : "pointer",
                opacity: retrying ? 0.6 : 1,
              }}
            >
              {String(retrying ? t("admin.asRetrying") : t("admin.asRetry"))}
            </button>
          </div>
        </div>
      );
    }

    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          fontFamily,
        }}
      >
        <span style={{ opacity: 0.7 }}>{String(t("admin.asLoading"))}</span>
      </div>
    );
  }

  return (
    <AdminEmailVerificationGate mode="banner">
      <AdminLedgerShell
        surfaceRole={t("admin.navRoleAdmin") as string}
        navSections={namespacedSections}
        currentRoute={currentRoute}
        accountContext={derivedAccountContext}
        availableContexts={availableContexts}
        enabledFeatureFlags={enabledFeatureFlags}
        collapsibleSections
        sectionCollapsePersistKey={
          // A nested context keeps its own collapse state (FR-202: per event
          // id); the workspace rail persists on the workspace slug alone.
          railContext?.persistKey ?? normalizedSlug ?? slug
        }
        showRailIdentity
        railIdentityHref={workspaceHomeHref}
        onRailIdentityPress={handleRailIdentityPress}
        railIdentityLabel={
          t("admin.asGoToWorkspaceDashboard", {
            workspace: derivedAccountContext.label,
          }) as string
        }
        railBack={railContext?.railBack}
        railContextHeader={railContext?.railContextHeader}
        // Registers 2/3 (section tabs, context strip) are deliberately NOT
        // passed (user decision 2026-08-27): the rail is admin's navigation;
        // tabs fought it for the same job and the strip duplicated the
        // builder header. Only the topbar (register 1) is used here.
        bottomBarCenterAction={scanCenterAction}
        onContextSwitch={handleContextSwitch}
        onCreateOrganization={handleOpenCreateOrg}
        onRouteSelect={handleRouteSelect}
        onReturnToConsumer={handleReturnToConsumer}
        returnToConsumerLabel={t("admin.asExitToAttendee") as string}
        returnToConsumerDescription={t("admin.asBrowseEvents") as string}
        brand={brandElement}
        navbarContentMaxWidth={1400}
        navbarSearchSlot={<NavbarSearch testIdBase="admin-navbar-search" />}
        navbarTrailingSlot={(layout: NavigationShellLayout) =>
          layout === "mobile" ? (
            // Mobile top bar carries exactly two controls: the workspace
            // switcher (leading, rendered by the shell) and notifications.
            // Theme + language live in the drawer (quickActionFooter below).
            <AlertsSidebar
              buttonLabel={t("common.openNotifications") as string}
              formatButtonLabel={formatBellLabel}
              labels={alertsLabels}
              unreadCount={unreadCount}
              renderInbox={renderInbox}
              buttonDimension={48}
            />
          ) : (
            <XStack alignItems="center" gap="$2">
              <AlertsSidebar
                buttonLabel={t("common.openNotifications") as string}
                formatButtonLabel={formatBellLabel}
                labels={alertsLabels}
                unreadCount={unreadCount}
                renderInbox={renderInbox}
              />
              <ThemeToggleButton />
              <LanguageSwitcher compact />
            </XStack>
          )
        }
        quickActionFooter={
          <YStack
            gap="$2"
            paddingTop="$3"
            borderTopWidth={2}
            borderTopColor="$borderColor"
          >
            <Text variant="overline" tone="muted">
              {t("common.preferences") as string}
            </Text>
            <XStack gap="$2" alignItems="center">
              <ThemeToggleButton />
              <LanguageSwitcher />
            </XStack>
          </YStack>
        }
        contextHrefBuilder={buildContextHref}
      >
        <AdminPageTransition>{children}</AdminPageTransition>
      </AdminLedgerShell>
      <CreateOrganizationDialog
        open={createOrgOpen}
        onClose={handleCloseCreateOrg}
        onCreated={handleOrgCreated}
      />
      {modeChoiceDialog}
    </AdminEmailVerificationGate>
  );
};

AdminShell.displayName = "AdminShell";
