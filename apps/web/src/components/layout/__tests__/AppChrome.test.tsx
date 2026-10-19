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
  AppShell: ({
    children,
    flush,
  }: {
    children?: ReactNode;
    flush?: boolean;
  }) => (
    <div data-testid="app-shell" data-flush={String(flush)}>
      {children}
    </div>
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

describe("AppChrome", () => {
  it("renders shell without auth gate on the homepage", () => {
    mockedUsePathname.mockReturnValue("/");

    render(
      <AppChrome>
        <span>content</span>
      </AppChrome>,
    );

    expect(screen.getByText("content")).toBeInTheDocument();
    expect(screen.getByTestId("app-shell")).toBeInTheDocument();
    expect(screen.queryByTestId("app-auth-gate")).not.toBeInTheDocument();
  });

  // A component can be written, documented, and never rendered — that is exactly
  // how `SentryReplayLoader` came to spend its whole life unmounted while the
  // cookie banner asked permission for the recording it was supposed to make.
  // These pin the mounts so an analytics loader cannot silently detach.
  describe.each([
    ["public consumer pages", "/"],
    ["auth-gated pages", "/tickets"],
    ["admin routes with their own shell", "/admin/some-org"],
  ])("analytics loaders on %s", (_label, pathname) => {
    it("mounts the cookieless and consent-gated loaders", () => {
      mockedUsePathname.mockReturnValue(pathname);

      render(
        <AppChrome>
          <span>content</span>
        </AppChrome>,
      );

      expect(screen.getByTestId("plausible")).toBeInTheDocument();
      expect(screen.getByTestId("cf-analytics")).toBeInTheDocument();
      expect(screen.getByTestId("analytics-loader")).toBeInTheDocument();
    });
  });

  it("keeps analytics off bare pages like embeds", () => {
    mockedUsePathname.mockReturnValue("/embed/some-id");

    render(
      <AppChrome>
        <span>embed</span>
      </AppChrome>,
    );

    expect(screen.queryByTestId("plausible")).not.toBeInTheDocument();
    expect(screen.queryByTestId("cf-analytics")).not.toBeInTheDocument();
    expect(screen.queryByTestId("analytics-loader")).not.toBeInTheDocument();
    expect(screen.queryByTestId("cookie-consent")).not.toBeInTheDocument();
  });

  it("bypasses auth chrome on the login page", () => {
    mockedUsePathname.mockReturnValue("/login");

    render(
      <AppChrome>
        <span>login</span>
      </AppChrome>,
    );

    expect(screen.getByText("login")).toBeInTheDocument();
    expect(screen.queryByTestId("app-shell")).not.toBeInTheDocument();
  });

  it("wraps protected routes with auth chrome", () => {
    mockedUsePathname.mockReturnValue("/tickets");

    render(
      <AppChrome>
        <span>tickets</span>
      </AppChrome>,
    );

    expect(screen.getByTestId("app-auth-gate")).toBeInTheDocument();
    expect(screen.getByTestId("app-shell")).toBeInTheDocument();
    expect(screen.getByText("tickets")).toBeInTheDocument();
  });

  it("bypasses chrome on sign-in routes", () => {
    mockedUsePathname.mockReturnValue("/sign-in/123");

    render(
      <AppChrome>
        <span>signin</span>
      </AppChrome>,
    );

    expect(screen.getByText("signin")).toBeInTheDocument();
    expect(screen.queryByTestId("app-shell")).not.toBeInTheDocument();
    expect(screen.queryByTestId("app-auth-gate")).not.toBeInTheDocument();
  });

  it("still bypasses chrome entirely on other auth-prefixed routes", () => {
    mockedUsePathname.mockReturnValue("/auth/callback");

    render(
      <AppChrome>
        <span>callback</span>
      </AppChrome>,
    );

    expect(screen.getByText("callback")).toBeInTheDocument();
    expect(screen.queryByTestId("app-shell")).not.toBeInTheDocument();
    expect(screen.queryByTestId("app-auth-gate")).not.toBeInTheDocument();
  });

  it("bypasses the consumer shell on admin routes", () => {
    mockedUsePathname.mockReturnValue("/admin/acme/events");

    render(
      <AppChrome>
        <span>admin</span>
      </AppChrome>,
    );

    expect(screen.getByText("admin")).toBeInTheDocument();
    expect(screen.queryByTestId("app-shell")).not.toBeInTheDocument();
    expect(screen.getByTestId("app-auth-gate")).toBeInTheDocument();
  });

  it("bypasses the consumer shell on platform routes without taking the bare branch", () => {
    mockedUsePathname.mockReturnValue("/platform/overview");

    render(
      <AppChrome>
        <span>platform</span>
      </AppChrome>,
    );

    expect(screen.getByText("platform")).toBeInTheDocument();
    expect(screen.queryByTestId("app-shell")).not.toBeInTheDocument();
    expect(screen.getByTestId("app-auth-gate")).toBeInTheDocument();
  });

  it("renders privacy inside the consumer shell without auth gate", () => {
    mockedUsePathname.mockReturnValue("/privacy");

    render(
      <AppChrome>
        <span>privacy</span>
      </AppChrome>,
    );

    expect(screen.getByText("privacy")).toBeInTheDocument();
    expect(screen.getByTestId("app-shell")).toBeInTheDocument();
    expect(screen.queryByTestId("app-auth-gate")).not.toBeInTheDocument();
  });

  // Invite accept pages own their signed-out screen (it stashes the bearer
  // token instead of putting it in the sign-in redirect URL), so the auth
  // gate must NOT bounce them to /sign-in?redirect=…token=….
  it.each(["/invite/accept", "/delegate/accept", "/invites/stop"])(
    "renders %s in the consumer shell without the auth gate",
    (path) => {
      mockedUsePathname.mockReturnValue(path);

      render(
        <AppChrome>
          <span>accept</span>
        </AppChrome>,
      );

      expect(screen.getByText("accept")).toBeInTheDocument();
      expect(screen.getByTestId("app-shell")).toBeInTheDocument();
      expect(screen.queryByTestId("app-auth-gate")).not.toBeInTheDocument();
    },
  );

  it("renders review-a-place as a public consumer route", () => {
    mockedUsePathname.mockReturnValue("/review-a-place");

    render(
      <AppChrome>
        <span>review a place</span>
      </AppChrome>,
    );

    expect(screen.getByText("review a place")).toBeInTheDocument();
    expect(screen.getByTestId("app-shell")).toBeInTheDocument();
    expect(screen.queryByTestId("app-auth-gate")).not.toBeInTheDocument();
  });

  it("renders the standalone rate-venue deep-link as a public consumer route", () => {
    mockedUsePathname.mockReturnValue(
      "/rate-venue/00000000-0000-0000-0000-00000000d035",
    );

    render(
      <AppChrome>
        <span>rate venue</span>
      </AppChrome>,
    );

    expect(screen.getByText("rate venue")).toBeInTheDocument();
    expect(screen.getByTestId("app-shell")).toBeInTheDocument();
    expect(screen.queryByTestId("app-auth-gate")).not.toBeInTheDocument();
  });

  it.each([
    ["/p/acme"],
    // The venue's acts roster (venue-track-record-and-review-switch FR-016)
    // is public like the page above it — an anonymous reader following
    // "All N acts →" must never land on /sign-in.
    ["/p/acme/acts"],
    ["/places/venue-slug"],
    ["/orgs/acme-collective"],
    ["/humans/jane-doe"],
  ])(
    "renders %s entity pages inside the consumer shell without auth gate",
    (pathname) => {
      mockedUsePathname.mockReturnValue(pathname);

      render(
        <AppChrome>
          <span>entity page</span>
        </AppChrome>,
      );

      expect(screen.getByText("entity page")).toBeInTheDocument();
      expect(screen.getByTestId("app-shell")).toBeInTheDocument();
      expect(screen.getByTestId("global-overlays")).toBeInTheDocument();
      expect(screen.queryByTestId("app-auth-gate")).not.toBeInTheDocument();
    },
  );

  it.each([
    ["/p/acme/settings"],
    // A prefix match is not a match: only the exact `acts` segment is public.
    ["/p/acme/actsomething"],
    ["/p/acme/acts/extra"],
  ])("keeps the unlisted sub-path %s on the auth-gated branch", (pathname) => {
    mockedUsePathname.mockReturnValue(pathname);

    render(
      <AppChrome>
        <span>entity sub-route</span>
      </AppChrome>,
    );

    expect(screen.getByText("entity sub-route")).toBeInTheDocument();
    expect(screen.getByTestId("app-auth-gate")).toBeInTheDocument();
  });

  it("renders event short links (/e/<shortId>) without the auth gate", () => {
    // Behind the gate the server never renders the page, so its redirect
    // left as a 200 and a signed-out visitor was sent to /sign-in.
    mockedUsePathname.mockReturnValue("/e/wqsdk6pxzi");

    render(
      <AppChrome>
        <span>short link</span>
      </AppChrome>,
    );

    expect(screen.getByText("short link")).toBeInTheDocument();
    expect(screen.getByTestId("app-shell")).toBeInTheDocument();
    expect(screen.queryByTestId("app-auth-gate")).not.toBeInTheDocument();
  });

  it.each([["/enroll-2fa"], ["/embedded"], ["/eventsfoo"]])(
    "does not let the /e prefix open %s to the public",
    (pathname) => {
      mockedUsePathname.mockReturnValue(pathname);

      render(
        <AppChrome>
          <span>gated</span>
        </AppChrome>,
      );

      expect(screen.getByTestId("app-auth-gate")).toBeInTheDocument();
    },
  );

  it.each([
    ["/es"],
    ["/es/acerca-de"],
    ["/es/eventos/categoria/music/nashville"],
    // The catch-all that answers 404 / 308: it must run on the server.
    ["/es/events/category/music"],
    ["/es/nope/nope"],
  ])("renders the Spanish public page %s without the auth gate", (pathname) => {
    // Behind the gate the server rendered only the spinner: no content for
    // crawlers, signed-out visitors sent to /sign-in, 404 / 308 sent as 200.
    mockedUsePathname.mockReturnValue(pathname);

    render(
      <AppChrome>
        <span>spanish page</span>
      </AppChrome>,
    );

    expect(screen.getByText("spanish page")).toBeInTheDocument();
    expect(screen.getByTestId("app-shell")).toBeInTheDocument();
    expect(screen.queryByTestId("app-auth-gate")).not.toBeInTheDocument();
  });

  it.each([["/esports"], ["/estate/1"]])(
    "does not let the /es prefix open %s to the public",
    (pathname) => {
      mockedUsePathname.mockReturnValue(pathname);

      render(
        <AppChrome>
          <span>gated</span>
        </AppChrome>,
      );

      expect(screen.getByTestId("app-auth-gate")).toBeInTheDocument();
    },
  );

  // Which wrapper a route got, read off the rendered tree.
  const renderedBranch = (pathname: string) => {
    mockedUsePathname.mockReturnValue(pathname);

    render(
      <AppChrome>
        <span>content</span>
      </AppChrome>,
    );

    expect(screen.getByText("content")).toBeInTheDocument();
    const shell = screen.queryByTestId("app-shell");
    const gate = screen.queryByTestId("app-auth-gate");
    if (!shell && !gate) return "bare";
    if (!shell) return "custom-shell";
    if (!gate) return "public-shell";
    return gate.contains(shell) ? "auth-gated-shell" : "unexpected";
  };

  // Every real route keeps the branch it had under the old `startsWith`
  // matcher; only sibling paths that no route serves moved.
  it.each([
    ["/auth/callback", "bare"],
    ["/embed/abc", "bare"],
    ["/sign-in", "bare"],
    ["/sign-in/factor-one", "bare"],
    ["/sign-up", "bare"],
    ["/events", "public-shell"],
    ["/events/some-slug", "public-shell"],
    ["/events/checkout-night", "public-shell"],
    ["/events/checkout/abc", "public-shell"],
    ["/account", "public-shell"],
    ["/account/settings", "public-shell"],
    ["/search", "public-shell"],
    ["/help", "public-shell"],
    ["/help/some-article", "public-shell"],
    ["/rate-venue/pl_1", "public-shell"],
    ["/e/abc123", "public-shell"],
    ["/admin", "custom-shell"],
    ["/admin/my-org/events", "custom-shell"],
    ["/platform", "custom-shell"],
    ["/platform/users", "custom-shell"],
    ["/my-tickets", "auth-gated-shell"],
    ["/saved", "auth-gated-shell"],
    ["/sell", "auth-gated-shell"],
  ])("keeps the real route %s on the %s branch", (pathname, branch) => {
    expect(renderedBranch(pathname)).toBe(branch);
  });

  // Prefixes match whole segments. With a bare `startsWith`, these sibling
  // paths took the prefix's branch: public ones skipped the auth gate.
  it.each([
    ["/eventsfoo", "auth-gated-shell"],
    ["/accounts-payable", "auth-gated-shell"],
    ["/helpers", "auth-gated-shell"],
    ["/searchlight", "auth-gated-shell"],
    ["/rate-venues", "auth-gated-shell"],
    ["/admin-guide", "auth-gated-shell"],
    ["/platformer", "auth-gated-shell"],
    ["/embedded", "auth-gated-shell"],
    ["/sign-in-help", "auth-gated-shell"],
    ["/authors", "auth-gated-shell"],
    // Bare /e is a 404 (only /e/[shortId] exists); it renders not-found in
    // the public shell, like /events/does-not-exist.
    ["/e", "public-shell"],
  ])(
    "gives the sibling path %s the %s branch, not the prefix's",
    (pathname, branch) => {
      expect(renderedBranch(pathname)).toBe(branch);
    },
  );

  it("keeps /places/id routes on the auth-gated branch", () => {
    mockedUsePathname.mockReturnValue("/places/id/place-123");

    render(
      <AppChrome>
        <span>place app route</span>
      </AppChrome>,
    );

    expect(screen.getByText("place app route")).toBeInTheDocument();
    expect(screen.getByTestId("app-shell")).toBeInTheDocument();
    expect(screen.getByTestId("app-auth-gate")).toBeInTheDocument();
  });

  it.each([
    ["/events/checkout/some-event", true],
    ["/events/checkout-collective/us/nashville/gig", false],
    ["/events/checkout-night", false],
  ])(
    "treats only the checkout route as checkout (%s -> %s)",
    (path, isCheckout) => {
      mockedUsePathname.mockReturnValue(path);
      render(
        <AppChrome>
          <span>content</span>
        </AppChrome>,
      );
      expect(screen.getByTestId("app-shell")).toHaveAttribute(
        "data-flush",
        String(isCheckout),
      );
      if (isCheckout) {
        expect(screen.queryByTestId("cart-recovery")).not.toBeInTheDocument();
      } else {
        expect(screen.getByTestId("cart-recovery")).toBeInTheDocument();
      }
    },
  );
});
