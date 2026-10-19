/**
 * BuilderHeaderBar owns the builder's ONE sticky bar (2026-08-27: the floating
 * action bar was deleted and this renders the actions itself). One quiet row
 * (2026-09-15): back / title / inline status on the left; Edit|Preview, Share,
 * the commit pair and an unframed `⋯` — last — on the right. The trailing ✕
 * is gone (the back arrow is the one exit), the hairline group rules are gone,
 * and Unpublish lives in the `⋯` rather than on the row. The header's own
 * "View event" link and new-tab preview icon are GONE (the `⋯` items own
 * those), so the bar never offers two activation paths for the same
 * destination.
 */
import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("tamagui", async () => {
  const React = await import("react");
  const PASS_PROP = /^(data-|aria-)|^(id|role|style|title|tabIndex|type)$/;
  const makeStack =
    () =>
    ({
      children,
      onPress,
      tag,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
      tag?: string;
      [key: string]: unknown;
    }) => {
      const domProps: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rest)) {
        if (PASS_PROP.test(key)) domProps[key] = value;
      }
      if (onPress) domProps.onClick = onPress;
      return React.createElement(tag ?? "div", domProps, children);
    };
  const Stack = makeStack();
  return { XStack: Stack, YStack: Stack, styled: makeStack };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  return {
    Text: ({
      children,
      ...rest
    }: {
      children?: ReactNode;
      [key: string]: unknown;
    }) =>
      React.createElement(
        "span",
        Object.fromEntries(
          Object.entries(rest).filter(([key]) => key.startsWith("data-")),
        ),
        children,
      ),
    useTranslations: () => (key: string) => key,
  };
});

