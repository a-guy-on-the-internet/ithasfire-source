"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { useRouter } from "@bprogress/next/app";
import { BrandLockup } from "@/components/navigation/BrandLockup";
import { ThemeToggleButton } from "@/components/theme/ThemeToggleButton";
import { XStack, YStack } from "tamagui";

import {
  NavigationShell,
  Text,
  namespaceNavSections,
  parseNamespacedPathname,
  toNamespacedHref,
  useTranslations,
  type AccountContext,
  type NavigationSection,
  type NavigationShellLayout,
} from "@th/ui";

import { authClient } from "@/lib/auth/auth-client";
import { useDocumentTitleFallback } from "@/hooks/useDocumentTitle";

export type SellerShellProps = {
  sections: NavigationSection[];
  children: ReactNode;
};

const SELL_BASE_PATH = "/sell";

const SELL_CONTEXT: AccountContext = {
  id: "seller",
  label: "Seller Hub",
  type: "personal",
  defaultRoute: "listings",
};

// Status screens render outside the Tamagui tree — mirror AdminShell's
// Montserrat-first stack (body copy must not fall back to system/Roboto).
const STATUS_FONT_FAMILY =
  "'Montserrat', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji'";

/**
 * Shell for the /sell/** seller-facing area.
 *
 * Requires authenticated user. No org switching — purely personal context.
 */
export const SellerShell = ({ sections, children }: SellerShellProps) => {
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations();
  const { data: session, isPending: isSessionLoading } =
    authClient.useSession();

  const isSignedIn = !!session?.user;

  // Translate label keys
  const translatedSections = useMemo(
    () =>
      sections.map((section) => ({
        ...section,
        label: String(t(section.label)),
        items: section.items.map((item) => ({
          ...item,
          label: String(t(item.label)),
        })),
      })),
    [sections, t],
  );

  const { sections: namespacedSections } = useMemo(
    () =>
      namespaceNavSections(translatedSections, {
        adminBasePath: SELL_BASE_PATH,
      }),
    [translatedSections],
  );

  const currentRoute =
    parseNamespacedPathname(pathname, {
      adminBasePath: SELL_BASE_PATH,
      fallbackRouteId: sections[0]?.items[0]?.route,
    }) ??
    sections[0]?.items[0]?.route ??
    "";

  // Descriptive browser tab/history title: "<Section> · Seller Hub".
  const activeSectionLabel = useMemo(() => {
    for (const section of translatedSections) {
      const item = section.items.find((i) => i.route === currentRoute);
      if (item) return item.label;
    }
    return undefined;
  }, [translatedSections, currentRoute]);

  useDocumentTitleFallback(
    activeSectionLabel ? `${activeSectionLabel} · Seller Hub` : "Seller Hub",
  );

  const handleReturnToConsumer = useCallback(() => {
    router.push("/my-tickets");
  }, [router]);

  // Loading
  if (isSessionLoading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          fontFamily: STATUS_FONT_FAMILY,
          // Inherit the theme foreground — the old rgba(0,0,0,0.7) was
          // near-invisible on the dark body background.
          color: "var(--foreground)",
          opacity: 0.7,
        }}
      >
        {String(t("admin.sellLoading"))}
      </div>
    );
  }

  // Not signed in
  if (!isSignedIn) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          padding: 24,
          fontFamily: STATUS_FONT_FAMILY,
        }}
      >
        {/* h1: this screen replaces the whole page — it owns the page's
            heading, and an h2 here left the page with no h1. */}
        <h1
          style={{
            margin: 0,
            fontSize: 20,
            textTransform: "uppercase",
            letterSpacing: "-0.02em",
            fontWeight: 900,
          }}
        >
          {String(t("admin.sellSignInRequired"))}
        </h1>
        <p
          style={{
            margin: 0,
            opacity: 0.6,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            fontSize: 14,
          }}
        >
          {String(t("admin.sellSignInDescription"))}
        </p>
        <button
          type="button"
          onClick={() => router.push("/")}
          style={{
            marginTop: 8,
            padding: "8px 24px",
            fontFamily: STATUS_FONT_FAMILY,
            fontSize: 14,
            // v2 button grammar (uppercase 700 / +1.5 tracking / zero radius) —
            // mirrors AdminShell's status-screen button.
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: 1.5,
            borderRadius: 0,
            border: "1px solid currentColor",
            background: "var(--backgroundInverted, #211C16)",
            color: "var(--colorInverted, #FDFAF3)",
            cursor: "pointer",
          }}
        >
          {String(t("admin.sellReturnHome"))}
        </button>
      </div>
    );
  }

  // This Link is the ONE home affordance in the header — NavigationShell gets
  // no `onBrandPress`, so the navbar never wraps it in a Button. It used to:
  // an XStack (flow content) inside a <button> is invalid HTML, and a link
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
      accountContext={SELL_CONTEXT}
      onRouteSelect={(routeId) => {
        const href = routeId.startsWith("/")
          ? routeId
          : toNamespacedHref(routeId, { adminBasePath: SELL_BASE_PATH });
        router.push(href);
      }}
      onReturnToConsumer={handleReturnToConsumer}
      returnToConsumerLabel={t("admin.sellReturnToTickets") as string}
      returnToConsumerDescription={t("admin.sellBrowseAsAttendee") as string}
      brand={brandElement}
      navbarTrailingSlot={(layout: NavigationShellLayout) =>
        // Mobile top bar stays sparse (same rule as AdminShell): the
        // workspace switcher is the identity anchor; theme moves into the
        // drawer via quickActionFooter.
        layout === "mobile" ? null : <ThemeToggleButton />
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

SellerShell.displayName = "SellerShell";

// ─────────────────────────────────────────────────────────────────────────────
// Page transition (mirrors PlatformShell / AdminShell)
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
