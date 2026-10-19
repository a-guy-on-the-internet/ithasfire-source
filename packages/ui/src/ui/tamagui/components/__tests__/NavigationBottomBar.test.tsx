import { fireEvent, screen } from "@testing-library/react";
import { ScanLine } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import type { NavigationSection } from "../../../shell/NavigationShell.types";
import { isRouteActive } from "../../../shell/utils/route-active";
import {
  BOTTOM_BAR_DEFAULT_MAX_ITEMS,
  NavigationBottomBar,
  bottomBarShowsMore,
  resolveBottomNavSwipe,
} from "../navigation/NavigationBottomBar";
import { renderWithProvider } from "../../../../../test/utils";

const sampleSection: NavigationSection = {
  id: "main",
  label: "Main",
  items: [
    { id: "dashboard", label: "Dashboard", route: "/dashboard" },
    { id: "events", label: "Events", route: "/events" },
    { id: "orders", label: "Orders", route: "/orders" },
  ],
};

const toPrimaryItems = () =>
  sampleSection.items.map((route) => ({
    section: sampleSection,
    route,
  }));

describe("resolveBottomNavSwipe", () => {
  it("returns the next route when swiping forward", () => {
    const outcome = resolveBottomNavSwipe({
      currentRoute: "/dashboard",
      primaryItems: toPrimaryItems(),
      shouldShowMore: false,
      direction: "next",
    });

    expect(outcome).toEqual({
      kind: "route",
      route: "/events",
      sectionId: sampleSection.id,
    });
  });

  it("returns the previous route when swiping backward", () => {
    const outcome = resolveBottomNavSwipe({
      currentRoute: "/orders",
      primaryItems: toPrimaryItems(),
      shouldShowMore: false,
      direction: "prev",
    });

    expect(outcome).toEqual({
      kind: "route",
      route: "/events",
      sectionId: sampleSection.id,
    });
  });

  it("falls back to opening the drawer when swiping past the last item", () => {
    const outcome = resolveBottomNavSwipe({
      currentRoute: "/orders",
      primaryItems: toPrimaryItems(),
      shouldShowMore: true,
      direction: "next",
    });

    expect(outcome).toEqual({ kind: "drawer" });
  });

  it("ignores swipes when the current route is unknown", () => {
    const outcome = resolveBottomNavSwipe({
      currentRoute: "/missing",
      primaryItems: toPrimaryItems(),
      shouldShowMore: true,
      direction: "next",
    });

    expect(outcome).toEqual({ kind: "none" });
  });

  // The center action is NOT part of the swipe order: `resolveBottomNavSwipe`
  // only ever sees `primaryItems` (tabs), so swiping from tab 2 lands on tab 3
  // regardless of the raised slot rendered between them.
  it("swipes across the tabs the center action visually splits", () => {
    const outcome = resolveBottomNavSwipe({
      currentRoute: "/events",
      primaryItems: toPrimaryItems(),
      shouldShowMore: false,
      direction: "next",
    });

    expect(outcome).toEqual({
      kind: "route",
      route: "/orders",
      sectionId: sampleSection.id,
    });
  });
});

// ─────────────────────────────────────────────────────────────
// Rendering — tab flattening, center action slot, active matching
// ─────────────────────────────────────────────────────────────

/** Admin-shaped fixture: hideInBottomBar demotes Places/Bookings so Orders
 * takes the third slot, and a later section forces the More drawer tab. */
const adminLikeSections: NavigationSection[] = [
  {
    id: "overview",
    label: "Overview",
    items: [
      { id: "dashboard", label: "Dashboard", route: "/admin/acme/dashboard" },
      {
        id: "search",
        label: "Search",
        route: "/admin/acme/search",
        hideInBottomBar: true,
      },
    ],
  },
  {
    id: "programming",
    label: "Programming",
    items: [
      { id: "events", label: "Events", route: "/admin/acme/events" },
      {
        id: "places",
        label: "Places",
        route: "/admin/acme/places",
        hideInBottomBar: true,
      },
      {
        id: "bookings",
        label: "Bookings",
        route: "/admin/acme/bookings",
        hideInBottomBar: true,
      },
    ],
  },
  {
    id: "sales",
    label: "Sales",
    items: [
      { id: "orders", label: "Orders", route: "/admin/acme/orders" },
      { id: "payments", label: "Payments", route: "/admin/acme/payments" },
      { id: "team", label: "Team", route: "/admin/acme/team" },
    ],
  },
];

const centerAction = (overrides?: { onPress?: () => void }) => ({
  id: "scan",
  label: "Scan",
  icon: <ScanLine />,
  onPress: overrides?.onPress ?? vi.fn(),
});