vi.mock("@/components/data-table/RowActionMenu", () => ({
  RowActionMenu: ({
    items,
    triggerVariant,
  }: {
    items: {
      key: string;
      label: string;
      testId?: string;
      tone?: string;
      disabled?: boolean;
      onPress: () => void;
    }[];
    triggerVariant?: string;
  }) => (
    <div data-testid="row-action-menu" data-trigger-variant={triggerVariant}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          data-testid={item.testId ?? item.key}
          data-tone={item.tone}
          disabled={item.disabled}
          onClick={item.onPress}
        >
          {item.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("../../../_components/EventStatusBadge", () => ({
  EventStatusBadge: ({
    status,
    appearance,
  }: {
    status: string;
    appearance?: string;
  }) => (
    <span
      data-testid="status-badge"
      data-appearance={appearance ?? "chip"}
      aria-label={`Status: ${status}`}
    >
      {status}
    </span>
  ),
}));

vi.mock("../EventViewModeToggle", () => ({
  EventViewModeToggle: () => <div data-testid="event-view-mode-toggle" />,
}));

import { BuilderHeaderBar } from "../BuilderHeaderBar";

const baseProps = {
  stickyBarRef: { current: null },
  slug: "acme",
  title: "Big Show",
  eventStatus: "PUBLISHED" as const,
  canEditEvent: true,
  eventLoaded: true,
  isPreviewMode: false,
  onViewModeChange: vi.fn(),
  isMobile: false,
  isCancelling: false,
  onRequestCancelEvent: vi.fn(),
};

/** DOM order: `a` precedes `b`. */
function precedes(a: Element, b: Element): boolean {
  return Boolean(
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
}

describe("BuilderHeaderBar", () => {
  it("is itself the sticky bar — no shared action-bar component", () => {
    const { container } = render(<BuilderHeaderBar {...baseProps} />);
    // Inline style, because react-native-web strips `position: sticky` from
    // styled stacks; a regression here silently unpins the whole header.
    const bar = container.firstElementChild as HTMLElement;
    expect(bar.style.position).toBe("sticky");
    expect(bar.style.top).toBe("0px");
    expect(screen.queryByTestId("page-action-bar")).toBeNull();
  });

  it("renders the actions node it is handed", () => {
    render(
      <BuilderHeaderBar
        {...baseProps}
        actions={<button data-testid="event-save-btn">Save</button>}
      />,
    );
    expect(screen.getByTestId("event-save-btn")).toBeInTheDocument();
  });

  it("shows back / title / status / toggle / ⋯ on desktop", () => {
    render(<BuilderHeaderBar {...baseProps} />);

    expect(screen.getByTestId("event-builder-back")).toBeInTheDocument();
    expect(screen.getByText("Big Show")).toBeInTheDocument();
    expect(screen.getByTestId("status-badge")).toBeInTheDocument();
    expect(screen.getByTestId("event-view-mode-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("event-cancel-event-btn")).toBeInTheDocument();
  });

  describe("cancel event gate", () => {
    it.each([
      ["a non-editor", { canEditEvent: false }],
      ["a cancelled event", { eventStatus: "CANCELLED" as const }],
      ["a completed event", { eventStatus: "COMPLETED" as const }],
      ["a surface with no cancel path", { onRequestCancelEvent: undefined }],
    ])("offers no Cancel event item to %s", (_label, overrides) => {
      render(<BuilderHeaderBar {...baseProps} {...overrides} />);
      expect(screen.queryByTestId("event-cancel-event-btn")).toBeNull();
    });

    it("shows the in-flight label and disables the item while cancelling", () => {
      render(<BuilderHeaderBar {...baseProps} isCancelling />);
      const item = screen.getByTestId("event-cancel-event-btn");
      expect(item).toHaveTextContent("admin.ebCancelling");
      expect(item).toBeDisabled();
    });
  });

  describe("one exit", () => {
    const originalLocation = window.location;

    beforeEach(() => {
      // jsdom logs "not implemented: navigation" on a real href assignment;
      // a plain object records it instead.
      Object.defineProperty(window, "location", {
        configurable: true,
        writable: true,
        value: { href: "http://localhost/admin/acme/events/e1/edit" },
      });
    });

    afterEach(() => {
      Object.defineProperty(window, "location", {
        configurable: true,
        writable: true,
        value: originalLocation,
      });
    });

    // The ✕ and the back arrow both went to `/admin/{slug}/events` — two
    // exits, three inches apart, to one destination. Only the arrow remains,
    // on every width.
    it.each([false, true])(
      "renders no ✕ and the back arrow leaves for the events list (isMobile: %s)",
      (isMobile) => {
        render(<BuilderHeaderBar {...baseProps} isMobile={isMobile} />);

        expect(screen.queryByTestId("event-cancel-btn")).toBeNull();
        expect(screen.queryByLabelText("admin.ebCloseBuilder")).toBeNull();

        const back = screen.getByTestId("event-builder-back");
        expect(back).toHaveAttribute("aria-label", "admin.ebBackToEvents");
        fireEvent.click(back);
        expect(window.location.href).toBe("/admin/acme/events");
      },
    );
  });

  it("renders the status INLINE beside the title, with its accessible name", () => {
    render(<BuilderHeaderBar {...baseProps} eventStatus="DRAFT" />);

    const status = screen.getByTestId("status-badge");
    expect(status).toHaveAttribute("data-appearance", "inline");
    expect(status).toHaveAttribute("aria-label", "Status: DRAFT");
    // A suffix to the title, not a neighbour of the toggle.
    expect(precedes(screen.getByText("Big Show"), status)).toBe(true);
    expect(precedes(status, screen.getByTestId("event-view-mode-toggle"))).toBe(
      true,
    );
  });

  it("puts the ⋯ LAST among the tools on desktop, unframed", () => {
    render(
      <BuilderHeaderBar
        {...baseProps}
        secondaryActions={<button data-testid="event-share-btn">Share</button>}
        actions={<button data-testid="event-publish-btn">Publish</button>}
      />,
    );

    const toggle = screen.getByTestId("event-view-mode-toggle");
    const share = screen.getByTestId("event-share-btn");
    const publish = screen.getByTestId("event-publish-btn");
    const menu = screen.getByTestId("row-action-menu");

    // Reading order: view mode, the reversible thing, the commit pair, then
    // everything else behind the ⋯.
    expect(precedes(toggle, share)).toBe(true);
    expect(precedes(share, publish)).toBe(true);
    expect(precedes(publish, menu)).toBe(true);
    expect(menu).toHaveAttribute("data-trigger-variant", "ghost");
    // Nothing sits after the ⋯ in the tools cluster.
    expect(screen.getByTestId("event-builder-tools").lastElementChild)
      .toContainElement(menu);
  });

  it("renders no hairline group rules", () => {
    const { container } = render(
      <BuilderHeaderBar
        {...baseProps}
        secondaryActions={<button data-testid="event-share-btn">Share</button>}
        actions={<button data-testid="event-publish-btn">Publish</button>}
      />,
    );
    expect(container.querySelector("[aria-hidden]:empty")).toBeNull();
  });

  it("renders no inline preview affordance of its own", () => {
    // View event belongs to the admin rail; previewing belongs to the
    // Edit|Preview toggle. Neither gets a second copy in this header.
    const { rerender } = render(<BuilderHeaderBar {...baseProps} />);
    expect(screen.queryByText("admin.ebViewEvent")).toBeNull();

    rerender(<BuilderHeaderBar {...baseProps} eventStatus="DRAFT" />);
    expect(screen.queryByTestId("event-preview-link")).toBeNull();
  });

  it("offers the live draft as a LABELLED ⋯ item, not a bare icon", () => {
    const onOpenLiveDraft = vi.fn();
    render(
      <BuilderHeaderBar {...baseProps} onOpenLiveDraft={onOpenLiveDraft} />,
    );

    const item = screen.getByTestId("event-preview-link");
    expect(item).toBeInTheDocument();
    // It is inside the menu, not loose in the action row.
    expect(screen.getByTestId("row-action-menu")).toContainElement(item);
    expect(item).toHaveTextContent("admin.ebPreviewNewTab");

    fireEvent.click(item);
    expect(onOpenLiveDraft).toHaveBeenCalledTimes(1);
  });

  it("offers Copy link in the ⋯ on a PUBLISHED event too", () => {
    // The rail's View event navigates away; hosts asked for the link itself,
    // and it must be reachable once the event is live — not only pre-publish
    // where the live-draft item lives.
    const onCopyEventLink = vi.fn();
    render(
      <BuilderHeaderBar
        {...baseProps}
        eventStatus="PUBLISHED"
        onCopyEventLink={onCopyEventLink}
      />,
    );

    const item = screen.getByTestId("event-copy-link");
    expect(screen.getByTestId("row-action-menu")).toContainElement(item);
    expect(item).toHaveTextContent("eventDetail.shareCopyLink");

    fireEvent.click(item);
    expect(onCopyEventLink).toHaveBeenCalledTimes(1);
  });

  it("drops Copy link when the builder hands it no handler", () => {
    // The prop is the only gate — if the builder ever needs to withhold the
    // item (no resolvable URL), passing nothing has to remove it, not render
    // an inert row.
    render(<BuilderHeaderBar {...baseProps} eventStatus="PUBLISHED" />);
    expect(screen.queryByTestId("event-copy-link")).toBeNull();
  });

  describe("Unpublish", () => {
    it("is a ⋯ item, not a button, when the builder passes onUnpublish", () => {
      const onUnpublish = vi.fn();
      render(<BuilderHeaderBar {...baseProps} onUnpublish={onUnpublish} />);

      const item = screen.getByTestId("event-unpublish-btn");
      expect(screen.getByTestId("row-action-menu")).toContainElement(item);
      expect(item).toHaveAttribute("role", "menuitem");
      expect(item).toHaveTextContent("pageActions.unpublishEvent");
      expect(
        screen.getByTestId("event-builder-tools").querySelector(
          'button[data-testid="event-unpublish-btn"]:not([role="menuitem"])',
        ),
      ).toBeNull();

      fireEvent.click(item);
      expect(onUnpublish).toHaveBeenCalledTimes(1);
    });

    it("is absent when the builder withholds the handler", () => {
      render(<BuilderHeaderBar {...baseProps} />);
      expect(screen.queryByTestId("event-unpublish-btn")).toBeNull();
    });
  });

  it("orders the ⋯: look, copy, open, unpublish — and Cancel event LAST", () => {
    render(
      <BuilderHeaderBar
        {...baseProps}
        eventStatus="PUBLISHED"
        onViewEvent={vi.fn()}
        onCopyEventLink={vi.fn()}
        onOpenLiveDraft={vi.fn()}
        onUnpublish={vi.fn()}
      />,
    );

    const items = screen.getAllByRole("menuitem");
    expect(items.map((el) => el.getAttribute("data-testid"))).toEqual([
      "event-view-live",
      "event-copy-link",
      "event-preview-link",
      "event-unpublish-btn",
      "event-cancel-event-btn",
    ]);
    const last = items[items.length - 1]!;
    expect(last).toHaveAttribute("data-tone", "danger");
  });

  it("keeps the secondary and commit groups in reading order", () => {
    render(
      <BuilderHeaderBar
        {...baseProps}
        secondaryActions={<button data-testid="event-share-btn">Share</button>}
        actions={<button data-testid="event-publish-btn">Publish</button>}
      />,
    );

    const secondary = screen.getByTestId("event-share-btn");
    const commit = screen.getByTestId("event-publish-btn");
    // Reversible things first, the commit pair after.
    expect(precedes(secondary, commit)).toBe(true);
  });

  it("omits the mobile button row when there is nothing to commit", () => {
    const { container } = render(<BuilderHeaderBar {...baseProps} isMobile />);
    const bar = container.firstElementChild!.firstElementChild!;
    // Row 1 (title) and row 2 (status + toggle) only.
    expect(bar.children).toHaveLength(2);
  });

  it("stacks three rows on mobile: title + ⋯, status + toggle, then the buttons", () => {
    render(
      <BuilderHeaderBar
        {...baseProps}
        isMobile
        secondaryActions={<button data-testid="event-share-btn">Share</button>}
        actions={<button data-testid="event-publish-btn">Publish</button>}
      />,
    );

    const title = screen.getByText("Big Show");
    const menu = screen.getByTestId("row-action-menu");
    const status = screen.getByTestId("status-badge");
    const toggle = screen.getByTestId("event-view-mode-toggle");
    const share = screen.getByTestId("event-share-btn");
    const publish = screen.getByTestId("event-publish-btn");

    // Row 1: back, title, ⋯ — the ⋯ shares the title's row.
    expect(title.parentElement).toContainElement(menu);
    expect(precedes(title, menu)).toBe(true);
    // Row 2: status, then the toggle — and nothing else on that row.
    expect(precedes(menu, status)).toBe(true);
    // The badge sits in its own no-shrink wrapper inside the row.
    const row2 = status.parentElement!.parentElement!;
    expect(row2).toContainElement(toggle);
    expect(precedes(status, toggle)).toBe(true);
    expect(row2).not.toContainElement(share);
    expect(row2).not.toContainElement(publish);
    // Row 3: Share, then the commit pair, on their own row.
    expect(precedes(toggle, share)).toBe(true);
    expect(precedes(share, publish)).toBe(true);
    expect(share.parentElement).toContainElement(publish);
    expect(screen.queryByTestId("event-cancel-btn")).toBeNull();
  });
});
