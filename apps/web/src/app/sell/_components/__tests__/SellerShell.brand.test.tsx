import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NavigationSection } from "@th/ui";

// The Seller Hub sits behind the `resale` feature gate, which is OFF by
// default, so `/sell` cannot be reached in local dev without a DB write. This
// file is how SellerShell actually gets executed: it renders the real
// component and pins the one thing the shell owns in the navbar — the brand.
//
// The assertion is not cosmetic. SellerShell used to hand NavigationShell an
// `onBrandPress`, which made the navbar wrap the brand in a <Button>. With an
// <XStack> inside, that produced flow content inside a <button> (invalid HTML)
// and two stacked "go home" targets in the accessibility tree. The fix is to
// pass a single <Link> and NO `onBrandPress`; these tests fail if either half
// regresses.

vi.mock("next/navigation", () => ({
  usePathname: () => "/sell",
}));

vi.mock("@bprogress/next/app", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: { user: { id: "human_1", name: "Dev Seller" } },
      isPending: false,
    }),
  },
}));

vi.mock("@/hooks/useDocumentTitle", () => ({
  useDocumentTitleFallback: () => undefined,
}));

vi.mock("@/components/navigation/BrandLockup", () => ({
  BrandLockup: () => <span data-testid="brand-lockup">Ithas Fire</span>,
}));

vi.mock("@/components/theme/ThemeToggleButton", () => ({
  ThemeToggleButton: () => <button type="button">Switch to dark mode</button>,
}));

// Capture what the shell hands NavigationShell, and render the brand for real
// so the DOM nesting is genuine rather than asserted from props alone.
const shellProps: Record<string, unknown> = {};

// Stubbed rather than `importActual`: the real barrel pulls in react-native
// and tamagui, which pushes first collect past the 5s test timeout when this
// file runs alongside the other shell suites. Nothing under test lives in
// @th/ui — the brand element is built by SellerShell itself and is rendered
// here for real, so the DOM nesting assertions are genuine.
vi.mock("@th/ui", () => ({
  NavigationShell: (props: Record<string, unknown>) => {
    Object.assign(shellProps, props);
    return (
      <div>
        <div data-testid="seller-brand-slot">
          {props.brand as React.ReactNode}
        </div>
        {props.children as React.ReactNode}
      </div>
    );
  },
  Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  namespaceNavSections: (sections: unknown) => ({ sections }),
  parseNamespacedPathname: () => "listings",
  toNamespacedHref: (route: string) => `/sell/${route}`,
  // Resolves the key the brand's accessible name comes from, so the assertion
  // below checks the string a screen reader actually announces rather than a
  // key echo (which would pass even if the key were wrong or missing).
  useTranslations: () => (key: string) =>
    key === "common.goToHome" ? "Go to home" : key,
}));

const SECTIONS: NavigationSection[] = [
  {
    id: "seller",
    label: "Seller",
    items: [{ id: "listings", label: "Listings", route: "listings" }],
  },
];

// Returns the brand slot scoped to THIS render's own container. `screen` and
// the bound queries both search document.body, which is shared with the other
// shell test files in this worker — so a document-wide lookup finds their
// slots too and throws "multiple elements found".
const renderShell = async () => {
  const { SellerShell } = await import("../SellerShell");
  const { container } = render(
    <SellerShell sections={SECTIONS}>
      <div>content</div>
    </SellerShell>,
  );
  const slot = container.querySelector<HTMLElement>(
    '[data-testid="seller-brand-slot"]',
  );
  if (!slot) {
    throw new Error("SellerShell did not render — the brand slot is missing.");
  }
  return { container, slot };
};

describe("SellerShell brand", () => {
  // This project's vitest setup does not auto-cleanup, so without this each
  // test stacks another render and `getByTestId` throws "multiple elements".
  afterEach(() => {
    cleanup();
    for (const key of Object.keys(shellProps)) delete shellProps[key];
  });

  it("passes no onBrandPress, so the navbar never wraps the brand in a button", async () => {
    // renderShell throws if the shell short-circuited, so this cannot pass
    // vacuously on an empty render.
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
