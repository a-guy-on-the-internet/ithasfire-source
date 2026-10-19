"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { useRouter } from "@bprogress/next/app";
import { BrandLockup } from "@/components/navigation/BrandLockup";

import {
  NavigationShell,
  AlertsSidebar,
  Text,
  namespaceNavSections,
  parseNamespacedPathname,
  toNamespacedHref,
  useTranslations,
  type AccountContext,
  type NavigationSection,
  type NavigationShellLayout,
} from "@th/ui";
import { useAlertsSidebarI18n } from "@/components/notifications/useAlertsSidebarI18n";

import type { StaffRole } from "@th/types";

import { NotificationInboxContainer } from "@/components/notifications/NotificationInboxContainer";
import { XStack, YStack } from "tamagui";
import { NavbarSearch } from "@/components/search/NavbarSearch";
import { ThemeToggleButton } from "@/components/theme/ThemeToggleButton";
import {
  useDocumentTitleFallback,
  useDocumentTitleUnread,
} from "@/hooks/useDocumentTitle";
import { trpc } from "@/trpc";

export type PlatformShellProps = {
  sections: NavigationSection[];
  children: React.ReactNode;
};

const PLATFORM_BASE_PATH = "/platform";

/**
 * The console's home route. Deliberately an explicit constant rather than
 * `sections[0]?.items[0]?.route`: `overview` is no longer a nav item (the rail
 * identity block is the one way home — see the doc on `PLATFORM_SECTIONS` in
 * `platform-nav-sections.tsx`), so deriving the fallback from the first nav item
 * would silently make it whatever now sits at the top of the rail. Mirrors
 * `ADMIN_DASHBOARD_ROUTE` in AdminShell.
 */
export const PLATFORM_OVERVIEW_ROUTE = "overview";

const PLATFORM_OVERVIEW_HREF = `${PLATFORM_BASE_PATH}/${PLATFORM_OVERVIEW_ROUTE}`;

/**
 * Display labels for the actor's platform staff role. The console previously
 * greeted every staff member as "Group Admin" — `PLATFORM_CONTEXT` declares
 * `type: "org"` with `role: "ADMIN"` for layout reasons, and
 * `getContextRoleLabel` maps the ORG role `ADMIN` to "Group Admin". These are
 * staff, not org members, so the shell passes an explicit `roleLabel`
 * override instead (see `AccountContext.roleLabel`).
 *
 * Ordered by privilege: a human holding several staff roles is labelled by the
 * strongest one, so the label is deterministic rather than dependent on the
 * order the API happens to return.
 */
const STAFF_ROLE_LABELS: ReadonlyArray<readonly [StaffRole, string]> = [
  ["ADMIN", "Platform Admin"],
  ["SUPPORT", "Support"],
  ["DEVELOPER", "Developer"],
  ["REVIEWER", "Reviewer"],
];

const staffRoleLabel = (roles: readonly StaffRole[]): string | undefined =>
  STAFF_ROLE_LABELS.find(([role]) => roles.includes(role))?.[1];

const PLATFORM_CONTEXT: AccountContext = {
  id: "platform",
  label: "Ithas Fire Platform",
  type: "org",
  // Display role only; nav filtering uses the staff `roles` set below, and
  // the visible label comes from `roleLabel` (set per-actor in the shell).
  role: "ADMIN",
  defaultRoute: PLATFORM_OVERVIEW_ROUTE,
};

/**
 * Shell for the /platform/** staff-only area.
 *
 * Gates access via `trpc.platform.checkStaffAccess` — only humans with
 * ADMIN, REVIEWER, SUPPORT, or DEVELOPER HumanRoles can enter. Staff missing
 * an enrolled second factor (passkey/TOTP — step-up 2FA gate) are redirected
 * to `/enroll-2fa` instead of `/access-denied` — they DO have the role, they
 * just need to add a passkey/TOTP first.
 */
