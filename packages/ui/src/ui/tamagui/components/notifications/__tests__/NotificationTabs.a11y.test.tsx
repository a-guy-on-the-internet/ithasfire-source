/**
 * Both tab rows in the notification panel — the panel's Inbox / Activity and
 * the inbox's Unread / All — were `role="tab"` <div>s with no tablist, no tab
 * stop and no keys, so a keyboard user could not switch views at all. These
 * pin the WAI-ARIA tabs contract: a named tablist, real buttons, a roving
 * tabindex, Left/Right/Home/End moving AND activating, and a tabpanel that
 * the tabs control and that is labelled by the selected tab.
 */
import { useState } from "react";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProvider } from "../../../../../../test/utils";

import { AlertsSidebar } from "../AlertsSidebar";
import { NotificationInbox, type InboxTab } from "../NotificationInbox";
import { NotificationProvider } from "../NotificationProvider";

function ControlledInbox({
  onTabChange,
}: {
  onTabChange?: (tab: InboxTab) => void;
}) {
  const [tab, setTab] = useState<InboxTab>("unread");
  return (
    <NotificationInbox
      notifications={[
        {
          id: "n1",
          title: "First",
          body: "Body",
          kind: "INFO",
          readAt: null,
          action: { label: "Open", href: "/x" },
          createdAt: new Date(),
        },
      ]}
      activeTab={tab}
      onTabChange={(next) => {
        onTabChange?.(next);
        setTab(next);
      }}
      unreadCount={3}
      onMarkRead={vi.fn()}
      onMarkAllRead={vi.fn()}
    />
  );
}

function expectTabContract(
  tablist: HTMLElement,
  selectedName: RegExp,
  otherName: RegExp,
) {
  const selected = within(tablist).getByRole("tab", { name: selectedName });
  const other = within(tablist).getByRole("tab", { name: otherName });
  expect(selected.tagName).toBe("BUTTON");
  expect(selected).toHaveAttribute("type", "button");
  expect(selected).toHaveAttribute("aria-selected", "true");
  expect(selected).toHaveAttribute("tabindex", "0");
  expect(other).toHaveAttribute("aria-selected", "false");
  expect(other).toHaveAttribute("tabindex", "-1");

  const panelId = selected.getAttribute("aria-controls");
  expect(panelId).toBeTruthy();
  expect(other).toHaveAttribute("aria-controls", panelId!);
  const panel = document.getElementById(panelId!);
  expect(panel).toHaveAttribute("role", "tabpanel");
  expect(panel).toHaveAttribute("aria-labelledby", selected.id);
  return { selected, other, panel: panel! };
}

describe("NotificationInbox Unread / All tabs", () => {
  it("is a named tablist with a roving tabindex and a labelled tabpanel", () => {
    renderWithProvider(<ControlledInbox />);

    const tablist = screen.getByRole("tablist", {
      name: "Filter notifications",
    });
    const { panel } = expectTabContract(tablist, /^Unread/, /^All$/);
    expect(within(panel).getByRole("list")).toBeInTheDocument();
  });

  it("ArrowRight / ArrowLeft move focus and activate, wrapping at the ends", async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    renderWithProvider(<ControlledInbox onTabChange={onTabChange} />);
    const tablist = screen.getByRole("tablist", {
      name: "Filter notifications",
    });

    within(tablist)
      .getByRole("tab", { name: /^Unread/ })
      .focus();
    await user.keyboard("{ArrowRight}");
    expect(onTabChange).toHaveBeenLastCalledWith("all");
    const all = within(tablist).getByRole("tab", { name: /^All$/ });
    expect(all).toHaveFocus();
    expectTabContract(tablist, /^All$/, /^Unread/);

    await user.keyboard("{ArrowRight}");
    expect(onTabChange).toHaveBeenLastCalledWith("unread");
    expect(within(tablist).getByRole("tab", { name: /^Unread/ })).toHaveFocus();

    await user.keyboard("{ArrowLeft}");
    expect(onTabChange).toHaveBeenLastCalledWith("all");
    expect(all).toHaveFocus();
  });

  it("Home and End jump to the first and last tab", async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    renderWithProvider(<ControlledInbox onTabChange={onTabChange} />);
    const tablist = screen.getByRole("tablist", {
      name: "Filter notifications",
    });

    within(tablist)
      .getByRole("tab", { name: /^Unread/ })
      .focus();
    await user.keyboard("{End}");
    expect(onTabChange).toHaveBeenLastCalledWith("all");
    expect(within(tablist).getByRole("tab", { name: /^All$/ })).toHaveFocus();

    await user.keyboard("{Home}");
    expect(onTabChange).toHaveBeenLastCalledWith("unread");
    expect(within(tablist).getByRole("tab", { name: /^Unread/ })).toHaveFocus();
  });

  it("Tab leaves the tablist after ONE stop instead of visiting every tab", async () => {
    const user = userEvent.setup();
    renderWithProvider(<ControlledInbox />);

    screen.getByRole("tab", { name: /^Unread/ }).focus();
    await user.tab();

    // Next stop is the Mark-all-read control, not the "All" tab.
    expect(screen.getByRole("tab", { name: /^All$/ })).not.toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Mark all read" }),
    ).toHaveFocus();
  });

  it("a click still selects a tab", async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    renderWithProvider(<ControlledInbox onTabChange={onTabChange} />);

    await user.click(screen.getByRole("tab", { name: /^All$/ }));

    expect(onTabChange).toHaveBeenCalledWith("all");
  });
});

