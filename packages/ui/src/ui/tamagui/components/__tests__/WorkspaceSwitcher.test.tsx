import { act } from "react";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountContext } from "../../../types/navigation";
import {
  WorkspaceSwitcher,
  getContextRoleLabel,
} from "../navigation/WorkspaceSwitcher";
import { renderWithProvider } from "../../../../../test/utils";

const dimensionState = { width: 1440, height: 900, scale: 1, fontScale: 1 };

type ReactNativeModule = typeof import("react-native");

vi.mock("react-native", async () => {
  const actual = (await vi.importActual("react-native")) as ReactNativeModule;
  return {
    ...actual,
    Easing: actual.Easing ?? { bezier: () => (value: number) => value },
    useWindowDimensions: () => dimensionState,
  };
});

const org: AccountContext = {
  id: "acme",
  label: "Acme Organizers",
  type: "org",
  role: "ADMIN",
};

const longNameOrg: AccountContext = {
  id: "chicago",
  label: "Chicago Underground Collective",
  type: "org",
  role: "EDITOR",
};

const personal: AccountContext = {
  id: "danielle",
  label: "Danielle Rivers",
  type: "personal",
};

/**
 * The platform staff console has to declare `type: "org"` + `role: "ADMIN"`
 * for layout reasons, which made it greet every staff member as "Group Admin"
 * — an ORG role label on the staff console. `roleLabel` is the additive
 * override; `type` deliberately gained no new member (that union has consumers
 * across web and mobile).
 */
const staffConsole: AccountContext = {
  id: "platform",
  label: "Ithas Fire Platform",
  type: "org",
  role: "ADMIN",
  roleLabel: "Platform Admin",
};

const actClick = async (
  user: ReturnType<typeof userEvent.setup>,
  target: Element,
) => {
  await act(async () => {
    await user.click(target);
  });
};

const renderSwitcher = (
  override?: Partial<Parameters<typeof WorkspaceSwitcher>[0]>,
) =>
  renderWithProvider(
    <WorkspaceSwitcher
      layout="desktop"
      accountContext={org}
      availableContexts={[org, longNameOrg, personal]}
      onContextSelect={vi.fn()}
      testIdBase="nav"
      {...override}
    />,
  );

const openMenu = async (user: ReturnType<typeof userEvent.setup>) => {
  await actClick(user, screen.getByTestId("nav-context-trigger"));
  return screen.getByRole("menu");
};

