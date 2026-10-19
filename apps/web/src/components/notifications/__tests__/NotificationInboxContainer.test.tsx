/**
 * The inbox container mapped `href: item.action.href ?? null`, so every
 * renderer that emits a route-only action (`{label, route}` — the image
 * moderation notices, order/ticket notices, event cancel/change notices, …)
 * produced an action whose href was null. `NotificationItem` gates its CTA
 * button on `action?.href`, so those buttons never rendered: the notice told
 * you something happened and gave you no way to go look at it.
 *
 * These pin the promotion (`route` → `href`). The "is this route even real"
 * question is answered at the SOURCE now — see the id-route regression guard in
 * `packages/core/src/use-cases/comms/__tests__/renderers.test.ts`.
 */
import type { ComponentType } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { registerNavigationGuard } from "@/hooks/navigation-guard";

import {
  resolveNotificationActionHref,
  toNotificationItemAction,
} from "../notification-action";

const EVENT_SLUG_ROUTE =
  "/events/bay-area-festivals/us/general/vip-night--00vfkyl834";
const EVENT_UUID = "b987250d-69bc-4a17-932f-6a653745eef7";

const state = vi.hoisted(() => ({
  items: [] as unknown[],
  captured: null as unknown,
  /** The input the container passed to `notifications.list.useInfiniteQuery`. */
  listInput: null as unknown,
  /** When true the REAL `NotificationInbox` renders (keyboard/a11y tests). */
  renderReal: false,
  push: vi.fn(),
  markRead: vi.fn(),
  /** The options the container passed to `markRead.useMutation`, so a test
   * can play the server's answer (`onError`). */
  markReadOptions: null as null | {
    onError?: (err: unknown, vars: { ids: string[] }) => void;
  },
}));

vi.mock("@bprogress/next/app", () => ({
  useRouter: () => ({ push: state.push, replace: vi.fn() }),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      notifications: {
        countUnread: { invalidate: vi.fn() },
        list: { invalidate: vi.fn() },
      },
    }),
    notifications: {
      list: {
        useInfiniteQuery: (input: unknown) => {
          state.listInput = input;
          return {
            data: { pages: [{ items: state.items, nextCursor: null }] },
            fetchNextPage: vi.fn(),
            hasNextPage: false,
            isFetchingNextPage: false,
            isLoading: false,
          };
        },
      },
      countUnread: { useQuery: () => ({ data: { count: 0 } }) },
      markRead: {
        useMutation: (options: {
          onError?: (err: unknown, vars: { ids: string[] }) => void;
        }) => {
          state.markReadOptions = options;
          return { mutate: state.markRead };
        },
      },
      markAllRead: { useMutation: () => ({ mutate: vi.fn() }) },
    },
  },
}));

vi.mock("@th/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@th/ui")>();
  const RealInbox = actual.NotificationInbox as unknown as ComponentType<
    Record<string, unknown>
  >;
  return {
    ...actual,
    NotificationInbox: (props: Record<string, unknown>) => {
      state.captured = props.notifications;
      return state.renderReal ? <RealInbox {...props} /> : null;
    },
  };
});

const {
  AlertsSidebar,
  IthasFireProvider,
  NotificationProvider,
  TranslationProvider,
} = await import("@th/ui");
const { default: enMessages } = await import("@/i18n/messages/en");
const { default: esMessages } = await import("@/i18n/messages/es");

// Imported AFTER the mocks so the container picks them up.
const { NotificationInboxContainer } =
  await import("../NotificationInboxContainer");

function makeItem(action: unknown, id = "n1") {
  return {
    id,
    title: "Your image is now live",
    body: "The image you uploaded has been approved.",
    kind: "SUCCESS",
    readAt: null,
    action,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
  };
}

beforeEach(() => {
  state.renderReal = false;
  state.push.mockReset();
  state.markRead.mockReset();
});

function mappedActions(items: unknown[]) {
  state.items = items;
  render(<NotificationInboxContainer />);
  return (state.captured as { action: unknown }[]).map((n) => n.action);
}

