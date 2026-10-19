import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NavigationSection } from "@th/ui";

// The platform console redirects to /enroll-2fa until the signed-in staff
// member has a second factor, so PlatformShell cannot be reached in local dev
// without changing account state. This file is how it actually gets executed:
// it renders the real component and pins the brand.
//
// PlatformShell used to pass `onBrandPress`, which made the navbar wrap the
// brand in a <Button>. With a <div> inside, that put flow content inside a
// <button> (invalid HTML) and two stacked "go home" targets in the a11y tree.
// The fix is a single <Link> and NO `onBrandPress`; these fail if either half
// regresses.

vi.mock("next/navigation", () => ({
  usePathname: () => "/platform",
}));

vi.mock("@bprogress/next/app", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("@/hooks/useDocumentTitle", () => ({
  useDocumentTitleFallback: () => undefined,
  useDocumentTitleUnread: () => undefined,
}));

vi.mock("@/components/navigation/BrandLockup", () => ({
  BrandLockup: () => <span data-testid="brand-lockup">Ithas Fire</span>,
}));

vi.mock("@/components/theme/ThemeToggleButton", () => ({
  ThemeToggleButton: () => <button type="button">Switch to dark mode</button>,
}));

vi.mock("@/components/search/NavbarSearch", () => ({
  NavbarSearch: () => <div data-testid="navbar-search" />,
}));

vi.mock("@/components/notifications/NotificationInboxContainer", () => ({
  NotificationInboxContainer: () => <div data-testid="inbox" />,
}));

// Staff access granted with a second factor already satisfied, so the shell
// renders its navbar instead of short-circuiting to null.
vi.mock("@/trpc", () => ({
  trpc: {
    platform: {
      checkStaffAccess: {
        // `secondFactorEnrolled` is the exact field the shell gates on — an
        // `allowed` staff member without it is redirected to /enroll-2fa and
        // the component returns null.
        useQuery: () => ({
          data: {
            allowed: true,
            role: "SUPER_ADMIN",
            secondFactorEnrolled: true,
          },
          isLoading: false,
          isError: false,
        }),
      },
    },
    notifications: {
      countUnread: { useQuery: () => ({ data: { count: 0 } }) },
    },
  },
}));

const shellProps: Record<string, unknown> = {};

// Stubbed rather than `importActual`: the real barrel pulls in react-native,
// whose Flow-typed index.js the vite transform cannot parse. Nothing under
// test lives in @th/ui — the brand element is built by PlatformShell itself
// and is rendered here for real, so the DOM nesting assertions are genuine.
vi.mock("@th/ui", () => ({
  NavigationShell: (props: Record<string, unknown>) => {
    Object.assign(shellProps, props);
    return (
      <div>
        <div data-testid="platform-brand-slot">
          {props.brand as React.ReactNode}
        </div>
        {props.children as React.ReactNode}
      </div>
    );
  },
  AlertsSidebar: () => <div data-testid="alerts-sidebar" />,
  Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  namespaceNavSections: (sections: unknown) => ({ sections }),
  parseNamespacedPathname: () => "overview",
  toNamespacedHref: (route: string) => `/platform/${route}`,
  // Resolves the key the brand's accessible name comes from, so the assertion
  // below checks the string a screen reader actually announces rather than a
  // key echo (which would pass even if the key were wrong or missing).
  useTranslations: () => (key: string) =>
    key === "common.goToHome" ? "Go to home" : key,
}));

const SECTIONS: NavigationSection[] = [
  {
    id: "platform",
    label: "Platform",
    items: [{ id: "overview", label: "Overview", route: "overview" }],
  },
];

// Returns the brand slot scoped to THIS render's own container. `screen` and
// the bound queries both search document.body, which is shared with the other
// shell test files in this worker — so a document-wide lookup finds their
// slots too and throws "multiple elements found".
//
// Throwing when the slot is absent is deliberate: the staff-access gate
// returns null when its query shape does not match, and every assertion below
// would otherwise pass vacuously against an empty document.
const renderShell = async () => {
  const { PlatformShell } = await import("../PlatformShell");
  const { container } = render(
    <PlatformShell sections={SECTIONS}>
      <div>content</div>
    </PlatformShell>,
  );
  const slot = container.querySelector<HTMLElement>(
    '[data-testid="platform-brand-slot"]',
  );
  if (!slot) {
    throw new Error(
      "PlatformShell rendered nothing — the staff-access gate short-circuited.",
    );
  }
  return { container, slot };
};

describe("PlatformShell brand", () => {
  afterEach(() => {
    cleanup();
    for (const key of Object.keys(shellProps)) delete shellProps[key];
  });

  it("passes no onBrandPress, so the navbar never wraps the brand in a button", async () => {
    await renderShell();

    expect(shellProps.onBrandPress).toBeUndefined();
  });

  it("renders the brand as exactly one anchor to home", async () => {
    const { slot } = await renderShell();
    const anchors = slot.querySelectorAll("a");

    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toHaveAttribute("href", "/");
    expect(anchors[0]).toHaveAccessibleName("Go to home");
  });

  it("puts no interactive element inside another in the brand slot", async () => {
    const { slot } = await renderShell();

    expect(
      slot.querySelectorAll("a a, a button, button a, button button"),
    ).toHaveLength(0);
  });
});
