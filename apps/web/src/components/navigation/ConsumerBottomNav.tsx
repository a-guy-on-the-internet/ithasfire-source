"use client";

/**
 * Consumer mobile bottom navigation.
 *
 * The admin shell has had a fixed bottom bar since the navigation rework; the
 * public site never did, which is why every page action had to float. This is
 * the same `NavigationBottomBar` organism admin renders, mounted by `AppShell`
 * BELOW 960px only — desktop keeps its inline, page-owned actions untouched.
 *
 * Four fixed destinations plus ONE raised centre slot, which any page can fill
 * with its single primary action (`usePagePrimaryAction`). When no page
 * publishes one, the plain four-tab row renders.
 */

import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useRouter } from "@bprogress/next/app";
import {
  ArrowRight,
  Home,
  MessageCircle,
  Music,
  Search,
  Ticket,
} from "lucide-react";

import {
  NavigationBottomBar,
  useTranslations,
  type NavigationSection,
} from "@th/ui";

import { useIsCompactViewport } from "@/hooks/useIsCompactViewport";
import type { PublicLinkPage } from "@/i18n/public-paths";
import { usePublicLinks } from "@/i18n/use-public-links";
import { isUnderPath } from "@/middleware/path-match";
import {
  usePagePrimaryActionValue,
  useSupportOpenerValue,
} from "./page-primary-action";

/**
 * Routes that own full-bleed / chrome-free experiences. Most of these never
 * reach this component anyway — `AppChrome` renders them WITHOUT `AppShell`
 * (its `CHROME_BYPASS_*` lists) or hands them their own shell (`/admin`,
 * `/platform`). They are repeated here so the suppression survives a future
 * change to which branch mounts `AppShell`, and so `/qr-test` (a bare
 * diagnostic surface that DOES get the shell) is covered.
 */
const HIDDEN_PREFIXES = [
  "/sign-in",
  "/sign-up",
  "/login",
  "/auth",
  "/embed",
  "/access-denied",
  "/qr-test",
  "/admin",
  "/platform",
  // The Seller Hub renders `SellerShell` → `NavigationShell`, which brings its
  // OWN `NavigationBottomBar` on phones — but unlike `/admin` and `/platform`
  // it is NOT in `AppChrome`'s `CUSTOM_SHELL_PREFIXES`, so `AppShell` wraps it
  // too. Measured at 320 on `/sell/listings`: the consumer navbar and this bar
  // both render. Without this entry a gate-ON Seller Hub stacks two fixed
  // bottom bars on one phone screen, and `AppShell` reserves clearance for a
  // bar the page is already reserving for.
  "/sell",
  // Checkout is the one surface where global navigation is a liability. Four
  // destinations under a payment form are four ways to abandon a cart, and a
  // buyer mid-flow needs exactly ONE exit — the "Back to event" link in
  // `CheckoutInfoBar`, which returns them where they came from.
  //
  // The alternative considered and rejected: keep the bar and suppress only
  // its destinations. `NavigationBottomBar`'s contract is sections PLUS a
  // centre slot, so stripping the sections leaves an 85px slab holding one
  // 64px square — chrome that announces a navigation surface and delivers a
  // button. The step primary also wants the amount on it ("Pay $47.50"), and
  // a raised icon square cannot carry that. Checkout's own `MobileCTABar`
  // does, so it comes back here and owns the CTA full-width.
  "/events/checkout",
  // Resale is the OTHER checkout — different path, same payment form, same
  // rule (2026-08-30). Its primary is literally "Pay $47.50" and it already
  // carries exactly one exit ("← Back to event"), so putting four global
  // destinations under it would reintroduce precisely what the entry above
  // exists to prevent.
  "/events/resale",
] as const;

/** Stable id for the centre slot — never equal to a `currentRoute`. */
const CENTER_ACTION_ID = "mobile-primary";

/**
 * Live height of the bar, published on `<html>` while it is mounted so other
 * FIXED, body-portaled elements can sit clear of it (the audio mini-player is
 * the first). Absent when the bar is not rendered, so every consumer's
 * `var(--consumer-bottom-nav-height, 0px)` fallback is the desktop truth.
 *
 * Measured rather than assumed: the bar's own padding resolves through
 * `env(safe-area-inset-bottom)`, which differs between a browser tab and an
 * installed PWA on the same device.
 */
export const CONSUMER_BOTTOM_NAV_HEIGHT_VAR = "--consumer-bottom-nav-height";

/** Sentinel "route" for the Support tab — opens a panel instead of navigating. */
const SUPPORT_ROUTE = "#support";

interface ConsumerTab {
  id: string;
  route: string;
  /**
   * A page with language twins: the tab goes to it in the language of the
   * page in view (`/es` from an /es page; spanish-seo FR-006), and `route`
   * is unused.
   */
  page?: PublicLinkPage;
  labelKey: string;
  icon: ReactNode;
  /** Route families that light this tab up; `route` is the resolved one. */
  isActive: (pathname: string, route: string) => boolean;
}