describe("NotificationInboxContainer action mapping", () => {
  it("promotes a route-only action to a clickable href", () => {
    const [action] = mappedActions([
      makeItem({
        label: "View event",
        route: "/events/bay-area-festivals/us/general/vip-night--00vfkyl834",
      }),
    ]);

    expect(action).toEqual({
      label: "View event",
      href: "/events/bay-area-festivals/us/general/vip-night--00vfkyl834",
    });
  });

  it("keeps passing an absolute href straight through", () => {
    const [action] = mappedActions([
      makeItem({
        label: "Open booking inbox",
        href: "https://ithasfire.com/admin/@me/bookings",
      }),
    ]);

    expect(action).toEqual({
      label: "Open booking inbox",
      href: "https://ithasfire.com/admin/@me/bookings",
    });
  });

  it("prefers href when both are present", () => {
    const [action] = mappedActions([
      makeItem({
        label: "View tickets",
        href: "https://ithasfire.com/my-tickets",
        route: "/my-tickets",
      }),
    ]);

    expect(action).toMatchObject({ href: "https://ithasfire.com/my-tickets" });
  });

  it("maps a missing action to null", () => {
    expect(mappedActions([makeItem(null)])).toEqual([null]);
  });

  it("maps every item in the page", () => {
    const actions = mappedActions([
      makeItem({ label: "View tickets", route: "/my-tickets" }, "n1"),
      makeItem({ label: "View event", route: EVENT_SLUG_ROUTE }, "n2"),
      makeItem(null, "n3"),
      makeItem({ label: "View event", route: `/events/${EVENT_UUID}` }, "n4"),
    ]);

    expect(actions).toEqual([
      { label: "View tickets", href: "/my-tickets" },
      { label: "View event", href: EVENT_SLUG_ROUTE },
      null,
      // Historical row: label kept, button hidden.
      { label: "View event", href: null },
    ]);
  });
});

describe("resolveNotificationActionHref", () => {
  it("keeps the live route-only targets the promotion switches on", () => {
    // order.confirmed / order.refund-processed / resale.purchase-confirmed
    expect(
      resolveNotificationActionHref({ label: "x", route: "/my-tickets" }),
    ).toBe("/my-tickets");
  });

  it("passes a multi-segment slug route through untouched", () => {
    expect(
      resolveNotificationActionHref({ label: "x", route: EVENT_SLUG_ROUTE }),
    ).toBe(EVENT_SLUG_ROUTE);
  });

  // PERMANENT read-side guard. Every emitter now builds slug links, but
  // `Notification.actionRoute` is a persisted column: rows already written as
  // `/events/<uuid>` are still in the database and still render. This is not a
  // stopgap awaiting a producer fix — see the comment on DEAD_EVENT_ID_ROUTE.
  it("drops an already-persisted /events/<uuid> route, relative or absolute", () => {
    for (const target of [
      `/events/${EVENT_UUID}`,
      `/events/${EVENT_UUID.toUpperCase()}`,
      `/events/${EVENT_UUID}?ref=email`,
      `/events/${EVENT_UUID}/suggest`,
      `/events/${EVENT_UUID}#tickets`,
      `https://ithasfire.com/events/${EVENT_UUID}`,
    ]) {
      expect(resolveNotificationActionHref({ label: "x", route: target })).toBe(
        null,
      );
      expect(resolveNotificationActionHref({ label: "x", href: target })).toBe(
        null,
      );
    }
  });

  it("never mistakes a slug that merely looks long for an id", () => {
    const slug = "/events/org/us/general/uuid-lookalike-2026-09-06--00vfkyl834";
    expect(resolveNotificationActionHref({ label: "x", route: slug })).toBe(
      slug,
    );
  });

  it("returns null when there is no target at all", () => {
    expect(resolveNotificationActionHref({ label: "x" })).toBeNull();
    expect(toNotificationItemAction(undefined)).toBeNull();
  });

  // The value lands verbatim in an `<a href>` now (NotificationItem), not
  // just `router.push`, so it is a new DOM href sink. The write path is
  // server-authored, but a rejected scheme must still be neutralised rather
  // than reaching the anchor — `safeHref` is the scheme allowlist this
  // routes through.
  it("neutralises a javascript: href instead of passing it to the anchor", () => {
    expect(
      resolveNotificationActionHref({
        label: "x",
        href: "javascript:alert(1)",
      }),
    ).toBeNull();
    expect(
      resolveNotificationActionHref({
        label: "x",
        route: "javascript:alert(1)",
      }),
    ).toBeNull();
  });

  it("still allows the schemes safeHref allows (https, mailto, tel)", () => {
    expect(
      resolveNotificationActionHref({ label: "x", href: "mailto:a@b.com" }),
    ).toBe("mailto:a@b.com");
    expect(
      resolveNotificationActionHref({ label: "x", href: "tel:+15551234567" }),
    ).toBe("tel:+15551234567");
  });
});

