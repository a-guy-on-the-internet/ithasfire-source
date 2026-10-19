/**
 * `/challenge/turnstile` opens signed out, in a system-browser sheet launched
 * by the native app. Through the auth gate it would bounce to /sign-in and
 * never run the check, so it must take the bare branch. Kept apart from
 * `AppChrome.test.tsx`; the mocks mirror it.
 */
import { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

const mockedUsePathname = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => mockedUsePathname(),
}));
vi.mock("@tanstack/react-query", () => ({
  HydrationBoundary: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
}));
vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: null }),
}));
vi.mock("@/lib/feature-gates/ServerFeatureGatesContext", () => ({
  ServerFeatureGatesProvider: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
}));
vi.mock("@/components/cart/CartRecoveryProvider", () => ({
  CartRecoveryProvider: () => <div data-testid="cart-recovery" />,
}));
vi.mock("@/components/guards/FeatureGateGuard", () => ({
  FeatureGateGuard: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/layout/GlobalOverlays", () => ({
  GlobalOverlays: () => <div data-testid="global-overlays" />,
}));
vi.mock("@/components/gdpr/CookieConsentBanner", () => ({
  CookieConsentBanner: () => <div data-testid="cookie-consent" />,
}));
vi.mock("@/components/analytics/GoogleAnalyticsLoader", () => ({
  GoogleAnalyticsLoader: () => <div data-testid="analytics-loader" />,
}));
vi.mock("@/components/analytics/PlausibleAnalytics", () => ({
  PlausibleAnalytics: () => <div data-testid="plausible" />,
}));
vi.mock("@/components/analytics/CloudflareAnalytics", () => ({
  CloudflareAnalytics: () => <div data-testid="cf-analytics" />,
}));
vi.mock("@/components/auth/AppAuthGate", () => ({
  AppAuthGate: ({ children }: { children?: ReactNode }) => (
    <div data-testid="app-auth-gate">{children}</div>
  ),
}));
vi.mock("@/components/layout/AppShell", () => ({
  AppShell: ({ children }: { children?: ReactNode }) => (
    <div data-testid="app-shell">{children}</div>
  ),
}));
vi.mock("@/components/layout/AppOverlayProvider", () => ({
  AppOverlayProvider: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
}));

let AppChrome: (typeof import("../AppChrome"))["AppChrome"];

beforeAll(async () => {
  ({ AppChrome } = await import("../AppChrome"));
});

const renderAt = (pathname: string) => {
  mockedUsePathname.mockReturnValue(pathname);
  render(
    <AppChrome>
      <span>content</span>
    </AppChrome>,
  );
};

describe("AppChrome — /challenge/turnstile", () => {
  it("renders bare: no auth gate, no shell, no analytics", () => {
    renderAt("/challenge/turnstile");

    expect(screen.getByText("content")).toBeInTheDocument();
    expect(screen.queryByTestId("app-auth-gate")).not.toBeInTheDocument();
    expect(screen.queryByTestId("app-shell")).not.toBeInTheDocument();
    expect(screen.queryByTestId("plausible")).not.toBeInTheDocument();
    expect(screen.queryByTestId("cookie-consent")).not.toBeInTheDocument();
  });

  // The sheet shares the system browser's cookies: a signed-in visitor with a
  // pending cart would otherwise get the resume-checkout banner over the check.
  it("mounts no cart recovery", () => {
    renderAt("/challenge/turnstile");

    expect(screen.queryByTestId("cart-recovery")).toBeNull();
  });

  it("other bare pages still mount cart recovery", () => {
    renderAt("/login");

    expect(screen.getByTestId("cart-recovery")).toBeInTheDocument();
  });

  it.each(["/challenge", "/challenge/other", "/challenges", "/challenge/turnstile/x"])(
    "the bypass is exact: %s stays on the gated branch",
    (pathname) => {
      renderAt(pathname);

      expect(screen.getByTestId("app-auth-gate")).toBeInTheDocument();
    },
  );
});