const renderBar = (
  props?: Partial<Parameters<typeof NavigationBottomBar>[0]>,
) =>
  renderWithProvider(
    <NavigationBottomBar
      sections={adminLikeSections}
      currentRoute="dashboard"
      onSelect={vi.fn()}
      onOpenDrawer={vi.fn()}
      {...props}
    />,
  );

const renderedNavOrder = (container: HTMLElement) =>
  Array.from(
    container.querySelectorAll<HTMLElement>(
      "[data-testid^='nav-item-'], [data-testid^='nav-center-']",
    ),
  ).map((el) => el.getAttribute("data-testid"));

// The shell hides the top-bar hamburger whenever `bottomBarShowsMore` says
// the bar grows a MORE tab. If the helper and the bar ever disagree, the
// hamburger goes AND no MORE tab appears — on web there is no edge-swipe, so
// the drawer (and the theme + language controls that now live only inside
// it) becomes unreachable. These tests pin the two together at the exact
// boundary the decision turns on, so the pair cannot drift silently.
describe("bottomBarShowsMore agrees with what the bar renders", () => {
  const sectionsWithItemCount = (count: number): NavigationSection[] => [
    {
      id: "main",
      label: "Main",
      items: Array.from({ length: count }, (_, i) => ({
        id: `item-${i}`,
        label: `Item ${i}`,
        route: `/item-${i}`,
      })),
    },
  ];

  // Straddle BOTTOM_BAR_DEFAULT_MAX_ITEMS (4) rather than hardcoding 4 here,
  // so raising the budget moves both the helper and this test together.
  const counts = [
    BOTTOM_BAR_DEFAULT_MAX_ITEMS - 1,
    BOTTOM_BAR_DEFAULT_MAX_ITEMS,
    BOTTOM_BAR_DEFAULT_MAX_ITEMS + 1,
  ];

  it.each(counts)(
    "with %i visible items the helper matches the rendered MORE tab",
    (count) => {
      const sections = sectionsWithItemCount(count);
      const { container } = renderWithProvider(
        <NavigationBottomBar
          sections={sections}
          currentRoute="/item-0"
          onSelect={vi.fn()}
          onOpenDrawer={vi.fn()}
        />,
      );

      const moreTabRendered = Boolean(
        container.querySelector("[data-testid='nav-item-mobile-bottom-more']"),
      );

      expect(bottomBarShowsMore(sections, { hasDrawer: true })).toBe(
        moreTabRendered,
      );
    },
  );

  it("reports no MORE tab when the bar has no drawer to open", () => {
    // The bar's own guard is `shouldShowMore && onOpenDrawer`. Enough items
    // to overflow, but no opener — the bar renders no MORE tab, so the
    // helper must not claim one, or the shell would drop the hamburger too.
    const sections = sectionsWithItemCount(BOTTOM_BAR_DEFAULT_MAX_ITEMS + 3);
    const { container } = renderWithProvider(
      <NavigationBottomBar
        sections={sections}
        currentRoute="/item-0"
        onSelect={vi.fn()}
      />,
    );

    expect(
      container.querySelector("[data-testid='nav-item-mobile-bottom-more']"),
    ).toBeNull();
    expect(bottomBarShowsMore(sections, { hasDrawer: false })).toBe(false);
  });

  it("ignores items the bar itself skips when counting toward MORE", () => {
    // `disabled` / `hideInBottomBar` items never render as tabs, so they must
    // not push the count over the threshold either.
    const sections: NavigationSection[] = [
      {
        id: "main",
        label: "Main",
        items: [
          { id: "a", label: "A", route: "/a" },
          { id: "b", label: "B", route: "/b" },
          { id: "c", label: "C", route: "/c" },
          { id: "d", label: "D", route: "/d" },
          { id: "e", label: "E", route: "/e", hideInBottomBar: true },
          { id: "f", label: "F", route: "/f", disabled: true },
        ],
      },
    ];

    const { container } = renderWithProvider(
      <NavigationBottomBar
        sections={sections}
        currentRoute="/a"
        onSelect={vi.fn()}
        onOpenDrawer={vi.fn()}
      />,
    );

    expect(
      container.querySelector("[data-testid='nav-item-mobile-bottom-more']"),
    ).toBeNull();
    expect(bottomBarShowsMore(sections, { hasDrawer: true })).toBe(false);
  });
});