describe("NotificationInboxContainer keyboard reach (real inbox)", () => {
  function renderInbox(items: unknown[]) {
    state.items = items;
    state.renderReal = true;
    return render(
      <IthasFireProvider>
        <TranslationProvider locale="en-US" messages={enMessages}>
          <NotificationInboxContainer />
        </TranslationProvider>
      </IthasFireProvider>,
    );
  }

  const lineupItem = {
    ...makeItem({ label: "Review your lineups", route: "/my-lineups" }, "n1"),
    title: "You're on the lineup for Autumn Showcase",
  };

  it("exposes the action as a link with the resolved href and a per-row name", () => {
    renderInbox([lineupItem]);

    const link = screen.getByRole("link", {
      name: "Review your lineups: You're on the lineup for Autumn Showcase",
    });
    expect(link).toHaveAttribute("href", "/my-lineups");
  });

  it("Enter on the link marks the notification read and navigates", async () => {
    const user = userEvent.setup();
    renderInbox([lineupItem]);

    const link = screen.getByRole("link", { name: /^Review your lineups:/ });
    link.focus();
    await user.keyboard("{Enter}");

    expect(state.markRead).toHaveBeenCalledTimes(1);
    expect(state.markRead).toHaveBeenCalledWith({ ids: ["n1"] });
    expect(state.push).toHaveBeenCalledTimes(1);
    expect(state.push).toHaveBeenCalledWith("/my-lineups");
  });

  it("Tab walks rows in order; rows with no usable action offer only Dismiss", async () => {
    const user = userEvent.setup();
    renderInbox([
      {
        ...makeItem({ label: "View tickets", route: "/my-tickets" }, "n1"),
        title: "Tickets",
      },
      { ...makeItem(null, "n2"), title: "No action" },
      // Dead `/events/<uuid>` route: label kept, href dropped, so no link.
      {
        ...makeItem(
          { label: "View event", route: `/events/${EVENT_UUID}` },
          "n3",
        ),
        title: "Dead",
      },
      {
        ...makeItem({ label: "View event", route: EVENT_SLUG_ROUTE }, "n4"),
        title: "Live",
      },
    ]);

    const list = screen.getByRole("list");
    const links = within(list).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/my-tickets",
      EVENT_SLUG_ROUTE,
    ]);

    // Each row: its link (if any), then its Dismiss.
    links[0]!.focus();
    await user.tab();
    expect(
      within(list).getByRole("button", { name: "Dismiss: Tickets" }),
    ).toHaveFocus();
    await user.tab();
    expect(
      within(list).getByRole("button", { name: "Dismiss: No action" }),
    ).toHaveFocus();
    await user.tab();
    expect(
      within(list).getByRole("button", { name: "Dismiss: Dead" }),
    ).toHaveFocus();
    await user.tab();
    expect(links[1]).toHaveFocus();
  });

  it("a row without an action has no link; Dismiss is its only control", () => {
    renderInbox([{ ...makeItem(null, "n1"), title: "Heads up" }]);

    const row = screen.getByRole("listitem");
    expect(within(row).queryByRole("link")).toBeNull();
    expect(
      Array.from(
        row.querySelectorAll(
          'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ),
    ).toEqual([within(row).getByRole("button", { name: "Dismiss: Heads up" })]);
  });

  it("Enter on Dismiss marks a no-action row read", async () => {
    const user = userEvent.setup();
    renderInbox([{ ...makeItem(null, "n1"), title: "Heads up" }]);

    screen.getByRole("button", { name: "Dismiss: Heads up" }).focus();
    await user.keyboard("{Enter}");

    expect(state.markRead).toHaveBeenCalledTimes(1);
    expect(state.markRead).toHaveBeenCalledWith({ ids: ["n1"] });
    expect(state.push).not.toHaveBeenCalled();
  });

  it("a mouse click on the row body still marks read and navigates", async () => {
    const user = userEvent.setup();
    renderInbox([lineupItem]);

    await user.click(
      screen.getByText("The image you uploaded has been approved."),
    );

    expect(state.markRead).toHaveBeenCalledWith({ ids: ["n1"] });
    expect(state.push).toHaveBeenCalledWith("/my-lineups");
  });

  // The bell sits in the admin navbar over pages with unsaved edits; a row
  // press is not a link click, so it goes through the page's guard.
  it("a row press waits for the page's navigation guard", async () => {
    const user = userEvent.setup();
    let held: (() => void) | null = null;
    const unregister = registerNavigationGuard((go) => {
      held = go;
    });
    try {
      renderInbox([lineupItem]);
      await user.click(
        screen.getByText("The image you uploaded has been approved."),
      );
      expect(state.push).not.toHaveBeenCalled();
      expect(held).not.toBeNull();
      act(() => held!());
      expect(state.push).toHaveBeenCalledWith("/my-lineups");
    } finally {
      unregister();
    }
  });

  it("a row press navigates at once when no guard is registered", async () => {
    const user = userEvent.setup();
    renderInbox([lineupItem]);
    await user.click(
      screen.getByText("The image you uploaded has been approved."),
    );
    expect(state.push).toHaveBeenCalledTimes(1);
    expect(state.push).toHaveBeenCalledWith("/my-lineups");
  });
});

