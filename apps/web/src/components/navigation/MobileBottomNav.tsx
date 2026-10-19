"use client";

import { useCallback } from "react";
import { usePathname } from "next/navigation";
import { useRouter } from "@bprogress/next/app";
import { Compass, Calendar, Heart, Ticket, User } from "lucide-react";
import { YStack } from "tamagui";

import { Text, useTranslations } from "@th/ui";
import { useAppOverlay } from "@/components/layout/AppOverlayProvider";
import { useSessionVerdict } from "@/hooks/useSessionVerdict";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface NavTab {
  id: string;
  labelKey: string;
  href: string;
  icon: typeof Compass;
  /** If true, tab requires auth; tapping while signed-out opens sign-in. */
  requiresAuth?: boolean;
  /** Matcher: returns true if this tab should be considered "active". */
  isActive: (pathname: string) => boolean;
}

/* ------------------------------------------------------------------ */
/*  Tab definitions                                                    */
/* ------------------------------------------------------------------ */

const TABS: NavTab[] = [
  {
    id: "explore",
    labelKey: "common.navExplore",
    href: "/",
    icon: Compass,
    isActive: (p) => p === "/" || p === "",
  },
  {
    id: "events",
    labelKey: "common.navEvents",
    href: "/events",
    icon: Calendar,
    isActive: (p) => p.startsWith("/events"),
  },
  {
    id: "saved",
    labelKey: "saves.navSaved",
    href: "/saved",
    icon: Heart,
    requiresAuth: true,
    isActive: (p) => p.startsWith("/saved"),
  },
  {
    id: "tickets",
    labelKey: "common.navTickets",
    href: "/my-tickets",
    icon: Ticket,
    requiresAuth: true,
    isActive: (p) => p.startsWith("/my-tickets"),
  },
  {
    id: "account",
    labelKey: "common.navAccount",
    href: "/account",
    icon: User,
    requiresAuth: true,
    isActive: (p) => p.startsWith("/sign-in") || p.startsWith("/account"),
  },
];

/* ------------------------------------------------------------------ */
/*  Styles – using plain CSS for position:fixed (unsupported by RN)    */
/* ------------------------------------------------------------------ */

const barStyle: React.CSSProperties = {
  position: "fixed",
  bottom: 0,
  left: 0,
  right: 0,
  display: "flex",
  flexDirection: "row",
  justifyContent: "space-around",
  alignItems: "center",
  borderTop: "1px solid var(--borderColor)",
  background: "var(--surface)",
  paddingTop: 6,
  paddingBottom: "max(8px, env(safe-area-inset-bottom))",
  zIndex: 1000,
};

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const MobileBottomNav = () => {
  const t = useTranslations();
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const { showSignInOverlay } = useAppOverlay();
  // Read through `useSessionVerdict`, not `isPending`/`data`: Better Auth
  // reports "nobody is signed in" and "the lookup beat the freshly-set cookie"
  // identically, and this component turns that answer into an interruption.
  //
  // No hydration gate here, deliberately. `verdict` never reaches the rendered
  // output — it is read inside a press handler only — so unlike `AppNavbar`
  // there is no server/client markup to disagree about. Adding one would
  // change this component's first render for no reason.
  const { verdict } = useSessionVerdict();

  const handleTabPress = useCallback(
    (tab: NavTab) => {
      // Only a SETTLED signed-out answer earns the overlay. While the verdict
      // is unknown, navigate and let the route's own gate decide — showing a
      // signed-in user a sign-in prompt is the complaint this change exists
      // for, and the worst case here is a signed-out user landing on
      // `/sign-in?redirect_url=…` instead of seeing the overlay in place.
      if (tab.requiresAuth && verdict === "signedOut") {
        showSignInOverlay({ redirect: tab.href });
        return;
      }
      router.push(tab.href);
    },
    [router, showSignInOverlay, verdict],
  );

  return (
    <nav
      data-testid="mobile-bottom-nav"
      aria-label={t("common.mobileNav") as string}
      style={barStyle}
      role="tablist"
    >
      {TABS.map((tab) => {
        const active = tab.isActive(pathname);
        const Icon = tab.icon;
        return (
          <YStack
            key={tab.id}
            alignItems="center"
            justifyContent="center"
            gap={2}
            paddingVertical={2}
            paddingHorizontal="$2"
            flex={1}
            cursor="pointer"
            hoverStyle={{ backgroundColor: "$backgroundHover" }}
            pressStyle={{ scale: 0.96 }}
            onPress={() => handleTabPress(tab)}
            data-testid={`mobile-nav-${tab.id}`}
            role="tab"
            tabIndex={0}
            aria-selected={active}
            aria-label={String(t(tab.labelKey))}
          >
            <Icon
              size={22}
              strokeWidth={active ? 2.2 : 1.6}
              color={active ? "var(--accent)" : "var(--colorMuted)"}
              aria-hidden="true"
            />
            <Text
              variant="caption"
              weight={active ? "semibold" : "regular"}
              color={active ? "$accent" : "$colorMuted"}
              fontSize={12}
              lineHeight={16}
            >
              {String(t(tab.labelKey))}
            </Text>
          </YStack>
        );
      })}
    </nav>
  );
};

MobileBottomNav.displayName = "MobileBottomNav";

/**
 * Height of the bottom nav bar in px, used by the shell to add
 * matching bottom padding so content isn't hidden behind the bar.
 */
export const MOBILE_BOTTOM_NAV_HEIGHT = 58;
