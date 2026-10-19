import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppFooter } from "@/components/layout/AppFooter";
import { useServerFeatureGates } from "@/lib/feature-gates/ServerFeatureGatesContext";

/**
 * Regression: the chrome pieces that read gates (AppFooter gates its Seller
 * Hub link; FeatureGateGuard reads maintenance mode; page and overlay content
 * read them too) get them through `useServerFeatureGates()` as the query's
 * `initialData`. When the provider sat only around the page, they saw
 * `undefined` in SSR while the client cache had the gates, so a gated link
 * (/sell) rendered on the client only and hydration failed.
 *
 * The real provider is used. Most chrome pieces are probes that print what
 * they see on the server render; the footer case renders the REAL AppFooter.
 * Mocked for the footer case: `@/trpc` (useQuery echoes `initialData`, as an
 * empty QueryClient does on the server); tamagui stacks (plain divs, as
 * AppShell.test does); ConsentProvider; BuildInfo; and from @th/ui
 * `useTranslations` (echoes the key; the real translator throws on the
 * footer's copyright message, which wants a `year` value the footer does not
 * pass), `Link` (an anchor) and `Text` (a span).
 */

const mockedUsePathname = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => mockedUsePathname(),
}));

vi.mock("@tanstack/react-query", () => ({
  HydrationBoundary: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("tamagui", async (importOriginal) => {
  const React = await import("react");
  const PASS_PROP = /^(data-|aria-)|^(id|role|style|className)$/;
  const Stack = ({
    children,
    ...rest
  }: {
    children?: ReactNode;
    [key: string]: unknown;
  }) => {
    const domProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (PASS_PROP.test(key)) domProps[key] = value;
    }
    return React.createElement("div", domProps, children);
  };
  return {
    ...(await importOriginal<typeof import("tamagui")>()),
    YStack: Stack,
    XStack: Stack,
    styled: () => Stack,
  };
});
vi.mock("@/trpc", () => ({
  trpc: {
    features: {
      getFeatureGates: {
        useQuery: (_input: unknown, opts: { initialData?: unknown }) => ({
          data: opts.initialData,
          isLoading: opts.initialData === undefined,
        }),
      },
    },
  },
}));
vi.mock("@/components/gdpr/ConsentProvider", () => ({
  useConsentContext: () => ({ openPreferences: () => {} }),
}));
vi.mock("@th/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@th/ui")>()),
  useTranslations: () => (key: string) => key,
  Link: ({ href, children }: { href: string; children?: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../BuildInfo", () => ({ BuildInfo: () => null }));

const Probe = ({ name, children }: { name: string; children?: ReactNode }) => {
  const gates = useServerFeatureGates();
  return (
    <div data-probe={name} data-resale={String(gates?.resale)}>
      {children}
    </div>
  );
};

vi.mock("@/components/cart/CartRecoveryProvider", () => ({
  CartRecoveryProvider: () => <Probe name="cart" />,
}));
vi.mock("@/components/guards/FeatureGateGuard", () => ({
  FeatureGateGuard: ({ children }: { children?: ReactNode }) => (
    <Probe name="guard">{children}</Probe>
  ),
}));
vi.mock("@/components/layout/GlobalOverlays", () => ({
  GlobalOverlays: () => <Probe name="overlays" />,
}));
vi.mock("@/components/gdpr/CookieConsentBanner", () => ({
  CookieConsentBanner: () => null,
}));
vi.mock("@/components/analytics/GoogleAnalyticsLoader", () => ({
  GoogleAnalyticsLoader: () => null,
}));
vi.mock("@/components/analytics/PlausibleAnalytics", () => ({
  PlausibleAnalytics: () => null,
}));
vi.mock("@/components/analytics/CloudflareAnalytics", () => ({
  CloudflareAnalytics: () => null,
}));
vi.mock("@/components/auth/AppAuthGate", () => ({
  AppAuthGate: ({ children }: { children?: ReactNode }) => (
    <Probe name="auth-gate">{children}</Probe>
  ),
}));
vi.mock("@/components/layout/AppShell", () => ({
  AppShell: ({ children }: { children?: ReactNode }) => (
    <Probe name="shell">
      {children}
      <AppFooter />
    </Probe>
  ),
}));

import { AppChrome } from "../AppChrome";

type Gates = Parameters<typeof AppChrome>[0]["featureGates"];
const gates = { resale: true } as unknown as Gates;

const renderAt = (pathname: string, g: Gates = gates): string => {
  mockedUsePathname.mockReturnValue(pathname);
  return renderToString(
    <AppChrome featureGates={g}>
      <Probe name="page" />
    </AppChrome>,
  );
};

describe("AppChrome feature-gate provider placement (SSR)", () => {
  beforeEach(() => mockedUsePathname.mockReset());

  it.each([
    ["/", ["shell", "guard", "overlays", "cart", "page"]],
    ["/dashboard", ["shell", "guard", "auth-gate", "overlays", "page"]],
    ["/admin", ["auth-gate", "overlays", "page"]],
    ["/embed/x", ["cart", "page"]],
  ])("every chrome piece at %s sees the gates", (pathname, probes) => {
    const html = renderAt(pathname);
    for (const name of probes) {
      expect(html).toMatch(
        new RegExp(`data-probe="${name}"[^>]*data-resale="true"`),
      );
    }
    expect(html).not.toContain('data-resale="undefined"');
  });

  it("the real AppFooter renders the Seller Hub link on the server when resale is on", () => {
    expect(renderAt("/")).toContain('href="/sell"');
  });

  it("the real AppFooter omits the Seller Hub link when resale is off", () => {
    const html = renderAt("/", { resale: false } as unknown as Gates);
    expect(html).toContain('href="/admin"');
    expect(html).not.toContain('href="/sell"');
  });
});
