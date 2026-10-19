import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * Real `@th/ui` except the two pieces that boot a Tamagui theme jsdom has no
 * business booting. `OverflowTooltip`'s OWN behaviour (the `display: block`
 * clip, the measure-then-reveal tooltip) is covered by its suite in
 * `packages/ui`; what matters here is that this surface hands it the FULL
 * title and wraps it in the contained box.
 */
// Plain-DOM stand-ins for the Tamagui stacks (same technique as
// `place-detail-layout.test.tsx`), so the header mounts without a
// TamaguiProvider while keeping its own structure real.
vi.mock("tamagui", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const Stack = ({
    children,
    ...rest
  }: {
    children?: React.ReactNode;
    "data-testid"?: string;
  }) => <div data-testid={rest["data-testid"]}>{children}</div>;
  return { ...actual, XStack: Stack, YStack: Stack };
});

// The status chip is its own tested component; here it only needs to prove it
// still renders BESIDE the title rather than inside the contained box.
vi.mock("../../events/_components/EventStatusBadge", () => ({
  EventStatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

vi.mock("@th/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@th/ui")>();
  return {
    ...actual,
    OverflowTooltip: ({ text }: { text: string }) => <span>{text}</span>,
    Button: ({
      children,
      ...rest
    }: {
      children?: React.ReactNode;
      "data-testid"?: string;
    }) => (
      <button type="button" data-testid={rest["data-testid"]}>
        {children}
      </button>
    ),
    Badge: ({ children }: { children?: React.ReactNode }) => (
      <span>{children}</span>
    ),
  };
});

const {
  RAIL_CONTEXT_TITLE_BOX_STYLE,
  RailContextTitle,
} = await import("../RailContextTitle");
const { EventRailContextHeader } = await import("../EventRailContextHeader");

const LONG_TITLE =
  "The Absolutely Enormous Midnight Rooftop Jamboree and Chili Cookoff Spectacular 2026";

describe("RailContextTitle", () => {
  /**
   * jsdom has no layout engine, so nothing here can prove the rail stopped
   * widening — that was measured in a real browser. What this suite CAN pin is
   * the contract the fix rests on, so a later edit cannot quietly drop it and
   * re-open the bug.
   */
  it("keeps the title from contributing to the rail's intrinsic width", () => {
    // `contain: inline-size` is the load-bearing one: it makes the box's
    // inline size compute as if it had no contents, which is what stops a long
    // title from dragging the whole shrink-to-fit rail out with it. Truncation
    // alone does NOT do this — an ellipsis is a paint-time clip and leaves
    // max-content unchanged.
    expect(RAIL_CONTEXT_TITLE_BOX_STYLE.contain).toBe("inline-size");
    // `width: 100%` hands the rail's real width back at layout time, and
    // `minWidth: 0` keeps the flex min-content floor from re-introducing it.
    expect(RAIL_CONTEXT_TITLE_BOX_STYLE.width).toBe("100%");
    expect(RAIL_CONTEXT_TITLE_BOX_STYLE.minWidth).toBe(0);
  });

  it("applies that box style to the rendered title", () => {
    render(<RailContextTitle title={LONG_TITLE} testId="rail-title" />);
    const box = screen.getByTestId("rail-title");
    expect(box.style.contain).toBe("inline-size");
    expect(box.style.width).toBe("100%");
    expect(box.style.minWidth).toBe("0");
  });

  it("keeps the FULL title in the DOM so the accessible name is not ellipsised", () => {
    render(<RailContextTitle title={LONG_TITLE} testId="rail-title" />);
    // The clip is visual only. A screen reader must still read all 84
    // characters, so the untruncated string has to be real text content.
    expect(screen.getByTestId("rail-title").textContent).toBe(LONG_TITLE);
    expect(screen.getByTestId("rail-title").textContent).not.toContain("…");
  });
});

describe("EventRailContextHeader", () => {
  it("routes a long event title through the contained box", () => {
    render(
      <EventRailContextHeader
        title={LONG_TITLE}
        status="PUBLISHED"
        viewHref="/events/rooftop-jamboree"
      />,
    );
    const box = screen.getByTestId("event-rail-context-title");
    expect(box.textContent).toBe(LONG_TITLE);
    expect(box.style.contain).toBe("inline-size");
  });

  it("leaves the status chip and View event outside it, at natural size", () => {
    render(
      <EventRailContextHeader
        title={LONG_TITLE}
        status="PUBLISHED"
        viewHref="/events/rooftop-jamboree"
      />,
    );
    // The title is the only thing that gives. Both of these sit in a sibling
    // row, so nothing about the title's length can clip or shrink them.
    const box = screen.getByTestId("event-rail-context-title");
    const link = screen.getByTestId("event-rail-view-live");
    expect(box.contains(link)).toBe(false);
    expect(link.textContent).toBeTruthy();
    expect(screen.getByText("PUBLISHED")).toBeTruthy();
  });
});
