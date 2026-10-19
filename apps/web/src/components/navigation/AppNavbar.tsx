"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "@bprogress/next/app";
import { Heart, Menu } from "lucide-react";
import { XStack, styled } from "tamagui";
import { AlertsSidebar, Button, Navbar, useTranslations } from "@th/ui";
import { useAlertsSidebarI18n } from "@/components/notifications/useAlertsSidebarI18n";
import { getLastAdminSlug, clearLastAdminSlug } from "@/lib/last-admin-context";
import { trpc } from "@/trpc";
import {
  useEventOwnerEntities,
  type OwnerEntityWithSlug,
} from "@/hooks/useEventOwnerEntities";
import { normalizeAdminSlug, useAdminSlug } from "@/hooks/useAdminSlug";
import { useAppOverlay } from "@/components/layout/AppOverlayProvider";
import {
  SHELL_GUTTER,
  SHELL_GUTTER_MOBILE,
  SHELL_MAX_WIDTH,
} from "@/components/layout/shell-metrics";
import { useCurrentUrl } from "@/hooks/useCurrentUrl";
import { useIsDarkTheme } from "@/hooks/useIsDarkTheme";
import { NavbarSearch } from "@/components/search/NavbarSearch";
import { MobileNavMenu } from "@/components/navigation/MobileNavMenu";
import { useHoldNavbarShown } from "@/components/navigation/navbar-hold-store";
import { ThemeToggleButton } from "@/components/theme/ThemeToggleButton";
import { ProfileMenu } from "@/components/auth/ProfileMenu";
import {
  AccountManagementPopover,
  type AccountMenuNextNight,
  type AccountMenuOrganization,
} from "@/components/auth/AccountManagementPopover";
import { authClient } from "@/lib/auth/auth-client";
import { useSessionVerdict } from "@/hooks/useSessionVerdict";
import { MOBILE_BREAKPOINT } from "@/hooks/useIsMobile";
import { PUBLIC_NAV_BREAKPOINT } from "@/hooks/useIsPublicNavCompact";
import { LanguageSwitcher } from "@/components/i18n/LanguageSwitcher";
import { usePublicLinks } from "@/i18n/use-public-links";
import { NotificationInboxContainer } from "@/components/notifications/NotificationInboxContainer";
import { useCreateDraftEvent } from "@/hooks/useCreateDraftEvent";

const BrandButton = styled(XStack, {
  name: "AppNavbarBrandButton",
  alignItems: "center",
  // Left-anchored, shrinkable. The shared Navbar's BrandSlot gives up width
  // on narrow phones ($sm safety valve), but the old `justifyContent:
  // "center"` + non-shrinking 160px lockup meant the image bled symmetrically
  // out of the shrunken slot — its LEFT edge went negative and was clipped at
  // x=0. minWidth 0 + maxWidth 100% let the constraint reach the <Image>,
  // which scales down (objectFit contain) pinned to the left instead.
  justifyContent: "flex-start",
  paddingHorizontal: 0,
  position: "relative",
  overflow: "visible",
  minWidth: 0,
  maxWidth: "100%",
});

const ActionGroup = styled(XStack, {
  gap: "$2",
  alignItems: "center",
});