describe("NotificationInboxContainer inside the bell panel", () => {
  const lineupItem = {
    ...makeItem({ label: "Review your lineups", route: "/my-lineups" }, "n1"),
    title: "You're on the lineup for Autumn Showcase",
  };

  async function openPanel(user: ReturnType<typeof userEvent.setup>) {
    state.items = [lineupItem];
    state.renderReal = true;
    render(
      <IthasFireProvider>
        <TranslationProvider locale="en-US" messages={enMessages}>
          <NotificationProvider>
            <AlertsSidebar
              platformOverride="web"
              renderInbox={() => <NotificationInboxContainer />}
            />
          </NotificationProvider>
        </TranslationProvider>
      </IthasFireProvider>,
    );
    const bell = screen.getByRole("button", { name: /open alerts/i });
    await user.click(bell);
    const dialog = await screen.findByRole("dialog", { name: "Notifications" });
    await waitFor(() => expect(dialog).toHaveFocus());
    return { bell, dialog };
  }

  it("Enter on a row's link navigates, closes the panel and returns focus to the bell", async () => {
    const user = userEvent.setup();
    const { bell, dialog } = await openPanel(user);

    within(dialog)
      .getByRole("link", { name: /^Review your lineups:/ })
      .focus();
    await user.keyboard("{Enter}");

    expect(state.markRead).toHaveBeenCalledWith({ ids: ["n1"] });
    expect(state.push).toHaveBeenCalledWith("/my-lineups");
    expect(bell).toHaveAttribute("aria-expanded", "false");
    expect(bell).toHaveFocus();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a mouse click on the row closes the panel the same way", async () => {
    const user = userEvent.setup();
    const { bell, dialog } = await openPanel(user);

    await user.click(
      within(dialog).getByText("The image you uploaded has been approved."),
    );

    expect(state.push).toHaveBeenCalledWith("/my-lineups");
    expect(bell).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Dismiss marks read and leaves the panel open", async () => {
    const user = userEvent.setup();
    const { bell, dialog } = await openPanel(user);

    within(dialog)
      .getByRole("button", {
        name: "Dismiss: You're on the lineup for Autumn Showcase",
      })
      .focus();
    await user.keyboard("{Enter}");

    expect(state.markRead).toHaveBeenCalledWith({ ids: ["n1"] });
    expect(state.push).not.toHaveBeenCalled();
    expect(bell).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("NotificationInboxContainer dismiss focus management", () => {
  /**
   * A dismiss marks the row read, which invalidates `notifications.list`.
   * The mock here has no real query cache, so the test plays the part of
   * that invalidate itself: mutate the mock's backing `state.items` and
   * `rerender` the SAME element tree (same type/position → React preserves
   * the open dialog's state) to stand in for the refetch that follows.
   */
  function tree(withPageInbox = false) {
    return (
      <IthasFireProvider>
        <TranslationProvider locale="en-US" messages={enMessages}>
          <NotificationProvider>
            {withPageInbox ? (
              // `/account/notifications` renders its own inbox behind the
              // panel, with the same rows.
              <NotificationInboxContainer />
            ) : null}
            <AlertsSidebar
              platformOverride="web"
              renderInbox={() => <NotificationInboxContainer />}
            />
          </NotificationProvider>
        </TranslationProvider>
      </IthasFireProvider>
    );
  }

  async function openPanel(
    user: ReturnType<typeof userEvent.setup>,
    items: unknown[],
    { withPageInbox = false } = {},
  ) {
    state.items = items;
    state.renderReal = true;
    const { rerender } = render(tree(withPageInbox));
    await user.click(screen.getByRole("button", { name: /open alerts/i }));
    const dialog = await screen.findByRole("dialog", { name: "Notifications" });
    await waitFor(() => expect(dialog).toHaveFocus());
    return {
      dialog,
      refetchWith(nextItems: unknown[]) {
        state.items = nextItems;
        rerender(tree(withPageInbox));
      },
    };
  }

  it("moves focus to the next row's first control, and announces the dismissal", async () => {
    const user = userEvent.setup();
    const { dialog, refetchWith } = await openPanel(user, [
      { ...makeItem(null, "n1"), title: "First" },
      { ...makeItem(null, "n2"), title: "Second" },
    ]);

    within(dialog).getByRole("button", { name: "Dismiss: First" }).focus();
    await user.keyboard("{Enter}");

    expect(state.markRead).toHaveBeenCalledWith({ ids: ["n1"] });
    expect(
      screen.getByText("Notification dismissed: First", { exact: false }),
    ).toBeInTheDocument();

    refetchWith([{ ...makeItem(null, "n2"), title: "Second" }]);

    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Dismiss: Second" }),
      ).toHaveFocus(),
    );
  });

  it("falls back to the previous row when the dismissed row was last", async () => {
    const user = userEvent.setup();
    const { dialog, refetchWith } = await openPanel(user, [
      { ...makeItem(null, "n1"), title: "First" },
      { ...makeItem(null, "n2"), title: "Second" },
    ]);

    within(dialog).getByRole("button", { name: "Dismiss: Second" }).focus();
    await user.keyboard("{Enter}");
    expect(state.markRead).toHaveBeenCalledWith({ ids: ["n2"] });

    refetchWith([{ ...makeItem(null, "n1"), title: "First" }]);

    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Dismiss: First" }),
      ).toHaveFocus(),
    );
  });

  it("falls back to the panel's Close button when the dismissed row was the only one", async () => {
    const user = userEvent.setup();
    const { dialog, refetchWith } = await openPanel(user, [
      { ...makeItem(null, "n1"), title: "Only one" },
    ]);

    within(dialog).getByRole("button", { name: "Dismiss: Only one" }).focus();
    await user.keyboard("{Enter}");
    expect(state.markRead).toHaveBeenCalledWith({ ids: ["n1"] });

    refetchWith([]);

    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Close notifications" }),
      ).toHaveFocus(),
    );
  });

  const first = { ...makeItem(null, "n1"), title: "First" };
  const second = { ...makeItem(null, "n2"), title: "Second" };

  it("on the All tab, Dismiss only marks read: nothing is armed, so switching tabs keeps focus on the tab", async () => {
    const user = userEvent.setup();
    const { dialog, refetchWith } = await openPanel(user, [first, second]);
    const allTab = within(dialog).getByRole("tab", { name: "All" });
    await user.click(allTab);

    within(dialog).getByRole("button", { name: "Dismiss: First" }).focus();
    await user.keyboard("{Enter}");
    expect(state.markRead).toHaveBeenCalledWith({ ids: ["n1"] });
    // The row stays on All, so there is no dismissal to announce.
    expect(
      screen.queryByText("Notification dismissed", { exact: false }),
    ).toBeNull();

    allTab.focus();
    await user.keyboard("{ArrowLeft}");
    const unreadTab = within(dialog).getByRole("tab", { name: /^Unread/ });
    expect(unreadTab).toHaveFocus();

    // The Unread list arrives without the now-read row.
    refetchWith([second]);
    await act(async () => {});
    expect(unreadTab).toHaveFocus();
  });

  it("a failed mark-read disarms the dismiss, so a later list change does not move focus", async () => {
    const user = userEvent.setup();
    const { dialog, refetchWith } = await openPanel(user, [first, second]);

    within(dialog).getByRole("button", { name: "Dismiss: First" }).focus();
    await user.keyboard("{Enter}");
    expect(state.markRead).toHaveBeenCalledWith({ ids: ["n1"] });
    act(() =>
      state.markReadOptions?.onError?.(new Error("boom"), { ids: ["n1"] }),
    );

    // Focus has gone nowhere in particular, and an unrelated refetch later
    // drops the row (e.g. it was read on another device).
    (document.activeElement as HTMLElement | null)?.blur();
    refetchWith([second]);
    await act(async () => {});
    expect(
      within(dialog).getByRole("button", { name: "Dismiss: Second" }),
    ).not.toHaveFocus();
  });

  it("leaves focus alone if the user moved it before the row left", async () => {
    const user = userEvent.setup();
    const { dialog, refetchWith } = await openPanel(user, [first, second]);

    within(dialog).getByRole("button", { name: "Dismiss: First" }).focus();
    await user.keyboard("{Enter}");

    const unreadTab = within(dialog).getByRole("tab", { name: /^Unread/ });
    unreadTab.focus();
    refetchWith([second]);
    await act(async () => {});
    expect(unreadTab).toHaveFocus();
  });

  it("hands focus to the next row in the PANEL, not the page inbox behind it", async () => {
    const user = userEvent.setup();
    const { dialog, refetchWith } = await openPanel(user, [first, second], {
      withPageInbox: true,
    });
    // Two inboxes, two "Dismiss: Second" buttons.
    expect(
      screen.getAllByRole("button", { name: "Dismiss: Second", hidden: true }),
    ).toHaveLength(2);

    within(dialog).getByRole("button", { name: "Dismiss: First" }).focus();
    await user.keyboard("{Enter}");
    refetchWith([second]);

    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Dismiss: Second" }),
      ).toHaveFocus(),
    );
  });

  it("a failed mark-read for a DIFFERENT row leaves the dismiss armed", async () => {
    const user = userEvent.setup();
    const { dialog, refetchWith } = await openPanel(user, [first, second]);

    within(dialog).getByRole("button", { name: "Dismiss: First" }).focus();
    await user.keyboard("{Enter}");
    // Some other row's mark-read (a row press, an earlier dismiss) fails.
    act(() =>
      state.markReadOptions?.onError?.(new Error("boom"), { ids: ["n9"] }),
    );

    refetchWith([second]);
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Dismiss: Second" }),
      ).toHaveFocus(),
    );
  });

  it("switching tabs disarms a pending Unread dismiss", async () => {
    const user = userEvent.setup();
    const { dialog, refetchWith } = await openPanel(user, [first, second]);

    within(dialog).getByRole("button", { name: "Dismiss: First" }).focus();
    await user.keyboard("{Enter}");
    await user.click(within(dialog).getByRole("tab", { name: "All" }));

    // Focus dropped to <body>, so only the tab-change clear stands between
    // the refetch and a focus move the user did not ask for.
    (document.activeElement as HTMLElement | null)?.blur();
    refetchWith([second]);
    await act(async () => {});
    expect(
      within(dialog).getByRole("button", { name: "Dismiss: Second" }),
    ).not.toHaveFocus();
  });

  it("a blank subject announces the no-subject sentence, not a placeholder", async () => {
    const user = userEvent.setup();
    const { dialog } = await openPanel(user, [
      { ...makeItem(null, "n1"), title: "   " },
      second,
    ]);

    within(dialog)
      .getByRole("button", { name: "Dismiss: Notification" })
      .focus();
    await user.keyboard("{Enter}");

    expect(screen.getByText("Notification dismissed")).toHaveAttribute(
      "aria-live",
      "polite",
    );
    expect(
      screen.queryByText("Notification dismissed:", { exact: false }),
    ).toBeNull();
  });
});

