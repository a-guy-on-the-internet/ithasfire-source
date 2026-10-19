import { act } from "react";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "react-native";

import type {
  NavigationSection,
  NavigationShellProps,
} from "../NavigationShell.types";
import { NavigationShell } from "../NavigationShell";
import { NavigationRail } from "../components/NavigationRail";
import { renderWithProvider } from "../../../../test/utils";

const dimensionState = { width: 1440, height: 900, scale: 1, fontScale: 1 };

type ReactNativeModule = typeof import("react-native");

vi.mock("react-native", async () => {
  const actual = (await vi.importActual("react-native")) as ReactNativeModule;
  return {
    ...actual,
    Easing: actual.Easing ?? {
      bezier: () => (value: number) => value,
    },
    useWindowDimensions: () => dimensionState,
  };
});

const setMockWidth = (width: number) => {
  dimensionState.width = width;
};

const actClick = async (
  user: ReturnType<typeof userEvent.setup>,
  target: Element,
) => {
  await act(async () => {
    await user.click(target);
  });
};

describe("NavigationShell", () => {
  beforeEach(() => {
    setMockWidth(1440);
    vi.clearAllMocks();
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.clear();
    }
  });

  const baseSections: NavigationSection[] = [
    {
      id: "main",
      label: "Main",
      items: [
        { id: "dashboard", label: "Dashboard", route: "/dashboard" },
        { id: "events", label: "Events", route: "/events" },
      ],
    },
  ];

  const accountContext: NavigationShellProps["accountContext"] = {
    id: "ctx-1",
    label: "Acme Org",
    type: "org",
    role: "ADMIN",
  };

  const renderShell = (override?: Partial<NavigationShellProps>) =>
    renderWithProvider(
      <NavigationShell
        navSections={baseSections}
        currentRoute="/events"
        accountContext={accountContext}
        onRouteSelect={override?.onRouteSelect ?? vi.fn()}
        forceLayout="desktop"
        {...override}
      >
        <div>Content</div>
      </NavigationShell>,
    );

  it("fires view analytics when ready", async () => {
    const onView = vi.fn();
    renderShell({ analytics: { onView } });

    await waitFor(() => {
      expect(onView).toHaveBeenCalledWith({
        layout: "desktop",
        contextType: accountContext.type,
        sectionCount: baseSections.length,
      });
    });
  });

  it("gates sections by role and feature flags", () => {
    const gatedSections: NavigationSection[] = [
      {
        id: "ops",
        label: "Operations",
        rbac: ["ADMIN"],
        featureFlag: "ops-nav",
        items: [{ id: "reports", label: "Reports", route: "/reports" }],
      },
    ];
    const { rerender } = renderWithProvider(
      <NavigationShell
        navSections={gatedSections}
        currentRoute="/dashboard"
        accountContext={{ ...accountContext, role: "VIEWER", roles: ["VIEWER"] }}
        onRouteSelect={vi.fn()}
        forceLayout="desktop"
      >
        <div>Content</div>
      </NavigationShell>,
    );

    expect(screen.queryByText("Operations")).not.toBeInTheDocument();

    rerender(
      <NavigationShell
        navSections={gatedSections}
        currentRoute="/dashboard"
        accountContext={{ ...accountContext, roles: ["ADMIN"] }}
        onRouteSelect={vi.fn()}
        enabledFeatureFlags={["ops-nav"]}
        forceLayout="desktop"
      >
        <div>Content</div>
      </NavigationShell>,
    );

    expect(screen.getByText("Operations")).toBeInTheDocument();
  });

  it("hides an item when the role set does not intersect its rbac", () => {
    const gatedSections: NavigationSection[] = [
      {
        id: "main",
        label: "Main",
        items: [
          { id: "dashboard", label: "Dashboard", route: "/dashboard" },
          {
            id: "team",
            label: "Team",
            route: "/team",
            rbac: ["OWNER", "ADMIN"],
          },
        ],
      },
    ];

    renderWithProvider(
      <NavigationShell
        navSections={gatedSections}
        currentRoute="/dashboard"
        accountContext={{ ...accountContext, role: "EDITOR", roles: ["EDITOR"] }}
        onRouteSelect={vi.fn()}
        forceLayout="desktop"
      >
        <div>Content</div>
      </NavigationShell>,
    );

    expect(screen.getByText("Dashboard")).toBeInTheDocument();
    expect(screen.queryByText("Team")).not.toBeInTheDocument();
  });

  it("shows an item when the role set intersects its rbac", () => {
    const gatedSections: NavigationSection[] = [
      {
        id: "main",
        label: "Main",
        items: [
          {
            id: "team",
            label: "Team",
            route: "/team",
            rbac: ["OWNER", "ADMIN"],
          },
        ],
      },
    ];

    renderWithProvider(
      <NavigationShell
        navSections={gatedSections}
        currentRoute="/team"
        accountContext={{ ...accountContext, role: "ADMIN", roles: ["ADMIN"] }}
        onRouteSelect={vi.fn()}
        forceLayout="desktop"
      >
        <div>Content</div>
      </NavigationShell>,
    );

    expect(screen.getByText("Team")).toBeInTheDocument();
  });

  it("errs open when the actor's roles are unknown (still loading)", () => {
    const gatedSections: NavigationSection[] = [
      {
        id: "main",
        label: "Main",
        items: [
          {
            id: "team",
            label: "Team",
            route: "/team",
            rbac: ["OWNER", "ADMIN"],
          },
        ],
      },
    ];

    renderWithProvider(
      <NavigationShell
        navSections={gatedSections}
        currentRoute="/team"
        // No `roles` and no `role` → unknown actor; show items rather than
        // hide everything (server-side checks remain the real boundary).
        accountContext={{ id: "ctx-1", label: "Acme Org", type: "org" }}
        onRouteSelect={vi.fn()}
        forceLayout="desktop"
      >
        <div>Content</div>
      </NavigationShell>,
    );

    expect(screen.getByText("Team")).toBeInTheDocument();
  });

  it("invokes route selection callbacks with meta", async () => {
    const user = userEvent.setup();
    const onRouteSelect = vi.fn();
    const onRouteAnalytics = vi.fn();

    renderShell({
      onRouteSelect,
      analytics: { onRouteSelect: onRouteAnalytics },
    });

    // Nav items render as <a> on web for right-click and screen reader support.
    await actClick(user, screen.getByRole("link", { name: "Dashboard" }));

    expect(onRouteSelect).toHaveBeenCalledWith("/dashboard", {
      source: "rail",
      sectionId: "main",
      parentId: undefined,
    });
    expect(onRouteAnalytics).toHaveBeenCalledWith({
      routeId: "/dashboard",
      meta: { source: "rail", sectionId: "main", parentId: undefined },
    });
  });

  it("closes the drawer after selecting a route on mobile", async () => {
    const user = userEvent.setup();
    const onRouteSelect = vi.fn();
    setMockWidth(480);

    renderWithProvider(
      <NavigationShell
        navSections={baseSections}
        currentRoute="/events"
        accountContext={accountContext}
        onRouteSelect={onRouteSelect}
        forceLayout="mobile"
        testIdBase="nav-shell"
      >
        <div>Content</div>
      </NavigationShell>,
    );

    // Two visible items → the bottom bar has no MORE tab, so the top-bar
    // hamburger survives as the drawer's only entry point.
    await actClick(user, screen.getByLabelText(/toggle navigation drawer/i));
    await waitFor(() =>
      expect(screen.getByTestId("nav-shell-drawer")).toBeInTheDocument(),
    );
    const drawer = screen.getByTestId("nav-shell-drawer");
    const drawerDashboard = within(drawer).getByRole("link", {
      name: "Dashboard",
    });
    expect(drawerDashboard).toBeVisible();

    await actClick(user, drawerDashboard);

    await waitFor(() => {
      expect(screen.queryByTestId("nav-shell-drawer")).not.toBeInTheDocument();
    });
    expect(onRouteSelect).toHaveBeenCalled();
  });

  // The dashboard is no longer a nav item, and the rail is never mounted on
  // mobile — so the drawer's account header is the ONLY way home there.
  it("links the drawer account header home and closes the drawer", async () => {
    const user = userEvent.setup();
    const onIdentityPress = vi.fn();
    setMockWidth(480);

    renderWithProvider(
      <NavigationShell
        navSections={baseSections}
        currentRoute="/events"
        accountContext={accountContext}
        onRouteSelect={vi.fn()}
        forceLayout="mobile"
        showRailIdentity
        railIdentityHref="/admin/acme/dashboard"
        onRailIdentityPress={onIdentityPress}
        railIdentityLabel="Go to Acme dashboard"
        testIdBase="nav-shell"
      >
        <div>Content</div>
      </NavigationShell>,
    );

    await actClick(user, screen.getByLabelText(/toggle navigation drawer/i));
    await waitFor(() =>
      expect(screen.getByTestId("nav-shell-drawer")).toBeInTheDocument(),
    );

    const drawer = screen.getByTestId("nav-shell-drawer");
    const identity = within(drawer).getByRole("link", {
      name: "Go to Acme dashboard",
    });
    expect(identity.tagName).toBe("A");
    expect(identity).toHaveAttribute("href", "/admin/acme/dashboard");
    expect(identity).toHaveAccessibleName("Go to Acme dashboard");

    await actClick(user, identity);

    expect(onIdentityPress).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByTestId("nav-shell-drawer")).not.toBeInTheDocument();
    });
  });

  // `BackRow` calls `back.onPress()` directly instead of going through
  // `onSelect`, and `onSelect` is the only path that closes the drawer — so
  // "← All events" used to navigate and leave the drawer open over the new
  // route. The rail's own copy of `back` must stay unwrapped, so this is only
  // asserted for the drawer.
  it("closes the drawer after using the rail back row on mobile", async () => {
    const user = userEvent.setup();
    const onBackPress = vi.fn();
    setMockWidth(480);

    renderWithProvider(
      <NavigationShell
        navSections={baseSections}
        currentRoute="/events"
        accountContext={accountContext}
        onRouteSelect={vi.fn()}
        forceLayout="mobile"
        railBack={{ label: "All events", onPress: onBackPress }}
        testIdBase="nav-shell"
      >
        <div>Content</div>
      </NavigationShell>,
    );

    await actClick(user, screen.getByLabelText(/toggle navigation drawer/i));
    await waitFor(() =>
      expect(screen.getByTestId("nav-shell-drawer")).toBeInTheDocument(),
    );

    const drawer = screen.getByTestId("nav-shell-drawer");
    await actClick(user, within(drawer).getByText("All events"));

    expect(onBackPress).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByTestId("nav-shell-drawer")).not.toBeInTheDocument();
    });
  });

  it("renders the bottom nav on mobile and dispatches route metadata", async () => {
    const user = userEvent.setup();
    const onRouteSelect = vi.fn();
    const mobileSections: NavigationSection[] = [
      {
        id: "main",
        label: "Main",
        items: [
          { id: "dashboard", label: "Dashboard", route: "/dashboard" },
          { id: "events", label: "Events", route: "/events" },
          { id: "orders", label: "Orders", route: "/orders" },
          { id: "payouts", label: "Payouts", route: "/payouts" },
          { id: "settings", label: "Settings", route: "/settings" },
        ],
      },
    ];

    renderWithProvider(
      <NavigationShell
        navSections={mobileSections}
        currentRoute="/events"
        accountContext={accountContext}
        onRouteSelect={onRouteSelect}
        forceLayout="mobile"
        testIdBase="nav-shell"
      >
        <div>Content</div>
      </NavigationShell>,
    );

    const bottomNav = screen.getByTestId("nav-shell-bottom-nav");
    expect(bottomNav).toBeInTheDocument();

    // The bottom-nav Pressables carry aria-label "<label> tab" (mirrored by
    // the react-native stub since it learned accessibility mapping).
    await actClick(
      user,
      within(bottomNav).getByRole("button", { name: "Dashboard tab" }),
    );

    expect(onRouteSelect).toHaveBeenCalledWith("/dashboard", {
      source: "mobile-bottom",
      sectionId: "main",
      parentId: undefined,
    });

    await actClick(
      user,
      within(bottomNav).getByRole("button", { name: "More tab" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("nav-shell-drawer")).toBeInTheDocument(),
    );
  });

  describe("mobile top bar (two-control rule)", () => {
    const fiveItemSections: NavigationSection[] = [
      {
        id: "main",
        label: "Main",
        items: [
          { id: "dashboard", label: "Dashboard", route: "/dashboard" },
          { id: "events", label: "Events", route: "/events" },
          { id: "orders", label: "Orders", route: "/orders" },
          { id: "payouts", label: "Payouts", route: "/payouts" },
          { id: "settings", label: "Settings", route: "/settings" },
        ],
      },
    ];

    const renderMobileShell = (override?: Partial<NavigationShellProps>) =>
      renderWithProvider(
        <NavigationShell
          navSections={fiveItemSections}
          currentRoute="/events"
          accountContext={accountContext}
          onRouteSelect={vi.fn()}
          forceLayout="mobile"
          testIdBase="nav-shell"
          {...override}
        >
          <div>Content</div>
        </NavigationShell>,
      );

    beforeEach(() => {
      setMockWidth(390);
    });

    it("hides the hamburger when the bottom bar offers its MORE tab", () => {
      renderMobileShell();

      const bottomNav = screen.getByTestId("nav-shell-bottom-nav");
      expect(
        within(bottomNav).getByRole("button", { name: "More tab" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByLabelText(/toggle navigation drawer/i),
      ).not.toBeInTheDocument();
    });

    it("keeps the hamburger when every section filters away (no bottom bar)", async () => {
      const user = userEvent.setup();
      renderMobileShell({
        navSections: [
          {
            id: "ops",
            label: "Operations",
            rbac: ["ADMIN"],
            items: [{ id: "reports", label: "Reports", route: "/reports" }],
          },
        ],
        accountContext: {
          ...accountContext,
          role: "VIEWER",
          roles: ["VIEWER"],
        },
      });

      expect(screen.queryByTestId("nav-shell-bottom-nav")).toBeNull();

      const hamburger = screen.getByLabelText(/toggle navigation drawer/i);
      await actClick(user, hamburger);
      await waitFor(() =>
        expect(screen.getByTestId("nav-shell-drawer")).toBeInTheDocument(),
      );
    });

    it("hides the brand and renders the full workspace label as the leading anchor", () => {
      renderMobileShell({ brand: <span>BRANDMARK</span> });

      expect(screen.queryByText("BRANDMARK")).toBeNull();

      const trigger = screen.getByTestId("nav-shell-top-bar-context-trigger");
      expect(within(trigger).getByText("Acme Org")).toBeInTheDocument();
      expect(within(trigger).getByText("Group Admin")).toBeInTheDocument();
    });

    it("still renders the brand on desktop", () => {
      setMockWidth(1440);
      renderMobileShell({
        brand: <span>BRANDMARK</span>,
        forceLayout: "desktop",
      });

      expect(screen.getByText("BRANDMARK")).toBeInTheDocument();
    });

    it("keeps the drawer footer OUTSIDE the scrollable nav body (pinned + always reachable)", async () => {
      const user = userEvent.setup();
      renderMobileShell({
        quickActionFooter: <div data-testid="prefs-block">Preferences</div>,
      });

      // Open via the bottom bar's MORE tab (5 items → MORE present).
      const bottomNav = screen.getByTestId("nav-shell-bottom-nav");
      await actClick(
        user,
        within(bottomNav).getByRole("button", { name: "More tab" }),
      );
      await waitFor(() =>
        expect(screen.getByTestId("nav-shell-drawer")).toBeInTheDocument(),
      );

      // The body is the web scroll region (overflow-y is an inline style —
      // jsdom does no layout, so structure/styles are the honest assertions
      // here; the live 390×844 clip was measured in a real browser).
      const body = screen.getByTestId("nav-shell-drawer-body");
      expect(body).toHaveStyle({ overflowY: "auto" });

      // Nav items live INSIDE the scroll region…
      expect(
        within(body).getByRole("link", { name: "Dashboard" }),
      ).toBeInTheDocument();

      // …while the footer is a SIBLING pinned on the surface, never a
      // descendant of the scrollable body.
      const footer = screen.getByTestId("nav-shell-drawer-footer");
      expect(within(footer).getByTestId("prefs-block")).toBeInTheDocument();
      expect(body.contains(footer)).toBe(false);
      expect(
        screen.getByTestId("nav-shell-drawer-surface").contains(footer),
      ).toBe(true);
    });

    it("resolves a function navbarTrailingSlot with the resolved layout", () => {
      renderMobileShell({
        navbarTrailingSlot: (layout) => <span>{`slot:${layout}`}</span>,
      });

      expect(screen.getByText("slot:mobile")).toBeInTheDocument();
      expect(screen.queryByText("slot:desktop")).toBeNull();
    });
  });

  describe("rail visibility across layouts (PART 2 — compact icon rail)", () => {
    it("renders the ICON rail, not nothing, when compact starts collapsed", () => {
      setMockWidth(1000);
      renderShell({ forceLayout: "compact" });

      // useRailState default for non-desktop auto behavior is "collapsed" —
      // previously this rendered NO rail at all.
      const rail = screen.getByRole("navigation", { name: "Main navigation" });
      // Items stay reachable via their accessible names…
      expect(
        within(rail).getByRole("link", { name: "Dashboard" }),
      ).toBeInTheDocument();
      // …while labels and section headings are visually absent in icon mode.
      expect(within(rail).queryByText("Dashboard")).toBeNull();
      expect(within(rail).queryByText("Main")).toBeNull();
    });

    it("gives every icon-rail item an accessible name and marks the active item", () => {
      setMockWidth(1000);
      renderShell({ forceLayout: "compact" });

      const rail = screen.getByRole("navigation", { name: "Main navigation" });
      const links = within(rail).getAllByRole("link");
      expect(links).toHaveLength(2);
      for (const link of links) {
        expect(link).toHaveAccessibleName();
      }

      // currentRoute is "/events" — the active row keeps aria-current and the
      // data-active hook that drives the 3px spine + accent tint.
      const active = within(rail).getByRole("link", { name: "Events" });
      expect(active).toHaveAttribute("aria-current", "page");
      expect(active).toHaveAttribute("data-active", "true");
      expect(
        within(rail).getByRole("link", { name: "Dashboard" }),
      ).toHaveAttribute("data-active", "false");
    });

    it("renders the labelled rail on desktop (default expanded)", () => {
      renderShell();

      const rail = screen.getByRole("navigation", { name: "Main navigation" });
      expect(within(rail).getByText("Dashboard")).toBeInTheDocument();
      expect(within(rail).getByText("Main")).toBeInTheDocument();
    });

    it("renders no rail at all on mobile", () => {
      setMockWidth(390);
      renderShell({ forceLayout: "mobile" });

      // The drawer's embedded rail only mounts while the drawer is open.
      expect(
        screen.queryByRole("navigation", { name: "Main navigation" }),
      ).toBeNull();
    });

    it("gives the rail toggle a ≥44×44 hit box (sole expand affordance at compact)", () => {
      renderShell();

      // Structural assertion only — jsdom does no layout. The 44px floor is
      // carried as explicit min dimensions on the chrome-weight button.
      expect(
        screen.getByRole("button", { name: "Collapse navigation rail" }),
      ).toHaveStyle({ minWidth: "44px", minHeight: "44px" });
    });

    it("picks the loading skeleton frame by railState, not layout (no 256→72 snap)", () => {
      // Desktop + explicitly collapsed rail → the 72px skeleton frame.
      const collapsedRender = renderShell({
        loading: true,
        railBehavior: "collapsed",
      });
      expect(
        collapsedRender.container.querySelector(
          ".is_NavigationShellCompactRailSkeleton",
        ),
      ).not.toBeNull();
      collapsedRender.unmount();

      // Desktop expanded (default) → the wide frame, never the compact one.
      const expandedRender = renderShell({ loading: true });
      expect(
        expandedRender.container.querySelector(
          ".is_NavigationShellCompactRailSkeleton",
        ),
      ).toBeNull();
      expect(
        expandedRender.container.querySelector(
          ".is_NavigationShellRailSkeleton",
        ),
      ).not.toBeNull();
    });

    it("toggles icon rail → labelled rail → icon rail via the navbar control", async () => {
      const user = userEvent.setup();
      setMockWidth(1000);
      renderShell({ forceLayout: "compact" });

      // Starts collapsed → the toggle offers "Expand".
      await actClick(
        user,
        screen.getByRole("button", { name: "Expand navigation rail" }),
      );
      let rail = screen.getByRole("navigation", { name: "Main navigation" });
      expect(within(rail).getByText("Dashboard")).toBeInTheDocument();

      // And back to the icon rail — never to nothing.
      await actClick(
        user,
        screen.getByRole("button", { name: "Collapse navigation rail" }),
      );
      rail = screen.getByRole("navigation", { name: "Main navigation" });
      expect(within(rail).queryByText("Dashboard")).toBeNull();
      expect(
        within(rail).getByRole("link", { name: "Dashboard" }),
      ).toBeInTheDocument();
    });
  });

  it("renders the workspace identity block in the rail when showRailIdentity is set", () => {
    renderShell({ showRailIdentity: true });

    // Scope to the rail — the navbar workspace switcher renders the same
    // initials/label.
    const rail = screen.getByRole("navigation", { name: "Main navigation" });
    expect(within(rail).getByText("AO")).toBeInTheDocument();
    expect(within(rail).getByText("Acme Org")).toBeInTheDocument();
    expect(within(rail).getByText("ADMIN")).toBeInTheDocument();
  });

  it("omits the identity block by default", () => {
    renderShell();
    const rail = screen.getByRole("navigation", { name: "Main navigation" });
    expect(within(rail).queryByText("AO")).toBeNull();
  });

  it("keeps the identity block inert when no href/onPress is supplied", () => {
    renderShell({ showRailIdentity: true });
    const rail = screen.getByRole("navigation", { name: "Main navigation" });
    // Scope to the identity block itself — the rail also has a nav item
    // literally called "Dashboard".
    const identityName = within(rail).getByText("Acme Org");
    expect(identityName.closest("a")).toBeNull();
    expect(identityName.closest("button")).toBeNull();
  });

  it("renders the identity block as a single labelled link when an href is supplied", () => {
    renderShell({
      showRailIdentity: true,
      railIdentityHref: "/admin/acme-co/dashboard",
      onRailIdentityPress: vi.fn(),
      railIdentityLabel: "Go to Acme Org dashboard",
    });

    const rail = screen.getByRole("navigation", { name: "Main navigation" });
    const links = within(rail).getAllByRole("link", {
      name: "Go to Acme Org dashboard",
    });
    // Exactly ONE "go to dashboard" affordance — no nested link-in-button.
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/admin/acme-co/dashboard");
    // The whole row is the target: avatar initials AND the name live inside.
    expect(within(links[0] as HTMLElement).getByText("AO")).toBeInTheDocument();
    expect(
      within(links[0] as HTMLElement).getByText("Acme Org"),
    ).toBeInTheDocument();
    expect(
      within(links[0] as HTMLElement).getByText("ADMIN"),
    ).toBeInTheDocument();
  });

  it("fires the identity press exactly once on a plain click", async () => {
    const user = userEvent.setup();
    const onRailIdentityPress = vi.fn();
    renderShell({
      showRailIdentity: true,
      railIdentityHref: "/admin/acme-co/dashboard",
      onRailIdentityPress,
      railIdentityLabel: "Go to Acme Org dashboard",
    });

    const rail = screen.getByRole("navigation", { name: "Main navigation" });
    await actClick(
      user,
      within(rail).getByRole("link", { name: "Go to Acme Org dashboard" }),
    );

    // Once, not twice — the anchor path must not also wire onPress.
    expect(onRailIdentityPress).toHaveBeenCalledTimes(1);
  });

  it("lets a modifier-click fall through to the browser", async () => {
    const user = userEvent.setup();
    const onRailIdentityPress = vi.fn();
    renderShell({
      showRailIdentity: true,
      railIdentityHref: "/admin/acme-co/dashboard",
      onRailIdentityPress,
      railIdentityLabel: "Go to Acme Org dashboard",
    });

    const rail = screen.getByRole("navigation", { name: "Main navigation" });
    const link = within(rail).getByRole("link", {
      name: "Go to Acme Org dashboard",
    });
    await act(async () => {
      await user.keyboard("{Meta>}");
      await user.click(link);
      await user.keyboard("{/Meta}");
    });

    expect(onRailIdentityPress).not.toHaveBeenCalled();
  });

  it("renders the identity block as a button when only onPress is supplied", async () => {
    const user = userEvent.setup();
    const onRailIdentityPress = vi.fn();
    renderShell({
      showRailIdentity: true,
      onRailIdentityPress,
      railIdentityLabel: "Go to Acme Org dashboard",
    });

    const rail = screen.getByRole("navigation", { name: "Main navigation" });
    const button = within(rail).getByRole("button", {
      name: "Go to Acme Org dashboard",
    });
    await actClick(user, button);
    expect(onRailIdentityPress).toHaveBeenCalledTimes(1);
  });

  it("keeps the collapsed icon rail identity clickable and labelled", async () => {
    const user = userEvent.setup();
    const onRailIdentityPress = vi.fn();
    renderShell({
      showRailIdentity: true,
      railBehavior: "collapsed",
      railIdentityHref: "/admin/acme-co/dashboard",
      onRailIdentityPress,
      railIdentityLabel: "Go to Acme Org dashboard",
    });

    const rail = screen.getByRole("navigation", { name: "Main navigation" });
    // Avatar only — the name/role are hidden in the 72px rail.
    expect(within(rail).queryByText("Acme Org")).toBeNull();
    const link = within(rail).getByRole("link", {
      name: "Go to Acme Org dashboard",
    });
    expect(within(link as HTMLElement).getByText("AO")).toBeInTheDocument();
    await actClick(user, link);
    expect(onRailIdentityPress).toHaveBeenCalledTimes(1);
  });

  it("names the collapsed identity link even when actionLabel is omitted", () => {
    // The 72px rail renders the avatar only (aria-hidden) — with no
    // actionLabel and no fallback this would be an <a> announced as a bare
    // "link". The tooltip cannot rescue it: it contributes aria-describedby,
    // and a description is never an accessible name.
    renderShell({
      showRailIdentity: true,
      railBehavior: "collapsed",
      railIdentityHref: "/admin/acme-co/dashboard",
      onRailIdentityPress: vi.fn(),
    });

    const rail = screen.getByRole("navigation", { name: "Main navigation" });
    const link = within(rail).getByRole("link", { name: "Acme Org" });
    expect(link).toHaveAttribute("href", "/admin/acme-co/dashboard");
  });

  it("leaves the wide identity row to its visible text when actionLabel is omitted", () => {
    renderShell({
      showRailIdentity: true,
      railIdentityHref: "/admin/acme-co/dashboard",
      onRailIdentityPress: vi.fn(),
    });

    const rail = screen.getByRole("navigation", { name: "Main navigation" });
    // No aria-label: the name is composed from the rendered label + sublabel.
    const link = within(rail).getByRole("link", { name: "Acme Org ADMIN" });
    expect(link).not.toHaveAttribute("aria-label");
  });

  it("skips hideInBottomBar items in the mobile bottom bar but keeps them in the drawer rail", async () => {
    const user = userEvent.setup();
    const mobileSections: NavigationSection[] = [
      {
        id: "main",
        label: "Main",
        items: [
          { id: "dashboard", label: "Dashboard", route: "/dashboard" },
          {
            id: "search",
            label: "Search",
            route: "/search",
            hideInBottomBar: true,
          },
          { id: "events", label: "Events", route: "/events" },
          { id: "orders", label: "Orders", route: "/orders" },
          { id: "payouts", label: "Payouts", route: "/payouts" },
          { id: "settings", label: "Settings", route: "/settings" },
        ],
      },
    ];

    renderWithProvider(
      <NavigationShell
        navSections={mobileSections}
        currentRoute="/events"
        accountContext={accountContext}
        onRouteSelect={vi.fn()}
        forceLayout="mobile"
        testIdBase="nav-shell"
      >
        <div>Content</div>
      </NavigationShell>,
    );

    const bottomNav = screen.getByTestId("nav-shell-bottom-nav");
    // Search yields its primary slot; the next items take it (5 visible items
    // > maxItems 4 → three primaries + More). Tab buttons are aria-labelled
    // "<label> tab".
    expect(
      within(bottomNav).queryByRole("button", { name: "Search tab" }),
    ).toBeNull();
    expect(
      within(bottomNav).getByRole("button", { name: "Dashboard tab" }),
    ).toBeInTheDocument();
    expect(
      within(bottomNav).getByRole("button", { name: "Events tab" }),
    ).toBeInTheDocument();
    expect(
      within(bottomNav).getByRole("button", { name: "Orders tab" }),
    ).toBeInTheDocument();

    // Still reachable from the drawer (full rail).
    await actClick(
      user,
      within(bottomNav).getByRole("button", { name: "More tab" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("nav-shell-drawer")).toBeInTheDocument(),
    );
    const drawer = screen.getByTestId("nav-shell-drawer");
    expect(
      within(drawer).getByRole("link", { name: "Search" }),
    ).toBeInTheDocument();
  });

  it("renders the edge swipe zone on native mobile", () => {
    const platformSpy = vi.spyOn(Platform, "OS", "get").mockReturnValue("ios");
    setMockWidth(480);
    renderWithProvider(
      <NavigationShell
        navSections={baseSections}
        currentRoute="/events"
        accountContext={accountContext}
        onRouteSelect={vi.fn()}
        forceLayout="mobile"
        testIdBase="nav-shell"
      >
        <div>Content</div>
      </NavigationShell>,
    );
    expect(screen.getByTestId("nav-shell-edge-swipe")).toBeInTheDocument();
    platformSpy.mockRestore();
  });

  it("fires quick action analytics when invoked", async () => {
    const user = userEvent.setup();
    const quickAction = { id: "invite", label: "Invite", onSelect: vi.fn() };
    const analytics = { onQuickAction: vi.fn() };

    renderShell({ quickActions: [quickAction], analytics });

    await actClick(user, screen.getByRole("button", { name: "Invite" }));

    expect(quickAction.onSelect).toHaveBeenCalled();
    expect(analytics.onQuickAction).toHaveBeenCalledWith({
      actionId: "invite",
    });
  });

  describe("collapsible section groups", () => {
    const groupedSections: NavigationSection[] = [
      {
        id: "overview",
        label: "Overview",
        items: [{ id: "dashboard", label: "Dashboard", route: "/dashboard" }],
      },
      {
        id: "sales",
        label: "Sales",
        items: [{ id: "orders", label: "Orders", route: "/orders" }],
      },
    ];

    const renderGroupedShell = (override?: Partial<NavigationShellProps>) =>
      renderWithProvider(
        <NavigationShell
          navSections={groupedSections}
          currentRoute="/dashboard"
          accountContext={accountContext}
          onRouteSelect={vi.fn()}
          forceLayout="desktop"
          collapsibleSections
          {...override}
        >
          <div>Content</div>
        </NavigationShell>,
      );

    it("toggles a section's items closed and open via its header button", async () => {
      const user = userEvent.setup();
      renderGroupedShell();

      const salesHeader = screen.getByRole("button", { name: "Sales" });
      expect(salesHeader).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByRole("link", { name: "Orders" })).toBeInTheDocument();

      await actClick(user, salesHeader);

      expect(salesHeader).toHaveAttribute("aria-expanded", "false");
      // The Reveal collapse unmounts the items after its animation window.
      await waitFor(() => {
        expect(screen.queryByRole("link", { name: "Orders" })).toBeNull();
      });
      // The other section is untouched.
      expect(
        screen.getByRole("link", { name: "Dashboard" }),
      ).toBeInTheDocument();

      await actClick(user, salesHeader);

      expect(salesHeader).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByRole("link", { name: "Orders" })).toBeInTheDocument();
    });

    it("keeps the section containing the active route open and ignores its toggle", async () => {
      const user = userEvent.setup();
      renderGroupedShell({ currentRoute: "/orders" });

      const salesHeader = screen.getByRole("button", { name: "Sales" });
      expect(salesHeader).toHaveAttribute("aria-disabled", "true");

      await actClick(user, salesHeader);

      expect(salesHeader).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByRole("link", { name: "Orders" })).toBeInTheDocument();
    });

    it("persists closed sections to localStorage and restores them on remount", async () => {
      const user = userEvent.setup();
      const first = renderGroupedShell({
        sectionCollapsePersistKey: "acme-co",
      });

      await actClick(user, screen.getByRole("button", { name: "Sales" }));

      expect(window.localStorage.getItem("th-nav-sections:acme-co")).toBe(
        JSON.stringify(["sales"]),
      );

      first.unmount();
      renderGroupedShell({ sectionCollapsePersistKey: "acme-co" });

      // The closed set hydrates from storage after mount.
      await waitFor(() => {
        expect(screen.queryByRole("link", { name: "Orders" })).toBeNull();
      });
      expect(
        screen.getByRole("button", { name: "Sales" }),
      ).toHaveAttribute("aria-expanded", "false");
      expect(
        screen.getByRole("link", { name: "Dashboard" }),
      ).toBeInTheDocument();
    });

    it("auto-opens a closed section when the route moves into it", async () => {
      const user = userEvent.setup();
      const renderProps = (currentRoute: string) => (
        <NavigationShell
          navSections={groupedSections}
          currentRoute={currentRoute}
          accountContext={accountContext}
          onRouteSelect={vi.fn()}
          forceLayout="desktop"
          collapsibleSections
          sectionCollapsePersistKey="acme-co"
        >
          <div>Content</div>
        </NavigationShell>
      );
      const { rerender } = renderWithProvider(renderProps("/dashboard"));

      await actClick(user, screen.getByRole("button", { name: "Sales" }));
      await waitFor(() => {
        expect(screen.queryByRole("link", { name: "Orders" })).toBeNull();
      });
      expect(window.localStorage.getItem("th-nav-sections:acme-co")).toBe(
        JSON.stringify(["sales"]),
      );

      rerender(renderProps("/orders"));

      await waitFor(() => {
        expect(
          screen.getByRole("link", { name: "Orders" }),
        ).toBeInTheDocument();
      });
      expect(
        screen.getByRole("button", { name: "Sales" }),
      ).toHaveAttribute("aria-expanded", "true");
      // The auto-open is persisted, not just visual.
      expect(window.localStorage.getItem("th-nav-sections:acme-co")).toBe(
        JSON.stringify([]),
      );
    });

    it("renders child groups as toggle rows: closed by default, open on press, open when a child is active", async () => {
      const user = userEvent.setup();
      const sectionsWithGroup: NavigationSection[] = [
        {
          id: "workspace",
          label: "Workspace",
          items: [
            {
              id: "settings",
              label: "Settings",
              route: "/settings",
              children: [
                { id: "general", label: "General", route: "/settings" },
                {
                  id: "contact",
                  label: "Contact",
                  route: "/settings/contact",
                },
              ],
            },
          ],
        },
        ...groupedSections,
      ];

      const renderProps = (currentRoute: string) => (
        <NavigationShell
          navSections={sectionsWithGroup}
          currentRoute={currentRoute}
          accountContext={accountContext}
          onRouteSelect={vi.fn()}
          forceLayout="desktop"
          collapsibleSections
        >
          <div>Content</div>
        </NavigationShell>
      );
      const { rerender } = renderWithProvider(renderProps("/dashboard"));

      // Closed by default when no child route is active.
      const settingsRow = screen.getByRole("button", { name: "Settings" });
      expect(settingsRow).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByRole("link", { name: "Contact" })).toBeNull();

      // Press → children appear as normal nav links.
      await actClick(user, settingsRow);
      expect(settingsRow).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByRole("link", { name: "Contact" })).toBeInTheDocument();

      // Press again → children collapse (Reveal unmounts after animating).
      await actClick(user, settingsRow);
      expect(settingsRow).toHaveAttribute("aria-expanded", "false");
      await waitFor(() => {
        expect(screen.queryByRole("link", { name: "Contact" })).toBeNull();
      });

      // Route moves onto a child → the user's closed override clears.
      rerender(renderProps("/settings/contact"));
      await waitFor(() => {
        expect(
          screen.getByRole("link", { name: "Contact" }),
        ).toBeInTheDocument();
      });
      const activeSettingsRow = screen.getByRole("button", {
        name: "Settings",
      });
      // Locked open: presented as a static disclosure (no aria-expanded
      // toggle) so it never invites a collapse the lock-open effect would
      // instantly undo. Pressing it is a no-op; the active child stays visible.
      expect(activeSettingsRow).not.toHaveAttribute("aria-expanded");
      await actClick(user, activeSettingsRow);
      expect(
        screen.getByRole("link", { name: "Contact" }),
      ).toBeInTheDocument();
    });

    it("roving arrow keys skip a closed section's hidden items and land on the next header", async () => {
      // Pre-seed overview closed; route into sales so sales is locked open.
      window.localStorage.setItem(
        "th-nav-sections:acme-co",
        JSON.stringify(["overview"]),
      );
      const { container } = renderWithProvider(
        <NavigationShell
          navSections={groupedSections}
          currentRoute="/orders"
          accountContext={accountContext}
          onRouteSelect={vi.fn()}
          forceLayout="desktop"
          collapsibleSections
          sectionCollapsePersistKey="acme-co"
        >
          <div>Content</div>
        </NavigationShell>,
      );

      // overview hydrates closed → its Dashboard item unmounts.
      await waitFor(() => {
        expect(screen.queryByRole("link", { name: "Dashboard" })).toBeNull();
      });

      const overviewHeader = container.querySelector(
        '[data-nav-id="header:overview"]',
      ) as HTMLElement | null;
      const salesHeader = container.querySelector(
        '[data-nav-id="header:sales"]',
      ) as HTMLElement | null;
      const ordersItem = container.querySelector('[data-nav-id="sales:orders"]');
      expect(overviewHeader).not.toBeNull();
      expect(salesHeader).not.toBeNull();

      act(() => overviewHeader?.focus());
      expect(document.activeElement).toBe(overviewHeader);

      // ArrowDown must skip the unmounted Dashboard item (still in the DOM
      // tree it would be `sales`'s predecessor) and land on the next header.
      // A regression that left the closed item in focusOrder would dead-key
      // here (focusById no-ops on the null ref) and focus would not move.
      act(() => {
        fireEvent.keyDown(window, { key: "ArrowDown" });
      });
      expect(document.activeElement).toBe(salesHeader);

      act(() => {
        fireEvent.keyDown(window, { key: "ArrowDown" });
      });
      expect(document.activeElement).toBe(ordersItem);
    });

    it("renders no header for a section whose items all filter away", () => {
      const gatedSections: NavigationSection[] = [
        ...groupedSections,
        {
          id: "ops",
          label: "Operations",
          items: [
            {
              id: "reports",
              label: "Reports",
              route: "/reports",
              rbac: ["ADMIN"],
            },
          ],
        },
      ];

      renderGroupedShell({
        navSections: gatedSections,
        accountContext: {
          ...accountContext,
          role: "VIEWER",
          roles: ["VIEWER"],
        },
      });

      expect(screen.queryByText("Operations")).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Operations" }),
      ).toBeNull();
      // Surviving sections still render their headers.
      expect(screen.getByRole("button", { name: "Sales" })).toBeInTheDocument();
    });

    it("ignores section collapse in the 72px icon rail (all items visible, no header toggles)", () => {
      // Pre-seed a closed section; the icon rail must ignore it.
      window.localStorage.setItem(
        "th-nav-sections:acme-co",
        JSON.stringify(["sales"]),
      );

      // Exercise the icon rail via NavigationRail directly to keep this a
      // focused unit test (the shell now renders this same collapsed mode
      // whenever railState is "collapsed" on desktop/compact).
      const { container } = renderWithProvider(
        <NavigationRail
          sections={groupedSections}
          currentRoute="/dashboard"
          collapsed
          layout="desktop"
          onSelect={vi.fn()}
          collapsibleSections
          sectionCollapsePersistKey="acme-co"
        />,
      );

      // Items of the "closed" section still render in icon-rail mode.
      expect(
        container.querySelector('[data-nav-id="sales:orders"]'),
      ).not.toBeNull();
      // No header toggle buttons in icon-rail mode.
      expect(screen.queryByRole("button", { name: "Sales" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Overview" })).toBeNull();
    });
  });

  describe("contextual rail extensions (back slot / anchor items)", () => {
    const contextSections: NavigationSection[] = [
      {
        id: "build",
        label: "Build",
        items: [
          {
            id: "essentials",
            label: "Essentials",
            route: "/admin/acme/events/e1/edit?section=essentials",
            active: true,
          },
          {
            id: "tickets",
            label: "Tickets",
            route: "/admin/acme/events/e1/edit?section=tickets",
            active: false,
          },
        ],
      },
      {
        id: "manage",
        label: "Manage",
        items: [
          {
            id: "attendees",
            label: "Attendees",
            route: "/admin/acme/events/e1/attendees",
            // Route-derived matching still applies when `active` is unset.
          },
          {
            id: "comp",
            label: "Comps",
            route: "/admin/acme/events/e1/comp-tickets",
            disabled: true,
            note: "post-pub",
          },
        ],
      },
    ];

    const renderContextRail = (
      override?: Partial<Parameters<typeof NavigationRail>[0]>,
    ) =>
      renderWithProvider(
        <NavigationRail
          sections={contextSections}
          currentRoute="events/e1/edit"
          layout="desktop"
          onSelect={vi.fn()}
          {...override}
        />,
      );

    it("renders the back slot as a link and intercepts plain clicks into onPress", () => {
      const onPress = vi.fn();
      renderContextRail({
        back: { label: "All events", href: "/admin/acme/events", onPress },
      });

      const backLink = screen.getByRole("link", { name: /all events/i });
      expect(backLink).toHaveAttribute("href", "/admin/acme/events");
      fireEvent.click(backLink);
      expect(onPress).toHaveBeenCalledTimes(1);
    });

    it("renders the context header slot above the sections", () => {
      renderContextRail({
        contextHeader: <div data-testid="event-context-header">Warehouse</div>,
      });
      expect(screen.getByTestId("event-context-header")).toBeInTheDocument();
    });

    it("honours the controlled `active` flag over route matching", () => {
      const { container } = renderContextRail();

      expect(
        container.querySelector('[data-nav-id="build:essentials"]'),
      ).toHaveAttribute("data-active", "true");
      // Same pathname family, but explicitly inactive.
      expect(
        container.querySelector('[data-nav-id="build:tickets"]'),
      ).toHaveAttribute("data-active", "false");
    });

    it("still derives active from the route when `active` is unset", () => {
      const { container } = renderContextRail({
        currentRoute: "events/e1/attendees",
      });
      expect(
        container.querySelector('[data-nav-id="manage:attendees"]'),
      ).toHaveAttribute("data-active", "true");
    });

    it("renders disabled items with a note as non-links that never fire onSelect", () => {
      const onSelect = vi.fn();
      renderContextRail({ onSelect });

      expect(screen.getByText("post-pub")).toBeInTheDocument();
      // Disabled → not an anchor (keyboard/middle-click must not navigate).
      expect(
        screen.queryByRole("link", { name: /comps/i }),
      ).not.toBeInTheDocument();

      const disabledRow = document.querySelector(
        '[data-nav-id="manage:comp"]',
      ) as HTMLElement;
      expect(disabledRow).not.toBeNull();
      fireEvent.click(disabledRow);
      expect(onSelect).not.toHaveBeenCalled();
    });
  });

  it("flips the workspace chevron when the context menu opens", async () => {
    const user = userEvent.setup();

    renderShell({
      availableContexts: [
        accountContext,
        {
          id: "ctx-2",
          label: "Side Project",
          type: "personal",
        },
      ],
    });

    expect(
      screen.getByTestId("navigation-shell-top-bar-context-chevron-down"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("navigation-shell-top-bar-context-chevron-up"),
    ).not.toBeInTheDocument();

    await actClick(user, screen.getByRole("button", { name: /acme org/i }));

    expect(
      screen.queryByTestId("navigation-shell-top-bar-context-chevron-down"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("navigation-shell-top-bar-context-chevron-up"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menu", { name: /switch workspace/i }),
    ).toBeInTheDocument();
  });
});