/**
 * The bar's breakpoint tiers, as CSS classes.
 *
 * TWO stages, not one. Below `PUBLIC_NAV_BREAKPOINT` (900, the folder's number
 * for the public nav) the burger appears and the set-once preferences move
 * into the sheet. Below `MOBILE_BREAKPOINT` (600, the bar's own space budget)
 * the saved-heart, My Tickets and the search trigger come out too. Collapsing
 * both into one breakpoint would either duplicate the theme toggle in the bar
 * AND the sheet (at 900) or strand notifications for 300px of viewport (at
 * 600).
 *
 * Media queries, NOT `useIsMobile()` / `useIsPublicNavCompact()`. Both hooks
 * answer `false` on the server and on the first client render, so a
 * JS-branched bar painted the DESKTOP controls at every width and swapped in
 * the narrow bar after hydration: 0.166 CLS on every AppShell page at 320,
 * with the bar shrinking 69 → 65px and dragging `#main-content` up with it.
 * Here the server HTML already carries every control and the stylesheet picks
 * which ones show, so first paint is the final layout at any width.
 *
 * `display: none` (not `visibility`) on purpose: a hidden control also leaves
 * the accessibility tree and the tab order, exactly as an unmounted one did.
 * Each wrapper is `display: contents` otherwise, so the control inside stays
 * the ActionGroup's flex item and the `$2` gap is unchanged.
 *
 * Below 600 the shared Navbar's SearchSlot itself is hidden, not just the
 * trigger inside it: an empty `flex: 1` slot would still cost the row one gap
 * and squeeze the brand by 8px. The rule targets the slot by the `data-qa` id
 * Navbar derives from our `testIdBase` (`<base>-search`), so it reaches that
 * one element and nothing else. It is `!important` because the slot is a
 * Tamagui element whose own atomic `display: flex` class has the same
 * specificity, and which of the two wins would otherwise come down to the
 * order the stylesheets happened to load in.
 *
 * The `max-width` bounds sit at `<breakpoint> - 0.02px` rather than `- 1px`:
 * at a fractional viewport width (browser zoom, some Android DPRs) a 599.5px
 * window matches neither `max-width: 599px` nor `min-width: 600px`, and every
 * tier would show at once.
 *
 * Rendered as a <style> element in the JSX (the HomeHero pattern) so it ships
 * in the SSR HTML; the thresholds come from the hooks' own constants so the
 * two can never drift.
 */
const NAV_WIDE = "th-appnav-slot th-appnav-wide"; // ≥ 900 only
const NAV_ROOMY = "th-appnav-slot th-appnav-roomy"; // ≥ 600 only
const NAV_COMPACT = "th-appnav-slot th-appnav-compact"; // < 900 only

/** `testIdBase` for the bar; the search-slot rule below keys on it. */
const NAVBAR_TEST_ID = "web-navbar";
const COMPACT_MAX = `${PUBLIC_NAV_BREAKPOINT - 0.02}px`;
const MOBILE_MAX = `${MOBILE_BREAKPOINT - 0.02}px`;

export const APP_NAVBAR_CSS = `
.th-appnav-slot { display: contents; }
@media (min-width: ${PUBLIC_NAV_BREAKPOINT}px) {
  .th-appnav-slot.th-appnav-compact { display: none; }
}
@media (max-width: ${COMPACT_MAX}) {
  .th-appnav-slot.th-appnav-wide { display: none; }
}
@media (max-width: ${MOBILE_MAX}) {
  .th-appnav-slot.th-appnav-roomy { display: none; }
  [data-qa="${NAVBAR_TEST_ID}-search"] { display: none !important; }
}
`;

// v2 nav grammar: "Sign In" is the nav's ghost button — square, transparent,
// atom-styled label (uppercase 700 / +1.5 tracking via the Button atom). The
// retired pill treatment (radius 999 + white-alpha chrome) must not return.
const SignInButton = ({
  onPress,
  reserved = false,
}: {
  onPress: () => void;
  /**
   * Render the CTA's FOOTPRINT without the CTA — `visibility: hidden`, which
   * keeps the layout box while removing the control from the accessibility
   * tree AND the tab order (neither `opacity: 0` nor `aria-hidden` alone does
   * both). Used for the `unknown` window, where "SIGN IN" would be a claim
   * about the reader we cannot yet make — the exact claim that greeted someone
   * who had just typed their password.
   *
   * The test id goes on the wrapper, never the hidden button: a spec asserting
   * "signed out shows sign in" must not pass against a reservation.
   */
  reserved?: boolean;
}) => {
  const t = useTranslations();
  const button = (
    <Button
      size="$3"
      variant="ghost"
      onPress={onPress}
      data-testid={reserved ? undefined : "navbar-account"}
      tabIndex={reserved ? -1 : undefined}
    >
      {String(t("auth.signIn"))}
    </Button>
  );
  if (!reserved) return button;
  return (
    <span
      style={{ visibility: "hidden", display: "inline-flex" }}
      data-testid="navbar-account-reserved"
    >
      {button}
    </span>
  );
};