const TABS: ConsumerTab[] = [
  {
    id: "home",
    route: "/",
    page: { kind: "home" },
    labelKey: "common.navHome",
    icon: <Home />,
    isActive: (p, route) => p === route,
  },
  {
    id: "search",
    route: "/search",
    labelKey: "common.search",
    icon: <Search />,
    isActive: (p) => p === "/search" || p.startsWith("/search/"),
  },
  {
    id: "tickets",
    route: "/my-tickets",
    labelKey: "common.navTickets",
    icon: <Ticket />,
    isActive: (p) => p === "/my-tickets" || p.startsWith("/my-tickets/"),
  },
  {
    // Support is a DESTINATION, not a floating bubble (user decision
    // 2026-08-28). The bubble is desktop-only again: on phones a floating
    // launcher competes with page controls — measured, it covered the venue hero's
    // "⋯", which is the only mobile route to Report/Claim.
    //
    // `route` is a sentinel, not a URL: selecting it opens the support panel in
    // place via the action the widget publishes. Account is deliberately NOT
    // here — it already lives in the top navbar's avatar menu, and a fifth tab
    // does not fit beside the 64px centre square at 320px (measured: four tabs
    // + square + gaps = 291 of 320).
    id: "support",
    route: SUPPORT_ROUTE,
    labelKey: "common.navSupport",
    icon: <MessageCircle />,
    isActive: () => false,
  },
];

/**
 * Glyph for the raised centre square, chosen from the route family rather than
 * published by the page: the store carries a label and a callback only, and an
 * icon token there would be a second thing to keep in sync.
 */
const centerIconForRoute = (pathname: string): ReactNode => {
  if (pathname.startsWith("/events")) return <Ticket />;
  if (pathname.startsWith("/p/") || pathname.startsWith("/places"))
    return <Music />;
  return <ArrowRight />;
};

/**
 * Whether the consumer bottom nav is currently mounted.
 *
 * Exported so the shell can reserve matching bottom clearance, and so the one
 * page that already ships a fixed bottom bar (checkout's `MobileCTABar`) can
 * stand down instead of stacking two docks on a phone. Returns `false` during
 * SSR and the first client render, like every other viewport hook here.
 */
export function useConsumerBottomNavVisible(): boolean {
  const pathname = usePathname() ?? "/";
  const isCompact = useIsCompactViewport();
  if (!isCompact) return false;
  return !HIDDEN_PREFIXES.some((prefix) => isUnderPath(pathname, prefix));
}

export const ConsumerBottomNav = () => {
  const t = useTranslations();
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const visible = useConsumerBottomNavVisible();
  const primary = usePagePrimaryActionValue();
  // The support widget publishes its open-panel action here; the tab is inert
  // on routes where the widget suppresses itself.
  const openSupport = useSupportOpenerValue();
  const links = usePublicLinks();

  const sections: NavigationSection[] = useMemo(
    () => [
      {
        id: "consumer",
        label: String(t("common.mobileNav")),
        items: TABS.map((tab) => {
          const route = tab.page ? links.path(tab.page) : tab.route;
          return {
            id: tab.id,
            label: String(t(tab.labelKey)),
            route,
            icon: tab.icon,
            active: tab.isActive(pathname, route),
          };
        }),
      },
    ],
    [pathname, t, links],
  );

  const handleSelect = useCallback(
    (route: string) => {
      if (route === SUPPORT_ROUTE) {
        // No-op when the widget is not mounted on this route (it suppresses
        // itself on auth/embed surfaces) — better a dead tab than a navigation
        // to "#support".
        openSupport?.();
        return;
      }
      router.push(route);
    },
    [router, openSupport],
  );

  const centerAction = useMemo(
    () =>
      primary
        ? {
            id: CENTER_ACTION_ID,
            label: primary.label,
            ariaLabel: primary.ariaLabel,
            icon: centerIconForRoute(pathname),
            onPress: primary.onPress,
            testId: "consumer-bottom-nav-primary",
          }
        : undefined,
    [pathname, primary],
  );

  useEffect(() => {
    const root = document.documentElement;
    const clear = () =>
      root.style.removeProperty(CONSUMER_BOTTOM_NAV_HEIGHT_VAR);
    if (!visible) {
      clear();
      return;
    }
    const el = document.querySelector('[data-testid="navigation-bottom-bar"]');
    if (!el) {
      clear();
      return;
    }
    const apply = () =>
      root.style.setProperty(
        CONSUMER_BOTTOM_NAV_HEIGHT_VAR,
        `${Math.round(el.getBoundingClientRect().height)}px`,
      );
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => {
      observer.disconnect();
      clear();
    };
  }, [visible]);

  // Every hook above runs unconditionally so the bar can appear/disappear with
  // the viewport without changing hook order.
  if (!visible) return null;

  return (
    <nav aria-label={String(t("common.mobileNav"))}>
      <NavigationBottomBar
        sections={sections}
        currentRoute={pathname}
        onSelect={handleSelect}
        centerAction={centerAction}
      />
    </nav>
  );
};

ConsumerBottomNav.displayName = "ConsumerBottomNav";

/**
 * Vertical space `AppShell` reserves at the bottom of the page so the fixed bar
 * never covers content. Same number the admin shells reserve: the bar is ~71px
 * (2px rule + 12px pad + ~45px item + 12px pad) and up to ~93px once the iOS
 * home-indicator inset lands, so 96 clears it with a little air.
 */
export const CONSUMER_BOTTOM_NAV_CLEARANCE = 96;
