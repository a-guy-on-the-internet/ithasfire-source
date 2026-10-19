"use client";

import type { CSSProperties, ReactNode } from "react";
import { YStack, styled } from "tamagui";

import { AppNavbar } from "@/components/navigation/AppNavbar";
import { AppFooter } from "@/components/layout/AppFooter";
import {
  SHELL_GUTTER,
  SHELL_GUTTER_MOBILE,
  SHELL_MAX_WIDTH,
} from "@/components/layout/shell-metrics";
import { EmailDeliveryBanner } from "@/components/layout/EmailDeliveryBanner";
import {
  ConsumerBottomNav,
  CONSUMER_BOTTOM_NAV_CLEARANCE,
  useConsumerBottomNavVisible,
} from "@/components/navigation/ConsumerBottomNav";
import { MOBILE_BREAKPOINT } from "@/hooks/useIsMobile";
import { ACCENT_FILL, ON_ACCENT_FILL } from "@/lib/design-tokens";
import { ScrollAwareNavbar } from "@/components/navigation/ScrollAwareNavbar";

const ShellContainer = styled(YStack, {
  minHeight: "100vh",
  // Avoid introducing a second, visually distinct "shell" above/below the navbar.
  // Global page background comes from providers / global styles.
  gap: 0,
});

const MainContent = styled(YStack, {
  name: "AppShellMainContent",
  flex: 1,
  width: "100%",
  minHeight: 0,
  maxWidth: SHELL_MAX_WIDTH,
  alignSelf: "center",
  // Horizontal gutters are the shell's shared grid, not a per-surface choice —
  // the navbar and the footer read the same two constants so the three bands
  // share one left/right edge. Vertical rhythm still steps per breakpoint.
  paddingHorizontal: SHELL_GUTTER_MOBILE,
  paddingTop: "$4",
  paddingBottom: "$4",
  gap: "$5",

  $gtSm: {
    paddingHorizontal: SHELL_GUTTER,
    paddingTop: "$5",
    paddingBottom: "$5",
  },

  $gtMd: {
    paddingTop: "$6",
    paddingBottom: "$6",
    gap: "$6",
  },
});

/**
 * `flush` (checkout) drops the shell's gutters and top padding on a phone.
 * That used to be a Tamagui variant gated on `useIsMobile()`, which is false
 * during SSR, so the server painted the padded shell and hydration snapped it
 * flush (0.045-0.067 layout shift at 320px). It is a media query now, so the
 * server HTML is already right. Rendered only when `flush` is set, so every
 * other page ships byte-identical markup.
 *
 * Specificity: Tamagui's atomic rules are class-only (`:root ._pl-16px`, plus
 * extra `:root`s inside media queries); an id selector outranks any number of
 * classes, so no `!important` is needed.
 * Values are the tokens Tamagui resolves: `$2` = 8px (`--t-space-2`).
 * Below 600 the `$gtSm`/`$gtMd` (641/901) rules are not active, so only the
 * base paddings and gap need overriding. 600-640 keeps the padded shell, as
 * before.
 */
const SHELL_FLUSH_CLASS = "th-shell-flush";
const SHELL_FLUSH_CSS = `@media (max-width: ${MOBILE_BREAKPOINT - 0.02}px) {
  #main-content.${SHELL_FLUSH_CLASS} {
    padding-left: 0;
    padding-right: 0;
    padding-top: 0;
    gap: var(--t-space-2, 8px);
  }
}`;

export const AppShell = ({
  children,
  flush,
}: {
  children: ReactNode;
  flush?: boolean;
}) => {
  // Below 960px the shell grows a fixed bottom nav. It overlays the very
  // bottom of the DOCUMENT (the footer, not just the content area), so the
  // clearance has to live on the shell root — mirrors how the admin shells
  // reserve `shellPaddingBottom`.
  const showBottomNav = useConsumerBottomNavVisible();

  const mainStyle = {
    position: "relative",
    zIndex: 1,
  } as CSSProperties;

  return (
    <ShellContainer
      style={{
        position: "relative",
        isolation: "isolate",
        ...(showBottomNav
          ? { paddingBottom: CONSUMER_BOTTOM_NAV_CLEARANCE }
          : null),
      }}
      className="swiss-noise"
    >
      {/* Swiss grid pattern — structural background texture */}
      <div
        className="swiss-grid-pattern"
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 0,
        }}
        aria-hidden
      />
      {/* Skip-to-content link — visible only on keyboard focus */}
      <a
        href="#main-content"
        style={{
          position: "absolute",
          left: -9999,
          top: "auto",
          width: 1,
          height: 1,
          overflow: "hidden",
          zIndex: 100,
        }}
        onFocus={(e) => {
          Object.assign(e.currentTarget.style, {
            position: "fixed",
            left: "16px",
            top: "12px",
            width: "auto",
            height: "auto",
            overflow: "visible",
            padding: "8px 16px",
            // The #B93312 rung + white (5.92:1). This is the skip-to-content link — an a11y
            // affordance, so it of all things must clear AA. It was ink on `ACCENT`, which was
            // 5.61:1 on the pre-v2 #FF5721 but is 4.17:1 on Stub's #E2481D (and white there is
            // 4.06:1 — that fill has no compliant label at this 13px/700).
            background: ACCENT_FILL,
            color: ON_ACCENT_FILL,
            borderRadius: "0",
            fontSize: "13px",
            fontWeight: "700",
            textTransform: "uppercase",
            letterSpacing: "1.5px",
            textDecoration: "none",
          });
        }}
        onBlur={(e) => {
          Object.assign(e.currentTarget.style, {
            position: "absolute",
            left: "-9999px",
            top: "auto",
            width: "1px",
            height: "1px",
            overflow: "hidden",
            padding: "0",
            background: "transparent",
          });
        }}
      >
        Skip to content
      </a>
      {/* UniverseDust lives in the root layout so its particle state
          persists across navigation — see app/layout.tsx. */}
      {/* Scroll-aware navbar — gradient fade + slide-up-on-scroll */}
      <ScrollAwareNavbar>
        <AppNavbar />
      </ScrollAwareNavbar>
      <EmailDeliveryBanner />
      {flush ? (
        <style dangerouslySetInnerHTML={{ __html: SHELL_FLUSH_CSS }} />
      ) : null}
      <MainContent
        id="main-content"
        role="main"
        {...(flush ? { className: SHELL_FLUSH_CLASS } : {})}
        style={mainStyle}
      >
        {children}
      </MainContent>
      <div
        style={{
          position: "relative",
          zIndex: 1,
          // No border here: AppFooter's own FooterOuter already caps the page
          // with the Swiss 2px `$borderColor` rule. This wrapper used to add a
          // second `rgba(255,255,255,0.12)` line, invisible on the retired dark
          // theme's navy — tokenising it would have painted a 4px double rule.
        }}
      >
        <AppFooter />
      </div>
      <ConsumerBottomNav />
    </ShellContainer>
  );
};

AppShell.displayName = "AppShell";