/**
 * `/account/notifications` renders the container with no sidebar around it,
 * so the container has to translate its inbox itself.
 */
describe("NotificationInboxContainer in Spanish (no sidebar)", () => {
  it("renders the inbox and its rows from the es catalog", () => {
    state.items = [
      {
        ...makeItem(null, "n1"),
        title: "Pago programado",
        createdAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
      },
    ];
    state.renderReal = true;
    render(
      <IthasFireProvider>
        <TranslationProvider locale="es" messages={esMessages}>
          <NotificationInboxContainer />
        </TranslationProvider>
      </IthasFireProvider>,
    );

    expect(
      screen.getByRole("tablist", { name: "Filtrar notificaciones" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^Sin leer/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Todas" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Descartar: Pago programado" }),
    ).toBeInTheDocument();
    expect(screen.getByText("hace 6 d")).toBeInTheDocument();
  });
});

/**
 * English keeps the hand-rolled timestamps (ruled 2026-10-02): the hook hands
 * no locale for "en*", so Intl's "now" / "yesterday" never reach English users.
 */
describe("NotificationInboxContainer timestamps in English", () => {
  it("reads 'just now' and '6d ago', not Intl's 'now' / 'yesterday'", () => {
    state.items = [
      { ...makeItem(null, "n1"), title: "Fresh", createdAt: new Date() },
      {
        ...makeItem(null, "n2"),
        title: "Older",
        createdAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
      },
      {
        ...makeItem(null, "n3"),
        title: "Yesterday",
        createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      },
    ];
    state.renderReal = true;
    render(
      <IthasFireProvider>
        <TranslationProvider locale="en-US" messages={enMessages}>
          <NotificationInboxContainer />
        </TranslationProvider>
      </IthasFireProvider>,
    );

    expect(screen.getByText("just now")).toBeInTheDocument();
    expect(screen.getByText("6d ago")).toBeInTheDocument();
    expect(screen.getByText("1d ago")).toBeInTheDocument();
    expect(screen.queryByText("yesterday")).toBeNull();
  });
});

/**
 * The server re-renders each row's text in the reader's language (option A,
 * 2026-10-03), so the page's language has to travel with the list query, and
 * being part of the query key is what refetches the list on a switch.
 */
describe("NotificationInboxContainer list locale", () => {
  it("asks for the list in the page's language", () => {
    state.items = [];
    render(
      <TranslationProvider locale="es" messages={esMessages}>
        <NotificationInboxContainer />
      </TranslationProvider>,
    );
    expect(state.listInput).toMatchObject({ locale: "es", limit: 25 });
  });
});
