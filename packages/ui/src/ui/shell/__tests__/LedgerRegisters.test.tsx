import { act } from "react";
import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithProvider } from "../../../../test/utils";
import { LedgerContextStrip, LedgerSectionTabs, LedgerTopbar } from "../ledger";

const tabItems = [
  { href: "/admin/acme/dashboard", label: "Overview" },
  { href: "/admin/acme/events", label: "Events", count: 12 },
  { href: "/admin/acme/orders", label: "Orders" },
];

describe("LedgerTopbar", () => {
  it("renders the default brand, the role chip and both slots", () => {
    renderWithProvider(
      <LedgerTopbar
        surfaceRole="Admin"
        left={<span>left-slot</span>}
        right={<span>right-slot</span>}
        testIdBase="tb"
      />,
    );

    expect(screen.getByText("Ithas Fire")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("tb-role")).getByText("Admin"),
    ).toBeInTheDocument();
    expect(screen.getByText("left-slot")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("tb-right")).getByText("right-slot"),
    ).toBeInTheDocument();
  });

  it("omits the role chip when no role is given and honours a custom brand", () => {
    renderWithProvider(
      <LedgerTopbar brand={<span>Custom Brand</span>} testIdBase="tb" />,
    );

    expect(screen.getByText("Custom Brand")).toBeInTheDocument();
    expect(screen.queryByText("Ithas Fire")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tb-role")).not.toBeInTheDocument();
  });

  it("renders no brand at all when brand is null", () => {
    renderWithProvider(<LedgerTopbar brand={null} testIdBase="tb" />);

    expect(screen.queryByText("Ithas Fire")).not.toBeInTheDocument();
  });

  it("gives search its own flexible slot rather than the shrink-to-fit right cluster", () => {
    // Structural, not computed: jsdom resolves no Tamagui CSS, so the guard is
    // that search is NOT a child of `-right`. Inside that cluster its
    // `flex: 1` had no free space to claim and the trigger rendered at its
    // content size (~195px at 1440) with the row's spare width left empty.
    renderWithProvider(
      <LedgerTopbar
        search={<span>search-slot</span>}
        right={<span>right-slot</span>}
        testIdBase="tb"
      />,
    );

    expect(
      within(screen.getByTestId("tb-search")).getByText("search-slot"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("tb-right")).queryByText("search-slot"),
    ).not.toBeInTheDocument();
  });

  it("renders no search slot when search is omitted (the mobile topbar)", () => {
    renderWithProvider(
      <LedgerTopbar right={<span>right-slot</span>} testIdBase="tb" />,
    );

    expect(screen.queryByTestId("tb-search")).not.toBeInTheDocument();
  });
});