describe("AlertsSidebar Inbox / Activity tabs (web)", () => {
  async function openPanel(user: ReturnType<typeof userEvent.setup>) {
    renderWithProvider(
      <NotificationProvider>
        <AlertsSidebar
          platformOverride="web"
          // LOAD-BEARING: the Inbox / Activity tabs only render when
          // `renderInbox` is given (see the "renders no tablist" case below).
          // Drop this stub and every assertion in this block quietly stops
          // testing anything.
          renderInbox={() => <div>Inbox content</div>}
        />
      </NotificationProvider>,
    );
    await user.click(screen.getByRole("button", { name: /open alerts/i }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog).toHaveFocus());
    return dialog;
  }

  it("is a named tablist controlling a labelled tabpanel", async () => {
    const user = userEvent.setup();
    const dialog = await openPanel(user);

    const tablist = within(dialog).getByRole("tablist", {
      name: "Notification views",
    });
    const { panel } = expectTabContract(tablist, /^Inbox$/, /^Activity/);
    expect(within(panel).getByText("Inbox content")).toBeInTheDocument();
  });

  it("ArrowRight switches to Activity and the tabpanel follows", async () => {
    const user = userEvent.setup();
    const dialog = await openPanel(user);
    const tablist = within(dialog).getByRole("tablist", {
      name: "Notification views",
    });

    within(tablist)
      .getByRole("tab", { name: /^Inbox$/ })
      .focus();
    await user.keyboard("{ArrowRight}");

    const activity = within(tablist).getByRole("tab", { name: /^Activity/ });
    expect(activity).toHaveFocus();
    const { panel } = expectTabContract(tablist, /^Activity/, /^Inbox$/);
    expect(within(panel).queryByText("Inbox content")).toBeNull();
    expect(within(panel).getByText("You're all caught up")).toBeInTheDocument();

    await user.keyboard("{Home}");
    expect(within(tablist).getByRole("tab", { name: /^Inbox$/ })).toHaveFocus();
    expect(within(dialog).getByText("Inbox content")).toBeInTheDocument();
  });

  it("renders no tablist and no tabpanel when there is no inbox", async () => {
    const user = userEvent.setup();
    renderWithProvider(
      <NotificationProvider>
        <AlertsSidebar platformOverride="web" />
      </NotificationProvider>,
    );
    await user.click(screen.getByRole("button", { name: /open alerts/i }));
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).queryByRole("tablist")).toBeNull();
    expect(within(dialog).queryByRole("tabpanel")).toBeNull();
  });
});

describe("AlertsSidebar Inbox / Activity tabs (native sheet)", () => {
  /**
   * The sheet's two tabs were `role="tab"` with no tablist around them, which
   * is worse for VoiceOver/TalkBack than no role at all. `role` and
   * `aria-selected` are real React Native props (RN maps them to
   * accessibilityRole and `accessibilityState.selected`), so the native
   * contract is a named tablist + two tabs + which one is selected. The
   * tabpanel RELATION is deliberately absent: `aria-controls` has no RN
   * equivalent and neither screen reader has a tabpanel concept, so
   * `tablist-a11y`'s wiring stays DOM-only.
   */
  async function renderSheet() {
    renderWithProvider(
      <NotificationProvider>
        <AlertsSidebar
          platformOverride="ios"
          defaultOpen
          renderInbox={() => <div>Inbox content</div>}
        />
      </NotificationProvider>,
    );
    return screen.findByTestId("alerts-bottom-sheet-handle");
  }

  it("is a named tablist whose tabs carry their selected state", async () => {
    await renderSheet();

    const tablist = screen.getByRole("tablist", {
      name: "Notification views",
    });
    const inbox = within(tablist).getByRole("tab", { name: /^Inbox$/ });
    const activity = within(tablist).getByRole("tab", { name: /^Activity/ });

    expect(inbox).toHaveAttribute("aria-selected", "true");
    expect(activity).toHaveAttribute("aria-selected", "false");
  });

  it("carries none of the DOM-only tab wiring", async () => {
    await renderSheet();

    const tablist = screen.getByRole("tablist", {
      name: "Notification views",
    });
    for (const tab of within(tablist).getAllByRole("tab")) {
      expect(tab).not.toHaveAttribute("aria-controls");
      expect(tab).not.toHaveAttribute("tabindex");
      expect(tab).not.toHaveAttribute("type");
    }
    expect(screen.queryByRole("tabpanel")).toBeNull();
  });
});
