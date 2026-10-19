/**
 * AppShell's layout contract: the page's own content is the first child of the
 * main content area (no shell-owned action surface sits above it any more),
 * and bottom clearance is reserved on the shell ROOT for the consumer bottom
 * nav — which is fixed over the whole document, footer included.
 */
import { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

vi.mock("tamagui", async () => {
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
  return { YStack: Stack, XStack: Stack, styled: () => Stack };
});

vi.mock("@/components/navigation/AppNavbar", () => ({
  AppNavbar: () => <div data-testid="navbar" />,
}));
vi.mock("@/components/layout/AppFooter", () => ({
  AppFooter: () => <div data-testid="footer" />,
}));
vi.mock("@/components/layout/EmailDeliveryBanner", () => ({
  EmailDeliveryBanner: () => null,
}));
vi.mock("@/components/navigation/ScrollAwareNavbar", () => ({
  ScrollAwareNavbar: ({ children }: { children?: ReactNode }) => (
    <>{children}</>
  ),
}));

// The consumer bottom nav is exercised in
// `components/navigation/__tests__/ConsumerBottomNav.test.tsx`; here we only
// care that the shell mounts it and reserves clearance when it is up.
let bottomNavVisible = false;
vi.mock("@/components/navigation/ConsumerBottomNav", () => ({
  ConsumerBottomNav: () =>
    bottomNavVisible ? <div data-testid="consumer-bottom-nav" /> : null,
  CONSUMER_BOTTOM_NAV_CLEARANCE: 96,
  useConsumerBottomNavVisible: () => bottomNavVisible,
}));

import { AppShell } from "../AppShell";
import { setNavbarVisibleHeight } from "@/components/navigation/navbar-offset-store";

describe("AppShell", () => {
  beforeEach(() => {
    bottomNavVisible = false;
  });

  it("flush adds the flush class and its media-query rule; default adds neither", () => {
    const { container, unmount } = render(
      <AppShell flush>
        <span>x</span>
      </AppShell>,
    );
    expect(screen.getByRole("main").className).toContain("th-shell-flush");
    const css = container.querySelector("style")?.innerHTML ?? "";
    expect(css).toContain("@media (max-width: 599.98px)");
    expect(css).toContain("#main-content.th-shell-flush");
    expect(css).toMatch(/padding-left:\s*0;/);
    expect(css).toMatch(/padding-right:\s*0;/);
    expect(css).toMatch(/padding-top:\s*0;/);
    expect(css).toContain("gap: var(--t-space-2, 8px)");
    unmount();

    const plain = render(
      <AppShell>
        <span>x</span>
      </AppShell>,
    );
    expect(screen.getByRole("main").className).not.toContain("th-shell-flush");
    expect(plain.container.querySelector("style")).toBeNull();
  });

  it("renders the page's own content as the first child of the main content", () => {
    render(
      <AppShell>
        <span data-testid="page-body">content</span>
      </AppShell>,
    );

    const main = screen.getByRole("main");
    expect(main.firstElementChild).toBe(screen.getByTestId("page-body"));
  });

  // The action bar is gone (2026-08-30): nothing the shell owns may sit
  // between <main> and the page, and no CSS custom property is published for
  // one. This pins that the shell stays out of the page's way.
  it("publishes no action-bar offset on the content area", () => {
    act(() => setNavbarVisibleHeight(68));
    render(
      <AppShell>
        <span>content</span>
      </AppShell>,
    );

    const main = screen.getByRole("main");
    expect(main.style.getPropertyValue("--page-action-bar-top")).toBe("");
  });

  it("reserves no bottom clearance for a floating dock", () => {
    render(
      <AppShell>
        <span>content</span>
      </AppShell>,
    );

    expect(screen.getByRole("main").style.paddingBottom).toBe("");
  });

  it("mounts the consumer bottom nav and reserves clearance for it", () => {
    bottomNavVisible = true;
    const { container } = render(
      <AppShell>
        <span>content</span>
      </AppShell>,
    );

    expect(screen.getByTestId("consumer-bottom-nav")).toBeInTheDocument();
    // The bar is fixed over the very bottom of the DOCUMENT (it overlays the
    // footer, not just the content area), so the clearance belongs on the
    // shell root — not on <main>.
    const shellRoot = container.firstElementChild as HTMLElement;
    expect(shellRoot.style.paddingBottom).toBe("96px");
    expect(screen.getByRole("main").style.paddingBottom).toBe("");
  });

  it("reserves no clearance where the bottom nav does not render", () => {
    const { container } = render(
      <AppShell>
        <span>content</span>
      </AppShell>,
    );

    expect(screen.queryByTestId("consumer-bottom-nav")).toBeNull();
    expect(
      (container.firstElementChild as HTMLElement).style.paddingBottom,
    ).toBe("");
  });
});