describe("LedgerSectionTabs", () => {
  it("renders a labelled navigation landmark with one link per item and a count", () => {
    renderWithProvider(
      <LedgerSectionTabs
        items={tabItems}
        current="/admin/acme/events"
        label="Admin sections"
      />,
    );

    const nav = screen.getByRole("navigation", { name: "Admin sections" });
    const links = within(nav).getAllByRole("link");
    expect(links).toHaveLength(3);
    expect(links[0]).toHaveAttribute("href", "/admin/acme/dashboard");
    expect(within(nav).getByText("12")).toBeInTheDocument();
  });

  it("marks the current href with aria-current=page and nothing else", () => {
    renderWithProvider(
      <LedgerSectionTabs
        items={tabItems}
        current="/admin/acme/events"
        label="Admin sections"
      />,
    );

    const active = screen.getByRole("link", { name: /Events/ });
    expect(active).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Overview" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(screen.getByRole("link", { name: "Orders" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("intercepts plain clicks for onSelect but lets modifier-clicks through", () => {
    const onSelect = vi.fn();
    renderWithProvider(
      <LedgerSectionTabs
        items={tabItems}
        label="Admin sections"
        onSelect={onSelect}
      />,
    );

    const overview = screen.getByRole("link", { name: "Overview" });

    const plain = fireEvent.click(overview);
    expect(onSelect).toHaveBeenCalledWith("/admin/acme/dashboard");
    // preventDefault was called → fireEvent.click returns false.
    expect(plain).toBe(false);

    onSelect.mockClear();
    const modified = fireEvent.click(overview, { metaKey: true });
    expect(onSelect).not.toHaveBeenCalled();
    expect(modified).toBe(true);
  });

  it("moves focus with ArrowRight / ArrowLeft / End / Home across the tab links", async () => {
    const user = userEvent.setup();
    renderWithProvider(
      <LedgerSectionTabs items={tabItems} label="Admin sections" />,
    );

    const [overview, events, orders] = screen.getAllByRole("link");

    await act(async () => {
      overview!.focus();
    });
    expect(overview).toHaveFocus();

    await act(async () => {
      await user.keyboard("{ArrowRight}");
    });
    expect(events).toHaveFocus();

    await act(async () => {
      await user.keyboard("{End}");
    });
    expect(orders).toHaveFocus();

    // Wraps from the last tab back to the first.
    await act(async () => {
      await user.keyboard("{ArrowRight}");
    });
    expect(overview).toHaveFocus();

    await act(async () => {
      await user.keyboard("{ArrowLeft}");
    });
    expect(orders).toHaveFocus();

    await act(async () => {
      await user.keyboard("{Home}");
    });
    expect(overview).toHaveFocus();
  });

  it("leaves modified arrow keys (browser Back, page scroll) to the browser", async () => {
    const user = userEvent.setup();
    renderWithProvider(
      <LedgerSectionTabs items={tabItems} label="Admin sections" />,
    );

    const [overview] = screen.getAllByRole("link");
    await act(async () => {
      overview!.focus();
    });

    for (const combo of [
      "{Alt>}{ArrowLeft}{/Alt}",
      "{Meta>}{ArrowLeft}{/Meta}",
      "{Control>}{End}{/Control}",
    ]) {
      await act(async () => {
        await user.keyboard(combo);
      });
      expect(overview).toHaveFocus();
    }

    // And the handler did not preventDefault: a modified keydown reaches the
    // link uncancelled.
    const event = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    const notCancelled = overview!.dispatchEvent(event);
    expect(notCancelled).toBe(true);
    expect(event.defaultPrevented).toBe(false);
  });

  it("renders the overflow slot after the tabs", () => {
    renderWithProvider(
      <LedgerSectionTabs
        items={tabItems}
        label="Admin sections"
        overflow={<button type="button">More</button>}
      />,
    );

    expect(screen.getByRole("button", { name: "More" })).toBeInTheDocument();
  });
});

describe("LedgerContextStrip", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders nothing when there are no facts and no right figure", () => {
    const { container } = renderWithProvider(
      <LedgerContextStrip items={[]} testIdBase="ctx" />,
    );

    expect(screen.queryByTestId("ctx")).not.toBeInTheDocument();
    // Only the provider's `display: contents` wrappers remain — no text,
    // no strip frame.
    expect(container.textContent).toBe("");
  });

  it("joins facts with aria-hidden middots and right-aligns the live figure", () => {
    renderWithProvider(
      <LedgerContextStrip
        items={["Aug 15 · Riverfront Park", "Published"]}
        right="1,284 / 1,500 sold"
        testIdBase="ctx"
      />,
    );

    const strip = screen.getByTestId("ctx");
    expect(within(strip).getByText("Published")).toBeInTheDocument();
    const separators = strip.querySelectorAll('[aria-hidden="true"]');
    expect(separators).toHaveLength(1);
    expect(separators[0]).toHaveTextContent("·");
    expect(
      within(screen.getByTestId("ctx-right")).getByText("1,284 / 1,500 sold"),
    ).toBeInTheDocument();
  });

  it("warns in development when a control is slotted in (facts only)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    renderWithProvider(
      <LedgerContextStrip
        items={["Published", <a href="/x">Edit</a>]}
        testIdBase="ctx"
      />,
    );

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[LedgerContextStrip] facts only"),
    );
  });

  it("does not warn for plain facts", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    renderWithProvider(
      <LedgerContextStrip
        items={["Published", <span key="s">Aug 15</span>]}
        right={<strong>3 open</strong>}
        testIdBase="ctx"
      />,
    );

    expect(warn).not.toHaveBeenCalled();
  });
});