describe("NavigationBottomBar rendering", () => {
  it("hideInBottomBar demotion yields Dashboard / Events / Orders + More", () => {
    const { container } = renderBar();

    expect(renderedNavOrder(container)).toEqual([
      "nav-item-dashboard",
      "nav-item-events",
      "nav-item-orders",
      "nav-item-mobile-bottom-more",
    ]);
  });

  it("renders no center action by default", () => {
    const { container } = renderBar();

    expect(
      container.querySelector("[data-testid^='nav-center-']"),
    ).toBeNull();
  });

  it("renders the center action between tabs 2 and 3", () => {
    const { container } = renderBar({ centerAction: centerAction() });

    expect(renderedNavOrder(container)).toEqual([
      "nav-item-dashboard",
      "nav-item-events",
      "nav-center-scan",
      "nav-item-orders",
      "nav-item-mobile-bottom-more",
    ]);
  });

  it("lets a tab shrink, with a floor that keeps the compact bar inside 320px", () => {
    // Structural assertion only — jsdom does no layout, so this pins the
    // PRESENCE of the contract, not its effect. Precedent and the same caveat:
    // `packages/ui/src/ui/shell/__tests__/NavigationShell.test.tsx`'s 44px
    // rail-toggle hit-box test.
    //
    // `flexShrink: 1` is the load-bearing half. Both RN and react-native-web
    // default a View to `flexShrink: 0`, so a tab sized by its own label — a
    // long word, or a longer translation of a short one — could only overflow
    // the row. Measured before this was added: injecting es-ES-length labels
    // pushed the admin bar to 389px inside a 320px viewport.
    const { container } = renderBar({ centerAction: centerAction() });

    const tab = container.querySelector<HTMLElement>(
      "[data-testid='nav-item-dashboard']",
    );
    // 44 is the design system's touch-target floor (`HIT_MIN`, tokens/density.ts)
    // and the budget the 64px raised centre action needs:
    // 4 tabs x 44 + 64 + the row's 2 x $2 padding = 256, inside 320.
    expect(tab).toHaveStyle({ flexShrink: 1, minWidth: "44px" });
  });

  it("fires the center action's onPress", () => {
    const onPress = vi.fn();
    renderBar({ centerAction: centerAction({ onPress }) });

    fireEvent.click(screen.getByRole("button", { name: "Scan" }));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("names the center action by its label when no ariaLabel is given", () => {
    renderBar({ centerAction: centerAction() });

    expect(screen.getByRole("button", { name: "Scan" })).toBeTruthy();
  });

  it("prefers ariaLabel for the center action's accessible name", () => {
    // The square MIRRORS a control that is already on the page, so its
    // one-word label can collide with that control's and a screen reader
    // hears the same name twice. `ariaLabel` is how the publisher
    // disambiguates. It still CONTAINS the visible label — WCAG 2.5.3 Label
    // in Name — so speech input matching "Scan" keeps working.
    renderBar({
      centerAction: {
        ...centerAction(),
        ariaLabel: "Scan a ticket at the door",
      },
    });

    expect(
      screen.getByRole("button", { name: "Scan a ticket at the door" }),
    ).toBeTruthy();
    // The VISIBLE text is unchanged — only the accessible name moved.
    expect(screen.getByText("Scan")).toBeTruthy();
  });

  it("marks the center action selected when currentRoute equals its id", () => {
    renderBar({
      centerAction: centerAction(),
      currentRoute: "scan",
    });

    expect(screen.getByRole("button", { name: "Scan" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("lights a tab whose namespaced route matches the bare currentRoute", () => {
    // AdminShell/SellerShell/PlatformShell pass bare stable ids while the
    // sections carry namespaced hrefs — strict equality (the old behavior)
    // never lit a tab there.
    renderBar({ currentRoute: "orders" });

    expect(screen.getByRole("button", { name: "Orders tab" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Dashboard tab" }),
    ).toHaveAttribute("aria-selected", "false");
  });
});

describe("isRouteActive (shared with NavigationRail)", () => {
  it("matches identical routes", () => {
    expect(isRouteActive("/events", "/events")).toBe(true);
  });

  it("matches a bare id against a namespaced route", () => {
    expect(isRouteActive("orders", "/admin/acme/orders")).toBe(true);
  });

  it("does not cross-match different leaves", () => {
    expect(isRouteActive("orders", "/admin/acme/events")).toBe(false);
  });

  it("prefix mode lights a route family owner", () => {
    expect(
      isRouteActive("settings/contact", "/admin/acme/settings", "prefix"),
    ).toBe(true);
    expect(isRouteActive("settings/contact", "/admin/acme/settings")).toBe(
      false,
    );
  });
});
