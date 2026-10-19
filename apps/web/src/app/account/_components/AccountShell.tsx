"use client";

import { useEffect, useRef, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BadgeCheck,
  Bell,
  FileText,
  LayoutDashboard,
  Settings,
} from "lucide-react";
import { XStack, YStack, styled } from "tamagui";

import { Text, useLocale, useTranslations } from "@th/ui";

import { useDocumentTitleFallback } from "@/hooks/useDocumentTitle";

type AccountTab = {
  id: "overview" | "page" | "memberships" | "settings" | "notifications";
  href: string;
  icon: typeof LayoutDashboard;
  labelKey:
    | "account.overview"
    | "account.myPage"
    | "account.memberships"
    | "account.settings"
    | "account.notifications";
  matches: (pathname: string) => boolean;
};

const TABS: readonly AccountTab[] = [
  {
    id: "overview",
    href: "/account",
    icon: LayoutDashboard,
    labelKey: "account.overview",
    matches: (pathname) => pathname === "/account",
  },
  {
    id: "page",
    href: "/account/page",
    icon: FileText,
    labelKey: "account.myPage",
    matches: (pathname) => pathname.startsWith("/account/page"),
  },
  {
    id: "memberships",
    href: "/account/memberships",
    icon: BadgeCheck,
    labelKey: "account.memberships",
    matches: (pathname) => pathname.startsWith("/account/memberships"),
  },
  {
    id: "settings",
    href: "/account/settings",
    icon: Settings,
    labelKey: "account.settings",
    matches: (pathname) => pathname.startsWith("/account/settings"),
  },
  {
    id: "notifications",
    href: "/account/notifications",
    icon: Bell,
    labelKey: "account.notifications",
    matches: (pathname) => pathname.startsWith("/account/notifications"),
  },
] as const;

const Shell = styled(YStack, {
  width: "100%",
  minHeight: "100%",
});

const HeaderBar = styled(XStack, {
  paddingHorizontal: "$4",
  paddingVertical: "$3",
  alignItems: "center",
  gap: "$3",
  borderBottomWidth: 1,
  borderBottomColor: "$borderColor",
  backgroundColor: "$surface",
});

const TabBarContainer = styled(XStack, {
  borderBottomWidth: 1,
  borderBottomColor: "$borderColor",
  backgroundColor: "$surface",
  paddingHorizontal: "$4",
  alignItems: "center",
  gap: "$1",
});

const TabItem = styled(XStack, {
  flexDirection: "row",
  alignItems: "center",
  gap: "$2",
  paddingHorizontal: "$3",
  paddingVertical: "$3",
  minHeight: 44,
  borderBottomWidth: 2,
  borderBottomColor: "transparent",
  variants: {
    active: {
      true: {
        borderBottomColor: "$accent",
      },
    },
  },
});

const Content = styled(YStack, {
  width: "100%",
  flex: 1,
});

export function AccountShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const t = useTranslations();
  const locale = useLocale();
  const activeTab = TABS.find((tab) => tab.matches(pathname)) ?? TABS[0];

  const tabBarRef = useRef<HTMLDivElement>(null);

  // The strip scrolls inside its own container on narrow viewports. Bring the
  // active tab into view by moving the strip only (scrollIntoView would also
  // scroll the page).
  useEffect(() => {
    const bar = tabBarRef.current;
    if (!bar) return;
    const reveal = () => {
      const active = bar.querySelector<HTMLElement>('[aria-current="page"]');
      if (!active) return;
      const barBox = bar.getBoundingClientRect();
      const box = active.getBoundingClientRect();
      const left = box.left - barBox.left + bar.scrollLeft;
      bar.scrollLeft = Math.max(0, left - (barBox.width - box.width) / 2);
    };
    reveal();
    // Web fonts change label widths; re-centre once they have loaded.
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) reveal();
    });
    return () => {
      cancelled = true;
    };
  }, [pathname, locale]);

  useDocumentTitleFallback(
    `${t(activeTab.labelKey)} · ${t("common.navAccount")}`,
  );

  return (
    <Shell>
      <HeaderBar>
        <YStack gap="$1" flexShrink={1} minWidth={0}>
          <Text variant="caption" tone="muted">
            {t("account.navigate")}
          </Text>
          <Text
            tag="h1"
            variant="h3"
            weight="black"
            letterSpacing={-0.5}
            // Next rung of the type scale (h3 = $7 -> h4 = $6) on narrow
            // viewports so the longest es title fits on one line.
            $sm={{ fontSize: "$6", lineHeight: "$6" }}
            style={{ overflowWrap: "anywhere" }}
          >
            {t(activeTab.labelKey)}
          </Text>
        </YStack>
      </HeaderBar>
      <TabBarContainer ref={tabBarRef} style={{ overflowX: "auto" }}>
        {TABS.map((tab) => {
          const isActive = tab.matches(pathname);
          const Icon = tab.icon;

          return (
            <Link
              key={tab.id}
              href={tab.href}
              aria-current={isActive ? "page" : undefined}
              style={{ textDecoration: "none", flexShrink: 0 }}
            >
              <TabItem active={isActive}>
                <Icon
                  size={15}
                  aria-hidden
                  color={
                    isActive
                      ? "var(--accent, #E2481D)"
                      : "var(--colorMuted, #5C544A)"
                  }
                />
                <Text
                  variant="bodySmall"
                  weight={isActive ? "bold" : "medium"}
                  tone={isActive ? "default" : "muted"}
                >
                  {t(tab.labelKey)}
                </Text>
              </TabItem>
            </Link>
          );
        })}
      </TabBarContainer>
      <Content>{children}</Content>
    </Shell>
  );
}