export const PlatformShell = ({ sections, children }: PlatformShellProps) => {
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations();
  // Bell name and panel labels in the user's language.
  const { formatButtonLabel: formatBellLabel, labels: alertsLabels } =
    useAlertsSidebarI18n();

  const staffAccessQuery = trpc.platform.checkStaffAccess.useQuery(undefined, {
    retry: false,
    staleTime: 5 * 60_000,
  });
  const needsSecondFactor =
    staffAccessQuery.data?.allowed === true &&
    staffAccessQuery.data.secondFactorEnrolled !== true;

  // Notification bell for platform navbar. Polls so the badge stays current
  // without a live push (the SSE subscription is not wired to Redis).
  const unreadCountQuery = trpc.notifications.countUnread.useQuery(undefined, {
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
  const unreadCount = unreadCountQuery.data?.count;

  const renderInbox = useCallback(() => <NotificationInboxContainer />, []);

  // Translate label keys (mirrors AdminShell.contextAwareSections)
  const translatedSections = useMemo(
    () =>
      sections.map((section) => ({
        ...section,
        label: String(t(section.label)),
        items: section.items.map((item) => ({
          ...item,
          label: String(t(item.label)),
          ...(item.children
            ? {
                children: item.children.map((c) => ({
                  ...c,
                  label: String(t(c.label)),
                })),
              }
            : {}),
        })),
      })),
    [sections, t],
  );

  const { sections: namespacedSections } = useMemo(
    () =>
      namespaceNavSections(translatedSections, {
        adminBasePath: PLATFORM_BASE_PATH,
      }),
    [translatedSections],
  );

  // Account context carrying the actor's real staff roles for nav filtering.
  // While the access query is loading, leave `roles` empty so filtering errs
  // OPEN (matches NavigationShell.hooks). Server-side checks remain the real
  // boundary, and the shell anyway only renders once access is `allowed`.
  const accountContext: AccountContext = useMemo(() => {
    // `checkStaffAccess` returns `string[]`; the server already narrows them
    // to `PLATFORM_STAFF_ROLES`, so they're safe to treat as `StaffRole[]`.
    const roles = (staffAccessQuery.data?.roles ?? []) as StaffRole[];
    const roleLabel = staffRoleLabel(roles);
    return {
      ...PLATFORM_CONTEXT,
      roles,
      // Omitted while the access query is in flight, so the switcher falls
      // back to today's behaviour rather than flashing a wrong label.
      ...(roleLabel ? { roleLabel } : {}),
    };
  }, [staffAccessQuery.data?.roles]);

  const currentRoute =
    parseNamespacedPathname(pathname, {
      adminBasePath: PLATFORM_BASE_PATH,
      fallbackRouteId: PLATFORM_OVERVIEW_ROUTE,
    }) ?? PLATFORM_OVERVIEW_ROUTE;

  // Descriptive browser tab/history title: "<Section> · Platform".
  const activeSectionLabel = useMemo(() => {
    // Overview is not a nav item (the rail identity block is the way home), so
    // it matches nothing in the loop below and the tab would read a bare
    // "Platform". Name it explicitly.
    if (currentRoute === PLATFORM_OVERVIEW_ROUTE) {
      return String(t("admin.navPlatformOverview"));
    }
    for (const section of translatedSections) {
      for (const item of section.items) {
        if (item.route === currentRoute) return item.label;
        const child = item.children?.find((c) => c.route === currentRoute);
        if (child) return child.label;
      }
    }
    return undefined;
  }, [translatedSections, currentRoute, t]);

  useDocumentTitleFallback(
    activeSectionLabel ? `${activeSectionLabel} · Platform` : "Platform",
  );
  useDocumentTitleUnread(unreadCount);

  const handleReturnToConsumer = useCallback(() => {
    router.push("/");
  }, [router]);

  // The rail identity block (and, on mobile, the drawer's account header) is
  // the one way home now that Overview left the nav.
  const handleRailIdentityPress = useCallback(() => {
    router.push(PLATFORM_OVERVIEW_HREF);
  }, [router]);

  // Access denied — redirect to standalone error page (no shell)
  // Must be before any early returns to satisfy Rules of Hooks.
  useEffect(() => {
    if (staffAccessQuery.isLoading) return;
    if (staffAccessQuery.isError || !staffAccessQuery.data?.allowed) {
      router.replace("/access-denied");
      return;
    }
    if (needsSecondFactor) {
      router.replace(
        `/enroll-2fa?redirect_url=${encodeURIComponent(pathname ?? "/platform")}`,
      );
    }
  }, [
    staffAccessQuery.isLoading,
    staffAccessQuery.isError,
    staffAccessQuery.data,
    needsSecondFactor,
    pathname,
    router,
  ]);

  // Loading state
  if (staffAccessQuery.isLoading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          fontFamily: "var(--font-body, Montserrat, sans-serif)",
          color: "var(--colorMuted, #5C544A)",
        }}
      >
        {String(t("admin.psLoading"))}
      </div>
    );
  }

  // Access denied (or missing 2nd factor) — return nothing while redirect fires
  if (
    staffAccessQuery.isError ||
    !staffAccessQuery.data?.allowed ||
    needsSecondFactor
  ) {
    return null;
  }

  // This Link is the ONE home affordance in the header — NavigationShell gets
  // no `onBrandPress`, so the navbar never wraps it in a Button. It used to:
  // a <div> (flow content) inside a <button> is invalid HTML, and a link
  // nested in a button puts two stacked "go home" targets in the a11y tree.
  // Same treatment as AdminShell. Mobile never renders it — the workspace
  // switcher is the identity anchor there.
  const brandElement = (
    <Link
      href="/"
      aria-label={t("common.goToHome") as string}
      style={{
        display: "inline-flex",
        alignItems: "center",
        // Shrinkable so the lockup scales instead of clipping if the brand
        // slot ever runs out of width.
        maxWidth: "100%",
        minWidth: 0,
      }}
    >
      <BrandLockup width={128} height={32} />
    </Link>
  );

  return (
    <NavigationShell
      navSections={namespacedSections}
      currentRoute={currentRoute}
      accountContext={accountContext}
      collapsibleSections
      // The platform console has exactly one workspace, so a constant key is
      // right here — AdminShell scopes its key by workspace slug because it
      // has many.
      sectionCollapsePersistKey="platform"
      showRailIdentity
      railIdentityHref={PLATFORM_OVERVIEW_HREF}
      onRailIdentityPress={handleRailIdentityPress}
      railIdentityLabel={t("admin.psGoToOverview") as string}
      onRouteSelect={(routeId) => {
        const href = routeId.startsWith("/")
          ? routeId
          : toNamespacedHref(routeId, { adminBasePath: PLATFORM_BASE_PATH });
        router.push(href);
      }}
      onReturnToConsumer={handleReturnToConsumer}
      returnToConsumerLabel={t("admin.psExitToAttendee") as string}
      returnToConsumerDescription={t("admin.psBrowseEvents") as string}
      brand={brandElement}
      navbarSearchSlot={<NavbarSearch testIdBase="platform-navbar-search" />}
      navbarTrailingSlot={(layout: NavigationShellLayout) =>
        layout === "mobile" ? (
          // Mobile top bar stays sparse (same rule as AdminShell): workspace
          // switcher + notifications only; theme moves into the drawer.
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
          </XStack>
        </YStack>
      }
    >
      <PageTransition>{children}</PageTransition>
    </NavigationShell>
  );
};

PlatformShell.displayName = "PlatformShell";

// ─────────────────────────────────────────────────────────────────────────────
// Page transition (mirrors AdminPageTransition)
// ─────────────────────────────────────────────────────────────────────────────

function PageTransition({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div
      style={{
        width: "100%",
        flex: 1,
        display: "flex",
        flexDirection: "column",
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(8px)",
        transition: "opacity 350ms ease-out, transform 350ms ease-out",
      }}
    >
      {children}
    </div>
  );
}
