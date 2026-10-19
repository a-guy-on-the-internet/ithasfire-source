/**
 * Keyboard and screen-reader reach for inbox rows.
 *
 * Found live 2026-09-30: an actionable row was a `role="listitem"` div with a
 * pointer cursor and a click handler, and its CTA was plain text. A mouse user
 * could open "Review your lineups"; a keyboard or screen-reader user could not
 * reach it at all. The CTA is now a real anchor, and Dismiss / Show more are
 * real buttons. These pin href, per-row names, Enter/Space, Tab order and
 * modifier-click, and that the row itself never becomes a tab stop.
 */
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProvider } from "../../../../../../test/utils";

import { NotificationInbox } from "../NotificationInbox";
import {
  NotificationItem,
  type NotificationItemData,
} from "../NotificationItem";

function makeNotification(
  over: Partial<NotificationItemData> = {},
): NotificationItemData {
  return {
    id: "n1",
    title: "You're on the lineup for Autumn Showcase",
    body: "The organiser added you to the lineup.",
    kind: "INFO",
    readAt: null,
    action: { label: "Review your lineups", href: "/my-lineups" },
    createdAt: new Date(),
    ...over,
  };
}

/** Elements a Tab press can land on inside `root`. */
function tabbables(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  );
}

describe("NotificationItem action link", () => {
  it("renders the action as a real link with the resolved href", () => {
    renderWithProvider(<NotificationItem notification={makeNotification()} />);

    const link = screen.getByRole("link", {
      name: "Review your lineups: You're on the lineup for Autumn Showcase",
    });
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "/my-lineups");
  });

  it("falls back to the body for the name when there is no title", () => {
    renderWithProvider(
      <NotificationItem notification={makeNotification({ title: null })} />,
    );

    expect(
      screen.getByRole("link", {
        name: "Review your lineups: The organiser added you to the lineup.",
      }),
    ).toBeInTheDocument();
  });

  it("Enter on the focused link marks read once and navigates once", async () => {
    const user = userEvent.setup();
    const onMarkRead = vi.fn();
    const onAction = vi.fn();
    renderWithProvider(
      <NotificationItem
        notification={makeNotification()}
        onMarkRead={onMarkRead}
        onAction={onAction}
      />,
    );

    await user.tab();
    const link = screen.getByRole("link");
    expect(link).toHaveFocus();

    await user.keyboard("{Enter}");

    expect(onMarkRead).toHaveBeenCalledTimes(1);
    expect(onMarkRead).toHaveBeenCalledWith("n1");
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith("/my-lineups");
  });

  it("does not mark an already-read notification again", async () => {
    const user = userEvent.setup();
    const onMarkRead = vi.fn();
    const onAction = vi.fn();
    renderWithProvider(
      <NotificationItem
        notification={makeNotification({ readAt: new Date() })}
        onMarkRead={onMarkRead}
        onAction={onAction}
      />,
    );

    await user.click(screen.getByRole("link"));

    expect(onMarkRead).not.toHaveBeenCalled();
    expect(onAction).toHaveBeenCalledWith("/my-lineups");
  });

  it("a plain click is routed through onAction and the default is prevented", () => {
    const onAction = vi.fn();
    renderWithProvider(
      <NotificationItem
        notification={makeNotification()}
        onMarkRead={vi.fn()}
        onAction={onAction}
      />,
    );

    const notPrevented = fireEvent.click(screen.getByRole("link"));

    expect(notPrevented).toBe(false);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("a modifier-click marks read but leaves navigation to the browser", () => {
    const onMarkRead = vi.fn();
    const onAction = vi.fn();
    // A hash href: the default is left alone here, and jsdom implements
    // fragment navigation but not page loads, so this keeps the run quiet.
    renderWithProvider(
      <NotificationItem
        notification={makeNotification({
          action: { label: "Review your lineups", href: "#my-lineups" },
        })}
        onMarkRead={onMarkRead}
        onAction={onAction}
      />,
    );

    const notPrevented = fireEvent.click(screen.getByRole("link"), {
      metaKey: true,
    });

    expect(notPrevented).toBe(true);
    expect(onMarkRead).toHaveBeenCalledTimes(1);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("a middle-click marks read and does not reach the row", () => {
    const onMarkRead = vi.fn();
    const onAction = vi.fn();
    renderWithProvider(
      <NotificationItem
        notification={makeNotification()}
        onMarkRead={onMarkRead}
        onAction={onAction}
      />,
    );

    fireEvent(
      screen.getByRole("link"),
      new MouseEvent("auxclick", { bubbles: true, button: 1 }),
    );

    expect(onMarkRead).toHaveBeenCalledTimes(1);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("clicking the row body (not the link) still marks read and navigates", () => {
    const onMarkRead = vi.fn();
    const onAction = vi.fn();
    renderWithProvider(
      <NotificationItem
        notification={makeNotification()}
        onMarkRead={onMarkRead}
        onAction={onAction}
      />,
    );

    fireEvent.click(screen.getByText("The organiser added you to the lineup."));

    expect(onMarkRead).toHaveBeenCalledWith("n1");
    expect(onAction).toHaveBeenCalledWith("/my-lineups");
  });

  it("the row itself is not a tab stop; its link and Dismiss are, in that order", () => {
    renderWithProvider(<NotificationItem notification={makeNotification()} />);

    const row = screen.getByRole("listitem");
    expect(row).not.toHaveAttribute("tabindex", "0");
    expect(tabbables(row)).toEqual([
      screen.getByRole("link"),
      screen.getByRole("button", { name: /^Dismiss:/ }),
    ]);
  });
});

describe("NotificationItem without an action", () => {
  it("has no link; Dismiss is its only tab stop", () => {
    renderWithProvider(
      <NotificationItem notification={makeNotification({ action: null })} />,
    );

    const row = screen.getByRole("listitem");
    expect(screen.queryByRole("link")).toBeNull();
    expect(row).not.toHaveAttribute("tabindex", "0");
    expect(tabbables(row)).toEqual([
      screen.getByRole("button", {
        name: "Dismiss: You're on the lineup for Autumn Showcase",
      }),
    ]);
  });

  it("a keyboard user can mark it read through Dismiss", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    const onMarkRead = vi.fn();
    renderWithProvider(
      <NotificationItem
        notification={makeNotification({ action: null })}
        onMarkRead={onMarkRead}
        onDismiss={onDismiss}
      />,
    );

    await user.tab();
    expect(screen.getByRole("button", { name: /^Dismiss:/ })).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith("n1");
    // Did not bubble into the row's own mark-read.
    expect(onMarkRead).not.toHaveBeenCalled();
  });

  it("an action whose href was dropped renders no link", () => {
    renderWithProvider(
      <NotificationItem
        notification={makeNotification({
          action: { label: "View event", href: null },
        })}
      />,
    );

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText("View event")).toBeNull();
  });

  it("clicking it still marks it read and navigates nowhere", () => {
    const onMarkRead = vi.fn();
    const onAction = vi.fn();
    renderWithProvider(
      <NotificationItem
        notification={makeNotification({ action: null })}
        onMarkRead={onMarkRead}
        onAction={onAction}
      />,
    );

    fireEvent.click(screen.getByText("The organiser added you to the lineup."));

    expect(onMarkRead).toHaveBeenCalledWith("n1");
    expect(onAction).not.toHaveBeenCalled();
  });
});

describe("NotificationItem Dismiss button", () => {
  it("is a real button named for its notification", () => {
    renderWithProvider(<NotificationItem notification={makeNotification()} />);

    const dismiss = screen.getByRole("button", {
      name: "Dismiss: You're on the lineup for Autumn Showcase",
    });
    expect(dismiss.tagName).toBe("BUTTON");
    expect(dismiss).toHaveAttribute("type", "button");
  });

  it("names itself from the body when there is no title", () => {
    renderWithProvider(
      <NotificationItem notification={makeNotification({ title: null })} />,
    );

    expect(
      screen.getByRole("button", {
        name: "Dismiss: The organiser added you to the lineup.",
      }),
    ).toBeInTheDocument();
  });

  it("bounds the name when a titleless row has a very long body", () => {
    // The name is built from the body only when there is no title. Using the
    // RAW body made a screen reader read a 600-character paragraph out for
    // Dismiss, the CTA and Show more, and diverged from the truncated text on
    // screen. It is cut to the display truncation length instead.
    const body = `${"Lorem ipsum dolor sit amet. ".repeat(30)}end`;
    renderWithProvider(
      <NotificationItem
        notification={makeNotification({ title: null, body })}
      />,
    );

    const dismiss = screen.getByRole("button", { name: /^Dismiss:/ });
    const name = dismiss.getAttribute("aria-label") ?? "";
    expect(body.length).toBeGreaterThan(500);
    expect(name.length).toBeLessThanOrEqual("Dismiss: ".length + 100);
    expect(body.startsWith(name.slice("Dismiss: ".length))).toBe(true);
  });

  it("bounds the name when the TITLE is very long too", () => {
    // `Notification.title` is a String? column with no length cap and nothing
    // in core validates it, so the titled path — the common one — needs the
    // same bound the titleless path got.
    const title = `${"A very wordy notification headline. ".repeat(20)}end`;
    renderWithProvider(
      <NotificationItem notification={makeNotification({ title })} />,
    );

    const name =
      screen
        .getByRole("button", { name: /^Dismiss:/ })
        .getAttribute("aria-label") ?? "";
    expect(title.length).toBeGreaterThan(500);
    expect(name.length).toBeLessThanOrEqual("Dismiss: ".length + 100);
    expect(title.startsWith(name.slice("Dismiss: ".length))).toBe(true);
  });

  it("never cuts an emoji in half at the bound", () => {
    // `slice` counts UTF-16 code units. A surrogate pair straddling the limit
    // used to leave a lone surrogate at the end of three accessible names.
    const title = `${"x".repeat(99)}\u{1F525} tail`;
    renderWithProvider(
      <NotificationItem notification={makeNotification({ title })} />,
    );

    const name =
      screen
        .getByRole("button", { name: /^Dismiss:/ })
        .getAttribute("aria-label") ?? "";
    const subject = name.slice("Dismiss: ".length);
    expect(subject).toBe("x".repeat(99));
    expect(/[\uD800-\uDFFF]/.test(subject)).toBe(false);
  });

  it("falls back to a generic name when title and body are both blank", () => {
    // A whitespace-only subject produced the name "Dismiss: " on every such
    // row — the exact cross-row collision the per-row name exists to prevent.
    renderWithProvider(
      <NotificationItem
        notification={makeNotification({ title: null, body: "   \n  " })}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Dismiss: Notification" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("listitem")).toHaveAttribute(
      "aria-label",
      "Notification",
    );
  });

  it("names the row with the same bounded subject as its controls", () => {
    const body = `${"Lorem ipsum dolor sit amet. ".repeat(40)}end`;
    renderWithProvider(
      <NotificationItem
        notification={makeNotification({ title: null, body })}
      />,
    );

    const rowName = screen.getByRole("listitem").getAttribute("aria-label");
    const dismissName =
      screen
        .getByRole("button", { name: /^Dismiss:/ })
        .getAttribute("aria-label") ?? "";
    expect(body.length).toBeGreaterThan(800);
    expect(rowName).toBe(dismissName.slice("Dismiss: ".length));
    expect(rowName?.length).toBeLessThanOrEqual(100);
  });

  it("Space dismisses, without opening the row's action", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    const onAction = vi.fn();
    renderWithProvider(
      <NotificationItem
        notification={makeNotification()}
        onDismiss={onDismiss}
        onAction={onAction}
      />,
    );

    screen.getByRole("button", { name: /^Dismiss:/ }).focus();
    await user.keyboard(" ");

    expect(onDismiss).toHaveBeenCalledWith("n1");
    expect(onAction).not.toHaveBeenCalled();
  });

  it("without onDismiss it falls back to marking read, as before", async () => {
    const user = userEvent.setup();
    const onMarkRead = vi.fn();
    renderWithProvider(
      <NotificationItem
        notification={makeNotification({ action: null })}
        onMarkRead={onMarkRead}
      />,
    );

    screen.getByRole("button", { name: /^Dismiss:/ }).focus();
    await user.keyboard("{Enter}");

    expect(onMarkRead).toHaveBeenCalledTimes(1);
    expect(onMarkRead).toHaveBeenCalledWith("n1");
  });
});

describe("NotificationItem Show more toggle", () => {
  const longBody = "A long notification body. ".repeat(8).trim();

  it("is a real button that reports and flips its expanded state", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const onMarkRead = vi.fn();
    renderWithProvider(
      <NotificationItem
        notification={makeNotification({ body: longBody })}
        onAction={onAction}
        onMarkRead={onMarkRead}
      />,
    );

    const subject = "You're on the lineup for Autumn Showcase";
    const toggle = screen.getByRole("button", {
      name: `Show more: ${subject}`,
    });
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    const controlled = document.getElementById(
      toggle.getAttribute("aria-controls") ?? "",
    );
    expect(controlled?.textContent).toMatch(/…$/);

    toggle.focus();
    await user.keyboard("{Enter}");

    const expanded = screen.getByRole("button", {
      name: `Show less: ${subject}`,
    });
    expect(expanded).toHaveAttribute("aria-expanded", "true");
    expect(controlled?.textContent).toBe(longBody);

    await user.keyboard(" ");
    expect(
      screen.getByRole("button", { name: `Show more: ${subject}` }),
    ).toHaveAttribute("aria-expanded", "false");

    // Toggling never reaches the row (no mark-read, no navigation).
    expect(onAction).not.toHaveBeenCalled();
    expect(onMarkRead).not.toHaveBeenCalled();
  });

  it("is absent when the body is short", () => {
    renderWithProvider(<NotificationItem notification={makeNotification()} />);

    expect(
      screen.queryByRole("button", { name: /Show (more|less)/ }),
    ).toBeNull();
  });

  // Found in review: the toggle's accessible name was a bare "Show more" —
  // the exact collision class this diff set out to fix for the CTA and
  // Dismiss. A single-row fixture can't catch that; this one renders two
  // long-body rows and asserts both toggles get distinct, per-row names.
  it("gives each row's toggle a distinct name when multiple rows have long bodies", () => {
    renderWithProvider(
      <>
        <NotificationItem
          notification={makeNotification({
            id: "n1",
            title: "You're on the lineup for Autumn Showcase",
            body: longBody,
          })}
        />
        <NotificationItem
          notification={makeNotification({
            id: "n2",
            title: "You're on the lineup for Winter Benefit",
            body: longBody,
          })}
        />
      </>,
    );

    expect(
      screen.getByRole("button", {
        name: "Show more: You're on the lineup for Autumn Showcase",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Show more: You're on the lineup for Winter Benefit",
      }),
    ).toBeInTheDocument();
  });
});

describe("NotificationInbox keyboard order", () => {
  it("Tab walks each row's link then its Dismiss; a no-action row offers only Dismiss", async () => {
    const user = userEvent.setup();
    renderWithProvider(
      <NotificationInbox
        notifications={[
          makeNotification({ id: "a", title: "First" }),
          makeNotification({ id: "b", title: "No action", action: null }),
          makeNotification({
            id: "c",
            title: "Third",
            action: { label: "View tickets", href: "/my-tickets" },
          }),
        ]}
        activeTab="all"
        onTabChange={vi.fn()}
        unreadCount={0}
        onMarkRead={vi.fn()}
        onMarkAllRead={vi.fn()}
      />,
    );

    const list = screen.getByRole("list");
    const first = within(list).getByRole("link", {
      name: "Review your lineups: First",
    });
    const third = within(list).getByRole("link", {
      name: "View tickets: Third",
    });

    const dismissFirst = within(list).getByRole("button", {
      name: "Dismiss: First",
    });
    const dismissSecond = within(list).getByRole("button", {
      name: "Dismiss: No action",
    });

    first.focus();
    expect(first).toHaveFocus();
    await user.tab();
    expect(dismissFirst).toHaveFocus();
    await user.tab();
    expect(dismissSecond).toHaveFocus();
    await user.tab();
    expect(third).toHaveFocus();
    await user.tab({ shift: true });
    expect(dismissSecond).toHaveFocus();
  });
});