describe("WorkspaceSwitcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("groups mixed contexts into PERSONAL and GROUPS sections", async () => {
    const user = userEvent.setup();
    renderSwitcher();

    const menu = await openMenu(user);

    // Section headers are uppercase-transformed via CSS; the text node itself
    // is title-case, and GROUPS carries its count once it holds more than one.
    // (`getByRole("group")` — a plain getByText("Personal") is ambiguous, the
    // personal row's own role sub-label reads "Personal" too.)
    const personalGroup = within(menu).getByRole("group", {
      name: "Personal",
    });
    expect(
      within(personalGroup).getByRole("menuitemradio", {
        name: /danielle rivers/i,
      }),
    ).toBeInTheDocument();

    // The accessible name is count-free — "Groups · 2" would be announced as
    // "Groups middle-dot 2". The count stays visual, in the header text.
    const orgGroup = within(menu).getByRole("group", { name: "Groups" });
    expect(within(orgGroup).getAllByRole("menuitemradio")).toHaveLength(2);
    expect(within(orgGroup).getByText("Groups · 2")).toBeInTheDocument();
  });

  it("marks only the active context as checked and renders the check glyph there", async () => {
    const user = userEvent.setup();
    renderSwitcher();

    const menu = await openMenu(user);
    const rows = within(menu).getAllByRole("menuitemradio");
    const active = rows.find(
      (row) => row.getAttribute("aria-checked") === "true",
    );

    expect(active).toBeDefined();
    expect(active).toHaveAccessibleName(/acme organizers/i);
    expect(
      rows.filter((r) => r.getAttribute("aria-checked") === "true"),
    ).toHaveLength(1);
    // The check icon lives on the active row only — and no chevron-right box
    // is rendered on any row.
    expect(screen.getAllByTestId("nav-workspace-item-check")).toHaveLength(1);
  });

  // Run the truncation contract against BOTH row shapes: production always
  // passes `contextHrefBuilder` (AdminShell does), so the plain-row path alone
  // was testing a shape the app never renders.
  describe.each([
    ["plain row", undefined],
    ["anchor row", (id: string) => `/admin/${id}/dashboard`],
  ] as const)("truncation — %s", (_name, contextHrefBuilder) => {
    it("truncates the name and keeps it reachable via title", async () => {
      const user = userEvent.setup();
      renderSwitcher({ contextHrefBuilder });

      const menu = await openMenu(user);

      // Assert on whichever node OWNS the role, not on a data-testid.
      const longRow = within(menu).getByRole("menuitemradio", {
        name: new RegExp(longNameOrg.label, "i"),
      });
      expect(longRow).toHaveAttribute("title", longNameOrg.label);

      const label = within(longRow).getByText(longNameOrg.label);
      expect(label).toHaveStyle({
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      });
    });
  });

  // BLOCKING 1 regression: `Avatar`'s own `size` variant emits
  // max-width/max-height atomic classes at var(--t-size-true) = 14px, which
  // beat the frameSize variant's width and collapsed the frame to 14x14.
  //
  // The fix now lives in the `Avatar` primitive (`frameSize` pins all six box
  // properties) rather than in a local override here, so this test no longer
  // guards a workaround — it guards the CONTRACT the switcher depends on: every
  // switcher avatar must still resolve to a full 40px box (`size="sm"`), from
  // wherever that sizing comes from. If the primitive regresses, or if someone
  // drops/changes the `size` prop here, this fails. Primitive-level coverage of
  // the mechanism itself is in Avatar.test.tsx. jsdom does no layout, so this
  // asserts resolved style, not a painted box.
  it("renders every switcher avatar at the full sm box, never the 14px clamp", async () => {
    const user = userEvent.setup();
    renderSwitcher();

    await openMenu(user);
    // Document-wide, not menu-scoped: the TRIGGER avatar collapsed too, and it
    // is the one that motivated the diagnosis. 3 rows + 1 trigger.
    const avatars = document.querySelectorAll(".is_Avatar");
    expect(avatars.length).toBe(4);

    avatars.forEach((avatar) => {
      expect(avatar).toHaveStyle({
        width: "40px",
        height: "40px",
        minWidth: "40px",
        minHeight: "40px",
        maxWidth: "40px",
        maxHeight: "40px",
      });
    });
  });

  it("hides the decorative monogram from the trigger's accessible name", () => {
    renderSwitcher();
    const trigger = screen.getByTestId("nav-context-trigger");
    expect(trigger.querySelector(".is_Avatar")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(trigger).toHaveAccessibleName("Acme Organizers Group Admin");
  });

  it("renders no section headers for a single-workspace account", async () => {
    const user = userEvent.setup();
    renderSwitcher({ availableContexts: [org] });

    const menu = await openMenu(user);

    expect(within(menu).queryByText("Groups")).toBeNull();
    expect(within(menu).queryByText("Personal")).toBeNull();
    expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(1);
  });

  describe("filter", () => {
    const many: AccountContext[] = Array.from({ length: 7 }, (_, i) => ({
      id: `org-${i}`,
      label: i === 0 ? "Acme Organizers" : `Workspace ${i}`,
      type: "org" as const,
      role: "ADMIN" as const,
    }));

    it("is hidden at or below the six-workspace threshold", async () => {
      const user = userEvent.setup();
      renderSwitcher({ availableContexts: many.slice(0, 6) });

      await openMenu(user);

      expect(screen.queryByTestId("nav-workspace-filter")).toBeNull();
    });

    it("appears above the threshold, filters, and shows an empty state", async () => {
      const user = userEvent.setup();
      renderSwitcher({ availableContexts: many });

      await openMenu(user);

      const filter = screen.getByTestId("nav-workspace-filter");
      expect(filter).toBeInTheDocument();
      expect(screen.getAllByRole("menuitemradio")).toHaveLength(7);

      await act(async () => {
        fireEvent.change(filter, { target: { value: "workspace 3" } });
      });

      await waitFor(() => {
        expect(screen.getAllByRole("menuitemradio")).toHaveLength(1);
      });
      expect(
        screen.getByRole("menuitemradio", { name: /workspace 3/i }),
      ).toBeInTheDocument();

      await act(async () => {
        fireEvent.change(filter, { target: { value: "zzzz" } });
      });

      await waitFor(() => {
        expect(screen.getByTestId("nav-workspace-empty")).toHaveTextContent(
          "No workspaces match",
        );
      });
      expect(screen.queryAllByRole("menuitemradio")).toHaveLength(0);
    });
  });

  it("moves focus with ArrowDown / ArrowUp and wraps at the ends", async () => {
    const user = userEvent.setup();
    renderSwitcher();

    const menu = await openMenu(user);
    // Sections render PERSONAL first, then GROUPS — so the active org sits at
    // index 1, not 0. Derive the index rather than assuming it.
    const rows = within(menu).getAllByRole("menuitemradio");
    const activeIndex = rows.findIndex(
      (row) => row.getAttribute("aria-checked") === "true",
    );
    const last = rows.length - 1;

    // Opening focuses the active workspace and gives it the only tabIndex 0.
    await waitFor(() => expect(document.activeElement).toBe(rows[activeIndex]));
    expect(rows[activeIndex]).toHaveAttribute("tabindex", "0");
    rows
      .filter((_, i) => i !== activeIndex)
      .forEach((row) => expect(row).toHaveAttribute("tabindex", "-1"));

    act(() => {
      fireEvent.keyDown(rows[activeIndex] as HTMLElement, { key: "ArrowDown" });
    });
    expect(document.activeElement).toBe(rows[activeIndex + 1]);

    act(() => {
      fireEvent.keyDown(document.activeElement as HTMLElement, {
        key: "ArrowUp",
      });
    });
    expect(document.activeElement).toBe(rows[activeIndex]);

    // Home / End jump to the ends; ArrowUp from the first item wraps to last.
    act(() => {
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Home" });
    });
    expect(document.activeElement).toBe(rows[0]);

    act(() => {
      fireEvent.keyDown(document.activeElement as HTMLElement, {
        key: "ArrowUp",
      });
    });
    expect(document.activeElement).toBe(rows[last]);

    act(() => {
      fireEvent.keyDown(document.activeElement as HTMLElement, {
        key: "ArrowDown",
      });
    });
    expect(document.activeElement).toBe(rows[0]);

    act(() => {
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: "End" });
    });
    expect(document.activeElement).toBe(rows[last]);
  });

  it("closes on Escape and restores focus to the trigger", async () => {
    const user = userEvent.setup();
    renderSwitcher();

    const menu = await openMenu(user);
    const trigger = screen.getByTestId("nav-context-trigger");

    act(() => {
      fireEvent.keyDown(menu, { key: "Escape" });
    });

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("exposes the footer actions as menu items and invokes them", async () => {
    const user = userEvent.setup();
    const onCreateOrganization = vi.fn();
    const onReturnToConsumer = vi.fn();
    renderSwitcher({
      onCreateOrganization,
      onReturnToConsumer,
      returnToConsumerDescription: "Browse events as an attendee",
    });

    const menu = await openMenu(user);

    const create = within(menu).getByRole("menuitem", {
      name: /create group/i,
    });
    const exit = within(menu).getByRole("menuitem", {
      name: /switch to attendee view/i,
    });
    expect(create).toBeInTheDocument();
    expect(exit).toBeInTheDocument();
    expect(
      within(menu).getByText("Browse events as an attendee"),
    ).toBeInTheDocument();

    await actClick(user, create);
    expect(onCreateOrganization).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("selects a workspace and reports a switch in progress", async () => {
    const user = userEvent.setup();
    const onContextSelect = vi.fn();
    renderSwitcher({ onContextSelect, contextSwitchingId: longNameOrg.id });

    const menu = await openMenu(user);
    expect(
      within(menu).getByRole("status", {
        name: `Switching to ${longNameOrg.label}`,
      }),
    ).toBeInTheDocument();

    await actClick(
      user,
      within(menu).getByRole("menuitemradio", { name: /danielle rivers/i }),
    );
    expect(onContextSelect).toHaveBeenCalledTimes(1);
    expect(onContextSelect).toHaveBeenCalledWith(personal.id);
  });

  describe("anchor rows (the shipped configuration — AdminShell always passes contextHrefBuilder)", () => {
    const contextHrefBuilder = (id: string) => `/admin/${id}/dashboard`;

    it("renders the row as a real link", async () => {
      const user = userEvent.setup();
      renderSwitcher({ contextHrefBuilder });

      const menu = await openMenu(user);
      const row = within(menu).getByRole("menuitemradio", {
        name: /danielle rivers/i,
      });

      expect(row.tagName).toBe("A");
      expect(row).toHaveAttribute("href", "/admin/danielle/dashboard");
    });

    it("fires the selection EXACTLY once on a plain click", async () => {
      const user = userEvent.setup();
      const onContextSelect = vi.fn();
      renderSwitcher({ contextHrefBuilder, onContextSelect });

      const menu = await openMenu(user);
      const row = within(menu).getByRole("menuitemradio", {
        name: /danielle rivers/i,
      });
      // Click a DESCENDANT, not the anchor itself: the inner MenuRow sits
      // BELOW the anchor, so dispatching on the anchor never puts the row on
      // React's dispatch path — an onPress re-added to the row would not fire
      // and this test would pass while the double-fire was back.
      await actClick(user, within(row).getByText(personal.label));

      // The row used to carry onPress AND sit inside an anchor with onClick,
      // so one click ran handleSelect twice (two router.push, two analytics).
      expect(onContextSelect).toHaveBeenCalledTimes(1);
    });

    it("leaves a modifier-click entirely to the browser", async () => {
      const onContextSelect = vi.fn();
      const user = userEvent.setup();
      renderSwitcher({ contextHrefBuilder, onContextSelect });

      const menu = await openMenu(user);
      const row = within(menu).getByRole("menuitemradio", {
        name: /danielle rivers/i,
      });
      // Same reasoning as above — dispatch from inside the row so the real
      // bubble path (row → anchor) is exercised.
      const target = within(row).getByText(personal.label);

      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        metaKey: true,
      });
      act(() => {
        target.dispatchEvent(event);
      });

      // ⌘-click must open a new tab and leave the current one alone: no
      // selection, and the default navigation is NOT prevented.
      expect(onContextSelect).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    });
  });

  it("keeps the mobile trigger's descriptive accessible name", () => {
    renderSwitcher({ layout: "mobile" });

    expect(
      screen.getByRole("button", {
        name: "Switch workspace: Acme Organizers, Group Admin",
      }),
    ).toBeInTheDocument();
  });

  it("spans the mobile menu across the anchor instead of a fixed 312px (guard-case hamburger offsets the anchor; 312 clips at 320–360px)", async () => {
    const user = userEvent.setup();
    renderSwitcher({ layout: "mobile" });

    const menu = await openMenu(user);
    // The popover FRAME (FloatingMenu) is the menu's parent — role="menu"
    // sits on the inner list container.
    const frame = menu.parentElement as HTMLElement;
    expect(frame).toHaveStyle({
      left: "0px",
      right: "0px",
      width: "auto",
      maxWidth: "calc(100vw - 16px)",
    });
  });

  it("keeps the desktop menu geometry (right-anchored, fixed 312px)", async () => {
    const user = userEvent.setup();
    renderSwitcher();

    const menu = await openMenu(user);
    const frame = menu.parentElement as HTMLElement;
    expect(frame).toHaveStyle({ right: "0px", width: "312px" });
  });

  describe("the trigger's horizontal bound (it is SHRINK, never a clip)", () => {
    // The admin topbar used to bound this switcher with an `overflow: hidden`
    // wrapper, which cropped the popover — an absolutely-positioned descendant
    // is still clipped by an ancestor's clip. The bound now lives in the flex
    // chain instead, and every link of that chain is asserted here: a single
    // `flexShrink: 0` or a label that cannot narrow puts the width back into
    // the document (measured in Chrome: scrollWidth 1058 at a 960 viewport).
    it("lets the anchor shrink with its parent instead of pinning to its content", () => {
      renderSwitcher();

      expect(screen.getByTestId("nav-workspace-switcher")).toHaveStyle({
        flexShrink: "1",
        minWidth: "0px",
      });
    });

    it("lets the truncating labels narrow with the trigger", () => {
      renderSwitcher();

      // `truncate` is paint-only (nowrap + ellipsis) — it gives the box no
      // ability to shrink. Under the column's old `align-items: flex-start`
      // each label sat at its own max-content width and spilled out of a
      // squeezed trigger; stretched, its used width is the column's.
      const label = within(screen.getByTestId("nav-context-trigger")).getByText(
        org.label,
      );
      const column = label.parentElement as HTMLElement;
      expect(column).toHaveStyle({ alignItems: "stretch" });
      expect(column).toHaveStyle({ flexShrink: "1" });
    });

    it("keeps the spill backstop on the TRIGGER, where it cannot reach the popover", async () => {
      // The clip has to live somewhere: the avatar and chevron are
      // `flexShrink: 0`, so a hard-squeezed `justifyContent: center` button
      // spills symmetrically over its left-hand neighbours. The Button is the
      // popover's SIBLING inside the anchor, so this is the one box in the
      // subtree that can carry it — every ancestor is off limits.
      const user = userEvent.setup();
      renderSwitcher();

      expect(screen.getByTestId("nav-context-trigger")).toHaveStyle({
        overflowX: "hidden",
        overflowY: "hidden",
      });

      const menu = await openMenu(user);
      const popover = menu.parentElement as HTMLElement;
      expect(
        screen.getByTestId("nav-context-trigger").contains(popover),
      ).toBe(false);
    });

    it("keeps both trigger labels flush left once their boxes stretch", () => {
      // Inseparable from the stretch above: the <button> host centers its
      // text, which a box hugging its own content hid. Measured in Chrome the
      // moment the boxes stretched — the role sat 33px in from the name.
      renderSwitcher();

      const trigger = screen.getByTestId("nav-context-trigger");
      expect(within(trigger).getByText(org.label)).toHaveStyle({
        textAlign: "left",
      });
      expect(within(trigger).getByText("Group Admin")).toHaveStyle({
        textAlign: "left",
      });
    });
  });

  it("shows the full workspace name + role on the mobile trigger (identity anchor, not an avatar chip)", () => {
    renderSwitcher({ layout: "mobile" });

    const trigger = screen.getByTestId("nav-context-trigger");
    expect(within(trigger).getByText(org.label)).toBeInTheDocument();
    expect(within(trigger).getByText("Group Admin")).toBeInTheDocument();
    // The name only truncates when genuinely too long — no fixed 150px cap
    // on mobile, so no ellipsis style is asserted here; the fluid slot rules.
  });

  it("keeps the trigger's workspace name in its natural case", () => {
    // The Button atom paints `text-transform: uppercase` on its frame; the
    // trigger label must opt out or a proper noun shouts.
    renderSwitcher();

    const trigger = screen.getByTestId("nav-context-trigger");
    expect(within(trigger).getByText(org.label)).toHaveStyle({
      textTransform: "none",
    });
  });

  it("drives menu navigation from the filter field", async () => {
    const user = userEvent.setup();
    const many: AccountContext[] = Array.from({ length: 8 }, (_, i) => ({
      id: `org-${i}`,
      label: `Probe Workspace ${i}`,
      type: "org" as const,
      role: "ADMIN" as const,
    }));
    // The shipped configuration: anchor rows.
    renderSwitcher({
      accountContext: many[0],
      availableContexts: many,
      contextHrefBuilder: (id) => `/admin/${id}/dashboard`,
    });

    const menu = await openMenu(user);
    const filter = screen.getByTestId("nav-workspace-filter");
    await waitFor(() => expect(document.activeElement).toBe(filter));

    // React Native Web's TextInput drops `onKeyDown`, and a keydown from the
    // input never reaches the popover frame's React handler — so the switcher
    // binds a NATIVE listener. Without it, ArrowDown moved focus nowhere.
    const rows = within(menu).getAllByRole("menuitemradio");
    act(() => {
      fireEvent.keyDown(filter, { key: "ArrowDown" });
    });
    expect(document.activeElement).toBe(rows[0]);

    act(() => {
      fireEvent.keyDown(document.activeElement as HTMLElement, {
        key: "ArrowDown",
      });
    });
    expect(document.activeElement).toBe(rows[1]);

    // Escape from the field still closes and restores.
    act(() => rows[1]?.blur());
    act(() => filter.focus());
    act(() => {
      fireEvent.keyDown(filter, { key: "Escape" });
    });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(
      screen.getByTestId("nav-context-trigger"),
    );
  });

  it("leaves Home to the caret while the filter has focus", async () => {
    const user = userEvent.setup();
    const many: AccountContext[] = Array.from({ length: 8 }, (_, i) => ({
      id: `org-${i}`,
      label: `Probe Workspace ${i}`,
      type: "org" as const,
      role: "ADMIN" as const,
    }));
    renderSwitcher({ accountContext: many[0], availableContexts: many });

    await openMenu(user);
    const filter = screen.getByTestId("nav-workspace-filter");
    await waitFor(() => expect(document.activeElement).toBe(filter));

    act(() => {
      fireEvent.keyDown(filter, { key: "Home" });
    });
    act(() => {
      fireEvent.keyDown(filter, { key: "End" });
    });

    // Home/End must NOT be hijacked into menu navigation here.
    expect(document.activeElement).toBe(filter);
  });

  it("clears a stale needle when the filter field unmounts", async () => {
    const user = userEvent.setup();
    const many: AccountContext[] = Array.from({ length: 7 }, (_, i) => ({
      id: `org-${i}`,
      label: `Probe Workspace ${i}`,
      type: "org" as const,
      role: "ADMIN" as const,
    }));
    const { rerender } = renderWithProvider(
      <WorkspaceSwitcher
        layout="desktop"
        accountContext={many[0]!}
        availableContexts={many}
        onContextSelect={vi.fn()}
        testIdBase="nav"
      />,
    );

    await actClick(user, screen.getByTestId("nav-context-trigger"));
    await act(async () => {
      fireEvent.change(screen.getByTestId("nav-workspace-filter"), {
        target: { value: "zzzz" },
      });
    });
    expect(screen.getByTestId("nav-workspace-empty")).toBeInTheDocument();

    // A background refetch drops the count below the filter threshold while
    // the menu is open. The field unmounts; without clearing `query` the menu
    // is stranded on "No workspaces match" with no way to clear it.
    rerender(
      <WorkspaceSwitcher
        layout="desktop"
        accountContext={many[0]!}
        availableContexts={many.slice(0, 6)}
        onContextSelect={vi.fn()}
        testIdBase="nav"
      />,
    );

    await waitFor(() => {
      expect(screen.queryByTestId("nav-workspace-filter")).toBeNull();
    });
    expect(screen.queryByTestId("nav-workspace-empty")).toBeNull();
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(6);
  });

  it("closes on Tab and hands focus back to the trigger", async () => {
    const user = userEvent.setup();
    renderSwitcher();

    const menu = await openMenu(user);
    const trigger = screen.getByTestId("nav-context-trigger");

    act(() => {
      fireEvent.keyDown(menu, { key: "Tab" });
    });

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    // Without this, focus fell to <body> and the browser computed "next
    // tabbable" from the top of the document.
    expect(document.activeElement).toBe(trigger);
  });

  it("recovers focus when the focused row is filtered away", async () => {
    const user = userEvent.setup();
    const many: AccountContext[] = Array.from({ length: 7 }, (_, i) => ({
      id: `org-${i}`,
      label: `Workspace ${i}`,
      type: "org" as const,
      role: "ADMIN" as const,
    }));
    renderSwitcher({ accountContext: many[0], availableContexts: many });

    const menu = await openMenu(user);
    const rows = within(menu).getAllByRole("menuitemradio");

    act(() => rows[3]?.focus());
    expect(document.activeElement).toBe(rows[3]);

    // Narrow the list so the focused row unmounts. Without reconciliation the
    // browser drops focus to <body>, the popover keydown handler stops firing
    // and the menu is left open and keyboard-dead.
    await act(async () => {
      fireEvent.change(screen.getByTestId("nav-workspace-filter"), {
        target: { value: "Workspace 1" },
      });
    });

    await waitFor(() => {
      expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(1);
    });
    const survivor = within(menu).getAllByRole("menuitemradio")[0];
    await waitFor(() => expect(document.activeElement).toBe(survivor));
    expect(survivor).toHaveAttribute("tabindex", "0");

    // And the menu is still keyboard-live.
    act(() => {
      fireEvent.keyDown(document.activeElement as HTMLElement, {
        key: "Escape",
      });
    });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("falls back to the account context when availableContexts is empty", async () => {
    const user = userEvent.setup();
    // `[]` is not nullish, so `?? [accountContext]` used to let it through and
    // render an unfocusable, unescapable menu reading "No workspaces match".
    renderSwitcher({ availableContexts: [] });

    const menu = await openMenu(user);

    expect(screen.queryByTestId("nav-workspace-empty")).toBeNull();
    const rows = within(menu).getAllByRole("menuitemradio");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAccessibleName(/acme organizers/i);
    await waitFor(() => expect(document.activeElement).toBe(rows[0]));
  });

  it("closes when focus leaves the switcher entirely", async () => {
    const user = userEvent.setup();
    renderSwitcher();

    await openMenu(user);
    const outside = document.createElement("button");
    document.body.appendChild(outside);

    act(() => {
      fireEvent.blur(screen.getByRole("menu"), { relatedTarget: outside });
    });

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    outside.remove();
  });
});

describe("getContextRoleLabel", () => {
  it("prefers an explicit roleLabel over the org ROLE_LABELS vocabulary", () => {
    expect(getContextRoleLabel(staffConsole)).toBe("Platform Admin");
  });

  it("still maps org roles when no roleLabel is given", () => {
    expect(getContextRoleLabel(org)).toBe("Group Admin");
    expect(getContextRoleLabel(longNameOrg)).toBe("Editor");
  });

  it("still falls back to the context type when there is no role", () => {
    expect(getContextRoleLabel(personal)).toBe("Personal");
  });

  it("renders the override in the trigger instead of 'Group Admin'", async () => {
    renderSwitcher({
      accountContext: staffConsole,
      availableContexts: [staffConsole],
    });

    const trigger = screen.getByTestId("nav-context-trigger");
    expect(within(trigger).getByText("Platform Admin")).toBeInTheDocument();
    expect(within(trigger).queryByText("Group Admin")).toBeNull();
  });
});