export const AppNavbar = () => {
  const [menuOpen, setMenuOpen] = useState(false);
  const t = useTranslations();
  // Bell name and panel labels in the user's language.
  const { formatButtonLabel: formatBellLabel, labels: alertsLabels } =
    useAlertsSidebarI18n();
  const router = useRouter();
  const { showSignInOverlay } = useAppOverlay();
  const currentPath = useCurrentUrl({ absolute: false });
  const resolvedPath = currentPath ?? "";
  // The logo goes home in this page's language: `/es` from an /es page
  // (spanish-seo FR-006).
  const homePath = usePublicLinks().path({ kind: "home" });
  // Which controls show at which width is CSS, not a hook: see
  // `APP_NAVBAR_CSS` above for the two stages and why.
  // `useIsDarkTheme()` resolves the active base theme ("ember" = dark, else
  // Stub/light) — same detection HomeHero uses. Drives the brand lockup so
  // the wordmark stays legible against the theme's navbar chrome.
  const isDark = useIsDarkTheme();
  const suppressAuxAuthQueries =
    !currentPath ||
    resolvedPath.startsWith("/admin") ||
    resolvedPath.startsWith("/platform") ||
    resolvedPath.startsWith("/sign-in") ||
    resolvedPath.startsWith("/sign-up") ||
    resolvedPath.startsWith("/login");

  // Better Auth is the source of truth for auth state, read through
  // `useSessionVerdict` rather than `isPending`/`data` directly. Reading it
  // raw meant one `/get-session` that answered "nobody" — including one whose
  // request beat a freshly-set cookie — painted SIGN IN at somebody who had
  // just signed in, and nothing re-checked.
  //
  // THREE states now, not two. `hasMounted` still gates it: the server cannot
  // know the session, so the first client render has to match what the server
  // emitted or React throws the tree away.
  const { verdict, markSignedOut } = useSessionVerdict();
  const [hasMounted, setHasMounted] = useState(false);
  useEffect(() => {
    setHasMounted(true);
  }, []);
  const sessionState: "unknown" | "signedIn" | "signedOut" = !hasMounted
    ? "unknown"
    : verdict;
  const isSignedIn = sessionState === "signedIn";
  /** Nothing session-dependent may be ASSERTED yet — see `SignInButton`. */
  const sessionUnknown = sessionState === "unknown";

  trpc.entityPages.getMyProfile.useQuery(
    {},
    {
      retry: false,
      staleTime: 60_000,
      // Only query profile when authenticated
      enabled: isSignedIn && !suppressAuxAuthQueries,
    },
  );

  const ownerEntitiesQuery = useEventOwnerEntities({
    enabled: !suppressAuxAuthQueries,
  });
  const { toAdminHref } = useAdminSlug("");

  // Staff access check — only fires when signed in on shopper-facing routes.
  const staffAccessQuery = trpc.platform.checkStaffAccess.useQuery(undefined, {
    enabled: isSignedIn && !suppressAuxAuthQueries,
    retry: false,
    staleTime: 5 * 60_000,
  });
  const isStaff = staffAccessQuery.data?.allowed === true;

  // Unread notification count for the bell badge. Polls so the badge stays
  // current without a live push (the SSE subscription is not wired to Redis).
  const unreadCountQuery = trpc.notifications.countUnread.useQuery(undefined, {
    enabled: isSignedIn && !suppressAuxAuthQueries,
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
  const unreadCount = unreadCountQuery.data?.count;

  // Resolve the admin slug for navbar links.
  // `preferredAdminSlug` is derived from the *current* user's owner entities.
  // `getLastAdminSlug()` reads a localStorage value that may belong to a
  // *different* user (e.g. when switching accounts without signing out first).
  // Only use the localStorage fallback when it matches one of the current
  // user's allowed slugs; otherwise fall back to `/admin` which will route
  // the user to their own workspace or the entity picker.
  const adminSlug = useMemo(() => {
    if (ownerEntitiesQuery.preferredAdminSlug) {
      return ownerEntitiesQuery.preferredAdminSlug;
    }
    // Defer the localStorage fallback until after hydration — reading it
    // during the first client render produces a different href than SSR
    // (which has no `window`) and trips React's hydration mismatch.
    if (!hasMounted) return null;
    const stored = getLastAdminSlug();
    if (!stored) return null;

    // If owner entities haven't loaded yet, don't use the stale slug —
    // fall back to the generic `/admin` route which handles auth/routing.
    const owners = ownerEntitiesQuery.ownersWithSlugs;
    if (!owners) return null;

    const isValid = owners.some(
      (o) => normalizeAdminSlug(o.adminSlug) === normalizeAdminSlug(stored),
    );
    return isValid ? stored : null;
  }, [
    hasMounted,
    ownerEntitiesQuery.preferredAdminSlug,
    ownerEntitiesQuery.ownersWithSlugs,
  ]);

  // Performer mode decides whether the account menu shows "Playing". Same
  // key + options as PerformerModeToggle so react-query shares one request.
  // Fails closed: hidden while loading and on error.
  const performerStatusQuery = trpc.performers.getMyStatus.useQuery(undefined, {
    staleTime: 30_000,
    retry: false,
    meta: { silent: true },
    enabled: isSignedIn && !suppressAuxAuthQueries,
  });
  const performerModeOn = performerStatusQuery.data?.human.enabled === true;

  // The viewer's next night (ticket, RSVP or lineup) heads the account menu.
  // Fails closed: no block while loading, on error, or when nothing is coming.
  const nextNightQuery = trpc.humans.getMyNextNight.useQuery(undefined, {
    staleTime: 60_000,
    retry: false,
    meta: { silent: true },
    enabled: isSignedIn && !suppressAuxAuthQueries,
  });
  const nextNight = useMemo<AccountMenuNextNight | null>(() => {
    // React Query keeps the last data when a refetch fails; an errored read
    // still hides the block.
    if (nextNightQuery.isError) return null;
    const night = nextNightQuery.data;
    if (!night) return null;
    return {
      kind: night.kind,
      title: night.title,
      startsAt: night.startsAt,
      timezone: night.timezone,
      placeLabel: night.placeLabel ?? null,
      ticketCount: night.ticketCount ?? null,
      // The popover labels the button by kind, so the target follows kind too.
      // A ticket holder lands on their order (the door ticket), or on the
      // /my-tickets list when every ticket they hold came by transfer and no
      // order is theirs. RSVPs and lineups open the event.
      href:
        night.kind === "ticket"
          ? night.orderId
            ? `/my-tickets/${night.orderId}`
            : "/my-tickets"
          : `/events/${night.slug ?? night.eventId}`,
    };
  }, [nextNightQuery.data, nextNightQuery.isError]);

  const accountMenu = useMemo(() => {
    const owners = ownerEntitiesQuery.ownersWithSlugs ?? [];
    const human = owners.find(
      (o): o is Extract<OwnerEntityWithSlug, { kind: "human" }> =>
        o.kind === "human",
    );
    const organizations: AccountMenuOrganization[] = owners.flatMap((o) =>
      o.kind === "org"
        ? [
            {
              slug: o.orgSlug,
              name: o.orgName,
              role: o.role,
              avatarUrl: o.avatarUrl,
              href: toAdminHref(o.adminSlug),
            },
          ]
        : [],
    );
    return {
      identity: human
        ? {
            name: human.humanName,
            handle: human.humanUsername,
            avatarUrl: human.avatarUrl,
          }
        : undefined,
      // Before the owners load there is no personal slug yet; `/admin`
      // routes the person to their own workspace or the picker.
      hub: { href: human ? toAdminHref(human.adminSlug) : "/admin" },
      organizations,
      myLineups: performerModeOn ? { href: "/my-lineups" } : undefined,
      platform: isStaff ? { href: "/platform" } : undefined,
    };
  }, [ownerEntitiesQuery.ownersWithSlugs, toAdminHref, performerModeOn, isStaff]);

  // Draft-creation hook — safe to call even when adminSlug is null; the
  // mutation simply won't fire until a valid owner is resolved.
  const { createDraft: handleCreateEvent, modeChoiceDialog } =
    useCreateDraftEvent(adminSlug ?? "");

  const handleMyTickets = useCallback(() => {
    router.push("/my-tickets");
  }, [router]);

  const handleSaved = useCallback(() => {
    router.push("/saved");
  }, [router]);

  const handleAccountPress = useCallback(() => {
    showSignInOverlay({ redirect: resolvedPath || "/" });
  }, [resolvedPath, showSignInOverlay]);

  const handleSignOut = useCallback(async () => {
    // If the current page requires auth, redirect home — otherwise the user
    // would stare at a "not signed in" stub. On public pages (events,
    // places, search, profiles, etc.) the page is signed-out-safe, so
    // staying put is the less jarring UX.
    const isAuthGatedPath =
      resolvedPath.startsWith("/admin") ||
      resolvedPath.startsWith("/platform") ||
      resolvedPath.startsWith("/account") ||
      resolvedPath.startsWith("/my-tickets") ||
      resolvedPath.startsWith("/sell") ||
      resolvedPath.startsWith("/sign-in") ||
      resolvedPath.startsWith("/sign-up") ||
      resolvedPath.startsWith("/login");

    await authClient.signOut({
      fetchOptions: {
        onSuccess: () => {
          clearLastAdminSlug();
          // LOAD-BEARING on a public page. `useSessionVerdict` latches
          // signed-in so a transient null cannot demote the bar, and this
          // navbar deliberately STAYS PUT when the current route is not auth
          // gated — so without disarming the latch by hand, signing out on
          // `/events` would leave the avatar and the bell sitting there.
          markSignedOut();
          if (isAuthGatedPath) {
            router.push("/");
          }
        },
      },
    });
  }, [markSignedOut, resolvedPath, router]);

  const renderInbox = useCallback(() => <NotificationInboxContainer />, []);

  // Signed-in account menu — one instance at every width, so every width opens
  // the exact same full account popover (My Tickets / manage account / sign
  // out / etc.). Only the surrounding controls differ (600 and up adds the
  // saved-heart + My Tickets buttons).
  // The bell also shows at every width. It carries the unread BADGE, which is
  // the whole point of it — a count buried in a menu tells you nothing you did
  // not already have to open the menu to learn. Nothing else surfaces
  // notifications (the bottom bar does not, and the sidebar it opens is
  // uncontrolled, so a sheet row cannot open it), so below 600 this was simply
  // unreachable. Saved events have no menu row of their own: the popover's
  // My Tickets row (/my-tickets) shows tickets and hearted events together, and
  // it renders at every width.
  // The panel owns the viewport while it is open, so the navbar it hangs off
  // has to stay put: this instance renders inside `ScrollAwareNavbar`, which
  // auto-hides on mobile scroll-down, and a bar that slid away before the
  // panel opened leaves Escape restoring focus to a bell nobody can see or
  // tap. (The admin and platform shells render their own AlertsSidebar with no
  // scroll-aware navbar above it, so only this instance takes the hold.)
  // The sidebar can unmount while open: signing out drops it. (Crossing a
  // breakpoint no longer does — the bar is one tree at every width and only
  // CSS changes.) AlertsSidebar reports `false` when it unmounts open, which
  // releases the hold; `isSignedIn` stays in the condition as a second guard
  // for sign-out.
  const [alertsOpen, setAlertsOpen] = useState(false);
  useHoldNavbarShown(alertsOpen && isSignedIn);

  const alertsEl = isSignedIn ? (
    <AlertsSidebar
      buttonLabel={t("common.openNotifications") as string}
      formatButtonLabel={formatBellLabel}
      labels={alertsLabels}
      unreadCount={unreadCount}
      renderInbox={renderInbox}
      onOpenChange={setAlertsOpen}
    />
  ) : null;

  // Shown at every width under 900 (`NAV_COMPACT`), not just the narrow bar —
  // the sheet is the overflow for Browse / Preferences / Organisers there.
  const menuButtonEl = (
    <Button
      size="$3"
      variant="ghost"
      onPress={() => setMenuOpen(true)}
      aria-label={String(t("common.menu"))}
      data-testid="navbar-menu"
    >
      <Menu size={20} aria-hidden />
    </Button>
  );

  const profileMenuEl = (
    <AccountManagementPopover
      testIdBase="navbar-profile"
      identity={accountMenu.identity}
      nextNight={nextNight}
      myTickets={{ href: "/my-tickets" }}
      myRsvps={{ href: "/my-rsvps" }}
      myLineups={accountMenu.myLineups}
      hub={accountMenu.hub}
      organizations={accountMenu.organizations}
      allOrganizations={{ href: "/admin" }}
      onCreateEvent={adminSlug ? () => void handleCreateEvent() : undefined}
      platform={accountMenu.platform}
      manageAccount={{ href: "/account/settings" }}
      onSignOutAction={() => void handleSignOut()}
      defaultOpen={process.env.NODE_ENV === "test"}
      trigger={
        <ProfileMenu
          testIdBase="navbar-profile"
          // v2: icon-only chrome buttons are square ghost buttons. $4 = 44px,
          // the touch-target minimum — this trigger also renders on mobile.
          // The circular avatar INSIDE the trigger is the allowed exception.
          size="$4"
          icon
          onPressAction={() => {
            // Intentionally empty: Floating UI attaches its own click handler
            // directly to this trigger. Passing a function avoids Tamagui/React
            // warnings about missing handlers.
          }}
        />
      }
    />
  );

  return (
    <>
      <Navbar
        brand={
          <Link
            href={homePath}
            aria-label={t("common.goToHome") as string}
            // minWidth 0: the Link is BrandSlot's flex item — its default
            // `min-width: auto` floored it at the lockup's intrinsic 160px, so
            // the slot's $sm shrink pushed the centered image to a negative x
            // (left edge clipped at the screen edge on narrow phones).
            style={{
              display: "inline-flex",
              textDecoration: "none",
              minWidth: 0,
              maxWidth: "100%",
            }}
          >
            <BrandButton>
              <Image
                src={
                  isDark
                    ? "/brand/ithasfire-lockup-white.png"
                    : "/brand/ithasfire-lockup-black.png"
                }
                alt="Ithas Fire"
                width={160}
                height={40}
                priority
                // maxWidth + contain + left anchoring: when the brand slot is
                // squeezed, the lockup scales down from its right edge instead
                // of overflowing (and clipping) on the left.
                style={{
                  width: "auto",
                  height: 40,
                  maxWidth: "100%",
                  objectFit: "contain",
                  objectPosition: "left center",
                }}
              />
            </BrandButton>
          </Link>
        }
        searchAccessory={
          // Mounted at every width and hidden below 600 by `APP_NAVBAR_CSS`
          // (slot and all). It is a bare trigger — no queries, no global key
          // listener (⌘K belongs to SpotlightSearch) — so the hidden instance
          // costs nothing.
          <div className={NAV_ROOMY}>
            {/* Match the shared SearchSlot's own cap. The slot is `flex: 1`, so
              it eats the row's slack before TrailingSlot's `marginLeft: auto`
              can; with the trigger capped at its 600 default the widened row
              left a ~364px hole between the search box and the controls. */}
            <NavbarSearch testIdBase="navbar-search" maxWidth={820} />
          </div>
        }
        trailingAccessory={
          // ONE group at every width; `APP_NAVBAR_CSS` decides what shows.
          // Every control is mounted once — the bell, the profile menu and
          // the create-event dialog each own queries, portals and test ids
          // that a second copy would duplicate. Visual order per width:
          //   ≥ 900   theme · language · (sign in | bell · saved · tickets · profile)
          //   600–899 (sign in | bell · saved · tickets · profile) · menu
          //   < 600   (sign in | bell · profile) · menu
          <ActionGroup>
            <style dangerouslySetInnerHTML={{ __html: APP_NAVBAR_CSS }} />
            {/* Set once, then never again — so below 900 they stop earning
              bar width and move into the sheet's Preferences group. Hidden
              rather than duplicated: showing a theme toggle in the bar AND a
              THEME row in the sheet is two controls for one setting. */}
            <div className={NAV_WIDE}>
              <ThemeToggleButton />
            </div>
            <div className={NAV_WIDE}>
              <LanguageSwitcher />
            </div>
            {!isSignedIn ? (
              // Signed out — or not yet known, in which case the button is
              // reserved rather than shown: it holds its own width so the
              // bar does not jump when the answer turns out to be
              // "signed out" (the common case), and asserts nothing in the
              // meantime. Same footprint at every width.
              <SignInButton
                onPress={handleAccountPress}
                reserved={sessionUnknown}
              />
            ) : (
              <>
                {/* AlertsSidebar's own trigger is already the v2 atom: a
                  square ghost icon Button with aria-label + zero radius. */}
                {alertsEl}
                {/* Below 600 these two go: they were costing the 320px bar
                  the width the wordmark needs, and the profile popover's My
                  Tickets row covers both. */}
                <div className={NAV_ROOMY}>
                  <Button
                    size="$4"
                    variant="ghost"
                    icon
                    aria-label={t("saves.navSaved") as string}
                    onPress={handleSaved}
                    data-testid="navbar-saved"
                  >
                    <Heart size={18} strokeWidth={2.25} aria-hidden />
                  </Button>
                </div>
                <div className={NAV_ROOMY}>
                  <Button
                    size="$3"
                    variant="ghost"
                    onPress={handleMyTickets}
                    data-testid="navbar-my-tickets"
                  >
                    {String(t("account.myTickets"))}
                  </Button>
                </div>
                {profileMenuEl}
              </>
            )}
            <div className={NAV_COMPACT}>{menuButtonEl}</div>
            {/* Portals to document.body — moderators only. */}
            {modeChoiceDialog}
          </ActionGroup>
        }
        border="none"
        // The nav is full-bleed chrome and shares the shell's grid, so the
        // brand lockup lands on the same left edge as the page body and the
        // footer wordmark. It used to cap at 1200 inside a 1440 page, which put
        // the lockup 120px inboard of the hero headline at 1600w.
        //
        // `contentMaxWidth` is Navbar's documented prop for this; it applies
        // maxWidth/marginHorizontal/width AFTER the loose row props, so passing
        // those three by hand would have lost silently the day anyone added it.
        contentMaxWidth={SHELL_MAX_WIDTH}
        paddingHorizontal={SHELL_GUTTER}
        // NavbarRow's own `$sm` block sets 8px of padding, so the mobile gutter
        // has to be restated at the same breakpoint — a base-level prop cannot
        // outrank a media rule. Tamagui deep-merges `$`-prefixed props per
        // property (`mergeProp` in @tamagui/web), so this replaces only the
        // padding; the block's `gap: "$2"` narrow-phone fix survives untouched.
        $sm={{ paddingHorizontal: SHELL_GUTTER_MOBILE }}
        testIdBase={NAVBAR_TEST_ID}
        aria-label={t("common.mainNavigation") as string}
      />
      {/* Portals to document.body; renders nothing while closed. */}
      <MobileNavMenu open={menuOpen} onClose={() => setMenuOpen(false)} />
    </>
  );
};

AppNavbar.displayName = "AppNavbar";
