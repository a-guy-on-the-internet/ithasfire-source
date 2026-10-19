import { act } from "react";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as tamagui from "tamagui";

import type { NavigationSection } from "../NavigationShell.types";
import type { AdminLedgerShellProps } from "../AdminLedgerShell.types";
import { AdminLedgerShell } from "../AdminLedgerShell";
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

const themeSpy = vi.fn();
vi.mock("tamagui", async () => {
  const actual = (await vi.importActual("tamagui")) as typeof tamagui;
  const ActualTheme = actual.Theme;
  const Theme = (props: Parameters<typeof ActualTheme>[0]) => {
    themeSpy(props);
    return <ActualTheme {...props} />;
  };
  return { ...actual, Theme };
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

const accountContext: AdminLedgerShellProps["accountContext"] = {
  id: "ctx-1",
  label: "Acme Org",
  type: "org",
  role: "ADMIN",
};

const sectionTabs = [
  { href: "/dashboard", label: "Overview" },
  { href: "/events", label: "Events", count: 4 },
  { href: "/orders", label: "Orders" },
];

const renderShell = (override?: Partial<AdminLedgerShellProps>) =>
  renderWithProvider(
    <AdminLedgerShell
      navSections={baseSections}
      currentRoute="/events"
      accountContext={accountContext}
      onRouteSelect={override?.onRouteSelect ?? vi.fn()}
      forceLayout="desktop"
      testIdBase="ledger"
      surfaceRole="Admin"
      sectionTabs={sectionTabs}
      sectionTabsLabel="Admin sections"
      sectionTabsCurrent="/events"
      contextItems={["Acme Org", "Published"]}
      contextRight="3 open"
      {...override}
    >
      <div>Content</div>
    </AdminLedgerShell>,
  );

describe("AdminLedgerShell", () => {
  beforeEach(() => {
    setMockWidth(1440);
    vi.clearAllMocks();
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.clear();
    }
  });

  it("renders the three registers plus the rail at desktop", () => {
    renderShell();

    // Register 1 — topbar with role chip and the workspace switcher.
    const topbar = screen.getByTestId("ledger-top-bar");
    expect(within(topbar).getByText("Admin")).toBeInTheDocument();
    expect(within(topbar).getByText("Acme Org")).toBeInTheDocument();

    // Register 2 — its own landmark, distinct from the rail's.
    const sections = screen.getByRole("navigation", { name: "Admin sections" });
    expect(
      within(sections).getByRole("link", { name: /Events/ }),
    ).toHaveAttribute("aria-current", "page");

    // Register 3 — facts + live figure.
    const context = screen.getByTestId("ledger-context");
    expect(within(context).getByText("Published")).toBeInTheDocument();
    expect(within(context).getByText("3 open")).toBeInTheDocument();

    // The rail is still the item-level navigation, with its own name.
    const rail = screen.getByRole("navigation", { name: "Main navigation" });
    expect(
      within(rail).getByRole("link", { name: "Dashboard" }),
    ).toBeInTheDocument();

    // Exactly two navigation landmarks, named differently (R10).
    expect(screen.getAllByRole("navigation")).toHaveLength(2);
  });

  it("hides the section tabs when the list is empty or omitted", () => {
    const { unmount } = renderShell({ sectionTabs: [] });
    expect(screen.queryByTestId("ledger-sections")).not.toBeInTheDocument();
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
    unmount();

    renderShell({ sectionTabs: undefined });
    expect(screen.queryByTestId("ledger-sections")).not.toBeInTheDocument();
  });

  it("hides the context strip when there are no facts and no figure", () => {
    renderShell({ contextItems: undefined, contextRight: undefined });
    expect(screen.queryByTestId("ledger-context")).not.toBeInTheDocument();
  });

  it("renders the topbar back affordance when railBack is set", async () => {
    const user = userEvent.setup();
    const onPress = vi.fn();
    renderShell({
      railBack: { label: "All events", href: "/events", onPress },
    });

    const back = screen.getByTestId("ledger-top-bar-back");
    expect(back).toHaveAttribute("href", "/events");
    await actClick(user, back);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("moves railBack to the topbar — the rail does not repeat it (one link per name)", () => {
    renderShell({
      railBack: { label: "All events", href: "/events", onPress: vi.fn() },
    });

    expect(screen.getAllByRole("link", { name: "All events" })).toHaveLength(1);
    const rail = screen.getByRole("navigation", { name: "Main navigation" });
    expect(
      within(rail).queryByRole("link", { name: "All events" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the labelled back affordance in the mobile drawer", async () => {
    const user = userEvent.setup();
    setMockWidth(390);
    renderShell({
      navSections: fiveItemSections,
      forceLayout: "mobile",
      railBack: { label: "All events", href: "/events", onPress: vi.fn() },
    });

    // Topbar affordance is icon-only on mobile (aria-label only, no text).
    const topbarBack = screen.getByTestId("ledger-top-bar-back");
    expect(topbarBack).toHaveAttribute("aria-label", "All events");
    expect(topbarBack).not.toHaveTextContent("All events");

    const bottomNav = screen.getByTestId("ledger-bottom-nav");
    await actClick(
      user,
      within(bottomNav).getByRole("button", { name: "More tab" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("ledger-drawer")).toBeInTheDocument(),
    );
    const drawer = screen.getByTestId("ledger-drawer");
    expect(
      within(drawer).getByRole("link", { name: "All events" }),
    ).toBeInTheDocument();
  });

  it("drops the brand and role chip on mobile — the switcher is the identity anchor", () => {
    setMockWidth(390);
    renderShell({
      forceLayout: "mobile",
      brand: <span>Brand Lockup</span>,
    });

    const topbar = screen.getByTestId("ledger-top-bar");
    expect(within(topbar).queryByText("Brand Lockup")).not.toBeInTheDocument();
    expect(within(topbar).queryByText("Ithas Fire")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ledger-top-bar-role")).not.toBeInTheDocument();
    expect(within(topbar).getByText("Acme Org")).toBeInTheDocument();
  });

  it("renders no rail on mobile and offers the drawer + bottom bar instead", async () => {
    const user = userEvent.setup();
    setMockWidth(390);
    renderShell({ navSections: fiveItemSections, forceLayout: "mobile" });

    expect(
      screen.queryByRole("navigation", { name: "Main navigation" }),
    ).not.toBeInTheDocument();

    const bottomNav = screen.getByTestId("ledger-bottom-nav");
    expect(bottomNav).toBeInTheDocument();

    await actClick(
      user,
      within(bottomNav).getByRole("button", { name: "More tab" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("ledger-drawer")).toBeInTheDocument(),
    );
  });

  it("renders the drawer toggle on every mobile page — even with no railBack and no section tabs", async () => {
    const user = userEvent.setup();
    setMockWidth(320);
    renderShell({
      navSections: baseSections,
      forceLayout: "mobile",
      railBack: undefined,
      sectionTabs: undefined,
      contextItems: undefined,
      contextRight: undefined,
    });

    const toggle = screen.getByRole("button", {
      name: /toggle navigation drawer/i,
    });
    await actClick(user, toggle);
    await waitFor(() =>
      expect(screen.getByTestId("ledger-drawer")).toBeInTheDocument(),
    );
    expect(
      within(screen.getByTestId("ledger-drawer")).getByRole("navigation", {
        name: "Main navigation",
      }),
    ).toBeInTheDocument();
  });

  it("withholds the hamburger when the bottom bar's MORE tab already opens the drawer (parity with NavigationShell)", () => {
    setMockWidth(320);
    renderShell({ navSections: fiveItemSections, forceLayout: "mobile" });

    const bottomNav = screen.getByTestId("ledger-bottom-nav");
    expect(
      within(bottomNav).getByRole("button", { name: "More tab" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /toggle navigation drawer/i }),
    ).not.toBeInTheDocument();
  });

  it("bounds the workspace switcher inside the topbar so the row cannot overflow — by SHRINKING, never by clipping", () => {
    // NOT asserted anywhere below: `minWidth: 0`. Every Tamagui View ships it
    // in `stackDefaultStyles`, so the assertion passes even with the
    // declaration deleted from source — verified by deleting it and watching
    // all 54 tests stay green. `flexShrink` is the real one: Tamagui defaults
    // it to 0, so `"1"` can only come from the source.
    setMockWidth(320);
    const { unmount } = renderShell({ forceLayout: "mobile" });

    const clamp = screen.getByTestId("ledger-top-bar-switcher");
    expect(within(clamp).getByText("Acme Org")).toBeInTheDocument();
    expect(clamp).toHaveStyle({ maxWidth: "100%", flexShrink: "1" });
    unmount();

    // DESKTOP is the layout where the anchor's own shrink is load-bearing.
    // On mobile the anchor is `width: 100%`, a percentage against the clamp's
    // USED width — it tracks the clamp whatever its flex-shrink says, so
    // shrink is inert there. On desktop/compact the anchor is `width: auto`,
    // so its flex base size is its max-content: measured in Chrome at
    // `flexShrink: 0` it held 238px while the clamp shrank to 124px at a 960
    // viewport, spilling 114px and pushing document scrollWidth to 1058.
    setMockWidth(960);
    renderShell({ forceLayout: "desktop" });
    expect(screen.getByTestId("ledger-top-bar-workspace-switcher")).toHaveStyle(
      { flexShrink: "1" },
    );
  });

  it("never clips the workspace popover: no ancestor of the open menu may hide overflow", async () => {
    // The production defect this pins. `SwitcherClamp` carried
    // `overflow: hidden`, and the popover is `position: absolute` INSIDE it —
    // an absolutely-positioned descendant is still clipped by an ancestor's
    // `overflow: hidden`, so the 48px-tall topbar box cropped the whole
    // dropdown to a sliver. Worse, a hidden box is still a scroll container:
    // the open-focus `scrollIntoView({block: "nearest"})` then scrolled that
    // sliver to the focused row (measured `scrollTop` 190), which is exactly
    // what shipped — one row, focus ring and check icon, hanging in the bar.
    //
    // Structural, not stylistic: walk the real ancestor chain of the rendered
    // popover and assert nothing on it clips. The trigger Button DOES clip —
    // deliberately, as the spill backstop — and this walk proves that is
    // safe, because the Button is the popover's SIBLING, not its ancestor.
    //
    // Two limits, both covered by a browser run instead. jsdom does no
    // layout, so nothing here could have caught the symptoms this test is
    // named for (`top: -130`, `scrollTop: 190`, a 114px spill). And jsdom
    // skips any `@media` rule whose media list is not literally `screen`, so
    // a clip re-introduced through a `$sm`/`$gtMd` variant would be invisible
    // to this walk.
    const user = userEvent.setup();
    renderShell();

    await actClick(user, screen.getByTestId("ledger-top-bar-context-trigger"));

    const menu = document.getElementById("ledger-top-bar-workspace-menu");
    expect(menu).not.toBeNull();
    // The popover FRAME is the menu's parent. It clips its OWN scroll region
    // on purpose, so the walk starts ABOVE it.
    const popover = menu!.parentElement as HTMLElement;

    // A node clips only when it DECLARES a non-visible overflow. jsdom returns
    // "" for an undeclared one, so test for the clipping values rather than
    // "not visible" — the latter flags every plain <div> in the chain.
    const CLIPS = new Set(["hidden", "clip", "auto", "scroll"]);
    const clippers: string[] = [];
    for (
      let node = popover.parentElement;
      node && node !== document.body;
      node = node.parentElement
    ) {
      const { overflowX, overflowY } = getComputedStyle(node);
      if (CLIPS.has(overflowX) || CLIPS.has(overflowY)) {
        clippers.push(
          `${node.dataset.testid ?? node.tagName}=${overflowX}/${overflowY}`,
        );
      }
    }

    expect(clippers).toEqual([]);
  });

  it("keeps the popover unclipped at 320 too — the mobile anchor is the identity slot, and the clip cropped it there as well", async () => {
    setMockWidth(320);
    const user = userEvent.setup();
    renderShell({ forceLayout: "mobile" });

    await actClick(user, screen.getByTestId("ledger-top-bar-context-trigger"));

    const menu = document.getElementById("ledger-top-bar-workspace-menu");
    expect(menu).not.toBeNull();
    const popover = menu!.parentElement as HTMLElement;

    const clamp = screen.getByTestId("ledger-top-bar-switcher");
    expect(clamp.contains(popover)).toBe(true);
    expect(clamp).toHaveStyle({ overflowX: "visible", overflowY: "visible" });
  });

  it("varies the trailing slot by layout and drops the search slot on mobile", () => {
    const { unmount } = renderShell({
      navbarSearchSlot: <div>search-slot</div>,
      navbarTrailingSlot: (layout) => <div>{`slot:${layout}`}</div>,
    });
    expect(screen.getByText("slot:desktop")).toBeInTheDocument();
    expect(screen.getByText("search-slot")).toBeInTheDocument();
    unmount();

    setMockWidth(390);
    renderShell({
      forceLayout: "mobile",
      navbarSearchSlot: <div>search-slot</div>,
      navbarTrailingSlot: (layout) => <div>{`slot:${layout}`}</div>,
    });
    expect(screen.getByText("slot:mobile")).toBeInTheDocument();
    expect(screen.queryByText("search-slot")).not.toBeInTheDocument();
  });

  it("keeps ContentArea overflow visible so sticky descendants use the document scrollport (R1)", () => {
    // Asserted on the RENDERED element, not the styled config. jsdom does
    // resolve Tamagui's class-emitted CSS (it cascades matching author rules,
    // and Tamagui inserts its atomic rules through `sheet.insertRule`), so
    // this reads the used value — which also catches a usage-site `overflow`
    // prop, the exact mistake the comment on the styled component warns
    // against. This rule is what the builder header / settings navs / table
    // headers depend on.
    renderShell();

    const content = screen.getByRole("main");
    expect(content).toHaveStyle({
      overflowX: "visible",
      overflowY: "visible",
    });
  });

  it("does not wrap the web shell in <Theme> so the light/dark toggle flows through (R6)", () => {
    renderShell();
    expect(themeSpy).not.toHaveBeenCalled();
  });

  it("renders exactly one main landmark and the skip link targets it", () => {
    renderShell();

    const mains = screen.getAllByRole("main");
    expect(mains).toHaveLength(1);
    const main = mains[0]!;
    expect(main.id).not.toBe("");

    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(skip).toHaveAttribute("href", `#${main.id}`);
  });

  it("dispatches rail route selection with meta", async () => {
    const user = userEvent.setup();
    const onRouteSelect = vi.fn();
    renderShell({ onRouteSelect });

    const rail = screen.getByRole("navigation", { name: "Main navigation" });
    await actClick(user, within(rail).getByRole("link", { name: "Dashboard" }));

    expect(onRouteSelect).toHaveBeenCalledWith("/dashboard", {
      source: "rail",
      sectionId: "main",
      parentId: undefined,
    });
  });

  it("dispatches section tab selection through onSectionTabSelect", async () => {
    const user = userEvent.setup();
    const onSectionTabSelect = vi.fn();
    renderShell({ onSectionTabSelect });

    const sections = screen.getByRole("navigation", { name: "Admin sections" });
    await actClick(
      user,
      within(sections).getByRole("link", { name: "Orders" }),
    );

    expect(onSectionTabSelect).toHaveBeenCalledWith("/orders");
  });
});
